/**
 * THE JOIN BETWEEN THE TWO IMPLEMENTATIONS, AS FIXTURE DATA.
 *
 * This file is the table, not a report about one. A harness that walked the
 * space and PRINTED (core, storage) pairs would assert nothing, stay green
 * forever, and say nothing at all when a verdict moved. Every number below is
 * committed, so movement on either side turns the suite red.
 *
 * TWO LAYERS, and both earn their place. `JOIN_TABLE_DIGEST_V1` DETECTS a change
 * -- two rows swapping verdicts with compensating counts leaves every
 * distribution below untouched and moves the hash. The distributions LOCALISE
 * one -- a digest alone reports "expected one hex string, got another" and names
 * nothing.
 */

/**
 * PROVENANCE, AND IT IS AN ASSERTION RATHER THAN A COMMENT.
 *
 * Every count in this file was measured against ONE set of core verdicts, and
 * core's side is under active revision: the S1 constructibility rule was retired
 * WHILE this join was being built, turning 61,920 refusals into real decisions.
 * A join pinned against superseded core verdicts stays internally consistent
 * while describing outcomes that no longer exist -- green, conserved, and about
 * nothing -- so the provenance is pinned and asserted.
 *
 * IT IS TAKEN OVER THE SWEEP'S OWN OUTPUT, NOT OVER THE CORE TABLE'S PUBLISHED
 * CONSTANT, and the S1 retirement is exactly why. Behaviour and published pin
 * move at different times: when this value was measured the core sweep had
 * already changed and `CORE_VERDICT_TABLE_DIGEST_V1` still carried the old hash.
 * A gate reading that constant would have sat green through the precise window
 * it exists for. The formula matches the core table's, so once the core half is
 * re-pinned the two constants agree -- and if they do not, the disagreement is
 * itself the signal.
 */
export const JOIN_PINNED_AGAINST_CORE_DIGEST_V1 =
  '93898e323d6a17e63ea36b2d1584b496bf42391f2de4f8007cade88924917a9e';

/**
 * THE FOUR-BUCKET PARTITION.
 *
 * `storageProjections` is pinned beside `cells` because they move
 * independently and the second is a cross-check on the first: every storage
 * projection covers EXACTLY 192 cells (min AND max, asserted upstream), so
 * 222/537/96 times 192 must reproduce these cell counts to the unit. A change
 * that moved cells without moving projections would be a projection key that
 * stopped discriminating; a change that moved projections without moving cells
 * would be the fixture growing. Neither can hide behind the other.
 *
 * THIS PARTITION WAS DERIVED BY HAND BEFORE THE RUN THAT CONFIRMED IT, and the
 * derivation is the reason these numbers are trustworthy rather than merely
 * observed. Per mintable head shape the covering projections are B x L x H,
 * with H constrained by the surviving (C,H,K) triples: 4x3x2 = 24 projections
 * for a present active candidate, 4x3x1 = 12 for a present tombstone, 1x3x2 = 6
 * in the absent region where axis B does not apply. Twelve mintable shapes give
 * 222 projections and 42,624 cells; the same derivation reproduces the PREVIOUS
 * pin exactly from the previous six shapes (114 and 21,888), which is what
 * earns it the right to predict the new one.
 *
 * IT ALSO CAUGHT A DEFECT THE RUN COULD NOT. An earlier run returned COMPARABLE
 * 35,712 / 186 -- internally consistent, conserving perfectly against 164,160,
 * every bucket summing. It disagreed with this derivation by exactly 6,912 cells
 * and 36 projections, which factors as three tombstone shapes x 12 x 192, and
 * that gap was a real defect: the storage minter was still building tombstone
 * closures against the current head. Conservation is a CONSISTENCY check, not a
 * correctness check, and only an independently derived count can tell the two
 * apart.
 */
export interface JoinBucketRowV1 {
  readonly cells: number;
  readonly storageProjections: number;
}

export const JOIN_PARTITION_V1: Readonly<Record<string, JoinBucketRowV1>> = {
  COMPARABLE: { cells: 42_624, storageProjections: 222 },
  'CORE-ONLY': { cells: 103_104, storageProjections: 537 },
  'NO-HEAD': { cells: 18_432, storageProjections: 96 },
};

export const JOIN_TOTAL_CELLS_V1 = 164_160;
export const JOIN_CELLS_PER_STORAGE_PROJECTION_V1 = 192;

/**
 * The CORE-ONLY bucket, split by whether the cell's axis-J evidence subset names
 * `verifiedAuthoritySummary`. It localises, and it is the row that PROVED the
 * separation between labels and counts rather than merely claiming it.
 *
 * The split was measured twice: once while core still refused the naming half at
 * S1 -- 61,920 cells it could not evaluate because the summary they ask for
 * cannot be minted -- and once after S1 was retired mid-build, when core began
 * DECIDING them. `cells` did not move on either side; only `coreSide` did, which
 * is why it is a separate field. Folding the label into the key would have made
 * a pure relabelling look like 61,920 cells changing bucket.
 *
 * WHAT DOES NOT MOVE, AND WHY IT CANNOT: the partition itself. Storage bind-
 * checks the verified authority summary at :882, so which cells are drivable is
 * a property of the STORAGE side and is unaffected by anything core does to its
 * own constructibility rules. That was measured across the S1 retirement, not
 * assumed.
 */
export interface JoinCoreOnlySplitRowV1 {
  readonly cells: number;
  readonly coreSide: 'decided' | 'refused';
}

export const JOIN_CORE_ONLY_SPLIT_V1: Readonly<Record<string, JoinCoreOnlySplitRowV1>> = {
  'namesSummary=false': { cells: 51_552, coreSide: 'decided' },
  'namesSummary=true': { cells: 51_552, coreSide: 'decided' },
};

/** The join's own unit: one row per distinct (core projection, storage projection). */
export const JOIN_ROWS_V1 = 164_160;

/**
 * The exact per-row pin, over the sorted
 * `coreKey>>storageKey=>verdict|coreLabel|storageLabel` list.
 *
 * DO NOT DELETE THIS AS BELT-AND-BRACES OVER THE DISTRIBUTIONS BELOW. That was
 * tested rather than argued, and the result is in the ledger as mutant M2: a
 * compensating swap that exchanges which projection pair carries an AGREEMENT
 * and which carries a DIVERGENCE leaves every distribution's multiset in this
 * file IDENTICAL, because none of them keys on a projection key. It failed
 * EXACTLY ONE assertion out of sixteen -- this one. Without it that mutation
 * ships green.
 */
export const JOIN_TABLE_DIGEST_V1 =
  '70dd5f765c5defe05b279f7a71a90f3b30b70907844f89a0e620e68f7ce0fdb7';

/**
 * THE HEADLINE, and the two numbers it carries are deliberately of different
 * kinds. DIVERGENCE counts CELLS where storage did something outside the image
 * its core decision requires. The semantics-changing count is over MAP ENTRIES,
 * because "core's quarantine is durable state and storage's defer is not" is ONE
 * fact about the systems -- multiplying it by the cells in its class would make
 * this headline describe the fixture's cardinality instead of the behaviour.
 */
export const JOIN_VERDICT_TOTALS_V1: Readonly<Record<string, number>> = {
  AGREEMENT: 11_456,
  DIVERGENCE: 4480,
  'NO-MAPPING': 4224,
  'NOT-COMPARABLE': 144_000,
};

export const JOIN_SEMANTICS_CHANGING_ENTRIES_V1 = 4;
/**
 * COMPARABLE minus the cells storage answers from the applied row before it
 * reads the candidate: 42,624 - 22,464 = 20,160, which is also the
 * `shortCircuit=false` half of JOIN_PRECONDITION_DISCRIMINATION_V1. The two are
 * computed by different code paths and must agree.
 */
export const JOIN_ADJUDICATED_CELLS_V1 = 20_160;

/**
 * NON-COMPARABILITY IS ALWAYS NAMED. An unnamed one is indistinguishable from a
 * case the harness dropped, and the largest of the three below is the finding
 * this whole join turns on rather than an exclusion.
 */
export const JOIN_NOT_COMPARABLE_CAUSE_TOTALS_V1: Readonly<Record<string, number>> = {
  'storage-requires-a-verified-authority-summary-this-head-cannot-mint': 103_104,
  'no-candidate-head-exists-because-the-system-forbids-the-input': 9216,
  'no-candidate-head-because-this-fixture-cannot-build-the-referent': 9216,
  'storage-answered-from-the-applied-row-without-reading-the-candidate': 22_464,
};

/**
 * THE NO-HEAD BUCKET'S OWN DISCRIMINATOR, pinned so the split cannot rot back
 * into one row. 9,216 + 9,216 must still be the bucket's 18,432: the correction
 * moved a CAUSE, never a count.
 */
export const JOIN_NO_HEAD_SPLIT_V1: Readonly<Record<string, number>> = {
  'system-forbids-the-input': 9216,
  'fixture-cannot-build-the-referent': 9216,
};

/**
 * THE PRECONDITION, PROVEN TO DISCRIMINATE.
 *
 * `storageReadsTheCandidateV1` is computed from the CELL AXES and from two cited
 * gates -- never from the storage answer, which would make it a restatement of
 * the observation and unfalsifiable. This table is the check that it is neither
 * vacuous nor wrong: the two off-diagonal keys are ABSENT, so the predicate
 * predicts `deferred('non-active-state')` exactly, in both directions. A gate
 * that admitted one extra row, or refused one it should have admitted, puts a
 * third key here.
 */
export const JOIN_PRECONDITION_DISCRIMINATION_V1: Readonly<Record<string, number>> = {
  'shortCircuit=false isNonActiveState=false': 20_160,
  'shortCircuit=true isNonActiveState=true': 22_464,
};

/** Every adjudicated row, keyed `verdict coreDecisionKey -> storageLabel`. */
export const JOIN_LEVEL1_TABLE_V1: Readonly<Record<string, number>> = {
  'AGREEMENT accept -> ready': 1472,
  'AGREEMENT quarantine|head-fork -> deferred|authority-fork': 768,
  'AGREEMENT reject -> deferred|authority-fork': 576,
  // The sequence-depth closure's own row: core rejects a two-ahead candidate,
  // storage defers it, both from the sequence arithmetic alone.
  'AGREEMENT reject -> deferred|authority-history-mismatch': 4032,
  // THE LATE-TOMBSTONE SEAM'S ROWS. These three carried 1,152 cells as
  // `reject -> stale` until that seam was routed through core; they moved
  // WITHOUT the AGREEMENT bucket total moving by one cell, which is why this
  // table is pinned per ROW and the bucket partition alone is not a gate. The
  // split is by applied status: an `active` row's disposition is decided, so
  // core answers it; a tombstoned or shadow-dirty row's is not, so nothing is
  // decided at all. See LATE_TOMBSTONE_SEAM_MOVEMENT_V1 for the pre-pin.
  'AGREEMENT reject -> deferred|late-tombstone-evidence-incomplete': 384,
  'AGREEMENT reject -> deferred|undecided-authority-classification': 768,
  'AGREEMENT reject -> stale': 1152,
  'AGREEMENT stale -> already-applied': 256,
  'AGREEMENT stale -> ready': 512,
  'AGREEMENT stale -> stale': 1536,
  // THE 192, PRESERVED WITH ITS CHARACTER CHANGED. Core accepts a late tombstone
  // it was handed a retained transition for; storage has no channel for one and
  // now RETRIES instead of discarding. Still a divergence -- but an EVIDENCE
  // divergence, not a classifier one.
  'DIVERGENCE accept -> deferred|late-tombstone-evidence-incomplete': 64,
  'DIVERGENCE accept -> deferred|undecided-authority-classification': 128,
  'DIVERGENCE reject -> already-applied': 192,
  'DIVERGENCE reject -> ready': 4096,
  'NO-MAPPING quarantine|transition-equivocation -> already-applied': 128,
  'NO-MAPPING quarantine|transition-equivocation -> deferred|authority-fork': 384,
  'NO-MAPPING quarantine|transition-equivocation -> deferred|authority-history-mismatch': 1152,
  'NO-MAPPING quarantine|transition-equivocation -> deferred|late-tombstone-evidence-incomplete': 128,
  'NO-MAPPING quarantine|transition-equivocation -> deferred|undecided-authority-classification': 256,
  'NO-MAPPING quarantine|transition-equivocation -> ready': 1408,
  'NO-MAPPING quarantine|transition-equivocation -> stale': 768,
};

/**
 * THE LATE-TOMBSTONE SEAM'S MOVEMENT, PRE-PINNED BEFORE THE ROUTING LANDED.
 *
 * Every count here was derived from the axis arithmetic and from the storage
 * gates, and measured against the UNROUTED tree, before any of the routing
 * existed. It is kept as its own table because the movement is invisible in
 * every bucket total: AGREEMENT 1,152, DIVERGENCE 192 and NO-MAPPING 384 are
 * identical before and after, while all 1,728 cells changed their storage
 * outcome. A coverage gate reading only the four-bucket partition stays green
 * through the entire behaviour change of this seam.
 *
 * THE POPULATION IS DECLARED FROM THE GATES, never from the answer: operation
 * 'tombstone' (entry :171-181), a present snapshot (:959 advances an absent
 * one), an applied status other than 'quarantined' (:976-980 defers those), a
 * tombstone candidate (:930 refuses any other head), and axis D 'below'
 * (:1000). The SECOND disjunct at :1001-1002 -- equal sequence, lower version --
 * is a different ADR rule (:126-128) and was measured to contain 3,456 cells of
 * which ZERO are adjudicated, so "nothing else moved" there is structural.
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
 * the operands storage really holds. All 1,728 came back with one decision --
 * `reject | late tombstone requires the exact retained resurrection transition`
 * -- because storage cannot supply a retained transition for any of them.
 *
 * THE SHIPPED DESIGN DOES NOT PRODUCE THAT UNIFORM ROW, and pinning it would
 * have pinned a design that is not shipping. Only the 576 cells whose applied
 * row carries a decided authority classification reach core at all; the other
 * 1,152 stop at the precondition and defer under their own reason. So the live
 * pin is LATE_TOMBSTONE_SEAM_MOVEMENT_V1, which carries the two-reason split per
 * row and per status. A reason-agnostic pin would have been satisfied by any
 * deferral label and could not have caught the split collapsing.
 *
 * Kept because it is the measurement that sized the seam before anything was
 * built, and because it states what core WOULD answer for the 1,152 if their
 * classification were ever decided.
 */
export const LATE_TOMBSTONE_COUNTERFACTUAL_CORE_DECISIONS_V1:
Readonly<Record<string, number>> = {
  'reject|late tombstone requires the exact retained resurrection transition': 1728,
};

/**
 * PER ENTRY, AND PER IMAGE MEMBER.
 *
 * The entry totals prove the map is LIVE -- every declared entry matches cells,
 * so none of them is decoration. The per-member counts are what make an image
 * honest: EVERY declared member is listed, including the ones observed ZERO
 * times, because the images were enumerated from the source BEFORE the run.
 * An image fitted to its own observation cannot be violated by that observation
 * -- it is drawing the target around the arrow -- and a zero here says
 * "declared, not reached", which is a coverage fact a reader can act on.
 */
export interface JoinLevel1EntryCountsV1 {
  readonly cells: number;
  readonly members: Readonly<Record<string, number>>;
}

export const JOIN_LEVEL1_PER_ENTRY_V1: Readonly<Record<string, JoinLevel1EntryCountsV1>> = {
  accept: {
    cells: 1664,
    members: { ready: 1472, 'already-applied': 0 },
  },
  stale: {
    cells: 2304,
    members: {
      stale: 1536,
      'already-applied': 256,
      ready: 512,
      'deferred|verified-state-mismatch': 0,
    },
  },
  'quarantine|head-fork': {
    cells: 768,
    members: { 'deferred|authority-fork': 768 },
  },
  'quarantine|transition-equivocation': {
    cells: 4224,
    members: {},
  },
  reject: {
    cells: 11_200,
    members: {
      stale: 1152,
      'root-collision': 0,
      'deferred|non-active-state': 0,
      'deferred|authority-fork': 576,
      'deferred|authority-history-mismatch': 4032,
      'deferred|late-tombstone-evidence-incomplete': 384,
      'deferred|undecided-authority-classification': 768,
      'deferred|verified-state-mismatch': 0,
      'deferred|root-state-changed': 0,
      'capacity-exhausted|state-revision-overflow': 0,
      'capacity-exhausted|capacity-revision-overflow': 0,
      'capacity-exhausted|record-count-cap': 0,
      'capacity-exhausted|aggregate-cap': 0,
      'capacity-exhausted|subject-union-cap': 0,
    },
  },
};

/**
 * EVERY DIVERGENCE, WITH BOTH SIDES VERBATIM. This is the actionable table: it
 * is what changes if Phase 3 routes the live path through core.
 *
 * IT DOES NOT READ AS ONE SENTENCE, and that sentence has been written three
 * different ways in this file's history -- see JOIN_DIVERGENCE_DIRECTIONS_V1 for
 * the full account, which is kept because the reasoning matters more than the
 * conclusion.
 *
 * THE BULK, 4,288 cells, is STORAGE MATERIALISES HEADS CORE REFUSES: a `reject`
 * paired with a storage outcome that admits the candidate, most of it core's
 * future clock-skew gate against a clock-blind storage classifier.
 *
 * THE REMAINDER, 192 cells, RUNS THE OTHER WAY: `accept -> stale`, core's
 * lower-sequence tombstone arm accepting a late tombstone that storage's flat
 * sequence rule refuses. Routing through core would newly ADMIT those.
 */
export const JOIN_DIVERGENCES_V1: Readonly<Record<string, number>> = {
  'reject|head issuedAt exceeds the future clock-skew bound -> ready': 2496,
  'reject|head issuedAt exceeds the future clock-skew bound -> already-applied': 192,
  'reject|absent state cannot retain authority history or quarantine -> ready': 512,
  'reject|current frontier fork requires its exact direct resolving successor -> ready': 384,
  'reject|cold noninitial head requires its verified authority closure -> ready': 128,
  // THE 192, AFTER THE SEAM WAS ROUTED. It was `accept -> stale`; core still
  // accepts (the fixture hands it the retained transition) while storage, which
  // has no channel for one, now defers for retry instead of discarding. The
  // divergence did not close, and that is the finding: it measures the EVIDENCE
  // CHANNEL, not the classifier. The classifier gap is what routing closed.
  'accept -> deferred|late-tombstone-evidence-incomplete': 64,
  'accept -> deferred|undecided-authority-classification': 128,
  'reject|exact accepted authority transition is missing -> ready': 192,
  'reject|unresolved head fork cannot advance authority sequence -> ready': 384,
};

/**
 * THE DIVERGENCE TOTAL SPLIT BY DIRECTION -- the number a routing decision
 * needs, and the one the aggregate hides.
 *
 *   storage-materialises-what-core-refuses (4,288) is a SAFETY GAP that routing
 *   through core would CLOSE.
 *   core-accepts-what-storage-refuses (192) runs the other way. It was recorded
 *   as "routing would newly ADMIT these", and the late-tombstone seam's routing
 *   MEASURED otherwise: storage cannot supply the retained transition core is
 *   handed here, so it now defers for retry rather than admitting. The 192 is a
 *   measure of the EVIDENCE CHANNEL, not of the classifier.
 *
 * THE REVERSE DIRECTION HAS A NAMED MECHANISM, which is what makes it a finding
 * rather than an observation. Enumerating the axis coordinates of every
 * accepting cell, exactly ONE accepting shape exists below the current authority
 * sequence: `A=present C=tombstone D=below G=equal`. That is core's
 * lower-sequence tombstone arm.
 *
 * THE DIRECTION OF THAT ARM WAS WRITTEN BACKWARDS HERE, AND IT IS A
 * SECURITY-RELEVANT GATE. The sentence used to read "returns `accept` once the
 * retained resurrection transition validates". Measured at
 * `packages/core/src/system-record-authority-v1-internal.ts:312-315`, the arm
 * returns `stale` when `evaluateAuthorityTransitionV1` ACCEPTS -- a validating
 * transition names the tombstone as its prior head, so a valid descendant
 * exists and the tombstone is superseded -- and returns `accept` OTHERWISE,
 * which is ADR 0002 :131-132's "otherwise the tombstone takes precedence". Both
 * halves are constructed in
 * `packages/storage/test/system-record-late-tombstone-seam-v1.test.ts`, because
 * NO CELL IN THIS FIXTURE DRIVES THE STALE SIDE: every retained transition it
 * builds names the ACTIVE head at that sequence, so the whole seam exercises the
 * accept side alone and the inverted sentence could not have been caught here.
 *
 * Storage returned a FLAT `stale` for any candidate below the current sequence,
 * checking neither the predecessor nor the transition --
 * `packages/storage/src/system-record-next-state-v1-internal.ts:1000-1003`
 * before the routing, where the condition read `authoritySequence <
 * transitionLineage.length` and the lineage's CONTENTS were never consulted. So
 * CORE ACCEPTS A LATE TOMBSTONE THAT STORAGE REFUSED OUTRIGHT, and only the
 * axis-B='active' slice reaches storage's comparison -- which is the 192.
 *
 * THIS FINDING HELD THREE POSITIONS AND THE HISTORY IS LOAD-BEARING. A reader
 * should know it survived adversarial scrutiny twice; a future skeptic should
 * meet the evidence rather than re-litigate from scratch.
 *
 *   1. FIRST REPORTED -- right conclusion, WRONG basis. The pair was observed,
 *      no mechanism was established, and it was elevated as the slice's headline
 *      before anything explained it.
 *   2. RETRACTED -- wrongly. A later rule keyed the axis-J `acceptedTransition`
 *      member to the candidate's SEQUENCE, which broke core's lower-sequence
 *      arm: those candidates got the rotation INTO their sequence where the arm
 *      demands the one OUT of it, so they refused before reaching `accept` and
 *      the divergence vanished. The disappearance was read as proof the
 *      divergence had been a fixture artifact. THE ARTIFACT WAS WHAT MADE IT
 *      DISAPPEAR.
 *   3. REINSTATED -- with the mechanism above measured. Across three evidence
 *      rules (original single constant, sequence-keyed, branch-keyed) BOTH rules
 *      that feed the lower-sequence arm correctly produce 192; only the broken
 *      one produces 0.
 *
 * THE RULE OUT OF POSITION 2: a disappearance inside a region you have just
 * modified is the least trustworthy kind of evidence. "My change removed it" is
 * exactly as consistent with "my change broke the path" as with "the finding was
 * an artifact", and only a mechanism separates them. The signature is a number
 * that RETURNS to where it started once the change is corrected -- here
 * `late tombstone requires the exact retained resurrection transition` went
 * 192 -> 384 -> 192.
 *
 * The suite asserts the two directions partition
 * JOIN_VERDICT_TOTALS_V1.DIVERGENCE, and reads them over the DECLARED keys so a
 * zero would still be pinned as zero rather than silently omitted.
 */
export const JOIN_DIVERGENCE_DIRECTIONS_V1: Readonly<Record<string, number>> = {
  'storage-materialises-what-core-refuses': 4288,
  'core-accepts-what-storage-refuses': 192,
};

/**
 * LEVEL 2: THE REASON PAIRS, VERBATIM, MAPPED TO NOTHING.
 *
 * There is no correspondence to declare here and the suite says so by asserting
 * the two reason unions are DISJOINT rather than by leaving the claim in prose.
 * Core's reasons are English sentences about authority; storage's are five
 * closed `deferred` tokens and five closed `capacity-exhausted` tokens about
 * materialisation. `<none>` on the storage side is not a reason -- it is the
 * three variants that carry no reason field at all.
 */
export const JOIN_LEVEL2_REASON_PAIRS_V1: Readonly<Record<string, number>> = {
  '<none> :: <none>': 3776,
  // THE 192 AT THE REASON LEVEL. Core `accept` carries no reason, so `<none>` on
  // the left is core accepting; the two right-hand tokens are the seam's
  // retry-shaped deferrals. 64 + 128 is the whole of the reverse-direction
  // divergence, and it is legible here in a way the bucket totals cannot show.
  '<none> :: late-tombstone-evidence-incomplete': 64,
  '<none> :: undecided-authority-classification': 128,
  'absent state cannot retain authority history or quarantine :: <none>': 512,
  // THE PAIR THE SEQUENCE-DEPTH CLOSURE EXISTS TO PRODUCE: a candidate two
  // authority sequences ahead, refused by core and deferred by storage, both
  // from the sequence arithmetic alone and both on input the other side accepts.
  'authority history is incomplete :: authority-history-mismatch': 1536,
  'cold noninitial head requires its verified authority closure :: <none>': 128,
  'current frontier fork requires its exact direct resolving successor :: <none>': 384,
  'exact accepted authority transition is missing :: <none>': 192,
  'exact accepted authority transition is missing :: authority-history-mismatch': 192,
  'head issuedAt exceeds the future clock-skew bound :: <none>': 3840,
  'head issuedAt exceeds the future clock-skew bound :: authority-fork': 576,
  'head issuedAt exceeds the future clock-skew bound :: authority-history-mismatch': 1728,
  'head issuedAt exceeds the future clock-skew bound :: late-tombstone-evidence-incomplete': 192,
  'head issuedAt exceeds the future clock-skew bound :: undecided-authority-classification': 384,
  'head-fork :: authority-fork': 768,
  // CORE'S OWN LATE-TOMBSTONE REJECTS, now paired with storage's retry rather
  // than with a flat discard. Their left-hand reasons come from the fixture's
  // axis-J evidence subsets; storage's own operands produce only the
  // retained-transition reason, which is why the two right-hand tokens are the
  // seam's and not core's.
  'late tombstone lacks its exact verified active predecessor :: late-tombstone-evidence-incomplete': 128,
  'late tombstone lacks its exact verified active predecessor :: undecided-authority-classification': 256,
  'late tombstone requires the exact retained resurrection transition :: late-tombstone-evidence-incomplete': 64,
  'late tombstone requires the exact retained resurrection transition :: undecided-authority-classification': 128,
  'next-sequence tombstone requires its exact same-sequence active predecessor :: authority-history-mismatch': 192,
  'transition-equivocation :: <none>': 2304,
  'transition-equivocation :: authority-fork': 384,
  'transition-equivocation :: authority-history-mismatch': 1152,
  'transition-equivocation :: late-tombstone-evidence-incomplete': 128,
  'transition-equivocation :: undecided-authority-classification': 256,
  'unresolved head fork cannot advance authority sequence :: <none>': 384,
  'unresolved head fork cannot advance authority sequence :: authority-history-mismatch': 384,
};

/**
 * CORE'S TWO STALE SUB-CAUSES, and which storage outcome each one took.
 *
 * This is the row that would have carried the fabricated divergence. Mapping
 * core `stale` to storage `{stale}` alone emits DIVERGENCE on the 256 + 512
 * identical-head cells, where the two implementations AGREE about the outcome
 * and differ only in which word carries it. The routes are derived from the cell
 * AXES, never from the storage answer, so they cannot agree with the observation
 * by construction.
 */
export const JOIN_STALE_ROUTES_V1: Readonly<Record<string, number>> = {
  'identical-head:core:199 -> already-applied': 256,
  'identical-head:core:199 -> ready': 512,
  'identical-head:core:199 -> NOT-COMPARABLE(applied-row-short-circuit)': 1280,
  'lower-version:core:196 -> stale': 768,
  'lower-version:core:196 -> NOT-COMPARABLE(applied-row-short-circuit)': 1280,
  // A THIRD SUB-CAUSE, reachable only since the sequence-depth closure. Core
  // reaches `stale` from the LOWER-SEQUENCE branch (:274) as well as from the
  // lower-version one, and storage answers it with the same flat `stale`. Its
  // counts mirror lower-version exactly -- 768 routed, 1,280 short-circuited --
  // which is the axis arithmetic, not a coincidence: both relations occupy one
  // axis-D value and differ only in which relation the cell names.
  'lower-sequence -> stale': 768,
  'lower-sequence -> NOT-COMPARABLE(applied-row-short-circuit)': 1280,
};

/**
 * STORAGE'S FULL LEVEL-1 CODOMAIN AND WHAT THE DIFF ACTUALLY REACHED.
 *
 * EIGHT OF FOURTEEN LABELS ARE ZERO, and they are pinned AS zero rather than
 * omitted. An omitted row and an unreachable row look identical in a pin, and
 * only one of them is a claim: a dispatch or codec change that starts producing
 * `root-collision` must turn this suite red rather than silently enlarging the
 * codomain the table claims to cover.
 *
 * ONE LABEL LEFT THE ZERO SET, WHICH IS THE POINT OF PINNING ZEROES AT ALL.
 * `deferred|authority-history-mismatch` was 0 and is now 5,184. It is reachable
 * only by a candidate whose sequence relation is not `equal`, so it was
 * unreachable for exactly as long as the sequence-depth boundary stood -- and it
 * appeared the moment that closed. A zero that becomes non-zero when the gap
 * that explained it is closed is a zero that was telling the truth.
 */
export const JOIN_STORAGE_LABEL_REACH_V1: Readonly<Record<string, number>> = {
  ready: 7488,
  'already-applied': 576,
  // 5,184 BEFORE THE LATE-TOMBSTONE SEAM WAS ROUTED. The 1,728 that left are
  // exactly the seam's comparable population, and they are accounted for by the
  // two rows below -- 576 + 1,152. `stale` losing a third of its reach is the
  // single clearest measure of what this routing removed: storage no longer
  // discards a tombstone learned below its current sequence on arithmetic alone.
  stale: 3456,
  'root-collision': 0,
  'deferred|non-active-state': 22_464,
  'deferred|authority-fork': 1728,
  'deferred|authority-history-mismatch': 5184,
  'deferred|late-tombstone-evidence-incomplete': 576,
  'deferred|undecided-authority-classification': 1152,
  'deferred|verified-state-mismatch': 0,
  'deferred|root-state-changed': 0,
  'capacity-exhausted|state-revision-overflow': 0,
  'capacity-exhausted|capacity-revision-overflow': 0,
  'capacity-exhausted|record-count-cap': 0,
  'capacity-exhausted|aggregate-cap': 0,
  'capacity-exhausted|subject-union-cap': 0,
};

/**
 * WHY EACH UNREACHED OUTCOME WENT UNREACHED, run through the same discriminator
 * this harness applies to a constructibility rule.
 *
 *   'system-forbids'        -- the axis set makes it impossible. A FINDING.
 *   'harness-never-builds'  -- the fixture never constructs the input. A GAP.
 *
 * The distinction is load-bearing because the two carry opposite obligations: a
 * finding is recorded and left alone, a gap bounds the coverage claim. Neither
 * is a reason to go and manufacture cells.
 *
 * ONE ENTRY HAS LEFT THIS REGISTER, AND THAT IS WHAT THE REGISTER IS FOR.
 * `deferred|authority-history-mismatch` was listed here as 'harness-never-builds'
 * on the ground that every non-`equal` sequence relation was retired earlier as
 * summary-unmintable. It is now REACHED, because the sequence-relative candidates
 * mint. An entry classified 'harness-never-builds' is a standing prediction that
 * closing the gap will make the outcome appear; this one was closed and it did.
 * Note the entry's stated CAUSE was already wrong before it was removed -- it
 * cited the chain helper's `(steps: 1 | 2)` signature, an attribution the core
 * table had already retired, while claiming "the core table records the same
 * boundary". A cross-reference asserting agreement with its own correction is
 * worse than a bare wrong cause, because it borrows authority it does not have.
 */
export interface JoinUnreachedOutcomeV1 {
  readonly side: 'storage' | 'core';
  readonly outcome: string;
  readonly why: 'system-forbids' | 'harness-never-builds';
  readonly reason: string;
}

export const JOIN_UNREACHED_OUTCOMES_V1: readonly JoinUnreachedOutcomeV1[] = [
  {
    side: 'storage',
    outcome: 'root-collision',
    why: 'harness-never-builds',
    reason: 'A collision needs a FOREIGN record already claiming this root subject. The '
      + 'driver derives observedRootClaimQuads from the current head\'s own plan, and no '
      + 'axis names another record. Not forbidden -- the driver even carries an explicit '
      + 'observedRootClaimQuadsOverride hook so a control can reach it.',
  },
  {
    side: 'storage',
    outcome: 'capacity-exhausted (all five reasons)',
    why: 'harness-never-builds',
    reason: 'There is no capacity axis. The fixture\'s single-subject record sits far below '
      + 'every cap and no cell varies revision counters, record counts or byte totals.',
  },
  {
    side: 'storage',
    outcome: 'deferred|verified-state-mismatch',
    why: 'harness-never-builds',
    reason: 'The reuse branch\'s mismatch exit at :270. The present snapshot is built FROM '
      + 'the current head\'s own materialisation plan, so the persisted state matches the '
      + 'verified head by construction; reaching it would take deliberate corruption.',
  },
  {
    side: 'storage',
    outcome: 'deferred|root-state-changed',
    why: 'harness-never-builds',
    reason: 'The other arm of the same root-snapshot classification as root-collision, and '
      + 'unreached for the same reason.',
  },
  {
    side: 'core',
    outcome: 'quarantine and accept at the fork-resolution successor branch (:558 and :560)',
    why: 'system-forbids',
    reason: 'Arithmetic, not observation, because nothing throws to announce it: :531 forces '
      + 'forkedVersion == current.version, the control codec forces resolutionVersion > '
      + 'forkedVersion, and :533 forces the candidate version > resolutionVersion. The '
      + 'branch therefore needs a candidate at least TWO versions above the current while '
      + 'axis E\'s largest value is exactly ONE above. Recorded by the core table as its '
      + 'own finding.',
  },
];

/**
 * IMPOSSIBILITY CLAIMS, WITH THE CLOSED SET EACH ONE DEPENDS ON NAMED.
 *
 * An impossibility that leans on an unstated premise is the fragile kind: it
 * stays written down and becomes false with nothing anywhere pointing at what
 * changed. `breaksIf` is where the claim dies, and the citation on the premise
 * means a future change lands on the line naming what it invalidates.
 */
export interface JoinImpossibilityProofV1 {
  readonly subject: string;
  readonly citations: readonly string[];
  readonly proof: string;
  readonly breaksIf: string;
}

export const JOIN_IMPOSSIBILITY_PROOFS_V1: readonly JoinImpossibilityProofV1[] = [
  {
    subject: "the throw at system-record-next-state-v1-internal.ts:260-262, 'equal system-record "
      + "head cannot exist in absent state'",
    citations: [
      'packages/storage/src/system-record-next-state-v1-internal.ts:1292',
      'packages/storage/src/system-record-next-state-v1-internal.ts:1240',
      'packages/storage/src/system-record-state-snapshot-v1-internal.ts:76',
    ],
    proof: "materialization 'reuse' is PRODUCED at exactly one site, :1249 (the literal occurs "
      + 'three times in that file: :259 the consumer test, :1188 the type union, :1249 the '
      + "production; the control is five 'rematerialize' hits, so the instrument finds "
      + 'things). :1197 returns advance{rematerialize} for an ABSENT snapshot before `const '
      + 'current = snapshot.appliedState` at :1200, so :1249 is reachable only on a '
      + 'non-absent snapshot. THE CLOSING PREMISE, and the citation that matters most: '
      + 'SystemRecordAppliedSnapshotV1 is declared as EXACTLY TWO variants at '
      + 'system-record-state-snapshot-v1-internal.ts:76-78. With the union closed at two, '
      + 'not-absent IS present -- which is what closes the gap between what `reuse` implies '
      + 'and what the throw tests. Without that premise the two predicates are not the same '
      + 'and the proof does not hold.',
    breaksIf: 'a THIRD SystemRecordAppliedSnapshotV1 variant is added -- a pending or dirty '
      + "snapshot state is not far-fetched for this stack. `reuse` would still imply "
      + 'not-absent, but the throw would become REACHABLE and this record false.',
  },
];

/**
 * THE NON-VACUITY LEDGER.
 *
 * Every pin above is only worth what it catches, and "it is green" is not
 * evidence about that. Each mutant below was applied SERIALLY to the live
 * source, apply-checked at the site, run, restored, and followed by a restore
 * control -- and each carries the prediction that was written down BEFORE the
 * run beside what was actually observed.
 *
 * THE ANCHOR IS THE UNIQUE TEXT, NOT A LINE NUMBER. A line number drifts on any
 * unrelated edit above it and the record then rots silently; a `before` string
 * asserted to occur EXACTLY ONCE cannot be satisfied by a different line, which
 * is the property the anchor is for.
 */
export interface JoinMutantV1 {
  readonly id: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly proves: string;
  readonly prediction: string;
  readonly observed: string;
}

export const JOIN_NON_VACUITY_MUTANTS_V1: readonly JoinMutantV1[] = [
  {
    id: 'M1',
    file: 'packages/storage/test/helpers/authority-verdict-diff-join-v1.ts',
    before: "    coreDecisionKey: 'stale',",
    after: "    coreDecisionKey: 'stale-RENAMED',",
    proves: 'the unadjudicated-pair guard FIRES. An observed core decision the level-1 map has '
      + 'never been shown must turn the suite red rather than being absorbed as a row.',
    prediction: 'RED, with `unadjudicated` listing exactly three pairs: stale -> already-applied, '
      + 'stale -> ready, stale -> stale.',
    observed: "EXACT. `expected [ 'stale  ->  already-applied', ...(2) ] to strictly equal []`. "
      + 'The storage-driver suite stayed green; the restore control returned 16/16.',
  },
  {
    id: 'M2',
    file: 'packages/storage/test/helpers/authority-verdict-diff-join-v1.ts',
    before: '  return { rows: [...grouped.values()], unadjudicated: [...unadjudicated].sort() };',
    after: 'a compensating swap: exchange the coreProjectionKey of one AGREEMENT row and one '
      + 'DIVERGENCE row, leaving every distribution\'s multiset identical.',
    proves: 'THE DIGEST EARNS ITS PLACE. It detects a moved verdict binding that no distribution '
      + 'in this file can see, which is the whole argument for carrying both layers.',
    prediction: 'EXACTLY ONE failing assertion -- the digest -- and every other test green.',
    observed: 'EXACT. 1 failed / 15 passed, the single failure being the digest comparison. Every '
      + 'distribution assertion in the other nine tests passed under a mutation that moved which '
      + 'projection pair carries which verdict.',
  },
  {
    id: 'M3',
    file: 'packages/storage/test/helpers/authority-verdict-diff-join-v1.ts',
    before: "    image: ['stale', 'already-applied', 'ready', 'deferred|verified-state-mismatch'],",
    after: "    image: ['stale'],",
    proves: 'THE FABRICATED-DIVERGENCE COUNTERFACTUAL, measured rather than argued. This is the '
      + 'naive core-stale image, and the number it invents is the cost of getting the entry wrong.',
    prediction: '768 cells move AGREEMENT -> DIVERGENCE: the 256 identical-head cells storage '
      + 'answers `already-applied` and the 512 it rematerialises to `ready`. Totals become '
      + 'AGREEMENT 3,968 and DIVERGENCE 3,904.',
    observed: 'MEASURED AT A SUPERSEDED BASE (core digest d396cb86..., before the '
      + 'sequence-depth closure); the DELTA is the result and the absolute totals are vintage. '
      + 'EXACT at that base: AGREEMENT 4,736 -> 3,968 and DIVERGENCE 3,136 -> 3,904, with '
      + '`DIVERGENCE stale -> already-applied: 256` and `DIVERGENCE stale -> ready: 512` appearing '
      + 'in the level-1 table. A QUARTER of the reported divergences would have been manufactured '
      + 'by the mapping rather than found in the systems.',
  },
  {
    id: 'M4',
    file: 'packages/storage/test/helpers/authority-verdict-diff-join-v1.ts',
    before: "  if (cell.storageOperation === 'tombstone') return cell.appliedStatus !== 'quarantined';",
    after: "  if (cell.storageOperation === 'tombstone') return true;",
    proves: 'the precondition is LOAD-BEARING branch by branch, not just in aggregate. This '
      + 'mutates one arm -- the tombstone path\'s own gate at :995-999 -- and nothing else.',
    prediction: 'the discrimination table gains a third key, `shortCircuit=false '
      + 'isNonActiveState=true: 576`, and the short-circuit count falls by 576. MEASURED AT A '
      + 'SUPERSEDED BASE, where that read 12,096 -> 11,520; the 576 delta is the claim.',
    observed: 'EXACT, on both numbers. Four assertions fired, including the discrimination '
      + 'cross-tab going from two keys to three -- so the two-key pin is a real claim about the '
      + 'predicate and not an artifact of how the tally was built.',
  },
];

/**
 * PHASE 1 FINDINGS from the join. Data, so they travel with the table rather
 * than living in a commit message nobody re-reads.
 */
export const JOIN_FINDINGS_V1: readonly string[] = [
  // The single sharpest fact the join produced, and the one that decides how
  // more than half the comparable region must be labelled.
  'STORAGE DECIDES 22,464 OF THE 42,624 COMPARABLE CELLS -- 53% -- WITHOUT READING THE '
  + 'CANDIDATE AT ALL. `classifyAuthorityAdvance` returns deferred(non-active-state) from the '
  + 'APPLIED ROW STATUS at :1213/:1216/:1219, before the candidate is first read at :1221, and '
  + 'the tombstone path has its own such gate at :995-999. Core has no field to put an applied '
  + 'status in, so on those cells the two sides are not disagreeing about the candidate -- they '
  + 'are answering different questions. Calling that DIVERGENCE would have manufactured 22,464 '
  + 'of them, which is five times the real divergence count and would have buried it.',

  // The actionable one. Every cell of it is a DIVERGENCE.
  'STORAGE MATERIALISES HEADS CORE REFUSES: 4,288 cells -- the BULK of the divergence population but no longer all of it, '
  + 'each a core `reject` paired with a storage outcome that ADMITS the candidate (4,096 `ready`, 192 '
  + '`already-applied`); 192 further cells run the OTHER way, see JOIN_DIVERGENCE_DIRECTIONS_V1. The largest single cause is core\'s future clock-skew gate at :98-103 '
  + 'against a storage classifier that takes no clock input at all; the same blindness is '
  + 'established AT SOURCE -- issuedAt, nowMs, clockSkew and futureSkew do not occur anywhere '
  + 'in packages/storage/src. (CORRECTED ATTRIBUTION: this clause previously cited the '
  + 'projection-equivalence suite as having measured 855 projection keys collapsing to 285 '
  + 'DISTINCT BUILT INPUTS. It did not. 285 is the storage projection key WITHOUT its clock '
  + 'segment, and the suite pins the relationship as key arithmetic, 855 = 285 x 3; the count '
  + 'of distinct built storage inputs is never pinned and is in fact 273. The claim was right '
  + 'and its stated evidence was a property of the key function.) THIS IS WHAT PHASE 3 WOULD CHANGE: '
  + 'routing the live path through core would start refusing these heads.',

  // The symmetry is the point, and it is why the two are recorded differently.
  'EACH IMPLEMENTATION SHORT-CIRCUITS ON AN AXIS THE OTHER CANNOT SEE, and the two are mirror '
  + 'images. Storage answers from axis B (applied status) at :1218 before reading the candidate; '
  + 'core answers from axis I (accepted disposition) at :139-141 before reading the candidate\'s '
  + 'sequence or version. Neither field exists on the other side. They are recorded differently '
  + 'ON PURPOSE: core\'s is CONSTANT across its whole mapping class, so it belongs to the MAP as '
  + 'the one entry that can ground no image; storage\'s varies cell by cell with axis B, so it '
  + 'belongs to the CELL as a named non-comparability. A fact constant across a mapping class '
  + 'that is stored per cell multiplies one semantic difference by the fixture\'s cardinality.',

  // The trap this table was built to avoid, recorded so the next reader does
  // not re-introduce it.
  'MAPPING CORE `stale` TO STORAGE {stale} ALONE FABRICATES 768 DIVERGENCES. Core has two stale '
  + 'sub-causes: the LOWER-VERSION candidate at :196, which storage also calls `stale` at :1239, '
  + 'and the IDENTICAL head at :199, which storage calls `advance` and surfaces as '
  + '`already-applied` (256 cells) or -- when :1249 selects rematerialize rather than reuse -- as '
  + '`ready` (512 cells). Same outcome, different word, and a naive image would have reported '
  + 'agreement as disagreement. THE ENTRY IS STILL SEMANTICS-CHANGING, for the opposite reason: '
  + 'on those 512 cells core does nothing at all while storage returns a CAS plan the executor '
  + 'APPLIES, so the identical head can cause a WRITE on one side and not the other.',

  // Bounds the coverage claim, and names the risk it creates.
  'NINE OF STORAGE\'S FOURTEEN OUTCOME LABELS AND TWO OF CORE\'S DECISION ARMS WERE NEVER '
  + 'COMPARED BY THIS DIFF. At the variant level that is two on each side -- storage\'s '
  + '`root-collision` and `capacity-exhausted`, core\'s fork-resolution successor quarantine and '
  + 'accept. Only core\'s pair is forbidden by the axis set; every storage one is a fixture gap, '
  + 'and the inventory says which is which. THE CONSEQUENCE IS INDEPENDENT OF THAT SPLIT: '
  + 'routing the live path through core exposes paths this table is silent about, so the '
  + 'unreached inventory is a Phase 3 routing risk in its own right and not a tidiness note.',

  // The correction that arrived while this table was being assembled, kept
  // inside the pinned data so it cannot be lost with the conversation.
  'HALF THE NO-HEAD BUCKET IS A FIXTURE LIMIT, NOT A SYSTEM PROPERTY. Its 18,432 cells split '
  + 'exactly in two: F2 (9,216) is a genuine contradiction -- a head digest-equal to the current '
  + 'cannot differ on any committed field, because a digest covers the whole head -- while F1 and '
  + 'F3 (9,216) were shown by a class sweep to retire cells against THIS FIXTURE\'S current-head '
  + 'properties. The sweep BUILT the referents they declare impossible: a version-3 tombstone '
  + 'referent mints a full summary and issues through the real registry, and a fork-carrying '
  + 'active head is codec-legal. The counts did not move; the CAUSE did, and it now rides on the '
  + 'rule id so the pinned distribution carries it. THE STORAGE SIDE IS NOT THE SAME ERROR: the '
  + '123,840-cell CORE-ONLY bucket rests on a bind-check in the code at :882, not on chain depth, '
  + 'and two harness limits on the core side do not imply a third here.',

  // TWO POPULATIONS, BOTH NAMED, because this is the third time in this slice
  // that a true claim was dangerous at the wrong scope. Neither sentence below
  // may be quoted without its population.
  'AXIS J IS NON-DISCRIMINATING ON PRESENT-SNAPSHOT CELLS AND DISCRIMINATING ON ABSENT ONES, and '
  + 'the two facts were measured over DIFFERENT populations. Over the present-path cells measured '
  + 'by the summary-independence probe, naming `verifiedAuthoritySummary` moves no core verdict. '
  + 'Over the 114 COMPARABLE storage projections measured here, it moves one on exactly 4 of them '
  + '-- all four ABSENT-snapshot, where naming the summary turns core\'s reject(cold noninitial '
  + 'head requires its verified authority closure) into `accept` at :230-237, while the other 110 '
  + 'carry an identical core label with and without it. So "axis J is dead" is TRUE of the '
  + 'present region and FALSE as a statement about the axis. Neither claim says anything about '
  + 'the 123,840 CORE-ONLY cells, where naming the summary is precisely what used to retire them.',

  // The wrong number I produced, kept as the general shape rather than as an
  // apology, because the shape is what recurs.
  'A STORAGE-SIDE AGGREGATE IS NOT ANY ONE CORE DECISION\'S IMAGE. Storage emits '
  + 'deferred(authority-fork) on 1,728 comparable cells, and that total was briefly attributed to '
  + 'core\'s quarantine(head-fork) as though the two named the same set. They do not: the 1,728 '
  + 'arrive from THREE core decisions -- 768 head-fork, 576 reject(head issuedAt exceeds the '
  + 'future clock-skew bound), 384 quarantine(transition-equivocation) -- while quarantine('
  + 'head-fork) itself covers 2,048 comparable cells of which 1,280 never reach the candidate at '
  + 'all. Every one of those four numbers is different from 1,728. THE SHAPE IS ATTRIBUTING A '
  + 'GROUP TOTAL TO ONE MEMBER, and it is available in both directions on every row of a join: '
  + 'the level-1 table is keyed on the PAIR for exactly this reason.',

  // The gate that fired, recorded because it fired for a reason that is not
  // obvious until it has cost something.
  'THE PROVENANCE GATE HASHES THE CORE SWEEP\'S OWN OUTPUT, NOT THE CORE TABLE\'S PUBLISHED '
  + 'CONSTANT, AND THAT DISTINCTION WAS NOT ACADEMIC. The S1 constructibility rule was retired in '
  + 'the core sweep while this join was being measured. For the duration of that window core\'s '
  + 'behaviour had already changed and `CORE_VERDICT_TABLE_DIGEST_V1` still carried the previous '
  + 'hash, because behaviour and published pin move at different times. A gate comparing this '
  + 'file\'s provenance against that constant would have compared one stale value to another and '
  + 'sat green through precisely the window it exists for. Hashing the sweep output makes the '
  + 'gate independent of whether anyone has re-pinned yet.',

  // THE JOIN-SIDE HALF OF A FINDING THE CORE TABLE STATES IN GENERAL TERMS. The
  // populations live here because this is where they were measured; the core
  // half deliberately claimed no numbers it had not measured itself.
  'THE TWO EVALUATORS HAVE DISJOINT PRIVATE INPUTS, AND THESE ARE THE CELLS. The core table '
  + 'states the general result -- ROUTING CANNOT BE A DROP-IN, BECAUSE EACH SIDE READS STATE '
  + 'THE OTHER DOES NOT HAVE -- and these are its two join-side populations. 22,464 cells are '
  + 'storage answering from the APPLIED ROW at :1213/:1216/:1219, before the candidate is read '
  + 'at :1221, on an axis CORE has no field for. 4,224 cells are core deciding '
  + '`quarantine|transition-equivocation` from `disposition` at :139-141, on an axis STORAGE '
  + 'has no producer for. TOTAL 26,688 -- THE SAME PHENOMENON IN OPPOSITE DIRECTIONS. Both are '
  + 'CORRECT cell-level exclusions and neither is reclassified: the 22,464 stay a named '
  + 'non-comparability on the CELL, the 4,224 stay the MAP\'s one no-image entry, and nothing '
  + 'in the conservation moves. TOGETHER THEY ARE ONE ARCHITECTURAL FINDING, and it was '
  + 'invisible precisely BECAUSE it was found twice, from opposite ends, and filed as an '
  + 'ABSENCE both times -- two correct exclusions in two registers do not add up to a finding '
  + 'until someone writes the finding down. THE `disposition` PROBE, WITH ITS INSTRUMENT '
  + 'NAMED: 15 occurrences across 14 lines, all in '
  + 'packages/core/src/system-record-authority-v1-internal.ts, against 0 anywhere in '
  + 'packages/storage/src. The two figures are ONE measurement read by TWO instruments -- '
  + 'matching LINES against matching OCCURRENCES -- and the entire difference is :718, where '
  + 'the word appears twice on one line. THE CORE COUNT IS THE POSITIVE CONTROL PROVING THE '
  + 'PROBE WORKS; THE LOAD-BEARING NUMBER IS THE ZERO, and both instruments agree on the zero. '
  + 'A count that disagrees between two instruments is not a discrepancy when neither '
  + 'instrument is the one the claim rests on -- but only if someone says which is which.',

  // A PROPOSED ANNOTATION, AND WHAT IT COST TO EARN IT. An unverified shadowing
  // claim reads exactly as principled as a demonstrated one, so it is written
  // only in the scope where it was actually shown, and that scope is named.
  'R2\'S CITED REFUSAL IS SHADOWED INSIDE THE STORAGE DRIVER -- MEASURED, NOT ARGUED, OVER ALL '
  + '30 OF ITS CANDIDATE-HEAD SHAPES. R2 (authority-verdict-diff-constructibility-v1.ts) '
  + 'retires operation `active` against a tombstone candidate and cites '
  + 'system-record-verified-replacement-v1-internal.ts:641. That territory is 65,664 cells over '
  + '30 distinct head shapes, of which R1 owns the K=present half, leaving R2 the 15 K=absent '
  + 'ones. Driven with constructibility BYPASSED, all 30 resolve: 17 never reach the driver '
  + 'because the head itself is refused (13 H1, 4 F1), 12 more are summary-unmintable, and '
  + 'EXACTLY ONE reaches the issue path. R2\'s own 15 split 2 / 12 / 1 the same way, and the '
  + 'one that gets there is present|tombstone|equal|above|-|equal|absent. There the driver\'s '
  + 'OWN `rebuildProjectionForHeadV1` throws first -- "driver projection rebuild is unfaithful: '
  + 'projectionBytes 790 != committed 0; projectionQuads 6 != committed 0; contentDigest ... != '
  + 'committed undefined" -- and it throws while building the ARGUMENT to `issueCandidate`, so '
  + 'the driver\'s catch reports it as {kind:refused, stage:issue}: THE SAME STAGE '
  + 'DISCRIMINATOR THE REGISTRY\'S OWN REFUSAL CARRIES, separable only by reading the message. '
  + 'THE DISCRIMINATOR: re-driving that same shape through the `projectionOverride` control '
  + 'hook skips the rebuild, and :641 then fires verbatim -- {kind:refused, stage:issue, '
  + 'message:"verified replacement head must be active"}. So the site is genuinely REACHABLE, '
  + 'which is what a read of the PRODUCTION issuer already found, and what shadows it is the '
  + 'INSTRUMENT rather than the system. CONTROL: the same call on an ACTIVE head does not '
  + 'throw, so the probe is not simply always-throwing. NOTHING MOVES ON THIS -- R2\'s cells '
  + 'stay retired and its counts stay pinned; the annotation says only which SITE owns the '
  + 'refusal when it is read through the driver. It is deliberately NOT written as a claim '
  + 'about the production issuer, where it could not be verified and is in fact false.',

  // THE SCOPE THE ADJUDICATED COUNT DOES NOT CARRY ON ITS FACE. Recorded after a
  // finding was escalated as a fabrication defect, measured, and overturned --
  // the escalation was wrong about the mechanism and right that something here
  // was unstated.
  'SUPERSEDED IN PART BY THE LATE-TOMBSTONE ROUTING, AND THE PART THAT SURVIVES IS '
  + 'NARROWER THAN IT READS. When this was written classifyTombstoneAdvance read '
  + 'current.status EXACTLY ONCE and only against \'quarantined\', which made axis B inert '
  + 'on the whole dispatch path. Routing the late-tombstone disjunct through core added a '
  + 'SECOND read of the status -- deriveAgentProfileAuthorityDispositionV1 over the applied '
  + 'row -- and that one discriminates: an active row derives a decided disposition and is '
  + 'answered by core, while a tombstoned or shadow-dirty row derives an UNDECIDED one and '
  + 'is deferred under its own reason. So on the below-sequence disjunct the three axis-B '
  + 'values now produce THREE DIFFERENT STORAGE OUTCOMES and are no longer behavioural '
  + 'duplicates. WHAT STILL HOLDS: the verdict CLASSES still coincide across axis B -- the '
  + 'routing moved every one of those cells without moving any bucket total -- so the '
  + 'duplicate-verdict observation survives while the duplicate-BEHAVIOUR one does not. '
  + 'THE LESSON THIS RECORDS, which is why it is rewritten rather than deleted: an '
  + 'inertness finding is a statement about the code as it stands, and the routing that '
  + 'made this axis live is exactly the kind of change that leaves such a finding green '
  + 'and false. The original text follows so the correction can be audited. '
  + 'ORIGINAL: "AXIS B IS NON-DISCRIMINATING ON THE TOMBSTONE DISPATCH PATH, SO 1,152 '
  + 'ADJUDICATED CELLS ARE BEHAVIOURAL DUPLICATES. classifyTombstoneAdvance reads '
  + 'current.status EXACTLY ONCE, at :975, and only against \'quarantined\'; a dirty or '
  + 'tombstone row with no conflict state passes straight through." POSITIVE CONTROL on the ACTIVE classifier '
  + '(:1192-1269) with the same instrument: THREE reads including a current.status !== '
  + '\'active\' test, which is why axis B does real work there and produces the 22,464 '
  + 'applied-row short-circuit. MEASURED CONSEQUENCE: under H=tombstone, B=active, B=dirty '
  + 'and B=tombstone each split 256 AGREEMENT / 192 DIVERGENCE / 128 NO-MAPPING -- IDENTICAL '
  + 'in every verdict class, which is the empirical confirmation of the source reading; three '
  + 'independent classes agreeing exactly is not what coincidence produces. So of the 576 '
  + 'divergence cells in this region there are only 192 DISTINCT divergent situations, and '
  + '384 of the 4,480 reported divergences are the same situations recounted under two axis-B '
  + 'values the classifier cannot see. NEGATIVE CONTROL: B=quarantined adjudicates ZERO cells '
  + 'under this operation, so the gate discriminates rather than admitting everything. '
  + 'NO CELL\'S VERDICT IS FALSE AND NO COUNT MOVES -- the table counts CELLS over a declared '
  + 'input space and never claimed to count distinct phenomena; this states that scope. '
  + 'WHY THIS IS STATED RATHER THAN RE-PINNED, which is the question a later reader will ask: '
  + 'the artifact already disposes of an identical situation at larger scale the same way -- '
  + 'axis L reaches no storage input at all -- established AT SOURCE, since issuedAt, nowMs, '
  + 'clockSkew and futureSkew do not occur anywhere in packages/storage/src -- and that ships '
  + 'as a stated finding with both populations rather '
  + 'than as a count re-pin. Re-pinning axis B while leaving axis L a finding would make this '
  + 'artifact inconsistent with itself, in the direction of treating one fixture-visibility '
  + 'fact as an error and an identical one as a result. '
  + 'THE DOUBT THIS DISPOSITION DOES NOT DISSOLVE, registered rather than dropped because the '
  + 'ruling went the other way: the standing rule that a CLASS-CONSTANT FACT BELONGS TO THE '
  + 'MAP rather than the cells cuts against it, since one semantic fact is here multiplied by '
  + 'axis-B cardinality. It was judged non-decisive because that rule governs the verdict '
  + 'CODOMAIN while this is the INPUT SPACE -- but the underlying concern, that counts can end '
  + 'up describing the fixture rather than the system, does bite here, and it is exactly why '
  + 'the scope sentence above is load-bearing rather than decorative. '
  + 'STILL OPEN, filed against the Phase-3 gate with its population already named: whether a '
  + 'dirty row retaining a non-empty projection and owned-subject table is materializer-'
  + 'reachable. Its worst case is REDUNDANT cells, never wrong ones, and if it closes as '
  + 'unreachable these are the exact 1,152 that reclassify.',

  // THE AXIS-J REFINEMENT. Raised as a suspected fabrication defect -- cells
  // claiming a summary but evaluated without one -- and measured into its
  // opposite. Recorded because the artifact's axis-J finding states WHERE the
  // member is read, and this states where the AXIS discriminates, which is the
  // narrower and more useful fact.
  'AXIS J DISCRIMINATES EXACTLY WHERE THE SUMMARY MINTS, AND DUPLICATES WHERE IT CANNOT. '
  + 'A cell whose evidence subset NAMES verifiedAuthoritySummary receives the member only '
  + 'when the closure builder mints one for its head shape; where it cannot, buildCoreEvidenceV1 '
  + 'OMITS the member rather than refusing the cell. MEASURED over the 82,080 cells that name '
  + 'it: 10,944 MINT and 71,136 are omitted. For every one of the 71,136, the built evidence '
  + 'object is BYTE-IDENTICAL to that of the otherwise-identical cell that does not name the '
  + 'member (71,136 identical, 0 differing), and the projection verdicts agree in every case '
  + '(71,136 same, 0 different, 0 unmatched). Input equality is the stronger half and was '
  + 'measured first: identical inputs force identical outputs, while equal outputs would not '
  + 'have proven the inputs equal. '
  + 'SO NOTHING FALSE IS RECORDED -- each such cell carries core\'s real answer to the input '
  + 'it was actually given -- but 71,136 of them are BEHAVIOURAL DUPLICATES of their '
  + 'summary-absent counterparts, and axis J does no work over that sub-region. Where the '
  + 'summary DOES mint the axis is live, and sharply so on the absent-snapshot path where core '
  + 'reads it: 576 minting cells there, of which 128 change verdict when the member is removed. '
  + 'THIS IS THE MIRROR OF THE REMOVED S1 RULE, and the direction matters: S1 RETIRED these '
  + 'cells for unmintability, and removing it DECIDED them instead. Removing it was correct -- '
  + 'core genuinely decides them, which is what the 71,136 equal verdicts show. What was left '
  + 'unstated is that the axis LABEL on the decided cells claims a distinction the evaluator '
  + 'does not make there. Same disposition as axis B on the tombstone path and axis L against '
  + 'storage: a stated scope, not a re-pin, because no verdict is false and no count is wrong. '
  + 'STILL OPEN and filed against the Phase-3 gate with its population named: whether a cell '
  + 'may claim an evidence member it is not given is a DENOTATION question about the axis, of '
  + 'the same family as D=abovePlusOne, and it is not closed here. If it closes as "the label '
  + 'must mean the member is present", these are the exact 71,136 that move.',
];
