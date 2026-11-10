// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEventLogCommit,
  ChainEventLogCountQuery,
  ChainEventLogCoverage,
  ChainEventLogQuery,
  ChainEventLogRow,
  ChainEventLogState,
  ChainEventLogStore,
} from '../../src/chain-index/chain-event-log.js';
import { CHAIN_EVENT_LOG_ZERO_HASH } from '../../src/chain-index/chain-index-tick.js';

interface MemoryChainEventLogScope {
  revision: number;
  state: ChainEventLogState | undefined;
  rows: ChainEventLogRow[];
}

/**
 * In-memory twin of the SQLite log store.
 *
 * It reproduces the two behaviours the tick's correctness rests on — the CAS
 * token and write-once settled rows — so a chain-side test can exercise them
 * without a database. The SQLite implementation is tested against the same
 * expectations in `node-ui`.
 */
export class MemoryChainEventLogStore implements ChainEventLogStore {
  readonly #scopes = new Map<string, MemoryChainEventLogScope>();
  /** Per scope, block number -> the hash kept for it and the lineage it was read under. */
  readonly #memo = new Map<string, Map<number, { lineage: string; hash: string }>>();
  commits = 0;
  tombstones = 0;
  counts = 0;
  memoReads = 0;
  memoWrites = 0;

  readSettledBlockHash?: ChainEventLogStore['readSettledBlockHash'];
  rememberSettledBlockHash?: ChainEventLogStore['rememberSettledBlockHash'];

  /**
   * `settledBlockHashMemo` adds the optional durable memo, with the SQLite
   * store's rules: a live cursor on the lineage, settled at or above the
   * block, no fork suspicion — on read and on write — and the memo dropped
   * whenever the lineage changes or the scope is tombstoned.
   */
  constructor(options: Readonly<{ settledBlockHashMemo?: boolean }> = {}) {
    if (options.settledBlockHashMemo !== true) return;
    const servable = (scope: string, lineage: string, blockNumber: number): boolean => {
      const state = this.#scopes.get(scope)?.state;
      return state !== undefined
        && state.cursor.lineage === lineage
        && state.cursor.settledBlockNumber >= blockNumber
        && state.suspectedForkBlockNumber === undefined;
    };
    this.readSettledBlockHash = async (scope, lineage, blockNumber) => {
      this.memoReads += 1;
      const held = this.#memo.get(scope)?.get(blockNumber);
      if (held === undefined || held.lineage !== lineage) return undefined;
      return servable(scope, lineage, blockNumber) ? held.hash : undefined;
    };
    this.rememberSettledBlockHash = async (scope, lineage, blockNumber, blockHash) => {
      this.memoWrites += 1;
      const memo = this.#memo.get(scope) ?? new Map();
      const held = memo.get(blockNumber);
      if (held !== undefined && held.lineage === lineage) {
        if (held.hash === blockHash) return true;
        memo.delete(blockNumber);
        return false;
      }
      if (!servable(scope, lineage, blockNumber)) return false;
      memo.set(blockNumber, { lineage, hash: blockHash });
      this.#memo.set(scope, memo);
      return true;
    };
  }

  /** Test-only window onto the durable memo. */
  memoSize(scope: string): number {
    return this.#memo.get(scope)?.size ?? 0;
  }

  /** The SQLite lineage trigger: any change of lineage empties the memo. */
  #followLineage(scope: string, next: ChainEventLogState | undefined): void {
    if (this.#scopes.get(scope)?.state?.cursor.lineage !== next?.cursor.lineage) {
      this.#memo.delete(scope);
    }
  }

  async load(scope: string): Promise<ChainEventLogState | undefined> {
    return this.#scopes.get(scope)?.state;
  }

  async commit(
    scope: string,
    expectedRevision: number | undefined,
    commit: ChainEventLogCommit,
  ): Promise<number | undefined> {
    let held = this.#scopes.get(scope);
    if (expectedRevision === undefined) {
      if (held?.state !== undefined) return undefined;
    } else if (held?.state?.cursor.revision !== expectedRevision) {
      return undefined;
    }
    if (held === undefined) {
      held = {
        revision: 0,
        state: undefined,
        rows: [],
      };
      this.#scopes.set(scope, held);
    }
    const replaced = commit.replacedRange !== undefined
      && commit.replacedRange.throughBlockNumber >= commit.replacedRange.fromBlockNumber
      ? commit.replacedRange
      : undefined;
    const insideReplaced = (blockNumber: number): boolean => replaced !== undefined
      && blockNumber >= replaced.fromBlockNumber
      && blockNumber <= replaced.throughBlockNumber;
    for (const row of commit.rows) {
      if (!row.settled && !insideReplaced(row.blockNumber)) {
        throw new Error('Chain event log tail row falls outside the replaced range');
      }
    }
    this.commits += 1;
    held.revision += 1;
    // Mirrors the SQLite DELETE exactly: the tail goes ONLY inside the range
    // this commit re-fetched, so coverage can never outlive its rows.
    held.rows = held.rows.filter((row) => row.settled || !insideReplaced(row.blockNumber));
    const heldPositions = new Set(held.rows.map((row) => `${row.blockNumber}:${row.logIndex}`));
    for (const row of commit.rows) {
      if (heldPositions.has(`${row.blockNumber}:${row.logIndex}`)) continue;
      held.rows.push(row);
    }
    const coverage = new Map<string, ChainEventLogCoverage>(
      (held.state?.coverage ?? []).map((entry) => [`${entry.family}:${entry.address}`, entry]),
    );
    for (const entry of commit.coverage) {
      coverage.set(`${entry.family}:${entry.address}`, entry);
    }
    // Sticky, exactly as the SQLite column is: only an explicit clear or a
    // verified matching hash may withdraw a suspicion.
    const suspected = commit.clearsForkSuspicion === true
      ? undefined
      : commit.suspectedForkBlockNumber ?? held.state?.suspectedForkBlockNumber;
    const next: ChainEventLogState = Object.freeze({
      cursor: Object.freeze({ ...commit.cursor, revision: held.revision }),
      coverage: Object.freeze([...coverage.values()]),
      ...(suspected === undefined ? {} : { suspectedForkBlockNumber: suspected }),
    });
    this.#followLineage(scope, next);
    held.state = next;
    return held.revision;
  }

  async tombstone(scope: string, expectedRevision: number): Promise<number | undefined> {
    const held = this.#scopes.get(scope);
    if (held?.state?.cursor.revision !== expectedRevision) return undefined;
    this.tombstones += 1;
    held.revision += 1;
    held.rows = [];
    this.#memo.delete(scope);
    held.state = undefined;
    return held.revision;
  }

  async readEvents(
    scope: string,
    query: ChainEventLogQuery,
  ): Promise<readonly ChainEventLogRow[]> {
    // topic0/topic1/topic2 filter the stored hex EXACTLY as the SQLite `IN (…)` does,
    // with no case folding on either side. That is the whole cross-package
    // contract behind the per-graph read, and a twin that ignored the filter
    // would let a mismatched encoding pass every test and then answer an empty
    // KA list in production.
    const matches = (held: string | undefined, wanted: readonly string[] | undefined): boolean =>
      wanted === undefined || wanted.length === 0
      || (held !== undefined && wanted.includes(held));
    return (this.#scopes.get(scope)?.rows ?? [])
      .filter((row) => row.blockNumber >= query.fromBlockNumber
        && row.blockNumber <= query.throughBlockNumber
        && (query.addresses === undefined || query.addresses.includes(row.address))
        && matches(row.topics[0], query.topic0)
        && matches(row.topics[1], query.topic1)
        && matches(row.topics[2], query.topic2))
      .sort((left, right) => left.blockNumber - right.blockNumber
        || left.logIndex - right.logIndex);
  }

  /** Counts exactly what {@link readEvents} returns, as the SQLite `COUNT(*)` does. */
  async countEvents(scope: string, query: ChainEventLogCountQuery): Promise<number> {
    this.counts += 1;
    return (await this.readEvents(scope, query))
      .filter((row) => query.settled === undefined || row.settled === query.settled)
      .length;
  }

  async blockHashAt(scope: string, blockNumber: number): Promise<string | undefined> {
    const held = this.#scopes.get(scope);
    const cursor = held?.state?.cursor;
    if (cursor?.settledBlockNumber === blockNumber
      && cursor.settledBlockHash !== CHAIN_EVENT_LOG_ZERO_HASH) {
      return cursor.settledBlockHash;
    }
    if (cursor?.head.number === blockNumber) return cursor.head.hash;
    return held?.rows.find((row) => row.blockNumber === blockNumber)?.blockHash;
  }

  /** Test-only window onto what the log holds. */
  rows(scope: string): readonly ChainEventLogRow[] {
    return [...(this.#scopes.get(scope)?.rows ?? [])];
  }

  seed(
    scope: string,
    state: ChainEventLogState,
    rows: readonly ChainEventLogRow[] = [],
  ): void {
    this.#followLineage(scope, state);
    this.#scopes.set(scope, {
      state,
      revision: state.cursor.revision,
      rows: [...rows],
    });
  }

}
