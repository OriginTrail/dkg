/**
 * INTERNAL to `StorePriorityScheduler`. Named `…-v1-internal` following this
 * package's convention for a module that is not API: this package publishes
 * `dist` wholesale, so the file name is the only signal a deep importer gets.
 * `StoreBarrierHostV1` in particular is a private callback contract between
 * two scheduler internals, not a surface to couple to. The stable public
 * types stay the ones re-exported from `store-priority-scheduler.ts`.
 *
 * The control-barrier subsystem: sequencing a store-exclusive transition.
 *
 * Split out of `StorePriorityScheduler`, which had grown two responsibilities —
 * priority admission, and this. The split is deliberately one-way: this
 * coordinator owns barrier LIFECYCLE (the pending set, the single running slot,
 * coalescing, the bound, and the metrics about barriers), and owns NO inflight
 * accounting whatsoever.
 *
 * That is the load-bearing constraint. Quiescence is decided from the same
 * counters the scheduler already maintains for admission, read through
 * {@link StoreBarrierHostV1} at the moment the decision is made. A barrier that
 * reports ready while work is still in flight is exactly the defect this
 * machinery exists to prevent, and duplicating the counters here — even as a
 * cache — would create a second source of truth for the one invariant that must
 * not drift.
 */

import {
  StoreControlBarrierTimeoutError,
  type StoreControlBarrierBlockers,
  type StoreGenerationSeal,
} from './store-barrier-contract.js';
import type { StoreControlBarrierKeyV1 } from './store-control-barrier-key-v1.js';

/** Label carried on a seal when the caller does not name a generation. */
const BARRIER_ANY_GENERATION = '*';

interface BarrierEntry {
  storeId: object;
  coalescingIdentity: string | object;
  purpose: string;
  transition: () => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  waitStartedAt: number;
  running: boolean;
  /** Guards the caller promise so a timeout and a late settle cannot both fire. */
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  seal: StoreGenerationSeal;
}

interface StoreControlBarrierBaseRequestV1<T> {
  readonly storeId: object;
  readonly purpose: string;
  readonly transition: () => Promise<T>;
  readonly generation?: string;
  readonly timeoutMs?: number;
}

interface StoreTypedControlBarrierRequestV1<T>
  extends StoreControlBarrierBaseRequestV1<T> {
  readonly key: StoreControlBarrierKeyV1<T>;
}

/**
 * What the coordinator needs from the scheduler, and nothing more.
 *
 * Every member is a QUERY against state the scheduler owns, or an instruction
 * to it. There is no setter for any counter: the coordinator cannot record
 * inflight even by accident.
 */
export interface StoreBarrierHostV1 {
  now(): number;
  /** Seals the store for the barrier's duration; the seal is committed here. */
  sealStoreGeneration(storeId: object, generation: string): StoreGenerationSeal;
  /**
   * What is still executing that could be touching `storeId` — the quiescence
   * question, asked as one question.
   *
   * On the hot path: `pump()` calls this from every completion, so it must stay
   * cheap. Deliberately excludes the diagnostic counters, which are O(stores)
   * and only needed when the bound expires.
   */
  quiescence(storeId: object): StoreBarrierQuiescenceV1;
  /** Diagnostics for an expired bound only. Never called while deciding readiness. */
  blockerDiagnostics(): StoreBarrierDiagnosticsV1;
  observeDepths(): void;
}

export interface StoreBarrierQuiescenceV1 {
  /** Inflight work carrying no store identity, so unattributable to any store. */
  readonly untaggedInflight: number;
  /** Inflight work tagged for this store, across every domain and generation. */
  readonly taggedInflightForStore: number;
}

export interface StoreBarrierDiagnosticsV1 {
  readonly generationsInflight: number;
  readonly heldRuns: number;
}

export interface StoreBarrierMetricsV1 {
  readonly inflight: number;
  readonly pending: number;
  readonly coalesced: number;
  readonly timeouts: number;
  readonly waitMs: number;
}

export class StoreControlBarrierCoordinator {
  private readonly barriers: BarrierEntry[] = [];
  private running: BarrierEntry | undefined;
  private coalescedTotal = 0;
  private timeoutsTotal = 0;
  private waitMsTotal = 0;

  constructor(
    private readonly host: StoreBarrierHostV1,
    private readonly defaultTimeoutMs: number,
  ) {}

  /**
   * Is any barrier pending or running for ANY store?
   *
   * Separate from {@link metrics} on purpose: admission consults this on the
   * hot path, and reading a diagnostics object to answer one scheduling
   * question both allocates and makes a reporting shape part of the control
   * contract — a metrics rename would then change admission behaviour.
   */
  hasPendingBarriers(): boolean {
    return this.barriers.length > 0;
  }

  get metrics(): StoreBarrierMetricsV1 {
    return {
      inflight: this.running ? 1 : 0,
      pending: this.barriers.length,
      coalesced: this.coalescedTotal,
      timeouts: this.timeoutsTotal,
      waitMs: this.waitMsTotal,
    };
  }

  enqueueLegacy(
    request: StoreControlBarrierBaseRequestV1<unknown>,
  ): Promise<unknown> {
    return this.enqueueWithIdentity(request.purpose, request);
  }

  enqueueTyped<T>(request: StoreTypedControlBarrierRequestV1<T>): Promise<T> {
    // Sound at this boundary: the nominal key binds every caller sharing this
    // runtime identity to one T.
    return this.enqueueWithIdentity(request.key, request) as Promise<T>;
  }

  private enqueueWithIdentity<T>(
    coalescingIdentity: string | object,
    request: StoreControlBarrierBaseRequestV1<T>,
  ): Promise<unknown> {
    const {
      storeId,
      purpose,
      transition,
      generation,
      timeoutMs,
    } = request;
    const existing = this.barriers.find(
      (barrier) =>
        barrier.storeId === storeId &&
        barrier.coalescingIdentity === coalescingIdentity,
    );
    if (existing !== undefined) {
      this.coalescedTotal += 1;
      this.host.observeDepths();
      return existing.promise;
    }
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const barrier: BarrierEntry = {
      storeId,
      coalescingIdentity,
      purpose,
      transition,
      promise,
      resolve,
      reject,
      waitStartedAt: this.host.now(),
      running: false,
      settled: false,
      // Sealing here is what makes the wait below terminate: without it a busy
      // store keeps admitting tagged work and never quiesces.
      seal: this.host.sealStoreGeneration(storeId, generation ?? BARRIER_ANY_GENERATION),
    };
    barrier.timer = setTimeout(() => this.fail(barrier), timeoutMs ?? this.defaultTimeoutMs);
    // Unref'd on purpose: a safety timer that kept a daemon alive through its
    // own shutdown would be worse than the deadlock it guards against.
    //
    // The consequence, which is NOT obvious: this bound can only fire while
    // something else holds the event loop open. A daemon always qualifies — a
    // listening server holds a ref'd handle — but a process that has quiesced
    // down to nothing but the deadlock exits silently instead.
    //
    // Practical consequence for tests: a real-timer test of this bound must
    // hold the loop open itself, or the process exits before the timer fires
    // and the run is recorded as a failure with a misleading cause.
    if (typeof barrier.timer.unref === 'function') barrier.timer.unref();
    this.barriers.push(barrier);
    this.host.observeDepths();
    this.pump();
    return promise;
  }

  /**
   * Starts at most one barrier: the reserved controller slot is single. Every
   * pending barrier WAITS concurrently (at zero slots), so a barrier blocked on
   * its own store cannot head-of-line block one that is already quiesced.
   */
  pump(): void {
    // Called from every completion, so the no-barrier case is one read.
    if (this.barriers.length === 0) return;
    if (this.running !== undefined) return;
    for (const barrier of this.barriers) {
      if (barrier.running) continue;
      if (!this.isReady(barrier)) continue;
      this.start(barrier);
      return;
    }
  }

  /**
   * Quiescence gate. A transition may start only once nothing is executing that
   * could still be touching the store it is about to stop.
   *
   * Two populations, treated differently:
   *
   * - **Untagged inflight** carries no store identity, so it can be neither
   *   attributed to this store nor ruled out. Waited on in full.
   * - **Tagged inflight for THIS store**, in every domain and every generation.
   *   Deliberately not narrowed to the sealed generation: the transition is a
   *   child-process restart, and the child it stops serves them all.
   *
   * Tagged work for OTHER stores is not waited on — it is attributable, and
   * provably not this store's.
   */
  private isReady(barrier: BarrierEntry): boolean {
    const { untaggedInflight, taggedInflightForStore } = this.host.quiescence(
      barrier.storeId,
    );
    return untaggedInflight === 0 && taggedInflightForStore === 0;
  }

  /**
   * Bound expired. Recovery differs by phase, and the difference matters:
   *
   * - **wait** — the transition never started, so nothing has been disrupted.
   *   The barrier is withdrawn completely and the store resumes. Fully
   *   recoverable, and this is the phase a circular wait actually lands in.
   * - **transition** — the transition is mid-flight and may be part-way through
   *   stopping a child. Releasing the seal here would admit work into a store
   *   that no longer exists, so the caller is told and the seal is left in
   *   place. If the transition ever settles, its own `finally` still cleans up,
   *   so this reports without permanently freezing the lane.
   */
  private fail(barrier: BarrierEntry): void {
    barrier.timer = undefined;
    if (barrier.settled) return;
    barrier.settled = true;
    this.timeoutsTotal += 1;
    barrier.reject(new StoreControlBarrierTimeoutError(
      barrier.running ? 'transition' : 'wait',
      barrier.purpose,
      Math.max(0, this.host.now() - barrier.waitStartedAt),
      this.describeBlockers(barrier),
    ));
    if (barrier.running) {
      this.host.observeDepths();
      return;
    }
    const index = this.barriers.indexOf(barrier);
    if (index >= 0) this.barriers.splice(index, 1);
    barrier.seal.commit();
    this.host.observeDepths();
    this.pump();
  }

  private describeBlockers(barrier: BarrierEntry): StoreControlBarrierBlockers {
    return {
      ...this.host.quiescence(barrier.storeId),
      ...this.host.blockerDiagnostics(),
    };
  }

  private start(barrier: BarrierEntry): void {
    barrier.running = true;
    this.running = barrier;
    const waitMs = Math.max(0, this.host.now() - barrier.waitStartedAt);
    this.waitMsTotal += waitMs;
    this.host.observeDepths();

    let result: Promise<unknown>;
    try {
      result = barrier.transition();
    } catch (err) {
      result = Promise.reject(err);
    }
    result
      .then(
        (value) => {
          if (barrier.settled) return;
          barrier.settled = true;
          barrier.resolve(value);
        },
        (err) => {
          if (barrier.settled) return;
          barrier.settled = true;
          barrier.reject(err);
        },
      )
      // Cleanup runs unconditionally, even for a transition already rejected by
      // the bound — a late settle must still unfreeze the lane.
      .finally(() => {
        if (barrier.timer !== undefined) {
          clearTimeout(barrier.timer);
          barrier.timer = undefined;
        }
        this.running = undefined;
        const index = this.barriers.indexOf(barrier);
        if (index >= 0) this.barriers.splice(index, 1);
        // Commit releases the seal, the held `run()` calls, and wakes selection.
        barrier.seal.commit();
        this.host.observeDepths();
        this.pump();
      });
  }
}
