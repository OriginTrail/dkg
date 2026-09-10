// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  normalizeContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexState,
  type ContextGraphAuthorityIndexStore,
} from './context-graph-authority-index-checkpoint.js';
import {
  normalizeContextGraphAuthorityHash as normalizeHash,
  normalizeContextGraphAuthorityNonNegativeSafeInteger as normalizeNonNegativeSafeInteger,
} from './context-graph-authority-generation.js';
import {
  reduceContextGraphAuthorityIndexPage,
  type ContextGraphAuthorityIndexEvent,
} from './context-graph-authority-index-reducer.js';
import { KeyedSingleFlight } from './keyed-ttl-single-flight-cache.js';

export class ContextGraphAuthorityIndexRetryableError extends Error {
  override readonly name = 'ContextGraphAuthorityIndexRetryableError';
}

export function isContextGraphAuthorityIndexRetryableError(
  error: unknown,
): error is ContextGraphAuthorityIndexRetryableError {
  return error instanceof ContextGraphAuthorityIndexRetryableError;
}

function retryableAuthorityIndexReadError(message: string): Error {
  return new ContextGraphAuthorityIndexRetryableError(message);
}

export interface ContextGraphAuthorityIndexScanInput {
  /** Deployment + physical ContextGraphStorage address; contains no secret. */
  readonly scope: string;
  readonly contextGraphId: bigint;
  /** Physical RPC reader identity; isolates a timed-out provider attempt. */
  readonly readScope: object;
  readonly deploymentBlockNumber: number;
  readonly finalized: Readonly<{ number: number; hash: string }>;
  readonly pageSize: number;
  readonly signal?: AbortSignal;
  readonly readBlockHash: (
    blockNumber: number,
    lifecycleSignal: AbortSignal,
  ) => Promise<string | null>;
  /** Read all six indexed authority event signatures for one inclusive range. */
  readonly readPage: (
    fromBlockNumber: number,
    throughBlockNumber: number,
    lifecycleSignal: AbortSignal,
  ) => Promise<readonly ContextGraphAuthorityIndexEvent[]>;
}

interface DurableAuthorityIndexState {
  /** Store-owned non-repeating CAS identity; absent only before the first write. */
  readonly token: number | undefined;
  /** Absent when the durable row is missing or is an invalidation tombstone. */
  readonly checkpoint?: ContextGraphAuthorityIndexCheckpoint;
}

function assertAuthorityIndexToken(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('Context Graph authority index durable token is invalid');
  }
}

/**
 * Process-local owner for the durable contract-wide authority index.
 *
 * Every successfully reduced page is persisted before the next page starts.
 * A later call (including one on a fallback endpoint) therefore resumes at the
 * next block instead of repeating the already-covered contract prefix.
 */
export class ContextGraphAuthorityIndex {
  readonly #entries = new Map<string, DurableAuthorityIndexState>();
  readonly #singleFlight = new KeyedSingleFlight<string, object>();
  #epoch = 0;
  #lifecycleAbort = new AbortController();

  constructor(readonly localStore: ContextGraphAuthorityIndexStore) {}

  clear(): void {
    this.#lifecycleAbort.abort(new DOMException(
      'Context Graph authority index lifecycle cleared',
      'AbortError',
    ));
    this.#lifecycleAbort = new AbortController();
    this.#epoch += 1;
    this.#entries.clear();
    this.#singleFlight.invalidateAll();
  }

  async resolve(
    input: ContextGraphAuthorityIndexScanInput,
  ): Promise<ContextGraphAuthorityIndexState> {
    input.signal?.throwIfAborted();
    const scope = input.scope.trim();
    if (scope.length === 0) throw new Error('Context Graph authority index scope is empty');
    if (
      typeof input.contextGraphId !== 'bigint'
      || input.contextGraphId <= 0n
      || input.contextGraphId > ethers.MaxUint256
    ) {
      throw new Error('Context Graph authority index target id is invalid');
    }
    if (input.readScope === null || typeof input.readScope !== 'object') {
      throw new Error('Context Graph authority index read scope is invalid');
    }
    const finalizedHash = normalizeHash(input.finalized.hash);
    if (finalizedHash === undefined) {
      throw new Error('Context Graph authority index finalized hash is invalid');
    }
    const scanKey = [scope, input.finalized.number, finalizedHash].join('\u0000');
    const pending = this.#singleFlight.run(scanKey, input.readScope, () => {
      const epoch = this.#epoch;
      const lifecycleSignal = this.#lifecycleAbort.signal;
      return this.#scan({ ...input, scope, finalized: {
        number: input.finalized.number,
        hash: finalizedHash,
      } }, epoch, lifecycleSignal);
    });
    const checkpoint = await waitForSharedAuthorityIndexScan(pending, input.signal);
    // Target lookup intentionally happens after the shared contract scan, so
    // every waiter resolves its own graph from the same complete checkpoint.
    return this.#requireState(checkpoint, input.contextGraphId);
  }

  async #scan(
    input: ContextGraphAuthorityIndexScanInput,
    epoch: number,
    lifecycleSignal: AbortSignal,
  ): Promise<ContextGraphAuthorityIndexCheckpoint> {
    const scope = input.scope;
    const deploymentBlockNumber = normalizeNonNegativeSafeInteger(input.deploymentBlockNumber);
    const finalizedNumber = normalizeNonNegativeSafeInteger(input.finalized.number);
    const finalizedHash = normalizeHash(input.finalized.hash);
    const pageSize = normalizeNonNegativeSafeInteger(input.pageSize);
    if (
      deploymentBlockNumber === undefined
      || finalizedNumber === undefined
      || finalizedHash === undefined
      || pageSize === undefined
      || pageSize < 1
      || deploymentBlockNumber > finalizedNumber
    ) {
      throw new Error('Context Graph authority index scan bounds are invalid');
    }

    let durable = await this.#load(scope);
    if (durable.checkpoint !== undefined) {
      durable = await this.#admitCheckpoint(
        scope,
        durable,
        deploymentBlockNumber,
        { number: finalizedNumber, hash: finalizedHash },
        input.readBlockHash,
        lifecycleSignal,
      );
    }

    for (;;) {
      lifecycleSignal.throwIfAborted();
      const checkpoint = durable.checkpoint;
      if (checkpoint !== undefined && checkpoint.cursor.throughBlockNumber === finalizedNumber) {
        return checkpoint;
      }

      const fromBlockNumber = checkpoint === undefined
        ? deploymentBlockNumber
        : checkpoint.cursor.throughBlockNumber + 1;
      const throughBlockNumber = Math.min(
        fromBlockNumber + pageSize - 1,
        finalizedNumber,
      );
      const throughBlockHash = throughBlockNumber === finalizedNumber
        ? finalizedHash
        : normalizeHash(await input.readBlockHash(throughBlockNumber, lifecycleSignal));
      if (throughBlockHash === undefined) {
        throw retryableAuthorityIndexReadError(
          `Context Graph authority index block ${throughBlockNumber} is unavailable`,
        );
      }

      const events = await input.readPage(
        fromBlockNumber,
        throughBlockNumber,
        lifecycleSignal,
      );
      lifecycleSignal.throwIfAborted();
      const reduction = reduceContextGraphAuthorityIndexPage({
        deploymentBlockNumber,
        throughBlockNumber,
        throughBlockHash,
        previous: checkpoint,
        events,
      });
      const next = reduction.checkpoint;

      const committedToken = await this.localStore.compareAndSwap(
        scope,
        durable.token,
        next,
      );
      if (committedToken === undefined) {
        // Another valid provider completion won the page. Reload its result
        // and continue from that cursor rather than overwriting or rescanning.
        durable = await this.#admitCheckpoint(
          scope,
          await this.#load(scope, true),
          deploymentBlockNumber,
          { number: finalizedNumber, hash: finalizedHash },
          input.readBlockHash,
          lifecycleSignal,
        );
        continue;
      }
      assertAuthorityIndexToken(committedToken);

      const current = this.#entries.get(scope);
      if (this.#epoch === epoch && (
        current === undefined
        || current.token === undefined
        || current.token < committedToken
      )) {
        this.#entries.set(scope, Object.freeze({ token: committedToken, checkpoint: next }));
      }
      durable = this.#epoch === epoch
        ? (this.#entries.get(scope) ?? Object.freeze({ token: committedToken, checkpoint: next }))
        : Object.freeze({ token: committedToken, checkpoint: next });
    }
  }

  async #load(
    scope: string,
    forceDurable = false,
  ): Promise<DurableAuthorityIndexState> {
    const memory = forceDurable ? undefined : this.#entries.get(scope);
    if (memory !== undefined) return memory;

    // A bounded loop handles a concurrent winner without allowing malformed
    // durable tokens to turn recovery into unbounded recursive reloads.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await this.localStore.load(scope);
      if (record === undefined) return Object.freeze({ token: undefined });
      assertAuthorityIndexToken(record.token);
      if (record.value === null) {
        const tombstone = Object.freeze({ token: record.token });
        this.#entries.set(scope, tombstone);
        return tombstone;
      }
      const checkpoint = normalizeContextGraphAuthorityIndexCheckpoint(record.value);
      if (checkpoint !== undefined) {
        const admitted = Object.freeze({ token: record.token, checkpoint });
        this.#entries.set(scope, admitted);
        return admitted;
      }
      const invalidatedToken = await this.localStore.invalidate(scope, record.token);
      if (invalidatedToken !== undefined) {
        assertAuthorityIndexToken(invalidatedToken);
        const tombstone = Object.freeze({ token: invalidatedToken });
        this.#entries.set(scope, tombstone);
        return tombstone;
      }
    }
    throw retryableAuthorityIndexReadError(
      'Context Graph authority index durable value changed repeatedly during recovery',
    );
  }

  async #admitCheckpoint(
    scope: string,
    durable: DurableAuthorityIndexState,
    deploymentBlockNumber: number,
    finalized: Readonly<{ number: number; hash: string }>,
    readBlockHash: (
      blockNumber: number,
      lifecycleSignal: AbortSignal,
    ) => Promise<string | null>,
    lifecycleSignal: AbortSignal,
    recoveryBudget = 3,
  ): Promise<DurableAuthorityIndexState> {
    const checkpoint = durable.checkpoint;
    if (checkpoint === undefined) return durable;
    if (
      checkpoint.cursor.deploymentBlockNumber !== deploymentBlockNumber
    ) {
      return this.#discardOrReload(
        scope,
        durable,
        deploymentBlockNumber,
        finalized,
        readBlockHash,
        lifecycleSignal,
        recoveryBudget,
      );
    }
    if (checkpoint.cursor.throughBlockNumber > finalized.number) {
      // A lagging provider/caller is not evidence that the durable prefix is
      // invalid. Preserve the newer winner and let endpoint failover obtain a
      // head that can serve it.
      throw retryableAuthorityIndexReadError(
        `Context Graph authority index finalized head ${finalized.number} is behind `
        + `durable cursor ${checkpoint.cursor.throughBlockNumber}`,
      );
    }
    const anchorHash = checkpoint.cursor.throughBlockNumber === finalized.number
      ? finalized.hash
      : normalizeHash(await readBlockHash(
          checkpoint.cursor.throughBlockNumber,
          lifecycleSignal,
        ));
    if (anchorHash === undefined) {
      // A non-archive endpoint must not destroy a valid durable prefix. Let the
      // adapter fail over to an endpoint that can revalidate it.
      throw retryableAuthorityIndexReadError(
        `Context Graph authority index anchor ${checkpoint.cursor.throughBlockNumber} is unavailable`,
      );
    }
    if (anchorHash !== checkpoint.cursor.throughBlockHash) {
      return this.#discardOrReload(
        scope,
        durable,
        deploymentBlockNumber,
        finalized,
        readBlockHash,
        lifecycleSignal,
        recoveryBudget,
      );
    }
    return durable;
  }

  async #discardOrReload(
    scope: string,
    durable: DurableAuthorityIndexState,
    deploymentBlockNumber: number,
    finalized: Readonly<{ number: number; hash: string }>,
    readBlockHash: (
      blockNumber: number,
      lifecycleSignal: AbortSignal,
    ) => Promise<string | null>,
    lifecycleSignal: AbortSignal,
    recoveryBudget: number,
  ): Promise<DurableAuthorityIndexState> {
    if (recoveryBudget < 1) {
      throw retryableAuthorityIndexReadError(
        'Context Graph authority index changed repeatedly during anchor recovery',
      );
    }
    if (this.#entries.get(scope) === durable) this.#entries.delete(scope);
    if (durable.token === undefined) return Object.freeze({ token: undefined });
    const invalidatedToken = await this.localStore.invalidate(scope, durable.token);
    if (invalidatedToken !== undefined) {
      assertAuthorityIndexToken(invalidatedToken);
      const tombstone = Object.freeze({ token: invalidatedToken });
      this.#entries.set(scope, tombstone);
      return tombstone;
    }
    return this.#admitCheckpoint(
      scope,
      await this.#load(scope, true),
      deploymentBlockNumber,
      finalized,
      readBlockHash,
      lifecycleSignal,
      recoveryBudget - 1,
    );
  }

  #requireState(
    checkpoint: ContextGraphAuthorityIndexCheckpoint,
    contextGraphId: bigint,
  ): ContextGraphAuthorityIndexState {
    const id = contextGraphId.toString(10);
    const state = checkpoint.states.find((candidate) => candidate.contextGraphId === id);
    if (state === undefined) {
      throw new Error(`Context Graph ${id} has no finalized creation event`);
    }
    return state;
  }
}

function waitForSharedAuthorityIndexScan<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
