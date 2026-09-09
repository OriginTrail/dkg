import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryProtocolOutboxStore } from '@origintrail-official/dkg-core';
import { DashboardDB, SqliteProtocolOutboxStore } from '../src/db.js';

let dir: string;
let db: DashboardDB;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dkg-outbox-budget-')); db = new DashboardDB({ dataDir: dir }); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('production SQLite byte-bounded outbox', () => {
  it('matches binary retry ordering and bounded prefix selection in the reference store', () => {
    const sqlite = new SqliteProtocolOutboxStore(db, { backoffFor: () => 10 });
    const memory = new InMemoryProtocolOutboxStore({ backoffs: [10] });
    for (const store of [sqlite, memory]) {
      for (const [id, bytes] of [['a', 4], ['Z', 5], ['_large', 20], ['Ä', 1], ['😀', 1]] as const) {
        store.enqueue('peer', '/test', id, new Uint8Array(bytes).fill(7), 'offline', 0);
      }
    }
    const budget = { maxEntries: 100, maxPayloadBytes: 6 };
    const first = sqlite.readDuePage(10, budget);
    expect(first).toEqual(memory.readDuePage(10, budget));
    expect(first).toMatchObject({ entries: [{ messageId: 'Z' }], skippedOversizedEntries: 1, byteBudgetExhausted: true });
    sqlite.recordRetryFailure('peer', '/test', 'Z', 'again', 10);
    const second = sqlite.readDuePage(10, budget);
    expect(second.entries.map(entry => entry.messageId)).toEqual(['a', 'Ä', '😀']);
    expect(second.entries.reduce((bytes, entry) => bytes + entry.payload.byteLength, 0)).toBe(6);
    expect(sqlite.readDuePage(10, { maxEntries: 1, maxPayloadBytes: 6 }).entries).toHaveLength(1);
    expect(sqlite.queueStats(15, 6)).toEqual({ queuedEntries: 5, queuedBytes: 31, oldestDueAgeMs: 5, oversizedDueEntries: 1 });
  });

  it('loads admitted payloads with a constant query count as the page grows', () => {
    const store = new SqliteProtocolOutboxStore(db, { backoffFor: () => 10 });
    for (let i = 0; i < 100; i++) store.enqueue('peer', '/test', String(i).padStart(3, '0'), new Uint8Array(4), 'offline', 0);
    const prepare = vi.spyOn(db.db, 'prepare');
    try {
      const counts: number[] = [];
      for (const maxEntries of [1, 10, 100]) {
        prepare.mockClear();
        const page = store.readDuePage(10, { maxEntries, maxPayloadBytes: 400 });
        expect(page.entries).toHaveLength(maxEntries);
        counts.push(prepare.mock.calls.length);
      }
      expect(new Set(counts).size).toBe(1);
      expect(counts[0]).toBeLessThanOrEqual(3);
    } finally { prepare.mockRestore(); }
  });

  it('loads the exact admitted keys when candidate eligibility and tie ordering change', () => {
    const store = new SqliteProtocolOutboxStore(db, { backoffFor: () => 10 });
    for (const [protocol, id] of [['/other', 'first'], ['/selected', 'a'], ['/selected', 'z']]) {
      store.enqueue('peer', protocol, id, new Uint8Array(3), 'offline', 0);
    }
    const prepare = db.db.prepare.bind(db.db);
    // Exercise a future candidate-policy change through real SQL. Payload
    // loading must follow these identities without duplicating that policy.
    const spy = vi.spyOn(db.db, 'prepare').mockImplementation(sql => prepare(
      sql.includes('AS payloadBytes') && sql.includes('LIMIT ?')
        ? sql.replace('WHERE next_attempt_at', "WHERE protocol = '/selected' AND next_attempt_at")
          .replace('ORDER BY next_attempt_at, first_failure_at, peer_id, protocol, message_id', 'ORDER BY message_id DESC')
        : sql,
    ));
    try {
      const page = store.readDuePage(10, { maxEntries: 2, maxPayloadBytes: 6 });
      expect(page.entries.map(entry => [entry.protocol, entry.messageId])).toEqual([
        ['/selected', 'z'], ['/selected', 'a'],
      ]);
      expect(page.entries.reduce((sum, entry) => sum + entry.payload.byteLength, 0)).toBe(6);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally { spy.mockRestore(); }
  });

  it('keeps snapshot bytes isolated and updates retries using only metadata', () => {
    const store = new SqliteProtocolOutboxStore(db, { backoffFor: attempts => attempts * 10, maxAgeMs: 100 });
    store.enqueue('peer', '/test', 'id', new Uint8Array([1, 2, 3]), 'offline', 0);
    const page = store.readDuePage(10, { maxEntries: 1, maxPayloadBytes: 3 });
    page.entries[0].payload[0] = 99;
    expect(store.getEntry('peer', '/test', 'id')?.payload).toEqual(new Uint8Array([1, 2, 3]));
    const metadata = store.recordRetryFailure('peer', '/test', 'id', 'retry failed', 10);
    expect(metadata).toEqual({ peer: 'peer', protocol: '/test', messageId: 'id', payloadBytes: 3, attempts: 2, firstFailureAt: 0, lastAttemptAt: 10, nextAttemptAt: 30, lastError: 'retry failed' });
    expect(store.listMetadata('peer')).toEqual([metadata]);
    expect(store.listMetadata('missing')).toEqual([]);
    expect(store.dropExpiredMetadata(100)).toEqual([]);
    expect(store.dropExpiredMetadata(101)).toEqual([metadata]);
    expect(store.recordRetryFailure('peer', '/test', 'id', 'late failure', 102)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('leaves selected rows durable through close/reopen without changing retry timestamps', () => {
    const store = new SqliteProtocolOutboxStore(db, { backoffFor: () => 10 });
    store.enqueue('peer', '/test', 'id', new Uint8Array([1, 2, 3]), 'offline', 0);
    const budget = { maxEntries: 1, maxPayloadBytes: 3 };
    const page = store.readDuePage(10, budget);
    db.close(); db = new DashboardDB({ dataDir: dir });
    expect(new SqliteProtocolOutboxStore(db).readDuePage(10, budget)).toEqual(page);
  });

  it('keeps metadata and payload expiry projections on the same strict retention rule', () => {
    for (const store of [new SqliteProtocolOutboxStore(db, { maxAgeMs: 100 }), new InMemoryProtocolOutboxStore({ maxAgeMs: 100 })]) {
      for (const at of [-1, 0, 1]) store.enqueue('peer', '/test', String(at), new Uint8Array([7]), 'offline', at);
      const metadata = store.dropExpiredMetadata(100);
      expect(metadata.map(entry => entry.messageId)).toEqual(['-1']);
      store.enqueue('peer', '/test', '-1', new Uint8Array([7]), 'offline', -1);
      const payloads = store.dropExpired(100);
      expect(payloads.map(({ payload, ...entry }) => ({ ...entry, payloadBytes: payload.byteLength }))).toEqual(metadata);
      expect(store.listMetadata().map(entry => entry.messageId).sort()).toEqual(['0', '1']);
    }
  });


});
