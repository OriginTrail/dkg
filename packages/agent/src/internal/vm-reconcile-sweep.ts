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

/** Own real admissions and their completion handles throughout a discovery turn. */
export class VmReconcileSweepPlanner {
  private readonly bound = new VmReconcileSweepSelector();
  private readonly unbound = new VmReconcileSweepSelector();
  private turn: SweepTurn | undefined;

  constructor(
    private readonly discoveryBatchSize: number,
    private readonly retainCapacity: VmReconcileSweepAdmission['retainCapacity'],
  ) {}

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
    this.releaseTimerCapacity(turn);
    this.advance(turn, boundKeys, unboundKeys, tryAdmit);
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
        this.advance(turn, boundKeys, unboundKeys,
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
      admittedKeys: new Set(), completions: [], finished: new AbortController(),
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

  private advance(
    turn: SweepTurn,
    boundKeys: readonly string[],
    unboundKeys: readonly string[],
    tryAdmit: (key: string) => Promise<unknown> | undefined,
  ): void {
    if (turn.finished.signal.aborted) return;
    const boundRotation = turn.owner === 'completion' ? turn.fullBoundKeys : boundKeys;
    const accept = (key: string): boolean => {
      const completion = tryAdmit(key);
      if (completion === undefined) return false;
      // Automatic failures are reported by the dispatcher. Retain each exact
      // handle immediately, including work admitted by an earlier timer tick.
      turn.completions.push(completion.catch(() => undefined));
      return true;
    };
    if (turn.state.phase === 'leading') {
      const count = this.bound.admit(boundRotation, 1, key => {
        if (!accept(key)) return false;
        turn.admittedKeys.add(key);
        return true;
      });
      if (boundRotation.length > 0 && count === 0) return;
      turn.state = {
        phase: 'discovery',
        remainingDiscovery: turn.state.remainingDiscovery,
      };
    }
    if (turn.state.phase === 'discovery') {
      let remainingDiscovery = Math.min(
        turn.state.remainingDiscovery,
        unboundKeys.length,
      );
      this.unbound.admit(unboundKeys, remainingDiscovery, key => {
        if (!accept(key)) return false;
        turn.admittedKeys.add(key);
        remainingDiscovery--;
        return true;
      });
      if (remainingDiscovery > 0) {
        turn.state = { phase: 'discovery', remainingDiscovery };
        return;
      }
      turn.state = { phase: 'tail' };
    }
    const tail = boundRotation.filter(key => !turn.admittedKeys.has(key));
    const count = this.bound.admit(tail, tail.length, key => {
      if (!accept(key)) return false;
      turn.admittedKeys.add(key);
      return true;
    });
    if (turn.owner === 'completion' && count < tail.length) return;
    // A timer's rejected tail leads its next discovery turn. Public callers
    // retain the tail until admitted, so their finite selected rotation drains.
    this.finish(turn);
  }
}
