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

  it('aborting an in-flight request tears down the stream so the pool does not stall (Codex #560 round 1)', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    // Start a send that we will abort.
    const ac = new AbortController();
    const cancelled = pool.send(PEER_A, new TextEncoder().encode('first'), { signal: ac.signal });
    await flush();
    const firstStream = node.state.streams.get(PEER_A)!;
    expect(firstStream).toBeDefined();
    // Cancel mid-flight (no response fed yet).
    ac.abort();
    await expect(cancelled).rejects.toThrow(/aborted/);

    // After cancel, the pool should have torn down state — next send
    // opens a fresh stream rather than queuing behind the dead in-flight.
    await flush();
    const next = pool.send(PEER_A, new TextEncoder().encode('second'));
    await flush();
    expect(node.state.dials.get(PEER_A)).toBe(2);
    const secondStream = node.state.streams.get(PEER_A)!;
    expect(secondStream).not.toBe(firstStream);
    secondStream.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('ok')));
    expect(new TextDecoder().decode(await next)).toBe('ok');

    await pool.close();
  });

  it('runs primePeer before dialProtocol on first contact (Codex #560 round 1)', async () => {
    let primed = false;
    let dialed = false;
    const node = makeFakeNode({
      onDial: async () => {
        // Dial must run AFTER prime — assert ordering by spying.
        expect(primed).toBe(true);
        dialed = true;
        return new FakeStream();
      },
    });
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      primePeer: async () => {
        primed = true;
      },
    });
    const pSend = pool.send(PEER_A, new TextEncoder().encode('hi'));
    await flush();
    expect(primed).toBe(true);
    expect(dialed).toBe(true);

    node.state.streams.get(PEER_A)!.feed(
      encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('ok')),
    );
    expect(new TextDecoder().decode(await pSend)).toBe('ok');

    await pool.close();
  });

  it('primePeer failures are swallowed; dial still attempted', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      primePeer: async () => {
        throw new Error('DHT timeout');
      },
    });
    const pSend = pool.send(PEER_A, new TextEncoder().encode('hi'));
    await flush();
    // Dial happened despite the prime throwing.
    expect(node.state.dials.get(PEER_A)).toBe(1);
    node.state.streams.get(PEER_A)!.feed(
      encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('ok')),
    );
    expect(new TextDecoder().decode(await pSend)).toBe('ok');

    await pool.close();
  });

  it('rejects immediately if signal already aborted before send() (Codex #560 round 2)', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const ac = new AbortController();
    ac.abort();
    const pSend = pool.send(PEER_A, new TextEncoder().encode('preborn'), { signal: ac.signal });
    await expect(pSend).rejects.toThrow(/aborted/);
    // Critically: no dial was attempted (we MUST NOT hit the wire
    // for a request that was cancelled before it was even sent).
    expect(node.state.dials.get(PEER_A) ?? 0).toBe(0);

    await pool.close();
  });

  it('rejects if signal aborts mid-dial, without writing to the wire (Codex #560 round 2)', async () => {
    let resolveDial: ((s: FakeStream) => void) | null = null;
    const dialPromise = new Promise<FakeStream>((r) => {
      resolveDial = r;
    });
    const node = makeFakeNode({
      onDial: () => dialPromise,
    });
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const ac = new AbortController();
    const pSend = pool.send(PEER_A, new TextEncoder().encode('inflight'), { signal: ac.signal });
    await flush();
    // Dial in flight, not yet resolved. Abort now.
    ac.abort();
    // Let the dial resolve AFTER abort.
    const stream = new FakeStream();
    resolveDial!(stream);
    await expect(pSend).rejects.toThrow(/aborted/);
    // The request must NOT have written to the stream.
    expect(stream.sent.length).toBe(0);

    await pool.close();
  });

  it('inbound stream closes local half on remote clean EOF (Codex #560 round 5)', async () => {
    let stubHandle:
      | ((stream: unknown, conn: { remotePeer: unknown }) => void)
      | null = null;
    const pool = new MessageStreamPool(
      {
        libp2p: {
          dialProtocol: () => { throw new Error('not used'); },
          handle: (
            _p: string,
            h: (stream: unknown, conn: { remotePeer: unknown }) => void,
          ) => { stubHandle = h; },
          unhandle: () => undefined,
        },
      } as unknown as PoolNode,
      { keepaliveIntervalMs: 0, idleTimeoutMs: 0 },
    );
    pool.registerHandler(async () => new TextEncoder().encode('ack'));
    expect(stubHandle).not.toBeNull();

    const inboundStream = new FakeStream();
    stubHandle!(inboundStream as unknown, { remotePeer: { toString: () => PEER_A } });
    await flush();
    // Remote closes its write side cleanly — no frames, just EOF.
    inboundStream.endRemote();
    // Let the handler's for-await loop exit + finally run.
    await flush();
    await flush();
    await flush();
    // Local half should now be closed — without the round-5 fix
    // it stayed 'open'.
    expect(inboundStream.writeStatus).toBe('closed');
    expect(inboundStream.abortReason).toBeNull(); // ← graceful, not abort

    await pool.close();
  });

  it('inbound handler receives the full remotePeer object (real PeerId parity, Codex #560 round 3)', async () => {
    let stubHandle:
      | ((stream: unknown, conn: { remotePeer: unknown }) => void)
      | null = null;
    const pool = new MessageStreamPool(
      {
        libp2p: {
          dialProtocol: () => { throw new Error('not used'); },
          handle: (
            _p: string,
            h: (stream: unknown, conn: { remotePeer: unknown }) => void,
          ) => {
            stubHandle = h;
          },
          unhandle: () => undefined,
        },
      } as unknown as PoolNode,
      { keepaliveIntervalMs: 0, idleTimeoutMs: 0 },
    );
    let handlerReceivedPeer: unknown = null;
    pool.registerHandler(async (_data, peerId) => {
      handlerReceivedPeer = peerId;
      return new TextEncoder().encode('ack');
    });
    expect(stubHandle).not.toBeNull();

    // Drive an inbound REQUEST through the libp2p.handle callback.
    const inboundStream = new FakeStream();
    inboundStream.feed(encodeFrame(FrameType.REQUEST, new TextEncoder().encode('hi')));
    const productionLikePeer = {
      toString: () => PEER_A,
      toBytes: () => new Uint8Array([0x12, 0x34, 0x56]),
      toMultihash: () => ({ bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }),
      equals: (_other: unknown) => false,
    };
    stubHandle!(inboundStream as unknown, { remotePeer: productionLikePeer });
    await flush();
    await flush();

    // The handler must receive the EXACT remotePeer object — not a
    // hollow `{ toString }` shim. This is what gives ProtocolRouter's
    // wrapper access to `.toMultihash().bytes` for one-shot parity.
    expect(handlerReceivedPeer).toBe(productionLikePeer);
    const asPeer = handlerReceivedPeer as { toBytes: () => Uint8Array };
    expect(Array.from(asPeer.toBytes())).toEqual([0x12, 0x34, 0x56]);

    inboundStream.endRemote();
    await pool.close();
  });

  it('graceful close uses stream.close() not stream.abort() (Codex #560 round 3)', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });
    const pSend = pool.send(PEER_A, new TextEncoder().encode('hi'));
    await flush();
    const stream = node.state.streams.get(PEER_A)!;
    expect(stream).toBeDefined();
    // Complete the request normally so close() finds clean state.
    stream.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('ok')));
    expect(new TextDecoder().decode(await pSend)).toBe('ok');

    // Now close. This is an intentional teardown — must use FIN
    // (stream.close()), not RST_STREAM (stream.abort()). Remote
    // sees clean EOF; their messenger substrate does NOT re-enqueue
    // anything as a transport error.
    const closeStatusBefore = stream.writeStatus;
    await pool.close();
    expect(stream.writeStatus).toBe('closed');
    expect(stream.abortReason).toBeNull(); // ← key assertion: NO abort
    expect(closeStatusBefore).toBe('open');
  });

  it('error teardown still uses stream.abort() (graceful path is opt-in only)', async () => {
    const node = makeFakeNode();
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });
    const pSend = pool.send(PEER_A, new TextEncoder().encode('hi'));
    await flush();
    const stream = node.state.streams.get(PEER_A)!;
    expect(stream).toBeDefined();

    // Simulate a transport-level reset from the remote: feed a
    // malformed frame so the reader's decoder throws.
    stream.feed(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    await flush();
    await flush();
    // The send should have rejected (recoverable).
    await expect(pSend).rejects.toBeInstanceOf(PooledStreamResetError);
    // Error path MUST abort (RST_STREAM), not gracefully close.
    expect(stream.abortReason).not.toBeNull();
  });

  it('one caller cancelling does not abort a shared open for another caller (Codex #560 round 4)', async () => {
    // Hold the dial in flight so two concurrent callers serialize
    // on the same `openLocks` promise.
    let resolveDial: ((s: FakeStream) => void) | null = null;
    const dialPromise = new Promise<FakeStream>((r) => { resolveDial = r; });
    const node = makeFakeNode({ onDial: () => dialPromise });
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const acA = new AbortController();
    const sendA = pool.send(PEER_A, new TextEncoder().encode('a'), { signal: acA.signal });
    const sendB = pool.send(PEER_A, new TextEncoder().encode('b'));
    await flush();
    // Both share the same in-flight dial. A aborts.
    acA.abort();
    await expect(sendA).rejects.toThrow(/aborted/);
    // Now the dial completes — B's request MUST still go through.
    const stream = new FakeStream();
    resolveDial!(stream);
    await flush();
    await flush();
    // Only B should be in-flight on the stream now.
    stream.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('b-ok')));
    expect(new TextDecoder().decode(await sendB)).toBe('b-ok');
    // Exactly ONE dial attempt was made (the shared open).
    expect(node.state.dials.get(PEER_A)).toBe(1);

    await pool.close();
  });

  it('close() during in-flight dial closes the resulting stream rather than installing it (Codex #560 round 4)', async () => {
    let resolveDial: ((s: FakeStream) => void) | null = null;
    const dialPromise = new Promise<FakeStream>((r) => { resolveDial = r; });
    const node = makeFakeNode({ onDial: () => dialPromise });
    const pool = new MessageStreamPool(node, {
      peerIdFromString: stubPeerIdFromString,
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
    });

    const pSend = pool.send(PEER_A, new TextEncoder().encode('hi'));
    await flush();
    // close() runs WHILE the dial is in flight.
    const closing = pool.close();
    // Now resolve the dial — pool must NOT install the stream.
    const lateStream = new FakeStream();
    resolveDial!(lateStream);
    await closing;
    await expect(pSend).rejects.toBeInstanceOf(PooledStreamResetError);
    // No peer state was registered post-close.
    expect(pool.size()).toBe(0);
    // The late stream was aborted by the pool (no leaked alive stream).
    await flush();
    expect(lateStream.abortReason).not.toBeNull();
  });

  it('honors caller-supplied timeoutMs above the pool default (Codex #560 round 2)', async () => {
    vi.useFakeTimers();
    try {
      const node = makeFakeNode();
      const pool = new MessageStreamPool(node, {
        peerIdFromString: stubPeerIdFromString,
        keepaliveIntervalMs: 0,
        idleTimeoutMs: 0,
        requestTimeoutMs: 1000,
      });

      // Caller asks for 5x the pool default — must NOT be capped.
      const pSend = pool.send(PEER_A, new TextEncoder().encode('long'), {
        timeoutMs: 5000,
      });
      // Pump open + write paths.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // At T=1500ms (past pool default), the request must still be pending.
      await vi.advanceTimersByTimeAsync(1500);
      let settled = false;
      pSend.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      // At T=5000ms (caller's budget), the request must reject with
      // the pool's recoverable timeout error.
      await vi.advanceTimersByTimeAsync(3600);
      await expect(pSend).rejects.toBeInstanceOf(PooledStreamResetError);

      await pool.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
