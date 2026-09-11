// SPDX-License-Identifier: Apache-2.0

import { CoalescingRecurringTask } from '../coalescing-recurring-task.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  './catalog-authority-config-v1.js';
import type { Rfc64CatalogWorkloadOwnerV1 } from './catalog-runtime-v1.js';

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
 * An omitted responsibility intentionally selects the legacy every-pass path.
 */
export type Rfc64CatalogAuthorityRevisionReadV1 = ReadonlyMap<string, string>;

export type Rfc64CatalogAuthorityRefreshResultV1 =
  | Readonly<{ kind: 'committed' }>
  | Readonly<{ kind: 'superseded' }>;

export interface Rfc64CatalogAuthorityRefreshLoopOptionsV1 {
  readonly readActiveContextGraphIds: () => readonly string[];
  readonly onActiveContextGraphIdsReadFailure: (error: unknown) => void;
  /** Optional shared-index projection; omitted CGs retain legacy refreshes. */
  readonly readAuthorityRevisions?: (
    contextGraphIds: readonly string[],
    signal: AbortSignal,
  ) => Promise<Rfc64CatalogAuthorityRevisionReadV1>;
  /** Drain physical revision scans after the cancellable selector retires. */
  readonly whenAuthorityRevisionsIdle?: () => Promise<void>;
  readonly onAuthorityRevisionsReadFailure?: (error: unknown) => void;
  readonly refreshContextGraph: (
    contextGraphId: string,
    signal: AbortSignal,
  ) => Promise<Rfc64CatalogAuthorityRefreshResultV1>;
  readonly onRefreshFailure: (contextGraphId: string, error: unknown) => void;
  readonly scheduler?: Rfc64CatalogAuthorityRefreshSchedulerV1;
}

const EMPTY_RFC64_CATALOG_AUTHORITY_REVISIONS_V1 = async ():
Promise<Rfc64CatalogAuthorityRevisionReadV1> => new Map();

/** One graph's physical worker and all revision state it owns. */
class Rfc64CatalogAuthorityRefreshLaneV1 {
  readonly #task: CoalescingRecurringTask;
  #acceptedRevision: string | undefined;
  #target: Readonly<{ revision: string | null; force: boolean }> | undefined;

  constructor(
    readonly contextGraphId: string,
    refresh: (
      contextGraphId: string,
      signal: AbortSignal,
    ) => Promise<Rfc64CatalogAuthorityRefreshResultV1>,
    onFailure: (contextGraphId: string, error: unknown) => void,
  ) {
    this.#task = new CoalescingRecurringTask({
      requestWhileRunning: 'coalesce',
      runPass: async (signal) => {
        const target = this.#target;
        if (target === undefined) return;
        try {
          const result = await refresh(this.contextGraphId, signal);
          if (signal.aborted) return;
          if (result.kind === 'superseded') {
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

  request(revision: string | null, force: boolean): boolean {
    if (!force && revision !== null && this.#acceptedRevision === revision) return false;
    if (
      this.#task.running
      && this.#target?.revision === revision
      && (!force || this.#target.force)
    ) return false;
    this.#target = Object.freeze({ revision, force });
    return this.#task.request();
  }

  whenIdle(): Promise<void> {
    return this.#task.whenIdle();
  }

  close(): Promise<void> {
    return this.#task.close();
  }
}

/** Bounded independent authority lanes with explicit scheduling and shutdown ownership. */
export class Rfc64CatalogAuthorityRefreshLoopV1 implements Rfc64CatalogWorkloadOwnerV1 {
  readonly #scheduler: Rfc64CatalogAuthorityRefreshSchedulerV1;
  readonly #readAuthorityRevisions: NonNullable<
    Rfc64CatalogAuthorityRefreshLoopOptionsV1['readAuthorityRevisions']
  >;
  readonly #lanes = new Map<string, Rfc64CatalogAuthorityRefreshLaneV1>();
  readonly #retirements = new Set<Promise<void>>();
  #passOwner: CoalescingRecurringTask | null = null;
  #passActivityRevision = 0;
  #pass = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #close: Promise<void> | null = null;

  constructor(private readonly options: Rfc64CatalogAuthorityRefreshLoopOptionsV1) {
    this.#scheduler = options.scheduler ?? rfc64CatalogAuthorityRefreshSchedulerV1;
    this.#readAuthorityRevisions = options.readAuthorityRevisions
      ?? EMPTY_RFC64_CATALOG_AUTHORITY_REVISIONS_V1;
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
    try {
      revisions = await this.#readAuthorityRevisions(
        Object.freeze([...desiredContextGraphIds]),
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      this.options.onAuthorityRevisionsReadFailure?.(error);
      // A failed delta read cannot identify a safe subset. The initial and
      // safety passes still revalidate everything; ordinary passes retry the
      // one shared scan at the next cadence without fanning out per-CG reads.
      if (!initial && !safety) return;
    }
    signal.throwIfAborted();

    for (const contextGraphId of desiredContextGraphIds) {
      let lane = this.#lanes.get(contextGraphId);
      if (lane === undefined || lane.closed) {
        lane = this.#createLane(contextGraphId);
        this.#lanes.set(contextGraphId, lane);
      }
      const revision = revisions.get(contextGraphId) ?? null;
      lane.request(revision, initial || safety);
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
      // pass owner, then loop if it scheduled or retired any lane after the
      // snapshot above so its resulting work is included in the idle proof.
      await passOwner?.whenIdle();
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
        this.options.whenAuthorityRevisionsIdle?.(),
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
