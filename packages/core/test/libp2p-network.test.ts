import { describe, it, expect, afterEach } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { DKGNode } from '../src/node.js';
import { LibP2PNetwork } from '../src/network/libp2p-network.js';

/**
 * RFC 07 §5 — `LibP2PNetwork` is a thin facade over `DKGNode.libp2p`.
 * These tests exercise it against two real libp2p instances rather
 * than mocking; the `Network` interface contract is what we verify,
 * not internal libp2p mechanics.
 */
describe('LibP2PNetwork', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const n of nodes) {
      await n.stop();
    }
    nodes.length = 0;
  });

  function spawn(): DKGNode {
    const n = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(n);
    return n;
  }

  it('exposes localId / localAddresses / isStarted that mirror DKGNode', async () => {
    const node = spawn();
    const net = new LibP2PNetwork(node);
    expect(net.isStarted).toBe(false);
    await net.start();
    expect(net.isStarted).toBe(true);
    expect(net.localId).toBe(node.peerId);
    expect(net.localAddresses).toEqual(node.multiaddrs);
    await net.stop();
    expect(net.isStarted).toBe(false);
  });

  it('start / stop are idempotent', async () => {
    const node = spawn();
    const net = new LibP2PNetwork(node);
    await net.start();
    await net.start();
    expect(net.isStarted).toBe(true);
    await net.stop();
    await net.stop();
    expect(net.isStarted).toBe(false);
  });

  it('handle + dialProtocol round-trips a stream', async () => {
    const a = spawn();
    const b = spawn();
    const netA = new LibP2PNetwork(a);
    const netB = new LibP2PNetwork(b);
    await netA.start();
    await netB.start();

    // Point A at B without using libp2p directly.
    await netA.addKnownAddresses(b.peerId, b.multiaddrs);

    const protocol = '/test/network-iface/1.0.0';
    const received: { remote: string; payload: string }[] = [];
    const dec = new TextDecoder();
    await netB.handle(protocol, async (stream, remote) => {
      // Drain the stream so we can record what the dialer sent.
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.subarray()));
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      received.push({ remote, payload: dec.decode(merged) });
      await stream.close();
    });

    const stream = await netA.dialProtocol(b.peerId, protocol);
    const enc = new TextEncoder();
    stream.send(enc.encode('hello'));
    await stream.close();
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toEqual([{ remote: a.peerId, payload: 'hello' }]);
  }, 15000);

  it('getConnections returns empty before connect, non-empty after', async () => {
    const a = spawn();
    const b = spawn();
    const netA = new LibP2PNetwork(a);
    await netA.start();
    await b.start();

    expect(netA.getConnections(b.peerId)).toHaveLength(0);

    await a.libp2p.dial(multiaddr(b.multiaddrs[0]));
    await new Promise((r) => setTimeout(r, 300));

    const conns = netA.getConnections(b.peerId);
    expect(conns.length).toBeGreaterThan(0);
    expect(conns[0].remotePeer.toString()).toBe(b.peerId);
  }, 15000);

  it('addKnownAddresses populates the peer store so subsequent dials skip resolution', async () => {
    const a = spawn();
    const b = spawn();
    const netA = new LibP2PNetwork(a);
    await netA.start();
    await b.start();

    await netA.addKnownAddresses(b.peerId, b.multiaddrs);

    // libp2p.dialProtocol given just a peer id will use the address book;
    // if the previous step worked, this dial succeeds without an explicit
    // multiaddr.
    const protocol = '/test/known-addrs/1.0.0';
    await b.libp2p.handle(protocol, (stream) => {
      void stream.close();
    });
    const stream = await netA.dialProtocol(b.peerId, protocol);
    expect(stream).toBeDefined();
    await stream.close();
  }, 15000);

  it('addKnownAddresses with empty array is a no-op', async () => {
    const a = spawn();
    const b = spawn();
    const netA = new LibP2PNetwork(a);
    await netA.start();
    await b.start();

    await expect(netA.addKnownAddresses(b.peerId, [])).resolves.toBeUndefined();
  });

  it('handle aborts the stream when an async handler rejects (Codex PR #494)', async () => {
    // Regression guard: the wrapper used to fire-and-forget the handler
    // promise, so an async rejection became an unhandledRejection AND
    // left the inbound stream half-open. The dialer would only notice
    // when its own read timeout fired, by which time minutes might have
    // passed. The fix awaits the handler in try/catch and aborts the
    // stream on failure.
    //
    // Test strategy: handler awaits a barrier, THEN throws. Dialer
    // sends, half-closes, then drains. If the fix works, the drain
    // either returns clean EOF (handler aborted before any reply was
    // sent) or throws a stream error — both well under the 5s deadline
    // we assert on. Without the fix, the drain hangs until vitest's
    // 10s test timeout.
    const a = spawn();
    const b = spawn();
    const netA = new LibP2PNetwork(a);
    const netB = new LibP2PNetwork(b);
    await netA.start();
    await netB.start();
    await netA.addKnownAddresses(b.peerId, b.multiaddrs);

    const protocol = '/test/handler-rejects/1.0.0';
    let handlerEntered = false;
    await netB.handle(protocol, async () => {
      handlerEntered = true;
      // Brief async barrier so the dialer-side send/close completes
      // before the handler aborts the stream — gives us a clean
      // observation point for the drain timing assertion.
      await new Promise((r) => setTimeout(r, 50));
      throw new Error('intentional handler failure');
    });

    const stream = await netA.dialProtocol(b.peerId, protocol);
    try {
      stream.send(new TextEncoder().encode('ping'));
      await stream.close();
    } catch {
      // Stream may already be aborted by the time we send — that's OK,
      // it's the same root cause we're testing for.
    }

    const drainStart = Date.now();
    try {
      for await (const _chunk of stream) { /* discard */ }
    } catch {
      // Aborted-stream error is one of the two acceptable outcomes.
    }
    const drainMs = Date.now() - drainStart;
    expect(handlerEntered).toBe(true);
    // Without the fix, the drain hangs until libp2p's own timeout (>>5s).
    // With the fix, abort propagates immediately.
    expect(drainMs).toBeLessThan(5000);
  }, 10000);

  it('unhandle removes a previously-registered protocol', async () => {
    const a = spawn();
    const b = spawn();
    const netA = new LibP2PNetwork(a);
    const netB = new LibP2PNetwork(b);
    await netA.start();
    await netB.start();
    await netA.addKnownAddresses(b.peerId, b.multiaddrs);

    const protocol = '/test/unhandle/1.0.0';
    await netB.handle(protocol, async (stream) => {
      await stream.close();
    });
    const s1 = await netA.dialProtocol(b.peerId, protocol);
    await s1.close();

    await netB.unhandle(protocol);

    // After unhandle, B should refuse the protocol.
    await expect(netA.dialProtocol(b.peerId, protocol, { timeoutMs: 2000 })).rejects.toThrow();
  }, 15000);
});
