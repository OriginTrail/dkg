import {
  coreInputProjectionKeyV1,
  storageInputProjectionKeyV1,
  type VerdictDiffCellV1,
} from './authority-verdict-diff-cells-v1.js';
import type { CoreProjectionRowV1 } from './authority-verdict-diff-core-sweep-v1.js';
import {
  storageOutcomeLabelV1,
  storageReasonOfV1,
  type StorageProjectionRowV1,
} from './authority-verdict-diff-storage-sweep-v1.js';

/**
 * THE JOIN BETWEEN THE TWO AUTHORITY-ADVANCE IMPLEMENTATIONS.
 *
 * TWO LEVELS, AND NEVER A COMMON ENUM. Normalising both codomains into one
 * tidy enum is the failure this module is arranged against: core answers "is
 * this candidate the authority?" and storage answers "should I write it now?",
 * and a shared enum would assert that those are the same question by construction
 * -- after which every agreement the table reported would be an artifact of the
 * normalisation rather than a measurement of the systems.
 *
 * LEVEL 1 is the OUTCOME. A declared, cited, PARTIAL map from a core decision to
 * the SET of storage outcomes that decision requires. An observation inside the
 * image is AGREEMENT, outside it is DIVERGENCE, and an entry that can ground no
 * image at all yields NO-MAPPING.
 *
 * LEVEL 2 is the REASON, recorded VERBATIM in pairs and mapped to nothing. The
 * two reason unions are disjoint and no correspondence between them is
 * groundable, which the suite asserts rather than asserts away.
 */

export const JOIN_VERDICT_V1 = {
  AGREEMENT: 'AGREEMENT',
  DIVERGENCE: 'DIVERGENCE',
  NO_MAPPING: 'NO-MAPPING',
  NOT_COMPARABLE: 'NOT-COMPARABLE',
} as const;

export type JoinVerdictV1 = (typeof JOIN_VERDICT_V1)[keyof typeof JOIN_VERDICT_V1];

/**
 * WHAT AN ENTRY MEANS, carried by the MAP rather than by the cells.
 *
 * The rule that put it here: a fact that is CONSTANT across every cell in a
 * mapping class belongs to the class, not to its members. Giving each such cell
 * its own verdict value multiplies one semantic fact by the fixture's
 * cardinality and makes the headline describe how many cells were generated
 * instead of how the two systems differ.
 */
export const JOIN_SEMANTICS_V1 = {
  PRESERVING: 'SEMANTICS_PRESERVING',
  CHANGING: 'SEMANTICS_CHANGING',
} as const;

export type JoinSemanticsV1 = (typeof JOIN_SEMANTICS_V1)[keyof typeof JOIN_SEMANTICS_V1];

export const JOIN_BUCKET_V1 = {
  COMPARABLE: 'COMPARABLE',
  CORE_ONLY: 'CORE-ONLY',
  NO_HEAD: 'NO-HEAD',
} as const;

/**
 * A CELL WHERE ONE SIDE COULD NOT BE BUILT IS NOT A DIVERGENCE, and every such
 * cell carries the NAMED cause that made it uncomparable. An unnamed
 * non-comparability is indistinguishable from a case the harness quietly
 * dropped.
 */
export const JOIN_NOT_COMPARABLE_CAUSE_V1 = {
  /**
   * F2 ONLY, and it is a genuine contradiction: a head digest-equal to the
   * current cannot differ on any committed field, because a digest covers the
   * whole head. The SYSTEM forbids the input; no fixture could build it.
   */
  NO_CANDIDATE_HEAD_SYSTEM: 'no-candidate-head-exists-because-the-system-forbids-the-input',
  /**
   * F1 AND F3, AND THIS SPLIT IS A CORRECTION RATHER THAN A REFINEMENT.
   *
   * Both were originally recorded beside F2 as contradictions. A class sweep
   * then BUILT the referents they claim cannot exist -- a version-3 tombstone
   * referent mints a full summary and issues through the real registry, and a
   * fork-carrying active head is codec-legal and a live referent. So F1 and F3
   * retire their 9,216 cells against THIS FIXTURE'S current-head properties, not
   * against anything the system forbids.
   *
   * The cause is split rather than annotated because a bucket that says "the
   * system has no candidate head here" when the truth is "our fixture cannot
   * build one" is precisely the error this artifact exists to report -- and
   * reproducing it inside the report would be the worst place to put it.
   */
  NO_CANDIDATE_HEAD_HARNESS: 'no-candidate-head-because-this-fixture-cannot-build-the-referent',
  /**
   * Storage cannot be driven at all. `verifiedAuthoritySummary` is a REQUIRED
   * field on all three facts variants and is bind-checked at
   * system-record-next-state-v1-internal.ts:902 -- the lineage-length invariant,
   * which is unique in that file, unlike the brand assert at :869 whose text
   * recurs at :925 in the tombstone path and so cannot name which path it means.
   * A summary is a factory-only capability, so where the closure builder refuses
   * to mint one there is no storage verdict to compare against.
   *
   * THIS IS NOT THE SAME ERROR AS F1/F3, and a reader who has just met that
   * correction will assume it is. Two harness limitations on the core side do
   * not imply a third here: storage genuinely requires a bound summary and
   * genuinely cannot be driven without one, which is a property of the code at
   * :882 rather than of this fixture's chain depth. The cause stands as declared.
   */
  NO_MINTABLE_SUMMARY: 'storage-requires-a-verified-authority-summary-this-head-cannot-mint',
  /**
   * THE MAP'S PRECONDITION, and the sharpest single fact in this artifact.
   * Storage answers from the APPLIED ROW without reading the candidate at all,
   * on an axis core has no field for. See `storageReadsTheCandidateV1`.
   */
  APPLIED_ROW_SHORT_CIRCUIT: 'storage-answered-from-the-applied-row-without-reading-the-candidate',
} as const;

/**
 * DOES STORAGE EVEN LOOK AT THE CANDIDATE? Declared from the two cited gates and
 * from the CELL AXES ALONE -- never from the storage answer, which would make
 * the precondition a restatement of the observation and unfalsifiable.
 *
 * TWO CLASSIFIERS, because the exported entry dispatches on the operation at
 * :190-200 and the tombstone path never enters `classifyAuthorityAdvance`:
 *
 *   operation 'tombstone' -> `deriveSystemRecordTombstoneReplacementV1`, whose
 *   gate at :995-999 refuses a QUARANTINED row and nothing else. A dirty or
 *   already-tombstoned row passes it.
 *
 *   operation 'active'/'quarantine' -> `classifyAuthorityAdvance`, which returns
 *   `deferred('non-active-state')` before the candidate is first read at :1221:
 *     :1218-1219  any status that is neither 'active' nor 'quarantined'
 *     :1215-1216  a quarantined row under any operation that is not 'quarantine'
 *     :1202-1213  a quarantined row under 'active' unless a verified direct
 *                 fork-resolving successor adjudicates that exact quarantine
 *   An absent row short-circuits the other way at :1197 and DOES produce a
 *   verdict, so it meets the precondition.
 *
 * Core has no field to put an applied status in: `AgentProfileAcceptedAuthority-
 * StateV1` carries current, disposition, transitionLineage and historicalRoots,
 * and axis B is pinned core-invisible in CORE_INVISIBLE_AXES_V1. So on a cell
 * that fails this predicate the two sides are not disagreeing about the
 * candidate -- they are answering different questions, and calling that a
 * DIVERGENCE would manufacture 12,096 of them.
 */
export function storageReadsTheCandidateV1(cell: VerdictDiffCellV1): boolean {
  if (cell.storageOperation === 'tombstone') return cell.appliedStatus !== 'quarantined';
  if (cell.snapshot === 'absent') return true;
  if (cell.appliedStatus === 'active') return true;
  // The :1202 arm can in principle admit a quarantined row under an 'active'
  // operation, but only for a candidate whose fork resolution adjudicates THAT
  // quarantine. No cell in this space does, which is recorded as a measured
  // sub-fact rather than assumed: the pinned distribution has zero adjudicated
  // cells at B=quarantined H=active, so if one ever appears this predicate
  // becomes wrong and the discrimination assertion goes red.
  if (cell.appliedStatus === 'quarantined') return cell.storageOperation === 'quarantine';
  return false;
}

/**
 * The level-1 key for a core decision.
 *
 * NON-UNIFORM, for the reason the core table already records: `accept` and
 * `stale` carry no reason and key bare, while `quarantine.reason` is a CLOSED
 * two-value union whose VALUE is the meaning -- the two quarantines are
 * different decisions and collapsing them would hide which one a cell took.
 * `reject.reason` is an OPEN string and belongs at level 2.
 */
export function coreDecisionKeyV1(outcome: CoreProjectionRowV1['outcome']): string {
  if (outcome.kind !== 'decision') return `NOT-A-DECISION|${outcome.kind}`;
  return outcome.decision === 'quarantine'
    ? `quarantine|${outcome.reason ?? '<none>'}`
    : outcome.decision;
}

export function coreOutcomeLabelV1(outcome: CoreProjectionRowV1['outcome']): string {
  if (outcome.kind === 'decision') {
    return outcome.reason === undefined ? outcome.decision : `${outcome.decision}|${outcome.reason}`;
  }
  return outcome.kind === 'refused'
    ? `REFUSED|${outcome.ruleId}`
    : `THREW|${outcome.message}`;
}

export function coreReasonOfV1(outcome: CoreProjectionRowV1['outcome']): string {
  if (outcome.kind !== 'decision') return `<not-a-decision:${outcome.kind}>`;
  return outcome.reason ?? '<none>';
}

/**
 * STORAGE'S COMPLETE LEVEL-1 CODOMAIN.
 *
 * Enumerated rather than collected, and that is the point: the two reason unions
 * at :68-73 and :75-80 are CLOSED, so a reason added to either one moves this
 * list and takes the pinned images with it. `root-collision` appears BARE
 * because it carries `claimSubjects` and NOT a reason -- its payload is a
 * subject list, which is a level-2 fact of a different shape, and forcing it
 * into a (verdict, reason) slot would assert a shape it does not have.
 */
export const STORAGE_OUTCOME_CODOMAIN_V1: readonly string[] = [
  'ready',
  'already-applied',
  'stale',
  'root-collision',
  'deferred|non-active-state',
  'deferred|authority-fork',
  'deferred|authority-history-mismatch',
  'deferred|verified-state-mismatch',
  'deferred|root-state-changed',
  // THE TWO REASONS THE LATE-TOMBSTONE SEAM ADDED, and this pin earned its keep
  // here. Routing that seam through core moved 1,152 cells onto labels the list
  // had never been shown, and because `reject`'s image is computed FROM this
  // list those cells adjudicated DIVERGENCE until the list caught up -- exactly
  // what the enumerated-not-collected discipline above says should happen. A
  // reason added to the source union moves this list and takes the images with
  // it, instead of being absorbed silently.
  'deferred|late-tombstone-evidence-incomplete',
  'deferred|undecided-authority-disposition',
  'capacity-exhausted|state-revision-overflow',
  'capacity-exhausted|capacity-revision-overflow',
  'capacity-exhausted|record-count-cap',
  'capacity-exhausted|aggregate-cap',
  'capacity-exhausted|subject-union-cap',
];

/** Storage outcomes that ADMIT the candidate; everything else withholds it. */
const STORAGE_ADMITTING_V1 = ['ready', 'already-applied'] as const;
const STORAGE_WITHHOLDING_V1 = STORAGE_OUTCOME_CODOMAIN_V1.filter(
  (label) => !(STORAGE_ADMITTING_V1 as readonly string[]).includes(label),
);

export interface JoinLevel1EntryV1 {
  readonly coreDecisionKey: string;
  /** The storage outcomes this core decision REQUIRES; null where none grounds. */
  readonly image: readonly string[] | null;
  readonly semantics: JoinSemanticsV1;
  readonly citations: readonly string[];
  readonly note: string;
}

/**
 * THE LEVEL-1 MAP. Declared from the sites, then measured -- in that order, and
 * every place the measurement widened a declaration is written into the note
 * rather than smoothed away.
 *
 * WHAT MAKES A DECLARED IMAGE ADMISSIBLE IS A COUNTERFACTUAL: toggle the feature
 * the deciding side decides on, and the other side's outcome must be ABLE to
 * move. Otherwise the image is a coincidence of whatever the other side's own
 * axes happened to be doing, and it can never be violated by the observation
 * that produced it.
 *
 * THE COUNTERFACTUAL REQUIREMENT APPLIES TO POSITIVE IMAGES ONLY, and the
 * qualifier is load-bearing rather than pedantic. A POSITIVE image -- "core says
 * this, so storage says X" -- NAMES an outcome, and nothing can name X unless the
 * other side is RESPONSIVE to the feature; the counterfactual is how that
 * responsiveness gets measured. A NEGATIVE image -- `reject`'s "withholding
 * outcomes only" -- is grounded in what the core decision MEANS, and asks the
 * other side only NOT to do the forbidden thing. There, structural invariance on
 * the deciding axis is not disqualifying; it is the EXPLANATION.
 *
 * WITHOUT THE QUALIFIER THE TEST REACHES THE WRONG ANSWER BY BEING APPLIED
 * CORRECTLY. Storage is clock-invariant, so `reject` fails a counterfactual it
 * was never subject to, gets reclassified NO-MAPPING for consistency with
 * `quarantine|transition-equivocation`, and this artifact's 3,136 divergences
 * vanish into an exclusion bucket.
 */
export const JOIN_LEVEL1_MAP_V1: readonly JoinLevel1EntryV1[] = [
  {
    coreDecisionKey: 'accept',
    image: [...STORAGE_ADMITTING_V1],
    semantics: JOIN_SEMANTICS_V1.PRESERVING,
    citations: [
      'packages/storage/src/system-record-next-state-v1-internal.ts:221-222',
      'packages/storage/src/system-record-next-state-v1-internal.ts:259',
      'packages/storage/src/system-record-next-state-v1-internal.ts:314',
    ],
    note: 'Storage has no outcome spelled `accept`. Its internal classifier value '
      + '`advance` never escapes the entry: :222 returns every NON-advance verdict '
      + 'verbatim, while `advance` falls through into the derivation and surfaces '
      + 'with the materialization discriminator folded in -- `already-applied` from '
      + 'the reuse branch at :259-:314, `ready` otherwise. Both admit the candidate '
      + 'as the new authority, which is what core `accept` says, so the image is the '
      + 'admitting pair. MEASURED: only `ready` is reached; the `already-applied` '
      + 'member is pinned at zero rather than dropped, because an image narrowed to '
      + 'fit the observation could never have caught the observation moving.',
  },
  {
    coreDecisionKey: 'stale',
    // ENUMERATED FROM THE SOURCE BEFORE THE RUN, never from the run. An image
    // fitted to an observation cannot be violated by that observation -- it is
    // drawing the target around the arrow, and the guard it arms would encode
    // nothing about what was expected. These are the four exits reachable from
    // the inputs core calls stale: :1224/:1239 stale, the reuse branch's
    // :313-314 already-applied and its :270 mismatch exit, and the
    // rematerialize fall-through to `ready`.
    image: ['stale', 'already-applied', 'ready', 'deferred|verified-state-mismatch'],
    semantics: JOIN_SEMANTICS_V1.CHANGING,
    citations: [
      'packages/core/src/system-record-authority-v1-internal.ts:196',
      'packages/core/src/system-record-authority-v1-internal.ts:199',
      'packages/storage/src/system-record-next-state-v1-internal.ts:1259',
      'packages/storage/src/system-record-next-state-v1-internal.ts:1261-1270',
      'packages/storage/src/system-record-next-state-v1-internal.ts:270',
    ],
    note: 'MAPPING core stale TO {stale} ALONE WOULD FABRICATE A DIVERGENCE, and '
      + 'that is the worst output this harness can produce. Core has TWO stale '
      + 'sub-causes and only one of them is storage `stale`. At :196 a LOWER-VERSION '
      + 'candidate is stale, and storage says `stale` at :1239 for the same input. At '
      + ':199 the IDENTICAL head -- same version, same digest -- is also stale, and '
      + 'storage calls that input `advance` at :1241-1250, surfacing as '
      + '`already-applied`. Same outcome, different word. THE IMAGE WAS THEN WIDENED '
      + 'BY MEASUREMENT to include `ready`: :1244-1249 selects `rematerialize` rather '
      + 'than `reuse` when the snapshot needs rematerialising or a quarantine '
      + 'operation moved the status or the conflict-evidence digest, and a '
      + 'rematerialize does NOT enter the reuse branch -- it returns a CAS plan the '
      + 'executor APPLIES. So on an identical head core does nothing while storage '
      + 'may rewrite state, which is why this entry is semantics-CHANGING and not a '
      + 'vocabulary difference.',
  },
  {
    coreDecisionKey: 'quarantine|head-fork',
    image: ['deferred|authority-fork'],
    semantics: JOIN_SEMANTICS_V1.CHANGING,
    citations: [
      'packages/core/src/system-record-authority-v1-internal.ts:200',
      'packages/core/src/system-record-authority-v1-internal.ts:480',
      'packages/storage/src/system-record-next-state-v1-internal.ts:1271',
    ],
    note: 'No storage outcome is spelled `quarantine`: storage\'s quarantine is an '
      + 'axis-H INPUT operation, not an outcome. The image is still groundable and '
      + 'still narrow -- core reaches :200 on a same-sequence same-version candidate '
      + 'whose digest differs, which is exactly the condition storage tests at :1251 '
      + 'before returning deferred(authority-fork). WHAT DIFFERS IS DURABILITY, and '
      + 'it is the concrete answer to what storage loses by not being routed through '
      + 'core: core\'s quarantine is STATE. At :480 `evaluateSameSequenceActiveAdvance'
      + 'V1` branches on `acceptedState.disposition === \'head-fork-quarantined\'` and '
      + 'routes the NEXT candidate down the fork-resolution-successor path. Storage\'s '
      + 'defer leaves no trace at all: the next candidate is evaluated identically to '
      + 'the first. '
      + 'THE ENTRY MATCHES 768 CELLS, NOT THE 1,728 A STORAGE-SIDE COUNT SUGGESTS, and '
      + 'the gap is a trap worth naming at the site. Storage emits '
      + 'deferred(authority-fork) on 1,728 comparable cells, but those arrive from THREE '
      + 'different core decisions -- 768 here, 576 from reject(head issuedAt exceeds the '
      + 'future clock-skew bound) and 384 from quarantine(transition-equivocation). A '
      + 'STORAGE-SIDE AGGREGATE IS NOT ANY ONE CORE DECISION\'S IMAGE. Reading one as the '
      + 'other produced a wrong count during this entry\'s design, and it is the same '
      + 'shape as attributing a group total to one of its members.',
  },
  {
    coreDecisionKey: 'quarantine|transition-equivocation',
    image: null,
    semantics: JOIN_SEMANTICS_V1.CHANGING,
    citations: [
      'packages/core/src/system-record-authority-v1-internal.ts:139-141',
      'packages/core/src/system-record-authority-v1-internal.ts:171-172',
      'packages/storage/test/authority-verdict-diff-projection-v1.test.ts:129',
    ],
    note: 'NO IMAGE CAN BE GROUNDED, and the reason is structural rather than a gap '
      + 'in the measurement. At :139-141 core returns this decision from '
      + '`acceptedState.disposition` ALONE, before it reads the candidate\'s sequence '
      + 'or version at all -- axis I, which storage has no field for and no producer '
      + 'of (pinned by the projection suite\'s scoped absence claim over '
      + 'packages/storage/src). So the storage outcomes observed under this entry are '
      + 'simply the ones the storage-VISIBLE axes would have produced anyway; they '
      + 'stand in no correspondence to the decision. THIS IS THE EXACT MIRROR OF THE '
      + 'MAP\'S PRECONDITION: storage short-circuits on axis B, which core cannot see, '
      + 'and core short-circuits on axis I, which storage cannot see. The two are '
      + 'recorded differently on purpose -- core\'s is CONSTANT across this whole '
      + 'mapping class and so belongs to the map as a no-image entry, while storage\'s '
      + 'varies cell by cell with axis B and so belongs to the cell as a named '
      + 'non-comparability. '
      + 'READ THIS BESIDE THE `reject` ENTRY, which meets the same shape of fact and correctly '
      + 'answers it the other way. Both are one side deciding on an axis the other cannot see: '
      + 'core on axis I here, core on axis L -- the clock -- there, where storage is just as '
      + 'blind. WHAT SEPARATES THEM IS THE KIND OF CLAIM THE IMAGE WOULD BE. This entry would '
      + 'need a POSITIVE image -- "core says transition-equivocation, so storage says X" -- and '
      + 'a positive image REQUIRES THE OTHER SIDE TO BE RESPONSIVE TO THE FEATURE, because X is '
      + 'grounded in the other side\'s answer to it. Storage is not responding to the '
      + 'equivocation at all, so nothing grounds an X and this entry stands at NO-MAPPING. The '
      + 'reject entry\'s image is NEGATIVE -- reject implies withholding outcomes only -- '
      + 'grounded in what a reject MEANS rather than in storage\'s responsiveness, and a '
      + 'NEGATIVE CONSTRAINT ONLY REQUIRES THE OTHER SIDE NOT TO DO THE FORBIDDEN THING. '
      + 'Storage materialises, so it is outside that image and those cells are DIVERGENCES. So '
      + 'TWO POPULATIONS OF THE SAME SURFACE SHAPE LAND IN OPPOSITE BUCKETS -- 1,920 cells '
      + 'NO-MAPPING here, 2,112 of the 3,136 divergences there -- and that is correct rather '
      + 'than an inconsistency to be tidied away. It is recorded at BOTH entries so that a '
      + 'later consistency argument cannot quietly reclassify the divergences into this bucket '
      + 'and delete the artifact\'s headline.',
  },
  {
    coreDecisionKey: 'reject',
    image: STORAGE_WITHHOLDING_V1,
    semantics: JOIN_SEMANTICS_V1.CHANGING,
    citations: [
      'packages/core/src/system-record-authority-v1-internal.ts:98-103',
      'packages/storage/src/system-record-next-state-v1-internal.ts:164-179',
      'packages/storage/test/authority-verdict-diff-projection-equivalence-v1.test.ts',
    ],
    note: 'A core `reject` refuses the candidate outright, so nothing that ADMITS it '
      + 'can be in the image: the image is every withholding outcome and only those. '
      + 'THE DIVERGENCES THIS ENTRY FINDS ARE THE HEADLINE OF THE WHOLE ARTIFACT. '
      + 'Storage materialises heads core refuses, and the dominant cause is core\'s '
      + 'clock gate at :98-103 -- `head issuedAt exceeds the future clock-skew bound` '
      + '-- against a storage classifier with no clock input at all. Axis L reaches '
      + 'no storage input, established AT SOURCE: issuedAt, nowMs, clockSkew and '
      + 'futureSkew do not occur anywhere in packages/storage/src. (285 is the storage '
      + 'projection key without its clock segment, not a count of built inputs.) '
      + 'Routing the live path through core would START REFUSING these heads. '
      + 'WHY THESE ARE DIVERGENCES AND NOT NO-MAPPING, answered at the entry because the '
      + 'question arrives from the other side of the map. '
      + '`quarantine|transition-equivocation` grounds no image on exactly this shape of fact '
      + '-- one side deciding on an axis the other cannot see -- and 2,112 of the 3,136 '
      + 'divergences here are core deciding on axis L, which storage cannot see either. THE '
      + 'TWO IMAGES ARE DIFFERENT KINDS OF CLAIM. That entry would need a POSITIVE image, '
      + '"core says this, so storage says X", and X has to be grounded in something: A '
      + 'POSITIVE IMAGE REQUIRES THE OTHER SIDE TO BE RESPONSIVE TO THE FEATURE. Nothing '
      + 'grounds an X there, because storage is not responding to the equivocation at all. '
      + 'THIS entry\'s image is NEGATIVE -- a reject implies withholding outcomes only -- and '
      + 'it is grounded in what a reject MEANS, not in storage\'s responsiveness to the clock. '
      + 'A NEGATIVE CONSTRAINT DOES NOT REQUIRE THE OTHER SIDE TO BE RESPONSIVE TO THE SAME '
      + 'FEATURE; IT ONLY REQUIRES IT NOT TO DO THE FORBIDDEN THING. Storage materialises, so '
      + 'it is outside the image, and the cell is a real divergence about whether this head '
      + 'may enter the store. TWO POPULATIONS WITH THE SAME SURFACE SHAPE THEREFORE LAND IN '
      + 'OPPOSITE BUCKETS ON THIS DISTINCTION, correctly -- 1,920 NO-MAPPING there, 2,112 '
      + 'DIVERGENCE here. STORAGE\'S CLOCK-BLINDNESS EXPLAINS THE DIVERGENCE; IT DOES NOT '
      + 'DISQUALIFY IT. The reason is written down rather than left to be re-derived because '
      + 'the tidy-looking move -- reclassifying these cells NO-MAPPING for consistency with '
      + 'the equivocation entry -- would erase the headline of the whole artifact.',
  },
];

const LEVEL1_BY_KEY_V1 = new Map(JOIN_LEVEL1_MAP_V1.map((entry) => [entry.coreDecisionKey, entry]));

/** What the guard returns for a pair the level-1 map has never been shown. */
export const JOIN_UNADJUDICATED_V1 = 'UNADJUDICATED';

/**
 * THE WHOLE OF LEVEL 1, AS ONE PURE FUNCTION, and it is exported so the suite
 * can fire the guard directly rather than only ever observing it silent.
 *
 * `expect(unadjudicated).toStrictEqual([])` is exactly the shape that passes
 * when a helper always returns empty. Calling this with a core decision the map
 * has never been shown, and watching it answer UNADJUDICATED, is the positive
 * apply-check that separates "the guard held" from "the guard is dead".
 */
export function adjudicatePairV1(
  coreDecisionKey: string,
  storageLabel: string,
): JoinVerdictV1 | typeof JOIN_UNADJUDICATED_V1 {
  const entry = LEVEL1_BY_KEY_V1.get(coreDecisionKey);
  if (entry === undefined) return JOIN_UNADJUDICATED_V1;
  if (entry.image === null) return JOIN_VERDICT_V1.NO_MAPPING;
  return entry.image.includes(storageLabel)
    ? JOIN_VERDICT_V1.AGREEMENT
    : JOIN_VERDICT_V1.DIVERGENCE;
}

export interface JoinRowV1 {
  readonly coreProjectionKey: string;
  readonly storageProjectionKey: string;
  readonly cells: number;
  readonly bucket: string;
  readonly verdict: JoinVerdictV1;
  readonly cause: string;
  readonly coreDecisionKey: string;
  readonly coreLabel: string;
  readonly storageLabel: string;
  readonly coreReason: string;
  readonly storageReason: string;
  /** Which of core's two stale sub-causes this row took; '' where not stale. */
  readonly staleRoute: string;
  /** True where the cell names verifiedAuthoritySummary in its axis-J subset. */
  readonly namesSummary: boolean;
}

export interface JoinResultV1 {
  readonly rows: readonly JoinRowV1[];
  /**
   * THE GUARD, AND IT IS THE POINT. An observed (core, storage) pair the level-1
   * map does not adjudicate is a FAILURE, never a row: it means core returned a
   * decision the map has never been shown, and a table that quietly absorbed it
   * would report a codomain it does not cover.
   */
  readonly unadjudicated: readonly string[];
}

/**
 * CORE'S TWO STALE SUB-CAUSES, separated so the pin can say which cells took
 * which route. Derived from the cell axes rather than from the storage answer:
 * deriving it from the answer would make the routes agree with the observation
 * by construction and prove nothing about core.
 */
function staleRouteV1(cell: VerdictDiffCellV1): string {
  if (cell.sequenceRelation === 'below') return 'lower-sequence';
  if (cell.sequenceRelation !== 'equal') return 'unclassified';
  if (cell.versionRelation === 'below') return 'lower-version:core:196';
  if (cell.versionRelation === 'equal' && cell.headDigest === 'equal') {
    return 'identical-head:core:199';
  }
  return 'unclassified';
}

export function joinVerdictDiffV1(input: {
  readonly cells: readonly VerdictDiffCellV1[];
  readonly coreRows: readonly CoreProjectionRowV1[];
  readonly storageRows: readonly StorageProjectionRowV1[];
}): JoinResultV1 {
  const coreByKey = new Map(input.coreRows.map((row) => [row.projectionKey, row.outcome]));
  const storageByKey = new Map(input.storageRows.map((row) => [row.projectionKey, row.outcome]));

  // Grouped by the PAIR of projection keys: that is the join's own unit, and it
  // is what the digest is taken over. Cells inside one pair present identical
  // inputs to both evaluators, so they cannot carry different verdicts.
  const grouped = new Map<string, JoinRowV1 & { cells: number }>();
  const unadjudicated = new Set<string>();

  for (const cell of input.cells) {
    const coreProjectionKey = coreInputProjectionKeyV1(cell);
    const storageProjectionKey = storageInputProjectionKeyV1(cell);
    const core = coreByKey.get(coreProjectionKey);
    const storage = storageByKey.get(storageProjectionKey);
    if (core === undefined || storage === undefined) {
      throw new Error(`join lost a projection for ${cell.id}`);
    }

    const coreLabel = coreOutcomeLabelV1(core);
    const coreDecisionKey = coreDecisionKeyV1(core);
    const namesSummary = cell.evidence.includes('verifiedAuthoritySummary');

    let bucket: string;
    let verdict: JoinVerdictV1;
    let cause = '';
    let storageLabel: string;
    let storageReason: string;

    if (storage.kind === 'head-refused') {
      bucket = JOIN_BUCKET_V1.NO_HEAD;
      verdict = JOIN_VERDICT_V1.NOT_COMPARABLE;
      // The discriminator rides on the RULE, so the pinned cause distribution
      // carries the harness/system split rather than leaving it to a comment
      // that no assertion can keep honest.
      cause = storage.ruleId.startsWith('F2-')
        ? JOIN_NOT_COMPARABLE_CAUSE_V1.NO_CANDIDATE_HEAD_SYSTEM
        : JOIN_NOT_COMPARABLE_CAUSE_V1.NO_CANDIDATE_HEAD_HARNESS;
      storageLabel = `head-refused|${storage.ruleId}`;
      storageReason = storage.ruleId;
    } else if (storage.kind === 'summary-unmintable') {
      bucket = JOIN_BUCKET_V1.CORE_ONLY;
      verdict = JOIN_VERDICT_V1.NOT_COMPARABLE;
      cause = JOIN_NOT_COMPARABLE_CAUSE_V1.NO_MINTABLE_SUMMARY;
      storageLabel = 'summary-unmintable';
      storageReason = 'summary-unmintable';
    } else {
      bucket = JOIN_BUCKET_V1.COMPARABLE;
      storageLabel = storageOutcomeLabelV1(storage.outcome);
      storageReason = storageReasonOfV1(storage.outcome);
      if (!storageReadsTheCandidateV1(cell)) {
        verdict = JOIN_VERDICT_V1.NOT_COMPARABLE;
        cause = JOIN_NOT_COMPARABLE_CAUSE_V1.APPLIED_ROW_SHORT_CIRCUIT;
      } else {
        const adjudged = adjudicatePairV1(coreDecisionKey, storageLabel);
        if (adjudged === JOIN_UNADJUDICATED_V1) {
          unadjudicated.add(`${coreDecisionKey}  ->  ${storageLabel}`);
          // Recorded so the row still conserves, but the run is already failing:
          // `unadjudicated` is asserted empty.
          verdict = JOIN_VERDICT_V1.NO_MAPPING;
          cause = 'UNADJUDICATED-PAIR';
        } else {
          verdict = adjudged;
          cause = adjudged === JOIN_VERDICT_V1.NO_MAPPING ? 'no-groundable-image' : '';
        }
      }
    }

    const key = `${coreProjectionKey}>>${storageProjectionKey}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        coreProjectionKey,
        storageProjectionKey,
        cells: 1,
        bucket,
        verdict,
        cause,
        coreDecisionKey,
        coreLabel,
        storageLabel,
        coreReason: coreReasonOfV1(core),
        storageReason,
        staleRoute: coreDecisionKey === 'stale' ? staleRouteV1(cell) : '',
        namesSummary,
      });
    } else {
      existing.cells += 1;
      if (existing.verdict !== verdict || existing.storageLabel !== storageLabel) {
        // Two cells sharing BOTH projection keys presented identical inputs to
        // both evaluators, so a split verdict here would mean a projection key
        // stopped discriminating -- a defect in the keys, not a finding.
        throw new Error(
          `join pair ${key} carries two verdicts: ${existing.verdict} and ${verdict}`,
        );
      }
    }
  }

  return { rows: [...grouped.values()], unadjudicated: [...unadjudicated].sort() };
}
