// SPDX-License-Identifier: Apache-2.0

import {
  type ContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexStore,
} from './context-graph-authority-index-checkpoint.js';
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
import {
  ContextGraphAuthorityIndexRepository,
  type ContextGraphAuthorityIndexAdmittedRepositoryRecord,
  type ContextGraphAuthorityIndexRepositoryRecord,
} from './context-graph-authority-index-repository.js';
import {
  ContextGraphAuthorityIndexProjectionCache,
  ContextGraphAuthorityIndexView,
  type ContextGraphAuthorityIndexProjectionOptions,
  type ContextGraphAuthorityIndexProjectionReadInput,
} from './context-graph-authority-index-projection.js';
import {
  ContextGraphAuthorityIndexHorizonCoordinator,
  type ContextGraphAuthorityIndexRefreshHorizonLease,
} from './context-graph-authority-index-horizon.js';
import { ContextGraphAuthorityIndexBootstrapCoordinator } from
  './context-graph-authority-index-bootstrap.js';
import { ContextGraphAuthorityIndexActivity } from
  './context-graph-authority-index-activity.js';
import { waitForSignal } from './wait-for-signal.js';
import {
  authorityIndexSnapshotWithinSizeLimit,
  ContextGraphAuthorityIndexSnapshotExportError,
  ContextGraphAuthorityIndexBootstrapUnavailableError,
  isContextGraphAuthorityIndexSnapshotRequest,
  type ContextGraphAuthorityIndexBootstrap,
  type ContextGraphAuthorityIndexSnapshot,
  type ContextGraphAuthorityIndexSnapshotRequest,
} from './context-graph-authority-index-snapshot.js';

const MAX_SERVABLE_CHECKPOINTS = 8;

/** Bootstrap observers only watch the scan: a throwing one must never fail it. */
function notify<T>(observer: ((info: T) => void) | undefined, info: T): void {
  if (observer === undefined) return;
  try {
    observer(info);
  } catch {
    // Observability only.
  }
}

/** The coordinator's own error, or the same failure raised by another copy of this package. */
function isBootstrapUnavailable(error: unknown): boolean {
  return error instanceof ContextGraphAuthorityIndexBootstrapUnavailableError
    || (typeof error === 'object' && error !== null
      && (error as { code?: unknown }).code === 'AUTHORITY_INDEX_BOOTSTRAP_UNAVAILABLE');
}

type ServableCheckpoint = Readonly<{
  deploymentBlockNumber: number;
  throughBlockNumber: number;
  /** Oversized checkpoints retain only metadata; cached wire payloads total at most 64 MiB. */
  snapshot?: ContextGraphAuthorityIndexSnapshot;
}>;

type ContextGraphAuthorityIndexScanFlight = Readonly<{
  promise: Promise<ContextGraphAuthorityIndexCheckpoint>;
  /** Active joiners promote the physical owner's lease synchronously. */
  activate(): void;
}>;

export {
  ContextGraphAuthorityIndexRetryableError,
  isContextGraphAuthorityIndexRetryableError,
} from './context-graph-authority-index-errors.js';

export interface ContextGraphAuthorityIndexScanInput {
  /** Deployment + physical ContextGraphStorage address; contains no secret. */
  readonly scope: string;
  /** Physical RPC reader identity; isolates a timed-out provider attempt. */
  readonly readScope: object;
  /**
   * Optional immutable generation of the rows exposed by `readScope`.
   *
   * A long-lived local reader can replace its rows while retaining the same
   * object identity and finalized block. Such generations must not join one
   * physical flight because its stabilization fence belongs to the generation
   * that started it. Provider readers omit this and retain the previous key.
   */
  readonly readGeneration?: string;
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
  /** Final provider/log-generation fence owned by the physical scan. */
  readonly stabilize?: (lifecycleSignal: AbortSignal) => Promise<void>;
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
  readonly #flights = new Map<string, Map<object, ContextGraphAuthorityIndexScanFlight>>();
  readonly #activity = new ContextGraphAuthorityIndexActivity();
  readonly #horizons: ContextGraphAuthorityIndexHorizonCoordinator;
  readonly #bootstrapCoordinator: ContextGraphAuthorityIndexBootstrapCoordinator | undefined;
  readonly #servable = new Map<string, readonly ServableCheckpoint[]>();
  readonly #servableEpochs = new Map<string, number>();
  /**
   * Last completed, TAIL-INCLUSIVE projection per scope. Strictly separate
   * from `#servable`: `exportSnapshot` reads only that map, so the unsettled
   * tail a cached projection carries can never be served to an edge.
   */
  readonly #projections: ContextGraphAuthorityIndexProjectionCache;
  #closed = false;
  #lifecycleAbort = new AbortController();
  /** New generations cannot read durable state until pre-clear physical work drains. */
  #lifecycleDrain: Promise<void> | undefined;

  constructor(
    readonly localStore: ContextGraphAuthorityIndexStore,
    private readonly bootstrap?: ContextGraphAuthorityIndexBootstrap,
    projection: ContextGraphAuthorityIndexProjectionOptions = {},
  ) {
    let projections!: ContextGraphAuthorityIndexProjectionCache;
    this.#horizons = new ContextGraphAuthorityIndexHorizonCoordinator({
      onConstraintChanged: (scope) => { projections.refreshHorizonChanged(scope); },
      onProjectionInvalidated: (scope) => { projections.dropProjection(scope); },
    });
    projections = new ContextGraphAuthorityIndexProjectionCache(projection, this.#horizons);
    this.#projections = projections;
    this.#bootstrapCoordinator = bootstrap === undefined ? undefined
      : new ContextGraphAuthorityIndexBootstrapCoordinator(bootstrap, this.#activity);
    this.#repository = new ContextGraphAuthorityIndexRepository(localStore);
  }

  /** The resolved `chain.indexTickMs` this index answers finalized reads for. */
  get projectionTickMs(): number {
    return this.#projections.tickMs;
  }

  /**
   * A structurally valid durable prefix the one-log migration may resume above.
   *
   * This does not admit the checkpoint against a live chain view; authority
   * reads still perform that fence themselves. It only prevents the raw log
   * from immediately rescanning history the already-materialized checkpoint
   * can supply while bounded backfill independently walks down to the floor.
   */
  async durableCursorBlockNumber(
    scope: string,
    deploymentBlockNumber: number,
  ): Promise<number | undefined> {
    if (this.#closed) return undefined;
    const lifecycleSignal = this.#lifecycleAbort.signal;
    const lifecycleDrain = this.#lifecycleDrain;
    if (lifecycleDrain !== undefined) {
      await this.#waitForLifecycleDrain(lifecycleDrain, lifecycleSignal);
    }
    if (this.#closed) return undefined;
    const record = await this.#repository.forScope(scope).load();
    lifecycleSignal.throwIfAborted();
    if (this.#closed) return undefined;
    if (record.kind !== 'checkpoint'
      || record.checkpoint.cursor.deploymentBlockNumber !== deploymentBlockNumber) {
      return undefined;
    }
    return record.checkpoint.cursor.throughBlockNumber;
  }

  /**
   * Read-your-writes. This node just submitted an authority transaction, so
   * every projection scanned before it is known to be out of date — including
   * as a stale-if-error answer. The durable index is untouched: the next read
   * is one ordinary incremental refresh.
   */
  dropProjections(): void {
    this.#projections.dropAll();
  }

  /** The caller must bind requests to this adapter's own initialized scope. */
  exportSnapshot(
    request: ContextGraphAuthorityIndexSnapshotRequest,
  ): ContextGraphAuthorityIndexSnapshot | null {
    if (this.#closed || this.bootstrap !== undefined
      || !isContextGraphAuthorityIndexSnapshotRequest(request)) return null;
    const candidates = this.#servable.get(request.scope)?.filter((candidate) => (
      candidate.deploymentBlockNumber === request.deploymentBlockNumber
    ));
    if (!candidates?.length) return null;
    const compatible = candidates.filter((candidate) => (
      candidate.throughBlockNumber >= request.minThroughBlockNumber
      && candidate.throughBlockNumber <= request.maxThroughBlockNumber
    ));
    const snapshot = compatible.find((candidate) => candidate.snapshot !== undefined)?.snapshot;
    if (snapshot !== undefined) return snapshot;
    if (compatible.length > 0) throw new ContextGraphAuthorityIndexSnapshotExportError('too-large');
    if (candidates.every((candidate) => candidate.throughBlockNumber > request.maxThroughBlockNumber)) {
      throw new ContextGraphAuthorityIndexSnapshotExportError('above-range');
    }
    if (candidates.every((candidate) => candidate.throughBlockNumber < request.minThroughBlockNumber)) {
      throw new ContextGraphAuthorityIndexSnapshotExportError('below-range');
    }
    throw new ContextGraphAuthorityIndexSnapshotExportError('unavailable');
  }

  /**
   * Publishes ONLY the holdback-clamped durable cursor. The in-memory `tail`
   * of a live scan sits above every requester's `maxThroughBlockNumber` and is
   * not reorg-settled, so it must never reach this method.
   */
  #rememberServable(scope: string, durableCheckpoint: ContextGraphAuthorityIndexCheckpoint): void {
    // An index with bootstrap never serves, whichever repository its scan ended
    // on: the trust-domain checkpoint may be imported, and this map is keyed by
    // scope alone, so it could not tell that one from a fallback's plain-scope
    // checkpoint.
    if (this.bootstrap !== undefined) return;
    const snapshot = Object.freeze({ version: 1 as const, scope, checkpoint: durableCheckpoint });
    const entry: ServableCheckpoint = Object.freeze({
      deploymentBlockNumber: durableCheckpoint.cursor.deploymentBlockNumber,
      throughBlockNumber: durableCheckpoint.cursor.throughBlockNumber,
      ...(authorityIndexSnapshotWithinSizeLimit(snapshot) ? { snapshot } : {}),
    });
    const entries = (this.#servable.get(scope) ?? []).filter((candidate) => (
      candidate.deploymentBlockNumber === entry.deploymentBlockNumber
      && candidate.throughBlockNumber !== entry.throughBlockNumber
    ));
    this.#servable.set(scope, [...entries, entry]
      .sort((a, b) => b.throughBlockNumber - a.throughBlockNumber)
      .slice(0, MAX_SERVABLE_CHECKPOINTS));
  }

  async refresh(input: ContextGraphAuthorityIndexScanInput): Promise<void> {
    input.signal?.throwIfAborted();
    await this.#snapshot(input, 'active');
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
    // Stores may finish an already-dispatched CAS after observing cancellation.
    // Fence the replacement lifecycle before clearing caches: no new scan may
    // admit the CAS's old token while that physical mutation is still pending.
    const lifecycleDrain = this.#activity.drainPending();
    this.#lifecycleDrain = lifecycleDrain;
    if (lifecycleDrain !== undefined) {
      void lifecycleDrain.then(() => {
        if (this.#lifecycleDrain === lifecycleDrain) this.#lifecycleDrain = undefined;
      });
    }
    this.#repository.clear();
    this.#servable.clear();
    this.#servableEpochs.clear();
    this.#horizons.clear();
    this.#projections.clear();
    this.#bootstrapCoordinator?.clear();
    this.#flights.clear();
  }

  /** Wait until every lifecycle-owned physical scan has settled. */
  whenIdle(): Promise<void> {
    return this.#activity.whenIdle();
  }

  /**
   * Answer ONLY from the last completed projection, or report a miss.
   *
   * The counterpart to {@link projection} for a caller that prefers a local
   * answer but does not need one. See
   * `ContextGraphAuthorityIndexProjectionCache.peek` for why a miss must not
   * escalate into the paged scan `projection` would perform.
   */
  async peekProjection<T>(
    input: Omit<ContextGraphAuthorityIndexProjectionReadInput<T>, 'refresh'>,
  ): Promise<Readonly<{ hit: true; value: T } | { hit: false }>> {
    if (this.#closed) throw new DOMException('Context Graph authority index is closed', 'AbortError');
    return this.#projections.peek(input);
  }

  /**
   * Answer from the last completed projection of `input.scope` while it is
   * younger than `chain.indexTickMs`, otherwise through `input.refresh` — the
   * caller's complete read, which ends in {@link view}. See
   * `ContextGraphAuthorityIndexProjectionCache` for the staleness contract.
   */
  async projection<T>(input: ContextGraphAuthorityIndexProjectionReadInput<T>): Promise<T> {
    if (this.#closed) throw new DOMException('Context Graph authority index is closed', 'AbortError');
    return this.#projections.read(input);
  }

  /** Fail a provider attempt that trails the durable refresh already observed. */
  assertProjectionAtRefreshHorizon(
    scope: string,
    finalized: Readonly<{ number: number; hash: string }>,
  ): void {
    if (this.#closed) {
      throw new DOMException('Context Graph authority index is closed', 'AbortError');
    }
    this.#horizons.assertAtOrAbove(scope.trim(), finalized);
  }

  /** One fresh scan to the anchor, behind the checkpoint-private projections. */
  async view(input: ContextGraphAuthorityIndexScanInput): Promise<ContextGraphAuthorityIndexView> {
    const scope = input.scope.trim();
    const view = new ContextGraphAuthorityIndexView(await this.#snapshot(input, 'on-rejection'));
    this.assertProjectionAtRefreshHorizon(scope, input.finalized);
    return view;
  }

  /** Resolve the complete materialized index at one finalized chain anchor. */
  async #snapshot(
    input: ContextGraphAuthorityIndexScanInput,
    horizonMode: 'active' | 'on-rejection',
  ): Promise<ContextGraphAuthorityIndexCheckpoint> {
    input.signal?.throwIfAborted();
    if (this.#closed) throw new DOMException('Context Graph authority index is closed', 'AbortError');
    const lifecycleSignal = this.#lifecycleAbort.signal;
    const lifecycleDrain = this.#lifecycleDrain;
    if (lifecycleDrain !== undefined) {
      await this.#waitForLifecycleDrain(lifecycleDrain, lifecycleSignal, input.signal);
    }
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
    const scanKey = [
      scope,
      input.finalized.number,
      finalizedHash,
      input.readGeneration ?? '',
    ].join('\u0000');
    const flight = this.#scanFlight(scanKey, input.readScope, {
      ...input,
      scope,
      finalized: { number: input.finalized.number, hash: finalizedHash },
    }, lifecycleSignal);
    if (horizonMode === 'active') flight.activate();
    return waitForSignal(flight.promise, input.signal);
  }

  /** Open or join one physical scan and its sole durable horizon lease. */
  #scanFlight(
    scanKey: string,
    readScope: object,
    input: ContextGraphAuthorityIndexScanInput,
    lifecycleSignal: AbortSignal,
  ): ContextGraphAuthorityIndexScanFlight {
    let variants = this.#flights.get(scanKey);
    const existing = variants?.get(readScope);
    if (existing !== undefined) return existing;
    if (variants === undefined) {
      variants = new Map();
      this.#flights.set(scanKey, variants);
    }

    const horizonLease = this.#horizons.begin(input.scope, input.finalized);
    let flight!: ContextGraphAuthorityIndexScanFlight;
    const physical = this.#scan(input, lifecycleSignal, horizonLease);
    // The exposed promise settles only after its lease and registry entry do.
    // A resolved inactive flight therefore cannot be joined and promoted too late.
    const settled = physical.then(
      (checkpoint) => {
        try {
          horizonLease.commit();
          return checkpoint;
        } finally {
          this.#removeScanFlight(scanKey, readScope, flight);
        }
      },
      (error: unknown) => {
        try {
          horizonLease.rollback();
        } finally {
          this.#removeScanFlight(scanKey, readScope, flight);
        }
        throw error;
      },
    );
    flight = Object.freeze({
      promise: this.#activity.track(settled),
      activate: () => { horizonLease.activate(); },
    });
    variants.set(readScope, flight);
    return flight;
  }

  /** Bind one pre-scan drain wait to the lifecycle generation that requested it. */
  async #waitForLifecycleDrain(
    lifecycleDrain: Promise<void>,
    lifecycleSignal: AbortSignal,
    callerSignal?: AbortSignal,
  ): Promise<void> {
    callerSignal?.throwIfAborted();
    lifecycleSignal.throwIfAborted();
    const waitSignal = callerSignal === undefined
      ? lifecycleSignal
      : AbortSignal.any([callerSignal, lifecycleSignal]);
    await waitForSignal(lifecycleDrain, waitSignal);
    callerSignal?.throwIfAborted();
    lifecycleSignal.throwIfAborted();
  }

  #removeScanFlight(
    scanKey: string,
    readScope: object,
    flight: ContextGraphAuthorityIndexScanFlight,
  ): void {
    const variants = this.#flights.get(scanKey);
    if (variants?.get(readScope) !== flight) return;
    variants.delete(readScope);
    if (variants.size === 0) this.#flights.delete(scanKey);
  }

  async #scan(
    input: ContextGraphAuthorityIndexScanInput,
    lifecycleSignal: AbortSignal,
    horizonLease: ContextGraphAuthorityIndexRefreshHorizonLease,
  ): Promise<ContextGraphAuthorityIndexCheckpoint> {
    const scope = input.scope;
    // Imported authority is never promoted into an independently scanned index
    // after a trust-policy change or when snapshot bootstrap is disabled. The
    // plain scope IS that independent index: a seeded scan keeps to its
    // trust-domain key, and only the local-history fallback below moves here.
    let repository = this.#repository.forScope(this.bootstrap === undefined ? scope
      : `${scope}:trusted-bootstrap:${this.bootstrap.trustDomain}`);
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

    let servableEpoch = this.#servableEpochs.get(scope) ?? 0;
    const onRejectedCheckpoint = (
      repositoryKey: string,
      rejectedToken: number,
    ): void => {
      // The tombstone voids everything reduced on top of that checkpoint,
      // including the projection readers are still being answered from. Keep
      // this scan's horizon: its physical work outlives a cancelled waiter.
      horizonLease.markCheckpointRejected(repositoryKey, rejectedToken);
      this.#servable.delete(scope);
      servableEpoch = (this.#servableEpochs.get(scope) ?? 0) + 1;
      this.#servableEpochs.set(scope, servableEpoch);
    };
    // The one admission path for every durable record this scan adopts: the
    // one it starts from, a CAS winner, and the plain-scope checkpoint the
    // fallback resumes from. Reads `repository` at call time on purpose.
    const admit = async (
      initial: ContextGraphAuthorityIndexRepositoryRecord,
    ): Promise<ContextGraphAuthorityIndexAdmittedRepositoryRecord> => {
      const admissionRepository = repository;
      const admitted = await admitContextGraphAuthorityIndexCheckpoint({
        repository: admissionRepository,
        initial,
        deploymentBlockNumber,
        finalized: { number: finalizedNumber, hash: finalizedHash },
        readBlockHash: input.readBlockHash,
        lifecycleSignal,
        onRejectedCheckpoint: (rejectedToken) => {
          onRejectedCheckpoint(admissionRepository.key, rejectedToken);
        },
      });
      horizonLease.admitDurableGeneration(admissionRepository.key, admitted);
      return admitted;
    };
    let durable = await admit(await repository.load());

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
      throw new RangeError(
        'Context Graph authority index tail budget is below the durable reorg holdback',
      );
    }
    let scannedBlocks = 0;
    // Set once the scan passes the horizon; from then on nothing is committed.
    let tail: ContextGraphAuthorityIndexCheckpoint | undefined;
    // Cleared once no trusted core could seed this scan and the operator opted
    // in; from then on this is the local-history scan: never reseeded, never
    // budgeted, and on the plain scope.
    let seedSession = this.#bootstrapCoordinator?.start({
      request: Object.freeze({
        scope, deploymentBlockNumber,
        minThroughBlockNumber: minimumSeedBlock,
        maxThroughBlockNumber: persistThroughBlockNumber,
      }),
      repository,
      finalized: { number: finalizedNumber, hash: finalizedHash },
      lifecycleSignal,
      readBlockHash: input.readBlockHash,
      onRejectedCheckpoint,
    });

    try {
      for (;;) {
        lifecycleSignal.throwIfAborted();
        if (seedSession !== undefined && tail === undefined && seedSession.needsSeed(durable)) {
          try {
            durable = await seedSession.seed(durable);
            horizonLease.admitDurableGeneration(repository.key, durable);
          } catch (error) {
            if (bootstrap === undefined || bootstrap.localHistoryFallback !== true
              || !isBootstrapUnavailable(error)) {
              throw error;
            }
            seedSession.close();
            seedSession = undefined;
            notify(bootstrap.onLocalHistoryFallback, {
              scope,
              reason: error instanceof Error ? error.message : String(error),
            });
            // Continue exactly as an index without bootstrap would: from the
            // checkpoint it keeps under the plain scope (built before this node
            // had a trusted set, or by an earlier fallback) rather than from
            // the deployment block, committing there. The trust-domain key is
            // left alone: its imported prefix is not this scan's to build on,
            // and nothing scanned here is written under it.
            repository = this.#repository.forScope(scope);
            durable = await admit(await repository.load());
          }
          continue;
        }
        const checkpoint = tail ?? (durable.kind === 'checkpoint'
          ? durable.checkpoint
          : undefined);
        if (checkpoint !== undefined && checkpoint.cursor.throughBlockNumber === finalizedNumber) {
          await input.stabilize?.(lifecycleSignal);
          lifecycleSignal.throwIfAborted();
          if (durable.kind === 'checkpoint'
            && servableEpoch === (this.#servableEpochs.get(scope) ?? 0)) {
            // `durable.checkpoint`, never the local `checkpoint`: that may be
            // the in-memory tail, which is above the holdback and unservable.
            this.#rememberServable(scope, durable.checkpoint);
          }
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
        // The tail budget binds only while a trusted seed may still be imported.
        if (bootstrap !== undefined && seedSession !== undefined
          && scannedBlocks + throughBlockNumber - fromBlockNumber + 1 > bootstrap.maxTailBlocks) {
          throw new ContextGraphAuthorityIndexBootstrapUnavailableError(new Error(
            'Context Graph authority index local tail scan budget exhausted',
          ));
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
        notify(bootstrap?.onScanProgress, {
          scope, fromBlockNumber, throughBlockNumber, finalizedNumber, scannedBlocks,
        });

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
          durable = await admit(commit.record);
          continue;
        }
        // A newer cache entry can belong to a concurrently scanned provider
        // fork. Keep this attempt on the checkpoint it reduced and admitted;
        // if another token wins the next CAS, that value is reloaded through
        // admission before it can influence this attempt.
        durable = commit.record;
        horizonLease.commitDurableGeneration(repository.key, durable);
      }
    } finally {
      seedSession?.close();
    }
  }
}
