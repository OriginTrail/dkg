import { describe, it, expect } from 'vitest';
import {
  ProtocolRouter,
  isProtocolUnsupportedError,
  POOLED_MESSAGE_PROTOCOL,
} from '../src/index.js';
import type { DKGNode } from '../src/node.js';
import {
  FrameType,
  encodeFrame,
  decodeFrames,
} from '../src/message-frame.js';

/**
 * Pool-enabled `ProtocolRouter` integration tests. These verify the
 * router-level negotiation: pool-first attempt, fall back to one-shot
 * on multistream-select failure, peer-variant memoization, and
 * end-to-end framed round-trip via the pool's inbound handler.
 *
 * The libp2p stub is intentionally narrower than the one in
 * `protocol-router.test.ts` — we only need dialProtocol + handle +
 * unhandle.
 */

/**
 * Valid base58btc peer IDs — needed because the router's one-shot
 * fallback path calls the real `peerIdFromString` from
 * `@libp2p/peer-id`. The pooled path uses an injectable
 * `peerIdFromString` stub, but the fallback escapes that boundary.
 */
const PEER_NEW = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';
const PEER_OLD = '12D3KooWGRUkpYzqu7w17X8YBaPDB6c7TuD3KSGmZSEpCpVjMx9V';

class FakeStream {
  writeStatus: 'open' | 'closing' | 'closed' = 'open';
  readonly sent: Uint8Array[] = [];
  private readBuf: Uint8Array[] = [];
  private waiters: Array<(v: IteratorResult<Uint8Array>) => void> = [];
  private ended = false;

  send(data: Uint8Array): void {
    if (this.writeStatus !== 'open') throw new Error('closed');
    this.sent.push(new Uint8Array(data));
  }

  feed(data: Uint8Array): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: data, done: false });
    else this.readBuf.push(data);
  }

  endRemote(): void {
    this.ended = true;
    while (this.waiters.length) {
      this.waiters.shift()!({ value: undefined as unknown as Uint8Array, done: true });
    }
  }

  abort(_err: Error): void {
    this.writeStatus = 'closed';
    this.endRemote();
  }

  async close(): Promise<void> {
    this.writeStatus = 'closed';
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        if (this.readBuf.length > 0) {
          return Promise.resolve({ value: this.readBuf.shift()!, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

interface RouterFixture {
  router: ProtocolRouter;
  dialedProtocols: Array<{ peer: string; protocols: string | string[] }>;
  streamsByCall: FakeStream[];
}

function makeRouterFixture(opts: {
  /**
   * Decides how dialProtocol resolves for each (peer, protocols)
   * tuple. Default: returns a fresh FakeStream for every protocol.
   * Tests can pass a custom function to simulate fallback (e.g.
   * throw on pooled protocol, succeed on logical).
   */
  onDial?: (peerStr: string, protocols: string | string[]) => Promise<FakeStream>;
} = {}): RouterFixture {
  const dialed: Array<{ peer: string; protocols: string | string[] }> = [];
  const streamsByCall: FakeStream[] = [];
  const node = {
    libp2p: {
      dialProtocol: async (peerId: unknown, protocols: string | string[], _options: unknown) => {
        const peerStr = (peerId as { toString: () => string }).toString();
        dialed.push({ peer: peerStr, protocols });
        const stream = opts.onDial
          ? await opts.onDial(peerStr, protocols)
          : new FakeStream();
        streamsByCall.push(stream);
        return stream as unknown as import('@libp2p/interface').Stream;
      },
      handle: () => undefined,
      unhandle: () => undefined,
      getConnections: () => [],
      peerStore: { get: async () => ({ addresses: [] }) },
    },
  } as unknown as DKGNode;
  const router = new ProtocolRouter(node);
  return { router, dialedProtocols: dialed, streamsByCall };
}

describe('ProtocolRouter pooled overlay', () => {
  it('routes pooled-protocol sends through the pool when enabled', async () => {
    const fixture = makeRouterFixture({
      onDial: async (_peer, protocols) => {
        // Pool dials with the pooled wire protocol only.
        expect(protocols).toBe(POOLED_MESSAGE_PROTOCOL);
        return new FakeStream();
      },
    });
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });

    const sendPromise = fixture.router.send(
      PEER_NEW,
      '/dkg/10.0.1/message',
      new TextEncoder().encode('hello'),
    );
    await flush();
    const stream = fixture.streamsByCall[0]!;
    // First write should be a framed REQUEST.
    expect(stream.sent.length).toBeGreaterThanOrEqual(1);
    const firstFrame = stream.sent[0];
    expect(firstFrame[1]).toBe(FrameType.REQUEST);

    // Feed a framed RESPONSE.
    stream.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('world')));
    const resp = await sendPromise;
    expect(new TextDecoder().decode(resp)).toBe('world');

    // Pool status reflects one live peer.
    const status = fixture.router.pooledStatus();
    expect(status).toHaveLength(1);
    expect(status[0].logicalProtocolId).toBe('/dkg/10.0.1/message');
    expect(status[0].wireProtocolId).toBe(POOLED_MESSAGE_PROTOCOL);
    expect(status[0].livePeers).toBe(1);

    await fixture.router.closePooling();
  });

  it('reuses the pooled stream across multiple sends to the same peer', async () => {
    const fixture = makeRouterFixture();
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });

    const p1 = fixture.router.send(PEER_NEW, '/dkg/10.0.1/message', new TextEncoder().encode('a'));
    await flush();
    const stream = fixture.streamsByCall[0]!;
    stream.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('A')));
    expect(new TextDecoder().decode(await p1)).toBe('A');

    const p2 = fixture.router.send(PEER_NEW, '/dkg/10.0.1/message', new TextEncoder().encode('b'));
    await flush();
    // No second dial.
    expect(fixture.dialedProtocols.length).toBe(1);
    stream.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('B')));
    expect(new TextDecoder().decode(await p2)).toBe('B');

    await fixture.router.closePooling();
  });

  it('falls back to one-shot when peer rejects pooled protocol', async () => {
    let dialCallNo = 0;
    const fixture = makeRouterFixture({
      onDial: async (_peer, protocols) => {
        dialCallNo += 1;
        if (protocols === POOLED_MESSAGE_PROTOCOL) {
          throw new Error('protocol selection failed - unsupported');
        }
        // One-shot dial — return a stream that closes after one
        // response.
        const s = new FakeStream();
        // Simulate the receiver immediately responding to one-shot
        // (raw bytes, no framing).
        queueMicrotask(() => {
          s.feed(new TextEncoder().encode('one-shot-resp'));
          s.endRemote();
        });
        return s;
      },
    });
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });

    const resp = await fixture.router.send(
      PEER_OLD,
      '/dkg/10.0.1/message',
      new TextEncoder().encode('x'),
    );
    expect(new TextDecoder().decode(resp)).toBe('one-shot-resp');
    // Two dials: one pooled (rejected), then one one-shot.
    expect(dialCallNo).toBe(2);

    // Verify the peer is memoized as one-shot for subsequent sends.
    expect(fixture.router.peerWireVariantFor(PEER_OLD, '/dkg/10.0.1/message')).toBe('one-shot');

    await fixture.router.closePooling();
  });

  it('memoized one-shot peers skip the pooled attempt entirely', async () => {
    let pooledDials = 0;
    let oneShotDials = 0;
    const fixture = makeRouterFixture({
      onDial: async (_peer, protocols) => {
        if (protocols === POOLED_MESSAGE_PROTOCOL) {
          pooledDials += 1;
          throw new Error('could not negotiate');
        }
        oneShotDials += 1;
        const s = new FakeStream();
        queueMicrotask(() => {
          s.feed(new TextEncoder().encode('os'));
          s.endRemote();
        });
        return s;
      },
    });
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });

    await fixture.router.send(PEER_OLD, '/dkg/10.0.1/message', new TextEncoder().encode('1'));
    await fixture.router.send(PEER_OLD, '/dkg/10.0.1/message', new TextEncoder().encode('2'));

    // Pooled attempted only ONCE — second send skipped it via memo.
    expect(pooledDials).toBe(1);
    expect(oneShotDials).toBe(2);

    await fixture.router.closePooling();
  });

  it('isProtocolUnsupportedError matches multistream-select failure shapes', () => {
    expect(isProtocolUnsupportedError(new Error('protocol selection failed: foo'))).toBe(true);
    expect(isProtocolUnsupportedError(new Error('Could not negotiate /dkg/10.0.2/message'))).toBe(true);
    expect(isProtocolUnsupportedError(new Error('Unsupported protocol'))).toBe(true);
    expect(isProtocolUnsupportedError(new Error('Protocol mismatch'))).toBe(true);
    expect(isProtocolUnsupportedError(new Error('ECONNRESET'))).toBe(false);
    expect(isProtocolUnsupportedError(new Error('no valid addresses'))).toBe(false);
  });

  it('pooledStatus is empty when pooling not enabled', () => {
    const fixture = makeRouterFixture();
    expect(fixture.router.pooledStatus()).toEqual([]);
  });

  it('closePooling tears down peer state', async () => {
    const fixture = makeRouterFixture();
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });

    const pSend = fixture.router.send(
      PEER_NEW,
      '/dkg/10.0.1/message',
      new TextEncoder().encode('a'),
    );
    await flush();
    expect(fixture.router.pooledStatus()[0].livePeers).toBe(1);
    await fixture.router.closePooling();
    expect(fixture.router.pooledStatus()).toEqual([]);
    await expect(pSend).rejects.toThrow();
  });

  it('pool-level transient errors do not silently fall back', async () => {
    let pooledCalls = 0;
    let logicalCalls = 0;
    const fixture = makeRouterFixture({
      onDial: async (_peer, protocols) => {
        if (protocols === POOLED_MESSAGE_PROTOCOL) {
          pooledCalls += 1;
          // Simulate a transient transport error, NOT a protocol
          // negotiation failure. Per design this should bubble up
          // to the caller, not fall back to one-shot.
          throw new Error('ECONNRESET');
        }
        logicalCalls += 1;
        return new FakeStream();
      },
    });
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });

    await expect(
      fixture.router.send(PEER_NEW, '/dkg/10.0.1/message', new TextEncoder().encode('x')),
    ).rejects.toThrow();
    // Pool attempted, but we did NOT call into the one-shot path —
    // surface to caller so substrate retries on the same wire.
    expect(pooledCalls).toBe(1);
    expect(logicalCalls).toBe(0);

    await fixture.router.closePooling();
  });
});

describe('ProtocolRouter pooled inbound handler', () => {
  it('forwards framed REQUESTs to the registered application handler', async () => {
    // For inbound, we need to invoke the libp2p handle callback ourselves.
    type HandlerFn = (
      stream: import('@libp2p/interface').Stream,
      connection: { remotePeer: { toString: () => string; toMultihash: () => { bytes: Uint8Array } } },
    ) => void | Promise<void>;
    let inboundHandler: HandlerFn | null = null;
    const node = {
      libp2p: {
        dialProtocol: async () => {
          throw new Error('not used');
        },
        handle: (_protocolId: string, handler: HandlerFn) => {
          // Only capture the POOLED protocol handler; one-shot handlers
          // for the logical id also call libp2p.handle but we don't
          // exercise them in this test.
          if (_protocolId === POOLED_MESSAGE_PROTOCOL) {
            inboundHandler = handler;
          }
        },
        unhandle: () => undefined,
        getConnections: () => [],
        peerStore: { get: async () => ({ addresses: [] }) },
      },
    } as unknown as DKGNode;

    const router = new ProtocolRouter(node);
    router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });
    router.register('/dkg/10.0.1/message', async (req, _peer) => {
      return new TextEncoder().encode(`echo:${new TextDecoder().decode(req)}`);
    });

    expect(inboundHandler).toBeDefined();

    // Simulate an inbound stream: feed REQUEST, expect RESPONSE.
    const inboundStream = new FakeStream();
    const probeStream = new FakeStream();
    const remotePeerStr = PEER_NEW;
    // Wire up so writes from the inbound side appear in the probe stream's
    // read buffer. Easiest: re-use FakeStream's sent buffer to inspect.
    void probeStream; // placeholder for clarity
    // Kick the handler.
    inboundHandler!(inboundStream as unknown as import('@libp2p/interface').Stream, {
      remotePeer: {
        toString: () => remotePeerStr,
        toMultihash: () => ({ bytes: new Uint8Array() }),
      },
    });
    await flush();
    // Feed a REQUEST frame.
    inboundStream.feed(encodeFrame(FrameType.REQUEST, new TextEncoder().encode('hi')));
    await flush();
    // The handler should have written a RESPONSE frame.
    expect(inboundStream.sent.length).toBeGreaterThanOrEqual(1);
    const parsed: { type: FrameType; payload: Uint8Array }[] = [];
    for await (const f of decodeFrames(
      (async function* () {
        for (const c of inboundStream.sent) yield c;
      })(),
    )) {
      parsed.push(f);
    }
    expect(parsed.length).toBe(1);
    expect(parsed[0].type).toBe(FrameType.RESPONSE);
    expect(new TextDecoder().decode(parsed[0].payload)).toBe('echo:hi');

    await router.closePooling();
  });
});
