/**
 * The control barrier's PUBLIC vocabulary.
 *
 * Its own module, and deliberately not `…-v1-internal`, because these four
 * declarations are published surface: `store-priority-scheduler.ts` re-exports
 * every one of them, and callers catch `StoreControlBarrierTimeoutError` and
 * hold `StoreGenerationSeal` handles.
 *
 * Kept out of the coordinator module because that one IS internal. Mixing a
 * published contract into a file marked private tells a reader the opposite of
 * the truth about both.
 */

export type StoreControlBarrierPhase = 'wait' | 'transition';

/** What a control barrier was still waiting on when it gave up. */
export interface StoreControlBarrierBlockers {
  /** Inflight work carrying no store identity, so it cannot be ruled out. */
  untaggedInflight: number;
  taggedInflightForStore: number;
  generationsInflight: number;
  heldRuns: number;
}

/**
 * A control transition that did not complete within its bound.
 *
 * The quiescence gate traded one failure mode for another: a transition that
 * issues store work through the scheduler no longer produces a burst of
 * transport errors, it produces a circular wait — the transition waits for work
 * to drain, and that work waits for the transition. Silent and indefinite is a
 * worse operational outcome than loud and wrong, so the wait is bounded and
 * reports exactly what it was blocked on.
 */
export class StoreControlBarrierTimeoutError extends Error {
  readonly code = 'STORE_CONTROL_BARRIER_TIMEOUT' as const;

  constructor(
    readonly phase: StoreControlBarrierPhase,
    readonly purpose: string,
    readonly elapsedMs: number,
    readonly blockedBy: StoreControlBarrierBlockers,
  ) {
    super(
      `Store control barrier "${purpose || 'unknown'}" timed out after ${elapsedMs} ms in the `
      + `${phase} phase (untagged inflight ${blockedBy.untaggedInflight}, tagged inflight for this `
      + `store ${blockedBy.taggedInflightForStore}, held runs ${blockedBy.heldRuns}). The usual `
      + 'cause is a transition that issues store work through the scheduler: a barrier owns the '
      + 'store exclusively, so work issued from inside one waits for the barrier waiting for it.',
    );
    this.name = 'StoreControlBarrierTimeoutError';
  }
}

/** Handle returned by {@link StorePriorityScheduler.sealStoreGeneration}. */
export interface StoreGenerationSeal {
  readonly storeId: object;
  readonly generation: string;
  /**
   * Commit the transition: release the seal, release every held `run()`, and
   * wake selection. Idempotent — a control path that commits in a `finally`
   * after an early `commit()` must not double-release.
   */
  commit(): void;
}
