/**
 * The ONE owner of reconciliation snapshot-acquisition ordering, extracted from the publisher
 * (PR #2380 r13 3884734172) so the protocol's sequencing is a property of this module's only
 * code path rather than caller discipline spread across an orchestration class.
 *
 * MODEL — acquisitions form a FIFO queue of release GATES (PR #2381 r1 3884946389: one
 * resolve-only promise per owner, representing the sole event a successor cares about —
 * permission to proceed). An acquisition installs its own gate synchronously, then awaits its
 * predecessor's. Once it owns the seam it draws the ordering SCOPE first — structurally
 * before the inventory read, so a snapshot's rank can never be assigned by read-completion
 * order (PR #2380 r11 🔴 3884193885: a hung read completing late must not outrank what a
 * successor installed from newer state; the sweep acts on absence, where no identity guard
 * applies). The owner's gate resolves at whichever comes first: its settlement (`finally`) or
 * its LEASE — a timer started when the owner starts executing, never at a waiter's entry
 * (r12 🔴 3884393225: entry-relative timers release a queued burst together and re-open
 * overlapping reads; owner leases promote exactly the head waiter, and every later waiter
 * stays behind the new owner's fresh lease). Serialization therefore degrades to overlap only
 * past a lease — availability over exactness for a hung read (r10 🔴 3883959795) — and a
 * bypassed owner completes still holding its pre-drawn older scope: refusable by rank, never
 * destructive. The gate is resolve-only, so a failed read rejects its own caller and can
 * never poison the queue (r7 🟡 3883690945).
 */

export interface ReconciliationSnapshotCoordinatorDeps<TInventory, TScope> {
  /** One fresh inventory read. Runs while this acquisition owns the seam (or past a lease). */
  readInventory(): Promise<TInventory>;
  /** Draw this acquisition's ordering scope; invoked before its read, in promotion order. */
  beginScope(): TScope;
  /** The owner lease in milliseconds. */
  leaseMs: number;
}

export class ReconciliationSnapshotCoordinator<TInventory, TScope> {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReconciliationSnapshotCoordinatorDeps<TInventory, TScope>) {}

  async acquire(): Promise<{ inventory: TInventory; scope: TScope }> {
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    const lease = setTimeout(release, Math.max(0, this.deps.leaseMs));
    try {
      const scope = this.deps.beginScope();
      const inventory = await this.deps.readInventory();
      return { inventory, scope };
    } finally {
      clearTimeout(lease);
      release();
    }
  }
}
