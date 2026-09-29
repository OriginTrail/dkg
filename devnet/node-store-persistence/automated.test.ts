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
 *      writes through `SqliteChainEventLogStore` is populated on the nodes
 *      that index the chain, and its cursor keeps advancing as the chain does.
 *   3. KA numbering is durable protocol state: publishing a Knowledge Asset
 *      allocates through `SqliteKaNumberStore` and the per-author counter in
 *      `node-ui.db` moves forward.
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
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
} from '../_bootstrap/harness.js';
import { SCHEMA_VERSION } from '../../packages/node-ui/src/db.js';

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

describe('the moved stores are live on nodes that index the chain', () => {
  for (const num of CORE_NODES) {
    it(`core node${num} has a populated chain-event log with a cursor at the chain head`, () => {
      const handle = openReadOnly(state.nodes[num]!);
      const cursors = handle.prepare(
        `SELECT scope, revision, head_block, settled_block, deployment_block FROM chain_index_cursor`,
      ).all() as Array<{ scope: string; revision: number; head_block: number; settled_block: number; deployment_block: number }>;
      expect(cursors.length, `core node${num}: no chain_index_cursor row`).toBeGreaterThan(0);
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
      expect(orphaned, `core node${num}: chain events with no cursor`).toBe(0);
    });
  }
});

describe('KA numbering is durable protocol state', () => {
  it('a publish allocates through the KA number store and the chain log cursor keeps up with the chain', async () => {
    const handle = openReadOnly(publisher);
    const kaTotal = () => count(handle, `SELECT COALESCE(SUM(next_number), 0) AS c FROM ka_numbers`);
    const headBlock = () => (handle.prepare(
      `SELECT COALESCE(MAX(head_block), 0) AS c FROM chain_index_cursor`,
    ).get() as { c: number }).c;
    const kaBefore = kaTotal();
    const headBefore = headBlock();

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

    // The chain-event log follows the chain: registering and publishing mined
    // blocks, and the poller's next tick lands them in the cursor.
    const head = await waitFor(
      'chain_index_cursor.head_block advances past the pre-publish head',
      180_000,
      3_000,
      async () => {
        const current = headBlock();
        return current > headBefore ? current : null;
      },
    );
    expect(head).toBeGreaterThan(headBefore);
  }, 900_000);
});
