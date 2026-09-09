import { describe, expect, it } from 'vitest';
import { InMemoryProtocolOutboxStore, BoundedProtocolOutbox, assertBoundedProtocolOutboxStore } from '../src/protocol-outbox.js';
import type { BoundedProtocolOutboxStore } from '../src/messenger-types.js';

function automaticStore(): BoundedProtocolOutboxStore {
  const store = new InMemoryProtocolOutboxStore({ backoffs: [10] });
  return {
    enqueue: store.enqueue.bind(store), markDelivered: store.markDelivered.bind(store),
    hasEntry: store.hasEntry.bind(store), size: store.size.bind(store), hasPendingFor: store.hasPendingFor.bind(store),
    readDuePage: store.readDuePage.bind(store), listMetadata: store.listMetadata.bind(store),
    dropExpiredMetadata: store.dropExpiredMetadata.bind(store), recordRetryFailure: store.recordRetryFailure.bind(store),
    queueStats: store.queueStats.bind(store),
  };
}

it('uses a bounded-only store without any legacy payload inspection methods', () => {
  const store = automaticStore();
  const outbox = new BoundedProtocolOutbox(store);
  outbox.enqueueFailure('peer', '/test', 'id', new Uint8Array([7]), 'offline', 0);
  expect(outbox.readDuePage(10, { maxEntries: 1, maxPayloadBytes: 1 }).entries[0].messageId).toBe('id');
  expect(outbox.hasPendingFor('peer')).toBe(true);
  expect(outbox.payloadInspection()).toBeUndefined();
  outbox.markDelivered('peer', '/test', 'id');
  expect(outbox.size()).toBe(0);
});

it('validates every required capability at the core construction boundary', () => {
  const store = automaticStore();
  for (const method of Object.keys(store)) {
    const incomplete = { ...store };
    Reflect.deleteProperty(incomplete, method);
    expect(() => assertBoundedProtocolOutboxStore(incomplete)).toThrow(method);
    expect(() => new BoundedProtocolOutbox(incomplete)).toThrow(method);
  }
  expect(() => assertBoundedProtocolOutboxStore(null)).toThrow('readDuePage');
});

function fixture() {
  const store = new InMemoryProtocolOutboxStore({ backoffs: [10, 20], maxAgeMs: 100 });
  const outbox = new BoundedProtocolOutbox(store, { backoffs: [10, 20], maxAgeMs: 100 });
  const add = (id: string, bytes: number) => outbox.enqueueFailure('peer', '/test', id, new Uint8Array(bytes).fill(7), 'offline', 0);
  return { store, outbox, add };
}

describe('byte-bounded outbox access', () => {
  it('skips an oversized head and admits later messages within both budgets', () => {
    const { outbox, add } = fixture();
    add('a-large', 9); add('b-small', 3); add('c-small', 5); add('d-next', 1);
    const page = outbox.readDuePage(10, { maxEntries: 2, maxPayloadBytes: 8 });
    expect(page.entries.map(e => e.messageId)).toEqual(['b-small', 'c-small']);
    expect(page).toMatchObject({ skippedOversizedEntries: 1 });
    for (const entry of page.entries) outbox.markDelivered(entry.peer, entry.protocol, entry.messageId);
    expect(outbox.readDuePage(10, { maxEntries: 2, maxPayloadBytes: 8 }).entries.map(e => e.messageId)).toEqual(['d-next']);
    expect(outbox.queueStats(15, 8)).toEqual({ queuedEntries: 2, queuedBytes: 10, oldestDueAgeMs: 5, oversizedDueEntries: 1 });
    expect(outbox.readDuePage(10, { maxEntries: 1, maxPayloadBytes: 9 }).entries[0].messageId).toBe('a-large');
  });

  it('retains due-prefix ordering across byte deferral and retry backoff', () => {
    const { outbox, add } = fixture();
    add('a', 5); add('b', 4); add('c', 1);
    expect(outbox.readDuePage(10, { maxEntries: 100, maxPayloadBytes: 6 })).toMatchObject({ entries: [{ messageId: 'a' }], byteBudgetExhausted: true });
    expect(outbox.recordRetryFailure('peer', '/test', 'a', 'again', 10)).toEqual({ peer: 'peer', protocol: '/test', messageId: 'a', payloadBytes: 5, attempts: 2, firstFailureAt: 0, lastAttemptAt: 10, nextAttemptAt: 30, lastError: 'again' });
    expect(outbox.readDuePage(10, { maxEntries: 100, maxPayloadBytes: 6 }).entries.map(e => e.messageId)).toEqual(['b', 'c']);
  });

  it('keeps payload ownership isolated and never resurrects a removed retry', () => {
    const { outbox, add } = fixture(); add('a', 3);
    const page = outbox.readDuePage(10, { maxEntries: 1, maxPayloadBytes: 3 });
    page.entries[0].payload[0] = 99;
    expect(outbox.payloadInspection()!.getEntry('peer', '/test', 'a')?.payload)
      .toEqual(new Uint8Array([7, 7, 7]));
    outbox.markDelivered('peer', '/test', 'a');
    expect(outbox.recordRetryFailure('peer', '/test', 'a', 'late failure', 20)).toBeUndefined();
    expect(outbox.size()).toBe(0);
  });

  it('lists and expires only metadata while preserving the strict age boundary', () => {
    const { outbox, add } = fixture(); add('a', 3);
    const metadata = outbox.listMetadata('peer');
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).not.toHaveProperty('payload');
    expect(metadata[0].payloadBytes).toBe(3);
    expect(outbox.listMetadata('missing')).toEqual([]);
    expect(outbox.dropExpiredMetadata(100)).toEqual([]);
    expect(outbox.dropExpiredMetadata(101)).toEqual(metadata);
    expect(outbox.queueStats(101, 3)).toEqual({ queuedEntries: 0, queuedBytes: 0, oldestDueAgeMs: 0, oversizedDueEntries: 0 });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid page budgets: %s', invalid => {
    const { outbox } = fixture();
    expect(() => outbox.readDuePage(10, { maxEntries: invalid, maxPayloadBytes: 1 })).toThrow(/positive safe integer/);
    expect(() => outbox.readDuePage(10, { maxEntries: 1, maxPayloadBytes: invalid })).toThrow(/positive safe integer/);
  });
});
