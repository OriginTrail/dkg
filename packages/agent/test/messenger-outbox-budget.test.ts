import { expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import { Messenger, DEFAULT_OUTBOX_DRAIN_MAX_PAYLOAD_BYTES } from '../src/p2p/messenger.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { InMemoryMessageIdempotencyStore, InMemoryProtocolOutboxStore, encodeReliableEnvelope,
  RELIABLE_ENVELOPE_VERSION, PROTOCOL_MESSAGE, PROTOCOL_SWM_UPDATE, DKG_GOSSIP_MAX_MESSAGE_BYTES, DEFAULT_MAX_READ_BYTES, type BoundedProtocolOutboxStore, type LegacyProtocolOutboxStore, type ProtocolRouter } from '@origintrail-official/dkg-core';

const peer = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const protocol = PROTOCOL_MESSAGE;
function envelope(id: string, bytes = 1) {
  return encodeReliableEnvelope({ messageId: id, version: RELIABLE_ENVELOPE_VERSION, tsMs: 0, payload: new Uint8Array(bytes) });
}
function fixture(maxPayloadBytes = 1024, send: () => Promise<Uint8Array> = async () => new Uint8Array()) {
  const outboxStore = new InMemoryProtocolOutboxStore({ backoffs: [10, 20], maxAgeMs: 100 });
  const idempotencyStore = new InMemoryMessageIdempotencyStore();
  const messenger = new Messenger({ router: { send } as unknown as ProtocolRouter, outboxStore, idempotencyStore,
    clock: () => 15, backoffs: [10, 20], maxAgeMs: 100,
    outboxDrain: { maxPayloadBytes, batchSize: 100, concurrency: 1 } });
  const add = (id: string, bytes = 1) => outboxStore.enqueue(peer, protocol, id, envelope(id, bytes), 'offline', 0);
  return { messenger, outboxStore, idempotencyStore, add };
}

it('holds a byte-bounded page through delivery and skips an oversized head without starving later messages', async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { started = resolve; });
  const limit = envelope('b').byteLength * 2;
  const { messenger, outboxStore, idempotencyStore, add } = fixture(limit, async () => { started(); await blocked; return new Uint8Array([42]); });
  const large = add('a', limit * 2); const b = add('b'); const c = add('c'); const d = add('d');
  const drain = messenger.processOutboxTick(15);
  try {
    await sending;
    expect(messenger.getOutboxStats()).toMatchObject({ queuedEntries: 4,
      queuedBytes: large.payload.byteLength + b.payload.byteLength + c.payload.byteLength + d.payload.byteLength,
      claimedEntries: 2, claimedBytes: limit, oversizedDueEntries: 1, oldestDueAgeMs: 5,
      skippedOversizedEntriesTotal: 1, byteBudgetDeferralsTotal: 1 });
  } finally { release(); }
  await drain;
  expect(messenger.getOutboxStats()).toMatchObject({ claimedBytes: 0, queuedEntries: 2, oversizedDueEntries: 1 });
  expect(idempotencyStore.check(peer, protocol, 'b', 'out')).toEqual({ seen: true, cachedResponse: new Uint8Array([42]) });
  await messenger.processOutboxTick(15);
  expect(messenger.listOutboxMetadata().map(entry => entry.messageId)).toEqual(['a']);
  expect(outboxStore.size()).toBe(1);
});

it('keeps retry updates, summary diagnostics and expiry on metadata-only store methods', async () => {
  const { messenger, outboxStore, add } = fixture(1024, async () => { throw new Error('permanent rejection'); });
  const entry = add('entry');
  const forbidden = () => { throw new Error('payload snapshot must not be loaded'); };
  vi.spyOn(outboxStore, 'list').mockImplementation(forbidden);
  vi.spyOn(outboxStore, 'dropExpired').mockImplementation(forbidden);
  vi.spyOn(outboxStore, 'getEntry').mockImplementation(forbidden);
  await messenger.processOutboxTick(15);
  expect(messenger.listOutboxMetadata()).toEqual([{ peer, protocol, messageId: 'entry', payloadBytes: entry.payload.byteLength,
    attempts: 2, firstFailureAt: 0, lastAttemptAt: 15, nextAttemptAt: 35, lastError: 'permanent rejection' }]);
  expect(messenger.getOutboxStats()).toMatchObject({ queuedEntries: 1, queuedBytes: entry.payload.byteLength, oldestDueAgeMs: 0 });
  expect(messenger.dropExpiredOutbox(101)).toHaveLength(1);
  expect(messenger.getOutboxStats()).toMatchObject({ queuedEntries: 0, queuedBytes: 0 });
});

it('preserves legacy payload inspection and offers metadata-only diagnostics', () => {
  const { messenger, add } = fixture(); const entry = add('entry');
  expect(messenger.listOutbox()![0].payload).toEqual(entry.payload);
  expect(messenger.listOutboxMetadata()[0]).not.toHaveProperty('payload');
  const payload = messenger.listOutbox()![0]!.payload;
  expect(payload).toEqual(entry.payload);
  payload.fill(0);
  expect(messenger.listOutbox()![0]!.payload).toEqual(entry.payload);
});

it('does not resurrect a retry removed while its wire attempt was in flight', async () => {
  let reject!: (reason: Error) => void;
  let started!: () => void;
  const pending = new Promise<Uint8Array>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const sending = new Promise<void>(resolve => { started = resolve; });
  const { messenger, outboxStore, add } = fixture(1024, () => { started(); return pending; });
  add('entry');
  const drain = messenger.processOutboxTick(15);
  await sending;
  outboxStore.markDelivered(peer, protocol, 'entry');
  reject(new Error('late wire failure'));
  await drain;
  expect(messenger.outboxSize()).toBe(0);
});

it('rejects a legacy store before any unbounded fallback read', () => {
  const backing = new InMemoryProtocolOutboxStore();
  const forbidden = vi.fn(() => { throw new Error('unbounded payload read'); });
  const store: LegacyProtocolOutboxStore = { enqueue: backing.enqueue.bind(backing), markDelivered: backing.markDelivered.bind(backing),
    hasEntry: backing.hasEntry.bind(backing), pendingFor: forbidden, due: forbidden, dropExpired: forbidden,
    size: backing.size.bind(backing), list: forbidden, getEntry: backing.getEntry.bind(backing) };
  expect(() => new Messenger({ router: {} as ProtocolRouter, idempotencyStore: new InMemoryMessageIdempotencyStore(),
    // @ts-expect-error JavaScript callers are also rejected before using an unbounded store.
    outboxStore: store }))
    .toThrow('readDuePage');
  expect(forbidden).not.toHaveBeenCalled();
});

it('carries SDK outbox limits into the real Messenger and exposes queue gauges', async () => {
  const outboxStore = new InMemoryProtocolOutboxStore();
  const agent = await DKGAgent.create({ name: 'outbox-budget-sdk', listenHost: '127.0.0.1', listenPort: 0,
    chainAdapter: new MockChainAdapter(), rfc64CatalogActivation: { enabled: false },
    messengerOutboxDrain: { batchSize: 3, maxPayloadBytes: 128, concurrency: 1 },
    messengerStores: { outboxStore, idempotencyStore: new InMemoryMessageIdempotencyStore() } });
  try {
    await agent.start();
    outboxStore.enqueue(peer, protocol, 'entry', envelope('entry'), 'offline', 0);
    expect(agent.getMessengerOutboxStats()).toMatchObject({ batchSize: 3, maxPayloadBytes: 128,
      queuedEntries: 1, queuedBytes: envelope('entry').byteLength, claimedBytes: 0 });
    expect(agent.listMessageOutbox()![0].payload).toEqual(new Uint8Array(envelope('entry')));
    vi.spyOn(outboxStore, 'list').mockImplementation(() => { throw new Error('metadata diagnostics loaded payloads'); });
    expect(agent.listMessageOutboxMetadata()[0]).toMatchObject({ messageId: 'entry', payloadBytes: envelope('entry').byteLength });
    expect(agent.listMessageOutboxMetadata()[0]).not.toHaveProperty('payload');
  } finally { await agent.stop(); }
});

it('reports payload inspection as unsupported for a bounded-only configured store', async () => {
  const backing = new InMemoryProtocolOutboxStore({ backoffs: [1_000_000_000] });
  const store: BoundedProtocolOutboxStore = {
    configurePolicy: backing.configurePolicy.bind(backing),
    enqueue: backing.enqueue.bind(backing), markDelivered: backing.markDelivered.bind(backing),
    hasEntry: backing.hasEntry.bind(backing), size: backing.size.bind(backing),
    hasPendingFor: backing.hasPendingFor.bind(backing), readDuePage: backing.readDuePage.bind(backing),
    listMetadata: backing.listMetadata.bind(backing), dropExpiredMetadata: backing.dropExpiredMetadata.bind(backing),
    recordRetryFailure: backing.recordRetryFailure.bind(backing), queueStats: backing.queueStats.bind(backing),
  };
  const agent = await DKGAgent.create({
    name: 'bounded-only-outbox-inspection',
    listenHost: '127.0.0.1',
    listenPort: 0,
    chainAdapter: new MockChainAdapter(),
    rfc64CatalogActivation: { enabled: false },
    messengerStores: {
      outboxStore: store,
      idempotencyStore: new InMemoryMessageIdempotencyStore(),
    },
  });
  try {
    await agent.start();
    store.enqueue(peer, protocol, 'bounded-only', envelope('bounded-only'), 'offline', Date.now());
    expect(agent.listMessageOutbox()).toBeUndefined();
    expect(agent.listMessageOutboxMetadata()).toMatchObject([{ messageId: 'bounded-only' }]);
  } finally {
    await agent.stop();
  }
});

it('retries a maximum-size SWM application payload with default drain settings', async () => {
  let now = 0;
  let online = false;
  const send = vi.fn(async () => {
    if (!online) throw new Error('stream reset');
    return new Uint8Array([42]);
  });
  const store = new InMemoryProtocolOutboxStore();
  const messenger = new Messenger({ router: { send } as unknown as ProtocolRouter,
    idempotencyStore: new InMemoryMessageIdempotencyStore(), outboxStore: store,
    clock: () => now, backoffs: [10] });
  const payload = new Uint8Array(DKG_GOSSIP_MAX_MESSAGE_BYTES);
  expect(await messenger.sendReliable(peer, PROTOCOL_SWM_UPDATE, payload, { messageId: 'max-swm' }))
    .toMatchObject({ queued: true });
  const queued = store.getEntry(peer, PROTOCOL_SWM_UPDATE, 'max-swm')!;
  expect(queued.payload.byteLength).toBeGreaterThan(payload.byteLength);
  online = true; now = 10;
  await messenger.processOutboxTick(now);
  expect(send).toHaveBeenCalledTimes(2);
  expect(store.size()).toBe(0);
});

it('holds only one transport-sized default page when queued payloads exceed that budget', async () => {
  expect(DEFAULT_OUTBOX_DRAIN_MAX_PAYLOAD_BYTES).toBe(10 * 1024 * 1024);
  expect(DEFAULT_OUTBOX_DRAIN_MAX_PAYLOAD_BYTES).toBe(DEFAULT_MAX_READ_BYTES);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const send = vi.fn(async () => { await gate; return new Uint8Array(); });
  const store = new InMemoryProtocolOutboxStore({ backoffs: [10] });
  const messenger = new Messenger({ router: { send } as unknown as ProtocolRouter,
    idempotencyStore: new InMemoryMessageIdempotencyStore(), outboxStore: store,
    clock: () => 10, backoffs: [10] });
  for (let i = 0; i < 6; i++) {
    store.enqueue(peer, PROTOCOL_SWM_UPDATE, `max-${i}`, envelope(`max-${i}`, DKG_GOSSIP_MAX_MESSAGE_BYTES), 'offline', 0);
  }
  const readPage = vi.spyOn(store, 'readDuePage');
  const drain = messenger.processOutboxTick(10);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(readPage).toHaveBeenCalledWith(10, { maxEntries: 100, maxPayloadBytes: DEFAULT_MAX_READ_BYTES });
    expect(messenger.getOutboxStats()).toMatchObject({ maxPayloadBytes: DEFAULT_MAX_READ_BYTES, claimedEntries: 2, queuedEntries: 6 });
    expect(messenger.getOutboxStats()!.claimedBytes).toBeGreaterThan(2 * DKG_GOSSIP_MAX_MESSAGE_BYTES);
    expect(messenger.getOutboxStats()!.claimedBytes).toBeLessThanOrEqual(DEFAULT_MAX_READ_BYTES);
    expect(send).toHaveBeenCalledTimes(2);
  } finally { release(); await drain; }
  expect(store.size()).toBe(4);
  expect(messenger.getOutboxStats()!.claimedBytes).toBe(0);
});

it('returns empty diagnostics when Messenger has no durable substrate', () => {
  const messenger = new Messenger({ router: {} as ProtocolRouter });
  expect(messenger.listOutbox()).toBeUndefined();
  expect(messenger.listOutboxMetadata()).toEqual([]);
  expect(messenger.getOutboxStats()).toBeUndefined();
});

it('drains a custom store that implements only automatic retry capabilities', async () => {
  const backing = new InMemoryProtocolOutboxStore({ backoffs: [10] });
  const store: BoundedProtocolOutboxStore = {
    configurePolicy: backing.configurePolicy.bind(backing),
    enqueue: backing.enqueue.bind(backing), markDelivered: backing.markDelivered.bind(backing),
    hasEntry: backing.hasEntry.bind(backing), size: backing.size.bind(backing), hasPendingFor: backing.hasPendingFor.bind(backing),
    readDuePage: backing.readDuePage.bind(backing), listMetadata: backing.listMetadata.bind(backing),
    dropExpiredMetadata: backing.dropExpiredMetadata.bind(backing), recordRetryFailure: backing.recordRetryFailure.bind(backing),
    queueStats: backing.queueStats.bind(backing),
  };
  const send = vi.fn(async () => new Uint8Array());
  const messenger = new Messenger({ router: { send } as unknown as ProtocolRouter, outboxStore: store,
    idempotencyStore: new InMemoryMessageIdempotencyStore(), clock: () => 10, backoffs: [10] });
  store.enqueue(peer, protocol, 'bounded-only', envelope('bounded-only'), 'offline', 0);
  await messenger.processOutboxTick(10);
  expect(send).toHaveBeenCalledTimes(1);
  expect(messenger.outboxSize()).toBe(0);
  expect(messenger.listOutboxMetadata()).toEqual([]);
  expect(messenger.listOutbox()).toBeUndefined();
});
