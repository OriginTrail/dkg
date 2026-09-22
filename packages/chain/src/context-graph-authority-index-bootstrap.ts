// SPDX-License-Identifier: Apache-2.0

import { normalizeContextGraphAuthorityHash as normalizeHash } from
  './context-graph-authority-generation.js';
import { admitContextGraphAuthorityIndexCheckpoint } from
  './context-graph-authority-index-admission.js';
import type { ContextGraphAuthorityIndexActivity } from
  './context-graph-authority-index-activity.js';
import type { ContextGraphAuthorityIndexCheckpoint } from
  './context-graph-authority-index-checkpoint.js';
import { ContextGraphAuthorityIndexRetryableError } from
  './context-graph-authority-index-errors.js';
import type {
  ContextGraphAuthorityIndexRepositoryRecord,
  ContextGraphAuthorityIndexScopedRepository,
} from './context-graph-authority-index-repository.js';
import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS,
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MIN_TAIL_BLOCKS,
  CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_TAIL_BLOCKS,
  ContextGraphAuthorityIndexBootstrapUnavailableError,
  decodeContextGraphAuthorityIndexSnapshot,
  type ContextGraphAuthorityIndexBootstrap,
  type ContextGraphAuthorityIndexSnapshotRequest,
} from './context-graph-authority-index-snapshot.js';

interface BootstrapSessionInput {
  readonly request: ContextGraphAuthorityIndexSnapshotRequest;
  readonly finalized: Readonly<{ number: number; hash: string }>;
  readonly repository: ContextGraphAuthorityIndexScopedRepository;
  readonly lifecycleSignal: AbortSignal;
  readonly readBlockHash: (blockNumber: number, signal: AbortSignal) => Promise<string | null>;
  readonly onRejectedCheckpoint: () => void;
}

export interface ContextGraphAuthorityIndexBootstrapSession {
  needsSeed(durable: ContextGraphAuthorityIndexRepositoryRecord): boolean;
  seed(durable: ContextGraphAuthorityIndexRepositoryRecord): Promise<ContextGraphAuthorityIndexRepositoryRecord>;
  close(): void;
}

/** Owns trusted-seed admission and the sole per-scope failure cooldown. */
export class ContextGraphAuthorityIndexBootstrapCoordinator {
  readonly #failures = new Map<string, Readonly<{
    until: number;
    error: ContextGraphAuthorityIndexBootstrapUnavailableError;
  }>>();

  constructor(
    private readonly config: ContextGraphAuthorityIndexBootstrap,
    private readonly activity: ContextGraphAuthorityIndexActivity,
  ) {
    if (!Number.isSafeInteger(config.maxTailBlocks)
      || config.maxTailBlocks < CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MIN_TAIL_BLOCKS
      || config.maxTailBlocks > CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT_MAX_TAIL_BLOCKS
      || typeof config.trustDomain !== 'string' || config.trustDomain.trim().length === 0
      || config.trustDomain.length > 256
      || typeof config.fetchSnapshot !== 'function') {
      throw new TypeError('Context Graph authority index bootstrap configuration is invalid');
    }
  }

  clear(): void {
    this.#failures.clear();
  }

  /** One session lives for the entire scan, including reseeding after tail CAS loss. */
  start(input: BootstrapSessionInput): ContextGraphAuthorityIndexBootstrapSession {
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;
    const budget = (): AbortSignal => {
      if (signal === undefined) {
        const deadline = new AbortController();
        timer = setTimeout(() => deadline.abort(new Error(
          'Context Graph authority index snapshot bootstrap deadline exceeded',
        )), CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS);
        signal = AbortSignal.any([input.lifecycleSignal, deadline.signal]);
      }
      return signal;
    };
    return {
      needsSeed: (durable) => durable.kind !== 'checkpoint'
        || durable.checkpoint.cursor.throughBlockNumber < input.request.minThroughBlockNumber,
      seed: async (durable) => {
        const previousFailure = this.#failures.get(input.request.scope);
        if (previousFailure !== undefined && previousFailure.until > Date.now()) {
          throw previousFailure.error;
        }
        const budgetSignal = budget();
        try {
          budgetSignal.throwIfAborted();
          if (attempts >= 3) {
            throw new Error('Context Graph authority index snapshot changed repeatedly during import');
          }
          attempts += 1;
          const admitted = await this.#importSeed(input, durable, budgetSignal);
          budgetSignal.throwIfAborted();
          this.#failures.delete(input.request.scope);
          return admitted;
        } catch (cause) {
          input.lifecycleSignal.throwIfAborted();
          const error = cause instanceof ContextGraphAuthorityIndexBootstrapUnavailableError
            ? cause : new ContextGraphAuthorityIndexBootstrapUnavailableError(cause);
          this.#failures.set(input.request.scope, { until: Date.now() + error.retryAfterMs, error });
          throw error;
        }
      },
      close: () => { if (timer !== undefined) clearTimeout(timer); },
    };
  }

  async #importSeed(
    input: BootstrapSessionInput,
    durable: ContextGraphAuthorityIndexRepositoryRecord,
    budgetSignal: AbortSignal,
  ): Promise<ContextGraphAuthorityIndexRepositoryRecord> {
    const anchors = new Map<number, string | undefined>();
    const validate = async (value: unknown, attemptSignal = budgetSignal): Promise<ContextGraphAuthorityIndexCheckpoint> => {
      const validationSignal = attemptSignal === budgetSignal ? budgetSignal
        : AbortSignal.any([budgetSignal, attemptSignal]);
      validationSignal.throwIfAborted();
      const seed = decodeContextGraphAuthorityIndexSnapshot(value, input.request);
      if (seed === undefined) {
        throw new ContextGraphAuthorityIndexRetryableError(
          'Context Graph authority index trusted snapshot is invalid or outside the tail budget',
        );
      }
      const blockNumber = seed.cursor.throughBlockNumber;
      if (!anchors.has(blockNumber)) {
        anchors.set(blockNumber, blockNumber === input.finalized.number ? input.finalized.hash
          : normalizeHash(await input.readBlockHash(blockNumber, validationSignal)));
      }
      validationSignal.throwIfAborted();
      if (anchors.get(blockNumber) !== seed.cursor.throughBlockHash) {
        throw new ContextGraphAuthorityIndexRetryableError(
          'Context Graph authority index trusted snapshot anchor is unavailable or replaced',
        );
      }
      return seed;
    };
    const value = await this.activity.run(budgetSignal, () => this.config.fetchSnapshot(
      input.request, budgetSignal,
      async (candidate, attemptSignal) => {
        const validationSignal = attemptSignal === undefined ? budgetSignal
          : AbortSignal.any([budgetSignal, attemptSignal]);
        // A peer may stop waiting before its validation RPC settles.
        await this.activity.run(validationSignal, () => validate(candidate, validationSignal));
      },
    ));
    const seed = await this.activity.run(budgetSignal, () => validate(value));
    budgetSignal.throwIfAborted();
    // Repository signal checks fence winner reload/cache publication after a
    // timeout. The physical atomic write stays owned until it settles.
    const commit = await this.activity.run(budgetSignal, () => (
      input.repository.commitOrReloadWinner(durable, seed, budgetSignal)
    ));
    budgetSignal.throwIfAborted();
    return commit.kind === 'committed' ? commit.record
      : this.activity.run(budgetSignal, () => admitContextGraphAuthorityIndexCheckpoint({
          repository: input.repository,
          initial: commit.record,
          deploymentBlockNumber: input.request.deploymentBlockNumber,
          finalized: input.finalized,
          readBlockHash: input.readBlockHash,
          lifecycleSignal: budgetSignal,
          onRejectedCheckpoint: input.onRejectedCheckpoint,
        }));
  }
}
