import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageStreamPool,
  POOLED_MESSAGE_PROTOCOL,
  PooledStreamResetError,
  type PoolNode,
  type PooledStreamHandler,
} from '../src/message-stream-pool.js';
import {
  FrameType,
  encodeFrame,
  decodeFrames,
} from '../src/message-frame.js';

/**
 * A pairable in-memory libp2p stream stub. Reads block on an async
 * queue; writes either go to a sibling stream's read queue (via
 * {@link pair}) or are buffered for inspection.
 */
class FakeStream {
  writeStatus: 'open' | 'closing' | 'closed' = 'open';
  readonly sent: Uint8Array[] = [];
  private readBuf: Uint8Array[] = [];
  private waiters: Array<(v: IteratorResult<Uint8Array>) => void> = [];
  private ended = false;
  private peer: FakeStream | null = null;
  abortReason: Error | null = null;

  send(data: Uint8Array): void {
    if (this.writeStatus !== 'open') throw new Error('stream closed for write');
    const copy = new Uint8Array(data);
    this.sent.push(copy);
    if (this.peer) {
      this.peer.feed(copy);
    }
  }

  feed(data: Uint8Array): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: data, done: false });
    } else {
      this.readBuf.push(data);
    }
  }

  endRemote(): void {
    this.ended = true;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: undefined as unknown as Uint8Array, done: true });
    }
  }

  abort(err: Error): void {
    this.abortReason = err;
    this.writeStatus = 'closed';
    this.endRemote();
    if (this.peer) {
      this.peer.endRemote();
    }
  }

  async close(): Promise<void> {
    this.writeStatus = 'closed';
  }

  pair(other: FakeStream): void {
    this.peer = other;
    other.peer = this;
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
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

interface FakeNodeState {
  /** Recorded dial attempts per peer (count). */
  dials: Map<string, number>;
  /** Streams the node returned from its most recent dialProtocol per peer. */
  streams: Map<string, FakeStream>;
  /** Registered inbound handler for the protocol, if any. */
  inboundHandler: ((stream: FakeStream, peerStr: string) => void) | null;
  /** Inbound side's stream (the receiving fake). */
  inboundStreams: Map<string, FakeStream>;
}

interface FakeNode extends PoolNode {
  state: FakeNodeState;
  // Manually drive a remote dial: the test acts as the peer dialling
  // INTO this node. Returns the stream the node's handler is reading
  // from (so the test can write requests into it).
  simulateInboundDial(remotePeerStr: string): { remoteWrites: FakeStream; localReads: FakeStream };
}

function makeFakeNode(opts: {
  /**
   * Optional override: when the pool dials a peer, the test wants to
   * control what stream comes back. By default, the node creates a
   * paired stream and returns one side; the test gets the other via
   * `state.streams.get(peerIdStr)` (the side the node returned to
   * the pool's caller).
   *
   * Returning `null` simulates a dial failure (test passes the
   * thrown error in).
   */
  onDial?: (peerIdStr: string) => Promise<FakeStream | null>;
} = {}): FakeNode {
  const state: FakeNodeState = {
    dials: new Map(),
    streams: new Map(),
    inboundHandler: null,
    inboundStreams: new Map(),
  };
  const node: FakeNode = {
    state,
    libp2p: {
      dialProtocol: async (peerId, _protocols, _options) => {
        const peerIdStr =
          typeof peerId === 'string' ? peerId : (peerId as { toString: () => string }).toString();
        state.dials.set(peerIdStr, (state.dials.get(peerIdStr) ?? 0) + 1);
        if (opts.onDial) {
          const s = await opts.onDial(peerIdStr);
          if (s === null) throw new Error('dial rejected');
          state.streams.set(peerIdStr, s);
          return s as unknown as import('@libp2p/interface').Stream;
        }
        const stream = new FakeStream();
        state.streams.set(peerIdStr, stream);
        return stream as unknown as import('@libp2p/interface').Stream;
      },
      handle: (_protocolId, handler, _opts) => {
        state.inboundHandler = (s, peerStr) =>
          handler(s as unknown as import('@libp2p/interface').Stream, {
            remotePeer: { toString: () => peerStr },
          });
      },
      unhandle: () => {
        state.inboundHandler = null;
      },
    },
    simulateInboundDial(remotePeerStr: string) {
      // remoteWrites — what the dialer (the peer) writes into.
      // localReads — what the node reads from.
      // They're paired so writing into one feeds the other's read.
      const localReads = new FakeStream();
      const remoteWrites = new FakeStream();
      // Pair them: writing to remoteWrites feeds localReads; writing
      // to localReads feeds remoteWrites.
      remoteWrites.pair(localReads);
      state.inboundStreams.set(remotePeerStr, localReads);
      if (state.inboundHandler) {
        state.inboundHandler(localReads, remotePeerStr);
      }
      return { remoteWrites, localReads };
    },
  };
  return node;
}

const PEER_A = '12D3KooWPeerA0000000000000000000000000000000000000000aaaa';
const PEER_B = '12D3KooWPeerB0000000000000000000000000000000000000000bbbb';

/**
 * Drain the microtask queue. We don't know exactly how many awaits
 * the dial+install chain costs (resolvePeerId + dialProtocol +
 * installState + dispatchSend), so flush generously.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

describe('MessageStreamPool', () => {
  // Skip libp2p's peerIdFromString import in tests via stub.
  const stubPeerIdFromString = (s: string): unknown => ({ toString: () => s });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('opens one stream per peer and reuses it across sends', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const sendPromise1 = pool.send(PEER_A, new TextEncoder().encode('hello'));
    // Wait a tick for the dial + stream wire-up.
    await flush();
    await flush();

    const dialedStream = node.state.streams.get(PEER_A)!;
    expect(dialedStream).toBeDefined();
    // First REQUEST frame should be in `sent`.
    expect(dialedStream.sent.length).toBeGreaterThanOrEqual(1);

    // Simulate response from peer.
    dialedStream.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('world')));
    const resp1 = await sendPromise1;
    expect(new TextDecoder().decode(resp1)).toBe('world');

    // Second send should NOT open a new stream.
    const sendPromise2 = pool.send(PEER_A, new TextEncoder().encode('hello2'));
    await flush();
    await flush();
    expect(node.state.dials.get(PEER_A)).toBe(1);
    dialedStream.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('world2')));
    const resp2 = await sendPromise2;
    expect(new TextDecoder().decode(resp2)).toBe('world2');

    await pool.close();
  });

  it('serialises in-flight sends per peer (FIFO)', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const a = pool.send(PEER_A, new TextEncoder().encode('a'));
    const b = pool.send(PEER_A, new TextEncoder().encode('b'));
    const c = pool.send(PEER_A, new TextEncoder().encode('c'));

    // Let the pool drain its work.
    await flush();
    await flush();

    const s = node.state.streams.get(PEER_A)!;
    // Only ONE REQUEST should be written so far (serial).
    let requestFrames = 0;
    for (const w of s.sent) {
      const ft = w[1];
      if (ft === FrameType.REQUEST) requestFrames += 1;
    }
    expect(requestFrames).toBe(1);

    // Answer first; second should now go out.
    s.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('A')));
    expect(new TextDecoder().decode(await a)).toBe('A');

    // After the response, the next REQUEST should have been pumped.
    await flush();
    await flush();
    requestFrames = 0;
    for (const w of s.sent) {
      const ft = w[1];
      if (ft === FrameType.REQUEST) requestFrames += 1;
    }
    expect(requestFrames).toBe(2);

    s.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('B')));
    expect(new TextDecoder().decode(await b)).toBe('B');

    await flush();
    await flush();
    s.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('C')));
    expect(new TextDecoder().decode(await c)).toBe('C');

    await pool.close();
  });

  it('opens separate streams per peer (no cross-contamination)', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const a = pool.send(PEER_A, new TextEncoder().encode('to-A'));
    const b = pool.send(PEER_B, new TextEncoder().encode('to-B'));

    await flush();
    await flush();

    expect(node.state.dials.get(PEER_A)).toBe(1);
    expect(node.state.dials.get(PEER_B)).toBe(1);

    const sA = node.state.streams.get(PEER_A)!;
    const sB = node.state.streams.get(PEER_B)!;

    sA.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('respA')));
    sB.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('respB')));

    expect(new TextDecoder().decode(await a)).toBe('respA');
    expect(new TextDecoder().decode(await b)).toBe('respB');

    await pool.close();
  });

  it('rejects pending sends on stream reset (recoverable)', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const pSend = pool.send(PEER_A, new TextEncoder().encode('hi'));
    await flush();
    await flush();
    const stream = node.state.streams.get(PEER_A)!;
    stream.abort(new Error('peer reset'));
    await expect(pSend).rejects.toBeInstanceOf(PooledStreamResetError);
  });

  it('reopens stream on next send after reset', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const a = pool.send(PEER_A, new TextEncoder().encode('hi'));
    await flush();
    await flush();
    const first = node.state.streams.get(PEER_A)!;
    first.abort(new Error('peer reset'));
    await expect(a).rejects.toBeInstanceOf(PooledStreamResetError);

    // Allow the teardown to propagate.
    await flush();
    await flush();

    const b = pool.send(PEER_A, new TextEncoder().encode('hi2'));
    await flush();
    await flush();
    expect(node.state.dials.get(PEER_A)).toBe(2);
    const second = node.state.streams.get(PEER_A)!;
    expect(second).not.toBe(first);
    second.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('ok')));
    expect(new TextDecoder().decode(await b)).toBe('ok');

    await pool.close();
  });

  it('responds to PING with PONG on outbound stream', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    // Force-open a stream by sending a dummy.
    const pSend = pool.send(PEER_A, new TextEncoder().encode('warm'));
    await flush();
    await flush();
    const s = node.state.streams.get(PEER_A)!;
    // Server sends PING; pool should respond PONG.
    s.feed(encodeFrame(FrameType.PING));
    await flush();
    await flush();
    // Among s.sent, find a PONG frame.
    const sawPong = s.sent.some((buf) => buf[1] === FrameType.PONG);
    expect(sawPong).toBe(true);
    // The original send is still pending — answer it so the test
    // doesn't hang on cleanup.
    s.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('ok')));
    await pSend;
    await pool.close();
  });

  it('keepalive timer emits PING frames after the configured interval', async () => {
    vi.useFakeTimers();
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 5000,
      idleTimeoutMs: 0,
    });

    const pSend = pool.send(PEER_A, new TextEncoder().encode('warm'));
    // Give the dial a real-timer microtask window to settle.
    await vi.advanceTimersByTimeAsync(0);
    const s = node.state.streams.get(PEER_A)!;
    s.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('ok')));
    await pSend;
    expect(s.sent.some((b) => b[1] === FrameType.PING)).toBe(false);

    // Advance past one keepalive interval.
    await vi.advanceTimersByTimeAsync(5500);
    expect(s.sent.some((b) => b[1] === FrameType.PING)).toBe(true);

    await pool.close();
    vi.useRealTimers();
  });

  it('idle timeout closes the stream when inactive', async () => {
    vi.useFakeTimers();
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 3000,
    });

    const pSend = pool.send(PEER_A, new TextEncoder().encode('hi'));
    await vi.advanceTimersByTimeAsync(0);
    const s = node.state.streams.get(PEER_A)!;
    s.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('ok')));
    await pSend;
    // Pool stats present.
    expect(pool.stats(PEER_A)).toBeDefined();

    await vi.advanceTimersByTimeAsync(3500);
    // After idle timeout, the per-peer state should be gone.
    expect(pool.stats(PEER_A)).toBeUndefined();

    await pool.close();
    vi.useRealTimers();
  });

  it('inbound handler answers framed requests', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const handler: PooledStreamHandler = async (req) => {
      return new TextEncoder().encode(`echo:${new TextDecoder().decode(req)}`);
    };
    pool.registerHandler(handler);

    // Simulate the remote peer dialling into us.
    const { remoteWrites } = node.simulateInboundDial(PEER_B);
    // Send a REQUEST frame from the "remote" side.
    remoteWrites.send(encodeFrame(FrameType.REQUEST, new TextEncoder().encode('ping')));

    // The handler will respond on the localReads side; we set up the
    // pair so feeding remoteWrites goes to localReads. We read what
    // the handler wrote BACK by inspecting remoteWrites.sent (which
    // is paired with localReads, so writes from localReads-side
    // appear in remoteWrites's read buffer / sent... wait, our
    // FakeStream pair semantics are: each side's `send` feeds the
    // peer's read queue. The remoteWrites side's reads = what the
    // handler wrote.

    // Wait for handler dispatch.
    let response: { type: FrameType; payload: Uint8Array } | undefined;
    const expectedFrame = encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('echo:ping'));
    void expectedFrame;
    for (let i = 0; i < 50; i++) {
      // Drain anything the remote side received from the handler.
      // remoteWrites is the dialer side; reads come from its async
      // iterator. Use a probe iterator.
      const buf: Uint8Array[] = [];
      // Pull whatever is currently buffered.
      // Since FakeStream's iterator awaits new data, we peek by
      // resolving microtasks.
      await flush();
      await flush();
      // Combine accumulated reads from remoteWrites:
      const accum = (remoteWrites as unknown as { readBuf: Uint8Array[] }).readBuf;
      if (accum.length > 0) {
        buf.push(...accum);
        for await (const f of decodeFrames(
          (async function* () {
            for (const c of buf) yield c;
          })(),
        )) {
          response = f;
          break;
        }
        break;
      }
    }
    expect(response).toBeDefined();
    expect(response!.type).toBe(FrameType.RESPONSE);
    expect(new TextDecoder().decode(response!.payload)).toBe('echo:ping');

    await pool.close();
  });

  it('inbound handler errors surface as ERROR frame, not stream teardown', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const handler: PooledStreamHandler = async () => {
      throw new Error('boom');
    };
    pool.registerHandler(handler);

    const { remoteWrites } = node.simulateInboundDial(PEER_B);
    remoteWrites.send(encodeFrame(FrameType.REQUEST, new TextEncoder().encode('?')));
    // Drain.
    let response: { type: FrameType; payload: Uint8Array } | undefined;
    for (let i = 0; i < 50; i++) {
      await flush();
      const accum = (remoteWrites as unknown as { readBuf: Uint8Array[] }).readBuf;
      if (accum.length > 0) {
        for await (const f of decodeFrames(
          (async function* () {
            for (const c of accum) yield c;
          })(),
        )) {
          response = f;
          break;
        }
        break;
      }
    }
    expect(response).toBeDefined();
    expect(response!.type).toBe(FrameType.ERROR);
    expect(new TextDecoder().decode(response!.payload)).toBe('boom');

    await pool.close();
  });

  it('close() rejects pending sends and prevents new sends', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const pSend = pool.send(PEER_A, new TextEncoder().encode('hi'));
    await flush();
    await flush();
    await pool.close();
    await expect(pSend).rejects.toBeInstanceOf(PooledStreamResetError);
    await expect(pool.send(PEER_A, new Uint8Array([0]))).rejects.toBeInstanceOf(PooledStreamResetError);
  });

  it('POOLED_MESSAGE_PROTOCOL is the wire-version-bump constant', () => {
    expect(POOLED_MESSAGE_PROTOCOL).toBe('/dkg/10.0.2/message');
  });
});
