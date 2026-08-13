/**
 * Phase 1 of the reconciliation slice: fixture data for the exhaustive
 * verdict-diff between core's `evaluateAgentProfileHeadAdvanceV1` and the live
 * storage path.
 *
 * THIS FILE IS DATA, NOT A REPORT. The verdict table is the test's fixture:
 * every constructible cell's verdict pair is committed here and any movement on
 * either side turns the suite red. A harness that walked the input space and
 * printed pairs would assert nothing and stay green forever.
 *
 * The two evaluators share neither inputs nor verdict codomain, and this file
 * deliberately does NOT normalise them into a common enum -- where no total
 * mapping exists, the absence is the finding and is recorded as one.
 */

/** Core: `{ decision: 'accept' | 'stale' }` carry no reason; the key is bare. */
export const CORE_BARE_DECISIONS_V1 = ['accept', 'stale'] as const;

/**
 * Core: `quarantine.reason` is a CLOSED union and part of the contract -- the
 * value IS the meaning. Site counts are informational only; a value appearing
 * at several sites is not ambiguity, because the value itself is what any
 * caller acts on.
 */
export const CORE_QUARANTINE_REASONS_V1 = {
  'head-fork': { sites: [280, 291, 679] },
  'transition-equivocation': { sites: [231, 263, 647, 746, 771, 827, 830] },
} as const;

/**
 * Core: `reject.reason` is an OPEN `string` -- a diagnostic that happens to
 * encode which branch fired. It is pinned as an observation with provenance:
 * the literal (the only thing a caller can observe) plus the site(s) that
 * produce it.
 *
 * Harvested from packages/core/src/system-record-authority-v1-internal.ts:
 * 28 distinct literals across 33 sites.
 *
 * AN UNMAPPED OBSERVED LITERAL IS A FAILURE, not a skip: it means a reject was
 * added or reworded, and the map says which case to look at.
 *
 * EVERY SITE BELOW :316 MOVED BY +47 WHEN THE LATE-TOMBSTONE ENTRY WAS ADDED,
 * and that is this pin working rather than a maintenance tax. The entry itself
 * is 47 lines of function and docblock inserted after the lower-sequence arm, so
 * twelve citations shifted together and the twenty-eighth literal appeared at
 * :354. A file-contains pin would have stayed green through all of it; only a
 * line-anchored one says which sites moved and by how much.
 */
export const CORE_REJECT_REASON_SITES_V1: Readonly<Record<string, readonly number[]>> = {
  'absent state cannot retain authority history or quarantine': [311, 798],
  'accepted authority state has incomplete transition lineage': [215, 809],
  'accepted head does not bind its retained transition lineage': [224],
  'active closure contains tombstone-only authority evidence': [359],
  'authority history is incomplete': [243],
  'authority transition reuses a root retained by this record': [628, 844],
  'cold noninitial head requires its verified authority closure': [328],
  'cold tombstone closure lacks its exact deletion predecessor': [350],
  'current frontier fork requires its exact direct resolving successor': [725],
  'exact accepted authority transition is missing': [607],
  'fork resolution issuedAt exceeds the future clock-skew bound': [731],
  'head issuedAt exceeds the future clock-skew bound': [179],
  'historical or unsolicited fork resolution is audit-only': [702],
  'late tombstone entry requires a candidate below the accepted authority sequence': [569],
  'late tombstone entry requires a tombstone candidate': [560],
  'late tombstone lacks its exact verified active predecessor': [406],
  'late tombstone requires the exact retained resurrection transition': [424],
  'next-sequence head does not bind transition issuer/root': [637],
  'next-sequence tombstone requires its exact same-sequence active predecessor': [613],
  'same-sequence authority changed': [259],
  'stable record key changed': [228, 816],
  'tombstone is terminal within its authority sequence': [284],
  'tombstone lacks its exact verified active predecessor': [674],
  'transition has no accepted predecessor': [803],
  'transition verification time is invalid': [785],
  'transitions do not target the same authority tuple': [765],
  'unresolved head fork cannot advance authority sequence': [592, 835],
  'verification clock is invalid': [174],
  'verified authority closure has incomplete lineage': [338],
};

/**
 * THE DELEGATED HALF OF CORE'S REJECT CODOMAIN -- and the reason the harvest
 * above is not the whole of it.
 *
 * `evaluateAgentProfileHeadAdvanceV1` delegates to `evaluateAuthorityTransitionV1`
 * at :353 and returns its decision VERBATIM at :358. Those rejects are minted in
 * a DIFFERENT FILE and carry no marker of their origin, so a caller observing
 * `{ decision: 'reject', reason }` cannot tell which file produced it.
 *
 * The map above was harvested from system-record-authority-v1-internal.ts alone
 * and its docstring says an unmapped observed literal is a FAILURE. The sweep
 * observed 'transition does not bind the accepted predecessor' on its first real
 * run and it was unmapped -- the pin fired, correctly, on a real gap. The lesson
 * is the scoping one: "27 literals across 32 sites" was a property of the FILE
 * measured, stated as though it were a property of core.
 *
 * Harvested from packages/core/src/system-record-authority-verification-v1-internal.ts.
 */
export const CORE_DELEGATED_REJECT_REASON_SITES_V1: Readonly<Record<string, readonly number[]>> = {
  'verification clock is invalid': [69],
  'transition issuedAt exceeds the future clock-skew bound': [73],
  'transition does not bind the accepted predecessor': [79],
  'expired-prior transition cannot resurrect a tombstone': [86],
  'expired-prior transition does not bind prior validity': [92],
  'prior authority has not passed the expiry skew': [101],
};

/** Every reject literal a caller can observe from the exported entry. */
export const CORE_ALL_REJECT_LITERALS_V1: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.keys(CORE_REJECT_REASON_SITES_V1),
    ...Object.keys(CORE_DELEGATED_REJECT_REASON_SITES_V1),
  ]),
]);

/**
 * THE SIX OBSERVATIONALLY AMBIGUOUS LITERALS -- a Phase 1 FINDING, not a
 * harness limitation.
 *
 * `{ decision: 'reject', reason: string }` carries no origin, so the producing
 * site is not recoverable from the decision object. For these six the
 * literal->site map is one-to-many, which means core has branches that are
 * indistinguishable to ANY caller, this diff included.
 *
 * BEARS ON PHASE 3: if routing the live path through core must preserve
 * behaviour, it cannot preserve a distinction no observer can make.
 *
 * THE COUNT IS SCOPED TO THE OBSERVABLE CODOMAIN, NOT TO ONE FILE, AND THE
 * FIRST VERSION OF IT WAS NOT. It filtered the PRIMARY map alone and reported
 * FIVE. Delegated rejects escape verbatim through the same decision object, so
 * a literal produced ONCE IN EACH FILE is one-to-many to a caller while being
 * one-to-one in either map on its own. Exactly one literal has that shape --
 * 'verification clock is invalid', at authority :97 and authority-verification
 * :30 -- and it was missed, so the finding said five when a caller sees six.
 *
 * THE CLASS, NOT THE INSTANCE: CORE_ALL_REJECT_LITERALS_V1 twenty lines above
 * ALREADY unions both maps. The delegation sweep was applied to that consumer
 * and not to this one, though both derive from the same two maps -- so the
 * defect was the sweep's discriminator being scoped to a file, not a missing
 * measurement. Any future constant derived from these maps is quantified over
 * the merged pair, and the harvest suite pins that as a mechanism rather than
 * as this literal's name.
 *
 * Closing the reject union would dissolve this. It is a recorded candidate for
 * Phase 3 or later and deliberately NOT done here -- it would change the thing
 * being measured in the middle of measuring it.
 */
export const CORE_AMBIGUOUS_REJECT_LITERALS_V1 = Object.freeze(
  CORE_ALL_REJECT_LITERALS_V1.filter(
    (literal) => (CORE_REJECT_REASON_SITES_V1[literal] ?? []).length
      + (CORE_DELEGATED_REJECT_REASON_SITES_V1[literal] ?? []).length > 1,
  ),
);

/**
 * The twelve axes the case generator drives, from the Phase 1 spec. The diff is
 * driven from the INPUT SPACE, never from reading the two implementations for
 * differences that catch the eye.
 *
 * Axes I, J and L are grounded in core's declared input shapes
 * (`AgentProfileAcceptedAuthorityStateV1` :63, `AgentProfileHeadAdvanceEvidenceV1` :76).
 */
export const VERDICT_DIFF_AXES_V1 = {
  A_snapshot: ['absent', 'present'],
  B_appliedStatus: ['active', 'quarantined', 'tombstone', 'dirty'],
  C_candidateHeadState: ['active', 'tombstone'],
  D_sequenceRelation: ['below', 'equal', 'plusOne', 'abovePlusOne'],
  E_versionRelation: ['below', 'equal', 'above'],
  F_headDigest: ['equal', 'differ'],
  /**
   * AXIS G IS SEQUENCE-RELATIVE, and this is the axis's denotation rather than a
   * note about one builder. 'equal' means the candidate names the ACCEPTED
   * rotation into ITS OWN authority sequence; 'differ' means it names a
   * COMPETING rotation into that same sequence.
   *
   * THE OLDER READING IS THE SPECIAL CASE, NOT A RIVAL. Until axis D gained
   * per-sequence lineage every candidate sat at the current sequence, where the
   * accepted rotation IS the current head's -- so "compared to the current
   * head's acceptedTransitionDigest" and the rule above are the same statement
   * in that column, and the core-heads suite asserts the D='equal' column still
   * lands on exactly the two constants it always did.
   *
   * WHY THE GENERAL FORM IS THE RIGHT ONE, ruled 2026-08-12 on three grounds.
   * The decisive one is that the SYSTEM responds to it: at the sequence-relative
   * shapes G='differ' fires '[system-record-closure] verification closure
   * contains authority-transition equivocation', so the outcome moves on the
   * axis, which is what makes an axis live -- 6 of the 40 buildable head shapes
   * refuse that way in CORE_SUMMARY_MINT_OUTCOMES_V1. Second, equivocation is
   * DEFINED at the source as two transitions out of the same prior head into the
   * same sequence, so the notion is sequence-relative where it is specified, not
   * where this fixture reads it. Third, and decisive against the literal
   * reading: taken literally, a G='equal' candidate off D='equal' would have to
   * name a rotation into somewhere other than its own sequence -- a head this
   * fixture authored to be malformed, refusing in the system's wording. That is
   * exactly the manufactured-retirement class this slice exists to remove, so
   * the literal reading would re-create it by definition.
   */
  G_acceptedTransitionDigest: ['equal', 'differ'],
  H_storageOperation: ['active', 'tombstone', 'quarantine'],
  I_coreDisposition: [
    'discoverable',
    'head-fork-quarantined',
    'transition-equivocation-quarantined',
  ],
  /**
   * EVERY optional member of `AgentProfileHeadAdvanceEvidenceV1`, not a chosen
   * subset -- and pinned against core's source by the harvest test, because this
   * axis was wrong and the prose above did not catch it.
   *
   * It originally listed four of the six, omitting `verifiedAuthoritySummary`
   * and `forkEvidenceHeads`, which made the generated space a QUARTER of the
   * declared input space while the file claimed to be grounded in the contract.
   * Both omitted members change decisions: absent `verifiedAuthoritySummary`
   * rejects at :237 where a bound one can reach accept at :271, and an absent
   * `forkEvidenceHeads` is a disjunct of the OR at :452 rejecting at :462 where
   * valid conflicts continue to quarantine at :483 or accept at :485.
   *
   * A table pinning every constructible cell over an axis that under-spans its
   * own contract is the failure this harness exists to refuse: the coverage
   * claim stays green while covering less than it says.
   */
  J_evidencePresence: [
    'acceptedTransition',
    'tombstonePredecessor',
    'verifiedAuthoritySummary',
    'forkResolution',
    'forkEvidenceHeads',
    'forkBaseHead',
  ],
  K_candidateForkResolutionDigest: ['present', 'absent'],
  L_clock: ['valid', 'beyondFutureSkew', 'priorExpirySkewUnmet'],
} as const;

/**
 * Storage's OBSERVABLE codomain, which differs from its DECLARED one -- a Phase 1
 * finding that corrects the spec.
 *
 * `advance` + its `reuse | rematerialize` discriminator NEVER escapes the
 * exported entry: at next-state-v1-internal.ts:202 every non-advance verdict
 * returns verbatim, but `advance` continues into the derivation and surfaces as
 * `ready` or `already-applied` with the materialization folded in.
 *
 * PHASE 3 REQUIREMENT (stated as a requirement, not an observation, so it gets
 * checked rather than nodded at): core's `accept` maps ONE-TO-MANY onto these
 * outcomes and core has no materialization notion at all, so **Phase 3 must name
 * the component that decides reuse-vs-rematerialize before routing begins.**
 */
export const STORAGE_OBSERVABLE_OUTCOMES_V1 = [
  'ready',
  'already-applied',
  'stale',
  'deferred',
  'root-collision',
  'capacity-exhausted',
] as const;

/** Storage: two DISJOINT reason unions attaching to different outcomes. */
export const STORAGE_DEFERRED_REASONS_V1 = [
  'non-active-state',
  'authority-fork',
  'authority-history-mismatch',
  'verified-state-mismatch',
  'root-state-changed',
] as const;

/**
 * No core analogue BY CONSTRUCTION -- core returns no capacity verdict in any
 * branch -- so these pin as NO-MAPPING statically, without axis enumeration.
 */
export const STORAGE_CAPACITY_REASONS_V1 = [
  'state-revision-overflow',
  'capacity-revision-overflow',
  'record-count-cap',
  'aggregate-cap',
  'subject-union-cap',
] as const;

export type VerdictDiffVerdictV1 = 'DIVERGENCE' | 'AGREEMENT' | 'NO-MAPPING';
