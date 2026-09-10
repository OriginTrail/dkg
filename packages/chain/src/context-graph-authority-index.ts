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
  classifyContextGraphAuthorityIndexAdmission,
  UNREAD_CONTEXT_GRAPH_AUTHORITY_INDEX_ANCHOR,
  type ContextGraphAuthorityIndexAnchorObservation,
} from './context-graph-authority-index-admission.js';
import {
  ContextGraphAuthorityIndexRepository,
  type ContextGraphAuthorityIndexRepositoryRecord,
} from './context-graph-authority-index-repository.js';
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
  /** Read all seven indexed authority event signatures for one inclusive range. */
  readonly readPage: (
    fromBlockNumber: number,
    throughBlockNumber: number,
    lifecycleSignal: AbortSignal,
  ) => Promise<readonly ContextGraphAuthorityIndexEvent[]>;
}

const MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_RECOVERY_EFFECTS = 16;
const MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_WINNER_RELOADS = 3;

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
      const epoch = this.#repository.epoch;
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

    let durable = await this.#driveCheckpointAdmission(
      scope,
      await this.#repository.load(scope, { epoch }),
      deploymentBlockNumber,
      { number: finalizedNumber, hash: finalizedHash },
      input.readBlockHash,
      lifecycleSignal,
      epoch,
    );

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

      const committed = await this.#repository.compareAndSwap(
        scope,
        durable,
        next,
        epoch,
      );
      if (committed === undefined) {
        // Another valid provider completion won the page. Reload its result
        // and continue from that cursor rather than overwriting or rescanning.
        durable = await this.#driveCheckpointAdmission(
          scope,
          await this.#repository.load(scope, { forceDurable: true, epoch }),
          deploymentBlockNumber,
          { number: finalizedNumber, hash: finalizedHash },
          input.readBlockHash,
          lifecycleSignal,
          epoch,
        );
        continue;
      }
      // A newer cache entry can belong to a concurrently scanned provider
      // fork. Keep this attempt on the checkpoint it reduced and admitted;
      // if another token wins the next CAS, that value is reloaded through
      // the admission driver before it can influence this attempt.
      durable = committed;
    }
  }

  /** Apply pure admission actions through one bounded, non-recursive effect loop. */
  async #driveCheckpointAdmission(
    scope: string,
    initial: ContextGraphAuthorityIndexRepositoryRecord,
    deploymentBlockNumber: number,
    finalized: Readonly<{ number: number; hash: string }>,
    readBlockHash: (
      blockNumber: number,
      lifecycleSignal: AbortSignal,
    ) => Promise<string | null>,
    lifecycleSignal: AbortSignal,
    epoch: number,
  ): Promise<ContextGraphAuthorityIndexRepositoryRecord> {
    let record = initial;
    let anchor: ContextGraphAuthorityIndexAnchorObservation =
      UNREAD_CONTEXT_GRAPH_AUTHORITY_INDEX_ANCHOR;
    let winnerReloads = 0;

    for (
      let effect = 0;
      effect < MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_RECOVERY_EFFECTS;
      effect += 1
    ) {
      lifecycleSignal.throwIfAborted();
      const action = classifyContextGraphAuthorityIndexAdmission({
        record,
        deploymentBlockNumber,
        finalized,
        anchor,
      });
      switch (action.kind) {
        case 'accept':
        case 'rebuild':
          return record;
        case 'read-anchor': {
          const hash = normalizeHash(await readBlockHash(
            action.blockNumber,
            lifecycleSignal,
          ));
          anchor = hash === undefined
            ? Object.freeze({ kind: 'unavailable' })
            : Object.freeze({ kind: 'available', hash });
          break;
        }
        case 'retry-provider':
          if (action.reason === 'finalized-behind') {
            throw retryableAuthorityIndexReadError(
              `Context Graph authority index finalized head ${action.finalizedBlockNumber} is behind `
              + `durable cursor ${action.cursorBlockNumber}`,
            );
          }
          throw retryableAuthorityIndexReadError(
            `Context Graph authority index anchor ${action.cursorBlockNumber} is unavailable`,
          );
        case 'invalidate': {
          this.#repository.discardIfCurrent(scope, record);
          if (record.token === undefined) {
            // The pure policy never emits invalidate for a missing row. Keep
            // this effect boundary total if a future action variant regresses.
            return record;
          }
          const invalidated = await this.#repository.invalidate(
            scope,
            record,
            epoch,
          );
          if (invalidated !== undefined) return invalidated;
          winnerReloads += 1;
          if (winnerReloads >= MAX_CONTEXT_GRAPH_AUTHORITY_INDEX_WINNER_RELOADS) {
            throw retryableAuthorityIndexReadError(
              'Context Graph authority index changed repeatedly during checkpoint recovery',
            );
          }
          record = await this.#repository.load(scope, {
            forceDurable: true,
            epoch,
          });
          anchor = UNREAD_CONTEXT_GRAPH_AUTHORITY_INDEX_ANCHOR;
          break;
        }
      }
    }
    throw retryableAuthorityIndexReadError(
      'Context Graph authority index exceeded its checkpoint recovery effect budget',
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
