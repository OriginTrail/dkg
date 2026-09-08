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

/** Own both cursors and the unfinished discovery turn across backlogged sweeps. */
export class VmReconcileSweepPlanner {
  private readonly bound = new VmReconcileSweepSelector();
  private readonly unbound = new VmReconcileSweepSelector();
  private remainingDiscovery = 0;

  constructor(private readonly discoveryBatchSize: number) {}

  reset(): void {
    this.bound.reset();
    this.unbound.reset();
    this.remainingDiscovery = 0;
  }

  admit(boundKeys: readonly string[], unboundKeys: readonly string[], tryAdmit: (key: string) => boolean): void {
    let firstBound = 0;
    if (this.remainingDiscovery === 0) {
      // Start each turn with bound work. A capacity-limited discovery turn then
      // keeps priority until its bounded allowance is spent, even across ticks.
      firstBound = this.bound.admit(boundKeys, 1, tryAdmit);
      if (boundKeys.length > 0 && firstBound === 0) return;
      this.remainingDiscovery = Math.min(this.discoveryBatchSize, unboundKeys.length);
    }
    this.remainingDiscovery = Math.min(this.remainingDiscovery, unboundKeys.length);
    this.remainingDiscovery -= this.unbound.admit(unboundKeys, this.remainingDiscovery, tryAdmit);
    if (this.remainingDiscovery > 0) return;
    // A single bound rotation needs no exclusion set: the first admission has
    // already advanced its cursor. The dispatcher preserves foreground room.
    this.bound.admit(boundKeys, boundKeys.length - firstBound, tryAdmit);
  }
}
