import type { VerdictDiffCellV1 } from './authority-verdict-diff-cells-v1.js';

/**
 * THE LATE-TOMBSTONE SEAM'S OWN ACCOUNTING.
 *
 * Split out of the join table because it is a subdomain with its own predicate,
 * its own population and its own before/after pin, and because the join table is
 * the aggregate surface rather than a home for every seam that routes.
 *
 * WHAT MAKES THIS DATA RATHER THAN NARRATIVE: every count below is asserted
 * against the live join in `authority-verdict-diff-join-v1.test.ts`. Pinned
 * numbers with no consumer are the shape this whole artifact exists to refuse --
 * they read as evidence and cannot fail.
 */

/**
 * Cells that reach the late-tombstone disjunct in `classifyTombstoneAdvance`,
 * declared FROM THE CELL AXES AND THE CITED GATES and never from the storage
 * answer, which would make the predicate a restatement of the observation.
 *
 *   :190-200  the exported entry dispatches operation 'tombstone' to
 *             `deriveSystemRecordTombstoneReplacementV1`
 *   :949      the issue is refused unless the candidate head is a tombstone
 *   :978      an absent snapshot advances before any comparison
 *   :995-999  a quarantined row defers as 'non-active-state'
 *   :1019     `authoritySequence < transitionLineage.length` is axis D 'below'
 */
export function reachesLateTombstoneDisjunctV1(cell: VerdictDiffCellV1): boolean {
  return cell.storageOperation === 'tombstone'
    && cell.snapshot === 'present'
    && cell.appliedStatus !== 'quarantined'
    && cell.candidateHeadState === 'tombstone'
    && cell.sequenceRelation === 'below';
}

/**
 * THE MOVEMENT, PRE-PINNED BEFORE THE ROUTING LANDED.
 *
 * Every count was derived from the axis arithmetic and measured against the
 * UNROUTED tree before any of the routing existed. It is kept as its own table
 * because the movement is invisible in every bucket total: AGREEMENT 1,152,
 * DIVERGENCE 192 and NO-MAPPING 384 are identical before and after, while all
 * 1,728 cells changed their storage outcome. A coverage gate reading only the
 * four-bucket partition stays green through the entire behaviour change of this
 * seam -- which is why the `after` rows carry the REASON, not just the verdict:
 * a reason-agnostic pin would have been satisfied by any deferral label and
 * could not have caught the two-reason split collapsing into one.
 */
export const LATE_TOMBSTONE_SEAM_MOVEMENT_V1: Readonly<Record<string, number>> = {
  'before :: AGREEMENT reject -> stale': 1152,
  'before :: DIVERGENCE accept -> stale': 192,
  'before :: NO-MAPPING quarantine|transition-equivocation -> stale': 384,
  'after :: AGREEMENT reject -> deferred|late-tombstone-evidence-incomplete': 384,
  'after :: AGREEMENT reject -> deferred|undecided-authority-classification': 768,
  'after :: DIVERGENCE accept -> deferred|late-tombstone-evidence-incomplete': 64,
  'after :: DIVERGENCE accept -> deferred|undecided-authority-classification': 128,
  'after :: NO-MAPPING quarantine|transition-equivocation -> deferred|late-tombstone-evidence-incomplete': 128,
  'after :: NO-MAPPING quarantine|transition-equivocation -> deferred|undecided-authority-classification': 256,
};

/** The seam's comparable population, and the split the routing turns on. */
export const LATE_TOMBSTONE_SEAM_POPULATION_V1: Readonly<Record<string, number>> = {
  'comparable cells reaching the late-tombstone disjunct': 1728,
  'of those, applied status active (classification decided)': 576,
  'of those, applied status tombstone (classification undecided)': 576,
  'of those, applied status dirty (classification undecided)': 576,
  'not comparable: no mintable summary for the candidate': 1728,
  'same-sequence lower-version disjunct, adjudicated': 0,
  'same-sequence lower-version disjunct, not comparable': 3456,
};

/**
 * THE COUNTERFACTUAL, LABELLED AS ONE SO IT IS NEVER READ AS THE SHIPPED DESIGN.
 *
 * Before the routing existed, core was run over EVERY comparable seam cell using
 * the operands storage really holds. All 1,728 came back with one decision,
 * because storage can supply a retained transition for none of them.
 *
 * THE SHIPPED DESIGN DOES NOT PRODUCE THAT UNIFORM ROW. Only the 576 cells whose
 * applied row carries a decided authority classification reach core at all; the
 * other 1,152 stop at the precondition and defer under their own reason. So the
 * live pin is LATE_TOMBSTONE_SEAM_MOVEMENT_V1, and this stays as the measurement
 * that sized the seam before anything was built -- and as the statement of what
 * core WOULD answer for the other 1,152 if their classification were decided.
 */
export const LATE_TOMBSTONE_COUNTERFACTUAL_CORE_DECISIONS_V1:
Readonly<Record<string, number>> = {
  'reject|late tombstone requires the exact retained resurrection transition': 1728,
};
