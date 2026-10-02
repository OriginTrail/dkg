import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteChainEventCursorStore,
  SqliteContextGraphAuthorityHistoryStore,
  SqliteContextGraphAuthorityIndexStore,
  SqliteContextGraphRegistryScanCursorStore,
} from '../src/index.js';
import { DashboardDB } from './helpers/dashboard-db.js';

let db: DashboardDB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-node-store-chain-cursor-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('authority index checkpoint inputs', () => {
  it('rejects an empty scope, an unserializable checkpoint and a malformed token', async () => {
    const store = new SqliteContextGraphAuthorityIndexStore(db);
    await expect(store.compareAndSwap('  ', undefined, { version: 1 })).rejects.toThrow('scope is empty');
    await expect(store.compareAndSwap('scope', undefined, undefined)).rejects.toThrow('not serializable');
    await expect(store.compareAndSwap('scope', 0, { version: 1 })).rejects.toThrow('expected token is invalid');
    await expect(store.compareAndSwap('scope', 1.5, { version: 1 })).rejects.toThrow('expected token is invalid');
    await expect(store.compareAndSwap('scope', Number.MAX_SAFE_INTEGER, { version: 1 }))
      .rejects.toThrow('exceeds the safe integer range');
    await expect(store.invalidate('scope', 0)).rejects.toThrow('expected token is invalid');
    await expect(store.invalidate('scope', Number.MAX_SAFE_INTEGER)).rejects.toThrow('exceeds the safe integer range');
    // Nothing was written by any refused call.
    expect(db.db.prepare('SELECT COUNT(*) AS c FROM context_graph_authority_indexes').get()).toEqual({ c: 0 });
  });
});

describe('chain RPC cursor stores', () => {
  it('persists chain-event lane cursors by scope across reopen', async () => {
    const store = new SqliteChainEventCursorStore(db, { scope: 'evm:1:hub=0xabc' });

    await store.saveLane('contextGraphDiscovery', 1234);
    await store.saveLane('vmReconcile', 5678);
    expect(await store.loadLane('contextGraphDiscovery')).toBe(1234);
    expect(await store.loadLane('vmReconcile')).toBe(5678);
    expect(db.db.prepare(
      `SELECT value FROM runtime_cursors
       WHERE namespace = 'chainEventPoller.cursor'
         AND scope = 'evm:1:hub=0xabc'
         AND key = 'contextGraphDiscovery'`,
    ).get()).toEqual({ value: 1234 });
    expect(await new SqliteChainEventCursorStore(db, { scope: 'evm:2:hub=0xabc' }).loadLane('contextGraphDiscovery')).toBeUndefined();

    await store.saveLane('contextGraphDiscovery', 0);
    await store.saveLane('contextGraphDiscovery', -1);
    await store.saveLane('contextGraphDiscovery', 1.5);
    await store.saveLane('contextGraphDiscovery', Number.MAX_SAFE_INTEGER + 1);
    expect(await store.loadLane('contextGraphDiscovery')).toBe(1234);

    db.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run('chainEventPoller.cursor:evm:1:hub=0xabc:badLane', '0');
    expect(await store.loadLane('badLane')).toBeUndefined();
    db.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run('chainEventPoller.cursor:evm:1:hub=0xabc:legacyLane', '2468');
    expect(await store.loadLane('legacyLane')).toBe(2468);

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteChainEventCursorStore(db, { scope: 'evm:1:hub=0xabc' });
    expect(await reopened.loadLane('contextGraphDiscovery')).toBe(1234);
    expect(await reopened.loadLane('vmReconcile')).toBe(5678);
    expect(await reopened.loadLane('legacyLane')).toBe(2468);
  });

  it('persists registry scan cursors by deployment key and ignores corrupt values', async () => {
    const store = new SqliteContextGraphRegistryScanCursorStore(db);
    const key = {
      chainId: 'evm:1',
      deploymentId: 'evm:1:hub=0xabc',
      registryAddress: '0x3333333333333333333333333333333333333333',
    };

    await store.save(key, 5000);
    expect(await store.load(key)).toBe(5000);
    // The scanner owns the monotonic policy. The physical store must support
    // an authoritative lower replacement after a bounded chain rollback.
    await store.save(key, 2101);
    expect(await store.load(key)).toBe(2101);
    await store.save(key, 5000);
    const repair = {
      version: 1,
      nextBlock: 1000,
      targetBlock: 4900,
      startedAt: 1_700_000_000_000,
    };
    await store.repairAudit.save(key, repair);
    expect(await store.repairAudit.load(key)).toEqual(repair);
    expect(db.db.prepare(
      `SELECT value FROM runtime_cursors
       WHERE namespace = 'contextGraphRegistryScan.cursor'
         AND scope = ?
         AND key = ?`,
    ).get(`${key.chainId}:${key.deploymentId}`, key.registryAddress.toLowerCase())).toEqual({ value: 5000 });
    await store.save(key, 0);
    await store.save(key, -1);
    await store.save(key, 1.5);
    await store.save(key, Number.MAX_SAFE_INTEGER + 1);
    expect(await store.load(key)).toBe(5000);
    expect(await store.load({ ...key, registryAddress: '0x4444444444444444444444444444444444444444' })).toBeUndefined();

    db.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run(
      `contextGraphRegistryScan.cursor:${key.chainId}:${key.deploymentId}:0x5555555555555555555555555555555555555555`,
      'not-a-number',
    );
    expect(await store.load({ ...key, registryAddress: '0x5555555555555555555555555555555555555555' })).toBeUndefined();
    db.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run(
      `contextGraphRegistryScan.cursor:${key.chainId}:${key.deploymentId}:0x6666666666666666666666666666666666666666`,
      '6000',
    );
    expect(await store.load({ ...key, registryAddress: '0x6666666666666666666666666666666666666666' })).toBe(6000);

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteContextGraphRegistryScanCursorStore(db);
    expect(await reopened.load(key)).toBe(5000);
    expect(await reopened.repairAudit.load(key)).toEqual(repair);
    expect(await reopened.load({ ...key, registryAddress: '0x6666666666666666666666666666666666666666' })).toBe(6000);
    expect(db.db.prepare(
      `SELECT value FROM settings WHERE key = ?`,
    ).get([
      SqliteContextGraphRegistryScanCursorStore.REPAIR_KEY_PREFIX,
      key.chainId,
      key.deploymentId,
      key.registryAddress.toLowerCase(),
    ].join(':'))).toEqual({ value: JSON.stringify(repair) });
  });

  it('atomically persists versioned Context Graph authority checkpoints', async () => {
    const store = new SqliteContextGraphAuthorityHistoryStore(db);
    const key = 'evm:84532:hub=0xabc:0x3333333333333333333333333333333333333333:9';
    const checkpoint = {
      version: 1,
      state: {
        throughBlockNumber: 5000,
        throughBlockHash: `0x${'55'.repeat(32)}`,
        nameHash: `0x${'88'.repeat(32)}`,
        ownershipEra: 2,
        policyVersion: 4,
        rosterVersion: 7,
        sourceBlockNumber: 4990,
        sourceBlockHash: `0x${'44'.repeat(32)}`,
      },
      integrity: `0x${'99'.repeat(32)}`,
    };

    await store.save(key, checkpoint);
    expect(await store.load(key)).toEqual(checkpoint);
    const persisted = db.db.prepare(
      `SELECT value FROM settings WHERE key = ?`,
    ).get(`${SqliteContextGraphAuthorityHistoryStore.KEY_PREFIX}${key}`) as { value: string };
    expect(JSON.parse(persisted.value)).toEqual(checkpoint);

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteContextGraphAuthorityHistoryStore(db);
    expect(await reopened.load(key)).toEqual(checkpoint);
    await reopened.delete(key);
    expect(await reopened.load(key)).toBeUndefined();
  });

  it('atomically advances opaque contract-wide authority index checkpoints', async () => {
    const store = new SqliteContextGraphAuthorityIndexStore(db);
    const scope = 'evm:84532:hub=0xabc:context-graph-storage=0xdef';
    const first = { version: 1, cursor: { throughBlockNumber: 20 } };
    const second = { version: 1, cursor: { throughBlockNumber: 30 } };

    expect(await store.compareAndSwap(scope, undefined, first)).toBe(1);
    expect(await store.compareAndSwap(scope, undefined, first)).toBeUndefined();
    expect(await store.load(scope)).toEqual({ token: 1, value: first });
    expect(await store.compareAndSwap(scope, 1, second)).toBe(2);
    expect(await store.compareAndSwap(scope, 1, second)).toBeUndefined();
    expect(await store.invalidate(scope, 1)).toBeUndefined();

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteContextGraphAuthorityIndexStore(db);
    expect(await reopened.load(scope)).toEqual({ token: 2, value: second });

    db.db.prepare(`
      UPDATE context_graph_authority_indexes SET checkpoint_json = ? WHERE scope = ?
    `).run('{not-json', scope);
    expect(await reopened.load(scope)).toEqual({
      token: 2,
      value: { invalidCheckpointJson: '{not-json' },
    });
    expect(await reopened.invalidate(scope, 1)).toBeUndefined();
    expect(await reopened.invalidate(scope, 2)).toBe(3);
    expect(await reopened.load(scope)).toEqual({ token: 3, value: null });
    expect(await reopened.compareAndSwap(scope, 3, first)).toBe(4);
    expect(await reopened.load(scope)).toEqual({ token: 4, value: first });
  });
});
