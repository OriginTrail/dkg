import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as nodeStore from '../src/index.js';
import {
  SqliteChainEventCursorStore,
  SqliteChainEventLogStore,
  SqliteChangelogCursorStore,
  SqliteChangelogEraGuard,
  SqliteContextGraphAuthorityHistoryStore,
  SqliteContextGraphAuthorityIndexStore,
  SqliteContextGraphRegistryScanCursorStore,
  SqliteContextGraphStorageDiscoveryStore,
  SqliteKaNumberStore,
  SqliteMessageIdempotencyStore,
  SqliteProtocolOutboxStore,
  SqliteSyncCheckpointStore,
  type NodeStoreDatabaseHandle,
} from '../src/index.js';
import { DashboardDB } from './helpers/dashboard-db.js';

/** Every runtime export the package promises. Adding a store is a deliberate edit here. */
const PROTOCOL_STORE_EXPORTS = [
  'SqliteChainEventCursorStore',
  'SqliteChainEventLogStore',
  'SqliteChangelogCursorStore',
  'SqliteChangelogEraGuard',
  'SqliteContextGraphAuthorityHistoryStore',
  'SqliteContextGraphAuthorityIndexStore',
  'SqliteContextGraphRegistryScanCursorStore',
  'SqliteContextGraphStorageDiscoveryStore',
  'SqliteKaNumberStore',
  'SqliteMessageIdempotencyStore',
  'SqliteProtocolOutboxStore',
  'SqliteSyncCheckpointStore',
];

describe('package surface', () => {
  it('exports exactly the protocol persistence stores, and only stores', () => {
    expect(Object.keys(nodeStore).sort()).toEqual(PROTOCOL_STORE_EXPORTS);
    for (const name of PROTOCOL_STORE_EXPORTS) {
      expect(typeof (nodeStore as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('constructing the stores from a bare database handle', () => {
  let dashboard: DashboardDB;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-node-store-surface-'));
    dashboard = new DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds and exercises every store from `{ db }` alone, with no DashboardDB in sight', async () => {
    // The whole point of the structural handle: the stores need an open,
    // migrated better-sqlite3 handle and nothing else the dashboard owns.
    const handle: NodeStoreDatabaseHandle = { db: dashboard.db };
    const scope = 'evm:31337:0xhub';

    const idempotency = new SqliteMessageIdempotencyStore(handle);
    idempotency.record('peer', '/dkg/10.0.1/message', 'msg-1', 'in', new Uint8Array([7]));
    expect(idempotency.check('peer', '/dkg/10.0.1/message', 'msg-1', 'in').seen).toBe(true);

    const outbox = new SqliteProtocolOutboxStore(handle);
    outbox.enqueue('peer', '/dkg/10.0.1/message', 'msg-1', new Uint8Array([1]), 'reset', 1_000);
    expect(outbox.size()).toBe(1);

    const checkpoints = new SqliteSyncCheckpointStore(handle);
    checkpoints.set('peer|cg|durable|data', 42);
    expect(checkpoints.get('peer|cg|durable|data')?.offset).toBe(42);

    const cursors = new SqliteChangelogCursorStore(handle);
    cursors.set('peer', 'cg', 'era-1', 3);
    expect(cursors.get('peer', 'cg')).toMatchObject({ era: 'era-1', seq: 3 });

    const eraGuard = new SqliteChangelogEraGuard(handle);
    await eraGuard.save('era-1', 9);
    expect(await eraGuard.load()).toEqual({ era: 'era-1', highSeq: 9 });

    const kaNumbers = new SqliteKaNumberStore(handle);
    expect(kaNumbers.allocate('0xAAAA')).toBe(0n);
    expect(kaNumbers.peekNext('0xaaaa')).toBe(1n);

    const laneCursors = new SqliteChainEventCursorStore(handle, { scope });
    await laneCursors.saveLane('contextGraphDiscovery', 77);
    expect(await laneCursors.loadLane('contextGraphDiscovery')).toBe(77);

    const registryKey = { chainId: 'evm:31337', deploymentId: scope, registryAddress: '0xABC' };
    const registryScan = new SqliteContextGraphRegistryScanCursorStore(handle);
    await registryScan.save(registryKey, 88);
    expect(await registryScan.load(registryKey)).toBe(88);

    const discovery = new SqliteContextGraphStorageDiscoveryStore(handle, { scope });
    await discovery.save({ nextId: '7' });
    expect(await discovery.load()).toEqual({ nextId: '7' });

    const history = new SqliteContextGraphAuthorityHistoryStore(handle);
    await history.save('cache-key', { version: 1 });
    expect(await history.load('cache-key')).toEqual({ version: 1 });

    const index = new SqliteContextGraphAuthorityIndexStore(handle);
    expect(await index.compareAndSwap(scope, undefined, { version: 1 })).toBe(1);
    expect(await index.load(scope)).toEqual({ token: 1, value: { version: 1 } });

    const chainLog = new SqliteChainEventLogStore(handle);
    expect(await chainLog.load(scope)).toBeUndefined();
  });

  it('shares one database across stores and writes nothing outside the host file', () => {
    // Every store built on the same handle sees one database, and the stores
    // create no file of their own (Phase 1 keeps protocol state in `node-ui.db`).
    new SqliteKaNumberStore({ db: dashboard.db }).allocate('0xbeef');
    const reader = new Database(join(dir, 'node-ui.db'), { readonly: true });
    try {
      expect(reader.prepare('SELECT next_number FROM ka_numbers WHERE author_address = ?').get('0xbeef'))
        .toEqual({ next_number: 1 });
    } finally {
      reader.close();
    }
    expect(readdirSync(dir).filter((name) => name.endsWith('.db'))).toEqual(['node-ui.db']);
  });
});

describe('the host owns the schema', () => {
  it('constructs against an empty database but never creates a table', () => {
    const empty = new Database(':memory:');
    try {
      const store = new SqliteKaNumberStore({ db: empty });
      expect(() => store.allocate('0xabc')).toThrow(/no such table: ka_numbers/);
      expect(() => new SqliteSyncCheckpointStore({ db: empty }).get('key'))
        .toThrow(/no such table: sync_checkpoints/);
      expect(empty.prepare(`SELECT COUNT(*) AS c FROM sqlite_master`).get()).toEqual({ c: 0 });
    } finally {
      empty.close();
    }
  });
});
