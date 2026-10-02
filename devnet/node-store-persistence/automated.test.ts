/**
 * Protocol persistence stores (`@origintrail-official/dkg-node-store`) on a
 * live devnet.
 *
 * The daemon's durable protocol state (outbox, message idempotency, sync
 * checkpoints, changelog cursors, KA numbers, the chain-event log and chain
 * cursors) moved out of the dashboard package into `dkg-node-store` (Phase 1: a
 * package move, no behavior change). Phase 1 keeps that state in the same
 * `node-ui.db` that `DashboardDB` opens and migrates. This suite pins, on real
 * nodes that have been running the real daemon:
 *
 *   1. Same file, same schema: every node's `node-ui.db` is at the schema
 *      version `DashboardDB` ships, carries every protocol table and index the
 *      moved stores need, and there is no second protocol database next to it.
 *   2. The moved stores are live: the chain-event log that the chain adapter
 *      writes through `SqliteChainEventLogStore` is populated on every node
 *      (cores and edges index the chain).
 *   3. KA numbering is durable protocol state: publishing a Knowledge Asset
 *      allocates through `SqliteKaNumberStore` and the per-author counter in
 *      `node-ui.db` moves forward. The same publish proves the chain log keeps
 *      following the chain: on every node, the cursor of the node's OWN
 *      chain-log scope reaches the block of the publish transaction's receipt
 *      and `chain_events` holds that transaction's
 *      `KnowledgeAssetRegisteredToContextGraph` event (address, log index and
 *      topics as the receipt has them). A head that merely moved since before
 *      the Context Graph was registered proves nothing: the registration mines
 *      a block of its own. The decision is `chain-log-follows.ts`, unit-tested
 *      without a devnet in `chain-log-follows.test.ts` (same vitest config).
 *
 * Isolation: the database is only ever opened READ-ONLY (a live node owns it;
 * `DashboardDB`'s constructor migrates and prunes, so it must never be
 * constructed here). The only mutation is a publish into a Context Graph this
 * suite creates itself; it never touches the shared `devnet-test` graph.
 *
 * Preconditions:
 *   pnpm run build:packages && pnpm --dir packages/cli run build:prepared
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * Run:
 *   pnpm test:devnet:node-store-persistence
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ethers } from 'ethers';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  detectDevnet,
  ensureAllIdentities,
  runDkgCli,
  runKaPublishLifecycle,
  waitFor,
  type CliResult,
  type DevnetNode,
  type DevnetState,
  type PublishResult,
} from '../_bootstrap/harness.js';
import { SCHEMA_VERSION } from '../../packages/node-ui/src/db.js';
import {
  chainLogScope,
  judgeChainLogFollows,
  readChainLogSnapshot,
  type ChainLogVerdict,
  type ExpectedChainEvent,
} from './chain-log-follows.js';

const NODE_COUNT = 6;
const CORE_NODES = [1, 2, 3, 4];

/** Every table the moved stores read or write, with the columns they rely on. */
const PROTOCOL_TABLES: Record<string, string[]> = {
  message_idempotency: ['peer_id', 'protocol', 'message_id', 'direction', 'response_blob', 'response_size', 'ts'],
  protocol_outbox: [
    'peer_id', 'protocol', 'message_id', 'payload', 'attempts',
    'first_failure_at', 'last_attempt_at', 'next_attempt_at', 'last_error',
  ],
  sync_checkpoints: [
    'key', 'offset', 'updated_at', 'expires_at', 'responder_session_id', 'responder_session_expires_at',
    'responder_session_offset', 'manifest_digest', 'manifest_prefix_digest', 'terminal',
  ],
  changelog_cursors: ['peer_id', 'context_graph_id', 'era', 'seq', 'updated_at'],
  changelog_era: ['id', 'era', 'high_seq', 'updated_at'],
  ka_numbers: ['author_address', 'next_number'],
  runtime_cursors: ['namespace', 'scope', 'key', 'value', 'updated_at'],
  settings: ['key', 'value'],
  context_graph_authority_indexes: ['scope', 'revision', 'checkpoint_json', 'updated_at'],
  chain_index_cursor: [
    'scope', 'revision', 'lineage', 'deployment_block', 'settled_block', 'settled_hash', 'head_block',
    'head_hash', 'head_timestamp_seconds', 'head_fetched_at_ms', 'topic_set_version', 'suspected_fork_block',
    'updated_at',
  ],
  chain_events: [
    'scope', 'block_number', 'log_index', 'block_hash', 'tx_hash', 'address', 'topic0', 'topic1', 'topic2',
    'topic3', 'data', 'settled',
  ],
  chain_index_coverage: [
    'scope', 'family', 'address', 'covered_from_block', 'covered_through_block', 'floor_block', 'updated_at',
  ],
};

/** The indexes the stores pin or lean on. */
const PROTOCOL_INDEXES = [
  'idx_idem_ts',
  'idx_outbox_next_attempt',
  'idx_sync_checkpoints_expires_at',
  'idx_runtime_cursors_namespace_scope',
  'idx_chain_events_scope_address_topic',
  'idx_chain_events_scope_unsettled',
  'idx_chain_events_scope_address_ka',
];

let state: DevnetState;
let publisher: DevnetNode;
const openHandles: Database.Database[] = [];

const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

function dbPath(node: DevnetNode): string {
  return join(node.home, 'node-ui.db');
}

/** A read-only view of a live node's database. Never write, never migrate. */
function openReadOnly(node: DevnetNode): Database.Database {
  const handle = new Database(dbPath(node), { readonly: true, fileMustExist: true });
  openHandles.push(handle);
  return handle;
}

function tableColumns(handle: Database.Database, table: string): string[] {
  return (handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function count(handle: Database.Database, sql: string, ...params: unknown[]): number {
  return (handle.prepare(sql).get(...params) as { c: number }).c;
}

function expectCliOk(result: CliResult, label: string): void {
  expect(
    result.code,
    `${label} failed with exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

/**
 * `ContextGraphStorage.KnowledgeAssetRegisteredToContextGraph(uint256 indexed
 * contextGraphId, uint256 indexed kaId)`: the event behind `kaToContextGraph`,
 * emitted once per published Knowledge Asset, inside the publish transaction.
 */
const KA_REGISTERED_TOPIC0 = ethers.id('KnowledgeAssetRegisteredToContextGraph(uint256,uint256)');

/**
 * The scope a node's chain log (`chain_index_cursor`, `chain_events`) is keyed by,
 * from the chain id and Hub in the node's own `config.json`: the ones its daemon
 * indexes. `chainLogScope` rebuilds the adapter's key from them; if that ever
 * drifts, the verdict says `no-cursor` and lists the scopes the node really has.
 */
function nodeChainLogScope(node: DevnetNode): string {
  const config = JSON.parse(readFileSync(join(node.home, 'config.json'), 'utf8')) as {
    chain?: { chainId?: string; hubAddress?: string };
  };
  const hubAddress = config.chain?.hubAddress;
  expect(hubAddress, `node${node.num} config.json has no chain.hubAddress`).toBeTruthy();
  expect(hubAddress!.toLowerCase(), `node${node.num} indexes another Hub than the devnet deployed`)
    .toBe(state.addrs.Hub!.toLowerCase());
  return chainLogScope({ chainId: config.chain?.chainId ?? 'evm:31337', hubAddress: hubAddress! });
}

/**
 * The event the publish transaction emitted, taken from its receipt on the chain:
 * the transaction hash the CLI reported, its block, and its one
 * `KnowledgeAssetRegisteredToContextGraph` log for the published Knowledge Asset.
 */
async function publishRegistrationEvent(result: PublishResult): Promise<ExpectedChainEvent> {
  const txHash = result.txHash;
  expect(txHash, `publish surfaced no tx hash\n${result.raw}`).toMatch(/^0x[0-9a-fA-F]{64}$/);
  const receipt = await waitFor(
    `the receipt of publish transaction ${txHash}`,
    60_000,
    1_000,
    () => state.provider.getTransactionReceipt(txHash!),
  );
  expect(receipt.status, `publish transaction ${txHash} reverted`).toBe(1);

  // ContextGraphStorage is an asset storage of the Hub, not a Hub contract.
  const contextGraphStorage = (await state.hub.getAssetStorageAddress('ContextGraphStorage')) as string;
  const kaTopic = ethers.zeroPadValue(ethers.toBeHex(result.kaId!), 32).toLowerCase();
  const registrations = receipt.logs.filter((log) => log.address.toLowerCase() === contextGraphStorage.toLowerCase()
    && log.topics[0]?.toLowerCase() === KA_REGISTERED_TOPIC0
    && log.topics[2]?.toLowerCase() === kaTopic);
  expect(
    registrations.length,
    `publish transaction ${txHash} (block ${receipt.blockNumber}) did not emit exactly one `
      + `KnowledgeAssetRegisteredToContextGraph for KA ${result.kaId}: ${JSON.stringify(receipt.logs.map((log) => [log.address, log.topics[0]]))}`,
  ).toBe(1);
  const log = registrations[0]!;
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    logIndex: log.index,
    address: log.address,
    topics: [...log.topics],
  };
}

/**
 * Wait until EVERY node's chain log has followed the chain through `event`.
 *
 * Each node polls the same chain on its own (nothing is gossiped), so each one
 * must show the publish. The whole verdict is polled, not the cursor alone:
 * `head_block` is the head the tick observed, and a catch-up pass may fetch
 * fewer blocks than that, so a cursor at the publish block does not by itself
 * mean the event was read. A timeout names, per node, what was missing.
 */
async function expectChainLogsFollow(nodes: readonly DevnetNode[], event: ExpectedChainEvent): Promise<void> {
  const watched = nodes.map((node) => ({ node, handle: openReadOnly(node), scope: nodeChainLogScope(node) }));
  const verdicts = new Map<number, ChainLogVerdict>();
  try {
    await waitFor(
      `every node's chain log follows publish transaction ${event.transactionHash} (block ${event.blockNumber})`,
      180_000,
      3_000,
      async () => {
        for (const { node, handle, scope } of watched) {
          verdicts.set(node.num, judgeChainLogFollows(readChainLogSnapshot(handle, event.transactionHash), scope, event));
        }
        return [...verdicts.values()].every((verdict) => verdict.followed) ? verdicts : null;
      },
    );
  } catch (err) {
    const behind = [...verdicts].filter(([, verdict]) => !verdict.followed).map(([num, verdict]) => `node${num}: ${verdict.reason}`);
    throw new Error(`${(err as Error).message}\n${behind.join('\n') || 'no verdict was reached'}`);
  }
}

beforeAll(async () => {
  const detected = await detectDevnet(NODE_COUNT);
  if (!detected) {
    throw new Error('No devnet detected - run ./scripts/devnet.sh start 6 and pnpm run build:packages before this suite.');
  }
  await ensureAllIdentities(detected, CORE_NODES.length);
  state = detected;
  publisher = state.nodes[1]!;
}, 240_000);

afterAll(() => {
  for (const handle of openHandles.splice(0)) {
    if (handle.open) handle.close();
  }
});

describe('node-ui.db keeps the protocol schema on every live node (same file, same schema)', () => {
  for (let num = 1; num <= NODE_COUNT; num++) {
    it(`node${num} carries the shipped schema version and every protocol table and index`, () => {
      const node = state.nodes[num]!;
      const handle = openReadOnly(node);

      expect(handle.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

      for (const [table, columns] of Object.entries(PROTOCOL_TABLES)) {
        const actual = tableColumns(handle, table);
        expect(actual.length, `node${num}: table ${table} is missing`).toBeGreaterThan(0);
        expect(actual, `node${num}: ${table} lost a column the stores rely on`).toEqual(expect.arrayContaining(columns));
      }

      const indexes = new Set(
        (handle.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      for (const index of PROTOCOL_INDEXES) {
        expect(indexes.has(index), `node${num}: index ${index} is missing`).toBe(true);
      }
    });

    it(`node${num} keeps protocol state in node-ui.db and has no second protocol database`, () => {
      const node = state.nodes[num]!;
      expect(existsSync(dbPath(node))).toBe(true);
      // Phase 2 (a separate protocol DB file) is not implemented: nothing may
      // have appeared next to node-ui.db, live or leftover.
      const sqliteFiles = readdirSync(node.home)
        .filter((name) => /\.(db|sqlite|sqlite3)$/.test(name))
        .sort();
      expect(sqliteFiles, `node${num} home: ${sqliteFiles.join(', ')}`).not.toContain('node-protocol.db');
      expect(sqliteFiles).toContain('node-ui.db');
    });
  }
});

describe('the moved stores are live on every node that indexes the chain', () => {
  for (let num = 1; num <= NODE_COUNT; num++) {
    it(`node${num} has a populated chain-event log with a consistent cursor`, () => {
      const handle = openReadOnly(state.nodes[num]!);
      const cursors = handle.prepare(
        `SELECT scope, revision, head_block, settled_block, deployment_block FROM chain_index_cursor`,
      ).all() as Array<{ scope: string; revision: number; head_block: number; settled_block: number; deployment_block: number }>;
      expect(cursors.length, `node${num}: no chain_index_cursor row`).toBeGreaterThan(0);
      for (const cursor of cursors) {
        expect(cursor.revision).toBeGreaterThan(0);
        expect(cursor.head_block).toBeGreaterThanOrEqual(cursor.deployment_block);
        // Every cursor has coverage, and every stored event belongs to a cursor scope.
        expect(count(handle, `SELECT COUNT(*) AS c FROM chain_index_coverage WHERE scope = ?`, cursor.scope))
          .toBeGreaterThan(0);
      }
      const orphaned = count(
        handle,
        `SELECT COUNT(*) AS c FROM chain_events WHERE scope NOT IN (SELECT scope FROM chain_index_cursor)`,
      );
      expect(orphaned, `node${num}: chain events with no cursor`).toBe(0);
      expect(count(handle, `SELECT COUNT(*) AS c FROM chain_events`), `node${num}: empty chain_events`).toBeGreaterThan(0);
      // The other chain stores write through the same handle: the poller's lane
      // cursors (`SqliteChainEventCursorStore`) and the authority index
      // (`SqliteContextGraphAuthorityIndexStore`).
      expect(count(handle, `SELECT COUNT(*) AS c FROM runtime_cursors`), `node${num}: no runtime_cursors`).toBeGreaterThan(0);
      expect(
        count(handle, `SELECT COUNT(*) AS c FROM context_graph_authority_indexes`),
        `node${num}: no authority index checkpoint`,
      ).toBeGreaterThan(0);
    });
  }
});

describe('KA numbering is durable protocol state', () => {
  it('a publish allocates through the KA number store and every node\'s chain log indexes the publish transaction', async () => {
    const handle = openReadOnly(publisher);
    const kaTotal = () => count(handle, `SELECT COALESCE(SUM(next_number), 0) AS c FROM ka_numbers`);
    const kaBefore = kaTotal();

    // An ephemeral Context Graph of this suite's own.
    const slug = unique('node-store-persistence');
    const created = await runDkgCli(
      publisher,
      ['context-graph', 'create', slug, '--name', 'node-store persistence devnet',
        '--description', 'Ephemeral context graph for the node-store persistence devnet suite'],
      120_000,
    );
    expectCliOk(created, 'context-graph create');
    const contextGraphId = /^\s*ID:\s+(.+)$/m.exec(created.stdout)?.[1]?.trim();
    expect(contextGraphId, `could not parse context graph ID from:\n${created.stdout}`).toBeTruthy();
    expectCliOk(await runDkgCli(publisher, ['context-graph', 'register', contextGraphId!], 240_000), 'context-graph register');

    const dir = join(import.meta.dirname, 'turns');
    mkdirSync(dir, { recursive: true });
    const inputFile = join(dir, `${slug}.nt`);
    writeFileSync(inputFile, `<urn:test:node-store-persistence:${slug}> <https://schema.org/name> "durable ka number" .\n`, 'utf8');

    const result = await runKaPublishLifecycle((args) => runDkgCli(publisher, args, 240_000), {
      kaName: unique('nsp-ka'),
      contextGraphId: contextGraphId!,
      inputFile,
    });
    expect(['confirmed', 'finalized', 'tentative'], `publish status ${result.status}\n${result.raw}`).toContain(result.status);
    expect(result.kaId, `publish surfaced no KA id\n${result.raw}`).toBeGreaterThan(0n);

    // The counter moved forward and is stored in the dashboard file (same file).
    expect(kaTotal(), 'ka_numbers did not advance across a publish').toBeGreaterThan(kaBefore);

    // The chain-event log follows the chain THROUGH THE PUBLISH. Registering the
    // graph mined a block of its own, so a head that moved past a baseline read
    // before the registration proves nothing about the publish: identify the
    // publish transaction on the chain, then require, on every node, the cursor
    // of the node's own scope at that block and the transaction's event kept.
    const event = await publishRegistrationEvent(result);
    await expectChainLogsFollow(Object.values(state.nodes), event);
  }, 900_000);
});
