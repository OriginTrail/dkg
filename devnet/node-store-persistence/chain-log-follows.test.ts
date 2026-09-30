/**
 * The verdict the live suite uses to decide that a node's chain-event log has
 * followed the chain through a publish. No devnet: every case builds a scratch
 * `node-ui.db` through the real `DashboardDB` schema, writes it through the real
 * `SqliteChainEventLogStore.commit` (the writer the chain adapter uses), and
 * reads it back through the same read-only reader the suite uses.
 *
 * The timeline is the counterexample from the review of the first version of
 * this check: the head was 100 when the suite began, registering the Context
 * Graph mined block 101 and the publish mined block 102. That check compared
 * `MAX(head_block)` over the whole table with the 100, so a log that stopped at
 * the registration block (101 > 100), or a cursor of some other scope, passed.
 * Every such case is asserted here to be accepted by that old predicate on the
 * SAME rows and rejected by the verdict.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardDB } from '../../packages/node-ui/src/db.js';
import { SqliteChainEventLogStore, type SqliteChainEventLogRow } from '../../packages/node-store/src/index.js';
import {
  chainLogScope,
  judgeChainLogFollows,
  readChainLogSnapshot,
  type ChainLogEventRow,
  type ChainLogVerdict,
  type ExpectedChainEvent,
} from './chain-log-follows.js';

const HUB = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const OTHER_HUB = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const SCOPE = chainLogScope({ chainId: 'evm:31337', hubAddress: HUB });
const OTHER_SCOPE = chainLogScope({ chainId: 'evm:31337', hubAddress: OTHER_HUB });

const CG_STORAGE = `0x${'c9'.repeat(20)}`;
const OTHER_CONTRACT = `0x${'d1'.repeat(20)}`;
const CG_CREATED_TOPIC0 = `0x${'10'.repeat(32)}`;
const KA_REGISTERED_TOPIC0 = `0x${'20'.repeat(32)}`;
const CG_TOPIC = `0x${'00'.repeat(31)}07`;
const KA_TOPIC = `0x${'00'.repeat(31)}2a`;
const OTHER_KA_TOPIC = `0x${'00'.repeat(31)}2b`;
const REGISTRATION_TX = `0x${'aa'.repeat(32)}`;
const PUBLISH_TX = `0x${'ab'.repeat(32)}`;
const OTHER_TX = `0x${'ac'.repeat(32)}`;

const HEAD_BEFORE = 100;
const REGISTRATION_BLOCK = 101;
const PUBLISH_BLOCK = 102;
const PUBLISH_LOG_INDEX = 3;

const blockHash = (block: number): string => `0x${block.toString(16).padStart(2, '0').repeat(32)}`;

function logRow(overrides: Partial<SqliteChainEventLogRow> & Pick<SqliteChainEventLogRow, 'blockNumber' | 'transactionHash'>): SqliteChainEventLogRow {
  return {
    blockHash: blockHash(overrides.blockNumber),
    logIndex: 0,
    address: CG_STORAGE,
    topics: [CG_CREATED_TOPIC0, CG_TOPIC],
    data: '0x',
    settled: false,
    ...overrides,
  };
}

/** The event the graph registration emitted, one block before the publish. */
const registrationEvent = logRow({ blockNumber: REGISTRATION_BLOCK, transactionHash: REGISTRATION_TX });

/** The event the publish emitted: what the receipt of the publish carries. */
const publishEvent = logRow({
  blockNumber: PUBLISH_BLOCK,
  transactionHash: PUBLISH_TX,
  logIndex: PUBLISH_LOG_INDEX,
  topics: [KA_REGISTERED_TOPIC0, CG_TOPIC, KA_TOPIC],
});

const expected: ExpectedChainEvent = {
  // Mixed case on purpose: the node stores lower case, an RPC may not.
  transactionHash: PUBLISH_TX.toUpperCase().replace('0X', '0x'),
  blockNumber: PUBLISH_BLOCK,
  logIndex: PUBLISH_LOG_INDEX,
  address: CG_STORAGE.toUpperCase().replace('0X', '0x'),
  topics: [KA_REGISTERED_TOPIC0, CG_TOPIC, KA_TOPIC],
};

interface ScopeLog {
  readonly scope: string;
  /** The head the cursor records. */
  readonly head: number;
  /** The rows the log holds; every one is a tail row inside [1, head]. */
  readonly rows: readonly SqliteChainEventLogRow[];
}

/** The check this module replaces: the head, over every scope, passed a baseline read before the graph was registered. */
function legacyHeadAdvanced(handle: Database.Database, headBefore: number): boolean {
  const row = handle.prepare(`SELECT COALESCE(MAX(head_block), 0) AS c FROM chain_index_cursor`).get() as { c: number };
  return row.c > headBefore;
}

describe('chainLogScope', () => {
  it('is the adapter\'s durable chain-log key: the deployment id, then the Hub address again, lower-cased', () => {
    const hub = HUB.toLowerCase();
    expect(SCOPE).toBe(`evm:31337:hub=${hub}:${hub}`);
    expect(OTHER_SCOPE).not.toBe(SCOPE);
  });
});

describe('judgeChainLogFollows', () => {
  const directories: string[] = [];
  const dashboards: DashboardDB[] = [];
  const handles: Database.Database[] = [];

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.close();
    for (const dashboard of dashboards.splice(0)) dashboard.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /**
   * A scratch node-ui.db holding the given logs, written the way the tick writes
   * them, and a read-only handle on it: the way the live suite opens a node's.
   */
  async function nodeWith(logs: readonly ScopeLog[]): Promise<{ handle: Database.Database; store: SqliteChainEventLogStore }> {
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-chain-log-follows-'));
    directories.push(dataDir);
    const dashboard = new DashboardDB({ dataDir });
    dashboards.push(dashboard);
    const store = new SqliteChainEventLogStore(dashboard);
    for (const log of logs) {
      const revision = await store.commit(log.scope, undefined, {
        cursor: {
          lineage: blockHash(0),
          deploymentBlockNumber: 1,
          settledBlockNumber: 0,
          settledBlockHash: blockHash(0),
          head: { number: log.head, hash: blockHash(log.head), timestampSeconds: 1_700_000_000, fetchedAtMs: 1_700_000_000_000 },
          topicSetVersion: 'v1',
        },
        rows: log.rows,
        replacedRange: { fromBlockNumber: 1, throughBlockNumber: log.head },
        coverage: [{
          family: 'context-graph-ka',
          address: CG_STORAGE,
          coveredFromBlock: 1,
          coveredThroughBlock: log.head,
          floorBlock: 1,
        }],
      });
      expect(revision, `seeding ${log.scope}`).toBe(1);
    }
    const handle = new Database(join(dataDir, 'node-ui.db'), { readonly: true, fileMustExist: true });
    handles.push(handle);
    return { handle, store };
  }

  /** The old predicate accepts the rows: what the review found, asserted on the same rows the verdict rejects. */
  const expectOldCheckAccepts = (handle: Database.Database): void => {
    expect(legacyHeadAdvanced(handle, HEAD_BEFORE), 'the old predicate accepts these rows').toBe(true);
  };

  const verdictOf = (handle: Database.Database, scope = SCOPE, event = expected): ChainLogVerdict =>
    judgeChainLogFollows(readChainLogSnapshot(handle, event.transactionHash), scope, event);

  it('does not follow when the cursor stopped at the registration block, before the publish block (the old check passes here)', async () => {
    const { handle } = await nodeWith([{ scope: SCOPE, head: REGISTRATION_BLOCK, rows: [registrationEvent] }]);

    expectOldCheckAccepts(handle);

    const verdict = verdictOf(handle);
    expect(verdict.followed).toBe(false);
    expect(verdict.kind).toBe('cursor-behind');
    expect(verdict.reason).toContain(`head_block ${REGISTRATION_BLOCK}`);
    expect(verdict.reason).toContain(`block ${PUBLISH_BLOCK}`);
  });

  it.each([PUBLISH_BLOCK, PUBLISH_BLOCK + 1])(
    'fails with a reason when the cursor is at %i but the publish event was never kept',
    async (head) => {
      const { handle } = await nodeWith([{ scope: SCOPE, head, rows: [registrationEvent] }]);

      expectOldCheckAccepts(handle);

      const verdict = verdictOf(handle);
      expect(verdict.followed).toBe(false);
      expect(verdict.kind).toBe('event-missing');
      expect(verdict.reason).toContain(`head_block ${head}`);
      expect(verdict.reason).toContain(expected.transactionHash);
      expect(verdict.reason).toContain('rows of that transaction in this scope: none');
    },
  );

  it.each([PUBLISH_BLOCK, PUBLISH_BLOCK + 1])(
    'follows when the cursor is at %i and the publish event is in the log (transaction hash and address compared case-insensitively)',
    async (head) => {
      const { handle } = await nodeWith([{ scope: SCOPE, head, rows: [registrationEvent, publishEvent] }]);

      const verdict = verdictOf(handle);
      expect(verdict.followed, verdict.reason).toBe(true);
      expect(verdict.kind).toBe('followed');
      expect(verdict.reason).toContain(`log ${PUBLISH_LOG_INDEX}`);
    },
  );

  it('does not let a cursor of another scope satisfy the wait', async () => {
    // This node's own log stopped at the registration block. A second scope (for
    // example a node home that outlived a Hub redeploy) is far ahead and holds the
    // very same publish event.
    const { handle } = await nodeWith([
      { scope: SCOPE, head: REGISTRATION_BLOCK, rows: [registrationEvent] },
      { scope: OTHER_SCOPE, head: 200, rows: [publishEvent] },
    ]);

    expectOldCheckAccepts(handle);

    const verdict = verdictOf(handle);
    expect(verdict.followed).toBe(false);
    expect(verdict.kind).toBe('cursor-behind');
    expect(verdict.reason).toContain(`scope ${SCOPE}`);
    expect(verdict.reason).toContain(`head_block ${REGISTRATION_BLOCK}`);
  });

  it('does not let an event of another scope satisfy the check once the own cursor has caught up', async () => {
    const { handle } = await nodeWith([
      { scope: SCOPE, head: PUBLISH_BLOCK, rows: [registrationEvent] },
      { scope: OTHER_SCOPE, head: PUBLISH_BLOCK, rows: [publishEvent] },
    ]);

    expectOldCheckAccepts(handle);
    const verdict = verdictOf(handle);
    expect(verdict.followed).toBe(false);
    expect(verdict.kind).toBe('event-missing');
    expect(verdict.reason).toContain('in other scopes: 1');
  });

  it('fails with no-cursor, listing the scopes that exist, when the active scope has no cursor row at all', async () => {
    // A wrong scope formula must fail immediately and say what the node has.
    const { handle } = await nodeWith([{ scope: OTHER_SCOPE, head: 200, rows: [publishEvent] }]);

    expectOldCheckAccepts(handle);

    const verdict = verdictOf(handle);
    expect(verdict.followed).toBe(false);
    expect(verdict.kind).toBe('no-cursor');
    expect(verdict.reason).toContain(`scope ${SCOPE}`);
    expect(verdict.reason).toContain(`${OTHER_SCOPE}@200`);
  });

  it('does not accept a tombstoned cursor of the active scope', async () => {
    const { handle, store } = await nodeWith([{ scope: SCOPE, head: PUBLISH_BLOCK, rows: [publishEvent] }]);
    // The chain identity check found a different chain under this node home: the
    // scope keeps its row (its CAS token must never repeat) but loses its lineage.
    expect(await store.tombstone(SCOPE, 1)).toBe(2);

    expectOldCheckAccepts(handle);
    const verdict = verdictOf(handle);
    expect(verdict.followed).toBe(false);
    expect(verdict.kind).toBe('no-cursor');
    expect(verdict.reason).toContain(`${SCOPE}@${PUBLISH_BLOCK} (tombstoned)`);
  });

  it('does not let an event of another transaction satisfy the check', async () => {
    // Same block, same contract, same log position and topics: only the
    // transaction differs.
    const { handle } = await nodeWith([{
      scope: SCOPE,
      head: PUBLISH_BLOCK,
      rows: [registrationEvent, { ...publishEvent, transactionHash: OTHER_TX }],
    }]);

    expectOldCheckAccepts(handle);
    const verdict = verdictOf(handle);
    expect(verdict.followed).toBe(false);
    expect(verdict.kind).toBe('event-missing');
    expect(verdict.reason).toContain('rows of that transaction in this scope: none');
  });

  it.each<[string, Partial<SqliteChainEventLogRow>]>([
    ['another log index', { logIndex: PUBLISH_LOG_INDEX + 1 }],
    ['another emitting contract', { address: OTHER_CONTRACT }],
    ['another event signature', { topics: [CG_CREATED_TOPIC0, CG_TOPIC, KA_TOPIC] }],
    ['another Knowledge Asset id', { topics: [KA_REGISTERED_TOPIC0, CG_TOPIC, OTHER_KA_TOPIC] }],
    ['a missing Knowledge Asset id topic', { topics: [KA_REGISTERED_TOPIC0, CG_TOPIC] }],
  ])('does not accept an event of the right transaction with %s', async (_label, differs) => {
    const { handle } = await nodeWith([{
      scope: SCOPE,
      head: PUBLISH_BLOCK,
      rows: [registrationEvent, { ...publishEvent, ...differs }],
    }]);

    expectOldCheckAccepts(handle);
    const verdict = verdictOf(handle);
    expect(verdict.followed).toBe(false);
    expect(verdict.kind).toBe('event-missing');
    // It says what the log does hold for the transaction.
    expect(verdict.reason).not.toContain('rows of that transaction in this scope: none');
  });

  it('does not accept the transaction\'s event recorded at another block', async () => {
    const { handle } = await nodeWith([{
      scope: SCOPE,
      head: PUBLISH_BLOCK,
      // Same transaction, contract, log index and topics: only the block differs.
      rows: [registrationEvent, { ...publishEvent, blockNumber: REGISTRATION_BLOCK, blockHash: blockHash(REGISTRATION_BLOCK) }],
    }]);

    expectOldCheckAccepts(handle);
    const verdict = verdictOf(handle);
    expect(verdict.followed).toBe(false);
    expect(verdict.kind).toBe('event-missing');
  });

  it('reads every cursor row and only the rows of the transaction, in every scope', async () => {
    const { handle } = await nodeWith([
      { scope: SCOPE, head: PUBLISH_BLOCK, rows: [registrationEvent, publishEvent, { ...publishEvent, transactionHash: OTHER_TX, logIndex: 4 }] },
      { scope: OTHER_SCOPE, head: 200, rows: [publishEvent] },
    ]);

    const snapshot = readChainLogSnapshot(handle, expected.transactionHash);
    expect(snapshot.cursors.map((row) => [row.scope, row.head_block])).toEqual(
      [[SCOPE, PUBLISH_BLOCK], [OTHER_SCOPE, 200]].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
    expect(snapshot.events.map((row) => [row.scope, row.tx_hash, row.log_index])).toEqual(
      [[SCOPE, PUBLISH_TX, PUBLISH_LOG_INDEX], [OTHER_SCOPE, PUBLISH_TX, PUBLISH_LOG_INDEX]]
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  });

  it('judges plain rows on their own: rows of another transaction or scope never satisfy it', () => {
    const row = (overrides: Partial<ChainLogEventRow>): ChainLogEventRow => ({
      scope: SCOPE,
      block_number: PUBLISH_BLOCK,
      log_index: PUBLISH_LOG_INDEX,
      tx_hash: PUBLISH_TX,
      address: CG_STORAGE,
      topic0: KA_REGISTERED_TOPIC0,
      topic1: CG_TOPIC,
      topic2: KA_TOPIC,
      topic3: null,
      ...overrides,
    });
    const cursors = [{ scope: SCOPE, lineage: blockHash(0), head_block: PUBLISH_BLOCK }];

    expect(judgeChainLogFollows({ cursors, events: [row({})] }, SCOPE, expected).followed).toBe(true);
    // A snapshot handed over with rows it should not hold is still judged on the rows' own fields.
    expect(judgeChainLogFollows({ cursors, events: [row({ tx_hash: OTHER_TX })] }, SCOPE, expected).kind).toBe('event-missing');
    expect(judgeChainLogFollows({ cursors, events: [row({ scope: OTHER_SCOPE })] }, SCOPE, expected).kind).toBe('event-missing');
    expect(judgeChainLogFollows({ cursors: [], events: [row({})] }, SCOPE, expected).kind).toBe('no-cursor');
  });
});
