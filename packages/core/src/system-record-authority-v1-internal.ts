import {
  hasOwnDataProperty,
  snapshotDataArray,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';
import { parseCanonicalDecimalU64, type Digest32V1 } from './sync-wire-scalars.js';
import { failSystemRecordObjectV1 as fail } from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_MAX_ROOT_CLAIMS,
} from './system-record-limits-v1.js';

import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  validateAuthorityTransition,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
} from './system-record-agent-profile-control-codecs-v1-internal.js';
import {
  computeAgentProfileHeadObjectDigestV1,
  validateAgentProfileHeadObjectV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileTombstoneHeadObjectV1,
} from './system-record-agent-profile-head-codec-v1-internal.js';
import {
  assertAgentRootV1,
  digest,
  snapshotSystemRecordDataRecord,
  u64,
} from './system-record-agent-profile-primitives-v1-internal.js';
import {
  isAgentProfileVerifiedAuthoritySummaryV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
} from './system-record-verification-closure-v1-internal.js';
import type {
  AgentProfileAppliedTransitionV1,
  SystemRecordAuthorityDecisionV1,
} from './system-record-authority-types-v1-internal.js';
import {
  assertAgentProfileForkResolutionEvidenceV1,
  evaluateAuthorityTransitionV1,
  isAgentProfileHeadBoundToAcceptedTransitionV1,
  isDirectResolvingSuccessorV1,
  isIssuedTooFarInFuture,
  isAuthorityTransitionBoundToPriorHeadV1,
  isSafeNow,
  isTombstoneBoundToPredecessorV1,
  validateAgentProfileForkResolutionEvidenceV1,
} from './system-record-authority-verification-v1-internal.js';

export type { SystemRecordAuthorityDecisionV1 } from './system-record-authority-types-v1-internal.js';
export {
  assertAgentProfileForkResolutionEvidenceV1,
  evaluateAuthorityTransitionV1,
  isAgentProfileHeadBoundToAcceptedTransitionV1,
  isAuthorityTransitionBoundToPriorHeadV1,
  isDirectResolvingSuccessorV1,
  isIssuedTooFarInFuture,
  isSafeNow,
  isTombstoneBoundToPredecessorV1,
} from './system-record-authority-verification-v1-internal.js';

export interface AgentProfileAcceptedAuthorityStateV1 {
  readonly current?: AgentProfileHeadObjectV1;
  readonly disposition:
    | 'discoverable'
    | 'head-fork-quarantined'
    | 'transition-equivocation-quarantined';
  readonly transitionLineage: readonly AgentProfileAppliedTransitionV1[];
  /** Duplicate-free prior roots in authority-sequence order; current root is excluded. */
  readonly historicalRoots: readonly string[];
  /** Bounded local diagnostics only; never an authority-completeness predicate. */
  readonly frontierConflictHeads?: readonly AgentProfileHeadObjectV1[];
}

export interface AgentProfileHeadAdvanceEvidenceV1 {
  readonly nowMs: number;
  /** Exact transition into a next-sequence candidate or out of a late tombstone sequence. */
  readonly acceptedTransition?: AgentProfileAuthorityTransitionV1;
  readonly tombstonePredecessor?: AgentProfileActiveHeadObjectV1;
  /** Opaque proof minted only by buildAgentProfileVerificationClosureV1. */
  readonly verifiedAuthoritySummary?: AgentProfileVerifiedAuthoritySummaryV1;
  readonly forkResolution?: AgentProfileForkResolutionV1;
  readonly forkEvidenceHeads?: readonly AgentProfileHeadObjectV1[];
  readonly forkBaseHead?: AgentProfileHeadObjectV1;
}

/**
 * The retained transition out of a late tombstone's sequence, WITH the clock
 * that verifies it.
 *
 * They are one field because neither is meaningful alone on this path: the
 * transition is only ever checked by a clocked verifier, and a clock with no
 * transition is a value nothing reads. Pairing them makes "a binding transition
 * plus an unusable clock" -- the shape that inverted a `stale` into an `accept`
 * -- unrepresentable rather than merely refused.
 */
export interface AgentProfileLateTombstoneRetainedTransitionV1 {
  readonly transition: AgentProfileAuthorityTransitionV1;
  readonly nowMs: number;
}

/**
 * Exactly the operands the ADR 0002 :129-133 rule reads, and nothing else.
 *
 * Deliberately NOT {@link AgentProfileHeadAdvanceEvidenceV1}: that shape carries
 * fork resolutions, evidence heads, a summary and a mandatory clock, none of
 * which this rule consults, and a caller forced to fill a required `nowMs` it
 * does not have will invent one.
 */
export interface AgentProfileLateTombstoneEvidenceV1 {
  readonly tombstonePredecessor?: AgentProfileActiveHeadObjectV1;
  readonly retainedTransition?: AgentProfileLateTombstoneRetainedTransitionV1;
}

/**
 * What the ADR 0002 :129-133 rule can decide, and nothing wider.
 *
 * The rule admits the tombstone, finds it superseded, or refuses -- it has no
 * quarantine to reach, because quarantine is a frontier/equivocation outcome
 * decided before this arm is ever dispatched to. Narrowing the RESULT rather
 * than returning the full authority union is what keeps a caller from having to
 * write an arm for a state this rule cannot produce: an unreachable arm is a
 * mapping decision made in advance and silently, and this one would have folded
 * a NEW durable authority state into "incomplete evidence" while compiling
 * cleanly. If quarantine ever becomes reachable here, widening this type is the
 * deliberate, compile-visible step that makes every caller answer for it.
 */
export type AgentProfileLateTombstoneDecisionV1 = Extract<
  SystemRecordAuthorityDecisionV1,
  { readonly decision: 'accept' | 'stale' | 'reject' }
>;

function snapshotLateTombstoneEvidenceV1(
  value: unknown,
): AgentProfileLateTombstoneEvidenceV1 {
  const probe = snapshotSystemRecordDataRecord(value, 'late tombstone evidence');
  const optionals = ['tombstonePredecessor', 'retainedTransition'].filter(
    (key) => hasOwnDataProperty(probe, key),
  );
  const evidence = snapshotExactDataRecord(probe, optionals, 'late tombstone evidence');
  const retained = evidence.retainedTransition === undefined
    ? undefined
    : snapshotExactDataRecord(
      evidence.retainedTransition,
      ['transition', 'nowMs'],
      'late tombstone retained transition',
    );
  return Object.freeze({
    ...evidence,
    ...(retained === undefined ? {} : { retainedTransition: Object.freeze({ ...retained }) }),
  }) as unknown as AgentProfileLateTombstoneEvidenceV1;
}

/**
 * The clock preflight both public entries owe, in ONE place.
 *
 * It was inline at each, which put two reason literals at two sites apiece and
 * pushed a literal into the observationally-ambiguous register purely as
 * bookkeeping. A boundary rule whose reason strings are externally harvested
 * should have one producer per literal, or a reword has to be applied in as many
 * places as it is written and the harvest cannot say which branch fired.
 *
 * Returns `undefined` when the clock is usable, so a caller reads it as a
 * refusal-or-continue rather than a boolean it has to remember the polarity of.
 */
function rejectInvalidHeadClockV1(
  candidateState: AgentProfileHeadObjectV1,
  nowMs: number,
): Extract<SystemRecordAuthorityDecisionV1, { readonly decision: 'reject' }> | undefined {
  if (!isSafeNow(nowMs)) {
    return { decision: 'reject', reason: 'verification clock is invalid' };
  }
  if (isIssuedTooFarInFuture(candidateState.issuedAt, nowMs)) {
    return {
      decision: 'reject',
      reason: 'head issuedAt exceeds the future clock-skew bound',
    };
  }
  return undefined;
}

export function evaluateAgentProfileHeadAdvanceV1(
  accepted: AgentProfileAcceptedAuthorityStateV1,
  candidate: AgentProfileHeadObjectV1,
  evidence: AgentProfileHeadAdvanceEvidenceV1,
): SystemRecordAuthorityDecisionV1 {
  const candidateState = validateAgentProfileHeadObjectV1(candidate);
  const acceptedState = snapshotAcceptedAuthorityStateV1(accepted);
  const evidenceState = snapshotHeadAdvanceEvidenceV1(evidence);
  const clockRefusal = rejectInvalidHeadClockV1(candidateState, evidenceState.nowMs);
  if (clockRefusal !== undefined) return clockRefusal;
  const lineage = validateAppliedTransitionLineage(acceptedState.transitionLineage);
  const current =
    acceptedState.current === undefined
      ? undefined
      : validateAgentProfileHeadObjectV1(acceptedState.current);
  const historicalRoots = validateAcceptedRootHistoryV1(acceptedState, current, lineage);
  const candidateDigest = computeAgentProfileHeadObjectDigestV1(candidateState);
  if (current === undefined) {
    return evaluateAbsentAgentProfileHeadAdvanceV1(
      acceptedState,
      candidateState,
      evidenceState,
      lineage,
      candidateDigest,
    );
  }
  const currentSequence = parseCanonicalDecimalU64(current.authoritySequence);
  if (BigInt(lineage.length) !== currentSequence) {
    return {
      decision: 'reject',
      reason: 'accepted authority state has incomplete transition lineage',
    };
  }
  if (
    currentSequence > 0n &&
    lineage[lineage.length - 1]?.transitionDigest !== current.acceptedTransitionDigest
  ) {
    return {
      decision: 'reject',
      reason: 'accepted head does not bind its retained transition lineage',
    };
  }
  if (current.networkId !== candidateState.networkId || current.peerId !== candidateState.peerId) {
    return { decision: 'reject', reason: 'stable record key changed' };
  }
  if (acceptedState.disposition === 'transition-equivocation-quarantined') {
    return { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  const candidateSequence = parseCanonicalDecimalU64(candidateState.authoritySequence);
  if (candidateSequence < currentSequence) {
    return evaluateLowerSequenceAgentProfileHeadAdvanceV1(
      candidateState,
      evidenceState,
      lineage,
      candidateSequence,
    );
  }
  if (candidateSequence > currentSequence + 1n) {
    return { decision: 'reject', reason: 'authority history is incomplete' };
  }
  if (candidateSequence === currentSequence + 1n) {
    return evaluateNextSequenceAgentProfileHeadAdvanceV1(
      acceptedState,
      current,
      candidateState,
      evidenceState,
      lineage,
      historicalRoots,
    );
  }
  if (
    candidateState.evmIssuer !== current.evmIssuer ||
    candidateState.rootSubject !== current.rootSubject
  ) {
    return { decision: 'reject', reason: 'same-sequence authority changed' };
  }
  const currentDigest = computeAgentProfileHeadObjectDigestV1(current);
  if (candidateState.acceptedTransitionDigest !== current.acceptedTransitionDigest) {
    return { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  const currentVersion = parseCanonicalDecimalU64(current.version);
  const candidateVersion = parseCanonicalDecimalU64(candidateState.version);
  if (candidateState.state === 'tombstone') {
    return evaluateSameSequenceTombstoneAdvanceV1(
      current,
      candidateState,
      evidenceState,
      currentVersion,
      candidateVersion,
      currentDigest,
      candidateDigest,
    );
  }
  if (current.state === 'tombstone') {
    if (candidateVersion === currentVersion) {
      return { decision: 'quarantine', reason: 'head-fork' };
    }
    return {
      decision: 'reject',
      reason: 'tombstone is terminal within its authority sequence',
    };
  }
  if (candidateVersion < currentVersion) return { decision: 'stale' };
  if (candidateVersion === currentVersion) {
    return candidateDigest === currentDigest
      ? { decision: 'stale' }
      : { decision: 'quarantine', reason: 'head-fork' };
  }
  return evaluateSameSequenceActiveAdvanceV1(
    acceptedState,
    current,
    candidateState,
    evidenceState,
  );
}

function evaluateAbsentAgentProfileHeadAdvanceV1(
  acceptedState: AgentProfileAcceptedAuthorityStateV1,
  candidateState: AgentProfileHeadObjectV1,
  evidenceState: AgentProfileHeadAdvanceEvidenceV1,
  lineage: readonly AgentProfileAppliedTransitionV1[],
  candidateDigest: Digest32V1,
): SystemRecordAuthorityDecisionV1 {
  if (acceptedState.disposition !== 'discoverable' || lineage.length !== 0) {
    return {
      decision: 'reject',
      reason: 'absent state cannot retain authority history or quarantine',
    };
  }
  if (
    candidateState.state === 'active' &&
    candidateState.authoritySequence === '0' &&
    candidateState.version === '0'
  ) {
    return { decision: 'accept' };
  }
  const summary = evidenceState.verifiedAuthoritySummary;
  if (
    !isAgentProfileVerifiedAuthoritySummaryV1(summary) ||
    summary.candidateHeadDigest !== candidateDigest
  ) {
    return {
      decision: 'reject',
      reason: 'cold noninitial head requires its verified authority closure',
    };
  }
  const summaryLineage = validateAppliedTransitionLineage(summary.transitionLineage);
  if (
    BigInt(summaryLineage.length) !== parseCanonicalDecimalU64(candidateState.authoritySequence) ||
    summary.historicalRoots.length !== summaryLineage.length
  ) {
    return {
      decision: 'reject',
      reason: 'verified authority closure has incomplete lineage',
    };
  }
  if (candidateState.state === 'tombstone') {
    const predecessor = summary.tombstonePredecessor;
    if (
      predecessor === undefined ||
      !isTombstoneBoundToPredecessorV1(candidateState, predecessor) ||
      summary.deletionTableDigest !== predecessor.ownedSubjectTableDigest
    ) {
      return {
        decision: 'reject',
        reason: 'cold tombstone closure lacks its exact deletion predecessor',
      };
    }
  } else if (
    summary.tombstonePredecessor !== undefined ||
    summary.deletionTableDigest !== undefined
  ) {
    return {
      decision: 'reject',
      reason: 'active closure contains tombstone-only authority evidence',
    };
  }
  return { decision: 'accept' };
}

/**
 * THE RULE ITSELF, over exactly its own operands.
 *
 * Both entries call this, so there is ONE implementation and no sentinel
 * anywhere: the full evaluator adapts its wider evidence object into these
 * arguments, and the late-tombstone entry passes what its caller already holds.
 * It used to take the whole head-advance evidence shape, which forced a caller
 * with no clock to invent one and made the safety of that invention depend on
 * which branch happened to run first inside this function. The operands are the
 * contract now, so that ordering is no longer load-bearing.
 *
 * `retainedTransition` carries its own clock because the transition is only ever
 * checked by a clocked verifier -- see the entry's docblock for the inversion
 * that pairing prevents.
 *
 * IT IS TOMBSTONE-ONLY, AND THE ACTIVE SHORTCUT DELIBERATELY LIVES ABOVE IT.
 * A lower-sequence ACTIVE candidate is stale, but that is a fact about the
 * SEQUENCE COMPARISON, not about the late-tombstone rule, and it is only sound
 * once the caller has established that both heads belong to the same record --
 * which the full evaluator does at :186 and a standalone caller cannot. Keeping
 * it in the adapter means the exported entry cannot answer for a head this rule
 * says nothing about.
 */
function evaluateLateTombstoneRuleV1(
  candidateState: AgentProfileTombstoneHeadObjectV1,
  tombstonePredecessor: AgentProfileActiveHeadObjectV1 | undefined,
  retainedTransition: AgentProfileLateTombstoneRetainedTransitionV1 | undefined,
  lineage: readonly AgentProfileAppliedTransitionV1[],
  candidateSequence: bigint,
): AgentProfileLateTombstoneDecisionV1 {
  const predecessor =
    tombstonePredecessor === undefined
      ? undefined
      : validateAgentProfileHeadObjectV1(tombstonePredecessor);
  if (
    predecessor === undefined ||
    predecessor.state !== 'active' ||
    !isTombstoneBoundToPredecessorV1(candidateState, predecessor)
  ) {
    return {
      decision: 'reject',
      reason: 'late tombstone lacks its exact verified active predecessor',
    };
  }
  const retained = lineage[Number(candidateSequence)];
  const transition =
    retainedTransition === undefined
      ? undefined
      : validateAuthorityTransition(retainedTransition.transition);
  if (
    retained === undefined ||
    transition === undefined ||
    retainedTransition === undefined ||
    transition.priorAuthoritySequence !== retained.priorAuthoritySequence ||
    transition.nextAuthoritySequence !== retained.nextAuthoritySequence ||
    computeAgentProfileAuthorityTransitionDigestV1(transition) !== retained.transitionDigest
  ) {
    return {
      decision: 'reject',
      reason: 'late tombstone requires the exact retained resurrection transition',
    };
  }
  const clockRefusal = rejectInvalidHeadClockV1(candidateState, retainedTransition.nowMs);
  if (clockRefusal !== undefined) return clockRefusal;
  const verified = evaluateAuthorityTransitionV1(
    transition,
    candidateState,
    retainedTransition.nowMs,
  );
  if (verified.decision === 'accept') {
    // A valid descendant of the tombstoned sequence exists, so the tombstone is
    // superseded.
    return { decision: 'stale' };
  }
  // ONLY "NAMES ANOTHER PREDECESSOR" MEANS THE TOMBSTONE TAKES PRECEDENCE, and
  // it is asked STRUCTURALLY rather than read off the verifier's refusal text.
  //
  // ADR 0002 :131-132 makes the descendant valid only when the transition NAMES
  // this tombstone, "otherwise the tombstone takes precedence" -- so the
  // affirmative rests on a structural fact about two objects. Every other refusal
  // the verifier produces means "not verifiable now" (an unusable clock, a
  // transition beyond the future-skew bound, an expiry window not yet passed) and
  // propagates verbatim: reading one of those as precedence ADMITS a tombstone
  // that the same evidence with a later clock marks stale.
  //
  // The two measured inversions behind this shape, and the sweep showing this is
  // the only site in the package with an affirmative outcome available to invert
  // into, are recorded in the late-tombstone seam suite beside the constructions
  // that prove them.
  if (!isAuthorityTransitionBoundToPriorHeadV1(transition, candidateState)) {
    return { decision: 'accept' };
  }
  return verified;
}

function evaluateLowerSequenceAgentProfileHeadAdvanceV1(
  candidateState: AgentProfileHeadObjectV1,
  evidenceState: AgentProfileHeadAdvanceEvidenceV1,
  lineage: readonly AgentProfileAppliedTransitionV1[],
  candidateSequence: bigint,
): SystemRecordAuthorityDecisionV1 {
  // The sequence comparison's own answer, and it stays HERE. Reaching this
  // function means the full evaluator has already established that the candidate
  // and the accepted head are the same record (:186) -- which is what makes
  // "below the sequence, therefore superseded" sound for an active head.
  if (candidateState.state === 'active') return { decision: 'stale' };
  return evaluateLateTombstoneRuleV1(
    candidateState,
    evidenceState.tombstonePredecessor,
    evidenceState.acceptedTransition === undefined
      ? undefined
      : { transition: evidenceState.acceptedTransition, nowMs: evidenceState.nowMs },
    lineage,
    candidateSequence,
  );
}

/**
 * The ADR 0002 :129-133 decision for a tombstone learned BELOW the current
 * applied authority sequence.
 *
 * WHY THIS ENTRY EXISTS RATHER THAN {@link evaluateAgentProfileHeadAdvanceV1}.
 * That evaluator requires the accepted head as an OBJECT, and a receiver that
 * has persisted its accepted state holds a head DIGEST plus the transition
 * lineage, not the head itself. Synthesising one would invent `peerPublicKey`,
 * `evmIssuer`, `issuedAt`, `projectionSchemaDigest` and `version`, producing a
 * head whose digest does not match the persisted one -- a fabricated operand
 * decided here as though it were evidence. The arm below reads none of those
 * fields, so the honest entry is the one whose operands the caller really holds.
 *
 * IT IS THE SAME ARM, NOT A SECOND IMPLEMENTATION. Every clause of the rule
 * stays in `evaluateLowerSequenceAgentProfileHeadAdvanceV1`; this function
 * validates its inputs the way the full evaluator does and delegates. A caller
 * that reimplemented the predecessor or retained-transition checks would be
 * deciding authority outside core, which is what this entry exists to prevent.
 *
 * THE OPERAND CONTRACT, stated because a caller cannot infer it from the types.
 *
 * `acceptedTransitionLineage` is the ACCEPTED state's lineage, whose length IS
 * the current authority sequence -- the identity the full evaluator enforces at
 * :121-126. The candidate's own sequence is read off the candidate, so a caller
 * cannot pass one that disagrees with the head it is deciding, and a candidate
 * at or above the accepted sequence is refused rather than evaluated.
 *
 * `evidence.tombstonePredecessor` is REQUIRED in substance: without it the
 * decision is `reject | late tombstone lacks its exact verified active
 * predecessor`.
 *
 * `evidence.retainedTransition.transition` MUST be the retained transition OUT
 * of the candidate's sequence -- `lineage[candidateSequence]`, the rotation into
 * the NEXT sequence -- not the rotation into the candidate's own. Supplying the
 * wrong one is refused rather than misread, because :303-305 compares prior
 * sequence, next sequence AND digest against the retained entry.
 *
 * WHEN IT IS ABSENT, THE ANSWER IS A REJECT AND NEVER A STALE. That is ADR 0002
 * :132-133 ("Missing retained-transition evidence rejects for retry rather than
 * treating the tombstone as stale"), and it is the case every caller hits today:
 * the applied state persists transition DIGESTS, so a receiver holding only
 * persisted state cannot produce the object. A caller must map that reject onto
 * a RETRYABLE outcome; mapping it onto a terminal one reintroduces the exact
 * behaviour this entry exists to remove.
 *
 * THE CLOCK TRAVELS WITH THE TRANSITION, AND THAT PAIRING IS A SAFETY PROPERTY
 * RATHER THAN TIDINESS. This arm reads a NON-ACCEPT from the transition verifier
 * as "the tombstone takes precedence" (:312-315). The verifier also refuses on
 * an unusable clock -- so a caller that supplied a binding transition together
 * with an invalid `nowMs` would have a clock failure INVERT the verdict from
 * `stale` into `accept`, admitting a tombstone that a valid clock supersedes.
 * Measured before it was fixed: NaN and -1 both returned `accept` where the same
 * inputs with a real clock returned `stale`, while the full evaluator rejected
 * them at its front door. So the two operands are ONE optional field, and the
 * clock gates the full evaluator runs at :96-103 are mirrored below rather than
 * delegated. The invariant this buys, asserted in the suite: **`accept` and
 * `stale` are reachable only when a retained transition AND a valid clock were
 * both supplied.** A caller with neither cannot express an admission at all.
 *
 * IT ANSWERS FOR TOMBSTONES ONLY, at the type AND at runtime. The rule this
 * entry exposes says nothing about an active candidate; the full evaluator's
 * "below the sequence, therefore stale" shortcut for actives is sound only after
 * it has established that both heads are the same record, and this entry has no
 * accepted head to make that comparison against. Measured before the guard
 * existed: an active head below the sequence with EMPTY evidence returned
 * `{ decision: 'stale' }` from an entry whose name promises a tombstone verdict.
 * The type narrows to a tombstone head and the runtime check refuses anything
 * else, because a caller can always cast.
 */
export function evaluateAgentProfileLateTombstoneAdvanceV1(
  candidate: AgentProfileTombstoneHeadObjectV1,
  evidence: AgentProfileLateTombstoneEvidenceV1,
  acceptedTransitionLineage: readonly AgentProfileAppliedTransitionV1[],
): AgentProfileLateTombstoneDecisionV1 {
  const candidateState = validateAgentProfileHeadObjectV1(candidate);
  if (candidateState.state !== 'tombstone') {
    return {
      decision: 'reject',
      reason: 'late tombstone entry requires a tombstone candidate',
    };
  }
  const supplied = snapshotLateTombstoneEvidenceV1(evidence);
  const lineage = validateAppliedTransitionLineage(acceptedTransitionLineage);
  const candidateSequence = parseCanonicalDecimalU64(candidateState.authoritySequence);
  if (candidateSequence >= BigInt(lineage.length)) {
    return {
      decision: 'reject',
      reason: 'late tombstone entry requires a candidate below the accepted authority sequence',
    };
  }
  return evaluateLateTombstoneRuleV1(
    candidateState,
    supplied.tombstonePredecessor,
    supplied.retainedTransition,
    lineage,
    candidateSequence,
  );
}

function evaluateNextSequenceAgentProfileHeadAdvanceV1(
  acceptedState: AgentProfileAcceptedAuthorityStateV1,
  current: AgentProfileHeadObjectV1,
  candidateState: AgentProfileHeadObjectV1,
  evidenceState: AgentProfileHeadAdvanceEvidenceV1,
  lineage: readonly AgentProfileAppliedTransitionV1[],
  historicalRoots: readonly string[],
): SystemRecordAuthorityDecisionV1 {
  if (acceptedState.disposition === 'head-fork-quarantined') {
    return {
      decision: 'reject',
      reason: 'unresolved head fork cannot advance authority sequence',
    };
  }
  const transition =
    evidenceState.acceptedTransition === undefined
      ? undefined
      : validateAuthorityTransition(evidenceState.acceptedTransition);
  if (
    transition === undefined ||
    candidateState.acceptedTransitionDigest === undefined ||
    candidateState.acceptedTransitionDigest !==
      computeAgentProfileAuthorityTransitionDigestV1(transition)
  ) {
    return {
      decision: 'reject',
      reason: 'exact accepted authority transition is missing',
    };
  }
  if (candidateState.state === 'tombstone') {
    return {
      decision: 'reject',
      reason: 'next-sequence tombstone requires its exact same-sequence active predecessor',
    };
  }
  const transitionDecision = evaluateAuthorityTransitionV1(
    transition,
    current,
    evidenceState.nowMs,
  );
  if (transitionDecision.decision !== 'accept') return transitionDecision;
  if (
    historicalRoots.includes(transition.nextRoot) ||
    transition.nextRoot === current.rootSubject
  ) {
    return {
      decision: 'reject',
      reason: 'authority transition reuses a root retained by this record',
    };
  }
  if (
    candidateState.evmIssuer !== transition.nextEvmIssuer ||
    candidateState.rootSubject !== transition.nextRoot
  ) {
    return {
      decision: 'reject',
      reason: 'next-sequence head does not bind transition issuer/root',
    };
  }
  const existing = lineage.find(
    (entry) => entry.nextAuthoritySequence === candidateState.authoritySequence,
  );
  if (
    existing !== undefined &&
    existing.transitionDigest !== candidateState.acceptedTransitionDigest
  ) {
    return { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  return { decision: 'accept' };
}

function evaluateSameSequenceTombstoneAdvanceV1(
  current: AgentProfileHeadObjectV1,
  candidateState: AgentProfileTombstoneHeadObjectV1,
  evidenceState: AgentProfileHeadAdvanceEvidenceV1,
  currentVersion: bigint,
  candidateVersion: bigint,
  currentDigest: Digest32V1,
  candidateDigest: Digest32V1,
): SystemRecordAuthorityDecisionV1 {
  const predecessor =
    evidenceState.tombstonePredecessor === undefined
      ? current.state === 'active'
        ? current
        : undefined
      : validateAgentProfileHeadObjectV1(evidenceState.tombstonePredecessor);
  if (
    predecessor === undefined ||
    predecessor.state !== 'active' ||
    !isTombstoneBoundToPredecessorV1(candidateState, predecessor)
  ) {
    return {
      decision: 'reject',
      reason: 'tombstone lacks its exact verified active predecessor',
    };
  }
  if (current.state === 'active') {
    if (candidateVersion === currentVersion) {
      return { decision: 'quarantine', reason: 'head-fork' };
    }
    return { decision: 'accept' };
  }
  if (candidateVersion !== currentVersion) {
    return candidateVersion < currentVersion ? { decision: 'accept' } : { decision: 'stale' };
  }
  if (candidateDigest === currentDigest) return { decision: 'stale' };
  return candidateDigest < currentDigest ? { decision: 'accept' } : { decision: 'stale' };
}

function evaluateSameSequenceActiveAdvanceV1(
  acceptedState: AgentProfileAcceptedAuthorityStateV1,
  current: AgentProfileHeadObjectV1,
  candidateState: AgentProfileActiveHeadObjectV1,
  evidenceState: AgentProfileHeadAdvanceEvidenceV1,
): SystemRecordAuthorityDecisionV1 {
  if (acceptedState.disposition === 'head-fork-quarantined') {
    return evaluateForkResolutionSuccessorV1(current, candidateState, evidenceState);
  }
  if (candidateState.forkResolutionDigest !== undefined) {
    return {
      decision: 'reject',
      reason: 'historical or unsolicited fork resolution is audit-only',
    };
  }
  return { decision: 'accept' };
}

function evaluateForkResolutionSuccessorV1(
  current: AgentProfileHeadObjectV1,
  candidateState: AgentProfileActiveHeadObjectV1,
  evidenceState: AgentProfileHeadAdvanceEvidenceV1,
): SystemRecordAuthorityDecisionV1 {
  const resolution = evidenceState.forkResolution;
  const conflicts = evidenceState.forkEvidenceHeads;
  if (
    resolution === undefined ||
    conflicts === undefined ||
    candidateState.state !== 'active' ||
    resolution.forkedVersion !== current.version ||
    computeAgentProfileForkResolutionDigestV1(resolution) !== candidateState.forkResolutionDigest ||
    !isDirectResolvingSuccessorV1(candidateState, resolution)
  ) {
    return {
      decision: 'reject',
      reason: 'current frontier fork requires its exact direct resolving successor',
    };
  }
  if (isIssuedTooFarInFuture(resolution.issuedAt, evidenceState.nowMs)) {
    return {
      decision: 'reject',
      reason: 'fork resolution issuedAt exceeds the future clock-skew bound',
    };
  }
  const validatedForkEvidence = validateAgentProfileForkResolutionEvidenceV1(
    resolution,
    conflicts,
    evidenceState.forkBaseHead,
  );
  const resolutionTransitionDigest =
    validatedForkEvidence.evidenceHeads[0]?.acceptedTransitionDigest;
  if (
    resolutionTransitionDigest !== current.acceptedTransitionDigest ||
    (validatedForkEvidence.forkBase !== undefined &&
      validatedForkEvidence.forkBase.acceptedTransitionDigest !== current.acceptedTransitionDigest)
  ) {
    return { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  return { decision: 'accept' };
}

export function evaluateAuthorityTransitionConflictV1(
  left: AgentProfileAuthorityTransitionV1,
  right: AgentProfileAuthorityTransitionV1,
): SystemRecordAuthorityDecisionV1 {
  const validatedLeft = validateAuthorityTransition(left);
  const validatedRight = validateAuthorityTransition(right);
  if (
    validatedLeft.networkId !== validatedRight.networkId ||
    validatedLeft.peerId !== validatedRight.peerId ||
    validatedLeft.priorAuthoritySequence !== validatedRight.priorAuthoritySequence ||
    validatedLeft.nextAuthoritySequence !== validatedRight.nextAuthoritySequence
  ) {
    return {
      decision: 'reject',
      reason: 'transitions do not target the same authority tuple',
    };
  }
  return computeAgentProfileAuthorityTransitionDigestV1(validatedLeft) ===
    computeAgentProfileAuthorityTransitionDigestV1(validatedRight)
    ? { decision: 'stale' }
    : { decision: 'quarantine', reason: 'transition-equivocation' };
}

/** Compare a verified transition with durable accepted lineage, including late delivery. */
export function evaluateAuthorityTransitionAgainstAcceptedStateV1(
  accepted: AgentProfileAcceptedAuthorityStateV1,
  transition: AgentProfileAuthorityTransitionV1,
  nowMs: number,
): SystemRecordAuthorityDecisionV1 {
  const validatedTransition = validateAuthorityTransition(transition);
  const acceptedState = snapshotAcceptedAuthorityStateV1(accepted);
  if (!isSafeNow(nowMs) || isIssuedTooFarInFuture(validatedTransition.issuedAt, nowMs)) {
    return {
      decision: 'reject',
      reason: 'transition verification time is invalid',
    };
  }
  const lineage = validateAppliedTransitionLineage(acceptedState.transitionLineage);
  const current =
    acceptedState.current === undefined
      ? undefined
      : validateAgentProfileHeadObjectV1(acceptedState.current);
  const historicalRoots = validateAcceptedRootHistoryV1(acceptedState, current, lineage);
  if (current === undefined) {
    if (acceptedState.disposition !== 'discoverable' || lineage.length !== 0) {
      return {
        decision: 'reject',
        reason: 'absent state cannot retain authority history or quarantine',
      };
    }
    return {
      decision: 'reject',
      reason: 'transition has no accepted predecessor',
    };
  }
  if (BigInt(lineage.length) !== parseCanonicalDecimalU64(current.authoritySequence)) {
    return {
      decision: 'reject',
      reason: 'accepted authority state has incomplete transition lineage',
    };
  }
  if (
    current.networkId !== validatedTransition.networkId ||
    current.peerId !== validatedTransition.peerId
  ) {
    return { decision: 'reject', reason: 'stable record key changed' };
  }
  const digestValue = computeAgentProfileAuthorityTransitionDigestV1(validatedTransition);
  const retained = lineage.find(
    (entry) =>
      entry.priorAuthoritySequence === validatedTransition.priorAuthoritySequence &&
      entry.nextAuthoritySequence === validatedTransition.nextAuthoritySequence,
  );
  if (retained !== undefined) {
    return retained.transitionDigest === digestValue
      ? { decision: 'stale' }
      : { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  if (acceptedState.disposition === 'transition-equivocation-quarantined') {
    return { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  if (acceptedState.disposition === 'head-fork-quarantined') {
    return {
      decision: 'reject',
      reason: 'unresolved head fork cannot advance authority sequence',
    };
  }
  if (
    historicalRoots.includes(validatedTransition.nextRoot) ||
    validatedTransition.nextRoot === current.rootSubject
  ) {
    return {
      decision: 'reject',
      reason: 'authority transition reuses a root retained by this record',
    };
  }
  return evaluateAuthorityTransitionV1(validatedTransition, current, nowMs);
}

function validateAppliedTransitionLineage(
  value: unknown,
): readonly AgentProfileAppliedTransitionV1[] {
  let lineage: readonly unknown[];
  try {
    lineage = snapshotDataArray(value, 'applied transition lineage', {
      maxLength: Number(SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX),
    });
  } catch (cause) {
    fail('system-record-history', 'applied transition lineage exceeds its closed V1 bound', cause);
  }
  let expectedPrior = 0n;
  const result: AgentProfileAppliedTransitionV1[] = [];
  for (const entry of lineage) {
    const exact = snapshotExactDataRecord(
      entry,
      ['priorAuthoritySequence', 'nextAuthoritySequence', 'transitionDigest'],
      'applied transition lineage entry',
    );
    const prior = u64(exact.priorAuthoritySequence, 'priorAuthoritySequence');
    const next = u64(exact.nextAuthoritySequence, 'nextAuthoritySequence');
    digest(exact.transitionDigest, 'transitionDigest');
    if (prior !== expectedPrior || next !== prior + 1n) {
      fail(
        'system-record-history',
        'applied transition lineage must be contiguous from sequence zero',
      );
    }
    expectedPrior = next;
    result.push(Object.freeze({ ...exact }) as unknown as AgentProfileAppliedTransitionV1);
  }
  return Object.freeze(result);
}

function snapshotAcceptedAuthorityStateV1(value: unknown): AgentProfileAcceptedAuthorityStateV1 {
  const probe = snapshotSystemRecordDataRecord(value, 'accepted authority state');
  const state = snapshotExactDataRecord(
    probe,
    [
      ...(hasOwnDataProperty(probe, 'current') ? ['current'] : []),
      'disposition',
      'transitionLineage',
      'historicalRoots',
      ...(hasOwnDataProperty(probe, 'frontierConflictHeads') ? ['frontierConflictHeads'] : []),
    ],
    'accepted authority state',
  );
  if (
    state.disposition !== 'discoverable' &&
    state.disposition !== 'head-fork-quarantined' &&
    state.disposition !== 'transition-equivocation-quarantined'
  ) {
    fail('system-record-history', 'accepted authority disposition is invalid');
  }
  return Object.freeze({
    ...(hasOwnDataProperty(state, 'current') ? { current: state.current } : {}),
    disposition: state.disposition,
    transitionLineage: state.transitionLineage,
    historicalRoots: state.historicalRoots,
  }) as unknown as AgentProfileAcceptedAuthorityStateV1;
}

function snapshotHeadAdvanceEvidenceV1(value: unknown): AgentProfileHeadAdvanceEvidenceV1 {
  const probe = snapshotSystemRecordDataRecord(value, 'head advance evidence');
  const optionals = [
    'acceptedTransition',
    'tombstonePredecessor',
    'verifiedAuthoritySummary',
    'forkResolution',
    'forkEvidenceHeads',
    'forkBaseHead',
  ].filter((key) => hasOwnDataProperty(probe, key));
  const evidence = snapshotExactDataRecord(probe, ['nowMs', ...optionals], 'head advance evidence');
  return Object.freeze({
    ...evidence,
  }) as unknown as AgentProfileHeadAdvanceEvidenceV1;
}

function validateAcceptedRootHistoryV1(
  accepted: AgentProfileAcceptedAuthorityStateV1,
  current: AgentProfileHeadObjectV1 | undefined,
  lineage: readonly AgentProfileAppliedTransitionV1[],
): readonly string[] {
  let historicalRoots: readonly unknown[];
  try {
    historicalRoots = snapshotDataArray(accepted.historicalRoots, 'accepted root history', {
      maxLength: SYSTEM_RECORD_MAX_ROOT_CLAIMS - 1,
    });
  } catch (cause) {
    fail('system-record-history', 'accepted authority state lacks a closed root history', cause);
  }
  if (current === undefined) {
    if (historicalRoots.length !== 0) {
      fail('system-record-history', 'absent authority state cannot retain root history');
    }
    return historicalRoots as readonly string[];
  }
  if (historicalRoots.length !== lineage.length) {
    fail('system-record-history', 'accepted root history must match transition lineage');
  }
  const roots = new Set<string>([current.rootSubject]);
  for (const root of historicalRoots) {
    assertAgentRootV1(root);
    if (roots.has(root))
      fail('system-record-history', 'accepted root history must be duplicate-free');
    roots.add(root);
  }
  return historicalRoots as readonly string[];
}
