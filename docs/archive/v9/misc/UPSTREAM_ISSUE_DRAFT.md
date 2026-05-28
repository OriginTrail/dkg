# Draft GitHub Issue for libp2p/js-libp2p

> **Title:** `Connection.newStream()` returns dead stream — `peerStore.merge()` triggers connection manager to close relay connection mid-negotiation

---

- **Version**: libp2p@3.1.3 (latest stable)

- **Platform**: Darwin 24.6.0 (macOS), Node.js v22

- **Subsystem**: `packages/libp2p/src/connection.ts` — `Connection.newStream()`, Connection Manager

#### Severity:

High — protocol streams opened on relay connections via `dialProtocol()` or `connection.newStream()` are silently killed. The returned stream has `writeStatus: closed`, making relay-based request/response communication unreliable.

#### Description

When calling `connection.newStream()` (or `libp2p.dialProtocol()`) on a relay (limited) connection to a peer that also has **direct TCP addresses** in the peer store (learned via identify), the returned stream is already dead (`writeStatus: closed`).

**Root cause:** After protocol negotiation succeeds, `Connection.newStream()` calls:

```ts
// packages/libp2p/src/connection.ts — inside newStream()
await this.components.peerStore.merge(this.remotePeer, {
  protocols: [muxedStream.protocol]
})
```

This `peerStore.merge` emits a peer-store event. The connection manager reacts by noticing the peer has direct (non-relay) TCP addresses and opens a direct connection. When the direct connection is established, the connection manager prunes the relay connection (which has `limits` set). This tears down the yamux session and kills all streams on the relay connection — **including the stream `newStream()` just negotiated**.

The stream is returned to the caller already dead (`writeStatus: 'closed'`).

**The same issue exists in `onIncomingStream()`** (the inbound path), which also calls `peerStore.merge` before dispatching the stream to the handler.

#### Relation to #3201 / PR #3205

This is the same class of bug as #3201, which was fixed in #3205 for the **WebRTC** upgrade path. This issue affects the **TCP** path — the connection manager auto-dials direct TCP addresses discovered via identify, closing the relay connection. The fix from #3205 does not cover this code path.

#### Steps to reproduce

Minimal reproduction (TCP transport only, no WebRTC):

```ts
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { multiaddr } from '@multiformats/multiaddr'
import { pipe } from 'it-pipe'

const protocol = '/test/echo/1.0.0'

// 1. Relay server
const relay = await createLibp2p({
  addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify(),
    relay: circuitRelayServer(),
  },
})

const relayAddr = relay.getMultiaddrs()[0]

// 2. Two nodes, both with direct TCP addresses and circuit relay transport
const nodeA = await createLibp2p({
  addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
  transports: [tcp(), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify() },
})

const nodeB = await createLibp2p({
  addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
  transports: [tcp(), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify() },
})

// Echo handler on A
await nodeA.handle(protocol, ({ stream }) => {
  pipe(stream, stream)
}, { runOnLimitedConnection: true })

// Both connect to relay so they discover each other's TCP addresses via identify
await nodeA.dial(relayAddr)
await nodeB.dial(relayAddr)
await new Promise(r => setTimeout(r, 2000))

// 3. B dials A explicitly through the circuit relay
const circuitAddr = multiaddr(`${relayAddr}/p2p-circuit/p2p/${nodeA.peerId}`)
const conn = await nodeB.dial(circuitAddr)
console.log('connection limited:', conn.limits != null) // true

await new Promise(r => setTimeout(r, 1000))

// 4. Open a protocol stream on the relay connection
const stream = await conn.newStream(protocol, {
  runOnLimitedConnection: true,
  signal: AbortSignal.timeout(5000),
})

// BUG: stream is dead before the caller can use it
console.log('stream.writeStatus:', stream.writeStatus) // "closed"

try {
  // this throws StreamStateError
  await pipe(
    [new TextEncoder().encode('hello')],
    stream,
    async (source) => {
      for await (const chunk of source) {
        console.log('response:', new TextDecoder().decode(chunk.subarray()))
      }
    }
  )
} catch (err) {
  console.error('ERROR:', err.message)
  // "Cannot write to a stream that is closed"
}

await relay.stop()
await nodeA.stop()
await nodeB.stop()
```

#### Expected behavior

`connection.newStream()` returns a usable stream with `writeStatus: 'writable'`. The `peerStore.merge` side-effect should not cause the connection manager to close the connection that `newStream()` is actively using.

#### Actual behavior

The stream is returned with `writeStatus: 'closed'`. The relay connection was closed mid-negotiation because `peerStore.merge` triggered the connection manager to open a direct TCP connection and prune the relay.

This is **intermittent** — it depends on timing. If the connection manager's direct dial completes before `newStream()` returns, the stream is dead. If it's slower, the stream may survive briefly.

#### Workaround

We work around this in our application layer by:
1. Checking `stream.writeStatus` immediately after `newStream()` returns
2. Retrying up to 3 times with exponential back-off (500ms, 1000ms)
3. On retry, the direct connection is established and `dialProtocol()` uses it instead

```ts
// Our workaround in ProtocolRouter.send()
let lastErr: unknown;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const stream = await libp2p.dialProtocol(peerId, protocolId, {
      runOnLimitedConnection: true,
      signal,
    });

    if (stream.writeStatus === 'closed' || stream.writeStatus === 'closing') {
      stream.abort(new Error('stream closed before send'));
      throw new Error('stream returned in closed state');
    }

    // ... use stream ...
    return result;
  } catch (err: unknown) {
    lastErr = err;
    const msg = err instanceof Error ? err.message : '';
    const recoverable = msg.includes('closed') || msg.includes('reset');
    if (!recoverable || attempt >= 2) throw err;
    await new Promise(r => setTimeout(r, (attempt + 1) * 500));
  }
}
```

#### Suggested fix

The `peerStore.merge` calls in both `newStream()` and `onIncomingStream()` should not block stream return or trigger connection-disrupting side effects. Options:

1. **Fire-and-forget** — don't `await` the merge, so the stream is returned before any connection manager reaction:
   ```ts
   this.components.peerStore.merge(this.remotePeer, {
     protocols: [muxedStream.protocol]
   }).catch(err => {
     this.log.error('failed to merge peer protocols: %e', err)
   })
   ```

2. **Defer to microtask** — `queueMicrotask()` to ensure the stream is fully returned before the merge runs.

3. **Guard against self-pruning** — the connection manager should not prune a connection that has active/recently-opened streams.

Option 1 is the simplest and most backwards-compatible.
