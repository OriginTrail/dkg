// SPDX-License-Identifier: Apache-2.0

import {
  contextGraphAuthorityIndexStateRevision,
  type ContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexState,
  type ContextGraphAuthorityIndexStore,
} from './context-graph-authority-index-checkpoint.js';
import type { ContextGraphAuthorityIndexId } from
  './context-graph-authority-index-id.js';
import {
  normalizeContextGraphAuthorityHash as normalizeHash,
  normalizeContextGraphAuthorityNonNegativeSafeInteger as normalizeNonNegativeSafeInteger,
} from './context-graph-authority-generation.js';
import {
  reduceContextGraphAuthorityIndexPage,
  type RawContextGraphAuthorityIndexEvent,
} from './context-graph-authority-index-reducer.js';
import {
  admitContextGraphAuthorityIndexCheckpoint,
} from './context-graph-authority-index-admission.js';
import { ContextGraphAuthorityIndexRetryableError } from
  './context-graph-authority-index-errors.js';
import { ContextGraphAuthorityIndexRepository } from
  './context-graph-authority-index-repository.js';
import { KeyedSingleFlight } from './keyed-ttl-single-flight-cache.js';

const ZERO_HASH = `0x${'00'.repeat(32)}`;

export {
  ContextGraphAuthorityIndexRetryableError,
  isContextGraphAuthorityIndexRetryableError,
} from './context-graph-authority-index-errors.js';

export interface ContextGraphAuthorityIndexScanInput {
  /** Deployment + physical ContextGraphStorage address; contains no secret. */
  readonly scope: string;
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
  ) => Promise<readonly RawContextGraphAuthorityIndexEvent[]>;
}

export interface ContextGraphAuthorityIndexResolveInput
  extends ContextGraphAuthorityIndexScanInput {
  readonly contextGraphId: ContextGraphAuthorityIndexId;
}

export interface ContextGraphAuthorityIndexRevisionInput
  extends ContextGraphAuthorityIndexScanInput {
  readonly contextGraphIds: readonly ContextGraphAuthorityIndexId[];
}

export interface ContextGraphAuthorityIndexNameHashInput
  extends ContextGraphAuthorityIndexScanInput {
  readonly nameHash: string;
}

export interface ContextGraphAuthorityIndexNameHashesInput
  extends ContextGraphAuthorityIndexScanInput {
  readonly nameHashes: readonly string[];
}
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
    input: ContextGraphAuthorityIndexResolveInput,
  ): Promise<ContextGraphAuthorityIndexState> {
    const checkpoint = await this.#snapshot(input);
    // Target lookup intentionally happens after the shared contract scan, so
    // every waiter resolves its own graph from the same complete checkpoint.
    return this.#requireState(checkpoint, input.contextGraphId);
  }

  /** Project opaque revisions without exposing persisted checkpoint internals. */
  async revisions(
    input: ContextGraphAuthorityIndexRevisionInput,
  ): Promise<ReadonlyMap<ContextGraphAuthorityIndexId, string>> {
    const targetIds = new Set<ContextGraphAuthorityIndexId>(input.contextGraphIds);
    const checkpoint = await this.#snapshot(input);
    const revisions = new Map<ContextGraphAuthorityIndexId, string>();
    for (const state of checkpoint.states) {
      if (targetIds.has(state.contextGraphId)) {
        revisions.set(state.contextGraphId, contextGraphAuthorityIndexStateRevision(state));
      }
    }
    return revisions;
  }

  /** Project the minimal immutable/read-selection fields for many targets. */
  async states(
    input: ContextGraphAuthorityIndexRevisionInput,
  ): Promise<ReadonlyMap<ContextGraphAuthorityIndexId, ContextGraphAuthorityIndexState>> {
    const targetIds = new Set<ContextGraphAuthorityIndexId>(input.contextGraphIds);
    const checkpoint = await this.#snapshot(input);
    const states = new Map<ContextGraphAuthorityIndexId, ContextGraphAuthorityIndexState>();
    for (const state of checkpoint.states) {
      if (!targetIds.has(state.contextGraphId)) continue;
      states.set(state.contextGraphId, state);
    }
    return states;
  }

  /** Resolve one unique name commitment from the shared contract-wide snapshot. */
  async resolveNameHash(
    input: ContextGraphAuthorityIndexNameHashInput,
  ): Promise<ContextGraphAuthorityIndexId | null> {
    const nameHash = normalizeHash(input.nameHash);
    if (nameHash === undefined) {
      throw new Error('Context Graph authority index name hash is invalid');
    }
    // ContextGraphStorage permits an explicit zero commitment as an opt-out.
    // It never participates in reverse name binding, even if several slots use it.
    if (nameHash === ZERO_HASH) return null;
    const matches = await this.statesByNameHashes({
      ...input,
      nameHashes: [nameHash],
    });
    return matches.get(nameHash)?.contextGraphId ?? null;
  }

  /**
   * Project unique name commitments and their complete authority states from
   * one checkpoint. Missing and zero-hash targets are omitted; any duplicate
   * finalized commitment fails the whole projection closed.
   */
  async statesByNameHashes(
    input: ContextGraphAuthorityIndexNameHashesInput,
  ): Promise<ReadonlyMap<string, ContextGraphAuthorityIndexState>> {
    const targets = new Set<string>();
    for (const rawNameHash of input.nameHashes) {
      const nameHash = normalizeHash(rawNameHash);
      if (nameHash === undefined) {
        throw new Error('Context Graph authority index name hash is invalid');
      }
      if (nameHash !== ZERO_HASH) targets.add(nameHash);
    }
    if (targets.size === 0) return new Map();

    const checkpoint = await this.#snapshot(input);
    const states = new Map<string, ContextGraphAuthorityIndexState>();
    const counts = new Map<string, number>();
    for (const state of checkpoint.states) {
      if (!targets.has(state.nameHash)) continue;
      counts.set(state.nameHash, (counts.get(state.nameHash) ?? 0) + 1);
      states.set(state.nameHash, state);
    }
    for (const [nameHash, count] of counts) {
      if (count <= 1) continue;
      throw new Error(
        `Context Graph name hash ${nameHash} is ambiguous across ` +
        `${count} finalized Context Graphs`,
      );
    }
    return states;
  }

  /** Resolve the complete materialized index at one finalized chain anchor. */
  async #snapshot(
    input: ContextGraphAuthorityIndexScanInput,
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
    input: ContextGraphAuthorityIndexScanInput,
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
    contextGraphId: ContextGraphAuthorityIndexId,
  ): ContextGraphAuthorityIndexState {
    const state = checkpoint.states.find((candidate) => (
      candidate.contextGraphId === contextGraphId
    ));
    if (state === undefined) {
      throw new Error(`Context Graph ${contextGraphId} has no finalized creation event`);
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
