/**
 * THE CORE HALF OF THE VERDICT TABLE, AS FIXTURE DATA.
 *
 * This file is the table, not a report about one. Every number below is
 * committed, and any movement on core's side turns the suite red. A harness that
 * walked the space and printed verdict pairs would assert nothing, stay green
 * forever, and say nothing at all when a verdict moved.
 */

/**
 * THE COUNTERFACTUAL COLUMN.
 *
 * It exists BEFORE any cell carries a verdict, and it is deliberately separate
 * from the table. Retrofitting it after the table is populated is exactly the
 * pressure that puts a counterfactual INTO a cell, where it becomes
 * indistinguishable from a measured value.
 *
 * A counterfactual is NOT pinned against running code, so nothing turns red when
 * it rots -- and it WILL rot the moment the cited site changes shape. So every
 * entry carries the EXACT mutation that produced it: file:line, the before and
 * after text, and an applied-proof. Prose like "with the status gate relaxed" is
 * not admissible: without the anchor, the recorded result and "the experiment was
 * never run" are indistinguishable from the notes alone.
 *
 * The cells themselves carry ACTUAL verdicts only.
 */
export interface VerdictDiffCounterfactualV1 {
  readonly site: string;
  readonly before: string;
  readonly after: string;
  /** How application was proven at the SITE, never a bare "the string changed". */
  readonly appliedProof: string;
  readonly result: string;
  /** The unmutated verdict, which is what the table's cell actually carries. */
  readonly actualVerdict: string;
}

export const VERDICT_DIFF_COUNTERFACTUALS_V1: readonly VerdictDiffCounterfactualV1[] = [
  {
    site: 'packages/storage/src/system-record-next-state-v1-internal.ts:1113',
    before: "} else if (current.status !== 'active') {",
    after: "} else if (current.status !== 'active' && current.status !== 'tombstone') {",
    appliedProof: 'occurrence count of the original predicate 1 -> 0',
    result: 'storage returns `ready` for a sequence+1 rotation over a tombstoned current',
    actualVerdict: "deferred('non-active-state')",
  },
];

/**
 * CORE'S VERDICT FOR EVERY CONSTRUCTIBLE CELL, keyed by (verdict, reason).
 *
 * The key follows the settled rulings and is NOT uniform, because core's
 * codomain is not: `accept` and `stale` carry no reason and key bare;
 * `quarantine.reason` is a CLOSED two-value union whose VALUE is the meaning;
 * `reject.reason` is an OPEN string, pinned as the literal (the only thing a
 * caller can observe) and resolved to its site through the harvested map.
 *
 * TWO COUNTS PER ROW, and both earn their place. `projections` is what was
 * actually evaluated -- cells sharing a core projection key present
 * byte-identical inputs, so one run serves them all. `cells` is what the row
 * covers. They move independently: a change that merges two projections leaves
 * the cell count untouched.
 */
export interface CoreVerdictRowV1 {
  readonly cells: number;
  readonly projections: number;
}

export const CORE_VERDICT_TABLE_V1: Readonly<Record<string, CoreVerdictRowV1>> = {
  'REFUSED|F1-digest-equality-forces-the-current-state': { cells: 4608, projections: 1152 },
  'REFUSED|F2-digest-equality-forces-the-current-transition-digest': { cells: 9216, projections: 1152 },
  'REFUSED|F3-digest-equality-forces-the-current-fork-resolution-absence': { cells: 4608, projections: 576 },
  'REFUSED|S1-verified-authority-summary-is-unmintable-for-this-head': { cells: 61920, projections: 9792 },
  accept: { cells: 2176, projections: 448 },
  'quarantine|head-fork': { cells: 3072, projections: 384 },
  'quarantine|transition-equivocation': { cells: 25856, projections: 3840 },
  'reject|absent state cannot retain authority history or quarantine': { cells: 896, projections: 512 },
  'reject|authority history is incomplete': { cells: 5120, projections: 768 },
  'reject|cold noninitial head requires its verified authority closure': { cells: 320, projections: 192 },
  'reject|current frontier fork requires its exact direct resolving successor': { cells: 1536, projections: 192 },
  'reject|exact accepted authority transition is missing': { cells: 1920, projections: 288 },
  'reject|head issuedAt exceeds the future clock-skew bound': { cells: 27936, projections: 4416 },
  'reject|historical or unsolicited fork resolution is audit-only': { cells: 512, projections: 64 },
  'reject|late tombstone lacks its exact verified active predecessor': { cells: 1024, projections: 256 },
  'reject|next-sequence tombstone requires its exact same-sequence active predecessor': { cells: 128, projections: 32 },
  'reject|tombstone lacks its exact verified active predecessor': { cells: 1024, projections: 256 },
  'reject|transition does not bind the accepted predecessor': { cells: 512, projections: 64 },
  'reject|unresolved head fork cannot advance authority sequence': { cells: 2560, projections: 384 },
  stale: { cells: 9216, projections: 1152 },
};

/**
 * The exact per-projection pin.
 *
 * The distribution above localises a change; this digest DETECTS one. Two
 * verdicts swapping between projections with compensating counts would leave
 * every row above untouched and move this hash, which is the failure a
 * distribution alone cannot see. Computed over the sorted
 * `projectionKey=>verdict` list.
 */
export const CORE_VERDICT_TABLE_DIGEST_V1 =
  '8f786624d9ec916d4f986795c8c73dac408118cea49079e29b8ddac1cd807d16';

/** Constructible cells whose verdict the table records. */
export const CORE_DECIDED_CELLS_V1 = 83808;
/** Cells retired after the resolver, by the head layer (F) and evidence layer (S). */
export const CORE_POST_RESOLVER_RETIRED_CELLS_V1 = 80352;
/** The resolver's own output, pinned upstream, restated here for conservation. */
export const CORE_RESOLVER_CONSTRUCTIBLE_CELLS_V1 = 164160;
export const CORE_PROJECTIONS_V1 = 25920;

/**
 * WHY A VERIFIED AUTHORITY SUMMARY IS OBTAINABLE FOR ONLY SIX HEAD SHAPES.
 *
 * A summary is a WeakSet-branded, factory-only capability, so a cell naming
 * `verifiedAuthoritySummary` exists only if the closure builder will mint one for
 * that candidate head. Of the 40 buildable shapes, 6 mint and 34 are refused --
 * and the refusals are the reason S1 retires 61,920 cells.
 *
 * EVERY ENTRY HERE IS A DOMAIN REFUSAL FROM CORE, and that property is the whole
 * point of the row rather than a detail of it. An earlier revision of this
 * fixture named axis G's 'differ' transition and axis K's fork resolution with
 * well-formed but INVENTED digests. A verification closure resolves every digest
 * a head names, so 25 of these 34 shapes were refused with
 * '[system-record-closure] verification closure is missing 0x...' -- a refusal
 * manufactured by this fixture's own missing artifacts. Pinning that would have
 * retired roughly 46,000 cells while every count summed, every message was real,
 * every citation named a real site, and the suite stayed green: the
 * manufactured-retirement failure at the largest scale this harness has offered
 * it. Both digests are now computed from REAL objects that travel with the
 * closure's artifact map, and no missing-object refusal survives.
 */
export const CORE_SUMMARY_MINT_OUTCOMES_V1: Readonly<Record<string, number>> = {
  MINTED: 6,
  '[system-record-closure] resolving successor changed accepted-transition lineage': 6,
  '[system-record-closure] verification closure contains authority-transition equivocation': 6,
  '[system-record-closure] tombstone predecessor is not the exact prior active authority state': 3,
  '[system-record-closure] head <digest> does not directly bind its fork resolution': 4,
  '[system-record-closure] head <digest> does not bind its accepted authority transition': 3,
  '[system-record-history] head <digest> has incomplete authority/root lineage': 12,
};

/** Buildable candidate head shapes; the mint memoises on this, not on the cell. */
export const CORE_BUILDABLE_HEAD_SHAPES_V1 = 40;

/**
 * PHASE 1 FINDINGS from the core half. Recorded as data so they travel with the
 * table rather than living in a commit message nobody re-reads.
 */
export const CORE_SWEEP_FINDINGS_V1: readonly string[] = [
  // Found by the sweep on its first real run, which is what the "an unmapped
  // observed literal is a FAILURE" pin exists for -- it is live, not vacuous.
  "core's observable reject codomain is LARGER than the harvested file: the "
  + 'evaluator delegates at :353 and returns transitionDecision VERBATIM at :358, so '
  + 'rejects minted in system-record-authority-verification-v1-internal.ts escape '
  + 'through the same decision object carrying no marker of their origin. The 27 '
  + 'literals / 32 sites figure is a property of one file, not of core.',

  // Nothing throws to announce this one, so it is stated as arithmetic.
  'the fork-resolution successor branch is UNREACHABLE under this axis set: :456 '
  + 'forces forkedVersion == current.version, the control codec forces '
  + 'resolutionVersion > forkedVersion (:262), and :458 forces the candidate version '
  + '> resolutionVersion -- so the branch needs a candidate at least TWO versions '
  + "above the current, while axis E's largest value is exactly ONE above. Every "
  + 'such cell therefore carries reject(current frontier fork requires its exact '
  + 'direct resolving successor) and the quarantine/accept arms at :483/:485 are '
  + 'unreached.',

  // Corroborates the factory-only-capability property from the other direction.
  'a verified authority summary is obtainable for only 6 of 40 buildable candidate '
  + 'head shapes. Anything wanting to observe this subsystem from outside pays a '
  + 'factory-only capability as its entry fee, and the fixture builders are the '
  + 'reusable asset -- the same wall both halves of this diff hit independently.',
];
