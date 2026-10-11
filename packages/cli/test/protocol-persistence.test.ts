import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS,
  DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS,
} from '@origintrail-official/dkg-core';
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
  type SqliteChainEventLogCommit,
} from '@origintrail-official/dkg-node-store';
import { DashboardDB, SCHEMA_VERSION } from '@origintrail-official/dkg-node-ui';
import { createProtocolStores, type ProtocolStores } from '../src/daemon/protocol-persistence.js';

/**
 * The daemon's protocol-persistence composition: `createProtocolStores` over a
 * real `DashboardDB`, opened and closed here exactly as the daemon does. That the
 * daemon constructs exactly ONE such database and closes it exactly once on its
 * shutdown path and on each core-prerequisite fatal exit is pinned in
 * `daemon-protocol-store-wiring.test.ts`. Everything here goes through the typed
 * result and the stores' and DashboardDB's public API: no private fields, no casts.
 */
const SCOPE = 'evm:31337:hub=0xhub';
const PEER = '12D3KooWProtocolPersistencePeer';
const PROTOCOL = '/dkg/10.0.1/message';
const AUTHOR = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const REGISTRY = '0x7777777777777777777777777777777777777777';
const HASH = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;

const CHAIN_LOG_COMMIT: SqliteChainEventLogCommit = {
  replacedRange: { fromBlockNumber: 11, throughBlockNumber: 12 },
  cursor: {
    lineage: HASH(1),
    deploymentBlockNumber: 1,
    settledBlockNumber: 10,
    settledBlockHash: HASH(10),
    head: { number: 12, hash: HASH(12), timestampSeconds: 1_700_000_000, fetchedAtMs: 1_700_000_000_000 },
    topicSetVersion: 'v1',
  },
  rows: [{
    blockNumber: 11,
    logIndex: 0,
    blockHash: HASH(11),
    transactionHash: HASH(0xaa),
    address: REGISTRY,
    topics: [HASH(0xbb)],
    data: '0x00',
    settled: false,
  }],
  coverage: [{
    family: 'context-graph-authority',
    address: REGISTRY,
    coveredFromBlock: 1,
    coveredThroughBlock: 12,
    floorBlock: 1,
  }],
};

interface StoreWrite {
  /** The typed field of {@link ProtocolStores} the write goes through. */
  readonly store: keyof ProtocolStores | 'messengerStores.idempotencyStore' | 'messengerStores.outboxStore';
  /** Tables the write lands in, read back over the shared connection. */
  readonly tables: readonly string[];
  readonly write: (stores: ProtocolStores & { readonly changelogEraGuard: SqliteChangelogEraGuard }) => unknown;
}

/** One real write per store, through that store's public API. */
const STORE_WRITES: readonly StoreWrite[] = [
  {
    store: 'messengerStores.idempotencyStore',
    tables: ['message_idempotency'],
    write: (s) => s.messengerStores.idempotencyStore.record(PEER, PROTOCOL, 'msg-1', 'in', new Uint8Array([1])),
  },
  {
    store: 'messengerStores.outboxStore',
    tables: ['protocol_outbox'],
    write: (s) => s.messengerStores.outboxStore.enqueue(PEER, PROTOCOL, 'msg-1', new Uint8Array([1]), 'reset', 1_000),
  },
  {
    store: 'syncCheckpointStore',
    tables: ['sync_checkpoints'],
    write: (s) => s.syncCheckpointStore.set('peer|cg|durable|meta', 5),
  },
  {
    store: 'changelogCursorStore',
    tables: ['changelog_cursors'],
    write: (s) => s.changelogCursorStore.set(PEER, 'cg', 'era-1', 3),
  },
  {
    store: 'changelogEraGuard',
    tables: ['changelog_era'],
    write: (s) => s.changelogEraGuard.save('era-1', 3),
  },
  {
    store: 'chainEventCursorStore',
    tables: ['runtime_cursors'],
    write: (s) => s.chainEventCursorStore.saveLane('contextGraphDiscovery', 9),
  },
  {
    store: 'contextGraphRegistryScanCursorStore',
    tables: ['runtime_cursors'],
    write: (s) => s.contextGraphRegistryScanCursorStore.save(
      { chainId: 'evm:31337', deploymentId: SCOPE, registryAddress: REGISTRY },
      5,
    ),
  },
  {
    store: 'contextGraphStorageDiscoveryStore',
    tables: ['settings'],
    write: (s) => s.contextGraphStorageDiscoveryStore.save({ version: 1, nextId: '7', entries: [] }),
  },
  {
    store: 'localContextGraphAuthorityHistoryStore',
    tables: ['settings'],
    write: (s) => s.localContextGraphAuthorityHistoryStore.save('history-key', { version: 1 }),
  },
  {
    store: 'localContextGraphAuthorityIndexStore',
    tables: ['context_graph_authority_indexes'],
    write: (s) => s.localContextGraphAuthorityIndexStore.compareAndSwap('index-scope', undefined, { version: 1 }),
  },
  {
    store: 'chainEventLogStore',
    tables: ['chain_index_cursor', 'chain_events', 'chain_index_coverage'],
    write: (s) => s.chainEventLogStore.commit(SCOPE, undefined, CHAIN_LOG_COMMIT),
  },
  {
    store: 'kaNumberStore',
    tables: ['ka_numbers'],
    write: (s) => s.kaNumberStore.allocate(AUTHOR),
  },
];

describe('protocol persistence composition', () => {
  let dir: string;
  let dashboardDb: DashboardDB;

  const countRows = (tables: readonly string[]): number => tables.reduce(
    (total, table) => total + (dashboardDb.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c,
    0,
  );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-protocol-persistence-'));
    dashboardDb = new DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    dashboardDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('over the dashboard database', () => {
    it('composes every store over the current schema in node-ui.db, and opens no other SQLite file', () => {
      createProtocolStores(dashboardDb, { chainCursorScope: SCOPE, changelogEnabled: true });
      expect(dashboardDb.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(new Set(readdirSync(dir).filter((name) => /\.db(-wal|-shm)?$/.test(name)).map((name) => name.replace(/-(wal|shm)$/, ''))))
        .toEqual(new Set(['node-ui.db']));
    });

    it('closing the database ends the shared connection, so every store stops working', () => {
      const stores = createProtocolStores(dashboardDb, { chainCursorScope: SCOPE, changelogEnabled: false });
      stores.kaNumberStore.allocate(AUTHOR);
      expect(dashboardDb.db.open).toBe(true);

      dashboardDb.close();

      expect(dashboardDb.db.open).toBe(false);
      expect(() => stores.kaNumberStore.allocate(AUTHOR)).toThrow(/not open/i);
      expect(() => stores.syncCheckpointStore.get('peer|cg|durable|meta')).toThrow(/not open/i);
    });
  });

  describe('createProtocolStores', () => {
    let stores: ProtocolStores & { readonly changelogEraGuard: SqliteChangelogEraGuard };

    beforeEach(() => {
      const composed = createProtocolStores(dashboardDb, { chainCursorScope: SCOPE, changelogEnabled: true });
      if (composed.changelogEraGuard === undefined) throw new Error('the era guard is built when the changelog is enabled');
      stores = { ...composed, changelogEraGuard: composed.changelogEraGuard };
    });

    it('builds the node-store classes, one instance per store', () => {
      expect(stores.messengerStores.idempotencyStore).toBeInstanceOf(SqliteMessageIdempotencyStore);
      expect(stores.messengerStores.outboxStore).toBeInstanceOf(SqliteProtocolOutboxStore);
      expect(stores.syncCheckpointStore).toBeInstanceOf(SqliteSyncCheckpointStore);
      expect(stores.changelogCursorStore).toBeInstanceOf(SqliteChangelogCursorStore);
      expect(stores.changelogEraGuard).toBeInstanceOf(SqliteChangelogEraGuard);
      expect(stores.chainEventCursorStore).toBeInstanceOf(SqliteChainEventCursorStore);
      expect(stores.contextGraphRegistryScanCursorStore).toBeInstanceOf(SqliteContextGraphRegistryScanCursorStore);
      expect(stores.contextGraphStorageDiscoveryStore).toBeInstanceOf(SqliteContextGraphStorageDiscoveryStore);
      expect(stores.localContextGraphAuthorityHistoryStore).toBeInstanceOf(SqliteContextGraphAuthorityHistoryStore);
      expect(stores.localContextGraphAuthorityIndexStore).toBeInstanceOf(SqliteContextGraphAuthorityIndexStore);
      expect(stores.chainEventLogStore).toBeInstanceOf(SqliteChainEventLogStore);
      expect(stores.kaNumberStore).toBeInstanceOf(SqliteKaNumberStore);
    });

    // A store on a connection of its own would not join this transaction: its
    // write would either survive the rollback or block on the write lock this
    // connection holds. So this proves each store shares THE connection, not
    // just the file.
    it.each(STORE_WRITES)('$store shares the one connection: its write joins, and rolls back with, its transaction', async ({ tables, write }) => {
      const before = countRows(tables);
      dashboardDb.db.exec('BEGIN IMMEDIATE');
      try {
        await write(stores);
        expect(countRows(tables), 'written inside the transaction, visible on the shared connection').toBeGreaterThan(before);
      } finally {
        dashboardDb.db.exec('ROLLBACK');
      }
      expect(countRows(tables), 'gone after the rollback').toBe(before);
    });

    it('covers every store the composition returns', () => {
      const covered = new Set(STORE_WRITES.map((entry) => entry.store.split('.')[0]));
      const returned = Object.entries(stores).filter(([, value]) => value !== undefined).map(([name]) => name);
      expect(returned.sort()).toEqual([...covered].sort());
    });

    it('hands the stores a bare `{ db }` handle: nothing DashboardDB-specific is needed', async () => {
      const bare = createProtocolStores({ db: dashboardDb.db }, {
        chainCursorScope: SCOPE,
        changelogEnabled: false,
      });
      expect(bare.kaNumberStore.allocate(AUTHOR)).toBe(0n);
      expect(countRows(['ka_numbers'])).toBe(1);
    });

    it('applies the daemon outbox policy: the retry ladder, then the last rung', () => {
      const outbox = stores.messengerStores.outboxStore;
      const ladder = DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS;
      for (let attempt = 1; attempt <= ladder.length + 2; attempt++) {
        const entry = outbox.enqueue(PEER, PROTOCOL, 'msg-ladder', new Uint8Array([1]), 'reset', 1_000);
        expect(entry.attempts).toBe(attempt);
        expect(entry.nextAttemptAt - 1_000, `attempt ${attempt}`).toBe(ladder[Math.min(attempt - 1, ladder.length - 1)]);
      }
    });

    it('applies the daemon outbox age limit to the queue it hands the messenger', () => {
      const outbox = stores.messengerStores.outboxStore;
      const now = 10 * DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS;
      outbox.enqueue(PEER, PROTOCOL, 'msg-fresh', new Uint8Array([1]), 'reset', now - DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS + 1_000);
      outbox.enqueue(PEER, PROTOCOL, 'msg-stale', new Uint8Array([1]), 'reset', now - DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS - 1_000);
      expect(outbox.dropExpired(now).map((entry) => entry.messageId)).toEqual(['msg-stale']);
      expect(outbox.hasEntry(PEER, PROTOCOL, 'msg-fresh')).toBe(true);
    });

    it('scopes the chain cursors and the storage-discovery checkpoint to the deployment', async () => {
      await stores.chainEventCursorStore.saveLane('contextGraphDiscovery', 9);
      await stores.contextGraphStorageDiscoveryStore.save({ version: 1, nextId: '7', entries: [] });

      const cursorScopes = dashboardDb.db
        .prepare(`SELECT scope FROM runtime_cursors WHERE namespace = 'chainEventPoller.cursor'`)
        .all() as Array<{ scope: string }>;
      expect(cursorScopes).toEqual([{ scope: SCOPE }]);
      const discoveryKeys = dashboardDb.db
        .prepare(`SELECT key FROM settings WHERE key LIKE 'contextGraphStorageDiscovery.checkpoint:v1:%'`)
        .all() as Array<{ key: string }>;
      expect(discoveryKeys).toEqual([{ key: `${SqliteContextGraphStorageDiscoveryStore.KEY_PREFIX}${SCOPE}` }]);
    });

    it('reads back through the same scope another composition of the same file wrote', async () => {
      await stores.chainEventCursorStore.saveLane('contextGraphDiscovery', 9);
      const again = createProtocolStores(dashboardDb, { chainCursorScope: SCOPE, changelogEnabled: false });
      await expect(again.chainEventCursorStore.loadLane('contextGraphDiscovery')).resolves.toBe(9);
      const otherDeployment = createProtocolStores(dashboardDb, { chainCursorScope: `${SCOPE}:other`, changelogEnabled: false });
      await expect(otherDeployment.chainEventCursorStore.loadLane('contextGraphDiscovery')).resolves.toBeUndefined();
    });
  });

  describe('the durable era guard follows the changelog intent', () => {
    it('is built when the changelog is enabled and absent when it is not', () => {
      expect(createProtocolStores(dashboardDb, { chainCursorScope: SCOPE, changelogEnabled: true }).changelogEraGuard)
        .toBeInstanceOf(SqliteChangelogEraGuard);
      expect(createProtocolStores(dashboardDb, { chainCursorScope: SCOPE, changelogEnabled: false }).changelogEraGuard)
        .toBeUndefined();
    });
  });
});
