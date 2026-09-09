import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
    expect(first).toMatchObject({ entries: [{ messageId: 'Z' }], payloadBytes: 5, skippedOversizedEntries: 1, byteBudgetExhausted: true });
    sqlite.recordRetryFailure('peer', '/test', 'Z', 'again', 10);
    const second = sqlite.readDuePage(10, budget);
    expect(second.entries.map(entry => entry.messageId)).toEqual(['a', 'Ä', '😀']);
    expect(second.payloadBytes).toBe(6);
    expect(sqlite.readDuePage(10, { maxEntries: 1, maxPayloadBytes: 6 }).entries).toHaveLength(1);
    expect(sqlite.queueStats(15, 6)).toEqual({ queuedEntries: 5, queuedBytes: 31, oldestDueAgeMs: 5, oversizedDueEntries: 1 });
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

  it('bounds an actual drain over 512 x 256 KiB rows and a 16 MiB head entry', () => {
    const result = spawnSync(process.execPath, ['--expose-gc', '--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./fixtures/outbox-memory.fixture.ts', import.meta.url))], { encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const line = result.stdout.split('\n').find(text => text.startsWith('OUTBOX_MEMORY_RESULT '));
    expect(line).toBeDefined();
    const sample = JSON.parse(line!.slice('OUTBOX_MEMORY_RESULT '.length));
    expect(sample.rows).toBe(512);
    expect(sample.rowBytes).toBe(256 * 1024);
    expect(sample.peakClaimedBytes).toBe(4 * 1024 * 1024);
    expect(sample.skippedOversizedEntriesTotal).toBe(32);
  }, 100_000);
});
