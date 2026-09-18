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
import {
  authorityIndexSnapshotWithinSizeLimit,
  decodeContextGraphAuthorityIndexSnapshot,
  isContextGraphAuthorityIndexSnapshotRequest,
  type ContextGraphAuthorityIndexBootstrap,
  type ContextGraphAuthorityIndexSnapshot,
  type ContextGraphAuthorityIndexSnapshotRequest,
} from './context-graph-authority-index-snapshot.js';

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
  /**
   * How far below the resolved anchor the DURABLE cursor may ratchet.
   *
   * The anchor is the operator's, and at the default depth it is the HEAD — a
   * block a reorg can take away. The cursor is not a finality decision, it is a
   * memo of "I have already reduced the log history to here", and a memo pinned
   * to a reorgable block is worse than no memo: `admit…Checkpoint` re-reads the
   * hash at the cursor height, and a single-block tip reorg makes it mismatch
   * and throw the WHOLE materialized index away, rescanning from the contract
   * deployment block. A cursor recorded at one endpoint's head also sits ABOVE
   * a sibling endpoint's head, and nothing can lower it.
   *
   * So the anchor and the cursor are separated: reads still project all the way
   * to the anchor — that is the window this hotfix exists to close — but only
   * the part below this horizon is written down. The tail is re-reduced in
   * memory each read, one bounded extra `readPage`.
   *
   * `0` (the default) writes the cursor at the anchor, which is the behaviour
   * before this option existed. A caller that omits it is therefore unchanged,
   * not newly exposed.
   */
  readonly durableReorgHoldbackBlocks?: number;
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
  readonly #activeScans = new Set<Promise<unknown>>();
  readonly #servable = new Map<string, ContextGraphAuthorityIndexCheckpoint>();
  #closed = false;
  #activityRevision = 0;
  #lifecycleAbort = new AbortController();

  constructor(
    readonly localStore: ContextGraphAuthorityIndexStore,
    private readonly bootstrap?: ContextGraphAuthorityIndexBootstrap,
  ) {
    if (bootstrap !== undefined && (
      !Number.isSafeInteger(bootstrap.maxTailBlocks)
      || bootstrap.maxTailBlocks < 50 || bootstrap.maxTailBlocks > 10_000
      || typeof bootstrap.trustDomain !== 'string' || bootstrap.trustDomain.trim().length === 0
      || bootstrap.trustDomain.length > 256
      || typeof bootstrap.fetchSnapshot !== 'function'
    )) throw new TypeError('Context Graph authority index bootstrap configuration is invalid');
    this.#repository = new ContextGraphAuthorityIndexRepository(localStore);
  }

  /** The caller must bind requests to this adapter's own initialized scope. */
  exportSnapshot(
    request: ContextGraphAuthorityIndexSnapshotRequest,
  ): ContextGraphAuthorityIndexSnapshot | null {
    if (this.#closed || this.bootstrap !== undefined
      || !isContextGraphAuthorityIndexSnapshotRequest(request)) return null;
    const checkpoint = this.#servable.get(request.scope);
    if (checkpoint === undefined
      || checkpoint.cursor.deploymentBlockNumber !== request.deploymentBlockNumber
      || checkpoint.cursor.throughBlockNumber < request.minThroughBlockNumber
      || checkpoint.cursor.throughBlockNumber > request.maxThroughBlockNumber) return null;
    const snapshot = Object.freeze({ version: 1 as const, scope: request.scope, checkpoint });
    return authorityIndexSnapshotWithinSizeLimit(snapshot) ? snapshot : null;
  }

  async refresh(input: ContextGraphAuthorityIndexScanInput): Promise<void> {
    await this.#snapshot(input);
  }

  open(): void {
    this.#closed = false;
  }

  close(): Promise<void> {
    this.#closed = true;
    this.clear();
    return this.whenIdle();
  }

  clear(): void {
    this.#lifecycleAbort.abort(new DOMException(
      'Context Graph authority index lifecycle cleared',
      'AbortError',
    ));
    this.#lifecycleAbort = new AbortController();
    this.#repository.clear();
    this.#servable.clear();
    this.#singleFlight.invalidateAll();
  }

  /** Wait until every lifecycle-owned physical scan has settled. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const activityRevision = this.#activityRevision;
      await Promise.allSettled(this.#activeScans);
      if (
        activityRevision === this.#activityRevision
        && this.#activeScans.size === 0
      ) return;
    }
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
    if (this.#closed) throw new DOMException('Context Graph authority index is closed', 'AbortError');
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
      const scan = this.#scan({ ...input, scope, finalized: {
        number: input.finalized.number,
        hash: finalizedHash,
      } }, lifecycleSignal);
      this.#activityRevision += 1;
      this.#activeScans.add(scan);
      void scan.finally(() => {
        this.#activeScans.delete(scan);
      }).catch(() => undefined);
      return scan;
    });
    return waitForSharedAuthorityIndexScan(pending, input.signal);
  }

  async #scan(
    input: ContextGraphAuthorityIndexScanInput,
    lifecycleSignal: AbortSignal,
  ): Promise<ContextGraphAuthorityIndexCheckpoint> {
    const scope = input.scope;
    // Imported authority is never promoted into an independently scanned index
    // after a trust-policy change or when snapshot bootstrap is disabled.
    const repositoryScope = this.bootstrap === undefined ? scope
      : `${scope}:trusted-bootstrap:${this.bootstrap.trustDomain}`;
    const repository = this.#repository.forScope(repositoryScope);
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

    // Highest block this scan may WRITE DOWN. Never below the deployment block:
    // holding the cursor back past the start of history would persist nothing.
    const holdback = normalizeNonNegativeSafeInteger(
      input.durableReorgHoldbackBlocks ?? 0,
    ) ?? 0;
    const persistThroughBlockNumber = Math.max(
      deploymentBlockNumber,
      finalizedNumber - holdback,
    );
    const bootstrap = this.bootstrap;
    const minimumSeedBlock = bootstrap === undefined ? deploymentBlockNumber
      : Math.max(deploymentBlockNumber, finalizedNumber - bootstrap.maxTailBlocks);
    if (bootstrap !== undefined && minimumSeedBlock > persistThroughBlockNumber) {
      throw new ContextGraphAuthorityIndexRetryableError(
        'Context Graph authority index tail budget is below the durable reorg holdback',
      );
    }
    let seedAttempts = 0;
    let scannedBlocks = 0;
    // Set once the scan passes the horizon; from then on nothing is committed.
    let tail: ContextGraphAuthorityIndexCheckpoint | undefined;

    for (;;) {
      lifecycleSignal.throwIfAborted();
      if (bootstrap !== undefined && tail === undefined && (
        durable.kind !== 'checkpoint'
        || durable.checkpoint.cursor.throughBlockNumber < minimumSeedBlock
      )) {
        if (seedAttempts >= 3) {
          throw new ContextGraphAuthorityIndexRetryableError(
            'Context Graph authority index snapshot changed repeatedly during import',
          );
        }
        seedAttempts += 1;
        const request: ContextGraphAuthorityIndexSnapshotRequest = Object.freeze({
          scope,
          deploymentBlockNumber,
          minThroughBlockNumber: minimumSeedBlock,
          maxThroughBlockNumber: persistThroughBlockNumber,
        });
        const anchors = new Map<number, string | undefined>();
        const validateSnapshot = async (
          value: unknown,
          attemptSignal?: AbortSignal,
        ): Promise<ContextGraphAuthorityIndexCheckpoint> => {
          const validationSignal = attemptSignal === undefined ? lifecycleSignal
            : AbortSignal.any([lifecycleSignal, attemptSignal]);
          validationSignal.throwIfAborted();
          const seed = decodeContextGraphAuthorityIndexSnapshot(value, request);
          if (seed === undefined) {
            throw new ContextGraphAuthorityIndexRetryableError(
              'Context Graph authority index trusted snapshot is invalid or outside the tail budget',
            );
          }
          const blockNumber = seed.cursor.throughBlockNumber;
          if (!anchors.has(blockNumber)) {
            anchors.set(blockNumber, blockNumber === finalizedNumber ? finalizedHash
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
        const value = await bootstrap.fetchSnapshot(request, lifecycleSignal,
          async (candidate, signal) => { await validateSnapshot(candidate, signal); });
        const seed = await validateSnapshot(value);
        const commit = await repository.commitOrReloadWinner(durable, seed);
        durable = commit.kind === 'committed' ? commit.record
          : await admitContextGraphAuthorityIndexCheckpoint({
              repository,
              initial: commit.record,
              deploymentBlockNumber,
              finalized: { number: finalizedNumber, hash: finalizedHash },
              readBlockHash: input.readBlockHash,
              lifecycleSignal,
            });
        continue;
      }
      const checkpoint = tail ?? (durable.kind === 'checkpoint'
        ? durable.checkpoint
        : undefined);
      if (checkpoint !== undefined && checkpoint.cursor.throughBlockNumber === finalizedNumber) {
        if (durable.kind === 'checkpoint') this.#servable.set(scope, durable.checkpoint);
        return checkpoint;
      }

      const fromBlockNumber = checkpoint === undefined
        ? deploymentBlockNumber
        : checkpoint.cursor.throughBlockNumber + 1;
      // A page that straddles the horizon is clamped to it, so the durable part
      // is still written down and the next iteration reduces the tail in memory.
      const committing = tail === undefined && fromBlockNumber <= persistThroughBlockNumber;
      const pageThroughBlockNumber = Math.min(
        fromBlockNumber + pageSize - 1,
        finalizedNumber,
      );
      const throughBlockNumber = committing
        ? Math.min(pageThroughBlockNumber, persistThroughBlockNumber)
        : pageThroughBlockNumber;
      if (bootstrap !== undefined
        && scannedBlocks + throughBlockNumber - fromBlockNumber + 1 > bootstrap.maxTailBlocks) {
        throw new ContextGraphAuthorityIndexRetryableError(
          'Context Graph authority index local tail scan budget exhausted',
        );
      }
      const throughBlockHash = throughBlockNumber === finalizedNumber
        ? finalizedHash
        : normalizeHash(await input.readBlockHash(throughBlockNumber, lifecycleSignal));
      if (throughBlockHash === undefined) {
        throw new ContextGraphAuthorityIndexRetryableError(
          `Context Graph authority index block ${throughBlockNumber} is unavailable`,
        );
      }

      scannedBlocks += throughBlockNumber - fromBlockNumber + 1;
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

      if (!committing) {
        // Above the reorg horizon: project, do not persist.
        tail = next;
        continue;
      }

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
