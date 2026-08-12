import {
  storageInputProjectionKeyV1,
  type VerdictDiffCellV1,
} from './authority-verdict-diff-cells-v1.js';
import {
  buildCoreCandidateHeadV1,
  coreHeadShapeKeyV1,
} from './authority-verdict-diff-core-heads-v1.js';
import {
  mintStorageSummaryForHeadV1,
  prepareStorageDriverV1,
  type StorageDriveOutcomeV1,
} from './authority-verdict-diff-storage-driver-v1.js';

/**
 * THE STORAGE HALF OF THE SWEEP, shaped exactly like the core half.
 *
 * Driven per PROJECTION, never per cell. Cells sharing
 * `storageInputProjectionKeyV1` present byte-identical inputs to the storage
 * entry, so one evaluation serves all 192 of them -- which is what turns 164,160
 * cells into 855 groups and 114 actual derivations.
 *
 * THE HEAD SHAPE IS CONSTANT INSIDE A STORAGE PROJECTION, and that is why one
 * representative is sound rather than convenient: `coreHeadShapeKeyV1` reads
 * axes A, C, D, E, F, G and K, every one of which is storage-VISIBLE, so no two
 * cells in a group can want different candidate heads. The invisible axes are I
 * and J, and neither reaches a head.
 */

export type StorageProjectionOutcomeV1 =
  /** The candidate head itself is unbuildable -- axis-F contradictions F1/F2/F3. */
  | { readonly kind: 'head-refused'; readonly ruleId: string; readonly message: string }
  /**
   * No verified authority summary can be minted for this head, so the storage
   * entry cannot be driven AT ALL. It is a REQUIRED field on all three facts
   * variants and is bind-checked at system-record-next-state-v1-internal.ts:862
   * -866, behind the brand assert at :850 -- so there is no way to reach the
   * classifier without one, and no verdict to compare.
   */
  | { readonly kind: 'summary-unmintable'; readonly message: string }
  | { readonly kind: 'driven'; readonly outcome: StorageDriveOutcomeV1 };

export interface StorageProjectionRowV1 {
  readonly projectionKey: string;
  readonly cellCount: number;
  readonly headShapeKey: string;
  readonly outcome: StorageProjectionOutcomeV1;
}

/**
 * `onUnresolved` receives every `objectKind:digest` the mint walk asked for and
 * the fixture could not answer.
 *
 * Threaded through the REAL sweep rather than audited by a parallel walk on
 * purpose. A second walk built to check the first can drift from it, and then
 * the audit reports on a graph nobody drives -- the same "two halves asking
 * different questions" failure this harness exists to catch, wearing an
 * auditor's clothes. Optional so no existing caller changes; the audit passes a
 * collector and asserts the result is empty.
 */
export async function runStorageSweepV1(
  cells: readonly VerdictDiffCellV1[],
  onUnresolved?: (reference: string) => void,
): Promise<readonly StorageProjectionRowV1[]> {
  const groups = new Map<string, { representative: VerdictDiffCellV1; count: number }>();
  for (const cell of cells) {
    const key = storageInputProjectionKeyV1(cell);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { representative: cell, count: 1 });
    else existing.count += 1;
  }

  const driver = await prepareStorageDriverV1();
  // Memoised on the head SHAPE, not on the projection: minting a closure is the
  // expensive step and 855 groups share a few dozen shapes.
  const heads = new Map<string, ReturnType<typeof buildCoreCandidateHeadV1>>();
  const mints = new Map<
    string,
    Awaited<ReturnType<typeof mintStorageSummaryForHeadV1>>
  >();

  const rows: StorageProjectionRowV1[] = [];
  for (const [projectionKey, group] of groups) {
    const cell = group.representative;
    const headShapeKey = coreHeadShapeKeyV1(cell);
    if (!heads.has(headShapeKey)) heads.set(headShapeKey, buildCoreCandidateHeadV1(cell));
    const head = heads.get(headShapeKey)!;
    if (!head.built) {
      rows.push({
        projectionKey,
        cellCount: group.count,
        headShapeKey,
        outcome: { kind: 'head-refused', ruleId: head.ruleId, message: head.message },
      });
      continue;
    }
    if (!mints.has(headShapeKey)) {
      mints.set(headShapeKey, await mintStorageSummaryForHeadV1(head.candidate, onUnresolved));
    }
    const mint = mints.get(headShapeKey)!;
    if (!mint.minted) {
      rows.push({
        projectionKey,
        cellCount: group.count,
        headShapeKey,
        outcome: { kind: 'summary-unmintable', message: mint.message },
      });
      continue;
    }
    rows.push({
      projectionKey,
      cellCount: group.count,
      headShapeKey,
      outcome: {
        kind: 'driven',
        outcome: driver.drive({
          candidate: head.candidate,
          summary: mint.summary as never,
          operation: cell.storageOperation,
          snapshotForm: cell.snapshot === 'absent'
            ? { kind: 'absent' }
            : { kind: 'present', appliedStatus: cell.appliedStatus! },
        }),
      },
    });
  }
  return rows;
}

/**
 * The observed storage outcome as ONE label, with the reason kept ATTACHED.
 *
 * `deferred` and `capacity-exhausted` draw their reasons from two DISJOINT
 * unions (:68-73 and :75-80), so a bare-label diff would collapse
 * `deferred/non-active-state` onto `deferred/authority-fork` -- which is exactly
 * the pair the level-1 images turn on. `root-collision` keys BARE here: it
 * carries `claimSubjects` and NOT a reason, so its payload is a subject list
 * rather than a member of a closed reason union, and it is recorded at level 2
 * in its own shape instead of being forced into one it does not have.
 */
export function storageOutcomeLabelV1(outcome: StorageDriveOutcomeV1): string {
  if (outcome.kind === 'refused') return `REFUSED-${outcome.stage}|${outcome.message}`;
  if (outcome.kind === 'snapshot-refused') return `SNAPSHOT-REFUSED|${outcome.message}`;
  if (outcome.kind === 'threw') return `THREW|${outcome.message}`;
  if (outcome.verdict === 'deferred' || outcome.verdict === 'capacity-exhausted') {
    return `${outcome.verdict}|${outcome.reason}`;
  }
  return outcome.verdict;
}

/** The bare derivation verdict, with the reason dropped. Level 1 keys on this. */
export function storageVerdictOfV1(outcome: StorageDriveOutcomeV1): string {
  return outcome.kind === 'derivation' ? outcome.verdict : outcome.kind;
}

/** The reason half, kept verbatim. Level 2 keys on this. */
export function storageReasonOfV1(outcome: StorageDriveOutcomeV1): string {
  if (outcome.kind !== 'derivation') return outcome.kind;
  if (outcome.verdict === 'root-collision') {
    return `claimSubjects[${outcome.claimSubjects.length}]`;
  }
  if (outcome.verdict === 'deferred' || outcome.verdict === 'capacity-exhausted') {
    return outcome.reason;
  }
  return '<none>';
}
