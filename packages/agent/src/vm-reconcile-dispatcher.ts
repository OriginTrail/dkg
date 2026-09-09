/** Agent-owned admission and scheduling for chain-driven VM reconciliation. */

import type { VmReconcileSweepAdmission } from './internal/vm-reconcile-sweep-admission.js';
import { VmReconcileSweepPlanner } from './internal/vm-reconcile-sweep.js';
import {
  VmReconcileQueueClosedError,
  VmReconcileQueueFullError,
  type VmReconcileSource,
} from './vm-reconcile-service.js';

/**
 * Per-CG, source-aware single-flight scheduling policy for VM reconciliation.
 *
 * Live chain events are latency nudges, while the periodic sweep is the
 * reliability path. After a failed VM pass, live nudges for that CG are held so
 * they cannot hot-loop the same expensive store/RPC work. The next periodic
 * sweep explicitly releases the hold and retries. Failure logging also lives at
 * this scheduling boundary; the domain operation remains a normal rejecting
 * async function. Each key has one prioritized queued source and an explicit
 * live-failure hold, so invalid combinations of pending flags are impossible.
 * This is the single owner of per-key coalescing semantics: a burst produces at
 * most one trailing pass, with periodic work taking priority over live nudges.
 * Trigger methods are deliberately fire-and-forget; callers that need a
 * completion boundary must use waitForIdle() explicitly. Agent/API result
 * models and route-facing errors live in `vm-reconcile-service.ts`.
 */
type VmReconcileHold = 'ready' | 'live-blocked';

interface VmReconcileDispatchWork<T> {
  key: string;
  source: VmReconcileSource;
  automatic: boolean;
  periodicRequested: boolean;
  sequence: number;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface VmReconcileDispatchState<T> {
  hold: VmReconcileHold;
  /** Increments whenever a binding change supplies fresh live-retry evidence. */
  releaseGeneration: number;
  active?: VmReconcileDispatchWork<T>;
  pending?: VmReconcileDispatchWork<T>;
  trailing?: VmReconcileDispatchWork<T>;
}

type VmReconcileAdmission<T> =
  | { kind: 'admitted' | 'coalesced'; completion: Promise<T> }
  | { kind: 'full' | 'closed' };

export interface VmReconcileDispatcherOptions {
  concurrency?: number;
  maxPending?: number;
  maxForegroundBurst?: number;
}

function vmReconcileSourceRank(source: VmReconcileSource): number {
  if (source === 'manual') return 2;
  if (source === 'live') return 1;
  return 0;
}

/**
 * Single admission and scheduling policy for chain-driven VM reconciliation.
 *
 * This dispatcher owns per-CG coalescing, live failure holds, pending priority
 * upgrades, global concurrency, overload bounds, foreground fairness, and
 * shutdown. Keeping those decisions in one state machine prevents a CG from
 * looking active to one scheduler while it is only queued in another.
 */
export class VmReconcileDispatcher<T> {
  private active = 0;
  private queued = 0;
  private sequence = 0;
  private foregroundBurst = 0;
  protected closed = false;
  private readonly states = new Map<string, VmReconcileDispatchState<T>>();
  private readonly pending: Array<VmReconcileDispatchWork<T>> = [];
  private readonly idleWaiters = new Set<() => void>();
  private readonly periodicStateWaiters = new Set<() => void>();
  private readonly keyIdleWaiters = new Map<string, Set<() => void>>();
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly maxForegroundBurst: number;
  constructor(
    private readonly run: (key: string, source: VmReconcileSource) => Promise<T>,
    private readonly onFailure: (key: string, error: unknown) => void,
    options: VmReconcileDispatcherOptions = {},
  ) {
    const {
      concurrency = 1,
      maxPending = 256,
      maxForegroundBurst = 8,
    } = options;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error(`VM reconcile concurrency must be a positive safe integer, got ${concurrency}`);
    }
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new Error(`VM reconcile maxPending must be a positive safe integer, got ${maxPending}`);
    }
    if (!Number.isSafeInteger(maxForegroundBurst) || maxForegroundBurst < 1) {
      throw new Error(`VM reconcile maxForegroundBurst must be a positive safe integer, got ${maxForegroundBurst}`);
    }
    this.concurrency = concurrency;
    this.maxPending = maxPending;
    this.maxForegroundBurst = maxForegroundBurst;
  }

  /** Enqueue a low-latency chain-event nudge; suppressed until a sweep after failure. */
  triggerLive(key: string): void {
    if (this.states.get(key)?.hold === 'live-blocked') return;
    void this.dispatch(key, 'live').catch(() => undefined);
  }

  /** A newly established binding is fresh evidence, so its first live nudge must not inherit an old discovery miss. */
  releaseLiveHold(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    // Record the evidence even while a pass is active. Otherwise that older
    // pass could fail after the rebind and restore the hold over a fresh nudge.
    state.releaseGeneration += 1;
    state.hold = 'ready';
    if (!state.active && !state.pending && !state.trailing) this.states.delete(key);
  }

  /** Enqueue the reliability path; every periodic sweep gets one failure retry. */
  triggerPeriodic(key: string): void {
    void this.dispatch(key, 'periodic').catch(() => undefined);
  }

  /**
   * Attempt periodic admission without hiding bounded-queue overflow.
   *
   * Sweep orchestration retains its round-robin cursor at the first rejected
   * key, so stable iteration order cannot permanently starve the tail. Keep
   * one pending slot for manual/live work; immediately runnable background work
   * and coalescing do not consume that reserve.
   */
  tryTriggerPeriodic(key: string): boolean {
    return this.tryDispatchPeriodic(key) !== undefined;
  }

  /** Periodic admission with its exact completion handle; undefined means no admission. */
  protected tryDispatchPeriodic(key: string): Promise<T> | undefined {
    const outcome = this.admit(key, 'periodic');
    if (!('completion' in outcome)) return undefined;
    void outcome.completion.catch(() => undefined);
    return outcome.completion;
  }

  protected waitForPeriodicStateChange(signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      const finish = () => {
        this.periodicStateWaiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      this.periodicStateWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (this.closed || signal?.aborted) finish();
    });
  }

  private resolvePeriodicStateWaiters(): void {
    for (const resolve of this.periodicStateWaiters) resolve();
    this.periodicStateWaiters.clear();
  }

  /** Operator path; errors and the typed domain result propagate to the API. */
  triggerManual(key: string): Promise<T> {
    return this.dispatch(key, 'manual');
  }

  /** Typed admission used by the canonical agent operation and focused tests. */
  dispatch(key: string, source: VmReconcileSource): Promise<T> {
    const outcome = this.admit(key, source);
    if ('completion' in outcome) return outcome.completion;
    return Promise.reject(outcome.kind === 'closed'
      ? new VmReconcileQueueClosedError()
      : new VmReconcileQueueFullError(this.maxPending));
  }

  isInFlight(key: string): boolean {
    const state = this.states.get(key);
    return Boolean(state?.active || state?.pending || state?.trailing);
  }

  pendingSource(key: string): VmReconcileSource | undefined {
    return this.states.get(key)?.pending?.source;
  }

  snapshot(): { active: number; queued: number; closed: boolean } {
    return { active: this.active, queued: this.queued, closed: this.closed };
  }

  /** Reject queued work immediately and wait only for already-active work. */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      const error = new VmReconcileQueueClosedError();
      for (const work of this.pending.splice(0)) {
        const state = this.states.get(work.key);
        if (state?.pending === work) state.pending = undefined;
        work.reject(error);
      }
      for (const [key, state] of this.states) {
        if (state.trailing) {
          state.trailing.reject(error);
          state.trailing = undefined;
        }
        if (!state.active) this.states.delete(key);
        this.resolveKeyIdleWaiters(key);
      }
      this.queued = 0;
      this.resolvePeriodicStateWaiters();
      this.resolveIdleWaiters();
    }
    return this.waitForIdle();
  }

  /** Wait globally for shutdown, or for one CG including its trailing pass. */
  waitForIdle(key?: string): Promise<void> {
    if (key !== undefined) {
      if (!this.isInFlight(key)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let waiters = this.keyIdleWaiters.get(key);
        if (!waiters) {
          waiters = new Set();
          this.keyIdleWaiters.set(key, waiters);
        }
        waiters.add(resolve);
      });
    }
    if (this.active === 0 && this.queued === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private stateFor(key: string): VmReconcileDispatchState<T> {
    let state = this.states.get(key);
    if (!state) {
      state = { hold: 'ready', releaseGeneration: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  /** One synchronous transition owns coalescing, capacity and source reservation. */
  private admit(key: string, source: VmReconcileSource): VmReconcileAdmission<T> {
    const outcome = this.admitState(key, source);
    // A newly admitted foreground trailing pass can make a waiting periodic
    // request coalescible without freeing queue capacity. Failed attempts never
    // wake other rejected attempts, which would recreate a retry spin.
    if ('completion' in outcome) this.resolvePeriodicStateWaiters();
    return outcome;
  }

  private admitState(key: string, source: VmReconcileSource): VmReconcileAdmission<T> {
    if (this.closed) return { kind: 'closed' };
    const state = this.stateFor(key);

    if (state.pending) {
      this.mergeWork(state.pending, source);
      this.sortPending();
      return { kind: 'coalesced', completion: state.pending.promise };
    }

    if (state.active) {
      // An operator request must observe a head snapshot taken no earlier than
      // that request. It may share an already-active operator pass, but never
      // an older automatic pass. In that case it joins or creates one fresh
      // trailing pass; repeated operator requests coalesce there.
      if (source === 'manual' && state.active.source === 'manual') {
        return { kind: 'coalesced', completion: state.active.promise };
      }
      if (state.trailing) {
        this.mergeWork(state.trailing, source);
        return { kind: 'coalesced', completion: state.trailing.promise };
      }
      const trailing = this.createQueuedWork(key, source, 'trailing');
      if (!trailing) return { kind: 'full' };
      state.trailing = trailing;
      return { kind: 'admitted', completion: trailing.promise };
    }

    const work = this.createQueuedWork(key, source, 'pending');
    if (!work) {
      if (state.hold === 'ready') this.states.delete(key);
      return { kind: 'full' };
    }
    state.pending = work;
    this.pending.push(work);
    this.sortPending();
    this.drain();
    return { kind: 'admitted', completion: work.promise };
  }

  private createQueuedWork(
    key: string,
    source: VmReconcileSource,
    placement: 'pending' | 'trailing',
  ): VmReconcileDispatchWork<T> | undefined {
    const immediatelyRunnable = placement === 'pending' && this.active < this.concurrency;
    const pendingLimit = source === 'periodic' && !immediatelyRunnable
      ? this.maxPending - 1 : this.maxPending;
    if (this.queued >= pendingLimit) return undefined;
    let resolveWork!: (value: T) => void;
    let rejectWork!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveWork = resolve;
      rejectWork = reject;
    });
    this.queued += 1;
    return {
      key,
      source,
      automatic: source !== 'manual',
      periodicRequested: source === 'periodic',
      sequence: this.sequence++,
      promise,
      resolve: resolveWork,
      reject: rejectWork,
    };
  }

  private sortPending(): void {
    this.pending.sort((a, b) => {
      const priorityDelta = (a.source === 'periodic' ? 1 : 0)
        - (b.source === 'periodic' ? 1 : 0);
      return priorityDelta || a.sequence - b.sequence;
    });
  }

  private mergeWork(work: VmReconcileDispatchWork<T>, source: VmReconcileSource): void {
    work.automatic ||= source !== 'manual';
    work.periodicRequested ||= source === 'periodic';
    if (vmReconcileSourceRank(source) > vmReconcileSourceRank(work.source)) {
      work.source = source;
    }
  }

  private takeNext(): VmReconcileDispatchWork<T> | undefined {
    if (this.pending.length === 0) return undefined;
    let index = 0;
    if (this.foregroundBurst >= this.maxForegroundBurst) {
      const backgroundIndex = this.pending.findIndex((work) => work.source === 'periodic');
      if (backgroundIndex >= 0) index = backgroundIndex;
    }
    const [work] = this.pending.splice(index, 1);
    if (!work) return undefined;
    const state = this.states.get(work.key);
    if (state?.pending === work) state.pending = undefined;
    this.queued -= 1;
    if (work.source !== 'periodic') this.foregroundBurst += 1;
    else this.foregroundBurst = 0;
    return work;
  }

  private resolveIdleWaiters(): void {
    if (this.active !== 0 || this.queued !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private resolveKeyIdleWaiters(key: string): void {
    if (this.isInFlight(key)) return;
    const waiters = this.keyIdleWaiters.get(key);
    if (!waiters) return;
    this.keyIdleWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }

  private drain(): void {
    while (!this.closed && this.active < this.concurrency && this.pending.length > 0) {
      const work = this.takeNext();
      if (!work) return;
      const state = this.stateFor(work.key);
      state.active = work;
      if (work.periodicRequested) state.hold = 'ready';
      const releaseGeneration = state.releaseGeneration;
      this.active += 1;
      let failure: unknown;
      void Promise.resolve()
        .then(() => this.run(work.key, work.source))
        .then(
          (result) => {
            // Any successful full pass, including an operator-forced recovery,
            // proves the failed-live hold can be released.
            state.hold = 'ready';
            work.resolve(result);
          },
          (error) => {
            failure = error;
            if (work.automatic) {
              if (state.releaseGeneration === releaseGeneration) {
                state.hold = 'live-blocked';
              }
              try {
                this.onFailure(work.key, error);
              } catch {
                // Observability must never break admission or callers.
              }
            }
            work.reject(error);
          },
        )
        .finally(() => {
          this.active -= 1;
          state.active = undefined;
          const trailing = state.trailing;
          state.trailing = undefined;
          if (
            trailing
            && state.hold === 'live-blocked'
            && trailing.source === 'live'
            && !trailing.periodicRequested
          ) {
            // A failing live pass must not immediately retry itself. Preserve
            // the failure hold until the periodic reliability path arrives.
            // A manual completion boundary is never suppressed by this rule.
            this.queued -= 1;
            trailing.reject(failure);
          } else if (trailing && !this.closed) {
            state.pending = trailing;
            this.pending.push(trailing);
            this.sortPending();
          } else if (!trailing && state.hold === 'ready') {
            this.states.delete(work.key);
          }
          this.drain();
          this.resolvePeriodicStateWaiters();
          this.resolveIdleWaiters();
          this.resolveKeyIdleWaiters(work.key);
        });
    }
  }
}

/** Module-private bridge: the sweep capability never escapes the cohesive runtime. */
class VmReconcileRuntimeDispatcher<T> extends VmReconcileDispatcher<T> {
  constructor(
    run: (key: string, source: VmReconcileSource) => Promise<T>,
    onFailure: (key: string, error: unknown) => void,
    options: VmReconcileDispatcherOptions,
    installSweepAdmission: (admission: VmReconcileSweepAdmission<T>) => void,
  ) {
    super(run, onFailure, options);
    installSweepAdmission(Object.freeze({
      tryAdmit: (key: string) => this.tryDispatchPeriodic(key),
      waitForChange: (signal?: AbortSignal) => this.waitForPeriodicStateChange(signal),
      isClosed: () => this.closed,
    }));
  }
}

/**
 * Cohesive host-owned runtime for foreground nudges and periodic sweep work.
 *
 * The dispatcher/planner relationship and exact-completion admission bridge
 * are deliberately private, leaving one lifecycle and scheduling identity at
 * the agent boundary.
 */
export class VmReconcileSchedulingRuntime<T> {
  private readonly dispatcher: VmReconcileRuntimeDispatcher<T>;
  private readonly planner: VmReconcileSweepPlanner;
  private readonly sweepAdmission: VmReconcileSweepAdmission<T>;

  constructor(
    run: (key: string, source: VmReconcileSource) => Promise<T>,
    onFailure: (key: string, error: unknown) => void,
    options: VmReconcileDispatcherOptions = {},
    discoveryBatchSize = 8,
  ) {
    let sweepAdmission!: VmReconcileSweepAdmission<T>;
    this.dispatcher = new VmReconcileRuntimeDispatcher(
      run,
      onFailure,
      options,
      (admission) => { sweepAdmission = admission; },
    );
    this.planner = new VmReconcileSweepPlanner(discoveryBatchSize);
    this.sweepAdmission = sweepAdmission;
  }

  triggerLive(key: string): void { this.dispatcher.triggerLive(key); }
  releaseLiveHold(key: string): void { this.dispatcher.releaseLiveHold(key); }
  triggerPeriodic(key: string): void { this.dispatcher.triggerPeriodic(key); }
  tryTriggerPeriodic(key: string): boolean { return this.dispatcher.tryTriggerPeriodic(key); }
  triggerManual(key: string): Promise<T> { return this.dispatcher.triggerManual(key); }
  dispatch(key: string, source: VmReconcileSource): Promise<T> {
    return this.dispatcher.dispatch(key, source);
  }
  isInFlight(key: string): boolean { return this.dispatcher.isInFlight(key); }
  pendingSource(key: string): VmReconcileSource | undefined {
    return this.dispatcher.pendingSource(key);
  }
  snapshot(): { active: number; queued: number; closed: boolean } {
    return this.dispatcher.snapshot();
  }
  waitForIdle(key?: string): Promise<void> { return this.dispatcher.waitForIdle(key); }

  scheduleSweep(
    boundKeys: readonly string[],
    unboundKeys: readonly string[],
    isCurrent: () => boolean,
  ): void {
    this.planner.admit(
      boundKeys,
      unboundKeys,
      key => isCurrent() ? this.sweepAdmission.tryAdmit(key) : undefined,
    );
  }

  completeSweep(
    boundKeys: readonly string[],
    unboundKeys: readonly string[],
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.planner.complete(
      boundKeys,
      unboundKeys,
      this.sweepAdmission,
      isCurrent,
      signal,
    );
  }

  resetSweep(): void { this.planner.reset(); }

  close(): Promise<void> {
    this.planner.reset();
    return this.dispatcher.close();
  }
}
