import { findTripleStoreCapability } from '@origintrail-official/dkg-storage';

/**
 * Process-wide record, per store and control graph, that a scan found no LEGACY un-indexed
 * VM-publish row (OT-RFC-73 P7). Admission asks it whether the unbounded fallback branch of the
 * duplicate check is still needed. Every writer since #1828 indexes every VM-publish job and the
 * boot backfill indexes the rest, so once a scan has found none the fallback only costs a join
 * over the whole retained history.
 *
 * The state is static and keyed by store identity, like `AsyncLiftQueueScheduler`: the daemon's
 * admission publisher and its runtime publisher are separate instances over one store, and a
 * memo per instance would make each of them pay the scan again. The identity follows only the
 * documented decorator accessor, so a decorated view of a store shares its backend's memo.
 * A new process starts with nothing learned. Reads never allocate: a short-lived publisher
 * retains no global state until a scan has actually cleared its graph.
 *
 * Accepted narrowing (P7's own, an extension of plan D-5): a legacy un-indexed VM-publish row that
 * appears after the memo has cleared is not seen until the next boot backfill or process restart.
 * Nothing writes such a row any more and each node owns its store, so it does not arise in practice.
 */
export class LiftLegacyScanMemo {
  private static readonly cleared = new WeakMap<object, Set<string>>();
  private readonly identity: object;

  constructor(store: object, private readonly graphUri: string) {
    this.identity = findTripleStoreCapability(store, (candidate): candidate is object =>
      typeof candidate === 'object' && candidate !== null && !('innerStore' in candidate)) ?? store;
  }

  /** True until a scan of this store and graph has found no un-indexed VM-publish row. */
  scanRequired(): boolean {
    return !LiftLegacyScanMemo.cleared.get(this.identity)?.has(this.graphUri);
  }

  /** A scan found no un-indexed VM-publish row: later admissions of this process skip the fallback. */
  clear(): void {
    let graphs = LiftLegacyScanMemo.cleared.get(this.identity);
    if (!graphs) {
      graphs = new Set();
      LiftLegacyScanMemo.cleared.set(this.identity, graphs);
    }
    graphs.add(this.graphUri);
  }

  /**
   * Test-only: forget what was learned, as a process restart does, so a test can seed legacy rows
   * and watch the memo clear again. Nothing in the daemon calls it.
   * @internal
   */
  forgetForTesting(): void {
    LiftLegacyScanMemo.cleared.get(this.identity)?.delete(this.graphUri);
  }
}
