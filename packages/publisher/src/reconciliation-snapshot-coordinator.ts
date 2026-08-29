/**
 * The ONE owner of reconciliation snapshot-acquisition ordering, extracted from the publisher
 * (PR #2380 r13 3884734172) so the protocol's sequencing is a property of this module's only
 * code path rather than caller discipline spread across an orchestration class.
 *
 * MODEL — acquisitions form a FIFO queue. The head acquisition (the "owner") executes: it
 * draws the ordering SCOPE first — structurally before the inventory read, so a snapshot's
 * rank can never be assigned by read-completion order (PR #2380 r11 🔴 3884193885: a hung
 * read completing late must not outrank what a successor installed from newer state; the
 * sweep acts on absence, where no identity guard applies). A successor waits for its
 * predecessor to SETTLE or for the predecessor's LEASE — measured from the moment the
 * predecessor STARTED executing, never from the waiter's own entry — to expire, whichever
 * comes first (r12 🔴 3884393225: entry-relative timers release a queued burst together and
 * re-open overlapping reads; owner leases promote exactly the head waiter, and every later
 * waiter stays behind the new owner's fresh lease). Serialization therefore degrades to
 * overlap only past a lease — availability over exactness for a hung read (r10 🔴
 * 3883959795) — and a bypassed owner completes still holding its pre-drawn older scope:
 * refusable by rank, never destructive. A failed acquisition never poisons the queue — the
 * tail carries settlement only (r7 🟡 3883690945).
 */

export interface ReconciliationSnapshotCoordinatorDeps<TInventory, TScope> {
  /** One fresh inventory read. Runs while this acquisition owns the seam (or past a lease). */
  readInventory(): Promise<TInventory>;
  /** Draw this acquisition's ordering scope; invoked before its read, in promotion order. */
  beginScope(): TScope;
  /** The owner lease in milliseconds; read per acquisition so configuration stays live. */
  leaseMs(): number;
}

export class ReconciliationSnapshotCoordinator<TInventory, TScope> {
  private tail: { settled: Promise<void>; leaseExpired: Promise<void> } = {
    settled: Promise.resolve(),
    leaseExpired: Promise.resolve(),
  };

  constructor(private readonly deps: ReconciliationSnapshotCoordinatorDeps<TInventory, TScope>) {}

  async acquire(): Promise<{ inventory: TInventory; scope: TScope }> {
    const predecessor = this.tail;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const acquisition = (async () => {
      await Promise.race([predecessor.settled, predecessor.leaseExpired]);
      markStarted();
      const scope = this.deps.beginScope();
      const inventory = await this.deps.readInventory();
      return { inventory, scope };
    })();
    const settled = acquisition.then(() => undefined, () => undefined);
    const leaseExpired = started.then(() => new Promise<void>((resolve) => {
      const lease = setTimeout(resolve, Math.max(0, this.deps.leaseMs()));
      void settled.finally(() => {
        clearTimeout(lease);
        resolve();
      });
    }));
    this.tail = { settled, leaseExpired };
    return acquisition;
  }
}
