import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  decodeReliableEnvelope,
  encodeReliableEnvelope,
  RELIABLE_ENVELOPE_VERSION,
  RESPONSE_GONE_MARKER,
  type ProtocolRouter,
  type StreamHandler,
} from '@origintrail-official/dkg-core';
import { Messenger, MessengerNotConfiguredError } from '../src/p2p/messenger.js';

const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PROTO = '/dkg/10.0.1/message';
const FIXED_MSG_ID = '00000000-0000-4000-8000-000000000001';

interface RouterDouble {
  send: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  /** Inbound stream handler captured from `register` for tests that invoke it. */
  inboundHandler?: StreamHandler;
}

function makeRouter(sendImpl?: () => Promise<Uint8Array>): RouterDouble {
  const router: RouterDouble = {
    send: vi.fn(sendImpl ?? (async () => new Uint8Array([0x10]))),
    register: vi.fn((_protocol: string, handler: StreamHandler) => {
      router.inboundHandler = handler;
    }),
  };
  return router;
}

function makeSubstrate(overrides: { router?: RouterDouble } = {}) {
  const router = overrides.router ?? makeRouter();
  const idempotencyStore = new InMemoryMessageIdempotencyStore();
  const outboxStore = new InMemoryProtocolOutboxStore({
    backoffs: [10],
    maxAgeMs: 60_000,
  });
  const clock = vi.fn(() => 1_700_000_000_000);
  const messenger = new Messenger({
    router: router as unknown as ProtocolRouter,
    idempotencyStore,
    outboxStore,
    backoffs: [10],
    maxAgeMs: 60_000,
    clock,
  });
  return { messenger, router, idempotencyStore, outboxStore, clock };
}

describe('Messenger.sendReliable (happy path semantics)', () => {
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
    expect(router.send).toHaveBeenCalledTimes(1);
    const [, , wireBytes] = router.send.mock.calls[0];
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

  it('generates a UUID when no messageId is supplied', async () => {
    const { messenger } = makeSubstrate();
    const result = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]));
    expect(result.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('Messenger.sendReliable (sender-side idempotency)', () => {
  it('returns the cached response on a second send with the same messageId, no router call', async () => {
    const router = makeRouter(async () => new Uint8Array([0x42]));
    const { messenger } = makeSubstrate({ router });
    await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
    });
    expect(router.send).toHaveBeenCalledTimes(1);
    const second = await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([2]), {
      messageId: FIXED_MSG_ID,
    });
    expect(router.send).toHaveBeenCalledTimes(1);
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

  it('persists timeoutMs with queued entries for background retries', async () => {
    const router = makeRouter(async () => {
      throw new Error('no valid addresses for peer');
    });
    const { messenger, outboxStore } = makeSubstrate({ router });

    await messenger.sendReliable(PEER_A, PROTO, new Uint8Array([1]), {
      messageId: FIXED_MSG_ID,
      timeoutMs: 1234,
    });

    const [entry] = outboxStore.pendingFor(PEER_A);
    expect(entry.timeoutMs).toBe(1234);
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
    expect(router.send).toHaveBeenCalledTimes(1);

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
  it('decodes the envelope and invokes the handler with the inner payload', async () => {
    const { messenger, router } = makeSubstrate();
    const handler = vi.fn(async (req: Uint8Array, _peer: string) => {
      return new Uint8Array([...req, 0xff]);
    });
    messenger.register(PROTO, handler);
    expect(router.register).toHaveBeenCalledWith(PROTO, expect.any(Function));

    const envelope = encodeReliableEnvelope({
      messageId: FIXED_MSG_ID,
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: 1,
      payload: new Uint8Array([1, 2, 3]),
    });
    const peerIdObj = { toString: () => PEER_A, toBytes: () => new Uint8Array() };
    const response = await router.inboundHandler!(envelope, peerIdObj);

    expect(handler).toHaveBeenCalledTimes(1);
    // protobufjs decodes `bytes` fields into Node Buffer (a Uint8Array
    // subclass). Compare bytes-as-array rather than typed-array identity.
    expect(Array.from(handler.mock.calls[0][0])).toEqual([1, 2, 3]);
    expect(Array.from(response)).toEqual([1, 2, 3, 0xff]);
  });

  it('returns the cached response on a duplicate receive without invoking the handler', async () => {
    const { messenger, router } = makeSubstrate();
    const handler = vi.fn(async () => new Uint8Array([0xaa]));
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

    expect(handler).toHaveBeenCalledTimes(1);
    expect(Array.from(first)).toEqual([0xaa]);
    expect(Array.from(second)).toEqual([0xaa]);
  });

  it('coalesces concurrent duplicate receives while the first handler is still running', async () => {
    const { messenger, router } = makeSubstrate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
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

    expect(handler).toHaveBeenCalledTimes(1);
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(Array.from(firstResponse)).toEqual([0xab]);
    expect(Array.from(secondResponse)).toEqual([0xab]);
    expect(handler).toHaveBeenCalledTimes(1);
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
      timeoutMs: 4321,
    });
    expect(outboxStore.size()).toBe(1);

    // Backoff is 10ms (configured in makeSubstrate); advance the
    // injected clock and let router.send succeed this time.
    shouldFail = false;
    const due = outboxStore.due(clock() + 100);
    expect(due).toHaveLength(1);

    await messenger.processOutboxTick(clock() + 100);
    expect(router.send.mock.calls[1][3]).toBe(4321);
    expect(outboxStore.size()).toBe(0);
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
    const sendCallsBefore = router.send.mock.calls.length;

    // Sibling flush completes delivery — we model that as
    // markDelivered without going through the wire.
    outboxStore.markDelivered(PEER_A, PROTO, FIXED_MSG_ID);

    await messenger.processOutboxTick(clock() + 100);
    expect(router.send.mock.calls.length).toBe(sendCallsBefore);
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
