// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
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
import {
  admitContextGraphAuthorityIndexCheckpoint,
} from './context-graph-authority-index-admission.js';
import { ContextGraphAuthorityIndexRetryableError } from
  './context-graph-authority-index-errors.js';
import { ContextGraphAuthorityIndexRepository } from
  './context-graph-authority-index-repository.js';
import { KeyedSingleFlight } from './keyed-ttl-single-flight-cache.js';

export {
  ContextGraphAuthorityIndexRetryableError,
  isContextGraphAuthorityIndexRetryableError,
} from './context-graph-authority-index-errors.js';

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
  /** Read all seven indexed authority event signatures for one inclusive range. */
  readonly readPage: (
    fromBlockNumber: number,
    throughBlockNumber: number,
    lifecycleSignal: AbortSignal,
  ) => Promise<readonly ContextGraphAuthorityIndexEvent[]>;
}

export type ContextGraphAuthorityIndexSnapshotInput = Omit<
  ContextGraphAuthorityIndexScanInput,
  'contextGraphId'
>;
/**
 * Process-local owner for the durable contract-wide authority index.
 *
 * Every successfully reduced page is persisted before the next page starts.
 * A later call (including one on a fallback endpoint) therefore resumes at the
 * next block instead of repeating the already-covered contract prefix.
 */
export class ContextGraphAuthorityIndex {
  readonly #repository: ContextGraphAuthorityIndexRepository;
  readonly #singleFlight = new KeyedSingleFlight<string, object>();
  #lifecycleAbort = new AbortController();

  constructor(readonly localStore: ContextGraphAuthorityIndexStore) {
    this.#repository = new ContextGraphAuthorityIndexRepository(localStore);
  }

  clear(): void {
    this.#lifecycleAbort.abort(new DOMException(
      'Context Graph authority index lifecycle cleared',
      'AbortError',
    ));
    this.#lifecycleAbort = new AbortController();
    this.#repository.clear();
    this.#singleFlight.invalidateAll();
  }

  async resolve(
    input: ContextGraphAuthorityIndexScanInput,
  ): Promise<ContextGraphAuthorityIndexState> {
    if (
      typeof input.contextGraphId !== 'bigint'
      || input.contextGraphId <= 0n
      || input.contextGraphId > ethers.MaxUint256
    ) {
      throw new Error('Context Graph authority index target id is invalid');
    }
    const checkpoint = await this.snapshot(input);
    // Target lookup intentionally happens after the shared contract scan, so
    // every waiter resolves its own graph from the same complete checkpoint.
    return this.#requireState(checkpoint, input.contextGraphId);
  }

  /** Resolve the complete materialized index at one finalized chain anchor. */
  async snapshot(
    input: ContextGraphAuthorityIndexSnapshotInput,
  ): Promise<ContextGraphAuthorityIndexCheckpoint> {
    input.signal?.throwIfAborted();
    const scope = input.scope.trim();
    if (scope.length === 0) throw new Error('Context Graph authority index scope is empty');
    if (input.readScope === null || typeof input.readScope !== 'object') {
      throw new Error('Context Graph authority index read scope is invalid');
    }
    const finalizedHash = normalizeHash(input.finalized.hash);
    if (finalizedHash === undefined) {
      throw new Error('Context Graph authority index finalized hash is invalid');
    }
    const scanKey = [scope, input.finalized.number, finalizedHash].join('\u0000');
    const pending = this.#singleFlight.run(scanKey, input.readScope, () => {
      const lifecycleSignal = this.#lifecycleAbort.signal;
      return this.#scan({ ...input, scope, finalized: {
        number: input.finalized.number,
        hash: finalizedHash,
      } }, lifecycleSignal);
    });
    return waitForSharedAuthorityIndexScan(pending, input.signal);
  }

  async #scan(
    input: ContextGraphAuthorityIndexSnapshotInput,
    lifecycleSignal: AbortSignal,
  ): Promise<ContextGraphAuthorityIndexCheckpoint> {
    const scope = input.scope;
    const repository = this.#repository.forScope(scope);
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

    let durable = await admitContextGraphAuthorityIndexCheckpoint({
      repository,
      initial: await repository.load(),
      deploymentBlockNumber,
      finalized: { number: finalizedNumber, hash: finalizedHash },
      readBlockHash: input.readBlockHash,
      lifecycleSignal,
    });

    for (;;) {
      lifecycleSignal.throwIfAborted();
      const checkpoint = durable.kind === 'checkpoint'
        ? durable.checkpoint
        : undefined;
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
        throw new ContextGraphAuthorityIndexRetryableError(
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

      const commit = await repository.commitOrReloadWinner(
        durable,
        next,
      );
      if (commit.kind === 'winner') {
        // Another valid provider completion won the page. Reload its result
        // and continue from that cursor rather than overwriting or rescanning.
        durable = await admitContextGraphAuthorityIndexCheckpoint({
          repository,
          initial: commit.record,
          deploymentBlockNumber,
          finalized: { number: finalizedNumber, hash: finalizedHash },
          readBlockHash: input.readBlockHash,
          lifecycleSignal,
        });
        continue;
      }
      // A newer cache entry can belong to a concurrently scanned provider
      // fork. Keep this attempt on the checkpoint it reduced and admitted;
      // if another token wins the next CAS, that value is reloaded through
      // admission before it can influence this attempt.
      durable = commit.record;
    }
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
