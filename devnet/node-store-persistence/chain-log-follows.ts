/**
 * Has a node's durable chain-event log followed the chain up to one specific
 * transaction?
 *
 * The devnet suite proves "the moved chain-log store keeps following the chain"
 * with a real publish. What that check may accept is the whole point of this
 * module, so the decision is a pure function of plain rows (no devnet, no
 * SQLite handle) that a unit test can drive with every wrong answer:
 *
 *   - It reads the cursor of the ACTIVE scope only. `chain_index_cursor` holds
 *     one row per chain-log scope, so `MAX(head_block)` over the table is not a
 *     statement about this node's deployment.
 *   - It needs the cursor to have reached the block of the transaction, not a
 *     block from before it. A Context Graph registration mines its own block
 *     before the publish does, so "the head moved since before the graph was
 *     created" is satisfied by the registration alone.
 *   - It needs the transaction's own event in `chain_events` under that scope,
 *     at the receipt's block and log index, from the expected contract, with
 *     the expected topics. A cursor position says where the tick looked; the
 *     row says what it kept.
 *
 * `head_block` is the head the tick OBSERVED, not the block its log fetch
 * reached (a catch-up pass fetches through `min(head, settled + maxCatchUp)`),
 * so a cursor at or past the block does not by itself prove the event was read.
 * That is why the verdict needs the row too, and why a caller polls the whole
 * verdict rather than the cursor alone.
 */
import type Database from 'better-sqlite3';
import { buildEvmDeploymentId } from '../../packages/chain/src/chain-adapter.js';

/**
 * The scope a node's chain log (`chain_index_cursor`, `chain_events`) is keyed
 * by: the deployment id (chain id + Hub) plus the Hub address again. It is the
 * adapter's private `chainEventLogScope` (`packages/chain/src/evm-adapter-base.ts`),
 * a DURABLE key that is deliberately not shortened. Note it is NOT the daemon's
 * `chainCursorScope` (`lifecycle.ts`), which is the bare deployment id and keys
 * `runtime_cursors` and the storage-discovery checkpoint.
 *
 * If this formula ever drifts from the adapter's, the live check fails at once
 * with `no-cursor`, listing the scopes the node really has, rather than passing
 * against the wrong rows.
 */
export function chainLogScope(chain: { readonly chainId: string; readonly hubAddress: string }): string {
  return `${buildEvmDeploymentId(chain)}:${chain.hubAddress.toLowerCase()}`;
}

/** The columns of `chain_index_cursor` the verdict reads. */
export interface ChainLogCursorRow {
  readonly scope: string;
  /** Empty for a tombstoned scope: `SqliteChainEventLogStore.load` refuses it. */
  readonly lineage: string;
  readonly head_block: number;
}

/** The columns of `chain_events` the verdict reads. */
export interface ChainLogEventRow {
  readonly scope: string;
  readonly block_number: number;
  readonly log_index: number;
  readonly tx_hash: string;
  readonly address: string;
  readonly topic0: string;
  readonly topic1: string | null;
  readonly topic2: string | null;
  readonly topic3: string | null;
}

/** What the chain says the transaction emitted: one log of its receipt. */
export interface ExpectedChainEvent {
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly address: string;
  /** Every topic of the log, topic0 first. */
  readonly topics: readonly string[];
}

export interface ChainLogSnapshot {
  /** Every row of `chain_index_cursor`, whatever its scope. */
  readonly cursors: readonly ChainLogCursorRow[];
  /** The `chain_events` rows of the expected transaction, whatever their scope. */
  readonly events: readonly ChainLogEventRow[];
}

export type ChainLogVerdictKind = 'followed' | 'no-cursor' | 'cursor-behind' | 'event-missing';

export interface ChainLogVerdict {
  readonly followed: boolean;
  readonly kind: ChainLogVerdictKind;
  readonly reason: string;
}

/**
 * Read what {@link judgeChainLogFollows} needs from a live node's database.
 * `handle` must be a read-only connection: the node owns the file.
 */
export function readChainLogSnapshot(handle: Database.Database, transactionHash: string): ChainLogSnapshot {
  return {
    cursors: handle.prepare(
      `SELECT scope, lineage, head_block FROM chain_index_cursor ORDER BY scope`,
    ).all() as ChainLogCursorRow[],
    events: handle.prepare(`
      SELECT scope, block_number, log_index, tx_hash, address, topic0, topic1, topic2, topic3
        FROM chain_events
       WHERE lower(tx_hash) = ?
       ORDER BY scope, block_number, log_index
    `).all(transactionHash.toLowerCase()) as ChainLogEventRow[],
  };
}

const lower = (value: string): string => value.toLowerCase();

/** A row's topics as the log had them: absent topics omitted, not zero-filled. */
function rowTopics(row: ChainLogEventRow): string[] {
  return [row.topic0, row.topic1, row.topic2, row.topic3]
    .filter((topic): topic is string => typeof topic === 'string' && topic.length > 0)
    .map(lower);
}

function describeRow(row: ChainLogEventRow): string {
  return `block ${row.block_number} log ${row.log_index} ${row.address} topic0 ${row.topic0}`;
}

/**
 * Did the log of `scope` reach the block of `expected` AND keep the event the
 * transaction emitted? Pure: the same rows always give the same verdict.
 */
export function judgeChainLogFollows(
  snapshot: ChainLogSnapshot,
  scope: string,
  expected: ExpectedChainEvent,
): ChainLogVerdict {
  const cursor = snapshot.cursors.find((row) => row.scope === scope && row.lineage !== '');
  if (cursor === undefined) {
    const present = snapshot.cursors
      .map((row) => `${row.scope}@${row.head_block}${row.lineage === '' ? ' (tombstoned)' : ''}`);
    return {
      followed: false,
      kind: 'no-cursor',
      reason: `no live chain_index_cursor row for scope ${scope}; the table has: ${present.join(', ') || 'no rows'}`,
    };
  }
  if (cursor.head_block < expected.blockNumber) {
    return {
      followed: false,
      kind: 'cursor-behind',
      reason: `scope ${scope} cursor head_block ${cursor.head_block} has not reached block ${expected.blockNumber} of transaction ${expected.transactionHash}`,
    };
  }

  const ofTransaction = snapshot.events.filter((row) => lower(row.tx_hash) === lower(expected.transactionHash));
  const inScope = ofTransaction.filter((row) => row.scope === scope);
  const expectedTopics = expected.topics.map(lower);
  const match = inScope.find((row) => row.block_number === expected.blockNumber
    && row.log_index === expected.logIndex
    && lower(row.address) === lower(expected.address)
    && rowTopics(row).length === expectedTopics.length
    && rowTopics(row).every((topic, index) => topic === expectedTopics[index]));
  if (match === undefined) {
    return {
      followed: false,
      kind: 'event-missing',
      reason: `scope ${scope} cursor head_block ${cursor.head_block} is at block ${expected.blockNumber}, but chain_events has no row for `
        + `${expected.address} log ${expected.logIndex} of transaction ${expected.transactionHash} at that block `
        + `(rows of that transaction in this scope: ${inScope.map(describeRow).join('; ') || 'none'}; in other scopes: ${ofTransaction.length - inScope.length})`,
    };
  }
  return {
    followed: true,
    kind: 'followed',
    reason: `scope ${scope} cursor head_block ${cursor.head_block} >= block ${expected.blockNumber} and chain_events holds ${describeRow(match)} of transaction ${expected.transactionHash}`,
  };
}
