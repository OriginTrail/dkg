import type Database from 'better-sqlite3';
import type { DashboardDB } from './db.js';

/**
 * SQLite backing for the node's ONE chain log.
 *
 * Opaque, exactly like `SqliteContextGraphAuthorityIndexStore` beside it: this
 * file stores and returns rows and never decides what a topic means. The chain
 * package owns the model, the decoders and every security decision; SQLite owns
 * atomicity and the monotonic CAS token.
 *
 * The one invariant enforced HERE, because only a transaction can enforce it:
 * a tick's cursor advance, its tail replacement and its coverage extension are
 * one atomic act. A half-applied tick would leave coverage claiming a range
 * whose rows were rolled back, and a reader would then report an unindexed
 * Context Graph as absent.
 */

/** Mirrors the chain package's `ChainEventLogRow`; matched structurally. */
export interface SqliteChainEventLogRow {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly logIndex: number;
  readonly transactionHash: string;
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly settled: boolean;
}

export interface SqliteChainEventLogHead {
  readonly number: number;
  readonly hash: string;
  readonly timestampSeconds: number;
  readonly fetchedAtMs: number;
}

export interface SqliteChainEventLogCursor {
  readonly revision: number;
  readonly lineage: string;
  readonly deploymentBlockNumber: number;
  readonly settledBlockNumber: number;
  readonly settledBlockHash: string;
  readonly head: SqliteChainEventLogHead;
  readonly topicSetVersion: string;
}

export interface SqliteChainEventLogCoverage {
  readonly family: string;
  readonly address: string;
  readonly coveredFromBlock: number;
  readonly coveredThroughBlock: number;
  readonly floorBlock: number;
}

export interface SqliteChainEventLogState {
  readonly cursor: SqliteChainEventLogCursor;
  readonly coverage: readonly SqliteChainEventLogCoverage[];
  readonly suspectedForkBlockNumber?: number;
}

export interface SqliteChainEventLogCommit {
  readonly cursor: Omit<SqliteChainEventLogCursor, 'revision'>;
  readonly rows: readonly SqliteChainEventLogRow[];
  readonly coverage: readonly SqliteChainEventLogCoverage[];
  readonly suspectedForkBlockNumber?: number;
}

export interface SqliteChainEventLogQuery {
  readonly fromBlockNumber: number;
  readonly throughBlockNumber: number;
  readonly addresses?: readonly string[];
  readonly topic0?: readonly string[];
  readonly topic1?: readonly string[];
}

interface CursorRow {
  revision: number;
  lineage: string;
  deployment_block: number;
  settled_block: number;
  settled_hash: string;
  head_block: number;
  head_hash: string;
  head_timestamp_seconds: number;
  head_fetched_at_ms: number;
  topic_set_version: string;
  suspected_fork_block: number | null;
}

interface EventRow {
  block_number: number;
  log_index: number;
  block_hash: string;
  tx_hash: string;
  address: string;
  topic0: string;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  data: string;
  settled: number;
}

/**
 * A tombstoned scope keeps its row so its CAS token can never repeat.
 *
 * The empty lineage is the tombstone: `load` refuses to return such a scope, so
 * nothing derived from the dead chain can be served, while a fresh cold start
 * re-initializes the SAME row at a strictly higher revision. Deleting the row
 * instead would restart the token at 1 and let a scanner holding the old token
 * overwrite a rebuilt log (the ABA case the authority index already guards).
 */
const TOMBSTONE_LINEAGE = '';

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

export class SqliteChainEventLogStore {
  private readonly db: Database.Database;

  constructor(dashboard: DashboardDB) {
    this.db = dashboard.db;
  }

  async load(scope: string): Promise<SqliteChainEventLogState | undefined> {
    const row = this.db.prepare(`
      SELECT revision, lineage, deployment_block, settled_block, settled_hash,
             head_block, head_hash, head_timestamp_seconds, head_fetched_at_ms,
             topic_set_version, suspected_fork_block
        FROM chain_index_cursor
       WHERE scope = ?
    `).get(scope) as CursorRow | undefined;
    if (row === undefined || row.lineage === TOMBSTONE_LINEAGE) return undefined;
    const coverage = this.db.prepare(`
      SELECT family, address, covered_from_block, covered_through_block, floor_block
        FROM chain_index_coverage
       WHERE scope = ?
       ORDER BY family, address
    `).all(scope) as Array<{
      family: string;
      address: string;
      covered_from_block: number;
      covered_through_block: number;
      floor_block: number;
    }>;
    return Object.freeze({
      cursor: Object.freeze({
        revision: row.revision,
        lineage: row.lineage,
        deploymentBlockNumber: row.deployment_block,
        settledBlockNumber: row.settled_block,
        settledBlockHash: row.settled_hash,
        head: Object.freeze({
          number: row.head_block,
          hash: row.head_hash,
          timestampSeconds: row.head_timestamp_seconds,
          fetchedAtMs: row.head_fetched_at_ms,
        }),
        topicSetVersion: row.topic_set_version,
      }),
      coverage: Object.freeze(coverage.map((entry) => Object.freeze({
        family: entry.family,
        address: entry.address,
        coveredFromBlock: entry.covered_from_block,
        coveredThroughBlock: entry.covered_through_block,
        floorBlock: entry.floor_block,
      }))),
      ...(row.suspected_fork_block === null
        ? {}
        : { suspectedForkBlockNumber: row.suspected_fork_block }),
    });
  }

  async commit(
    scope: string,
    expectedRevision: number | undefined,
    commit: SqliteChainEventLogCommit,
  ): Promise<number | undefined> {
    if (scope.trim().length === 0) throw new Error('Chain event log scope is empty');
    if (commit.cursor.lineage === TOMBSTONE_LINEAGE) {
      throw new Error('Chain event log lineage is empty');
    }
    if (expectedRevision !== undefined
      && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new Error('Chain event log expected revision is invalid');
    }
    const apply = this.db.transaction((): number | undefined => {
      const revision = this.writeCursor(scope, expectedRevision, commit);
      if (revision === undefined) return undefined;
      // The whole previous tail goes first. An orphaned log then needs no undo
      // journal and no parent-hash walk: it is simply not in the new tail.
      this.db.prepare(`DELETE FROM chain_events WHERE scope = ? AND settled = 0`).run(scope);
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO chain_events (
          scope, block_number, log_index, block_hash, tx_hash, address,
          topic0, topic1, topic2, topic3, data, settled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of commit.rows) {
        // OR IGNORE, not OR REPLACE: a settled row is written ONCE. A second
        // write at the same (block, logIndex) would mean the settled prefix was
        // re-fetched, which only a reorg below the tail can cause — and that is
        // the tombstone's job, not a silent overwrite's.
        insert.run(
          scope,
          row.blockNumber,
          row.logIndex,
          row.blockHash,
          row.transactionHash,
          row.address,
          row.topics[0] ?? '',
          row.topics[1] ?? null,
          row.topics[2] ?? null,
          row.topics[3] ?? null,
          row.data,
          row.settled ? 1 : 0,
        );
      }
      const upsertCoverage = this.db.prepare(`
        INSERT INTO chain_index_coverage (
          scope, family, address, covered_from_block, covered_through_block,
          floor_block, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, family, address) DO UPDATE SET
          covered_from_block = excluded.covered_from_block,
          covered_through_block = excluded.covered_through_block,
          floor_block = excluded.floor_block,
          updated_at = excluded.updated_at
      `);
      for (const entry of commit.coverage) {
        upsertCoverage.run(
          scope,
          entry.family,
          entry.address,
          entry.coveredFromBlock,
          entry.coveredThroughBlock,
          entry.floorBlock,
          Date.now(),
        );
      }
      return revision;
    });
    return apply();
  }

  async tombstone(scope: string, expectedRevision: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('Chain event log expected revision is invalid');
    }
    const nextRevision = expectedRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new Error('Chain event log revision exceeds the safe integer range');
    }
    const apply = this.db.transaction((): number | undefined => {
      const invalidated = this.db.prepare(`
        UPDATE chain_index_cursor
           SET revision = ?, lineage = ?, settled_block = -1, settled_hash = '',
               suspected_fork_block = NULL, updated_at = ?
         WHERE scope = ? AND revision = ?
      `).run(nextRevision, TOMBSTONE_LINEAGE, Date.now(), scope, expectedRevision).changes === 1;
      if (!invalidated) return undefined;
      // Everything derived from the dead chain goes with the cursor. A single
      // surviving "permanent memo" is enough to answer an id-reuse question
      // from a chain that no longer exists.
      for (const table of [
        'chain_events',
        'chain_index_coverage',
        'hub_bindings',
        'cg_state',
        'cg_participants',
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE scope = ?`).run(scope);
      }
      return nextRevision;
    });
    return apply();
  }

  async readEvents(
    scope: string,
    query: SqliteChainEventLogQuery,
  ): Promise<readonly SqliteChainEventLogRow[]> {
    const clauses = ['scope = ?', 'block_number >= ?', 'block_number <= ?'];
    const parameters: unknown[] = [scope, query.fromBlockNumber, query.throughBlockNumber];
    for (const [column, values] of [
      ['address', query.addresses],
      ['topic0', query.topic0],
      ['topic1', query.topic1],
    ] as const) {
      if (values === undefined || values.length === 0) continue;
      clauses.push(`${column} IN (${placeholders(values.length)})`);
      parameters.push(...values);
    }
    const rows = this.db.prepare(`
      SELECT block_number, log_index, block_hash, tx_hash, address,
             topic0, topic1, topic2, topic3, data, settled
        FROM chain_events
       WHERE ${clauses.join(' AND ')}
       ORDER BY block_number, log_index
    `).all(...parameters) as EventRow[];
    return Object.freeze(rows.map((row) => Object.freeze({
      blockNumber: row.block_number,
      blockHash: row.block_hash,
      logIndex: row.log_index,
      transactionHash: row.tx_hash,
      address: row.address,
      // Absent topics are omitted rather than zero-filled: a decoder must see
      // the log's real arity, not a padded one.
      topics: Object.freeze(
        [row.topic0, row.topic1, row.topic2, row.topic3]
          .filter((topic): topic is string => typeof topic === 'string' && topic.length > 0),
      ),
      data: row.data,
      settled: row.settled === 1,
    })));
  }

  async blockHashAt(scope: string, blockNumber: number): Promise<string | undefined> {
    const cursor = this.db.prepare(`
      SELECT settled_block, settled_hash, head_block, head_hash
        FROM chain_index_cursor
       WHERE scope = ? AND lineage <> ?
    `).get(scope, TOMBSTONE_LINEAGE) as Pick<
      CursorRow, 'settled_block' | 'settled_hash' | 'head_block' | 'head_hash'
    > | undefined;
    if (cursor?.settled_block === blockNumber && cursor.settled_hash.length > 0) {
      return cursor.settled_hash;
    }
    if (cursor?.head_block === blockNumber) return cursor.head_hash;
    const row = this.db.prepare(`
      SELECT block_hash FROM chain_events
       WHERE scope = ? AND block_number = ?
       LIMIT 1
    `).get(scope, blockNumber) as { block_hash: string } | undefined;
    return row?.block_hash;
  }

  private writeCursor(
    scope: string,
    expectedRevision: number | undefined,
    commit: SqliteChainEventLogCommit,
  ): number | undefined {
    const cursor = commit.cursor;
    const suspected = commit.suspectedForkBlockNumber ?? null;
    const now = Date.now();
    if (expectedRevision === undefined) {
      const inserted = this.db.prepare(`
        INSERT INTO chain_index_cursor (
          scope, revision, lineage, deployment_block, settled_block, settled_hash,
          head_block, head_hash, head_timestamp_seconds, head_fetched_at_ms,
          topic_set_version, suspected_fork_block, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          revision = chain_index_cursor.revision + 1,
          lineage = excluded.lineage,
          deployment_block = excluded.deployment_block,
          settled_block = excluded.settled_block,
          settled_hash = excluded.settled_hash,
          head_block = excluded.head_block,
          head_hash = excluded.head_hash,
          head_timestamp_seconds = excluded.head_timestamp_seconds,
          head_fetched_at_ms = excluded.head_fetched_at_ms,
          topic_set_version = excluded.topic_set_version,
          suspected_fork_block = excluded.suspected_fork_block,
          updated_at = excluded.updated_at
        -- Re-initializing is allowed ONLY for a tombstoned scope. A live cursor
        -- must lose this CAS, so a caller that thinks the scope is cold cannot
        -- reset a cursor another pass is advancing.
        WHERE chain_index_cursor.lineage = ''
      `).run(
        scope, cursor.lineage, cursor.deploymentBlockNumber, cursor.settledBlockNumber,
        cursor.settledBlockHash, cursor.head.number, cursor.head.hash,
        cursor.head.timestampSeconds, cursor.head.fetchedAtMs, cursor.topicSetVersion,
        suspected, now,
      ).changes === 1;
      if (!inserted) return undefined;
      return (this.db.prepare(`SELECT revision FROM chain_index_cursor WHERE scope = ?`)
        .get(scope) as { revision: number }).revision;
    }
    const nextRevision = expectedRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new Error('Chain event log revision exceeds the safe integer range');
    }
    const updated = this.db.prepare(`
      UPDATE chain_index_cursor
         SET revision = ?, lineage = ?, deployment_block = ?, settled_block = ?,
             settled_hash = ?, head_block = ?, head_hash = ?,
             head_timestamp_seconds = ?, head_fetched_at_ms = ?,
             topic_set_version = ?, suspected_fork_block = ?, updated_at = ?
       WHERE scope = ? AND revision = ? AND lineage <> ''
    `).run(
      nextRevision, cursor.lineage, cursor.deploymentBlockNumber, cursor.settledBlockNumber,
      cursor.settledBlockHash, cursor.head.number, cursor.head.hash,
      cursor.head.timestampSeconds, cursor.head.fetchedAtMs, cursor.topicSetVersion,
      suspected, now, scope, expectedRevision,
    ).changes === 1;
    return updated ? nextRevision : undefined;
  }
}
