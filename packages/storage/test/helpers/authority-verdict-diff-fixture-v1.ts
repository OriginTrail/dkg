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
  'head-fork': { sites: [189, 200, 416] },
  'transition-equivocation': { sites: [140, 172, 384, 483, 508, 564, 567] },
} as const;

/**
 * Core: `reject.reason` is an OPEN `string` -- a diagnostic that happens to
 * encode which branch fired. It is pinned as an observation with provenance:
 * the literal (the only thing a caller can observe) plus the site(s) that
 * produce it.
 *
 * Harvested from packages/core/src/system-record-authority-v1-internal.ts:
 * 27 distinct literals across 32 sites.
 *
 * AN UNMAPPED OBSERVED LITERAL IS A FAILURE, not a skip: it means a reject was
 * added or reworded, and the map says which case to look at.
 */
export const CORE_REJECT_REASON_SITES_V1: Readonly<Record<string, readonly number[]>> = {
  'absent state cannot retain authority history or quarantine': [220, 535],
  'accepted authority state has incomplete transition lineage': [124, 546],
  'accepted head does not bind its retained transition lineage': [133],
  'active closure contains tombstone-only authority evidence': [268],
  'authority history is incomplete': [152],
  'authority transition reuses a root retained by this record': [365, 581],
  'cold noninitial head requires its verified authority closure': [237],
  'cold tombstone closure lacks its exact deletion predecessor': [259],
  'current frontier fork requires its exact direct resolving successor': [462],
  'exact accepted authority transition is missing': [344],
  'fork resolution issuedAt exceeds the future clock-skew bound': [468],
  'head issuedAt exceeds the future clock-skew bound': [101],
  'historical or unsolicited fork resolution is audit-only': [439],
  'late tombstone lacks its exact verified active predecessor': [292],
  'late tombstone requires the exact retained resurrection transition': [309],
  'next-sequence head does not bind transition issuer/root': [374],
  'next-sequence tombstone requires its exact same-sequence active predecessor': [350],
  'same-sequence authority changed': [168],
  'stable record key changed': [137, 553],
  'tombstone is terminal within its authority sequence': [193],
  'tombstone lacks its exact verified active predecessor': [411],
  'transition has no accepted predecessor': [540],
  'transition verification time is invalid': [522],
  'transitions do not target the same authority tuple': [502],
  'unresolved head fork cannot advance authority sequence': [329, 572],
  'verification clock is invalid': [97],
  'verified authority closure has incomplete lineage': [247],
};

/**
 * THE FIVE OBSERVATIONALLY AMBIGUOUS LITERALS -- a Phase 1 FINDING, not a
 * harness limitation.
 *
 * `{ decision: 'reject', reason: string }` carries no origin, so the producing
 * site is not recoverable from the decision object. For these five the
 * literal->site map is one-to-many, which means core has branches that are
 * indistinguishable to ANY caller, this diff included.
 *
 * BEARS ON PHASE 3: if routing the live path through core must preserve
 * behaviour, it cannot preserve a distinction no observer can make.
 *
 * Closing the reject union would dissolve this. It is a recorded candidate for
 * Phase 3 or later and deliberately NOT done here -- it would change the thing
 * being measured in the middle of measuring it.
 */
export const CORE_AMBIGUOUS_REJECT_LITERALS_V1 = Object.freeze(
  Object.keys(CORE_REJECT_REASON_SITES_V1).filter(
    (literal) => (CORE_REJECT_REASON_SITES_V1[literal] ?? []).length > 1,
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
  G_acceptedTransitionDigest: ['equal', 'differ'],
  H_storageOperation: ['active', 'tombstone', 'quarantine'],
  I_coreDisposition: [
    'discoverable',
    'head-fork-quarantined',
    'transition-equivocation-quarantined',
  ],
  J_evidencePresence: [
    'acceptedTransition',
    'tombstonePredecessor',
    'forkResolution',
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
