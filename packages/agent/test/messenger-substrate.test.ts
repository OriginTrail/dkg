import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  decodeReliableEnvelope,
  encodeReliableEnvelope,
  RELIABLE_ENVELOPE_VERSION,
  RESPONSE_GONE_MARKER,
  type LegacyProtocolOutboxStore,
  type ProtocolRouter,
  type StreamHandler,
} from '@origintrail-official/dkg-core';
import {
  DEFAULT_OUTBOX_DRAIN_BATCH_SIZE,
  Messenger,
  MessengerNotConfiguredError,
} from '../src/p2p/messenger.js';

/**
 * Hand-rolled call recorder: records every call's args on `.calls`
 * and delegates to `impl`. Replaces the former vitest auto-spies as
 * a plain DI seam — no behaviour mocking, just observation.
 */
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

/**
 * Mutable clock seam: a no-arg recorder whose backing implementation
 * can be swapped via `.set(impl)`. Stands in for the injectable
 * wall-clock the Messenger reads; tests drive deterministic
 * timestamps by re-pointing the impl mid-test.
 */
function makeClock(initial: () => number) {
  let impl = initial;
  const calls: [][] = [];
  const fn = (): number => {
    calls.push([]);
    return impl();
  };
  return Object.assign(fn, {
    calls,
    set(next: () => number) {
      impl = next;
    },
  });
}

const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PROTO = '/dkg/10.0.1/message';
const FIXED_MSG_ID = '00000000-0000-4000-8000-000000000001';

interface RouterDouble {
  send: ReturnType<typeof recorder<[string, string, Uint8Array, ...unknown[]], Promise<Uint8Array>>>;
  register: ReturnType<
    typeof recorder<
      [string, StreamHandler, { maxReadBytes: number }?],
      void
    >
  >;
  /** Inbound stream handler captured from `register` for tests that invoke it. */
  inboundHandler?: StreamHandler;
}

function makeRouter(
  sendImpl?: (...args: [string, string, Uint8Array, ...unknown[]]) => Promise<Uint8Array>,
): RouterDouble {
  const send = recorder(
    (sendImpl ?? (async () => new Uint8Array([0x10]))) as (
      ...args: [string, string, Uint8Array, ...unknown[]]
    ) => Promise<Uint8Array>,
  );
  const register = recorder((
    _protocol: string,
    handler: StreamHandler,
    _options?: { maxReadBytes: number },
  ): void => {
    router.inboundHandler = handler;
  });
  const router: RouterDouble = { send, register };
  return router;
}

function makeSubstrate(overrides: {
  router?: RouterDouble;
  resolvePeer?: (peerId: string, opts: { signal: AbortSignal }) => Promise<void>;
} = {}) {
  const router = overrides.router ?? makeRouter();
  const idempotencyStore = new InMemoryMessageIdempotencyStore();
  const outboxStore = new InMemoryProtocolOutboxStore({
    backoffs: [10],
    maxAgeMs: 60_000,
  });
  const clock = makeClock(() => 1_700_000_000_000);
  const messenger = new Messenger({
    router: router as unknown as ProtocolRouter,
    idempotencyStore,
    outboxStore,
    backoffs: [10],
    maxAgeMs: 60_000,
    clock,
    resolvePeer: overrides.resolvePeer,
  });
  return { messenger, router, idempotencyStore, outboxStore, clock };
}

describe('Messenger.sendReliable (happy path semantics)', () => {
  it('accepts a legacy custom outbox store with pendingFor but no hasPendingFor', async () => {
    const backing = new InMemoryProtocolOutboxStore({ backoffs: [10], maxAgeMs: 60_000 });
    const legacyStore: LegacyProtocolOutboxStore = {
      enqueue: backing.enqueue.bind(backing),
      markDelivered: backing.markDelivered.bind(backing),
      hasEntry: backing.hasEntry.bind(backing),
      pendingFor: backing.pendingFor.bind(backing),
      due: backing.due.bind(backing),
      dropExpired: backing.dropExpired.bind(backing),
      size: backing.size.bind(backing),
      list: backing.list.bind(backing),
      getEntry: backing.getEntry.bind(backing),
    };
    const router = makeRouter(async () => new Uint8Array([0x42]));
    const messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore: new InMemoryMessageIdempotencyStore(),
      outboxStore: legacyStore,
      backoffs: [10],
      maxAgeMs: 60_000,
    });

    const result = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });

    expect(result.delivered).toBe(true);
    expect(router.send.calls).toHaveLength(1);
    expect(legacyStore.pendingFor(PEER_A)).toEqual([]);
  });

  it('envelope-wraps the payload before calling router.send', async () => {
    const { messenger, router } = makeSubstrate();
    const payload = new TextEncoder().encode('hello');

    const result = await messenger.sendReliable(PEER_B, PROTO, payload, {
      messageId: FIXED_MSG_ID,
    });

    expect(result).toMatchObject({
      delivered: true,
      messageId: FIXED_MSG_ID,
      attempts: 1,
    });
    expect(router.send.calls).toHaveLength(1);
    const [, , wireBytes] = router.send.calls[0];
    const decoded = decodeReliableEnvelope(wireBytes as Uint8Array);
    expect(decoded.messageId).toBe(FIXED_MSG_ID);
    expect(decoded.version).toBe(RELIABLE_ENVELOPE_VERSION);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it('returns the response bytes from the wire send', async () => {
    const router = makeRouter(async () => new Uint8Array([0x42]));
    const { messenger } = makeSubstrate({ router });
    const result = await messenger.sendReliable(
      PEER_A,
      PROTO,
      new Uint8Array([1]),
      { messageId: FIXED_MSG_ID },
    );
    expect(result.delivered).toBe(true);
    expect(result.delivered && Array.from(result.response)).toEqual([0x42]);
  });

  it('records the response in the idempotency store under direction=out', async () => {
    const router = makeRouter(async () => new Uint8Array([0x42]));
    const { messenger, idempotencyStore } = makeSubstrate({ router });
    await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    const check = idempotencyStore.check(PEER_A, PROTO, FIXED_MSG_ID, 'out');
    expect(check.seen).toBe(true);
    expect(check.seen && Array.from(check.cachedResponse ?? [])).toEqual([0x42]);
  });

  it('queues a protocol-invalid response and validates it again before retry completion', async () => {
    let valid = false;
    const router = makeRouter(async () => valid ? new Uint8Array([0x42]) : new Uint8Array());
    const { messenger, idempotencyStore, outboxStore, clock } = makeSubstrate({ router });
    messenger.setResponseAcceptanceValidator(PROTO, (response) => response.byteLength > 0);

    const first = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });

    expect(first).toMatchObject({ delivered: false, queued: true });
    expect(outboxStore.size()).toBe(1);
    expect(idempotencyStore.check(PEER_A, PROTO, FIXED_MSG_ID, 'out').seen).toBe(false);

    valid = true;
    await messenger.processOutboxTick(clock() + 100);

    expect(router.send.calls).toHaveLength(2);
    expect(outboxStore.size()).toBe(0);
    expect(idempotencyStore.check(PEER_A, PROTO, FIXED_MSG_ID, 'out').seen).toBe(true);
  });

  it('generates a UUID when no messageId is supplied', async () => {
    const { messenger } = makeSubstrate();
    const result = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]));
    expect(result.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('Messenger.sendRequestOwned', () => {
  it('keeps reliable framing but does not persist recoverable failures', async () => {
    const router = makeRouter(async () => {
      throw new Error('no valid addresses for peer');
    });
    const resolvePeer = recorder(
      async (_peerId: string, _opts: { signal: AbortSignal }): Promise<void> => undefined,
    );
    const { messenger, outboxStore } = makeSubstrate({ router, resolvePeer });

    await expect(messenger.sendRequestOwned(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    })).rejects.toThrow('no valid addresses for peer');
    expect(outboxStore.size()).toBe(0);
    expect(() => decodeReliableEnvelope(router.send.calls[0][2] as Uint8Array)).not.toThrow();
    expect((messenger as any).firstAttemptAt.size).toBe(0);
    expect(resolvePeer.calls).toEqual([[PEER_A, { signal: expect.any(AbortSignal) }]]);

    // ACKCollector retries with a fresh message id. Recovery remains
    // request-owned and rate-limited rather than creating an outbox attempt
    // counter just to reach the normal durable-send DHT threshold.
    await expect(messenger.sendRequestOwned(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: '00000000-0000-4000-8000-000000000002',
    })).rejects.toThrow('no valid addresses for peer');
    expect(outboxStore.size()).toBe(0);
    expect((messenger as any).firstAttemptAt.size).toBe(0);
    expect(resolvePeer.calls).toHaveLength(1);
  });

  it('does not return an address failure until slow DHT recovery can affect the next retry', async () => {
    vi.useFakeTimers();
    try {
      let peerResolved = false;
      const router = makeRouter(async () => {
        if (!peerResolved) throw new Error('no valid addresses for peer');
        return new Uint8Array([0x42]);
      });
      const resolvePeer = recorder(
        async (_peerId: string, _opts: { signal: AbortSignal }): Promise<void> => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
          peerResolved = true;
        },
      );
      const { messenger, outboxStore } = makeSubstrate({ router, resolvePeer });

      let firstSettled = false;
      const firstOutcome = messenger.sendRequestOwned(
        PEER_A,
        PROTO,
        new Uint8Array([1]),
        { messageId: FIXED_MSG_ID },
      ).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      ).finally(() => {
        firstSettled = true;
      });

      // Longer than ACKCollector's historical ~3s retry window: the send still
      // owns its failure until peerStore refresh completes, so no retry can run
      // against the same stale routing state.
      await vi.advanceTimersByTimeAsync(3_001);
      expect(firstSettled).toBe(false);
      expect(router.send.calls).toHaveLength(1);
      expect(outboxStore.size()).toBe(0);

      await vi.advanceTimersByTimeAsync(1_999);
      const first = await firstOutcome;
      expect(first.value).toBeUndefined();
      expect(first.error).toBeInstanceOf(Error);
      expect((first.error as Error).message).toBe('no valid addresses for peer');
      expect(resolvePeer.calls).toHaveLength(1);

      const retried = await messenger.sendRequestOwned(
        PEER_A,
        PROTO,
        new Uint8Array([1]),
        { messageId: '00000000-0000-4000-8000-000000000002' },
      );
      expect(retried.delivered).toBe(true);
      expect(router.send.calls).toHaveLength(2);
      expect(outboxStore.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the transport failure when awaited peer recovery also fails', async () => {
    const transportError = new Error('no valid addresses for peer');
    const recoveryError = new Error('DHT walk timed out');
    const router = makeRouter(async () => {
      throw transportError;
    });
    const resolvePeer = recorder(
      async (_peerId: string, _opts: { signal: AbortSignal }): Promise<void> => {
        throw recoveryError;
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { messenger, outboxStore } = makeSubstrate({ router, resolvePeer });

      await expect(messenger.sendRequestOwned(
        PEER_A,
        PROTO,
        new Uint8Array([1]),
        { messageId: FIXED_MSG_ID },
      )).rejects.toBe(transportError);

      expect(resolvePeer.calls).toHaveLength(1);
      expect(outboxStore.size()).toBe(0);
      expect((messenger as any).firstAttemptAt.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('DHT walk timed out'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Messenger.sendReliable (sender-side idempotency)', () => {
  it('returns the cached response on a second send with the same messageId, no router call', async () => {
    const router = makeRouter(async () => new Uint8Array([0x42]));
    const { messenger } = makeSubstrate({ router });
    await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    expect(router.send.calls).toHaveLength(1);
    const second = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([2]), {
      messageId: FIXED_MSG_ID,
    });
    expect(router.send.calls).toHaveLength(1);
    expect(second.delivered).toBe(true);
    expect(second.delivered && Array.from(second.response)).toEqual([0x42]);
  });
});

describe('Messenger.sendReliable (failure / outbox)', () => {
  it('queues on recoverable failure and reports queued=true with attempts=1', async () => {
    const router = makeRouter(async () => {
      throw new Error('no valid addresses for peer');
    });
    const { messenger, outboxStore } = makeSubstrate({ router });

    const result = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });

    expect(result).toMatchObject({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: FIXED_MSG_ID,
    });
    expect(outboxStore.size()).toBe(1);
    expect(outboxStore.hasEntry(PEER_A, PROTO, FIXED_MSG_ID)).toBe(true);
  });

  it('reports inFlight instead of queued when a duplicate send races the active attempt', async () => {
    let release!: (value: Uint8Array) => void;
    const router = makeRouter(
      () => new Promise<Uint8Array>((resolve) => {
        release = resolve;
      }),
    );
    const { messenger, outboxStore } = makeSubstrate({ router });

    const first = messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    expect(router.send.calls).toHaveLength(1);

    const second = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    expect(second).toMatchObject({
      delivered: false,
      queued: false,
      inFlight: true,
      attempts: 0,
      messageId: FIXED_MSG_ID,
    });
    expect(outboxStore.size()).toBe(0);

    release(new Uint8Array([0x55]));
    await expect(first).resolves.toMatchObject({ delivered: true, messageId: FIXED_MSG_ID });
  });

  it('rethrows non-recoverable errors without enqueueing', async () => {
    const router = makeRouter(async () => {
      throw new Error('something unexpected exploded');
    });
    const { messenger, outboxStore } = makeSubstrate({ router });

    await expect(
      messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      }),
    ).rejects.toThrow(/something unexpected/);
    expect(outboxStore.size()).toBe(0);
    expect((messenger as any).firstAttemptAt.size).toBe(0);
  });

  it('releases the inflight slot even when the send rejects', async () => {
    const router = makeRouter(async () => {
      throw new Error('no valid addresses for peer');
    });
    const { messenger, outboxStore: _outboxStore } = makeSubstrate({ router });
    void _outboxStore;
    await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    // A second sendReliable on the same key should be free to attempt
    // (will queue again because router still throws).
    const second = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    expect(second.queued).toBe(true);
    expect(second.attempts).toBe(2);
  });
});

describe('Messenger.register (receiver-side idempotency)', () => {
  it('forwards a reliable-envelope wire cap to the protocol router', () => {
    const { messenger, router } = makeSubstrate();

    messenger.register(PROTO, async () => new Uint8Array([0xaa]), {
      maxWireBytes: 80 * 1024,
    });

    expect(router.register.calls.at(-1)).toEqual([
      PROTO,
      expect.any(Function),
      { maxReadBytes: 80 * 1024 },
    ]);
  });

  it('decodes the envelope and invokes the handler with the inner payload', async () => {
    const { messenger, router } = makeSubstrate();
    const handler = recorder(async (req: Uint8Array, _peer: string) => {
      return new Uint8Array([...req, 0xff]);
    });
    messenger.register(PROTO, handler);
    expect(router.register.calls.at(-1)).toEqual([PROTO, expect.any(Function)]);

    const envelope = encodeReliableEnvelope({
      messageId: FIXED_MSG_ID,
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: 1,
      payload: new Uint8Array([1, 2, 3]),
    });
    const peerIdObj = { toString: () => PEER_A, toBytes: () => new Uint8Array() };
    const response = await router.inboundHandler!(envelope, peerIdObj);

    expect(handler.calls).toHaveLength(1);
    // protobufjs decodes `bytes` fields into Node Buffer (a Uint8Array
    // subclass). Compare bytes-as-array rather than typed-array identity.
    expect(Array.from(handler.calls[0][0])).toEqual([1, 2, 3]);
    expect(Array.from(response)).toEqual([1, 2, 3, 0xff]);
  });

  it('returns the cached response on a duplicate receive without invoking the handler', async () => {
    const { messenger, router } = makeSubstrate();
    const handler = recorder(async () => new Uint8Array([0xaa]));
    messenger.register(PROTO, handler);

    const envelope = encodeReliableEnvelope({
      messageId: FIXED_MSG_ID,
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: 1,
      payload: new Uint8Array([1]),
    });
    const peerIdObj = { toString: () => PEER_A, toBytes: () => new Uint8Array() };
    const first = await router.inboundHandler!(envelope, peerIdObj);
    const second = await router.inboundHandler!(envelope, peerIdObj);

    expect(handler.calls).toHaveLength(1);
    expect(Array.from(first)).toEqual([0xaa]);
    expect(Array.from(second)).toEqual([0xaa]);
  });

  it('coalesces concurrent duplicate receives while the first handler is still running', async () => {
    const { messenger, router } = makeSubstrate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = recorder(async () => {
      await gate;
      return new Uint8Array([0xab]);
    });
    messenger.register(PROTO, handler);

    const envelope = encodeReliableEnvelope({
      messageId: FIXED_MSG_ID,
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: 1,
      payload: new Uint8Array([1]),
    });
    const peerIdObj = { toString: () => PEER_A, toBytes: () => new Uint8Array() };
    const first = router.inboundHandler!(envelope, peerIdObj);
    const second = router.inboundHandler!(envelope, peerIdObj);

    expect(handler.calls).toHaveLength(1);
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(Array.from(firstResponse)).toEqual([0xab]);
    expect(Array.from(secondResponse)).toEqual([0xab]);
    expect(handler.calls).toHaveLength(1);
  });

  it('returns RESPONSE_GONE bytes on a duplicate receive when the original response was too big to cache', async () => {
    const { messenger, router, idempotencyStore } = makeSubstrate();
    // Pre-record the idempotency entry as mark-only (response: undefined).
    idempotencyStore.record(PEER_A, PROTO, FIXED_MSG_ID, 'in');
    messenger.register(PROTO, async () => new Uint8Array([0xaa]));

    const envelope = encodeReliableEnvelope({
      messageId: FIXED_MSG_ID,
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: 1,
      payload: new Uint8Array([1]),
    });
    const peerIdObj = { toString: () => PEER_A, toBytes: () => new Uint8Array() };
    const response = await router.inboundHandler!(envelope, peerIdObj);

    expect(new TextDecoder().decode(response)).toBe(RESPONSE_GONE_MARKER);
  });

  it('surfaces decode errors loudly (no silent bare-bytes fallback)', async () => {
    const { messenger, router } = makeSubstrate();
    messenger.register(PROTO, async () => new Uint8Array([0xaa]));
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);
    const peerIdObj = { toString: () => PEER_A, toBytes: () => new Uint8Array() };
    await expect(router.inboundHandler!(garbage, peerIdObj)).rejects.toThrow(
      /failed to decode ReliableEnvelope/,
    );
  });
});

describe('Messenger.processOutboxTick (retry loop semantics)', () => {
  it('retries due entries via router.send and marks delivered on success', async () => {
    let shouldFail = true;
    const router = makeRouter(async () => {
      if (shouldFail) throw new Error('no valid addresses for peer');
      return new Uint8Array([0x42]);
    });
    const { messenger, outboxStore, clock } = makeSubstrate({ router });

    // First attempt fails + enqueues.
    await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    expect(outboxStore.size()).toBe(1);

    // Backoff is 10ms (configured in makeSubstrate); advance the
    // injected clock and let router.send succeed this time.
    shouldFail = false;
    const due = outboxStore.due(clock() + 100);
    expect(due).toHaveLength(1);

    await messenger.processOutboxTick(clock() + 100);
    expect(outboxStore.size()).toBe(0);
  });

  it('keeps a delivered retry queued until its response handler succeeds', async () => {
    const payload = new Uint8Array([0x11, 0x22]);
    const response = new Uint8Array([0x42]);
    let wireAvailable = false;
    let reconcileAvailable = false;
    const router = makeRouter(async () => {
      if (!wireAvailable) throw new Error('no valid addresses for peer');
      return response;
    });
    const { messenger, outboxStore, idempotencyStore, clock } = makeSubstrate({ router });
    const handled: Array<{ request: number[]; response: number[] }> = [];
    messenger.setOutboxResponseHandler(PROTO, async (result) => {
      handled.push({
        request: Array.from(result.requestPayload),
        response: Array.from(result.response),
      });
      if (!reconcileAvailable) throw new Error('state store unavailable');
    });

    await messenger.sendReliable(PEER_A, PROTO, payload, {
      messageId: FIXED_MSG_ID,
    });
    expect(outboxStore.size()).toBe(1);

    wireAvailable = true;
    await messenger.processOutboxTick(clock() + 100);
    expect(outboxStore.size()).toBe(1);
    expect(idempotencyStore.check(PEER_A, PROTO, FIXED_MSG_ID, 'out').seen).toBe(false);

    reconcileAvailable = true;
    await messenger.processOutboxTick(clock() + 200);
    expect(outboxStore.size()).toBe(0);
    expect(idempotencyStore.check(PEER_A, PROTO, FIXED_MSG_ID, 'out').seen).toBe(true);
    expect(handled).toEqual([
      { request: [0x11, 0x22], response: [0x42] },
      { request: [0x11, 0x22], response: [0x42] },
    ]);
  });

  it('honours the stale-snapshot guard (rc.9 #538) — markDelivered in between aborts the retry', async () => {
    // Surfaced via: first attempt fails + queues; we manually
    // markDelivered before the next tick to simulate a sibling
    // flush; tick must NOT re-send.
    const router = makeRouter(async () => {
      throw new Error('no valid addresses for peer');
    });
    const { messenger, outboxStore, clock } = makeSubstrate({ router });

    await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    expect(outboxStore.size()).toBe(1);
    const sendCallsBefore = router.send.calls.length;

    // Sibling flush completes delivery — we model that as
    // markDelivered without going through the wire.
    outboxStore.markDelivered(PEER_A, PROTO, FIXED_MSG_ID);

    await messenger.processOutboxTick(clock() + 100);
    expect(router.send.calls.length).toBe(sendCallsBefore);
  });

  it('coalesces overlapping ticks and bounds batch size and retry concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const router = makeRouter(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return new Uint8Array([0x42]);
    });
    const idempotencyStore = new InMemoryMessageIdempotencyStore();
    const outboxStore = new InMemoryProtocolOutboxStore({ backoffs: [10] });
    for (let i = 0; i < 5; i += 1) {
      outboxStore.enqueue(PEER_A, PROTO, `message-${i}`, new Uint8Array([i]), 'offline', 0);
    }
    const messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore,
      outboxStore,
      backoffs: [10],
      outboxDrain: { batchSize: 3, concurrency: 2 },
    });

    const first = messenger.processOutboxTick(100);
    const overlapping = messenger.processOutboxTick(100);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.send.calls).toHaveLength(2);
    expect(maxActive).toBe(2);
    releases.splice(0).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases.splice(0).forEach((release) => release());
    await Promise.all([first, overlapping]);

    expect(router.send.calls).toHaveLength(3);
    expect(outboxStore.size()).toBe(2);
  });

  it('caps a production-default tick at the default batch size', async () => {
    const router = makeRouter(async () => new Uint8Array([0x42]));
    const outboxStore = new InMemoryProtocolOutboxStore({ backoffs: [10] });
    const queued = DEFAULT_OUTBOX_DRAIN_BATCH_SIZE + 25;
    for (let i = 0; i < queued; i += 1) {
      outboxStore.enqueue(PEER_A, PROTO, `default-batch-${i}`, new Uint8Array([i]), 'offline', 0);
    }
    const messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore: new InMemoryMessageIdempotencyStore(),
      outboxStore,
      backoffs: [10],
    });

    await messenger.processOutboxTick(100);

    expect(router.send.calls).toHaveLength(DEFAULT_OUTBOX_DRAIN_BATCH_SIZE);
    expect(outboxStore.size()).toBe(25);
  });

  it('moves terminal failures behind later due rows instead of starving the next page', async () => {
    const router = makeRouter(async (_peer, _protocol, payload) => {
      if (payload[0] < 2) throw new Error('Invalid payload');
      return new Uint8Array([0x42]);
    });
    const outboxStore = new InMemoryProtocolOutboxStore({ backoffs: [10] });
    for (let i = 0; i < 3; i += 1) {
      outboxStore.enqueue(PEER_A, PROTO, `terminal-${i}`, new Uint8Array([i]), 'offline', 0);
    }
    const messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore: new InMemoryMessageIdempotencyStore(),
      outboxStore,
      backoffs: [10],
      clock: () => 100,
      outboxDrain: { batchSize: 2, concurrency: 1 },
    });

    await messenger.processOutboxTick(100);
    await messenger.processOutboxTick(100);
    expect(router.send.calls).toHaveLength(3);
    expect(outboxStore.size()).toBe(2);
  });

  it('waitForOutboxDrain stays pending until the active retry completes', async () => {
    let release!: () => void;
    const router = makeRouter(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Uint8Array([0x42]);
    });
    const outboxStore = new InMemoryProtocolOutboxStore({ backoffs: [10] });
    outboxStore.enqueue(PEER_A, PROTO, FIXED_MSG_ID, new Uint8Array([1]), 'offline', 0);
    const messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore: new InMemoryMessageIdempotencyStore(),
      outboxStore,
      backoffs: [10],
    });

    const tick = messenger.processOutboxTick(100);
    let waitResolved = false;
    const waiting = messenger.waitForOutboxDrain().then(() => { waitResolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.send.calls).toHaveLength(1);
    expect(waitResolved).toBe(false);

    release();
    await Promise.all([tick, waiting]);
    expect(waitResolved).toBe(true);
    expect(outboxStore.size()).toBe(0);
  });
});

describe('Messenger construction guardrails', () => {
  it('throws MessengerNotConfiguredError when sendReliable is called without stores wired', async () => {
    const router = makeRouter();
    const messenger = new Messenger({ router: router as unknown as ProtocolRouter });
    await expect(
      messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1])),
    ).rejects.toThrow(MessengerNotConfiguredError);
  });

  it('throws MessengerNotConfiguredError when register is called without stores wired', () => {
    const router = makeRouter();
    const messenger = new Messenger({ router: router as unknown as ProtocolRouter });
    expect(() => messenger.register(PROTO, async () => new Uint8Array([0]))).toThrow(
      MessengerNotConfiguredError,
    );
  });

  it('keeps legacy sendToPeer working in a bare-router fixture (backwards compat for /dkg/10.0.0/* callers)', async () => {
    const router = makeRouter(async () => new Uint8Array([0x77]));
    const messenger = new Messenger({ router: router as unknown as ProtocolRouter });
    const out = await messenger.sendToPeer(PEER_A, '/dkg/10.0.0/message', new Uint8Array([1]));
    expect(Array.from(out)).toEqual([0x77]);
  });
});

// rc.9 PR-12 — SLO histogram coverage.
describe('Messenger.getSloStats (SLO histogram)', () => {
  it('records latency from sendReliable invoke → delivered:true', async () => {
    const { messenger, clock } = makeSubstrate();
    // Start at T=1_700_000_000_000 (from makeSubstrate's clock default).
    clock.set(() => 1_700_000_000_000);
    const sendPromise = messenger.sendReliable(PEER_B, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    // Tick the clock forward before the await resolves — the SLO
    // sample should be the *delivery* timestamp minus the *first
    // invocation* timestamp (here: 250ms).
    clock.set(() => 1_700_000_000_250);
    const result = await sendPromise;
    expect(result.delivered).toBe(true);

    const stats = messenger.getSloStats();
    expect(stats[PROTO]).toBeDefined();
    expect(stats[PROTO].samples).toBe(1);
    expect(stats[PROTO].p50Ms).toBe(250);
    expect(stats[PROTO].p95Ms).toBe(250);
    expect(stats[PROTO].p99Ms).toBe(250);
    expect(stats[PROTO].delivered).toBe(1);
    expect(stats[PROTO].queued).toBe(0);
  });

  it('latency clock spans queue + retries (queued first, then retry succeeds)', async () => {
    let shouldFail = true;
    const router = makeRouter(async () => {
      if (shouldFail) throw new Error('no valid addresses for peer');
      return new Uint8Array([0x42]);
    });
    const { messenger, clock } = makeSubstrate({ router });
    // First attempt at T=0 fails → queued.
    clock.set(() => 1_700_000_000_000);
    const first = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    expect(first.delivered).toBe(false);
    // queued bumps counter immediately; no latency sample yet.
    let stats = messenger.getSloStats();
    expect(stats[PROTO].queued).toBe(1);
    expect(stats[PROTO].samples).toBe(0);

    // Backoff ladder is 10ms; advance to T+10, retry succeeds.
    shouldFail = false;
    clock.set(() => 1_700_000_000_010);
    await messenger.processOutboxTick(1_700_000_000_010);

    stats = messenger.getSloStats();
    // SLO clock = full queue+retry window = 10ms from initial
    // sendReliable invocation to first successful delivery.
    expect(stats[PROTO].samples).toBe(1);
    expect(stats[PROTO].p99Ms).toBe(10);
    expect(stats[PROTO].delivered).toBe(1);
    expect(stats[PROTO].queued).toBe(1);
  });

  it('p95 / p99 are nearest-rank over the recorded window', async () => {
    const { messenger, clock } = makeSubstrate();
    const latencies = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500];
    let base = 1_700_000_000_000;
    for (let i = 0; i < latencies.length; i++) {
      const sendStart = base + i * 1_000_000; // well-separated windows
      const sendEnd = sendStart + latencies[i];
      let next = sendStart;
      clock.set(() => next);
      const p = messenger.sendReliable(PEER_B, PROTO, new Uint8Array([i]), {
        messageId: `m-${i}-${'0'.repeat(34)}`,
      });
      next = sendEnd;
      await p;
    }
    const stats = messenger.getSloStats();
    expect(stats[PROTO].samples).toBe(latencies.length);
    // Nearest-rank percentile over sorted = [1,2,3,5,10,20,50,100,200,500]:
    // p50 = index ceil(0.5*10)-1 = 4 → 10
    // p95 = index ceil(0.95*10)-1 = 9 → 500
    // p99 = index ceil(0.99*10)-1 = 9 → 500
    expect(stats[PROTO].p50Ms).toBe(10);
    expect(stats[PROTO].p95Ms).toBe(500);
    expect(stats[PROTO].p99Ms).toBe(500);
    expect(stats[PROTO].delivered).toBe(latencies.length);
    expect(stats[PROTO].queued).toBe(0);
  });

  it('returns empty {} when no substrate traffic has flowed yet', () => {
    const { messenger } = makeSubstrate();
    expect(messenger.getSloStats()).toEqual({});
  });

  /**
   * PR-C codex R7: per-protocol classifier hook lets the protocol
   * owner exclude application-level rejection responses from the
   * protocol-level `delivered` counter + latency histogram. SWM
   * uses this for its 1-byte rejection sentinel so
   * `protocols['/dkg/10.0.1/swm-update'].delivered` stays accurate
   * to apply-level truth.
   *
   * These tests exercise the hook directly against a stock
   * Messenger (no SWM-specific code involved) so the primitive
   * stays reusable for future protocols.
   */
  describe('setResponseDeliveredClassifier (PR-C codex R7)', () => {
    const REJECTION_SENTINEL = new Uint8Array([0x01]);

    it('default behaviour (no classifier registered): every response counts as delivered', async () => {
      const router = makeRouter(async () => REJECTION_SENTINEL);
      const { messenger } = makeSubstrate({ router });
      await messenger.sendReliable(PEER_B, PROTO, new Uint8Array([1]), {
        messageId: 'm-default-' + '0'.repeat(26),
      });

      const stats = messenger.getSloStats();
      expect(stats[PROTO].delivered).toBe(1);
      expect(stats[PROTO].samples).toBe(1);
    });

    it('classifier returning false for a response skips delivered bump AND latency sample', async () => {
      const router = makeRouter(async () => REJECTION_SENTINEL);
      const { messenger, clock } = makeSubstrate({ router });
      messenger.setResponseDeliveredClassifier(
        PROTO,
        (resp) => !(resp.byteLength === 1 && resp[0] === 0x01),
      );

      clock.set(() => 1_700_000_000_000);
      const p = messenger.sendReliable(PEER_B, PROTO, new Uint8Array([1]), {
        messageId: 'm-rej-' + '0'.repeat(30),
      });
      clock.set(() => 1_700_000_000_500);
      const result = await p;

      // Caller still sees a successful response with the sentinel
      // bytes — only the metric is adjusted.
      expect(result.delivered).toBe(true);
      expect(Array.from(result.response ?? [])).toEqual([0x01]);

      const stats = messenger.getSloStats();
      // No SLO entry at all because nothing successfully delivered
      // — getSloStats only emits keys for protocols with traffic.
      expect(stats[PROTO]).toBeUndefined();
    });

    it('classifier returning true keeps the delivered bump (apply-OK response)', async () => {
      const router = makeRouter(async () => new Uint8Array());
      const { messenger } = makeSubstrate({ router });
      messenger.setResponseDeliveredClassifier(
        PROTO,
        (resp) => !(resp.byteLength === 1 && resp[0] === 0x01),
      );

      await messenger.sendReliable(PEER_B, PROTO, new Uint8Array([1]), {
        messageId: 'm-ok-' + '0'.repeat(31),
      });

      const stats = messenger.getSloStats();
      expect(stats[PROTO].delivered).toBe(1);
    });

    it('mix of applied + rejected responses bumps delivered only for applied', async () => {
      let respondWith = new Uint8Array();
      const router = makeRouter(async () => respondWith);
      const { messenger } = makeSubstrate({ router });
      messenger.setResponseDeliveredClassifier(
        PROTO,
        (resp) => !(resp.byteLength === 1 && resp[0] === 0x01),
      );

      // First: apply OK → counts as delivered.
      respondWith = new Uint8Array();
      await messenger.sendReliable(PEER_B, PROTO, new Uint8Array([1]), {
        messageId: 'm-r7-ok-' + '0'.repeat(28),
      });
      // Second: rejected → does NOT count as delivered.
      respondWith = REJECTION_SENTINEL;
      await messenger.sendReliable(PEER_B, PROTO, new Uint8Array([2]), {
        messageId: 'm-r7-rej-' + '0'.repeat(27),
      });
      // Third: apply OK → counts as delivered.
      respondWith = new Uint8Array();
      await messenger.sendReliable(PEER_B, PROTO, new Uint8Array([3]), {
        messageId: 'm-r7-ok2-' + '0'.repeat(27),
      });

      const stats = messenger.getSloStats();
      expect(stats[PROTO].delivered).toBe(2);
      expect(stats[PROTO].samples).toBe(2);
    });

    it('classifier crash fails open (counts as delivered) so a classifier bug does not hide real traffic', async () => {
      const router = makeRouter(async () => REJECTION_SENTINEL);
      const { messenger } = makeSubstrate({ router });
      messenger.setResponseDeliveredClassifier(PROTO, () => {
        throw new Error('classifier bug');
      });

      await messenger.sendReliable(PEER_B, PROTO, new Uint8Array([1]), {
        messageId: 'm-r7-bug-' + '0'.repeat(27),
      });

      const stats = messenger.getSloStats();
      expect(stats[PROTO].delivered).toBe(1);
    });
  });

  it('per-protocol stats are isolated', async () => {
    const { messenger, clock } = makeSubstrate();
    const PROTO_B = '/dkg/10.0.1/private-access';
    clock.set(() => 1_000_000);
    let next = 1_000_000;
    clock.set(() => next);
    const p1 = messenger.sendReliable(PEER_B, PROTO, new Uint8Array([1]), {
      messageId: 'msg-A-' + '0'.repeat(30),
    });
    next = 1_000_050;
    await p1;

    next = 2_000_000;
    const p2 = messenger.sendReliable(PEER_B, PROTO_B, new Uint8Array([2]), {
      messageId: 'msg-B-' + '0'.repeat(30),
    });
    next = 2_000_500;
    await p2;

    const stats = messenger.getSloStats();
    expect(Object.keys(stats).sort()).toEqual([PROTO_B, PROTO].sort());
    expect(stats[PROTO].p99Ms).toBe(50);
    expect(stats[PROTO_B].p99Ms).toBe(500);
  });
});

// rc.9 PR-5 — DHT walk on stalled outbox entry. When an entry hits
// OUTBOX_STALL_THRESHOLD attempts on an address-resolution error,
// the Messenger fires the optional `resolvePeer` hook in the
// background. Per-peer rate-limited so a stuck peer doesn't burn DHT
// bandwidth.
describe('Messenger DHT-walk-on-stall recovery (rc.9 PR-5)', () => {
  function makeStallSubstrate(opts: {
    resolvePeer?: ReturnType<typeof recorder<[string, { signal: AbortSignal }], Promise<void>>>;
    backoffs?: readonly number[];
    initialClock?: number;
    errorMessage?: string;
  } = {}) {
    const router = makeRouter(async () => {
      throw new Error(opts.errorMessage ?? 'no valid addresses for peer');
    });
    const idempotencyStore = new InMemoryMessageIdempotencyStore();
    const outboxStore = new InMemoryProtocolOutboxStore({
      backoffs: opts.backoffs ?? [10],
      maxAgeMs: 60_000,
    });
    let nowMs = opts.initialClock ?? 1_700_000_000_000;
    const advance = (ms: number) => {
      nowMs += ms;
    };
    const resolvePeer =
      opts.resolvePeer ??
      recorder(async (_peerId: string, _opts: { signal: AbortSignal }): Promise<void> => undefined);
    const messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore,
      outboxStore,
      backoffs: opts.backoffs ?? [10],
      maxAgeMs: 60_000,
      clock: () => nowMs,
      resolvePeer,
    });
    return { messenger, router, outboxStore, resolvePeer, advance, now: () => nowMs };
  }

  it('does NOT fire resolvePeer below the stall threshold', async () => {
    const { messenger, resolvePeer, advance } = makeStallSubstrate();

    for (let i = 0; i < 4; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
      advance(1000);
    }

    expect(resolvePeer.calls).toEqual([]);
  });

  it('fires resolvePeer once when the stall threshold is hit', async () => {
    const { messenger, resolvePeer, advance } = makeStallSubstrate();

    for (let i = 0; i < 5; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
      advance(1000);
    }

    expect(resolvePeer.calls).toHaveLength(1);
    expect(resolvePeer.calls.at(-1)).toEqual([PEER_A, { signal: expect.any(AbortSignal) }]);
  });

  it('treats NO_RESERVATION as recoverable and triggers the DHT walk', async () => {
    const { messenger, resolvePeer, advance } = makeStallSubstrate({
      errorMessage: 'NO_RESERVATION',
    });

    for (let i = 0; i < 5; i++) {
      const result = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
      expect(result.queued).toBe(true);
      advance(1000);
    }

    expect(resolvePeer.calls).toHaveLength(1);
  });

  // Regression for the May 2026 multi-node soak. libp2p surfaces
  // "All multiaddr dials failed" when every candidate address for
  // a peer fails in a single dial — peerStore briefly stale, all
  // cached relay addrs dead, etc. PR #567's classifier change made
  // this recoverable so the outbox queues it, but Codex review
  // caught that without ALSO adding the string to
  // `DHT_WALK_TRIGGER_ERRORS`, the outbox would just back off and
  // retry the SAME dead addresses forever. This test asserts the
  // string is wired through to the DHT-walk path the same way as
  // `no valid addresses` / `NO_RESERVATION`.
  it('treats "All multiaddr dials failed" as recoverable and triggers the DHT walk', async () => {
    const { messenger, resolvePeer, advance } = makeStallSubstrate({
      errorMessage: 'All multiaddr dials failed',
    });

    for (let i = 0; i < 5; i++) {
      const result = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
      expect(result.queued).toBe(true);
      advance(1000);
    }

    expect(resolvePeer.calls).toHaveLength(1);
    expect(resolvePeer.calls.at(-1)).toEqual([PEER_A, { signal: expect.any(AbortSignal) }]);
  });

  it('rate-limits resolvePeer per peer (no second walk within DHT_WALK_RATE_LIMIT_MS)', async () => {
    const { messenger, resolvePeer, advance } = makeStallSubstrate();

    for (let i = 0; i < 5; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
      advance(1000);
    }
    expect(resolvePeer.calls).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
      advance(1000);
    }
    expect(resolvePeer.calls).toHaveLength(1);

    advance(5 * 60 * 1000 + 1);
    await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    expect(resolvePeer.calls).toHaveLength(2);
  });

  it('does NOT fire resolvePeer for non-address-resolution errors (stream resets etc.)', async () => {
    const router = makeRouter(async () => {
      throw new Error('ECONNRESET: stream closed');
    });
    const idempotencyStore = new InMemoryMessageIdempotencyStore();
    const outboxStore = new InMemoryProtocolOutboxStore({ backoffs: [10], maxAgeMs: 60_000 });
    const resolvePeer = recorder(
      async (_peerId: string, _opts: { signal: AbortSignal }): Promise<void> => undefined,
    );
    const messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore,
      outboxStore,
      backoffs: [10],
      maxAgeMs: 60_000,
      resolvePeer,
    });

    for (let i = 0; i < 8; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
    }

    expect(resolvePeer.calls).toEqual([]);
  });

  it('is a no-op when resolvePeer is not wired (backwards compat)', async () => {
    const router = makeRouter(async () => {
      throw new Error('no valid addresses for peer');
    });
    const idempotencyStore = new InMemoryMessageIdempotencyStore();
    const outboxStore = new InMemoryProtocolOutboxStore({ backoffs: [10], maxAgeMs: 60_000 });
    const messenger = new Messenger({
      router: router as unknown as ProtocolRouter,
      idempotencyStore,
      outboxStore,
      backoffs: [10],
      maxAgeMs: 60_000,
    });

    for (let i = 0; i < 7; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
    }
    expect(outboxStore.size()).toBe(1);
  });

  it('rate-limits per-peer, not globally (different peers can each walk independently)', async () => {
    const { messenger, resolvePeer, advance } = makeStallSubstrate();

    for (let i = 0; i < 5; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), { messageId: 'a' });
      advance(100);
    }
    for (let i = 0; i < 5; i++) {
      await messenger.sendReliable(PEER_B, PROTO, new Uint8Array([1]), { messageId: 'b' });
      advance(100);
    }

    expect(resolvePeer.calls).toHaveLength(2);
    const peers = resolvePeer.calls.map((c) => c[0]).sort();
    expect(peers).toEqual([PEER_A, PEER_B].sort());
  });

  it('clears the DHT-walk rate limit when a peer outbox expires empty', async () => {
    const { messenger, resolvePeer, advance, now } = makeStallSubstrate();

    for (let i = 0; i < 5; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
      advance(1000);
    }
    expect(resolvePeer.calls).toHaveLength(1);

    const dropped = messenger.dropExpiredOutbox(now() + 60_001);
    expect(dropped).toHaveLength(1);
    expect(messenger.outboxSize()).toBe(0);

    for (let i = 0; i < 5; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: '00000000-0000-4000-8000-000000000002',
      });
      advance(1000);
    }
    expect(resolvePeer.calls).toHaveLength(2);
  });

  it('swallows resolvePeer rejections (failure must not bubble to caller)', async () => {
    const resolvePeer = recorder(
      async (_peerId: string, _opts: { signal: AbortSignal }): Promise<void> => {
        throw new Error('DHT walk timed out');
      },
    );
    const { messenger } = makeStallSubstrate({ resolvePeer });

    for (let i = 0; i < 5; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
    }
    expect(resolvePeer.calls).toHaveLength(1);
  });

  it('also fires from the retry tick path (not only from sendReliable)', async () => {
    const { messenger, resolvePeer, advance, outboxStore } = makeStallSubstrate();

    for (let i = 0; i < 4; i++) {
      await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
        messageId: FIXED_MSG_ID,
      });
      advance(1000);
    }
    expect(resolvePeer.calls).toEqual([]);
    expect(outboxStore.size()).toBe(1);

    advance(100);
    await messenger.processOutboxTick(20_000_000_000_000);

    expect(resolvePeer.calls).toHaveLength(1);
  });
});
