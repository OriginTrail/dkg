import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { DkgConfig } from '../src/config.js';
import type { CorePrereqResult } from '../src/daemon/core-prereq-check.js';
import type { ProtocolStoreOptions, ProtocolStores } from '../src/daemon/protocol-persistence.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

/**
 * The daemon builds ONE `DashboardDB` at its composition root, composes every
 * protocol persistence store (the ones that moved to
 * `@origintrail-official/dkg-node-store`) over it through `createProtocolStores`,
 * and closes it exactly once on each of the three paths that close it: the
 * shutdown teardown and the two core-relay-prerequisite fatal exits. (A boot that
 * fails elsewhere, for example `DKGAgent.create` rejecting, closes nothing here
 * and is not covered.) This boots the REAL `runDaemonInner` against a
 * `node-ui.db` whose protocol tables were filled with raw SQL (no store code
 * involved) and asserts, for the normal boot and shutdown:
 *
 *  - the daemon constructs exactly one `DashboardDB` (the real class, observed
 *    through a counting subclass), and `createProtocolStores` receives that one;
 *  - the agent is handed exactly the stores that composition returned, and they
 *    read the seeded rows back;
 *  - boot leaves the file, its schema and every seeded row untouched, and creates
 *    no second SQLite file;
 *  - shutdown closes that one database exactly once, after the agent has
 *    stopped, and the connection is really ended.
 *
 * The two core-relay-prerequisite fatal exits also close the database, each
 * once: the pre-start one before any store is composed, the post-start one after
 * the agent stopped. Both are reached with a FORCED prerequisite verdict
 * (`checkCoreRelayPrereqs` is replaced, and the post-start one also relies on
 * the fake agent's fake transport listeners), because the real verdict depends
 * on the host's network interfaces; `core-prereq-check.test.ts` covers the real
 * checker. `process.exit` is stubbed, so what is pinned is the close, not the exit.
 *
 * The composition is observed through its typed results (`createProtocolStores`
 * is wrapped to record what it returns), never through a store's private fields.
 * Only the agent, the HTTP server and a few unrelated collaborators are replaced;
 * the DashboardDB, the schema and every store are real. `createProtocolStores`
 * itself is tested in `protocol-persistence.test.ts`.
 */
const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
  createServer: vi.fn(),
  checkCoreRelayPrereqs: vi.fn(),
  realCheckCoreRelayPrereqs: undefined as undefined | typeof import('../src/daemon/core-prereq-check.js').checkCoreRelayPrereqs,
  /** Every DashboardDB constructed or closed while a test runs (this test's seeding included). */
  dashboardDbs: {
    constructed: [] as DashboardDB[],
    closed: [] as DashboardDB[],
  },
  /** The order of the calls whose sequence a shutdown path must keep. */
  events: [] as string[],
  composition: { composed: 0 } as {
    storesDatabase?: unknown;
    storesOptions?: ProtocolStoreOptions;
    stores?: ProtocolStores;
    composed: number;
  },
}));

// Counts every DashboardDB constructed and closed (the real class, only
// observed). lifecycle.ts imports it from this package, so this sees the daemon's.
vi.mock('@origintrail-official/dkg-node-ui', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-node-ui')>();
  class CountingDashboardDB extends actual.DashboardDB {
    constructor(...args: ConstructorParameters<typeof actual.DashboardDB>) {
      super(...args);
      mocks.dashboardDbs.constructed.push(this);
    }

    override close(): void {
      mocks.dashboardDbs.closed.push(this);
      mocks.events.push('dashboard.close');
      super.close();
    }
  }
  return { ...actual, DashboardDB: CountingDashboardDB };
});

vi.mock('node:http', () => ({ createServer: mocks.createServer }));

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

vi.mock('../src/vector-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/vector-store.js')>();
  // No vector routes are exercised. Avoid an unrelated SQLite file in the home.
  return { ...actual, VectorStore: class VectorStore {} };
});

vi.mock('../src/daemon/core-prereq-check.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/core-prereq-check.js')>();
  mocks.realCheckCoreRelayPrereqs = actual.checkCoreRelayPrereqs;
  return { ...actual, checkCoreRelayPrereqs: mocks.checkCoreRelayPrereqs };
});

vi.mock('../src/daemon/protocol-persistence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/protocol-persistence.js')>();
  return {
    ...actual,
    // The real function, recording what it is given and what it hands back.
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

function createFakeServer() {
  const server = {
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return server;
    }),
    address: vi.fn(() => ({ port: 43123 })),
    close: vi.fn((callback?: () => void) => {
      callback?.();
      return server;
    }),
    on: vi.fn(() => server),
    once: vi.fn(() => server),
  };
  return server;
}

/** The slice of a DKGAgent the daemon's boot and shutdown touch. */
function createFakeAgent(boundListenAddresses: string[] = []) {
  const store = { close: vi.fn(async () => undefined) };
  return {
    peerId: 'self-peer',
    multiaddrs: [],
    wallet: { keypair: { publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) } },
    store,
    node: {
      libp2p: {
        getMultiaddrs: vi.fn(() => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        components: {
          transportManager: {
            getListeners: () => boundListenAddresses.map((addr) => ({ getAddrs: () => [addr] })),
          },
        },
      },
    },
    eventBus: { on: vi.fn() },
    assertion: { create: vi.fn(), write: vi.fn() },
    setChatAcl: vi.fn(),
    setSkillAcl: vi.fn(),
    onChat: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => {
      mocks.events.push('agent.stop');
      await store.close();
    }),
    ensureProfilePublished: vi.fn(async () => undefined),
    publishRelayRegistry: vi.fn(async () => undefined),
    ensureContextGraphLocal: vi.fn(async () => undefined),
    getSubscribedContextGraphs: vi.fn(() => new Map()),
    subscribeToContextGraph: vi.fn(),
    pingPeers: vi.fn(async () => undefined),
    listLocalAgents: vi.fn(() => []),
    registerImportedArtifactByteStore: vi.fn(),
    getDefaultAgentAddress: vi.fn(() => undefined),
    query: vi.fn(async () => ({ type: 'bindings', bindings: [] })),
    createContextGraph: vi.fn(),
    listContextGraphs: vi.fn(async () => []),
    createACKTransportFactory: vi.fn(() => ({})),
    drainRpcUsage: vi.fn(() => ({ calls: 0, errors: 0, throttledMs: 0, byEndpoint: {} })),
  };
}

const BASE_CONFIG = {
  name: 'protocol-store-wiring-test',
  networkConfig: 'mainnet-gnosis',
  listenPort: 0,
  apiPort: 0,
  nodeRole: 'edge',
  store: { backend: 'oxigraph-worker', changelog: true },
  auth: { enabled: false },
  promoteQueue: { enabled: false },
  telemetry: { enabled: false, metrics: { collectionEnabled: false } },
  autoUpdate: { enabled: false, source: 'monorepo' },
  publisher: { enabled: false },
  chain: {
    type: 'evm',
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: HUB,
    chainId: 'gnosis:100',
  },
} satisfies DkgConfig;

/** A degraded / not-degraded verdict for the core-relay prerequisite check. */
function relayVerdict(looksDegraded: boolean): CorePrereqResult {
  return {
    publicListenAddresses: looksDegraded ? [] : ['/ip4/203.0.113.7/tcp/9090'],
    nonRoutableAddresses: looksDegraded ? [{ addr: '/ip4/10.0.0.5/tcp/9090', class: 'rfc1918' }] : [],
    looksDegraded,
    indeterminate: false,
    reasons: looksDegraded ? ['forced by the test: no public listen address'] : [],
  };
}

describe('daemon composition of the protocol persistence stores', () => {
  const signals = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
  const processEvents: NodeJS.EventEmitter = process;
  const originalListeners = new Map<string, ReturnType<typeof processEvents.listeners>>();
  let tempHome: string;
  let shutdownHandler: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.dashboardDbs.constructed.length = 0;
    mocks.dashboardDbs.closed.length = 0;
    mocks.events.length = 0;
    mocks.composition.stores = undefined;
    mocks.composition.storesDatabase = undefined;
    mocks.composition.storesOptions = undefined;
    mocks.composition.composed = 0;
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-protocol-store-wiring-'));
    vi.stubEnv('DKG_HOME', tempHome);
    for (const event of signals) originalListeners.set(event, processEvents.listeners(event));
    // The daemon's deferred start-up work and intervals never run: only boot and shutdown do.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    mocks.createServer.mockImplementation(createFakeServer);
    mocks.checkCoreRelayPrereqs.mockReset();
    if (mocks.realCheckCoreRelayPrereqs) mocks.checkCoreRelayPrereqs.mockImplementation(mocks.realCheckCoreRelayPrereqs);
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: [],
      defaultNodeRole: 'edge',
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    // A failed assertion must not leave a daemon connection or handler behind.
    for (const dashboard of mocks.dashboardDbs.constructed) dashboard.db.close();
    for (const event of signals) {
      for (const listener of processEvents.listeners(event)) {
        if (!originalListeners.get(event)?.includes(listener)) processEvents.removeListener(event, listener as () => void);
      }
    }
    shutdownHandler = undefined;
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(tempHome, { recursive: true, force: true });
  });

  /** A node that last ran before this boot: schema at the current version, protocol rows written by raw SQL. */
  function seedLegacyHome() {
    const legacy = new DashboardDB({ dataDir: tempHome });
    seedLegacyProtocolRows(legacy.db);
    const rowsBefore = fingerprintRows(legacy.db);
    const schemaBefore = fingerprintSchema(legacy.db);
    const versionBefore = legacy.db.pragma('user_version', { simple: true });
    legacy.close();
    expect(versionBefore).toBe(SCHEMA_VERSION);
    expect(Object.values(rowsBefore).every((rows) => rows.length > 0), 'every protocol table is seeded').toBe(true);
    // Only what the daemon does from here on is counted.
    mocks.dashboardDbs.constructed.length = 0;
    mocks.dashboardDbs.closed.length = 0;
    mocks.events.length = 0;
    return { rowsBefore, schemaBefore, versionBefore };
  }

  async function boot(config: DkgConfig): Promise<void> {
    await runDaemonInner(true, config, Date.now(), resolveShutdownPolicy(undefined));
  }

  /** The SIGTERM handler `runDaemonInner` installed, invoked directly so its promise can be awaited. */
  function installedShutdown(): () => Promise<void> {
    const installed = processEvents.listeners('SIGTERM').filter(
      (listener) => !originalListeners.get('SIGTERM')?.includes(listener),
    );
    expect(installed).toHaveLength(1);
    shutdownHandler = installed[0] as unknown as () => Promise<void>;
    return shutdownHandler;
  }

  it('boots against a legacy node-ui.db on ONE DashboardDB, hands the agent its stores, and closes it once at shutdown', async () => {
    const { rowsBefore, schemaBefore, versionBefore } = seedLegacyHome();
    const agent = createFakeAgent();
    mocks.agentCreate.mockResolvedValue(agent);

    await boot(BASE_CONFIG);

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as DKGAgentConfig;
    const { stores } = mocks.composition;
    if (!stores) throw new Error('the daemon did not compose its protocol stores through protocol-persistence');
    // 0. The daemon constructed exactly one DashboardDB, and composed its stores once.
    const { constructed, closed } = mocks.dashboardDbs;
    expect(constructed).toHaveLength(1);
    const daemonDashboard = constructed[0];
    expect(daemonDashboard).toBeInstanceOf(DashboardDB);
    expect(mocks.composition.composed).toBe(1);
    const daemonDb: Database.Database = daemonDashboard.db;
    expect(daemonDb.open).toBe(true);
    expect(closed, 'still in use while the daemon runs').toHaveLength(0);

    // 1. The stores were built over that very DashboardDB (one connection), for
    //    this chain deployment, with the changelog on.
    expect(mocks.composition.storesDatabase).toBe(daemonDashboard);
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

    // 6. Shutdown closes that one database exactly once, after the agent
    //    stopped, and the connection really ends: the stores can no longer use it.
    await installedShutdown()();
    expect(mocks.dashboardDbs.constructed, 'shutdown opens no other database').toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toBe(daemonDashboard);
    expect(mocks.events).toEqual(['agent.stop', 'dashboard.close']);
    expect(daemonDb.open).toBe(false);
    expect(() => stores.syncCheckpointStore.get(`${PEER}|legacy-cg|durable|data`)).toThrow(/not open/i);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  describe('the core-relay prerequisite fatal exits', () => {
    const CORE_STRICT = {
      ...BASE_CONFIG,
      nodeRole: 'core',
      core: { allowDegradedRelay: false },
    } satisfies DkgConfig;

    it('before the agent starts: closes the one DashboardDB once, and has composed no store yet', async () => {
      seedLegacyHome();
      mocks.checkCoreRelayPrereqs.mockReturnValue(relayVerdict(true));

      await boot(CORE_STRICT);

      expect(mocks.checkCoreRelayPrereqs).toHaveBeenCalledTimes(1);
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
      const { constructed, closed } = mocks.dashboardDbs;
      expect(constructed).toHaveLength(1);
      expect(closed).toHaveLength(1);
      expect(closed[0]).toBe(constructed[0]);
      expect(constructed[0].db.open).toBe(false);
      // The stores are composed after this check, so a refused boot never built any.
      expect(mocks.composition.composed).toBe(0);
      expect(mocks.agentCreate).not.toHaveBeenCalled();
      expect(mocks.events).toEqual(['dashboard.close']);
    });

    it('after the agent started: stops the agent, then closes the one DashboardDB once', async () => {
      seedLegacyHome();
      const agent = createFakeAgent(['/ip4/10.0.0.5/tcp/9090']);
      mocks.agentCreate.mockResolvedValue(agent);
      mocks.checkCoreRelayPrereqs
        .mockReturnValueOnce(relayVerdict(false))
        .mockReturnValueOnce(relayVerdict(true));

      await boot(CORE_STRICT);

      expect(mocks.checkCoreRelayPrereqs).toHaveBeenCalledTimes(2);
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
      const { constructed, closed } = mocks.dashboardDbs;
      expect(constructed).toHaveLength(1);
      expect(mocks.composition.composed).toBe(1);
      expect(mocks.composition.storesDatabase).toBe(constructed[0]);
      expect(agent.stop).toHaveBeenCalledTimes(1);
      expect(closed).toHaveLength(1);
      expect(closed[0]).toBe(constructed[0]);
      expect(constructed[0].db.open).toBe(false);
      expect(mocks.events).toEqual(['agent.stop', 'dashboard.close']);
    });
  });
});
