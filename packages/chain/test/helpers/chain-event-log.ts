// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEventLogCommit,
  ChainEventLogCoverage,
  ChainEventLogQuery,
  ChainEventLogRow,
  ChainEventLogState,
  ChainEventLogStore,
} from '../../src/chain-index/chain-event-log.js';

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
    this.commits += 1;
    this.#tombstoned = false;
    this.#revision += 1;
    this.#rows = this.#rows.filter((row) => row.settled);
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
    this.#state = Object.freeze({
      cursor: Object.freeze({ ...commit.cursor, revision: this.#revision }),
      coverage: Object.freeze([...coverage.values()]),
      ...(commit.suspectedForkBlockNumber === undefined
        ? {}
        : { suspectedForkBlockNumber: commit.suspectedForkBlockNumber }),
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
    return this.#rows
      .filter((row) => row.blockNumber >= query.fromBlockNumber
        && row.blockNumber <= query.throughBlockNumber
        && (query.addresses === undefined || query.addresses.includes(row.address)))
      .sort((left, right) => left.blockNumber - right.blockNumber
        || left.logIndex - right.logIndex);
  }

  async blockHashAt(_scope: string, blockNumber: number): Promise<string | undefined> {
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
