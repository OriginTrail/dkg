import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESPONSE_CACHE_BYTES } from '@origintrail-official/dkg-core';
import {
  DashboardDB,
  SqliteMessageIdempotencyStore,
  SqliteProtocolOutboxStore,
} from '../src/db.js';

const PEER_A = '12D3KooWMilesPlaceholder';
const PEER_B = '12D3KooWLexPlaceholder';
const PROTO = '/dkg/10.0.1/message';
const MSG_1 = '00000000-0000-4000-8000-000000000001';
const MSG_2 = '00000000-0000-4000-8000-000000000002';
const PAYLOAD = new TextEncoder().encode('payload-bytes');

let db: DashboardDB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-messenger-stores-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('V12 migration', () => {
  it('creates message_idempotency and protocol_outbox tables', () => {
    const tables = (db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('message_idempotency');
    expect(tables).toContain('protocol_outbox');
  });

  it('records user_version = 13 after migration', () => {
    // V12 introduced the substrate stores; V13 (rc.9 PR-3) drops
    // the V11 `idx_chat_msgid` partial unique index now that
    // receiver-side dedup is owned by the substrate's
    // `message_idempotency` table. Both bumps are tested at the
    // DB layer in `db.test.ts`; this assertion just pins that
    // the substrate store fixtures are created against the
    // current SCHEMA_VERSION.
    expect(db.db.pragma('user_version', { simple: true })).toBe(13);
  });
});

describe('SqliteMessageIdempotencyStore', () => {
  it('check returns { seen: false } for unrecorded triples', () => {
    const store = new SqliteMessageIdempotencyStore(db);
    expect(store.check(PEER_A, PROTO, MSG_1, 'in')).toEqual({ seen: false });
  });

  it('record + check round-trips a small response inline', () => {
    const store = new SqliteMessageIdempotencyStore(db);
    const resp = new TextEncoder().encode('ack');
    store.record(PEER_A, PROTO, MSG_1, 'in', resp);
    const result = store.check(PEER_A, PROTO, MSG_1, 'in');
    expect(result.seen).toBe(true);
    expect(result.seen && Array.from(result.cachedResponse ?? [])).toEqual(Array.from(resp));
  });

  it('snapshots cached responses on write and read', () => {
    const store = new SqliteMessageIdempotencyStore(db);
    const resp = new Uint8Array([1, 2, 3]);
    store.record(PEER_A, PROTO, MSG_1, 'in', resp);

    resp[0] = 9;
    const first = store.check(PEER_A, PROTO, MSG_1, 'in');
    expect(first.seen && Array.from(first.cachedResponse ?? [])).toEqual([1, 2, 3]);

    if (first.seen && first.cachedResponse) {
      first.cachedResponse[1] = 8;
    }
    const second = store.check(PEER_A, PROTO, MSG_1, 'in');
    expect(second.seen && Array.from(second.cachedResponse ?? [])).toEqual([1, 2, 3]);
  });

  it('stores mark-only (NULL blob) for responses larger than RESPONSE_CACHE_BYTES', () => {
    const store = new SqliteMessageIdempotencyStore(db);
    const oversize = new Uint8Array(RESPONSE_CACHE_BYTES + 1);
    store.record(PEER_A, PROTO, MSG_1, 'in', oversize);
    const row = db.db
      .prepare(
        `SELECT response_blob, response_size FROM message_idempotency
         WHERE peer_id = ? AND protocol = ? AND message_id = ? AND direction = ?`,
      )
      .get(PEER_A, PROTO, MSG_1, 'in') as { response_blob: Buffer | null; response_size: number };
    expect(row.response_blob).toBeNull();
    expect(row.response_size).toBe(RESPONSE_CACHE_BYTES + 1);
    expect(store.check(PEER_A, PROTO, MSG_1, 'in')).toEqual({ seen: true });
  });

  it('treats different directions as independent (Codex #534 lesson)', () => {
    const store = new SqliteMessageIdempotencyStore(db);
    store.record(PEER_A, PROTO, MSG_1, 'in');
    expect(store.check(PEER_A, PROTO, MSG_1, 'in')).toEqual({ seen: true });
    expect(store.check(PEER_A, PROTO, MSG_1, 'out')).toEqual({ seen: false });
  });

  it('treats different protocols as independent', () => {
    const store = new SqliteMessageIdempotencyStore(db);
    store.record(PEER_A, '/dkg/10.0.1/message', MSG_1, 'in');
    expect(store.check(PEER_A, '/dkg/10.0.1/message', MSG_1, 'in')).toEqual({ seen: true });
    expect(store.check(PEER_A, '/dkg/10.0.1/skill_request', MSG_1, 'in')).toEqual({ seen: false });
  });

  it('re-record on existing key is a no-op (ON CONFLICT DO NOTHING)', () => {
    const store = new SqliteMessageIdempotencyStore(db);
    store.record(PEER_A, PROTO, MSG_1, 'in', new TextEncoder().encode('first'));
    // Second record with a different blob — first wins.
    store.record(PEER_A, PROTO, MSG_1, 'in', new TextEncoder().encode('second'));
    const result = store.check(PEER_A, PROTO, MSG_1, 'in');
    expect(result.seen).toBe(true);
    expect(
      result.seen && new TextDecoder().decode(result.cachedResponse ?? new Uint8Array()),
    ).toBe('first');
  });

  it('pruneOlderThan removes records older than the cutoff', () => {
    let now = 1_000_000;
    const store = new SqliteMessageIdempotencyStore(db, { clock: () => now });
    store.record(PEER_A, PROTO, MSG_1, 'in');
    now = 2_000_000;
    store.record(PEER_A, PROTO, MSG_2, 'in');
    const dropped = store.pruneOlderThan(1_500_000);
    expect(dropped).toBe(1);
    expect(store.check(PEER_A, PROTO, MSG_1, 'in')).toEqual({ seen: false });
    expect(store.check(PEER_A, PROTO, MSG_2, 'in')).toEqual({ seen: true });
  });

  it('survives a re-open with data preserved (durability sanity)', () => {
    const store = new SqliteMessageIdempotencyStore(db);
    const resp = new TextEncoder().encode('persisted');
    store.record(PEER_A, PROTO, MSG_1, 'in', resp);

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteMessageIdempotencyStore(db);
    const result = reopened.check(PEER_A, PROTO, MSG_1, 'in');
    expect(result.seen).toBe(true);
    expect(result.seen && new TextDecoder().decode(result.cachedResponse ?? new Uint8Array())).toBe(
      'persisted',
    );
  });
});

describe('SqliteProtocolOutboxStore', () => {
  it('enqueue creates a new entry with attempts=1', () => {
    const store = new SqliteProtocolOutboxStore(db, { backoffFor: () => 5_000 });
    const entry = store.enqueue(PEER_A, PROTO, MSG_1, PAYLOAD, 'reset', 1_000_000);
    expect(entry.attempts).toBe(1);
    expect(entry.firstFailureAt).toBe(1_000_000);
    expect(entry.nextAttemptAt).toBe(1_005_000);
    expect(entry.lastError).toBe('reset');
    expect(Array.from(entry.payload)).toEqual(Array.from(PAYLOAD));
  });

  it('configurePolicy updates the SQLite store backoff and max age', () => {
    const store = new SqliteProtocolOutboxStore(db);
    store.configurePolicy({ backoffFor: () => 123, maxAgeMs: 60_000 });

    const entry = store.enqueue(PEER_A, PROTO, MSG_1, PAYLOAD, 'reset', 0);
    expect(entry.nextAttemptAt).toBe(123);
    expect(store.dropExpired(60_000)).toHaveLength(0);
    expect(store.dropExpired(60_001)).toHaveLength(1);
  });

  it('snapshots payload bytes on write and read', () => {
    const store = new SqliteProtocolOutboxStore(db, { backoffFor: () => 5_000 });
    const payload = new Uint8Array([1, 2, 3]);
    const entry = store.enqueue(PEER_A, PROTO, MSG_1, payload, 'reset', 1000);

    payload[0] = 9;
    entry.payload[1] = 8;

    const pending = store.pendingFor(PEER_A);
    expect(Array.from(pending[0].payload)).toEqual([1, 2, 3]);

    pending[0].payload[2] = 7;
    expect(Array.from(store.due(6000)[0].payload)).toEqual([1, 2, 3]);
  });

  it('enqueue bumps attempts and reschedules on repeat failure for the same key', () => {
    const store = new SqliteProtocolOutboxStore(db, { backoffFor: (n) => n * 1000 });
    store.enqueue(PEER_A, PROTO, MSG_1, PAYLOAD, 'first', 1_000_000);
    const second = store.enqueue(PEER_A, PROTO, MSG_1, PAYLOAD, 'second', 1_005_000);
    expect(second.attempts).toBe(2);
    expect(second.firstFailureAt).toBe(1_000_000);
    expect(second.lastAttemptAt).toBe(1_005_000);
    expect(second.nextAttemptAt).toBe(1_005_000 + 2000);
    expect(second.lastError).toBe('second');
  });

  it('markDelivered removes the entry and returns true', () => {
    const store = new SqliteProtocolOutboxStore(db);
    store.enqueue(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 1000);
    expect(store.hasEntry(PEER_A, PROTO, MSG_1)).toBe(true);
    expect(store.markDelivered(PEER_A, PROTO, MSG_1)).toBe(true);
    expect(store.hasEntry(PEER_A, PROTO, MSG_1)).toBe(false);
    expect(store.markDelivered(PEER_A, PROTO, MSG_1)).toBe(false);
  });

  it('pendingFor returns entries sorted by firstFailureAt ascending', () => {
    const store = new SqliteProtocolOutboxStore(db);
    store.enqueue(PEER_A, PROTO, MSG_2, PAYLOAD, 'e', 2000);
    store.enqueue(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 1000);
    store.enqueue(PEER_B, PROTO, MSG_1, PAYLOAD, 'e', 500);
    expect(store.pendingFor(PEER_A).map((e) => e.messageId)).toEqual([MSG_1, MSG_2]);
    expect(store.pendingFor(PEER_B)).toHaveLength(1);
  });

  it('due returns entries with nextAttemptAt <= now', () => {
    const store = new SqliteProtocolOutboxStore(db, { backoffFor: () => 5_000 });
    store.enqueue(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 1_000_000);
    expect(store.due(1_004_999)).toHaveLength(0);
    expect(store.due(1_005_000)).toHaveLength(1);
  });

  it('dropExpired removes entries older than maxAgeMs and returns them', () => {
    const store = new SqliteProtocolOutboxStore(db, {
      maxAgeMs: 60_000,
    });
    store.enqueue(PEER_A, PROTO, MSG_1, PAYLOAD, 'old', 0);
    store.enqueue(PEER_A, PROTO, MSG_2, PAYLOAD, 'new', 100_000);
    const dropped = store.dropExpired(100_001);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].messageId).toBe(MSG_1);
    expect(store.size()).toBe(1);
  });

  it('size reflects the row count', () => {
    const store = new SqliteProtocolOutboxStore(db);
    expect(store.size()).toBe(0);
    store.enqueue(PEER_A, PROTO, MSG_1, PAYLOAD, 'e', 1000);
    expect(store.size()).toBe(1);
    store.enqueue(PEER_B, PROTO, MSG_1, PAYLOAD, 'e', 1000);
    expect(store.size()).toBe(2);
  });

  it('survives re-open with entries preserved (durability sanity)', () => {
    const store = new SqliteProtocolOutboxStore(db);
    const oldEnoughForDefaultPolicy = Date.now() - 25 * 60 * 60 * 1000;
    store.enqueue(
      PEER_A,
      PROTO,
      MSG_1,
      PAYLOAD,
      'crash-before-delivery',
      oldEnoughForDefaultPolicy,
    );

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteProtocolOutboxStore(db);
    const pending = reopened.pendingFor(PEER_A);
    expect(pending).toHaveLength(1);
    expect(pending[0].lastError).toBe('crash-before-delivery');
    expect(Array.from(pending[0].payload)).toEqual(Array.from(PAYLOAD));
  });
});
