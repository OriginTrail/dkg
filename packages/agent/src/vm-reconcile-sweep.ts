/** A bounded, process-local round-robin cursor; no iterator or key snapshot is retained. */
export class VmReconcileSweepSelector {
  private nextKey: string | undefined;
  private nextIndex = 0;

  reset(): void { this.nextKey = undefined; this.nextIndex = 0; }

  admit(
    keys: readonly string[],
    maximum: number,
    eligible: (key: string) => boolean,
    tryAdmit: (key: string) => boolean,
  ): void {
    if (keys.length === 0) { this.reset(); return; }
    const previous = this.nextKey === undefined ? -1 : keys.indexOf(this.nextKey);
    const start = previous < 0 ? this.nextIndex % keys.length : previous;
    let attempts = 0;
    for (let scanned = 0; scanned < keys.length && attempts < maximum; scanned++) {
      const index = (start + scanned) % keys.length;
      const key = keys[index]!;
      this.nextKey = key;
      this.nextIndex = index;
      if (eligible(key)) {
        attempts++;
        // Retry this candidate after capacity becomes available, without losing the tail.
        if (!tryAdmit(key)) return;
      }
      this.nextIndex = (index + 1) % keys.length;
      this.nextKey = keys[this.nextIndex];
    }
  }
}
