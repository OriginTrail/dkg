import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteProtocolOutboxStore } from '../src/index.js';
import { DashboardDB } from './helpers/dashboard-db.js';

const PROTO = '/dkg/10.0.1/message';

let db: DashboardDB;
let dir: string;
let store: SqliteProtocolOutboxStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-node-store-outbox-test-'));
  db = new DashboardDB({ dataDir: dir });
  store = new SqliteProtocolOutboxStore(db, { backoffFor: () => 1_000 });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteProtocolOutboxStore inspection reads', () => {
  it('lists every row oldest failure first and reads one entry by its key', () => {
    store.enqueue('peer-b', PROTO, 'm-2', new Uint8Array([2]), 'reset', 2_000);
    store.enqueue('peer-a', PROTO, 'm-1', new Uint8Array([1]), 'timeout', 1_000);

    expect(store.list().map((entry) => entry.messageId)).toEqual(['m-1', 'm-2']);
    const entry = store.getEntry('peer-a', PROTO, 'm-1');
    expect(entry).toMatchObject({ peer: 'peer-a', protocol: PROTO, messageId: 'm-1', lastError: 'timeout' });
    expect(Array.from(entry!.payload)).toEqual([1]);
    expect(store.getEntry('peer-a', PROTO, 'never-queued')).toBeUndefined();
    expect(store.getEntry('peer-z', PROTO, 'm-1')).toBeUndefined();
  });

  it('reports an empty last error as an empty string', () => {
    store.enqueue('peer-a', PROTO, 'm-1', new Uint8Array([1]), '', 1_000);
    db.db.prepare('UPDATE protocol_outbox SET last_error = NULL').run();
    expect(store.getEntry('peer-a', PROTO, 'm-1')?.lastError).toBe('');
  });

  it('refuses a due page limit that is not a non-negative safe integer', () => {
    store.enqueue('peer-a', PROTO, 'm-1', new Uint8Array([1]), 'reset', 1_000);
    for (const limit of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store.duePage(10_000, limit), String(limit)).toThrow(RangeError);
    }
    expect(store.duePage(10_000, 0)).toEqual([]);
    expect(store.duePage(10_000, 5)).toHaveLength(1);
  });
});
