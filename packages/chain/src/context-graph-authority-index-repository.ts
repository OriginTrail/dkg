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

function assertAuthorityIndexToken(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('Context Graph authority index durable token is invalid');
  }
}

/** Decode, cache and mutate opaque durable rows behind one CAS repository boundary. */
export class ContextGraphAuthorityIndexRepository {
  readonly #entries = new Map<string, CacheableAuthorityIndexRecord>();
  #epoch = 0;

  constructor(readonly store: ContextGraphAuthorityIndexStore) {}

  get epoch(): number {
    return this.#epoch;
  }

  clear(): void {
    this.#epoch += 1;
    this.#entries.clear();
  }

  async load(
    scope: string,
    options: Readonly<{ forceDurable?: boolean; epoch: number }>,
  ): Promise<ContextGraphAuthorityIndexRepositoryRecord> {
    const memory = options.forceDurable ? undefined : this.#entries.get(scope);
    if (memory !== undefined) return memory;

    const record = await this.store.load(scope);
    if (record === undefined) return Object.freeze({ kind: 'missing', token: undefined });
    assertAuthorityIndexToken(record.token);
    if (record.value === null) {
      const tombstone = Object.freeze({ kind: 'tombstone' as const, token: record.token });
      this.#publish(scope, tombstone, options.epoch);
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
    this.#publish(scope, admitted, options.epoch);
    return admitted;
  }

  discardIfCurrent(scope: string, record: ContextGraphAuthorityIndexRepositoryRecord): void {
    if (this.#entries.get(scope) === record) this.#entries.delete(scope);
  }

  async invalidate(
    scope: string,
    record: Exclude<ContextGraphAuthorityIndexRepositoryRecord, { token: undefined }>,
    epoch: number,
  ): Promise<ContextGraphAuthorityIndexRepositoryRecord | undefined> {
    const token = await this.store.invalidate(scope, record.token);
    if (token === undefined) return undefined;
    assertAuthorityIndexToken(token);
    const tombstone = Object.freeze({ kind: 'tombstone' as const, token });
    this.#publish(scope, tombstone, epoch);
    return tombstone;
  }

  async compareAndSwap(
    scope: string,
    previous: ContextGraphAuthorityIndexRepositoryRecord,
    checkpoint: ContextGraphAuthorityIndexCheckpoint,
    epoch: number,
  ): Promise<ContextGraphAuthorityIndexRepositoryRecord | undefined> {
    const token = await this.store.compareAndSwap(scope, previous.token, checkpoint);
    if (token === undefined) return undefined;
    assertAuthorityIndexToken(token);
    const committed = Object.freeze({
      kind: 'checkpoint' as const,
      token,
      checkpoint,
    });
    this.#publish(scope, committed, epoch);
    return committed;
  }

  #publish(scope: string, record: CacheableAuthorityIndexRecord, epoch: number): void {
    if (this.#epoch !== epoch) return;
    const current = this.#entries.get(scope);
    if (current === undefined || current.token <= record.token) {
      this.#entries.set(scope, record);
    }
  }
}
