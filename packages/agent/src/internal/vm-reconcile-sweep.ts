import type { VmReconcileSweepAdmission } from './vm-reconcile-sweep-admission.js';

/** A scalar round-robin cursor over candidates already classified by the host. */
export class VmReconcileSweepSelector {
  private nextKey: string | undefined;
  private nextIndex = 0;

  reset(): void { this.nextKey = undefined; this.nextIndex = 0; }

  /** Return successful admissions; keep a rejected candidate for the next call. */
  admit(keys: readonly string[], maximum: number, tryAdmit: (key: string) => boolean): number {
    if (keys.length === 0) { this.reset(); return 0; }
    const previous = this.nextKey === undefined ? -1 : keys.indexOf(this.nextKey);
    const start = previous < 0 ? this.nextIndex % keys.length : previous;
    let admitted = 0;
    for (let scanned = 0; scanned < keys.length && admitted < maximum; scanned++) {
      const index = (start + scanned) % keys.length;
      const key = keys[index]!;
      this.nextKey = key;
      this.nextIndex = index;
      if (!tryAdmit(key)) break;
      admitted++;
      this.nextIndex = (index + 1) % keys.length;
      this.nextKey = keys[this.nextIndex];
    }
    return admitted;
  }
}

interface SweepTurnBase {
  /** Every key admitted in this retained turn, across both candidate classes. */
  readonly admittedKeys: Set<string>;
  /** Bound graphs admitted in this turn (discovery has a separate budget). */
  boundAdmissions: number;
  readonly completions: Promise<unknown>[];
  readonly finished: AbortController;
  releaseTimerCapacity?: () => void;
}

type SweepTurnState =
  | Readonly<{ phase: 'leading'; remainingDiscovery: number }>
  | Readonly<{ phase: 'discovery'; remainingDiscovery: number }>
  | Readonly<{ phase: 'tail' }>;

type SweepTurn = SweepTurnBase & (
  | {
    owner: 'timer';
    state: SweepTurnState;
  }
  | {
    owner: 'completion';
    /** A public caller claims a complete, finite bound rotation for this turn. */
    readonly fullBoundKeys: readonly string[];
    state: SweepTurnState;
  }
);

export interface VmReconcileSweepPlannerOptions {
  discoveryBatchSize: number;
  periodicBoundBatchSize?: number;
  maxOutstandingBound?: number;
}

/** Own real admissions and their completion handles throughout a discovery turn. */
export class VmReconcileSweepPlanner {
  private readonly bound = new VmReconcileSweepSelector();
  private readonly unbound = new VmReconcileSweepSelector();
  private readonly outstandingBound = new Set<Promise<unknown>>();
  private readonly discoveryBatchSize: number;
  private readonly periodicBoundBatchSize: number;
  private readonly maxOutstandingBound: number;
  private turn: SweepTurn | undefined;

  constructor(
    options: VmReconcileSweepPlannerOptions,
    private readonly retainCapacity: VmReconcileSweepAdmission['retainCapacity'],
  ) {
    this.discoveryBatchSize = options.discoveryBatchSize;
    this.periodicBoundBatchSize = options.periodicBoundBatchSize ?? 8;
    this.maxOutstandingBound = options.maxOutstandingBound ?? Number.POSITIVE_INFINITY;
  }

  reset(): void {
    if (this.turn) this.finish(this.turn);
    this.bound.reset();
    this.unbound.reset();
  }

  /** Timer admission is synchronous; retain a capacity-limited discovery turn. */
  admit(
    boundKeys: readonly string[],
    unboundKeys: readonly string[],
    tryAdmit: (key: string) => Promise<unknown> | undefined,
  ): void {
    const turn = this.currentTurn();
    if (turn.owner === 'completion') return;
    this.releaseTimerCapacity(turn);
    this.advanceTimerTurn(turn, boundKeys, unboundKeys, tryAdmit);
    if (!turn.finished.signal.aborted) {
      turn.releaseTimerCapacity = this.retainCapacity(turn.finished.signal);
    }
  }

  /**
   * Join retained admissions, then finish this turn's selected rotation.
   * Calls overlapping a partial admission turn join it; once admission is
   * complete a new call starts a new turn, with ordinary dispatcher coalescing.
   */
  async complete(
    boundKeys: readonly string[],
    unboundKeys: readonly string[],
    admission: VmReconcileSweepAdmission,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const isActive = () => isCurrent() && !signal?.aborted;
    if (!isActive() || admission.isClosed()) return;
    const turn = this.claimForCompletion(boundKeys);
    const waitingSignal = signal
      ? AbortSignal.any([signal, turn.finished.signal]) : turn.finished.signal;
    const releaseCapacity = this.retainCapacity(waitingSignal);
    try {
      while (!turn.finished.signal.aborted && isActive() && !admission.isClosed()) {
        this.advanceCompletionTurn(turn, unboundKeys,
          key => isActive() ? admission.tryAdmit(key) : undefined);
        if (turn.finished.signal.aborted || !isActive() || admission.isClosed()) break;
        // Successful admissions may wake another caller finishing this turn.
        // Finishing/resetting the turn also retires the capacity waiter.
        await admission.waitForChange(waitingSignal);
      }
    } finally {
      releaseCapacity();
    }
    await Promise.all(turn.completions);
  }

  private currentTurn(): SweepTurn {
    return this.turn ??= {
      owner: 'timer',
      state: { phase: 'leading', remainingDiscovery: this.discoveryBatchSize },
      admittedKeys: new Set(), boundAdmissions: 0,
      completions: [], finished: new AbortController(),
    };
  }

  private claimForCompletion(boundKeys: readonly string[]): SweepTurn {
    const current = this.currentTurn();
    this.releaseTimerCapacity(current);
    if (current.owner === 'completion') return current;
    const claimed: SweepTurn = {
      ...current,
      owner: 'completion',
      fullBoundKeys: [...boundKeys],
    };
    this.turn = claimed;
    return claimed;
  }

  private releaseTimerCapacity(turn: SweepTurn): void {
    turn.releaseTimerCapacity?.();
    turn.releaseTimerCapacity = undefined;
  }

  private finish(turn: SweepTurn): void {
    turn.finished.abort();
    if (this.turn === turn) this.turn = undefined;
  }

  /** Only timer-owned bound work consumes the historical backlog allowance. */
  private tryAdmitTimerBound(
    key: string,
    tryAdmit: (key: string) => Promise<unknown> | undefined,
  ): Promise<unknown> | undefined {
    if (this.outstandingBound.size >= this.maxOutstandingBound) return undefined;
    const completion = tryAdmit(key);
    if (completion === undefined) return undefined;
    if (!this.outstandingBound.has(completion)) {
      this.outstandingBound.add(completion);
      void completion.then(
        () => { this.outstandingBound.delete(completion); },
        () => { this.outstandingBound.delete(completion); },
      );
    }
    return completion;
  }

  private record(
    turn: SweepTurn,
    key: string,
    tryAdmit: (key: string) => Promise<unknown> | undefined,
    bound: boolean,
  ): boolean {
    const completion = tryAdmit(key);
    if (completion === undefined) return false;
    // Preserve the exact handle, including work coalesced with an earlier tick.
    turn.completions.push(completion.catch(() => undefined));
    turn.admittedKeys.add(key);
    if (bound) turn.boundAdmissions++;
    return true;
  }

  private admitLeadingBound(
    turn: SweepTurn,
    keys: readonly string[],
    tryAdmit: (key: string) => Promise<unknown> | undefined,
  ): boolean {
    return keys.length === 0 || this.bound.admit(keys, 1,
      key => this.record(turn, key, tryAdmit, true)) === 1;
  }

  private spendDiscovery(
    turn: SweepTurn,
    keys: readonly string[],
    remaining: number,
    tryAdmit: (key: string) => Promise<unknown> | undefined,
  ): number {
    let budget = Math.min(remaining, keys.length);
    this.unbound.admit(keys, budget, key => {
      if (!this.record(turn, key, tryAdmit, false)) return false;
      budget--;
      return true;
    });
    return budget;
  }

  private admitBoundTail(
    turn: SweepTurn,
    keys: readonly string[],
    limit: number,
    tryAdmit: (key: string) => Promise<unknown> | undefined,
  ): { admitted: number; available: number } {
    const tail = keys.filter(key => !turn.admittedKeys.has(key));
    const admitted = limit === 0 ? 0 : this.bound.admit(tail,
      Math.min(tail.length, limit), key => this.record(turn, key, tryAdmit, true));
    return { admitted, available: tail.length };
  }

  /** A timer tick spends discovery independently, then fills only its bound allowance. */
  private advanceTimerTurn(
    turn: SweepTurn,
    boundKeys: readonly string[],
    unboundKeys: readonly string[],
    tryAdmit: (key: string) => Promise<unknown> | undefined,
  ): void {
    if (turn.owner !== 'timer' || turn.finished.signal.aborted) return;
    const timerBound = (key: string) => this.tryAdmitTimerBound(key, tryAdmit);
    if (turn.state.phase === 'leading') {
      const remaining = turn.state.remainingDiscovery;
      if (!this.admitLeadingBound(turn, boundKeys, timerBound)) {
        // Keep the periodic capacity claim for dispatcher fairness. Discovery
        // can still run, but the rejected bound key waits for the next tick.
        turn.state = {
          phase: 'leading',
          remainingDiscovery: this.spendDiscovery(turn, unboundKeys, remaining, tryAdmit),
        };
        return;
      }
      turn.state = { phase: 'discovery', remainingDiscovery: remaining };
    }
    if (turn.state.phase === 'discovery') {
      const remaining = this.spendDiscovery(
        turn, unboundKeys, turn.state.remainingDiscovery, tryAdmit,
      );
      if (remaining > 0) {
        turn.state = { phase: 'discovery', remainingDiscovery: remaining };
        return;
      }
      turn.state = { phase: 'tail' };
    }
    this.admitBoundTail(
      turn,
      boundKeys,
      Math.max(0, this.periodicBoundBatchSize - turn.boundAdmissions),
      timerBound,
    );
    // A rejected tail retains the selector's round-robin cursor for the next
    // tick. Timer turns never own an unbounded completion drain.
    this.finish(turn);
  }

  /** An explicit completion owns one full finite bound rotation and retries. */
  private advanceCompletionTurn(
    turn: SweepTurn,
    unboundKeys: readonly string[],
    tryAdmit: (key: string) => Promise<unknown> | undefined,
  ): void {
    if (turn.owner !== 'completion' || turn.finished.signal.aborted) return;
    const boundKeys = turn.fullBoundKeys;
    if (turn.state.phase === 'leading') {
      if (!this.admitLeadingBound(turn, boundKeys, tryAdmit)) return;
      turn.state = { phase: 'discovery', remainingDiscovery: turn.state.remainingDiscovery };
    }
    if (turn.state.phase === 'discovery') {
      const remaining = this.spendDiscovery(
        turn, unboundKeys, turn.state.remainingDiscovery, tryAdmit,
      );
      if (remaining > 0) {
        turn.state = { phase: 'discovery', remainingDiscovery: remaining };
        return;
      }
      turn.state = { phase: 'tail' };
    }
    const { admitted, available } = this.admitBoundTail(
      turn, boundKeys, boundKeys.length, tryAdmit,
    );
    if (admitted < available) return;
    this.finish(turn);
  }

}
