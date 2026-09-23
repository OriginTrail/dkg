import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB, SqliteContextGraphStorageDiscoveryStore } from '../src/db.js';

let db: DashboardDB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-cg-storage-discovery-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const CHECKPOINT = {
  version: 1,
  storageAddress: '0x1b37447cc735ab8ac29f057c8874087fe9a98154',
  nextId: '35',
  refreshNextId: null,
  lastRefreshAt: 1_790_000_000_000,
  entries: [{
    contextGraphId: '34',
    owner: '0x64529c023d853371228923b4fda5fb22f929bf51',
    active: true,
    createdAt: 1_790_152_299,
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: '0xbbe5ef8ec201677bbe3e4faabe73556b84a6ea13',
    nameHash: `0x${'69'.repeat(32)}`,
    observedAtBlock: 51_682_578,
  }],
};

describe('SqliteContextGraphStorageDiscoveryStore', () => {
  it('replaces one checkpoint per deployment scope and survives a reopen', async () => {
    const base = new SqliteContextGraphStorageDiscoveryStore(db, { scope: 'evm:8453:hub=0x99aa' });
    const gnosis = new SqliteContextGraphStorageDiscoveryStore(db, { scope: 'evm:100:hub=0x882d' });

    await expect(base.load()).resolves.toBeUndefined();
    await base.save(CHECKPOINT);
    await base.save({ ...CHECKPOINT, nextId: '36' });
    await expect(gnosis.load()).resolves.toBeUndefined();

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteContextGraphStorageDiscoveryStore(db, { scope: 'evm:8453:hub=0x99aa' });
    await expect(reopened.load()).resolves.toEqual({ ...CHECKPOINT, nextId: '36' });
    const rows = db.db.prepare(
      `SELECT key FROM settings WHERE key LIKE ?`,
    ).all(`${SqliteContextGraphStorageDiscoveryStore.KEY_PREFIX}%`) as Array<{ key: string }>;
    expect(rows.map((row) => row.key)).toEqual([
      `${SqliteContextGraphStorageDiscoveryStore.KEY_PREFIX}evm:8453:hub=0x99aa`,
    ]);
  });

  it('hands an unparseable value back for the agent to reject visibly', async () => {
    const store = new SqliteContextGraphStorageDiscoveryStore(db);
    db.db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
      .run(`${SqliteContextGraphStorageDiscoveryStore.KEY_PREFIX}default`, '{not json');
    await expect(store.load()).resolves.toBe('{not json');
  });

  it('refuses a value that JSON cannot represent', async () => {
    const store = new SqliteContextGraphStorageDiscoveryStore(db);
    await expect(store.save(undefined)).rejects.toThrow(/not serializable/);
  });
});
