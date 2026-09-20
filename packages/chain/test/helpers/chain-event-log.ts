// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEventLogCommit,
  ChainEventLogCoverage,
  ChainEventLogQuery,
  ChainEventLogRow,
  ChainEventLogState,
  ChainEventLogStore,
} from '../../src/chain-index/chain-event-log.js';
import { CHAIN_EVENT_LOG_ZERO_HASH } from '../../src/chain-index/chain-index-tick.js';

/**
 * In-memory twin of the SQLite log store.
 *
 * It reproduces the two behaviours the tick's correctness rests on — the CAS
 * token and write-once settled rows — so a chain-side test can exercise them
 * without a database. The SQLite implementation is tested against the same
 * expectations in `node-ui`.
 */
export class MemoryChainEventLogStore implements ChainEventLogStore {
  #revision = 0;
  #state: ChainEventLogState | undefined;
  #rows: ChainEventLogRow[] = [];
  #tombstoned = false;
  commits = 0;
  tombstones = 0;

  async load(): Promise<ChainEventLogState | undefined> {
    return this.#tombstoned ? undefined : this.#state;
  }

  async commit(
    _scope: string,
    expectedRevision: number | undefined,
    commit: ChainEventLogCommit,
  ): Promise<number | undefined> {
    if (expectedRevision === undefined) {
      if (this.#state !== undefined && !this.#tombstoned) return undefined;
    } else if (this.#state?.cursor.revision !== expectedRevision || this.#tombstoned) {
      return undefined;
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
    this.#tombstoned = false;
    this.#revision += 1;
    // Mirrors the SQLite DELETE exactly: the tail goes ONLY inside the range
    // this commit re-fetched, so coverage can never outlive its rows.
    this.#rows = this.#rows.filter((row) => row.settled || !insideReplaced(row.blockNumber));
    const held = new Set(this.#rows.map((row) => `${row.blockNumber}:${row.logIndex}`));
    for (const row of commit.rows) {
      if (held.has(`${row.blockNumber}:${row.logIndex}`)) continue;
      this.#rows.push(row);
    }
    const coverage = new Map<string, ChainEventLogCoverage>(
      (this.#state?.coverage ?? []).map((entry) => [`${entry.family}:${entry.address}`, entry]),
    );
    for (const entry of commit.coverage) {
      coverage.set(`${entry.family}:${entry.address}`, entry);
    }
    // Sticky, exactly as the SQLite column is: only an explicit clear or a
    // verified matching hash may withdraw a suspicion.
    const suspected = commit.clearsForkSuspicion === true
      ? undefined
      : commit.suspectedForkBlockNumber ?? this.#state?.suspectedForkBlockNumber;
    this.#state = Object.freeze({
      cursor: Object.freeze({ ...commit.cursor, revision: this.#revision }),
      coverage: Object.freeze([...coverage.values()]),
      ...(suspected === undefined ? {} : { suspectedForkBlockNumber: suspected }),
    });
    return this.#revision;
  }

  async tombstone(_scope: string, expectedRevision: number): Promise<number | undefined> {
    if (this.#state?.cursor.revision !== expectedRevision) return undefined;
    this.tombstones += 1;
    this.#revision += 1;
    this.#tombstoned = true;
    this.#rows = [];
    this.#state = undefined;
    return this.#revision;
  }

  async readEvents(
    _scope: string,
    query: ChainEventLogQuery,
  ): Promise<readonly ChainEventLogRow[]> {
    // topic0/topic1 filter the stored hex EXACTLY as the SQLite `IN (…)` does,
    // with no case folding on either side. That is the whole cross-package
    // contract behind the per-graph read, and a twin that ignored the filter
    // would let a mismatched encoding pass every test and then answer an empty
    // KA list in production.
    const matches = (held: string | undefined, wanted: readonly string[] | undefined): boolean =>
      wanted === undefined || wanted.length === 0
      || (held !== undefined && wanted.includes(held));
    return this.#rows
      .filter((row) => row.blockNumber >= query.fromBlockNumber
        && row.blockNumber <= query.throughBlockNumber
        && (query.addresses === undefined || query.addresses.includes(row.address))
        && matches(row.topics[0], query.topic0)
        && matches(row.topics[1], query.topic1))
      .sort((left, right) => left.blockNumber - right.blockNumber
        || left.logIndex - right.logIndex);
  }

  async blockHashAt(_scope: string, blockNumber: number): Promise<string | undefined> {
    const cursor = this.#state?.cursor;
    if (cursor?.settledBlockNumber === blockNumber
      && cursor.settledBlockHash !== CHAIN_EVENT_LOG_ZERO_HASH) {
      return cursor.settledBlockHash;
    }
    if (cursor?.head.number === blockNumber) return cursor.head.hash;
    return this.#rows.find((row) => row.blockNumber === blockNumber)?.blockHash;
  }

  /** Test-only window onto what the log holds. */
  rows(): readonly ChainEventLogRow[] {
    return [...this.#rows];
  }

  seed(state: ChainEventLogState, rows: readonly ChainEventLogRow[] = []): void {
    this.#state = state;
    this.#revision = state.cursor.revision;
    this.#rows = [...rows];
    this.#tombstoned = false;
  }
}
