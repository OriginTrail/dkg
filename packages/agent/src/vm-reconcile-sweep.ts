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

type SweepTurn =
  | { phase: 'ready' }
  | { phase: 'discovery'; leadingBoundKey: string | undefined; remaining: number };

/** Own the complete discovery turn, including its leading bound admission. */
export class VmReconcileSweepPlanner {
  private readonly bound = new VmReconcileSweepSelector();
  private readonly unbound = new VmReconcileSweepSelector();
  private turn: SweepTurn = { phase: 'ready' };

  constructor(private readonly discoveryBatchSize: number) {}

  reset(): void {
    this.bound.reset();
    this.unbound.reset();
    this.turn = { phase: 'ready' };
  }

  admit(boundKeys: readonly string[], unboundKeys: readonly string[], accepted: (key: string) => boolean): void {
    if (this.turn.phase === 'ready') {
      let leadingBoundKey: string | undefined;
      const count = this.bound.admit(boundKeys, 1, key => {
        if (!accepted(key)) return false;
        leadingBoundKey = key;
        return true;
      });
      if (boundKeys.length > 0 && count === 0) return;
      this.turn = {
        phase: 'discovery', leadingBoundKey,
        remaining: Math.min(this.discoveryBatchSize, unboundKeys.length),
      };
    }
    const turn = this.turn;
    turn.remaining = Math.min(turn.remaining, unboundKeys.length);
    turn.remaining -= this.unbound.admit(unboundKeys, turn.remaining, accepted);
    if (turn.remaining > 0) return;
    this.turn = { phase: 'ready' };
    // Candidates can disappear or reorder while discovery is paused. Exclude
    // the actual leading key, rather than reconstructing its position/count.
    const tail = boundKeys.filter(key => key !== turn.leadingBoundKey);
    this.bound.admit(tail, tail.length, accepted);
    // A rejected tail key leads the next turn. Do not let an arbitrarily large
    // bound backlog postpone the next bounded discovery allowance indefinitely.
  }
}
