import { expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import { Messenger } from '../src/p2p/messenger.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { InMemoryMessageIdempotencyStore, InMemoryProtocolOutboxStore, encodeReliableEnvelope,
  RELIABLE_ENVELOPE_VERSION, PROTOCOL_MESSAGE, type LegacyProtocolOutboxStore, type ProtocolRouter } from '@origintrail-official/dkg-core';

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
  expect(messenger.listOutbox().map(entry => entry.messageId)).toEqual(['a']);
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
  expect(messenger.listOutbox()).toEqual([{ peer, protocol, messageId: 'entry', payloadBytes: entry.payload.byteLength,
    attempts: 2, firstFailureAt: 0, lastAttemptAt: 15, nextAttemptAt: 35, lastError: 'permanent rejection' }]);
  expect(messenger.getOutboxStats()).toMatchObject({ queuedEntries: 1, queuedBytes: entry.payload.byteLength, oldestDueAgeMs: 0 });
  expect(messenger.dropExpiredOutbox(101)).toHaveLength(1);
  expect(messenger.getOutboxStats()).toMatchObject({ queuedEntries: 0, queuedBytes: 0 });
});

it('loads independently owned payloads only through explicit diagnostic opt-in', () => {
  const { messenger, add } = fixture(); const entry = add('entry');
  expect(messenger.listOutbox()[0]).not.toHaveProperty('payload');
  const payload = messenger.listOutbox({ includePayload: true })[0]!.payload;
  expect(payload).toEqual(entry.payload);
  payload.fill(0);
  expect(messenger.listOutbox({ includePayload: true })[0]!.payload).toEqual(entry.payload);
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
  expect(() => new Messenger({ router: {} as ProtocolRouter, idempotencyStore: new InMemoryMessageIdempotencyStore(), outboxStore: store }))
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
    expect(agent.listMessageOutbox()[0]).not.toHaveProperty('payload');
  } finally { await agent.stop(); }
});
