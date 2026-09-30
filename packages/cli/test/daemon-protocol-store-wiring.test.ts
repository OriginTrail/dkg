import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { KaNumberAllocator, type DKGAgentConfig } from '@origintrail-official/dkg-agent';
import { buildEvmDeploymentId } from '@origintrail-official/dkg-chain';
import {
  SqliteChainEventCursorStore,
  SqliteChainEventLogStore,
  SqliteChangelogCursorStore,
  SqliteChangelogEraGuard,
  SqliteContextGraphAuthorityHistoryStore,
  SqliteContextGraphAuthorityIndexStore,
  SqliteContextGraphRegistryScanCursorStore,
  SqliteContextGraphStorageDiscoveryStore,
  SqliteMessageIdempotencyStore,
  SqliteProtocolOutboxStore,
  SqliteSyncCheckpointStore,
} from '@origintrail-official/dkg-node-store';
import { DashboardDB, SCHEMA_VERSION } from '@origintrail-official/dkg-node-ui';
import type {
  NodeDatabase,
  ProtocolStoreOptions,
  ProtocolStores,
} from '../src/daemon/protocol-persistence.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

/**
 * The daemon composes every protocol persistence store (the ones that moved to
 * `@origintrail-official/dkg-node-store`) over the dashboard's `node-ui.db` in
 * `runDaemonInner`, through `openNodeDatabase` and `createProtocolStores`. This
 * boots the REAL start-up path against a `node-ui.db` whose protocol tables were
 * filled with raw SQL (no store code involved), then asserts that the stores the
 * daemon hands the agent are the ones that composition returned, that they read
 * those rows back, and that boot leaves the file, its schema and every seeded
 * row untouched: same file, same schema, no second SQLite file.
 *
 * The composition seam is observed through its typed results (the two functions
 * are wrapped to record what they return), never through a store's private
 * fields. Only `DKGAgent.create` is replaced (it captures the wiring and stops
 * the boot); the DashboardDB, the schema and every store are real. The seam
 * itself is tested directly in `protocol-persistence.test.ts`.
 */
const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
  composition: { opened: 0, composed: 0 } as {
    owner?: NodeDatabase;
    storesDatabase?: unknown;
    storesOptions?: ProtocolStoreOptions;
    stores?: ProtocolStores;
    opened: number;
    composed: number;
  },
}));

vi.mock('@origintrail-official/dkg-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-agent')>();
  return {
    ...actual,
    DKGAgent: { create: mocks.agentCreate },
    loadOpWallets: mocks.loadOpWallets,
  };
});

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadNetworkConfig: mocks.loadNetworkConfig,
  };
});

vi.mock('../src/daemon/protocol-persistence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/protocol-persistence.js')>();
  return {
    ...actual,
    // The real functions, recording what they hand back to the daemon.
    openNodeDatabase: (dataDir: string) => {
      const owner = actual.openNodeDatabase(dataDir);
      mocks.composition.owner = owner;
      mocks.composition.opened += 1;
      return owner;
    },
    createProtocolStores: (
      database: Parameters<typeof actual.createProtocolStores>[0],
      options: ProtocolStoreOptions,
    ) => {
      const stores = actual.createProtocolStores(database, options);
      mocks.composition.storesDatabase = database;
      mocks.composition.storesOptions = options;
      mocks.composition.stores = stores;
      mocks.composition.composed += 1;
      return stores;
    },
  };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

const HUB = '0x3334567890123456789012345678901234567890';
const DEPLOYMENT_ID = buildEvmDeploymentId({ chainId: 'gnosis:100', hubAddress: HUB });
const PEER = '12D3KooWLegacyNodeUiDbPeer';
const PROTOCOL = '/dkg/10.0.1/message';
const AUTHOR = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const REGISTRY = '0x7777777777777777777777777777777777777777';
const CHAIN_LOG_SCOPE = `${DEPLOYMENT_ID}:legacy-log`;
const FAR_FUTURE = Date.now() + 90 * 24 * 60 * 60 * 1000;
const SEEDED_AT = Date.now();

/** The protocol tables and the column order used to fingerprint them. */
const PROTOCOL_TABLES = [
  'message_idempotency',
  'protocol_outbox',
  'sync_checkpoints',
  'changelog_cursors',
  'changelog_era',
  'ka_numbers',
  'runtime_cursors',
  'settings',
  'context_graph_authority_indexes',
  'chain_index_cursor',
  'chain_events',
  'chain_index_coverage',
];

const AUTHORITY_CHECKPOINT = {
  version: 1,
  state: { throughBlockNumber: 5000 },
  integrity: `0x${'99'.repeat(32)}`,
};
const DISCOVERY_CHECKPOINT = { version: 1, nextId: '7', entries: [] };

/** Fill the protocol tables with raw SQL, exactly as an older node would have left them. */
function seedLegacyProtocolRows(db: Database.Database): void {
  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);
  run(
    `INSERT INTO message_idempotency (peer_id, protocol, message_id, direction, response_blob, response_size, ts)
     VALUES (?, ?, ?, 'in', ?, 3, ?)`,
    PEER, PROTOCOL, 'legacy-in-1', Buffer.from([1, 2, 3]), SEEDED_AT,
  );
  run(
    `INSERT INTO protocol_outbox
       (peer_id, protocol, message_id, payload, attempts, first_failure_at, last_attempt_at, next_attempt_at, last_error)
     VALUES (?, ?, ?, ?, 3, ?, ?, ?, 'connection reset')`,
    PEER, PROTOCOL, 'legacy-out-1', Buffer.from([9, 8, 7, 6]), SEEDED_AT - 2_000, SEEDED_AT - 1_000, SEEDED_AT + 60_000,
  );
  run(
    `INSERT INTO sync_checkpoints (key, offset, updated_at, expires_at, terminal)
     VALUES (?, ?, ?, ?, 0)`,
    `${PEER}|legacy-cg|durable|data`, 4096, SEEDED_AT, FAR_FUTURE,
  );
  run(
    `INSERT INTO changelog_cursors (peer_id, context_graph_id, era, seq, updated_at) VALUES (?, ?, ?, ?, ?)`,
    PEER, 'legacy-cg', 'era-legacy', 41, SEEDED_AT,
  );
  run(`INSERT INTO changelog_era (id, era, high_seq, updated_at) VALUES (1, ?, ?, ?)`, 'era-legacy', 41, SEEDED_AT);
  run(`INSERT INTO ka_numbers (author_address, next_number) VALUES (?, ?)`, AUTHOR, 7);
  run(
    `INSERT INTO runtime_cursors (namespace, scope, key, value, updated_at) VALUES (?, ?, ?, ?, ?)`,
    'chainEventPoller.cursor', DEPLOYMENT_ID, 'contextGraphDiscovery', 4321, SEEDED_AT,
  );
  run(
    `INSERT INTO runtime_cursors (namespace, scope, key, value, updated_at) VALUES (?, ?, ?, ?, ?)`,
    'contextGraphRegistryScan.cursor', `gnosis:100:${DEPLOYMENT_ID}`, REGISTRY, 5000, SEEDED_AT,
  );
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)`,
    `contextGraphStorageDiscovery.checkpoint:v1:${DEPLOYMENT_ID}`, JSON.stringify(DISCOVERY_CHECKPOINT),
  );
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)`,
    'contextGraphAuthorityHistory.checkpoint:v1:legacy-key', JSON.stringify(AUTHORITY_CHECKPOINT),
  );
  run(
    `INSERT INTO context_graph_authority_indexes (scope, revision, checkpoint_json, updated_at) VALUES (?, ?, ?, ?)`,
    'legacy-index-scope', 3, JSON.stringify({ version: 1, cursor: { throughBlockNumber: 30 } }), SEEDED_AT,
  );
  run(
    `INSERT INTO chain_index_cursor
       (scope, revision, lineage, deployment_block, settled_block, settled_hash, head_block, head_hash,
        head_timestamp_seconds, head_fetched_at_ms, topic_set_version, suspected_fork_block, updated_at)
     VALUES (?, 2, '0xlineage', 1, 10, '0xsettled', 12, '0xhead', 1700000000, 1700000000000, 'v1', NULL, ?)`,
    CHAIN_LOG_SCOPE, SEEDED_AT,
  );
  run(
    `INSERT INTO chain_events
       (scope, block_number, log_index, block_hash, tx_hash, address, topic0, topic1, topic2, topic3, data, settled)
     VALUES (?, 10, 0, '0xb10', '0xt10', '0xaddr', '0xtopic0', NULL, NULL, NULL, '0xdata', 1)`,
    CHAIN_LOG_SCOPE,
  );
  run(
    `INSERT INTO chain_index_coverage
       (scope, family, address, covered_from_block, covered_through_block, floor_block, updated_at)
     VALUES (?, 'context-graph-authority', '0xaddr', 1, 12, 1, ?)`,
    CHAIN_LOG_SCOPE, SEEDED_AT,
  );
}

function normalize(value: unknown): unknown {
  return Buffer.isBuffer(value) ? `blob:${value.toString('hex')}` : value;
}

/** Every protocol row, order-independent, blobs as hex: a comparable fingerprint. */
function fingerprintRows(db: Database.Database): Record<string, string[]> {
  return Object.fromEntries(PROTOCOL_TABLES.map((table) => {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    return [table, rows.map((row) => JSON.stringify(
      Object.fromEntries(Object.entries(row).map(([column, cell]) => [column, normalize(cell)])),
    )).sort()];
  }));
}

/** The protocol tables' and indexes' DDL exactly as SQLite stored it. */
function fingerprintSchema(db: Database.Database): Array<Record<string, unknown>> {
  const names = PROTOCOL_TABLES.map((name) => `'${name}'`).join(', ');
  return db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE (type = 'table' AND name IN (${names}))
        OR (type = 'index' AND tbl_name IN (${names}) AND sql IS NOT NULL)
     ORDER BY type, name
  `).all() as Array<Record<string, unknown>>;
}

describe('daemon composition of the protocol persistence stores', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.composition.owner = undefined;
    mocks.composition.stores = undefined;
    mocks.composition.storesDatabase = undefined;
    mocks.composition.storesOptions = undefined;
    mocks.composition.opened = 0;
    mocks.composition.composed = 0;
    process.stdout.write = stdoutWrite;
    process.removeAllListeners('uncaughtException');
    for (const listener of uncaughtExceptionListeners) process.on('uncaughtException', listener);
    process.removeAllListeners('unhandledRejection');
    for (const listener of unhandledRejectionListeners) process.on('unhandledRejection', listener);
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it('boots against a legacy node-ui.db: every store reads the seeded rows and boot rewrites nothing', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-protocol-store-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    // A node that last ran before this boot: schema at the current version,
    // protocol rows written by raw SQL.
    const legacy = new DashboardDB({ dataDir: tempHome });
    seedLegacyProtocolRows(legacy.db);
    const rowsBefore = fingerprintRows(legacy.db);
    const schemaBefore = fingerprintSchema(legacy.db);
    const versionBefore = legacy.db.pragma('user_version', { simple: true });
    legacy.close();
    expect(versionBefore).toBe(SCHEMA_VERSION);
    expect(Object.values(rowsBefore).every((rows) => rows.length > 0), 'every protocol table is seeded').toBe(true);

    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: ['/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M'],
      defaultNodeRole: 'edge',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runDaemonInner(true, {
      name: 'protocol-store-wiring-test',
      listenPort: 0,
      nodeRole: 'edge',
      store: { changelog: true },
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: HUB,
        chainId: 'gnosis:100',
      },
    } as Parameters<typeof runDaemonInner>[1], Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as DKGAgentConfig;
    // The daemon opened one node database and composed its stores exactly once.
    const { owner, stores } = mocks.composition;
    if (!owner || !stores) throw new Error('the daemon did not compose its protocol stores through protocol-persistence');
    expect(mocks.composition.opened).toBe(1);
    expect(mocks.composition.composed).toBe(1);
    const daemonDb: Database.Database = owner.dashboardDb.db;
    try {
      // 1. The stores were built over the very DashboardDB the daemon opened
      //    (one connection), for this chain deployment, with the changelog on.
      expect(owner.dashboardDb).toBeInstanceOf(DashboardDB);
      expect(mocks.composition.storesDatabase).toBe(owner.dashboardDb);
      expect(mocks.composition.storesOptions).toEqual({ chainCursorScope: DEPLOYMENT_ID, changelogEnabled: true });

      // 2. The agent is handed exactly those instances, of the node-store classes.
      expect(createArg.messengerStores?.idempotencyStore).toBe(stores.messengerStores.idempotencyStore);
      expect(createArg.messengerStores?.outboxStore).toBe(stores.messengerStores.outboxStore);
      expect(createArg.syncCheckpointStore).toBe(stores.syncCheckpointStore);
      expect(createArg.changelogCursorStore).toBe(stores.changelogCursorStore);
      expect(createArg.chainEventCursorStore).toBe(stores.chainEventCursorStore);
      expect(createArg.contextGraphRegistryScanCursorStore).toBe(stores.contextGraphRegistryScanCursorStore);
      expect(createArg.contextGraphStorageDiscoveryStore).toBe(stores.contextGraphStorageDiscoveryStore);
      expect(createArg.localContextGraphAuthorityHistoryStore).toBe(stores.localContextGraphAuthorityHistoryStore);
      expect(createArg.localContextGraphAuthorityIndexStore).toBe(stores.localContextGraphAuthorityIndexStore);
      expect(createArg.chainEventLogStore).toBe(stores.chainEventLogStore);
      const changelog = createArg.storeConfig?.changelog;
      const eraGuard = typeof changelog === 'object' ? changelog.eraGuard : undefined;
      expect(eraGuard).toBe(stores.changelogEraGuard);
      expect(createArg.kaNumberAllocator).toBeInstanceOf(KaNumberAllocator);
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

      // 3. Each one reads what the legacy file holds.
      expect(stores.messengerStores.idempotencyStore.check(PEER, PROTOCOL, 'legacy-in-1', 'in'))
        .toEqual({ seen: true, cachedResponse: new Uint8Array([1, 2, 3]) });
      const queued = stores.messengerStores.outboxStore;
      expect(queued.size()).toBe(1);
      expect(queued.hasPendingFor(PEER)).toBe(true);
      expect(stores.syncCheckpointStore.get(`${PEER}|legacy-cg|durable|data`)?.offset).toBe(4096);
      expect(stores.changelogCursorStore.get(PEER, 'legacy-cg')).toMatchObject({ era: 'era-legacy', seq: 41 });
      await expect(eraGuard?.load()).resolves.toEqual({ era: 'era-legacy', highSeq: 41 });
      // The next KA number for the author continues from the persisted counter,
      // through the allocator the daemon built over the composed store.
      const allocator = createArg.kaNumberAllocator;
      expect(allocator?.peekKaId(AUTHOR)).toBe((BigInt(AUTHOR) << 96n) | 7n);
      allocator?.markReconciled();
      expect(allocator?.allocate(AUTHOR)).toEqual({ kaId: (BigInt(AUTHOR) << 96n) | 7n, number: 7n });
      await expect(stores.chainEventCursorStore.loadLane('contextGraphDiscovery')).resolves.toBe(4321);
      await expect(stores.contextGraphRegistryScanCursorStore.load({
        chainId: 'gnosis:100', deploymentId: DEPLOYMENT_ID, registryAddress: REGISTRY,
      })).resolves.toBe(5000);
      await expect(stores.contextGraphStorageDiscoveryStore.load()).resolves.toEqual(DISCOVERY_CHECKPOINT);
      await expect(stores.localContextGraphAuthorityHistoryStore.load('legacy-key'))
        .resolves.toEqual(AUTHORITY_CHECKPOINT);
      await expect(stores.localContextGraphAuthorityIndexStore.load('legacy-index-scope'))
        .resolves.toEqual({ token: 3, value: { version: 1, cursor: { throughBlockNumber: 30 } } });
      const logState = await stores.chainEventLogStore.load(CHAIN_LOG_SCOPE);
      expect(logState?.cursor).toMatchObject({ revision: 2, settledBlockNumber: 10, lineage: '0xlineage' });
      await expect(stores.chainEventLogStore.readEvents(CHAIN_LOG_SCOPE, {
        fromBlockNumber: 0, throughBlockNumber: 20,
      })).resolves.toHaveLength(1);

      // 4. Boot itself rewrote nothing: the schema, the version and every row
      //    are as the legacy file left them. (The allocation above is the only
      //    write this test made, so account for it explicitly.)
      expect(daemonDb.pragma('user_version', { simple: true })).toBe(versionBefore);
      expect(fingerprintSchema(daemonDb)).toEqual(schemaBefore);
      const rowsAfter = fingerprintRows(daemonDb);
      const { ka_numbers: kaAfter, ...otherAfter } = rowsAfter;
      const { ka_numbers: kaBefore, ...otherBefore } = rowsBefore;
      expect(otherAfter).toEqual(otherBefore);
      expect(kaBefore).toEqual([JSON.stringify({ author_address: AUTHOR, next_number: 7 })]);
      expect(kaAfter).toEqual([JSON.stringify({ author_address: AUTHOR, next_number: 8 })]);

      // 5. Same file: one SQLite database in the node's home, no protocol file.
      const sqliteFiles = (await readdir(tempHome)).filter((name) => /\.db(-wal|-shm)?$/.test(name));
      expect([...new Set(sqliteFiles.map((name) => name.replace(/-(wal|shm)$/, '')))]).toEqual(['node-ui.db']);
    } finally {
      // The daemon's owner is the typed cleanup path for the connection it opened.
      owner.close();
    }
    expect(daemonDb.open).toBe(false);
  });
});
