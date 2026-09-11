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

export type Rfc64CatalogAuthorityRevisionReadV1 =
  | Readonly<{
      kind: 'complete';
      revisions: ReadonlyMap<string, string>;
      fallbackContextGraphIds: ReadonlySet<string>;
    }>
  | Readonly<{
      kind: 'failed';
      fallbackContextGraphIds: ReadonlySet<string>;
      error: unknown;
    }>;

export interface Rfc64CatalogAuthorityRefreshLoopOptionsV1 {
  readonly readActiveContextGraphIds: () => readonly string[];
  readonly onActiveContextGraphIdsReadFailure: (error: unknown) => void;
  /**
   * Optional shared-index projection. A `null` result retains legacy all-CG
   * refreshes; omitted CGs are also refreshed so incomplete bindings fail safe.
   */
  readonly readAuthorityRevisions?: (
    contextGraphIds: readonly string[],
    signal: AbortSignal,
  ) => Promise<Rfc64CatalogAuthorityRevisionReadV1 | null>;
  readonly onAuthorityRevisionsReadFailure?: (error: unknown) => void;
  readonly refreshContextGraph: (
    contextGraphId: string,
    signal: AbortSignal,
  ) => Promise<boolean | void>;
  readonly onRefreshFailure: (contextGraphId: string, error: unknown) => void;
  readonly scheduler?: Rfc64CatalogAuthorityRefreshSchedulerV1;
}

/** One graph's physical worker and all revision state it owns. */
class Rfc64CatalogAuthorityRefreshLaneV1 {
  readonly #task: CoalescingRecurringTask;
  #acceptedRevision: string | undefined;
  #target: Readonly<{ revision: string | null }> | undefined;

  constructor(
    readonly contextGraphId: string,
    refresh: (contextGraphId: string, signal: AbortSignal) => Promise<boolean | void>,
    onFailure: (contextGraphId: string, error: unknown) => void,
  ) {
    this.#task = new CoalescingRecurringTask({
      requestWhileRunning: 'coalesce',
      runPass: async (signal) => {
        const target = this.#target;
        if (target === undefined) return;
        try {
          // `false` is an explicit fulfilled-but-not-committed result. `void`
          // remains successful for existing callers and focused test fixtures.
          const committed = await refresh(this.contextGraphId, signal);
          if (signal.aborted || committed === false) return;
          if (target.revision !== null) this.#acceptedRevision = target.revision;
        } catch (error) {
          if (signal.aborted) return;
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
    if (this.#task.running && this.#target?.revision === revision) return false;
    this.#target = Object.freeze({ revision });
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
  readonly #lanes = new Map<string, Rfc64CatalogAuthorityRefreshLaneV1>();
  readonly #retirements = new Set<Promise<void>>();
  #passOwner: CoalescingRecurringTask | null = null;
  #pass = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #close: Promise<void> | null = null;

  constructor(private readonly options: Rfc64CatalogAuthorityRefreshLoopOptionsV1) {
    this.#scheduler = options.scheduler ?? rfc64CatalogAuthorityRefreshSchedulerV1;
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
    let revisionRead: Rfc64CatalogAuthorityRevisionReadV1 | null = null;
    if (this.options.readAuthorityRevisions !== undefined) {
      try {
        revisionRead = await this.options.readAuthorityRevisions(
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
    }
    signal.throwIfAborted();

    if (revisionRead?.kind === 'failed') {
      this.options.onAuthorityRevisionsReadFailure?.(revisionRead.error);
    }

    for (const contextGraphId of desiredContextGraphIds) {
      if (
        revisionRead?.kind === 'failed'
        && !initial
        && !safety
        && !revisionRead.fallbackContextGraphIds.has(contextGraphId)
      ) continue;
      let lane = this.#lanes.get(contextGraphId);
      if (lane === undefined || lane.closed) {
        lane = this.#createLane(contextGraphId);
        this.#lanes.set(contextGraphId, lane);
      }
      const revision = revisionRead?.kind === 'complete'
        ? revisionRead.revisions.get(contextGraphId) ?? null
        : null;
      lane.request(revision, initial || safety);
    }
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const passOwner = this.#passOwner;
      await passOwner?.whenIdle();
      const lanes = [...this.#lanes.values()];
      const retirements = [...this.#retirements];
      await Promise.all([
        ...lanes.map((lane) => lane.whenIdle()),
        ...retirements,
      ]);
      const currentLanes = [...this.#lanes.values()];
      const currentRetirements = [...this.#retirements];
      const samePassOwner = passOwner === this.#passOwner;
      const sameLanes = lanes.length === currentLanes.length
        && lanes.every((lane, index) => lane === currentLanes[index]);
      const sameRetirements = retirements.length === currentRetirements.length
        && retirements.every((retirement, index) => (
          retirement === currentRetirements[index]
        ));
      if (samePassOwner && sameLanes && sameRetirements) return;
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
