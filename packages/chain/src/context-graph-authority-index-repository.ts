// SPDX-License-Identifier: Apache-2.0

import {
  normalizeContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexStore,
} from './context-graph-authority-index-checkpoint.js';

export type ContextGraphAuthorityIndexRepositoryRecord =
  | Readonly<{ kind: 'missing'; token: undefined }>
  | Readonly<{ kind: 'tombstone'; token: number }>
  | Readonly<{ kind: 'invalid'; token: number }>
  | Readonly<{
      kind: 'checkpoint';
      token: number;
      checkpoint: ContextGraphAuthorityIndexCheckpoint;
    }>;

type CacheableAuthorityIndexRecord = Exclude<
  ContextGraphAuthorityIndexRepositoryRecord,
  Readonly<{ kind: 'missing'; token: undefined }> | Readonly<{ kind: 'invalid'; token: number }>
>;

type TokenedAuthorityIndexRecord = Exclude<
  ContextGraphAuthorityIndexRepositoryRecord,
  Readonly<{ kind: 'missing'; token: undefined }>
>;

export type ContextGraphAuthorityIndexInvalidationResult =
  | Readonly<{
      kind: 'invalidated';
      record: Extract<ContextGraphAuthorityIndexRepositoryRecord, { kind: 'tombstone' }>;
    }>
  | Readonly<{
      kind: 'winner';
      record: ContextGraphAuthorityIndexRepositoryRecord;
    }>;

export type ContextGraphAuthorityIndexCommitResult =
  | Readonly<{
      kind: 'committed';
      record: Extract<ContextGraphAuthorityIndexRepositoryRecord, { kind: 'checkpoint' }>;
    }>
  | Readonly<{
      kind: 'winner';
      record: ContextGraphAuthorityIndexRepositoryRecord;
    }>;

function assertAuthorityIndexToken(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('Context Graph authority index durable token is invalid');
  }
}

/** Decode, cache and mutate opaque durable rows behind one CAS repository boundary. */
export class ContextGraphAuthorityIndexRepository {
  readonly #entries = new Map<string, CacheableAuthorityIndexRecord>();
  readonly #store: ContextGraphAuthorityIndexStore;
  #epoch = 0;

  constructor(store: ContextGraphAuthorityIndexStore) {
    this.#store = store;
  }

  clear(): void {
    this.#epoch += 1;
    this.#entries.clear();
  }

  async load(scope: string): Promise<ContextGraphAuthorityIndexRepositoryRecord> {
    const memory = this.#entries.get(scope);
    if (memory !== undefined) return memory;

    return this.#readDurable(scope, this.#epoch);
  }

  async reload(scope: string): Promise<ContextGraphAuthorityIndexRepositoryRecord> {
    const epoch = this.#epoch;
    return this.#reloadDurable(scope, epoch);
  }

  /**
   * Conditionally tombstone one rejected observation. If another writer wins,
   * return its freshly decoded row so admission can continue without callers
   * sequencing cache eviction and a forced durable reload themselves.
   */
  async invalidateOrReloadWinner(
    scope: string,
    record: TokenedAuthorityIndexRecord,
  ): Promise<ContextGraphAuthorityIndexInvalidationResult> {
    const epoch = this.#epoch;
    this.#discardIfCurrent(scope, record);
    const token = await this.#store.invalidate(scope, record.token);
    if (token === undefined) {
      return Object.freeze({
        kind: 'winner',
        record: await this.#reloadDurable(scope, epoch),
      });
    }
    assertAuthorityIndexToken(token);
    const tombstone = Object.freeze({ kind: 'tombstone' as const, token });
    this.#publish(scope, tombstone, epoch);
    return Object.freeze({ kind: 'invalidated', record: tombstone });
  }

  /** Persist one reduced page, or atomically surface the durable CAS winner. */
  async commitOrReloadWinner(
    scope: string,
    previous: ContextGraphAuthorityIndexRepositoryRecord,
    checkpoint: ContextGraphAuthorityIndexCheckpoint,
  ): Promise<ContextGraphAuthorityIndexCommitResult> {
    const epoch = this.#epoch;
    const token = await this.#store.compareAndSwap(scope, previous.token, checkpoint);
    if (token === undefined) {
      return Object.freeze({
        kind: 'winner',
        record: await this.#reloadDurable(scope, epoch),
      });
    }
    assertAuthorityIndexToken(token);
    const committed = Object.freeze({
      kind: 'checkpoint' as const,
      token,
      checkpoint,
    });
    this.#publish(scope, committed, epoch);
    return Object.freeze({ kind: 'committed', record: committed });
  }

  async #readDurable(
    scope: string,
    epoch: number,
  ): Promise<ContextGraphAuthorityIndexRepositoryRecord> {
    const record = await this.#store.load(scope);

    if (record === undefined) return Object.freeze({ kind: 'missing', token: undefined });
    assertAuthorityIndexToken(record.token);
    if (record.value === null) {
      const tombstone = Object.freeze({ kind: 'tombstone' as const, token: record.token });
      this.#publish(scope, tombstone, epoch);
      return tombstone;
    }
    const checkpoint = normalizeContextGraphAuthorityIndexCheckpoint(record.value);
    if (checkpoint === undefined) {
      return Object.freeze({ kind: 'invalid', token: record.token });
    }
    const admitted = Object.freeze({
      kind: 'checkpoint' as const,
      token: record.token,
      checkpoint,
    });
    this.#publish(scope, admitted, epoch);
    return admitted;
  }

  #reloadDurable(
    scope: string,
    epoch: number,
  ): Promise<ContextGraphAuthorityIndexRepositoryRecord> {
    // A completion from before clear() must not evict a newer lifecycle's
    // cache entry. The epoch guard also prevents its durable read publishing.
    if (this.#epoch === epoch) this.#entries.delete(scope);
    return this.#readDurable(scope, epoch);
  }

  #discardIfCurrent(scope: string, record: ContextGraphAuthorityIndexRepositoryRecord): void {
    if (this.#entries.get(scope) === record) this.#entries.delete(scope);
  }

  #publish(scope: string, record: CacheableAuthorityIndexRecord, epoch: number): void {
    if (this.#epoch !== epoch) return;
    const current = this.#entries.get(scope);
    if (current === undefined || current.token <= record.token) {
      this.#entries.set(scope, record);
    }
  }
}
