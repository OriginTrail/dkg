import type { SourceCitationV1 } from './authority-verdict-diff-constructibility-v1.js';

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
 *
 * THE THREE REFUSAL ROWS ARE NOT ALL THE SAME KIND, and the table must not imply
 * they are. F2 is a genuine contradiction between two axes RELATIVE to the same
 * referent. F1 and F3 are HARNESS LIMITATIONS: the objects they retire are ones
 * the system builds, and only this fixture's single referent forbids them. Their
 * counts are true and stay exactly as pinned; their labels were not, and the
 * dispositions live in CORE_HARNESS_LIMITATIONS_V1 -- a separate register, so a
 * fixture's own boundary is never read as a statement about the system.
 */
export interface CoreVerdictRowV1 {
  readonly cells: number;
  readonly projections: number;
}

export const CORE_VERDICT_TABLE_V1: Readonly<Record<string, CoreVerdictRowV1>> = {
  'REFUSED|F1-digest-equality-forces-the-current-state': { cells: 4608, projections: 1152 },
  'REFUSED|F2-digest-equality-forces-the-current-transition-digest': { cells: 9216, projections: 1152 },
  'REFUSED|F3-digest-equality-forces-the-current-fork-resolution-absence': { cells: 4608, projections: 576 },
  accept: { cells: 3456, projections: 640 },
  'quarantine|head-fork': { cells: 4096, projections: 512 },
  'quarantine|transition-equivocation': { cells: 47104, projections: 7040 },
  'reject|absent state cannot retain authority history or quarantine': { cells: 1280, projections: 768 },
  'reject|authority history is incomplete': { cells: 10240, projections: 1536 },
  'reject|cold noninitial head requires its verified authority closure': { cells: 512, projections: 320 },
  'reject|current frontier fork requires its exact direct resolving successor': { cells: 2048, projections: 256 },
  'reject|exact accepted authority transition is missing': { cells: 2560, projections: 384 },
  'reject|head issuedAt exceeds the future clock-skew bound': { cells: 48576, projections: 7680 },
  'reject|historical or unsolicited fork resolution is audit-only': { cells: 1024, projections: 128 },
  'reject|late tombstone lacks its exact verified active predecessor': { cells: 1536, projections: 384 },
  // THIS ROW WENT 192 -> 384 -> 192 ACROSS THREE EVIDENCE RULES, and the middle
  // value was a regression this fixture authored and then explained as a result.
  // Under sequence-keyed selection a lower-sequence tombstone was handed the
  // rotation INTO its sequence, while core's lower-sequence arm demands
  // lineage[candidateSequence] -- the rotation OUT of it -- so the fixture
  // manufactured this refusal and doubled the row. Branch-keyed selection
  // restores it. A number returning to where it started is the cleanest possible
  // evidence that what moved it was never the system.
  'reject|late tombstone requires the exact retained resurrection transition': { cells: 256, projections: 64 },
  // NEW ROW, and the table has never carried this reason before. A G='differ'
  // candidate names a competing rotation to a wallet root its own head does not
  // carry, so core refuses at the next-sequence issuer/root binding. It only
  // became reachable once the evidence layer stopped handing G='differ'
  // candidates the REAL rotation -- the mismatch was short-circuiting core at
  // 'exact accepted authority transition is missing' before this check ran,
  // which is why that row drops 3,840 -> 2,560 as this one appears.
  'reject|next-sequence head does not bind transition issuer/root': { cells: 1024, projections: 128 },
  'reject|next-sequence tombstone requires its exact same-sequence active predecessor': { cells: 512, projections: 128 },
  'reject|tombstone lacks its exact verified active predecessor': { cells: 2048, projections: 512 },
  // 'reject|transition does not bind the accepted predecessor' (1,024 / 128) is
  // GONE. It fired when a candidate named a transition whose prior head was not
  // its own; every candidate now names the rotation into its own sequence, so
  // nothing reaches it. Removed rather than pinned at zero because it is not a
  // declared codomain member -- this table records the rejects core RETURNED.
  'reject|unresolved head fork cannot advance authority sequence': { cells: 5120, projections: 768 },
  stale: { cells: 14336, projections: 1792 },
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
  '93898e323d6a17e63ea36b2d1584b496bf42391f2de4f8007cade88924917a9e';

/**
 * WHAT THE TABLE DECIDES, AND THE TWO THINGS THESE NUMBERS DO NOT SAY.
 *
 * THE SEQUENCE-DEPTH BOUNDARY IS NOW CLOSED, AND THIS NOTE IS KEPT RATHER THAN
 * DELETED. It used to read "ISSUE #57 STILL STANDS ... axis D='plusOne' has
 * 23,040 buildable cells and 0 that can mint ... the gap did not close", because
 * "core decides all 145,728 cells" reads exactly like a boundary that went away
 * when in fact it had only moved buckets. The gap HAS now closed: all four
 * axis-D relations mint, and D='plusOne' -- the next-sequence rotation the
 * Phase-3 coupling rests on -- reaches storage's advance path.
 *
 * The note stays because the hazard it names has not gone anywhere. This total
 * still says nothing about COVERAGE, and the next thing to move buckets will
 * hide behind it exactly the same way. What is comparable is 42,624 cells, not
 * 145,728, and the four-bucket partition is where that is visible.
 *
 * 145,728 DECIDED IS NOT 145,728 INDEPENDENT OBSERVATIONS. Of the 61,920 cells
 * the S1 removal returns to the table, 20,640 short-circuit at the future
 * clock-skew bound (core :98 testing it, :101 returning) before any other axis
 * does anything, so each of those contributes roughly one bit rather than a full
 * axis product. THE RE-PIN CHANGES WHAT IS DECIDED, NOT WHAT IS COVERED -- and
 * this is the number in the artifact most likely to be read as the opposite.
 *
 * THAT CLOCK ROW WAS SUSPECTED OF BEING A FOURTH MANUFACTURED RETIREMENT, AND WAS
 * MEASURED AND CLEARED. 20,640 is exactly one third of 61,920, and a mass refusal
 * collapsing onto a single message is that failure's signature -- the shape this
 * fixture has already had to withdraw twice. Measured: axis L is uniform over the
 * space and `beyondFutureSkew` is a DELIBERATE axis value chosen to trip that
 * bound (authority-verdict-diff-core-evidence-v1.ts:86), so 61,920/3 = 20,640
 * exactly, and each of those cells is a genuine system refusal of an input the
 * axis constructs on purpose rather than a gap the fixture left. A suspicion
 * investigated and withdrawn belongs in the record; one never raised does not.
 */
export const CORE_DECIDED_CELLS_V1 = 145728;
/**
 * Cells retired after the resolver, by the head layer alone.
 *
 * F1 4,608 + F2 9,216 + F3 4,608 = 18,432. The evidence layer retires nothing:
 * axis J is total.
 */
export const CORE_POST_RESOLVER_RETIRED_CELLS_V1 = 18432;
/** The resolver's own output, pinned upstream, restated here for conservation. */
export const CORE_RESOLVER_CONSTRUCTIBLE_CELLS_V1 = 164160;
export const CORE_PROJECTIONS_V1 = 25920;

/**
 * THE MEASUREMENT THAT LICENSES OMITTING AN UNMINTABLE SUMMARY, pinned beside the
 * table rather than argued in a comment.
 *
 * Rule S1 used to retire every cell that named `verifiedAuthoritySummary` on a
 * head shape the closure builder would not mint for -- 61,920 cells, 38% of the
 * space. Those cells are now driven with the member OMITTED, which is the only
 * evidence object a real caller holding such a head could assemble. The claim
 * that this does not move a verdict is EXHAUSTIVE over the affected set, not
 * sampled: every one of the 8,064 affected projections was driven twice, once
 * with a summary minted for a DIFFERENT head and once with the member absent.
 * Exhaustive over the affected set dominates any per-branch sample, and a branch
 * no affected cell reaches cannot be relevant to this change by construction.
 *
 * A NAME-GREP WOULD NOT HAVE BEEN ENOUGH, which is why the instrument is
 * empirical rather than textual. Core copies the field into its evidence snapshot
 * through an allowlist at system-record-authority-v1-internal.ts:654, so it
 * travels inside an object; a branch reading it off the whole snapshot, or by
 * dynamic access, would never appear in a grep for the symbol. Running the
 * branches closes that gap for the branches actually run.
 *
 * BOTH CONTROLS ARE PART OF THE RESULT, not decoration. Without the absent-path
 * control an instrument that compared nothing would report the same perfect
 * equality; 128 of 576 absent-path cells DO move when the summary is taken away,
 * so the instrument discriminates. The present-path control runs the other way:
 * 10,368 cells holding a VALID summary of their own are inert when it is removed,
 * so the present region's indifference is not an artefact of the substitute being
 * foreign.
 *
 * Re-run by authority-verdict-diff-summary-independence-v1.test.ts, which asserts
 * this whole object in ONE comparison -- so a control cannot be quietly dropped.
 *
 * THE AFFECTED SET SHRANK AND THAT IS THE GOOD DIRECTION, which is worth saying
 * because a falling number in a coverage-adjacent pin reads like a loss.
 * `affected` counts projections naming a summary their head shape CANNOT mint;
 * closing the sequence-depth boundary made six more shapes mintable, so cells
 * moved OUT of the affected set and INTO the summary-carrying one --
 * affectedProjections 9,792 -> 8,064 while summaryCarryingProjections 1,728 ->
 * 3,456. Fewer cells now rest on the omission argument and more carry a real
 * minted summary. Both controls still discriminate at their previous strength
 * (128 of 576 absent-path cells still move), so the equality is no more vacuous
 * than before.
 */
export const CORE_SUMMARY_INDEPENDENCE_V1 = {
  /** What rule S1 used to retire. */
  affectedProjections: 8064,
  affectedCells: 51552,
  affectedCellsAbsentPath: 864,
  affectedCellsPresentPath: 50688,
  /** Foreign summary vs member omitted, over EVERY affected projection. */
  equalityHeld: 8064,
  equalityDiffered: 0,
  equalityThrew: 0,
  /** Control: core DOES read the field here, so the instrument is not blind. */
  absentControlCells: 576,
  absentControlDiffered: 128,
  /** Control: a cell's OWN valid summary is inert across the present region. */
  presentControlCells: 20736,
  presentControlDiffered: 0,
  /** Of the returning cells, how many short-circuit at the clock before anything else. */
  clockShortCircuitCells: 17184,
  /** Cells and projections whose evidence really does carry a minted summary. */
  summaryCarryingProjections: 3456,
  summaryCarryingCells: 21312,
} as const;

/**
 * THE HARNESS'S OWN LIMITATIONS, KEPT IN THEIR OWN REGISTER.
 *
 * SEPARATION IS THE POINT, not tidiness. A fixture boundary filed beside the
 * system findings is read as a statement about the system -- which is the exact
 * error this register exists to correct, and putting the correction next to the
 * findings would reproduce it.
 *
 * THE DISCRIMINATOR. A refusal is the SYSTEM's only if the two axis values it
 * refuses cannot coexist on any object the system builds. If they can -- and the
 * sweep BUILDS such an object -- then what refused the cell was this fixture's
 * choice of referent, and calling it a domain refusal states something false
 * about the system while every count still sums.
 *
 * WHY IT IS RUN OVER EVERY RULE AND NOT THE INTERESTING ONES. This class's
 * IDENTIFYING PROPERTY IS THAT IT LOOKS PRINCIPLED: conservation is perfect, the
 * message is a real string from a real named site, the citation resolves, the
 * suite is green. A rule that looked suspicious would already have been caught by
 * something else. So triage-by-suspicion is not merely imperfect here, it is
 * ANTI-SELECTIVE -- it searches the one region the class does not inhabit. The
 * paired evidence is in this very file: the clock-skew row LOOKED exactly like an
 * instance (a third of the returning cells collapsing onto one message) and was
 * measured CLEAN, while F1 and F3 looked principled and were not.
 *
 * SIX INSTANCES OF THIS CLASS HAVE SURFACED IN THIS HARNESS: (1) axis G='differ'
 * and axis K='present' named with INVENTED digests, refusing 18 of 40 shapes for
 * missing objects; (2) the same species at larger scale, 25 of 34 refused shapes
 * and roughly 46,000 cells; (3) rule S1, 61,920 cells, which shipped pinned; (4)
 * F1; (5) F3; and (6) the NO-HEAD bucket describing 9,216 fixture-unbuildable
 * cells as though no candidate head existed on either side -- reported by the
 * join half, and counted here because it is the SAME error by the SAME
 * discriminator at bucket granularity rather than rule granularity, and
 * granularity is not species. The tally is evidence about the class, so
 * excluding an instance for being caught early would weaken the argument the
 * tally is being used to make.
 *
 * COMPLETENESS, SCOPED: no further instance found by THIS discriminator over
 * THESE rules, enumerated from source. That is not an all-clear -- five of the
 * six surfaced within a day of each other.
 */
export interface HarnessLimitationV1 {
  /** The rule id as it appears in the table, which does NOT change. */
  readonly ruleId: string;
  readonly cells: number;
  readonly projections: number;
  /** Why it is not a domain refusal, in this harness's own discriminator terms. */
  readonly discriminator: string;
  /** The referent that would make the region constructible. */
  readonly escape: string;
  /**
   * Whether the remedy needs #57's deeper chain or stands on its own.
   *
   * `unblocked-independent-of-issue-57` is a claim about SCHEDULE, not urgency,
   * and the two are easy to run together. The relabel already makes the artifact
   * truthful -- the data was never wrong, only the attribution -- so nothing
   * about this table's correctness waits on either remedy. What must not happen
   * is an unblocked item inheriting a backstop's schedule; what equally must not
   * happen is it being done by reopening the resolver mid-assembly.
   */
  readonly disposition: 'unblocked-independent-of-issue-57' | 'couples-to-issue-57';
  /**
   * How a reader RE-CHECKS the escape, one entry per CLAIM.
   *
   * STRUCTURED RATHER THAN PROSE, and the reason is this commit's own subject.
   * The first version of this field was a paragraph and the guard beside it
   * asserted that the paragraph contained the substring 'RUN:' -- a guard keyed
   * on WORDING, which went red the moment the paragraph was reworded without
   * losing a single claim. WORSE, AND MEASURED RATHER THAN SUSPECTED: the same
   * guard PASSED on precisely the failure it was written to catch, so it was
   * false-positive and vacuous at once. That pair is the whole argument for
   * keying on structure -- a guard for "an executed provenance exists" has to
   * key on a labelled entry, not on how the entry is phrased.
   *
   * ONE ENTRY PER CLAIM, never merged. "the referent is constructible", "the
   * referent moves the version axis" and "the remedy is cheap" are three
   * different claims, and merging them lets the weakest borrow the strongest's
   * evidence -- which is how "cheap" and "independent of #57" came to be
   * asserted from a single measurement that only supported one of them.
   */
  readonly provenance: readonly LimitationProvenanceV1[];
}

export interface LimitationProvenanceV1 {
  readonly claim: string;
  /** `run` was EXECUTED; `structural-read` was read at the site. */
  readonly kind: 'run' | 'structural-read';
  readonly evidence: string;
}

export const CORE_HARNESS_LIMITATIONS_V1: readonly HarnessLimitationV1[] = [
  {
    ruleId: 'F1-digest-equality-forces-the-current-state',
    cells: 4608,
    projections: 1152,
    discriminator:
      'F is RELATIVE to the referent and C is ABSOLUTE, and AXIS_CANDIDATE_HEAD_BINDING_V1 '
      + 'already says a codec refusal is a RULE only where an axis pins its field '
      + 'absolutely -- a relative axis is satisfied by MOVING the referent. The system '
      + 'builds a tombstone head at this authority sequence; only this fixture, which '
      + 'builds one referent and it is active, refuses the pair.',
    escape:
      'a SECOND referent: a tombstone at CORE_CURRENT_HEAD_V1\'s OWN authority sequence '
      + 'with a higher version. The axis that moves is E (version), not D '
      + '(authority-sequence depth), so the existing depth-2 chain is enough. Four sites '
      + 'cover the F=\'equal\' region between them: core-heads-v1.ts:55 (the single '
      + 'referent), :236 (this rule), :252 (F3\'s) and :264 (the referent the digest-equal '
      + 'path returns). SCHEDULED AS ITS OWN TASK (#59) AND NOT PERFORMED HERE: the '
      + 'artifact is already truthful once the label is right, and a remedy taken inside '
      + 'this assembly reopens the resolver mid-table, which is the move the #57 ruling '
      + 'exists to avoid.',
    disposition: 'unblocked-independent-of-issue-57',
    provenance: [
      {
        claim: 'the escape referent is constructible and mints a verified authority summary',
        kind: 'run',
        evidence:
          'This sweep already builds the object against the CURRENT fixture and it mints: '
          + 'shape present|tombstone|equal|above|-|equal|absent, a tombstone at authority '
          + 'sequence 2 with version 3. Had F1 carried a version-depth cost of its own, '
          + 'that build would have failed. Re-checked by '
          + 'authority-verdict-diff-core-table-v1.test.ts, which asserts the SEQUENCE '
          + 'equality rather than only the mint -- the sequence is the load-bearing part.',
      },
      {
        claim: 'the escape moves the VERSION axis at the existing authority sequence, '
          + 'which is what makes it independent of #57',
        kind: 'structural-read',
        evidence:
          "Read at the sweep's probe D (probes/p3.probe.test.ts, referent freedom) as "
          + 'reported by the storage half, and independently at '
          + 'authority-verdict-diff-core-heads-v1.ts:48-54 here: version 2 requires '
          + '`previousHeadDigest` (codec :206) and the current head carries exactly ONE '
          + 'such link, to CHAIN.base. The requirement is a SINGLE link to an immediate '
          + 'predecessor, not a chain of N-1 objects, so a version-3 referent links to '
          + 'the existing version-2 head whose own predecessor is already in the '
          + 'artifact map.',
      },
      {
        claim: 'the remedy is cheap',
        kind: 'run',
        evidence:
          'From the same run as the first entry, corroborated by the structural read. '
          + 'Kept as its own entry because "cheap" and "independent of #57" are DIFFERENT '
          + 'claims that were once asserted together from evidence supporting only one.',
      },
    ],
  },
  {
    ruleId: 'F3-digest-equality-forces-the-current-fork-resolution-absence',
    cells: 4608,
    projections: 576,
    discriminator:
      'F is RELATIVE and K is ABSOLUTE, the same pairing as F1. The head codec permits an '
      + 'ACTIVE head above version zero to carry a `forkResolutionDigest`, and this sweep '
      + 'builds 13 such heads, so the pair is not one the system forbids -- it is one this '
      + "fixture's referent cannot express.",
    escape:
      'a referent carrying a fork resolution. On the CORE side that is one more active '
      + 'head; the STORAGE half additionally needs a resolving successor above the '
      + 'resolution version, which is where the chain depth binds.',
    disposition: 'couples-to-issue-57',
    provenance: [
      {
        claim: 'an active head carrying a fork resolution is built and evaluated live',
        kind: 'run',
        evidence:
          '13 active heads carrying a forkResolutionDigest are built by this sweep. '
          + 'Re-checked by authority-verdict-diff-core-table-v1.test.ts, which asserts '
          + 'the count AND that core returns a decision rather than throwing for one of '
          + 'them -- "the codec builds it" alone would leave open that the evaluator '
          + 'rejects the object as malformed, which is not an escape.',
      },
    ],
  },
];

/**
 * The anchors for the asymmetry finding, in the harness's one citation shape.
 *
 * CITED AT :863 RATHER THAN :850 DELIBERATELY. The obvious line to quote for
 * "storage checks the summary" is the assert at :850, and it is the wrong one:
 * that exact text occurs TWICE in the file -- :850 in `assertTrustedReplacement`
 * and :906 in `assertTrustedTombstoneReplacement` -- so a line-anchored citation
 * on it cannot say which path it names, and the two paths are different
 * subjects. The binding conjuncts at :862/:863/:864 are unique, and :863 is the
 * discriminator: it ties the summary's lineage length to the head's own authority
 * sequence, which is the part core never re-imposes anywhere.
 */
export const CORE_SUMMARY_ASYMMETRY_CITATIONS_V1: readonly SourceCitationV1[] = [
  {
    id: 'core-single-semantic-read',
    site: 'packages/core/src/system-record-authority-v1-internal.ts:230',
    contains: 'const summary = evidenceState.verifiedAuthoritySummary;',
    why: "Core's ONLY semantic read of the field, and it sits inside the absent-state branch.",
  },
  {
    id: 'core-evidence-allowlist-copy',
    site: 'packages/core/src/system-record-authority-v1-internal.ts:654',
    contains: "'verifiedAuthoritySummary',",
    why: 'The allowlist that carries the field into the evidence snapshot, which is why a '
      + 'name-grep over the branch functions could not have settled this on its own.',
  },
  {
    id: 'storage-binds-candidate-head-digest',
    site: 'packages/storage/src/system-record-next-state-v1-internal.ts:862',
    contains: 'summary.candidateHeadDigest !== headDigest',
    why: 'Storage refuses a summary that does not name the head it is presented with.',
  },
  {
    id: 'storage-binds-lineage-length',
    site: 'packages/storage/src/system-record-next-state-v1-internal.ts:863',
    contains: 'BigInt(summary.transitionLineage.length) '
      + '!== parseCanonicalDecimalU64(facts.head.authoritySequence)',
    why: 'The lineage-length invariant: the discriminating conjunct, and unique in the file.',
  },
  {
    id: 'storage-binds-root-history-length',
    site: 'packages/storage/src/system-record-next-state-v1-internal.ts:864',
    contains: 'summary.historicalRoots.length !== summary.transitionLineage.length',
    why: 'The retained-root count must match the lineage it is retained against.',
  },
];

/**
 * The anchors for the sequence-depth boundary's CLOSURE.
 *
 * This register has now cited three different things, and the history is the
 * reason it exists. It first blamed the chain helper's `steps: 1 | 2` signature
 * -- a PARAMETER, not a bound. It was corrected to cite the two lines that were
 * the real cause: every candidate naming the same transition digest and the same
 * predecessor for all four axis-D values, so a deeper chain alone changed
 * nothing. Both of those lines are now GONE, and these citations anchor what
 * replaced them, so "the boundary is closed" is checkable rather than believed.
 *
 * A closed boundary keeps its anchors rather than dropping them. The claim a
 * reader needs to test is no longer "why can't these cells mint" but "is the
 * lineage really selected per sequence, or did someone quietly re-pin it" --
 * and that question is answered at exactly these lines.
 */
export const CORE_SEQUENCE_DEPTH_CITATIONS_V1: readonly SourceCitationV1[] = [
  {
    id: 'candidate-selects-the-lineage-of-its-own-sequence',
    site: 'packages/storage/test/helpers/authority-verdict-diff-core-heads-v1.ts:576',
    contains: 'const lineageHead = coreSequenceActiveHeadV1(String(sequence));',
    why: 'Axis D now selects the head its candidate descends from, which carries the '
      + 'issuer, root subject, owned-subject table digest and accepted transition that '
      + 'sequence requires. The single reused transition digest is gone.',
  },
  {
    id: 'candidate-descends-from-the-head-at-its-own-sequence',
    site: 'packages/storage/test/helpers/authority-verdict-diff-core-heads-v1.ts:589',
    contains: 'previousHeadDigest: requireSequenceLineageV1(String(sequence)).predecessorDigest,',
    why: 'The predecessor is the digest of that same head rather than the pinned '
      + 'sequence-2 current head, so a sequence-1 candidate no longer claims a '
      + 'predecessor ABOVE itself and a sequence-3 one no longer skips its own. '
      + 'Precomputed per sequence rather than hashed per build: hashing here cost '
      + 'roughly 145,000 digests and pushed this lane past its CI budget.',
  },
  {
    id: 'the-future-rotates-off-the-current-head-not-off-the-ancestry',
    site: 'packages/storage/test/helpers/authority-verdict-diff-core-heads-v1.ts:86',
    contains: 'const FORWARD = extendRotatedAuthorityChainV1(CORE_CURRENT_HEAD_V1, 2, 2);',
    why: 'The sequence-3 and sequence-4 heads rotate off the CURRENT head, not off the '
      + "ancestry's version-zero head at sequence 2. Extending the ancestry instead "
      + 'would mint a well-formed summary that storage still refuses as a history '
      + "mismatch, because its next-sequence arm compares the lineage tail's prior "
      + "head digest against the applied head's -- a refusal owned by this fixture "
      + 'wearing the system\'s wording.',
  },
];

/**
 * WHY A VERIFIED AUTHORITY SUMMARY IS OBTAINABLE FOR ONLY SIX HEAD SHAPES.
 *
 * A summary is a WeakSet-branded, factory-only capability, so a cell naming
 * `verifiedAuthoritySummary` receives one only if the closure builder will mint
 * one for that candidate head. Of the 40 buildable shapes, 12 mint and 28 are
 * refused.
 *
 * THE 'incomplete authority/root lineage' ROW IS GONE, and its absence is the
 * sequence-depth closure's headline. It carried 12 shapes -- every candidate at
 * an authority sequence other than the current one -- because each named the
 * same 1->2 transition and the same predecessor whatever sequence it claimed.
 * Six of those twelve now MINT and six moved to refusals that ARE the system's:
 * three to the accepted-transition binding and three to the resolving-successor
 * lineage check. A row leaving this census is the strongest available evidence
 * that a boundary closed rather than moved.
 *
 * WHAT THIS ROW NO LONGER MEANS: it used to be quoted as the cause of a
 * 61,920-cell retirement. It is not a retirement of anything now. The 34
 * unmintable shapes carry verdicts like every other shape, because a caller
 * holding an unmintable head still has an evidence object to present -- the one
 * without that member.
 *
 * EVERY ENTRY HERE IS A DOMAIN REFUSAL FROM CORE, and that property is the whole
 * point of the row rather than a detail of it. An earlier revision of this
 * fixture named axis G's 'differ' transition and axis K's fork resolution with
 * well-formed but INVENTED digests. A verification closure resolves every digest
 * a head names, so 25 of these 34 shapes were refused with
 * '[system-record-closure] verification closure is missing 0x...' -- a refusal
 * manufactured by this fixture's own missing artifacts. Pinning that would have
 * retired roughly 46,000 cells while every count summed, every message was real,
 * every citation named a real site, and the suite stayed green. Both digests are
 * now computed from REAL objects that travel with the closure's artifact map, and
 * the mint index AUDITS it: every lookup the closure walk makes is answered, and
 * THAT is the property the suite asserts -- not the wording of any one message.
 */
export const CORE_SUMMARY_MINT_OUTCOMES_V1: Readonly<Record<string, number>> = {
  MINTED: 12,
  '[system-record-closure] resolving successor changed accepted-transition lineage': 9,
  '[system-record-closure] verification closure contains authority-transition equivocation': 6,
  '[system-record-closure] tombstone predecessor is not the exact prior active authority state': 3,
  '[system-record-closure] head <digest> does not directly bind its fork resolution': 4,
  '[system-record-closure] head <digest> does not bind its accepted authority transition': 6,
};

/** Buildable candidate head shapes; the mint memoises on this, not on the cell. */
export const CORE_BUILDABLE_HEAD_SHAPES_V1 = 40;

/** Built ACTIVE heads carrying a fork resolution -- F3's escape, counted. */
export const CORE_FORK_CARRYING_ACTIVE_SHAPES_V1 = 13;

/**
 * PHASE 1 FINDINGS from the core half. Recorded as data so they travel with the
 * table rather than living in a commit message nobody re-reads.
 *
 * FINDINGS ABOUT THE SYSTEM ONLY. Anything that turns out to be a limitation of
 * this harness belongs in CORE_HARNESS_LIMITATIONS_V1, never here.
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
  // REQUALIFIED when rule S1 was removed: it bounds observation, not coverage.
  'a verified authority summary is obtainable for only 6 of 40 buildable candidate '
  + 'head shapes. Anything wanting to observe this subsystem from outside pays a '
  + 'factory-only capability as its entry fee, and the fixture builders are the '
  + 'reusable asset -- the same wall both halves of this diff hit independently. '
  + 'REQUALIFIED: this bounds what can be OBSERVED FROM OUTSIDE, not what core '
  + 'DECIDES. It was previously quoted as the cause of a 61,920-cell retirement, '
  + 'which turned an entry-fee observation into a coverage bound it does not '
  + 'support -- the 34 unmintable shapes are now decided like any other, on the '
  + 'evidence a caller holding such a head could actually assemble.',

  // THE COVERAGE BOUNDARY THIS TABLE'S OWN NUMBERS DO NOT ANNOUNCE. Recorded
  // after measurement because the alternative is a reader concluding that core
  // rejects next-sequence rotations, which this table does not show and cannot.
  // CORRECTED: the first version named the wrong cause and over-claimed on the
  // sequence relations. A finding that shipped wrong once is exactly the kind
  // that gets believed the second time, so both corrections are cited.
  'THE SEQUENCE-DEPTH BOUNDARY IS CLOSED, AND THIS ENTRY IS ITS HISTORY RATHER THAN '
  + 'ITS STATEMENT. What it used to say: over all 40 buildable shapes, D=below 23,040 '
  + 'buildable cells / 0 able to mint, D=plusOne 23,040 / 0, D=abovePlusOne 23,040 / 0 '
  + '-- 69,120 of 145,728 buildable cells, 47%, where no verified authority summary '
  + 'could be obtained. All three now mint. Mintable head shapes went 6 -> 12 and the '
  + "'[system-record-history] head <digest> has incomplete authority/root lineage' "
  + 'class went 12 shapes -> 0. The COMPARABLE region went 21,888 cells -> 42,624, '
  + '13.3% -> 25.97% of the constructible space. '
  + 'THE CAUSE WAS NEVER the chain helper\'s (steps: 1 | 2) signature -- a PARAMETER, '
  + 'not a bound. It was that every candidate reused the current head as its '
  + 'predecessor and the same 1->2 transition digest for EVERY axis-D value, so a '
  + 'deeper chain alone would have changed nothing. Both lines are gone; '
  + 'CORE_SEQUENCE_DEPTH_CITATIONS_V1 now anchors what replaced them. '
  + 'WHAT THE CLOSURE COST, recorded because the naive fix does not work: a candidate '
  + 'at sequence 3 cannot be built by DEEPENING the ancestry chain. The ancestry\'s '
  + 'sequence-2 head is the version-zero one while the current head is that head at '
  + 'version 2, so a rotation off the ancestry names a prior the receiver never '
  + 'applied -- and storage\'s next-sequence arm compares exactly that. Such a '
  + 'candidate verifies internally, mints a well-formed summary, and is STILL refused '
  + 'as a history mismatch, by the fixture\'s choice of predecessor in the system\'s '
  + 'wording. The future is therefore built by extendRotatedAuthorityChainV1 rotating '
  + 'off the CURRENT head, which is a different primitive from the ancestry builder on '
  + 'purpose. '
  + 'THE DENOTATION QUESTION ON D=abovePlusOne IS DISSOLVED, NOT DECIDED. This entry '
  + 'previously said the axis "AWAITS A DENOTATION DETERMINATION" and that building a '
  + "candidate first would pin a fixture's guess as a finding. Measured at both sites, "
  + 'neither implementation has the distinction the question presupposed: core '
  + 'system-record-authority-v1-internal.ts:151-153 rejects any candidate more than '
  + 'one sequence ahead with \'authority history is incomplete\', and storage\'s '
  + 'classifyAuthorityAdvance defers it as \'authority-history-mismatch\', both from '
  + 'the SEQUENCE NUMBER ALONE and both short-circuiting before reading the summary, '
  + 'the lineage, or anything else that could tell "intermediates presented" from '
  + '"intermediates withheld". There is no input the two readings differ on that '
  + 'reaches a branch. The shape the fixture builds is then forced by '
  + 'CONSTRUCTIBILITY rather than chosen: storage requires a verified summary as an '
  + 'input, so the withheld-intermediates shape cannot drive storage at all and its '
  + 'cells stay unconstructible on both sides. '
  + 'AXIS K=\'present\' IS A DIFFERENT BOUNDARY AND IS STILL OPEN. Axis G=\'differ\' '
  + 'never minting IS core being correct -- two transitions out of the same prior head '
  + 'into the same sequence is equivocation, which is what the axis value means. Axis '
  + 'K=\'present\' never minting is NOT, and closing axis D did not close it. Measured '
  + 'at isDirectResolvingSuccessorV1 (system-record-authority-verification-v1-internal'
  + '.ts:96-118), the predicate has FIVE conjuncts a candidate must satisfy, not the '
  + 'two previously recorded: version STRICTLY ABOVE resolutionVersion; '
  + 'previousHeadDigest equal to the resolution\'s forkBaseHeadDigest; and also '
  + 'matching evmIssuer, matching authoritySequence, and forkResolutionDigest equal to '
  + 'the resolution\'s digest. The last two are new information and they bite here '
  + 'specifically: a rotation MOVES evmIssuer, so the single fork resolution this '
  + 'fixture builds can only ever bind a sequence-2 candidate, and closing K=\'present\' '
  + 'across axis D requires a PER-SEQUENCE resolution with its own evidence heads. '
  + 'Separately, axis E applies only at D=\'equal\' (cells-v1), so off that column the '
  + 'candidate version falls to its default and cannot clear the version threshold at '
  + 'any chain depth. Filed as its own follow-up with these measurements rather than '
  + 'folded into the sequence-depth work, because it is a distinct mechanism at a '
  + 'distinct site and the Phase-3 routing coupling does not rest on it.'
  + ' '
  + 'EQUAL OUTCOMES FROM UNEQUAL MACHINERY, and this is the Phase-3-relevant '
  + 'half of what the closure buys. The three sequence relations are NOT alike '
  + 'in comparison value, and the ranking is the reverse of their cell counts. '
  + 'At D=below and D=abovePlusOne storage answers by a FLAT RULE on the '
  + 'sequence number alone -- `candidateSequence < currentSequence` returns '
  + 'stale, `> currentSequence + 1n` defers -- while core runs a RICH BRANCH on '
  + 'both, indexing lineage[candidateSequence] and comparing transition fields '
  + 'one by one at :274. The outcomes AGREE; the work does not. That matters '
  + 'because routing the live path through core replaces the flat rule with the '
  + 'rich one, so agreement measured today is agreement between a cheap check '
  + 'and an expensive one, and only the expensive one survives the route. '
  + 'D=plusOne is the discriminating comparison -- the only relation where BOTH '
  + 'sides do real work, core at its next-sequence branch (:318) and storage at '
  + "its tail checks on the summary's lineage, its "
  + 'lastAuthorityTransitionPriorHeadDigest and its root-history arithmetic -- '
  + 'which is consistent with the Phase-3 coupling having been placed on '
  + 'plusOne alone.',

  // AXIS DENOTATION, not a count. Filed because a committed axis's MEANING was
  // generalised, and a meaning that changes without a record is the kind of
  // thing a later reader reconstructs wrongly from the builder.
  'AXIS G IS SEQUENCE-RELATIVE, RULED RATHER THAN ASSUMED. Closing the '
  + "sequence-depth boundary forced a choice about what axis G means away from "
  + "D='equal', because a well-formed candidate at another authority sequence "
  + 'MUST name the rotation into its own sequence -- naming the current head\'s '
  + '1->2 transition at sequence 3 is precisely the malformation that boundary '
  + 'work removed. Two readings were available: LITERAL (compared to the current '
  + "head's digest, full stop, which makes G='equal' unconstructible off "
  + "D='equal' and returns half the newly-comparable cells to retirement) and "
  + 'SEQUENCE-RELATIVE (\'equal\' names the accepted rotation into the '
  + "candidate's own sequence, 'differ' a competing one). THE SEQUENCE-RELATIVE "
  + 'READING WAS ADOPTED, adjudicated 2026-08-12 rather than settled by the '
  + 'implementer, because generalising a reviewed axis is not a call the builder '
  + 'gets to make for itself. '
  + 'THE GROUND IS SYSTEM RESPONSIVENESS, WHICH IS EVIDENCE RATHER THAN '
  + "PREFERENCE: at the sequence-relative shapes G='differ' fires "
  + "'[system-record-closure] verification closure contains "
  + "authority-transition equivocation' -- 6 of the 40 buildable head shapes in "
  + 'CORE_SUMMARY_MINT_OUTCOMES_V1 -- so the outcome MOVES on the axis, which is '
  + 'what makes an axis live rather than enumerated. Supporting: equivocation is '
  + 'defined at its source as two transitions out of the same prior head into '
  + 'the same sequence, a sequence-relative notion where it is SPECIFIED and not '
  + 'merely where this fixture reads it. Against the literal reading and '
  + 'decisive: it would require a G=\'equal\' candidate off D=\'equal\' to name a '
  + 'rotation into somewhere other than its own sequence -- a head this fixture '
  + "authored to be malformed, refusing in the system's own wording, which is "
  + 'the manufactured-retirement class this slice exists to remove. '
  + 'SCOPE, because this claim is exactly the kind that gets widened: the '
  + 'generalisation is about AXIS G ONLY. It says nothing about axes D, E or F, '
  + 'whose relations remain against the current head. The older reading is not '
  + "wrong, it is the SPECIAL CASE at D='equal', and the core-heads suite pins "
  + 'that column on the two original constants byte for byte rather than '
  + 'inheriting it from the general rule.',

  // CONDITION-3 FINDING. Filed on its own rather than folded into the counts,
  // because it is a routing hazard and a statistic absorbed into a total is not
  // something anyone routes around.
  'THE ASYMMETRY: CORE NEVER READS `verifiedAuthoritySummary` ON ANY PRESENT-STATE '
  + 'PATH, WHILE STORAGE BIND-CHECKS IT HARD. Core has exactly ONE semantic read of '
  + 'the field, at system-record-authority-v1-internal.ts:230, inside the ABSENT-state '
  + 'branch; the five present-state branch functions (:274 lower-sequence, :318 '
  + 'next-sequence, :389 same-sequence tombstone, :427 same-sequence active, :445 '
  + 'fork-resolution successor) never read it, which is why omitting it moves no '
  + 'verdict there and is why this table can be re-pinned at all. Storage does the '
  + 'opposite: system-record-next-state-v1-internal.ts refuses a summary whose '
  + 'candidateHeadDigest is not the head\'s own digest (:862), whose transition lineage '
  + "length is not the head's authority sequence (:863), and whose retained root count "
  + 'is not its lineage length (:864). '
  + "ROUTING STORAGE'S CLASSIFICATION THROUGH CORE MUST NOT DROP STORAGE'S BINDING "
  + 'CHECK: core will not re-impose it on any present-state path, so a Phase-3 route '
  + "that hands the decision to core and carries only core's conditions loses the bind "
  + 'silently and with nothing failing anywhere. This is security-relevant and is '
  + 'exactly the class the mandatory diff exists to catch. '
  + 'SCOPE: "core never reads it" is TRUE; "the system never reads it" is FALSE (about '
  + '50 hits across storage and agent). The absence is scoped to the tree searched, and '
  + "storage's bind-check is the asymmetry's other half. "
  + 'The anchors are CORE_SUMMARY_ASYMMETRY_CITATIONS_V1, cited at :863 rather than at '
  + ':850: the text on :850 occurs TWICE in that file (:850 in assertTrustedReplacement, '
  + ':906 in assertTrustedTombstoneReplacement), so a line-anchored citation on it '
  + 'cannot say which path it names, and they are different subjects. '
  + 'THIS IS ONE DIRECTION OF A TWO-DIRECTIONAL FACT, and the general form is the '
  + 'sharpest sentence this phase produces: ROUTING CANNOT BE A DROP-IN, BECAUSE EACH '
  + 'SIDE READS STATE THE OTHER DOES NOT HAVE. The summary is one instance. The other '
  + "instance running the same way is core's `disposition`, which decides at :139-141 "
  + 'and for which storage has no producer at all -- MEASURED, with controls: the token '
  + 'occurs 15 times across 14 LINES in packages/core/src -- the gap is :643, which '
  + 'carries the token twice, so a line count and an occurrence count disagree here '
  + 'without either being wrong -- and 0 times in packages/storage/src, against a '
  + 'positive control (`authoritySequence`, 63 and 13) and a negative one (a nonexistent '
  + 'token, 0 and 0), so the zero is the tree\'s and not the instrument\'s. The mirror '
  + 'population -- cells storage answers from the applied row before the candidate is '
  + 'read, on an axis core has no field for -- is measured and recorded by the join '
  + 'half. THE ARCHITECTURAL FACT IS EASY TO LOSE PRECISELY BECAUSE IT IS FOUND TWICE, '
  + 'from opposite ends, and each time it presents as an ABSENCE and gets filed as an '
  + 'exclusion. Two exclusions in two registers do not add up to a finding unless '
  + 'someone writes the finding down.',

  // What the equality run establishes about the AXIS SPACE, which is a separate
  // claim from what it establishes about the table.
  'AXIS J IS NON-DISCRIMINATING OVER THE PRESENT REGION -- a property of the axis '
  + 'space, not of this fixture. All 61,056 present-path affected cells returned '
  + 'identical verdicts with a summary minted for a DIFFERENT head and with the member '
  + 'absent, so there the present/absent distinction axis J exists to express changes '
  + 'nothing core returns. THAT IS ALSO WHY OMITTING THE MEMBER IS LEGITIMATE RATHER '
  + 'THAN A MUTATION OF THE CELL: the field provably cannot affect the verdict there, '
  + 'so the evidence object this harness builds is the honest one a caller would hold '
  + 'rather than a weakened one -- the omission is a consequence of a measurement, not '
  + 'a fixture preference. The axis stays in the space because it DOES discriminate on '
  + 'the absent path, where 128 of 576 cells move, and an axis retired where it is dead '
  + 'would take its live half with it. '
  + 'READ THE SCOPE OF THIS ONE, because the claim is exactly the kind that gets '
  + 'widened on the way to the next reader: it is about the PRESENT region, and it is '
  + 'FALSE about the absent one. A FINDING\'S SCOPE IS PART OF THE FINDING, AND A TRUE '
  + 'CLAIM APPLIED AT THE READER\'S SCOPE IS A FALSE ONE. That is a STANDING HAZARD in '
  + 'this slice rather than three unlucky incidents -- "core never reads it" widening to '
  + '"the system never reads it", "27 literals / 32 sites" widening from one file to '
  + 'core, and an aggregate count being read as an image. Each was true where it was '
  + 'measured. None survived the widening, and none of them announced the widening '
  + 'either.',
];
