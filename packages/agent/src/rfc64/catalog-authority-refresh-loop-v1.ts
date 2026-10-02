// SPDX-License-Identifier: Apache-2.0

import { CoalescingRecurringTask } from '../coalescing-recurring-task.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  './catalog-authority-config-v1.js';
import type { Rfc64CatalogRefreshableWorkloadOwnerV1 } from './catalog-runtime-v1.js';
import type { Rfc64FinalizedAuthoritySnapshotEvidenceV1 } from
  './finalized-authority-snapshot-batch-runtime-v1.js';

export interface Rfc64CatalogAuthorityRefreshSchedulerV1 {
  setInterval(
    callback: () => void,
    intervalMs: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

/** Production cadence boundary. Tests inject a scheduler per loop instance. */
const rfc64CatalogAuthorityRefreshSchedulerV1:
  Rfc64CatalogAuthorityRefreshSchedulerV1 = {
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return timer;
  },
  clearInterval(timer) {
    clearInterval(timer);
  },
};

/**
 * Opaque revisions for responsibilities backed by the shared authority index.
 * An omitted responsibility intentionally selects automatic authority resolution.
 */
export type Rfc64CatalogAuthorityRevisionReadV1 = ReadonlyMap<string, string>;

/**
 * A rejected shared-index read whose local projection completed first.
 * The cause remains the observable read failure; the fallback IDs let an
 * ordinary pass preserve work that never depended on the failed RPC scan.
 */
export class Rfc64CatalogAuthorityRevisionReadFailureV1 extends Error {
  readonly fallbackContextGraphIds: readonly string[];

  constructor(cause: unknown, fallbackContextGraphIds: Iterable<string>) {
    super(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
    this.name = 'Rfc64CatalogAuthorityRevisionReadFailureV1';
    this.fallbackContextGraphIds = Object.freeze([
      ...new Set(fallbackContextGraphIds),
    ]);
    Object.freeze(this);
  }
}

/** Paired revision-read and physical-lifecycle capability. */
export interface Rfc64CatalogAuthorityRevisionSourceV1 {
  read(
    contextGraphIds: readonly string[],
    signal: AbortSignal,
  ): Promise<Rfc64CatalogAuthorityRevisionReadV1>;
  whenIdle(): Promise<void>;
}

export type Rfc64CatalogAuthorityRefreshResultV1 = 'committed' | 'superseded';
export type Rfc64CatalogAuthorityRefreshRequestV1 =
  | Readonly<{ kind: 'auto' }>
  | Readonly<{ kind: 'finalized-absence' }>
  | Readonly<{
      kind: 'finalized-evidence';
      evidence: Rfc64FinalizedAuthoritySnapshotEvidenceV1;
    }>;

const AUTO_RFC64_CATALOG_AUTHORITY_REFRESH_REQUEST_V1:
Rfc64CatalogAuthorityRefreshRequestV1 = Object.freeze({ kind: 'auto' });

interface Rfc64CatalogAuthorityRefreshAdmissionEntryV1 {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly work: () => Promise<Rfc64CatalogAuthorityRefreshResultV1>;
  readonly resolve: (result: Rfc64CatalogAuthorityRefreshResultV1) => void;
  readonly reject: (error: unknown) => void;
  onAbort?: () => void;
}

/**
 * A store timeout/admission rejection is shared backend pressure, not one
 * graph's authority result. Recognize the stable cross-package error codes
 * (including a shallow wrapper chain) without coupling this orchestration
 * layer to a concrete storage adapter class.
 */
export function isRfc64SharedStorePressureFailureV1(error: unknown): boolean {
  const seen = new Set<unknown>();
  let candidate = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    const shaped = candidate as Readonly<Record<string, unknown>>;
    if (
      shaped.code === 'STORE_OPERATION_TIMEOUT'
      || shaped.code === 'STORE_SCHEDULER_BUSY'
    ) return true;
    candidate = shaped.cause;
  }
  return false;
}

/**
 * Authority projection performs local store reads. Keep those reads
 * single-flight so a large responsibility set cannot fill the store queue.
 * The first shared store-pressure failure trips only its selector generation;
 * queued lanes settle as superseded and are retried by the next refresh pass.
 */
class Rfc64CatalogAuthorityRefreshAdmissionV1 {
  readonly #pending: Rfc64CatalogAuthorityRefreshAdmissionEntryV1[] = [];
  #active = false;
  #generation = 0;
  #trippedGeneration: number | null = null;

  beginPass(): number {
    this.#generation += 1;
    return this.#generation;
  }

  run(
    generation: number,
    signal: AbortSignal,
    work: () => Promise<Rfc64CatalogAuthorityRefreshResultV1>,
  ): Promise<Rfc64CatalogAuthorityRefreshResultV1> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#trippedGeneration === generation) return Promise.resolve('superseded');
    return new Promise((resolve, reject) => {
      const admission: Rfc64CatalogAuthorityRefreshAdmissionEntryV1 = {
        generation,
        signal,
        work,
        resolve,
        reject,
      };
      admission.onAbort = () => {
        const index = this.#pending.indexOf(admission);
        if (index < 0) return;
        this.#pending.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', admission.onAbort, { once: true });
      this.#pending.push(admission);
      this.#drain();
    });
  }

  #settleSkippedGeneration(generation: number): void {
    this.#trippedGeneration = generation;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const admission = this.#pending[index]!;
      if (admission.generation !== generation) continue;
      this.#pending.splice(index, 1);
      if (admission.onAbort !== undefined) {
        admission.signal.removeEventListener('abort', admission.onAbort);
      }
      admission.resolve('superseded');
    }
  }

  #drain(): void {
    if (this.#active) return;
    const admission = this.#pending.shift();
    if (admission === undefined) return;
    if (admission.onAbort !== undefined) {
      admission.signal.removeEventListener('abort', admission.onAbort);
    }
    if (admission.signal.aborted) {
      admission.reject(admission.signal.reason);
      this.#drain();
      return;
    }
    if (this.#trippedGeneration === admission.generation) {
      admission.resolve('superseded');
      this.#drain();
      return;
    }
    this.#active = true;
    void admission.work().then(
      admission.resolve,
      (error) => {
        if (isRfc64SharedStorePressureFailureV1(error)) {
          this.#settleSkippedGeneration(admission.generation);
        }
        admission.reject(error);
      },
    ).finally(() => {
      this.#active = false;
      this.#drain();
    });
  }
}

export interface Rfc64CatalogAuthorityRefreshLoopOptionsV1 {
  readonly readActiveContextGraphIds: () => readonly string[];
  readonly onActiveContextGraphIdsReadFailure: (error: unknown) => void;
  /** Optional shared-index capability; omission retains legacy refreshes. */
  readonly authorityRevisionSource?: Rfc64CatalogAuthorityRevisionSourceV1;
  readonly onAuthorityRevisionsReadFailure?: (error: unknown) => void;
  readonly createRefreshRequests?: (
    contextGraphIds: readonly string[],
    signal: AbortSignal,
  ) => Promise<ReadonlyMap<string, Rfc64CatalogAuthorityRefreshRequestV1>>;
  readonly refreshContextGraph: (
    contextGraphId: string,
    signal: AbortSignal,
    request: Rfc64CatalogAuthorityRefreshRequestV1,
  ) => Promise<Rfc64CatalogAuthorityRefreshResultV1>;
  readonly onRefreshFailure: (contextGraphId: string, error: unknown) => void;
  readonly scheduler?: Rfc64CatalogAuthorityRefreshSchedulerV1;
}

const EMPTY_RFC64_CATALOG_AUTHORITY_REVISION_SOURCE_V1:
Rfc64CatalogAuthorityRevisionSourceV1 = Object.freeze({
  async read(): Promise<Rfc64CatalogAuthorityRevisionReadV1> {
    return new Map();
  },
  async whenIdle(): Promise<void> {
    // The unsupported-reader path never starts physical revision work.
  },
});

/** One graph's physical worker and all revision state it owns. */
class Rfc64CatalogAuthorityRefreshLaneV1 {
  readonly #task: CoalescingRecurringTask;
  #acceptedRevision: string | undefined;
  #target: Readonly<{
    revision: string | null;
    force: boolean;
    request: Rfc64CatalogAuthorityRefreshRequestV1;
    admissionGeneration: number;
  }> | undefined;

  constructor(
    readonly contextGraphId: string,
    refresh: (
      contextGraphId: string,
      signal: AbortSignal,
      request: Rfc64CatalogAuthorityRefreshRequestV1,
    ) => Promise<Rfc64CatalogAuthorityRefreshResultV1>,
    admission: Rfc64CatalogAuthorityRefreshAdmissionV1,
    onFailure: (contextGraphId: string, error: unknown) => void,
  ) {
    this.#task = new CoalescingRecurringTask({
      requestWhileRunning: 'coalesce',
      runPass: async (signal) => {
        const target = this.#target;
        if (target === undefined) return;
        try {
          const result = await admission.run(
            target.admissionGeneration,
            signal,
            () => refresh(this.contextGraphId, signal, target.request),
          );
          if (signal.aborted) return;
          if (result === 'superseded') {
            if (target.force) this.#acceptedRevision = undefined;
            return;
          }
          if (target.revision !== null) this.#acceptedRevision = target.revision;
        } catch (error) {
          if (signal.aborted) return;
          if (target.force) this.#acceptedRevision = undefined;
          onFailure(this.contextGraphId, error);
        }
      },
      // Per-context-graph failures are reported by the lane body.
      onError: () => undefined,
      closingMessage: 'RFC-64 authority refresh stopped during agent shutdown',
    });
  }

  get closed(): boolean {
    return this.#task.closed;
  }

  request(
    revision: string | null,
    force: boolean,
    request: Rfc64CatalogAuthorityRefreshRequestV1,
    admissionGeneration: number,
  ): boolean {
    if (!this.needsRequest(revision, force)) return false;
    this.#target = Object.freeze({ revision, force, request, admissionGeneration });
    return this.#task.request();
  }

  needsRequest(revision: string | null, force: boolean): boolean {
    if (!force && revision !== null && this.#acceptedRevision === revision) return false;
    return !(
      this.#task.running
      && this.#target?.revision === revision
      && (!force || this.#target.force)
    );
  }

  whenIdle(): Promise<void> {
    return this.#task.whenIdle();
  }

  close(): Promise<void> {
    return this.#task.close();
  }
}

/** Bounded independent authority lanes with explicit scheduling and shutdown ownership. */
export class Rfc64CatalogAuthorityRefreshLoopV1
implements Rfc64CatalogRefreshableWorkloadOwnerV1 {
  readonly #scheduler: Rfc64CatalogAuthorityRefreshSchedulerV1;
  readonly #authorityRevisionSource: Rfc64CatalogAuthorityRevisionSourceV1;
  readonly #lanes = new Map<string, Rfc64CatalogAuthorityRefreshLaneV1>();
  readonly #refreshAdmission = new Rfc64CatalogAuthorityRefreshAdmissionV1();
  readonly #retirements = new Set<Promise<void>>();
  #passOwner: CoalescingRecurringTask | null = null;
  #passActivityRevision = 0;
  #pass = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #close: Promise<void> | null = null;

  constructor(private readonly options: Rfc64CatalogAuthorityRefreshLoopOptionsV1) {
    this.#scheduler = options.scheduler ?? rfc64CatalogAuthorityRefreshSchedulerV1;
    this.#authorityRevisionSource = options.authorityRevisionSource
      ?? EMPTY_RFC64_CATALOG_AUTHORITY_REVISION_SOURCE_V1;
  }

  #createPassOwner(): CoalescingRecurringTask {
    return new CoalescingRecurringTask({
      // Preserve one follow-up tick so responsibility changes observed while
      // the selector is settling cannot leave a retired CG lane alive.
      requestWhileRunning: 'coalesce',
      runPass: (signal) => this.#runRefreshPass(signal),
      onError: (error) => {
        if (!this.#started) return;
        this.options.onAuthorityRevisionsReadFailure?.(error);
      },
      closingMessage: 'RFC-64 authority refresh selection stopped during agent shutdown',
    });
  }

  #createLane(contextGraphId: string): Rfc64CatalogAuthorityRefreshLaneV1 {
    return new Rfc64CatalogAuthorityRefreshLaneV1(
      contextGraphId,
      this.options.refreshContextGraph,
      this.#refreshAdmission,
      this.options.onRefreshFailure,
    );
  }

  #retireLane(
    contextGraphId: string,
    lane: Rfc64CatalogAuthorityRefreshLaneV1,
  ): void {
    if (this.#lanes.get(contextGraphId) !== lane) return;
    this.#lanes.delete(contextGraphId);
    const retirement = lane.close();
    this.#retirements.add(retirement);
    void retirement.then(
      () => { this.#retirements.delete(retirement); },
      () => { this.#retirements.delete(retirement); },
    );
  }

  start(): void {
    if (this.#close !== null) {
      throw new Error('RFC-64 authority refresh cannot start while close is in progress');
    }
    if (this.#started) return;
    this.#started = true;
    this.#pass = 0;
    this.#passOwner = this.#createPassOwner();
    this.#timer = this.#scheduler.setInterval(
      this.trigger,
      RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs,
    );
    this.trigger();
  }

  readonly trigger = (): void => {
    if (!this.#started) return;
    this.#passActivityRevision += 1;
    this.#passOwner?.request();
  };

  async #runRefreshPass(signal: AbortSignal): Promise<void> {
    const admissionGeneration = this.#refreshAdmission.beginPass();
    let activeContextGraphIds: readonly string[];
    try {
      activeContextGraphIds = this.options.readActiveContextGraphIds();
    } catch (error) {
      this.options.onActiveContextGraphIdsReadFailure(error);
      return;
    }
    signal.throwIfAborted();
    const desiredContextGraphIds = new Set(activeContextGraphIds);
    for (const [contextGraphId, lane] of this.#lanes) {
      if (!desiredContextGraphIds.has(contextGraphId)) {
        this.#retireLane(contextGraphId, lane);
      }
    }

    this.#pass += 1;
    const pass = this.#pass;
    const initial = pass === 1;
    const safety = !initial && (pass - 1)
      % RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.safetyRevalidationIntervalCount === 0;
    let revisions: Rfc64CatalogAuthorityRevisionReadV1 = new Map();
    let ordinaryFailureFallbackContextGraphIds: ReadonlySet<string> | undefined;
    try {
      revisions = await this.#authorityRevisionSource.read(
        Object.freeze([...desiredContextGraphIds]),
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      const projectedFailure = error instanceof Rfc64CatalogAuthorityRevisionReadFailureV1
        ? error
        : undefined;
      this.options.onAuthorityRevisionsReadFailure?.(
        projectedFailure === undefined ? error : projectedFailure.cause,
      );
      // A failed delta read cannot identify a safe subset. The initial and
      // safety passes still revalidate everything; ordinary passes retry the
      // shared scan at the next cadence without fanning out mapped CG reads.
      // A production source can still preserve the locally projected legacy
      // subset because those lanes never depended on the failed RPC scan.
      if (!initial && !safety) {
        if (projectedFailure === undefined) return;
        ordinaryFailureFallbackContextGraphIds = new Set(
          projectedFailure.fallbackContextGraphIds,
        );
      }
    }
    signal.throwIfAborted();
    const selectedContextGraphIds = [...desiredContextGraphIds].filter((contextGraphId) => (
      ordinaryFailureFallbackContextGraphIds === undefined
      || ordinaryFailureFallbackContextGraphIds.has(contextGraphId)
    )).filter((contextGraphId) => {
      const lane = this.#lanes.get(contextGraphId);
      return lane === undefined
        || lane.closed
        || lane.needsRequest(revisions.get(contextGraphId) ?? null, initial || safety);
    });
    const refreshRequests = this.options.createRefreshRequests === undefined
      ? new Map(selectedContextGraphIds.map((contextGraphId) => [
          contextGraphId,
          AUTO_RFC64_CATALOG_AUTHORITY_REFRESH_REQUEST_V1,
        ]))
      : await this.options.createRefreshRequests(
        Object.freeze(selectedContextGraphIds),
        signal,
      );
    signal.throwIfAborted();
    for (const contextGraphId of selectedContextGraphIds) {
      if (!refreshRequests.has(contextGraphId)) {
        throw new Error(
          `RFC-64 authority refresh request factory omitted selected Context Graph "${contextGraphId}"`,
        );
      }
    }

    for (const contextGraphId of desiredContextGraphIds) {
      if (
        ordinaryFailureFallbackContextGraphIds !== undefined
        && !ordinaryFailureFallbackContextGraphIds.has(contextGraphId)
      ) continue;
      let lane = this.#lanes.get(contextGraphId);
      if (lane === undefined || lane.closed) {
        lane = this.#createLane(contextGraphId);
        this.#lanes.set(contextGraphId, lane);
      }
      const revision = revisions.get(contextGraphId) ?? null;
      lane.request(
        revision,
        initial || safety,
        refreshRequests.get(contextGraphId)
          ?? AUTO_RFC64_CATALOG_AUTHORITY_REFRESH_REQUEST_V1,
        admissionGeneration,
      );
    }
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const passOwner = this.#passOwner;
      await passOwner?.whenIdle();
      const settledPassActivityRevision = this.#passActivityRevision;
      const lanes = [...this.#lanes.values()];
      const retirements = [...this.#retirements];
      await Promise.all([
        ...lanes.map((lane) => lane.whenIdle()),
        ...retirements,
      ]);
      // A pass may begin while pre-existing lanes are draining. Re-fence the
      // pass owner, then drain any physical revision read which outlived its
      // cancellable selector. Loop if the pass scheduled or retired a lane
      // after the snapshot above so its resulting work is also included.
      await passOwner?.whenIdle();
      await this.#authorityRevisionSource.whenIdle();
      const currentLanes = [...this.#lanes.values()];
      const currentRetirements = [...this.#retirements];
      const samePassOwner = passOwner === this.#passOwner;
      const samePassActivity = settledPassActivityRevision
        === this.#passActivityRevision;
      const sameLanes = lanes.length === currentLanes.length
        && lanes.every((lane, index) => lane === currentLanes[index]);
      const sameRetirements = retirements.length === currentRetirements.length
        && retirements.every((retirement, index) => (
          retirement === currentRetirements[index]
        ));
      if (samePassOwner && samePassActivity && sameLanes && sameRetirements) return;
    }
  }

  close(): Promise<void> {
    if (this.#close !== null) return this.#close;
    this.#started = false;
    if (this.#timer !== null) {
      this.#scheduler.clearInterval(this.#timer);
      this.#timer = null;
    }
    const passOwner = this.#passOwner;
    const closing = (async () => {
      await passOwner?.close();
      const lanes = [...this.#lanes.values()];
      const retirements = [...this.#retirements];
      await Promise.all([
        this.#authorityRevisionSource.whenIdle(),
        ...lanes.map((lane) => lane.close()),
        ...retirements,
      ]);
    })();
    this.#close = closing;
    void closing.then(() => {
      if (this.#close !== closing) return;
      this.#lanes.clear();
      this.#retirements.clear();
      if (this.#passOwner === passOwner) this.#passOwner = null;
      this.#close = null;
    });
    return closing;
  }
}
