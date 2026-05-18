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
  /**
   * Spy hook for `libp2p.unhandle(protocolId)`. Tests can use it to
   * assert that both logical and pooled wire handlers are released
   * (Codex PR #560 round-2 unregister leak).
   */
  onUnhandle?: (protocolId: string) => void;
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
      unhandle: (protocolId: string) => {
        if (opts.onUnhandle) opts.onUnhandle(protocolId);
      },
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

  it('closePooling tears down peer state (live peer count drops to zero)', async () => {
    const fixture = makeRouterFixture();
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });

    // Open a stream + complete one request so the peer is fully
    // established (we can then assert closePooling() drops it).
    const pSend = fixture.router.send(
      PEER_NEW,
      '/dkg/10.0.1/message',
      new TextEncoder().encode('a'),
    );
    await flush();
    fixture.streamsByCall[0]!.feed(encodeFrame(FrameType.RESPONSE, new TextEncoder().encode('ok')));
    expect(new TextDecoder().decode(await pSend)).toBe('ok');
    expect(fixture.router.pooledStatus()[0].livePeers).toBe(1);

    await fixture.router.closePooling();
    expect(fixture.router.pooledStatus()).toEqual([]);
  });

  it('first-contact transient pool error falls through to one-shot (Codex #560 round 1)', async () => {
    let pooledCalls = 0;
    let logicalCalls = 0;
    const fixture = makeRouterFixture({
      onDial: async (_peer, protocols) => {
        if (protocols === POOLED_MESSAGE_PROTOCOL) {
          pooledCalls += 1;
          // Cold-peer-class failure: no addresses in peerStore. Not
          // a protocol-negotiation error; without fallback, enabling
          // pooling would regress first-contact delivery.
          throw new Error('The dial request has no valid addresses for peer');
        }
        logicalCalls += 1;
        const s = new FakeStream();
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
      PEER_NEW,
      '/dkg/10.0.1/message',
      new TextEncoder().encode('x'),
    );
    expect(new TextDecoder().decode(resp)).toBe('one-shot-resp');
    expect(pooledCalls).toBe(1);
    expect(logicalCalls).toBe(1);
    // Crucially we do NOT memoize as one-shot — the failure was
    // transient, not a definitive protocol-unsupported signal — so
    // the next send retries the pool.
    expect(fixture.router.peerWireVariantFor(PEER_NEW, '/dkg/10.0.1/message')).toBeUndefined();

    await fixture.router.closePooling();
  });

  it('established pooled peer transient errors still bubble (no spurious wire switch)', async () => {
    // Use a manual peer-wire memo so we can simulate "we already
    // know this peer is pooled-capable" without the round-trip
    // setup.
    const fixture = makeRouterFixture({
      onDial: async (_peer, protocols) => {
        if (protocols === POOLED_MESSAGE_PROTOCOL) {
          throw new Error('ECONNRESET');
        }
        return new FakeStream();
      },
    });
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });
    // Manually mark the peer as pooled-capable.
    fixture.router.memoizePeerWire(PEER_NEW, '/dkg/10.0.1/message', 'pooled');

    await expect(
      fixture.router.send(PEER_NEW, '/dkg/10.0.1/message', new TextEncoder().encode('x')),
    ).rejects.toThrow();
    // Wire memo is preserved — next outbox retry stays on pooled.
    expect(fixture.router.peerWireVariantFor(PEER_NEW, '/dkg/10.0.1/message')).toBe('pooled');

    await fixture.router.closePooling();
  });

  it('overall send timeoutMs is shared across pool + one-shot fallback (Codex #560 round 4)', async () => {
    // Slow pool failure → fall-through to one-shot. Total elapsed
    // wall-clock MUST stay under `timeoutMs`, not 2x.
    const fixture = makeRouterFixture({
      onDial: async (_peer, protocols) => {
        if (protocols === POOLED_MESSAGE_PROTOCOL) {
          // Simulate a slow pool failure that consumes ~half the
          // overall budget.
          await new Promise((r) => setTimeout(r, 150));
          throw new Error('no valid addresses');
        }
        // One-shot succeeds quickly.
        const s = new FakeStream();
        queueMicrotask(() => {
          s.feed(new TextEncoder().encode('shot-resp'));
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

    const started = Date.now();
    const resp = await fixture.router.send(
      PEER_NEW,
      '/dkg/10.0.1/message',
      new TextEncoder().encode('x'),
      { timeoutMs: 500 },
    );
    const elapsed = Date.now() - started;
    expect(new TextDecoder().decode(resp)).toBe('shot-resp');
    // Total wall-clock MUST be well under 2 * timeoutMs (the bug
    // shape) — we allow some headroom for the one-shot path's own
    // retry budget but cap at 750ms to fail loudly on a regression.
    expect(elapsed).toBeLessThan(750);

    await fixture.router.closePooling();
  });

  it('throws when a second logical claims an already-used wire id (Codex #560 round 3)', () => {
    const fixture = makeRouterFixture();
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });
    // Second logical, default wire id (collides with first pool).
    expect(() =>
      fixture.router.enablePooling('/dkg/10.0.1/some-other-logical', {
        keepaliveIntervalMs: 0,
        idleTimeoutMs: 0,
        peerIdFromString: (s) => ({ toString: () => s }) as unknown,
      }),
    ).toThrow(/already claimed by/);
    // Passing a DISTINCT wire id works.
    expect(() =>
      fixture.router.enablePooling('/dkg/10.0.1/some-other-logical', {
        protocolId: '/dkg/10.0.3/some-other-wire',
        keepaliveIntervalMs: 0,
        idleTimeoutMs: 0,
        peerIdFromString: (s) => ({ toString: () => s }) as unknown,
      }),
    ).not.toThrow();
  });

  it('unregister(logicalId) clears peerWireVariant memos for that logical (Codex #560 round 5)', () => {
    const fixture = makeRouterFixture();
    fixture.router.register('/dkg/10.0.1/message', async () => new Uint8Array());
    fixture.router.register('/dkg/other/1.0.0', async () => new Uint8Array());
    fixture.router.memoizePeerWire(PEER_NEW, '/dkg/10.0.1/message', 'one-shot');
    fixture.router.memoizePeerWire(PEER_NEW, '/dkg/other/1.0.0', 'pooled');
    expect(fixture.router.peerWireVariantFor(PEER_NEW, '/dkg/10.0.1/message')).toBe('one-shot');
    expect(fixture.router.peerWireVariantFor(PEER_NEW, '/dkg/other/1.0.0')).toBe('pooled');

    fixture.router.unregister('/dkg/10.0.1/message');
    // Memos for the unregistered logical must be cleared.
    expect(fixture.router.peerWireVariantFor(PEER_NEW, '/dkg/10.0.1/message')).toBeUndefined();
    // Memos for OTHER logicals are preserved.
    expect(fixture.router.peerWireVariantFor(PEER_NEW, '/dkg/other/1.0.0')).toBe('pooled');
  });

  it('one-shot backoff respects the overall deadline (Codex #560 round 5)', async () => {
    let oneShotAttempts = 0;
    const fixture = makeRouterFixture({
      onDial: async (_peer, protocols) => {
        if (protocols === POOLED_MESSAGE_PROTOCOL) {
          // Pool burns ~half the overall budget then fails recoverably.
          await new Promise((r) => setTimeout(r, 200));
          throw new Error('no valid addresses');
        }
        oneShotAttempts += 1;
        // One-shot always fails recoverably — would normally retry
        // with 500ms backoff, then 1000ms.
        throw new Error('stream reset');
      },
    });
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });

    const started = Date.now();
    await expect(
      fixture.router.send(PEER_NEW, '/dkg/10.0.1/message', new TextEncoder().encode('x'), {
        timeoutMs: 400,
      }),
    ).rejects.toThrow();
    const elapsed = Date.now() - started;
    // Total elapsed must respect the 400ms budget — the bug shape
    // would let one-shot's 500ms backoff push us to ~900ms.
    expect(elapsed).toBeLessThan(650);
    // The first one-shot attempt should have run; the SECOND
    // attempt's backoff aborts on overall deadline.
    expect(oneShotAttempts).toBeGreaterThanOrEqual(1);

    await fixture.router.closePooling();
  });

  it('unregister(logicalId) tears down the pooled wire handler (Codex #560 round 2)', async () => {
    const unhandleCalls: string[] = [];
    const fixture = makeRouterFixture({
      onUnhandle: (protocolId) => {
        unhandleCalls.push(protocolId);
      },
    });
    fixture.router.register('/dkg/10.0.1/message', async () => new Uint8Array([0xaa]));
    fixture.router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });

    fixture.router.unregister('/dkg/10.0.1/message');
    await flush();

    // Both the logical AND the wire protocol must have been unhandled.
    expect(unhandleCalls).toContain('/dkg/10.0.1/message');
    expect(unhandleCalls).toContain(POOLED_MESSAGE_PROTOCOL);
    // Overlay is fully detached — pooledStatus reports it gone.
    expect(fixture.router.pooledStatus()).toEqual([]);
  });

  it('primes peerResolver before pool dial (cold-peer recovery, Codex #560 round 1)', async () => {
    const resolveCalls: string[] = [];
    const peerResolver = {
      resolve: async (peerIdStr: string) => {
        resolveCalls.push(peerIdStr);
        return [];
      },
    } as unknown as import('../src/network/peer-resolver.js').PeerResolver;
    let dialCalls = 0;
    const node = {
      libp2p: {
        dialProtocol: async () => {
          dialCalls += 1;
          // Assert the resolver ran BEFORE the dial.
          expect(resolveCalls.length).toBeGreaterThan(0);
          const s = new FakeStream();
          return s as unknown as import('@libp2p/interface').Stream;
        },
        handle: () => undefined,
        unhandle: () => undefined,
        getConnections: () => [],
        peerStore: { get: async () => ({ addresses: [] }) },
      },
    } as unknown as DKGNode;
    const { ProtocolRouter } = await import('../src/protocol-router.js');
    const router = new ProtocolRouter(node, { peerResolver });
    router.enablePooling('/dkg/10.0.1/message', {
      keepaliveIntervalMs: 0,
      idleTimeoutMs: 0,
      peerIdFromString: (s) => ({ toString: () => s }) as unknown,
    });
    // Avoid awaiting the send — the FakeStream never responds, so
    // the test's job is just to verify the prime → dial ordering
    // happened. Swallow the eventual rejection so it doesn't leak
    // as an unhandled promise.
    const pSend = router.send(PEER_NEW, '/dkg/10.0.1/message', new TextEncoder().encode('a'));
    pSend.catch(() => undefined);
    await flush();
    expect(resolveCalls).toEqual([PEER_NEW]);
    expect(dialCalls).toBe(1);
    await router.closePooling();
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
