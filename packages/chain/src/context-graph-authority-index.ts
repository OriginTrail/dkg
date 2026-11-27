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
  type ContextGraphAuthorityIndexRepositoryRecord,
  type ContextGraphAuthorityIndexScopedRepository,
} from './context-graph-authority-index-repository.js';
import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS,
  ContextGraphAuthorityIndexProjectionCache,
  ContextGraphAuthorityIndexView,
  type ContextGraphAuthorityIndexProjectionOptions,
  type ContextGraphAuthorityIndexProjectionReadInput,
} from './context-graph-authority-index-projection.js';
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

/** The scan lane a caller runs in; the EVM reader passes its RPC request class. */
export type ContextGraphAuthorityIndexScanClass = 'foreground' | 'background';

/** A contract's deployment block, and whether the lookup could pin it. */
export type ContextGraphAuthorityIndexDeploymentLookup = Readonly<{
  blockNumber: number;
  /**
   * False for the adapter's genesis fallback: no endpoint could pin the block
   * (pruned or throttled), so `blockNumber` is 0 and the adapter does not
   * cache it.
   */
  pinned: boolean;
}>;

/** The one physical scan a scope has in flight in one request class; see `#snapshot`. */
type ActiveScan = Readonly<{
  key: string;
  readScope: object;
  /** What a caller to the same anchor on the same endpoint joins. */
  checkpoint: Promise<ContextGraphAuthorityIndexCheckpoint>;
  /** Settles with the scan and never rejects. */
  settled: Promise<void>;
}>;

/**
 * A scan's work on one repository, fixed when it starts there; see `#scan`.
 * The bootstrap's local-history fallback starts a new one on the plain scope.
 */
type RepositoryScan = Readonly<{
  key: string;
  repository: ContextGraphAuthorityIndexScopedRepository;
  /** The block the stored history and every page are reduced from. */
  deploymentBlockNumber: number;
  /** Highest block this scan may write down; never below the deployment block. */
  persistThroughBlockNumber: number;
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
  /**
   * False when `deploymentBlockNumber` comes from a lookup that could not pin
   * the block (the adapter's uncached genesis fallback). The scan then resumes
   * a stored checkpoint reduced from a later block, while admission keeps it,
   * and rebuilds from `deploymentBlockNumber` when it does not: a deployment
   * block is only as good as the history it was reduced with.
   */
  readonly deploymentBlockPinned?: boolean;
  /**
   * Which of the scope's two scan lanes this scan runs in. A scan's requests
   * keep the RPC class of the caller that started it, so a foreground read
   * must not wait out, or join, a walk on the smaller background budget.
   * Defaults to `foreground`.
   */
  readonly scanClass?: ContextGraphAuthorityIndexScanClass;
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

/**
 * Process-local owner for the durable contract-wide authority index.
 *
 * Every successfully reduced page is persisted before the next page starts.
 * A later call (including one on a fallback endpoint) therefore resumes at the
 * next block instead of repeating the already-covered contract prefix.
 */
export class ContextGraphAuthorityIndex {
  readonly #repository: ContextGraphAuthorityIndexRepository;
  readonly #activity = new ContextGraphAuthorityIndexActivity();
  readonly #bootstrapCoordinator: ContextGraphAuthorityIndexBootstrapCoordinator | undefined;
  readonly #servable = new Map<string, readonly ServableCheckpoint[]>();
  readonly #servableEpochs = new Map<string, number>();
  /**
   * Last completed, TAIL-INCLUSIVE projection per scope. Strictly separate
   * from `#servable`: `exportSnapshot` reads only that map, so the unsettled
   * tail a cached projection carries can never be served to an edge.
   */
  readonly #projections: ContextGraphAuthorityIndexProjectionCache;
  /**
   * The scan each scope has in flight, per request class. A scope runs ONE
   * physical scan per class at a time: a scan from a far-behind cursor is a
   * walk of many pages, and two walks to different anchors read the same
   * pages twice while they race each other's commits. A later scan waits for
   * the running one and resumes from the cursor it left, a page or two.
   *
   * Per class, because a scan's requests keep the class of the caller that
   * started it: a foreground read must not wait out a walk that the core's
   * background refresh started on the smaller background budget.
   */
  readonly #activeScans = new Map<string, ActiveScan>();
  /**
   * Per durable key, the record a scan first found out of reach of its
   * anchor, and when. Any commit, or any admission against a chain view,
   * clears it. The record is rebuilt only once it has stayed out of reach for
   * the head tolerance (the age past which no cached answer is served either)
   * with nothing clearing it: a restored or copied store, or a chain reset at
   * the same address. A lagging endpoint, or a scan that waited behind
   * another, is one anchor; the next read at a current one admits the record.
   * Tokens never repeat, so a new token is a new record and a new clock.
   */
  readonly #outOfReachSince = new Map<string, Readonly<{ token: number; sinceMs: number }>>();
  #closed = false;
  #lifecycleAbort = new AbortController();

  constructor(
    readonly localStore: ContextGraphAuthorityIndexStore,
    private readonly bootstrap?: ContextGraphAuthorityIndexBootstrap,
    projection: ContextGraphAuthorityIndexProjectionOptions = {},
  ) {
    this.#projections = new ContextGraphAuthorityIndexProjectionCache(projection);
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
    const record = await this.#repository.forScope(scope).load();
    if (record.kind !== 'checkpoint'
      || record.checkpoint.cursor.deploymentBlockNumber !== deploymentBlockNumber) {
      return undefined;
    }
    return record.checkpoint.cursor.throughBlockNumber;
  }

  /**
   * The first block a scan of `scope` resumes from for this deployment lookup:
   * the looked-up block, or, for a lookup that could not pin it, the block the
   * stored checkpoint was reduced from (see `deploymentBlockPinned`). A chain
   * event log anchor must cover the history from here.
   */
  async deploymentCoverageFromBlockNumber(
    scope: string,
    lookup: ContextGraphAuthorityIndexDeploymentLookup,
  ): Promise<number> {
    if (lookup.pinned || this.#closed) return lookup.blockNumber;
    for (const key of this.bootstrap === undefined ? [scope]
      : [`${scope}:trusted-bootstrap:${this.bootstrap.trustDomain}`, scope]) {
      const record = await this.#repository.forScope(key).load();
      if (record.kind === 'checkpoint') {
        return Math.max(lookup.blockNumber, record.checkpoint.cursor.deploymentBlockNumber);
      }
    }
    return lookup.blockNumber;
  }

  /**
   * Resolve once `scope` has no scan in flight in `scanClass`, or reject with
   * `signal`.
   *
   * For a caller about to start one: the anchor it reads before waiting would
   * be out of date by the time the running scan lets it in, and on a node
   * whose walk outlasts its readers every one of them would pay that head
   * read for nothing.
   */
  async whenScanIdle(
    scope: string,
    signal?: AbortSignal,
    scanClass: ContextGraphAuthorityIndexScanClass = 'foreground',
  ): Promise<void> {
    const lane = this.#scanLane(scope, scanClass);
    const lifecycleSignal = this.#lifecycleAbort.signal;
    for (let active = this.#activeScans.get(lane); active !== undefined;
      active = this.#activeScans.get(lane)) {
      await this.#waitOut(active, signal, lifecycleSignal);
    }
  }

  /** One of `scope`'s two scan lanes; see `scanClass`. */
  #scanLane(scope: string, scanClass: ContextGraphAuthorityIndexScanClass): string {
    return [scope, scanClass].join('\u0000');
  }

  /**
   * Wait for one running scan to settle. Bounded by the caller's `signal` and
   * by the lifecycle the caller entered under: a `clear()` while it waits (a
   * Hub rotation, a chain reconfiguration) rejects it with that lifecycle's
   * abort, as it rejects the scans it stops, so nothing prepared before the
   * clear starts after it.
   */
  async #waitOut(
    active: ActiveScan,
    signal: AbortSignal | undefined,
    lifecycleSignal: AbortSignal,
  ): Promise<void> {
    await waitForSignal(active.settled, signal === undefined
      ? lifecycleSignal
      : AbortSignal.any([signal, lifecycleSignal]));
    lifecycleSignal.throwIfAborted();
    if (this.#closed) throw new DOMException('Context Graph authority index is closed', 'AbortError');
  }

  /**
   * Read-your-writes. This node just submitted an authority transaction, so
   * every projection scanned before it is known to be out of date — including
   * as a stale-if-error answer. The durable index is untouched: the next read
   * is one ordinary incremental refresh.
   */
  dropProjections(): void {
    this.#projections.clear();
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
    // The aborted scans settle on their own; a scan of the new lifecycle does
    // not wait behind them, and nothing proven before the clear stays proven.
    this.#activeScans.clear();
    this.#outOfReachSince.clear();
    this.#servable.clear();
    this.#servableEpochs.clear();
    this.#projections.clear();
    this.#bootstrapCoordinator?.clear();
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

  /** One fresh scan to the anchor, behind the checkpoint-private projections. */
  async view(input: ContextGraphAuthorityIndexScanInput): Promise<ContextGraphAuthorityIndexView> {
    return new ContextGraphAuthorityIndexView(await this.#snapshot(input));
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
    // The request class is part of the key: a foreground read must not join a
    // walk the background refresh runs on the smaller background budget.
    const lane = this.#scanLane(scope, input.scanClass ?? 'foreground');
    const scanKey = [lane, input.finalized.number, finalizedHash].join('\u0000');
    // ONE physical scan per scope and request class. A caller to the same
    // anchor on the same endpoint joins the running scan. A scan to any other
    // anchor used to start beside it; from a far-behind cursor each of those
    // is a walk of the same pages, and every walk outlives the callers that
    // started it, so under a throttled RPC budget a walk that takes longer
    // than readers wait was joined by one more walk per reader. Now it waits,
    // bounded by its caller's own signal, and leaves nothing queued if the
    // caller gives up. The check that ends the wait and the registration
    // below run in one synchronous step, so two callers cannot both find the
    // lane free.
    const lifecycleSignal = this.#lifecycleAbort.signal;
    let active = this.#activeScans.get(lane);
    while (active !== undefined
      && (active.key !== scanKey || active.readScope !== input.readScope)) {
      await this.#waitOut(active, input.signal, lifecycleSignal);
      active = this.#activeScans.get(lane);
    }
    if (active === undefined) {
      const checkpoint = this.#activity.track(this.#scan({ ...input, scope, finalized: {
        number: input.finalized.number,
        hash: finalizedHash,
      } }, lifecycleSignal));
      const started: ActiveScan = Object.freeze({
        key: scanKey,
        readScope: input.readScope,
        checkpoint,
        settled: checkpoint.then(() => undefined, () => undefined),
      });
      this.#activeScans.set(lane, started);
      void started.settled.then(() => {
        if (this.#activeScans.get(lane) === started) this.#activeScans.delete(lane);
      });
      active = started;
    }
    return waitForSignal(active.checkpoint, input.signal);
  }

  async #scan(
    input: ContextGraphAuthorityIndexScanInput,
    lifecycleSignal: AbortSignal,
  ): Promise<ContextGraphAuthorityIndexCheckpoint> {
    const scope = input.scope;
    const requestedDeploymentBlockNumber = normalizeNonNegativeSafeInteger(input.deploymentBlockNumber);
    const finalizedNumber = normalizeNonNegativeSafeInteger(input.finalized.number);
    const finalizedHash = normalizeHash(input.finalized.hash);
    const pageSize = normalizeNonNegativeSafeInteger(input.pageSize);
    if (
      requestedDeploymentBlockNumber === undefined
      || finalizedNumber === undefined
      || finalizedHash === undefined
      || pageSize === undefined
      || pageSize < 1
      || requestedDeploymentBlockNumber > finalizedNumber
    ) {
      throw new Error('Context Graph authority index scan bounds are invalid');
    }
    const holdback = normalizeNonNegativeSafeInteger(
      input.durableReorgHoldbackBlocks ?? 0,
    ) ?? 0;

    let servableEpoch = this.#servableEpochs.get(scope) ?? 0;
    const onRejectedCheckpoint = (): void => {
      // The tombstone voids everything reduced on top of that checkpoint,
      // including the projection readers are still being answered from.
      this.#projections.drop(scope);
      this.#servable.delete(scope);
      servableEpoch = (this.#servableEpochs.get(scope) ?? 0) + 1;
      this.#servableEpochs.set(scope, servableEpoch);
    };
    // A record this lifecycle committed, or admitted against a chain view, is
    // within reach of a current anchor.
    const markReachable = (key: string, record: ContextGraphAuthorityIndexRepositoryRecord): void => {
      if (record.kind === 'checkpoint' && !lifecycleSignal.aborted) {
        this.#outOfReachSince.delete(key);
      }
    };
    // See `#outOfReachSince`. A clock that stepped back starts it again.
    const rebuildOutOfReach = (key: string, record: ContextGraphAuthorityIndexRepositoryRecord): boolean => {
      if (record.kind !== 'checkpoint') return true;
      const now = Date.now();
      const seen = this.#outOfReachSince.get(key);
      if (seen === undefined || seen.token !== record.token || now < seen.sinceMs) {
        this.#outOfReachSince.set(key, Object.freeze({
          token: record.token,
          sinceMs: now,
        }));
        return false;
      }
      return now - seen.sinceMs >= CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS;
    };
    // Admits a durable record on one repository against a lower bound.
    const admit = async (
      on: Pick<RepositoryScan, 'key' | 'repository'>,
      record: ContextGraphAuthorityIndexRepositoryRecord,
      bound: number,
    ): Promise<ContextGraphAuthorityIndexRepositoryRecord> => {
      const admitted = await admitContextGraphAuthorityIndexCheckpoint({
        repository: on.repository,
        initial: record,
        deploymentBlockNumber: bound,
        finalized: { number: finalizedNumber, hash: finalizedHash },
        readBlockHash: input.readBlockHash,
        lifecycleSignal,
        onRejectedCheckpoint,
        rebuildOutOfReach: (stored) => rebuildOutOfReach(on.key, stored),
      });
      // Admission returns a checkpoint only after matching its cursor hash.
      markReachable(on.key, admitted);
      return admitted;
    };
    // Starts this scan on the repository under `key`, with bounds fixed there.
    // An unpinned lookup resumes the stored checkpoint from the block it was
    // reduced from, if that block is on this side of the anchor and admission
    // keeps the history; otherwise the scan starts from the lookup's block.
    const startRepositoryScan = async (key: string): Promise<Readonly<{
      repositoryScan: RepositoryScan;
      durable: ContextGraphAuthorityIndexRepositoryRecord;
    }>> => {
      const repository = this.#repository.forScope(key);
      const initial = await repository.load();
      let bound = requestedDeploymentBlockNumber;
      if (input.deploymentBlockPinned === false && initial.kind === 'checkpoint') {
        const stored = initial.checkpoint.cursor.deploymentBlockNumber;
        if (stored > bound && stored <= finalizedNumber) bound = stored;
      }
      const durable = await admit({ key, repository }, initial, bound);
      const deploymentBlockNumber = durable.kind === 'checkpoint' ? bound : requestedDeploymentBlockNumber;
      return Object.freeze({
        repositoryScan: Object.freeze({
          key,
          repository,
          deploymentBlockNumber,
          // Holding the cursor back past the start of history would persist nothing.
          persistThroughBlockNumber: Math.max(deploymentBlockNumber, finalizedNumber - holdback),
        }),
        durable,
      });
    };
    // A record adopted mid-scan (a CAS winner) is checked against the bounds
    // the repository scan fixed. If the stored checkpoint they came from is
    // gone (another writer saw a chain reset at the same address), this scan's
    // pages and any seed session are set for the old block: end it, and let
    // the next scan start over from the lookup.
    const readmit = async (
      on: RepositoryScan,
      record: ContextGraphAuthorityIndexRepositoryRecord,
    ): Promise<ContextGraphAuthorityIndexRepositoryRecord> => {
      const admitted = await admit(on, record, on.deploymentBlockNumber);
      if (admitted.kind !== 'checkpoint' && on.deploymentBlockNumber !== requestedDeploymentBlockNumber) {
        throw new ContextGraphAuthorityIndexRetryableError(
          `Context Graph authority index checkpoint from block ${on.deploymentBlockNumber} was `
          + `dropped during this scan; it is rebuilt from block ${requestedDeploymentBlockNumber}`,
        );
      }
      return admitted;
    };
    // Imported authority is never promoted into an independently scanned index
    // after a trust-policy change or when snapshot bootstrap is disabled. The
    // plain scope IS that independent index: a seeded scan keeps to its
    // trust-domain key, and only the local-history fallback below moves here.
    let { repositoryScan, durable } = await startRepositoryScan(this.bootstrap === undefined
      ? scope : `${scope}:trusted-bootstrap:${this.bootstrap.trustDomain}`);

    const bootstrap = this.bootstrap;
    const minimumSeedBlock = bootstrap === undefined ? repositoryScan.deploymentBlockNumber
      : Math.max(repositoryScan.deploymentBlockNumber, finalizedNumber - bootstrap.maxTailBlocks);
    if (bootstrap !== undefined && minimumSeedBlock > repositoryScan.persistThroughBlockNumber) {
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
        scope,
        deploymentBlockNumber: repositoryScan.deploymentBlockNumber,
        minThroughBlockNumber: minimumSeedBlock,
        maxThroughBlockNumber: repositoryScan.persistThroughBlockNumber,
      }),
      repository: repositoryScan.repository,
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
            // the deployment block, committing there, with bounds of its own.
            // The trust-domain key is left alone: its imported prefix is not
            // this scan's to build on, and nothing scanned here is written under it.
            ({ repositoryScan, durable } = await startRepositoryScan(scope));
          }
          continue;
        }
        const checkpoint = tail ?? (durable.kind === 'checkpoint'
          ? durable.checkpoint
          : undefined);
        if (checkpoint !== undefined && checkpoint.cursor.throughBlockNumber === finalizedNumber) {
          if (durable.kind === 'checkpoint'
            && servableEpoch === (this.#servableEpochs.get(scope) ?? 0)) {
            // `durable.checkpoint`, never the local `checkpoint`: that may be
            // the in-memory tail, which is above the holdback and unservable.
            this.#rememberServable(scope, durable.checkpoint);
          }
          return checkpoint;
        }

        const fromBlockNumber = checkpoint === undefined
          ? repositoryScan.deploymentBlockNumber
          : checkpoint.cursor.throughBlockNumber + 1;
        // A page that straddles the horizon is clamped to it, so the durable part
        // is still written down and the next iteration reduces the tail in memory.
        const committing = tail === undefined
          && fromBlockNumber <= repositoryScan.persistThroughBlockNumber;
        const pageThroughBlockNumber = Math.min(
          fromBlockNumber + pageSize - 1,
          finalizedNumber,
        );
        const throughBlockNumber = committing
          ? Math.min(pageThroughBlockNumber, repositoryScan.persistThroughBlockNumber)
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
          deploymentBlockNumber: repositoryScan.deploymentBlockNumber,
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

        const commit = await repositoryScan.repository.commitOrReloadWinner(
          durable,
          next,
        );
        if (commit.kind === 'winner') {
          // Another valid provider completion won the page. Reload its result
          // and continue from that cursor rather than overwriting or rescanning.
          durable = await readmit(repositoryScan, commit.record);
          continue;
        }
        // A newer cache entry can belong to a concurrently scanned provider
        // fork. Keep this attempt on the checkpoint it reduced and admitted;
        // if another token wins the next CAS, that value is reloaded through
        // admission before it can influence this attempt.
        durable = commit.record;
        markReachable(repositoryScan.key, durable);
      }
    } finally {
      seedSession?.close();
    }
  }
}
