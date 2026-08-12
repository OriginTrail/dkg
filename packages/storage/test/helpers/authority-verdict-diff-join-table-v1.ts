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
  'd396cb862bc3b091652db60568683f970d6ba6cbbbb1fb4a98107cf7159d32d8';

/**
 * THE FOUR-BUCKET PARTITION.
 *
 * `storageProjections` is pinned beside `cells` because they move
 * independently and the second is a cross-check on the first: every storage
 * projection covers EXACTLY 192 cells (min AND max, asserted upstream), so
 * 114/645/96 times 192 must reproduce these cell counts to the unit. A change
 * that moved cells without moving projections would be a projection key that
 * stopped discriminating; a change that moved projections without moving cells
 * would be the fixture growing. Neither can hide behind the other.
 */
export interface JoinBucketRowV1 {
  readonly cells: number;
  readonly storageProjections: number;
}

export const JOIN_PARTITION_V1: Readonly<Record<string, JoinBucketRowV1>> = {
  COMPARABLE: { cells: 21_888, storageProjections: 114 },
  'CORE-ONLY': { cells: 123_840, storageProjections: 645 },
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
 * checks the verified authority summary at :863, so which cells are drivable is
 * a property of the STORAGE side and is unaffected by anything core does to its
 * own constructibility rules. That was measured across the S1 retirement, not
 * assumed.
 */
export interface JoinCoreOnlySplitRowV1 {
  readonly cells: number;
  readonly coreSide: 'decided' | 'refused';
}

export const JOIN_CORE_ONLY_SPLIT_V1: Readonly<Record<string, JoinCoreOnlySplitRowV1>> = {
  'namesSummary=false': { cells: 61_920, coreSide: 'decided' },
  'namesSummary=true': { cells: 61_920, coreSide: 'decided' },
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
  'edc66a0acc2d10bbc30e0bea2df54620441dcc9b27426829239f8200d96cbb8b';

/**
 * THE HEADLINE, and the two numbers it carries are deliberately of different
 * kinds. DIVERGENCE counts CELLS where storage did something outside the image
 * its core decision requires. The semantics-changing count is over MAP ENTRIES,
 * because "core's quarantine is durable state and storage's defer is not" is ONE
 * fact about the systems -- multiplying it by the cells in its class would make
 * this headline describe the fixture's cardinality instead of the behaviour.
 */
export const JOIN_VERDICT_TOTALS_V1: Readonly<Record<string, number>> = {
  AGREEMENT: 4736,
  DIVERGENCE: 3136,
  'NO-MAPPING': 1920,
  'NOT-COMPARABLE': 154_368,
};

export const JOIN_SEMANTICS_CHANGING_ENTRIES_V1 = 4;
export const JOIN_ADJUDICATED_CELLS_V1 = 9792;

/**
 * NON-COMPARABILITY IS ALWAYS NAMED. An unnamed one is indistinguishable from a
 * case the harness dropped, and the largest of the three below is the finding
 * this whole join turns on rather than an exclusion.
 */
export const JOIN_NOT_COMPARABLE_CAUSE_TOTALS_V1: Readonly<Record<string, number>> = {
  'storage-requires-a-verified-authority-summary-this-head-cannot-mint': 123_840,
  'no-candidate-head-exists-because-the-system-forbids-the-input': 9216,
  'no-candidate-head-because-this-fixture-cannot-build-the-referent': 9216,
  'storage-answered-from-the-applied-row-without-reading-the-candidate': 12_096,
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
  'shortCircuit=false isNonActiveState=false': 9792,
  'shortCircuit=true isNonActiveState=true': 12_096,
};

/** Every adjudicated row, keyed `verdict coreDecisionKey -> storageLabel`. */
export const JOIN_LEVEL1_TABLE_V1: Readonly<Record<string, number>> = {
  'AGREEMENT accept -> ready': 1280,
  'AGREEMENT quarantine|head-fork -> deferred|authority-fork': 768,
  'AGREEMENT reject -> deferred|authority-fork': 576,
  'AGREEMENT reject -> stale': 576,
  'AGREEMENT stale -> already-applied': 256,
  'AGREEMENT stale -> ready': 512,
  'AGREEMENT stale -> stale': 768,
  'DIVERGENCE reject -> already-applied': 192,
  'DIVERGENCE reject -> ready': 2944,
  'NO-MAPPING quarantine|transition-equivocation -> already-applied': 128,
  'NO-MAPPING quarantine|transition-equivocation -> deferred|authority-fork': 384,
  'NO-MAPPING quarantine|transition-equivocation -> ready': 1024,
  'NO-MAPPING quarantine|transition-equivocation -> stale': 384,
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
    cells: 1280,
    members: { ready: 1280, 'already-applied': 0 },
  },
  stale: {
    cells: 1536,
    members: {
      stale: 768,
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
    cells: 1920,
    members: {},
  },
  reject: {
    cells: 4288,
    members: {
      stale: 576,
      'root-collision': 0,
      'deferred|non-active-state': 0,
      'deferred|authority-fork': 576,
      'deferred|authority-history-mismatch': 0,
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
 * Read it as one sentence: STORAGE MATERIALISES HEADS CORE REFUSES. Two thirds
 * of it is one cause -- core's future clock-skew gate against a storage
 * classifier that takes no clock at all.
 */
export const JOIN_DIVERGENCES_V1: Readonly<Record<string, number>> = {
  'reject|head issuedAt exceeds the future clock-skew bound -> ready': 1920,
  'reject|head issuedAt exceeds the future clock-skew bound -> already-applied': 192,
  'reject|absent state cannot retain authority history or quarantine -> ready': 512,
  'reject|current frontier fork requires its exact direct resolving successor -> ready': 384,
  'reject|cold noninitial head requires its verified authority closure -> ready': 128,
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
  '<none> :: <none>': 2816,
  'absent state cannot retain authority history or quarantine :: <none>': 512,
  'cold noninitial head requires its verified authority closure :: <none>': 128,
  'current frontier fork requires its exact direct resolving successor :: <none>': 384,
  'head issuedAt exceeds the future clock-skew bound :: <none>': 2688,
  'head issuedAt exceeds the future clock-skew bound :: authority-fork': 576,
  'head-fork :: authority-fork': 768,
  'transition-equivocation :: <none>': 1536,
  'transition-equivocation :: authority-fork': 384,
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
};

/**
 * STORAGE'S FULL LEVEL-1 CODOMAIN AND WHAT THE DIFF ACTUALLY REACHED.
 *
 * NINE OF FOURTEEN LABELS ARE ZERO, and they are pinned AS zero rather than
 * omitted. An omitted row and an unreachable row look identical in a pin, and
 * only one of them is a claim: a dispatch or codec change that starts producing
 * `root-collision` must turn this suite red rather than silently enlarging the
 * codomain the table claims to cover.
 */
export const JOIN_STORAGE_LABEL_REACH_V1: Readonly<Record<string, number>> = {
  ready: 5760,
  'already-applied': 576,
  stale: 1728,
  'root-collision': 0,
  'deferred|non-active-state': 12_096,
  'deferred|authority-fork': 1728,
  'deferred|authority-history-mismatch': 0,
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
    outcome: 'deferred|authority-history-mismatch',
    why: 'harness-never-builds',
    reason: 'Reached only by a candidate whose sequence relation is not `equal`, and every '
      + 'such shape is retired earlier as summary-unmintable: the chain is '
      + 'makeRotatedAuthorityChainV1(2) with the current head at its top, so a sequence-3 '
      + 'candidate needs a 2->3 transition that does not exist and the helper signature '
      + '(steps: 1 | 2) caps the depth. The core table records the same boundary.',
  },
  {
    side: 'storage',
    outcome: 'deferred|verified-state-mismatch',
    why: 'harness-never-builds',
    reason: 'The reuse branch\'s mismatch exit at :251. The present snapshot is built FROM '
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
    outcome: 'quarantine and accept at the fork-resolution successor branch (:483 and :485)',
    why: 'system-forbids',
    reason: 'Arithmetic, not observation, because nothing throws to announce it: :456 forces '
      + 'forkedVersion == current.version, the control codec forces resolutionVersion > '
      + 'forkedVersion, and :458 forces the candidate version > resolutionVersion. The '
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
    subject: "the throw at system-record-next-state-v1-internal.ts:241-243, 'equal system-record "
      + "head cannot exist in absent state'",
    citations: [
      'packages/storage/src/system-record-next-state-v1-internal.ts:1144',
      'packages/storage/src/system-record-next-state-v1-internal.ts:1092',
      'packages/storage/src/system-record-state-snapshot-v1-internal.ts:76',
    ],
    proof: "materialization 'reuse' is PRODUCED at exactly one site, :1144 (the literal occurs "
      + 'three times in that file: :240 the consumer test, :1083 the type union, :1144 the '
      + "production; the control is five 'rematerialize' hits, so the instrument finds "
      + 'things). :1092 returns advance{rematerialize} for an ABSENT snapshot before `const '
      + 'current = snapshot.appliedState` at :1095, so :1144 is reachable only on a '
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
    observed: 'EXACT. AGREEMENT 4,736 -> 3,968 and DIVERGENCE 3,136 -> 3,904, with '
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
      + 'mutates one arm -- the tombstone path\'s own gate at :956-960 -- and nothing else.',
    prediction: 'the discrimination table gains a third key, `shortCircuit=false '
      + 'isNonActiveState=true: 576`, and the short-circuit count falls 12,096 -> 11,520.',
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
  'STORAGE DECIDES 12,096 OF THE 21,888 COMPARABLE CELLS -- 55% -- WITHOUT READING THE '
  + 'CANDIDATE AT ALL. `classifyAuthorityAdvance` returns deferred(non-active-state) from the '
  + 'APPLIED ROW STATUS at :1108/:1111/:1114, before the candidate is first read at :1116, and '
  + 'the tombstone path has its own such gate at :956-960. Core has no field to put an applied '
  + 'status in, so on those cells the two sides are not disagreeing about the candidate -- they '
  + 'are answering different questions. Calling that DIVERGENCE would have manufactured 12,096 '
  + 'of them, which is more than three times the real divergence count and would have buried it.',

  // The actionable one. Every cell of it is a DIVERGENCE.
  'STORAGE MATERIALISES HEADS CORE REFUSES: 3,136 cells, every one a DIVERGENCE, all of them a '
  + 'core `reject` paired with a storage outcome that ADMITS the candidate (2,944 `ready`, 192 '
  + '`already-applied`). Two thirds -- 2,112 -- are core\'s future clock-skew gate at :98-103 '
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
  + 'images. Storage answers from axis B (applied status) at :1113 before reading the candidate; '
  + 'core answers from axis I (accepted disposition) at :139-141 before reading the candidate\'s '
  + 'sequence or version. Neither field exists on the other side. They are recorded differently '
  + 'ON PURPOSE: core\'s is CONSTANT across its whole mapping class, so it belongs to the MAP as '
  + 'the one entry that can ground no image; storage\'s varies cell by cell with axis B, so it '
  + 'belongs to the CELL as a named non-comparability. A fact constant across a mapping class '
  + 'that is stored per cell multiplies one semantic difference by the fixture\'s cardinality.',

  // The trap this table was built to avoid, recorded so the next reader does
  // not re-introduce it.
  'MAPPING CORE `stale` TO STORAGE {stale} ALONE FABRICATES 768 DIVERGENCES. Core has two stale '
  + 'sub-causes: the LOWER-VERSION candidate at :196, which storage also calls `stale` at :1134, '
  + 'and the IDENTICAL head at :199, which storage calls `advance` and surfaces as '
  + '`already-applied` (256 cells) or -- when :1144 selects rematerialize rather than reuse -- as '
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
  + '123,840-cell CORE-ONLY bucket rests on a bind-check in the code at :863, not on chain depth, '
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
  + 'THE OTHER DOES NOT HAVE -- and these are its two join-side populations. 12,096 cells are '
  + 'storage answering from the APPLIED ROW at :1108/:1111/:1114, before the candidate is read '
  + 'at :1116, on an axis CORE has no field for. 1,920 cells are core deciding '
  + '`quarantine|transition-equivocation` from `disposition` at :139-141, on an axis STORAGE '
  + 'has no producer for. TOTAL 14,016 -- THE SAME PHENOMENON IN OPPOSITE DIRECTIONS. Both are '
  + 'CORRECT cell-level exclusions and neither is reclassified: the 12,096 stay a named '
  + 'non-comparability on the CELL, the 1,920 stay the MAP\'s one no-image entry, and nothing '
  + 'in the conservation moves. TOGETHER THEY ARE ONE ARCHITECTURAL FINDING, and it was '
  + 'invisible precisely BECAUSE it was found twice, from opposite ends, and filed as an '
  + 'ABSENCE both times -- two correct exclusions in two registers do not add up to a finding '
  + 'until someone writes the finding down. THE `disposition` PROBE, WITH ITS INSTRUMENT '
  + 'NAMED: 15 occurrences across 14 lines, all in '
  + 'packages/core/src/system-record-authority-v1-internal.ts, against 0 anywhere in '
  + 'packages/storage/src. The two figures are ONE measurement read by TWO instruments -- '
  + 'matching LINES against matching OCCURRENCES -- and the entire difference is :643, where '
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
  'AXIS B IS NON-DISCRIMINATING ON THE TOMBSTONE DISPATCH PATH, SO 1,152 ADJUDICATED '
  + 'CELLS ARE BEHAVIOURAL DUPLICATES. classifyTombstoneAdvance reads current.status '
  + 'EXACTLY ONCE, at :956, and only against \'quarantined\'; a dirty or tombstone row with '
  + 'no conflict state passes straight through. POSITIVE CONTROL on the ACTIVE classifier '
  + '(:1087-1164) with the same instrument: THREE reads including a current.status !== '
  + '\'active\' test, which is why axis B does real work there and produces the 12,096 '
  + 'applied-row short-circuit. MEASURED CONSEQUENCE: under H=tombstone, B=active, B=dirty '
  + 'and B=tombstone each split 256 AGREEMENT / 192 DIVERGENCE / 128 NO-MAPPING -- IDENTICAL '
  + 'in every verdict class, which is the empirical confirmation of the source reading; three '
  + 'independent classes agreeing exactly is not what coincidence produces. So of the 576 '
  + 'divergence cells in this region there are only 192 DISTINCT divergent situations, and '
  + '384 of the 3,136 reported divergences are the same situations recounted under two axis-B '
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
