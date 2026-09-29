import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildEvmDeploymentId } from '@origintrail-official/dkg-chain';
import {
  DashboardDB,
  SCHEMA_VERSION,
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
} from '@origintrail-official/dkg-node-ui';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

/**
 * The daemon composes every protocol persistence store (the ones that moved to
 * `@origintrail-official/dkg-node-store`) over the dashboard's `node-ui.db` in
 * `runDaemonInner`. This boots the REAL start-up path against a `node-ui.db`
 * whose protocol tables were filled with raw SQL (no store code involved), then
 * asserts that the stores the daemon hands the agent read those rows back, and
 * that boot leaves the file, its schema and every seeded row untouched: same
 * file, same schema, no second SQLite file.
 *
 * Only `DKGAgent.create` is replaced (it captures the wiring and stops the
 * boot); the DashboardDB, the schema and every store are real.
 */
const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
}));

vi.mock('@origintrail-official/dkg-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-agent')>();
  return {
    ...actual,
    DKGAgent: { create: mocks.agentCreate },
    loadOpWallets: mocks.loadOpWallets,
    // Keep the store the daemon hands the allocator reachable from the test.
    KaNumberAllocator: class KaNumberAllocator {
      constructor(readonly store: unknown) {}
    },
  };
});

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadNetworkConfig: mocks.loadNetworkConfig,
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
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    const daemonDb: Database.Database = createArg.chainEventCursorStore.cursors.db;
    try {
      // 1. The stores the daemon composes are the ones node-ui exports (the
      //    moved classes, re-exported), not a second copy.
      expect(createArg.messengerStores.idempotencyStore).toBeInstanceOf(SqliteMessageIdempotencyStore);
      expect(createArg.messengerStores.outboxStore).toBeInstanceOf(SqliteProtocolOutboxStore);
      expect(createArg.syncCheckpointStore).toBeInstanceOf(SqliteSyncCheckpointStore);
      expect(createArg.changelogCursorStore).toBeInstanceOf(SqliteChangelogCursorStore);
      expect(createArg.kaNumberAllocator.store).toBeInstanceOf(SqliteKaNumberStore);
      expect(createArg.chainEventCursorStore).toBeInstanceOf(SqliteChainEventCursorStore);
      expect(createArg.contextGraphRegistryScanCursorStore).toBeInstanceOf(SqliteContextGraphRegistryScanCursorStore);
      expect(createArg.contextGraphStorageDiscoveryStore).toBeInstanceOf(SqliteContextGraphStorageDiscoveryStore);
      expect(createArg.localContextGraphAuthorityHistoryStore).toBeInstanceOf(SqliteContextGraphAuthorityHistoryStore);
      expect(createArg.localContextGraphAuthorityIndexStore).toBeInstanceOf(SqliteContextGraphAuthorityIndexStore);
      expect(createArg.chainEventLogStore).toBeInstanceOf(SqliteChainEventLogStore);
      const eraGuard = createArg.storeConfig?.changelog?.eraGuard;
      expect(eraGuard).toBeInstanceOf(SqliteChangelogEraGuard);

      // 2. Each one reads what the legacy file holds.
      expect(createArg.messengerStores.idempotencyStore.check(PEER, PROTOCOL, 'legacy-in-1', 'in'))
        .toEqual({ seen: true, cachedResponse: new Uint8Array([1, 2, 3]) });
      const queued = createArg.messengerStores.outboxStore;
      expect(queued.size()).toBe(1);
      expect(queued.hasPendingFor(PEER)).toBe(true);
      expect(createArg.syncCheckpointStore.get(`${PEER}|legacy-cg|durable|data`)?.offset).toBe(4096);
      expect(createArg.changelogCursorStore.get(PEER, 'legacy-cg')).toMatchObject({ era: 'era-legacy', seq: 41 });
      await expect(eraGuard.load()).resolves.toEqual({ era: 'era-legacy', highSeq: 41 });
      // The next KA number for the author continues from the persisted counter.
      expect(createArg.kaNumberAllocator.store.peekNext(AUTHOR)).toBe(7n);
      expect(createArg.kaNumberAllocator.store.allocate(AUTHOR)).toBe(7n);
      await expect(createArg.chainEventCursorStore.loadLane('contextGraphDiscovery')).resolves.toBe(4321);
      await expect(createArg.contextGraphRegistryScanCursorStore.load({
        chainId: 'gnosis:100', deploymentId: DEPLOYMENT_ID, registryAddress: REGISTRY,
      })).resolves.toBe(5000);
      await expect(createArg.contextGraphStorageDiscoveryStore.load()).resolves.toEqual(DISCOVERY_CHECKPOINT);
      await expect(createArg.localContextGraphAuthorityHistoryStore.load('legacy-key'))
        .resolves.toEqual(AUTHORITY_CHECKPOINT);
      await expect(createArg.localContextGraphAuthorityIndexStore.load('legacy-index-scope'))
        .resolves.toEqual({ token: 3, value: { version: 1, cursor: { throughBlockNumber: 30 } } });
      const logState = await createArg.chainEventLogStore.load(CHAIN_LOG_SCOPE);
      expect(logState?.cursor).toMatchObject({ revision: 2, settledBlockNumber: 10, lineage: '0xlineage' });
      await expect(createArg.chainEventLogStore.readEvents(CHAIN_LOG_SCOPE, {
        fromBlockNumber: 0, throughBlockNumber: 20,
      })).resolves.toHaveLength(1);

      // 3. Boot itself rewrote nothing: the schema, the version and every row
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

      // 4. Same file: one SQLite database in the node's home, no protocol file.
      const sqliteFiles = (await readdir(tempHome)).filter((name) => /\.db(-wal|-shm)?$/.test(name));
      expect([...new Set(sqliteFiles.map((name) => name.replace(/-(wal|shm)$/, '')))]).toEqual(['node-ui.db']);
    } finally {
      daemonDb.close();
    }
  });
});
