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
import type { SystemRecordAppliedStatusV1 } from './system-record-applied-state-v1.js';
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
  rejectInadmissibleExpiredPriorTransitionV1,
  rejectUnverifiableAuthorityTransitionV1,
  isAgentProfileHeadBoundToAcceptedTransitionV1,
  isDirectResolvingSuccessorV1,
  isIssuedTooFarInFuture,
  classifyAuthorityTransitionBindingV1,
  isSafeNow,
  isTombstoneBoundToPredecessorV1,
  validateAgentProfileForkResolutionEvidenceV1,
} from './system-record-authority-verification-v1-internal.js';

export type { SystemRecordAuthorityDecisionV1 } from './system-record-authority-types-v1-internal.js';
export {
  assertAgentProfileForkResolutionEvidenceV1,
  evaluateAuthorityTransitionV1,
  isAgentProfileHeadBoundToAcceptedTransitionV1,
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
 * Exactly the operands the ADR 0002 :112-114 / :126-128 same-sequence rule reads
 * from the evidence side, which is the tombstone's predecessor and nothing else.
 *
 * No clock, no transition, no summary: unlike the late-tombstone rule this one
 * never consults a verifier, so a shape carrying those fields would ask every
 * caller to supply operands the decision cannot read.
 */
export interface AgentProfileSameSequenceTombstoneEvidenceV1 {
  readonly tombstonePredecessor?: AgentProfileActiveHeadObjectV1;
}

/**
 * The applied row this rule decides AGAINST, in the vocabulary a receiver holds.
 *
 * A receiver persists the applied ROW -- a status, a head digest, a version and
 * the sequence its lineage reaches -- not the applied head OBJECT. Asking for
 * the object would repeat the operand gap that made the late-tombstone entry
 * necessary, and a caller that manufactured one would be inventing the issuer,
 * clock and schema fields its digest is taken over.
 *
 * `status` is core's own {@link SystemRecordAppliedStatusV1}, so the step from a
 * persisted status to the head state this rule branches on is taken HERE, where
 * both vocabularies are defined. A receiver that made that step itself would be
 * modelling core's authority reading in order to call core.
 */
export interface AgentProfileSameSequenceAppliedRowV1 {
  readonly status: SystemRecordAppliedStatusV1;
  readonly authoritySequence: string;
  readonly version: string;
  readonly headDigest: Digest32V1;
  /**
   * THE STABLE RECORD KEY, and it is a DIFFERENT question from the branch below.
   *
   * `currentRoot` establishes the authority BRANCH; it cannot establish the
   * RECORD, because the codec welds the root to `did:dkg:agent:${evmIssuer}` and
   * one issuer may key more than one record. The full evaluator asks both, and
   * asks this one FIRST -- `reject | stable record key changed` -- before it
   * classifies the branch at all. The extracted entry carried the branch
   * conjuncts and left this one behind, which is the same precondition loss that
   * made the entry necessary, one layer over: at authority sequence zero there is
   * no accepted transition to separate two records either, so a tombstone for one
   * record could be accepted against another record's applied row and advance,
   * deleting the wrong projection.
   *
   * A receiver persists both; they are the applied state's own `networkId` and
   * `peerId`, taken from it rather than derived.
   */
  readonly networkId: string;
  readonly peerId: string;
  /**
   * THE APPLIED ROW'S AUTHORITY BRANCH. Without it this rule decides a
   * projection-DELETING question without establishing that the candidate and the
   * applied row are the same record, which is the defect this field was added to
   * close: a verified tombstone bound to its own predecessor on a DIFFERENT
   * same-sequence branch was accepted and advanced, deleting the applied
   * projection. The full evaluator refuses that state before it ever reaches this
   * rule; the extracted entry had no operand able to ask the question.
   *
   * A receiver persists this as `currentRoot`, and it is the same value the
   * applied head carries as `rootSubject` -- measured, not assumed.
   *
   * ONE COMPARISON COVERS THE ISSUER TOO, and the reason is a codec weld rather
   * than an economy: `assertAgentRootV1` refuses any head whose `rootSubject` is
   * not `did:dkg:agent:${evmIssuer}`, so two codec-valid heads agree on the root
   * exactly when they agree on the issuer. The full evaluator's disjunction over
   * both fields is belt-and-braces over that weld. The weld is pinned by a test
   * rather than trusted: perturbing either field alone is refused, which is what
   * makes the single comparison faithful instead of eight-of-nine.
   */
  readonly currentRoot: string;
  /**
   * The transition the applied row accepted INTO this sequence -- the applied
   * head's `acceptedTransitionDigest`, which a receiver holds as the last entry
   * of its persisted transition lineage (measured equal, both directions).
   *
   * Optional because a record at authority sequence zero has accepted no
   * transition and its lineage is empty; the candidate at that sequence carries
   * none either, so the comparison is `undefined === undefined` and passes
   * rather than being skipped.
   */
  readonly acceptedTransitionDigest?: Digest32V1;
}

function snapshotSameSequenceTombstoneEvidenceV1(
  value: unknown,
): AgentProfileSameSequenceTombstoneEvidenceV1 {
  const probe = snapshotSystemRecordDataRecord(value, 'same-sequence tombstone evidence');
  const optionals = ['tombstonePredecessor'].filter((key) => hasOwnDataProperty(probe, key));
  return Object.freeze(
    snapshotExactDataRecord(probe, optionals, 'same-sequence tombstone evidence'),
  ) as unknown as AgentProfileSameSequenceTombstoneEvidenceV1;
}

function snapshotSameSequenceAppliedRowV1(
  value: unknown,
): AgentProfileSameSequenceAppliedRowV1 {
  const probe = snapshotSystemRecordDataRecord(value, 'same-sequence applied row');
  const row = snapshotExactDataRecord(
    probe,
    [
      'status',
      'authoritySequence',
      'version',
      'headDigest',
      'networkId',
      'peerId',
      'currentRoot',
      // A sequence-zero row has accepted no transition, so the key is absent
      // rather than undefined -- the exact-record check counts keys, and listing
      // it unconditionally would refuse the genesis row outright.
      ...(hasOwnDataProperty(probe, 'acceptedTransitionDigest')
        ? (['acceptedTransitionDigest'] as const)
        : ([] as const)),
    ],
    'same-sequence applied row',
  );
  digest(row.headDigest, 'same-sequence applied row headDigest');
  if (typeof row.networkId !== 'string' || row.networkId.length === 0) {
    fail('system-record-schema', 'same-sequence applied row networkId is invalid');
  }
  if (typeof row.peerId !== 'string' || row.peerId.length === 0) {
    fail('system-record-schema', 'same-sequence applied row peerId is invalid');
  }
  assertAgentRootV1(row.currentRoot);
  if (row.acceptedTransitionDigest !== undefined) {
    digest(row.acceptedTransitionDigest, 'same-sequence applied row acceptedTransitionDigest');
  }
  u64(row.authoritySequence, 'same-sequence applied row authoritySequence');
  u64(row.version, 'same-sequence applied row version');
  if (!['active', 'quarantined', 'tombstone', 'dirty'].includes(row.status as string)) {
    fail('system-record-schema', 'same-sequence applied row status is invalid');
  }
  return Object.freeze({ ...row }) as unknown as AgentProfileSameSequenceAppliedRowV1;
}

/**
 * The head state a persisted status stands for, or `undefined` when V1 does not
 * define one this rule may decide against.
 *
 * `quarantined` and `dirty` are refusals rather than readings. A quarantined row
 * holds an unresolved head fork, and core clears a quarantine only through its
 * fork-resolution-successor branch -- letting a tombstone answer here would
 * resolve the equivocation by omission and take the evidence with it. A `dirty`
 * row is shadow mode's, and what a shadow row's head means is exactly what V1
 * has not decided; reading it as a tombstone would answer :127-128 for it
 * anyway, inventing the clearance the undecided state exists to withhold.
 */
function sameSequenceAppliedHeadStateV1(
  status: SystemRecordAppliedStatusV1,
): AgentProfileHeadObjectV1['state'] | undefined {
  switch (status) {
    case 'active':
      return 'active';
    case 'tombstone':
      return 'tombstone';
    case 'quarantined':
    case 'dirty':
      return undefined;
    default: {
      // Reached only when the applied-status union grows: the assignment is the
      // compile error that makes a new status this entry's problem rather than a
      // row that quietly reads as whichever state the last arm returned.
      const unmapped: never = status;
      throw new Error(
        `unmapped system-record applied status: ${JSON.stringify(unmapped)}`,
      );
    }
  }
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
  const identity = classifyAgentProfileSameSequenceIdentityV1(
    candidateState,
    current.rootSubject,
    current.acceptedTransitionDigest,
  );
  if (identity === 'authority-changed') {
    return { decision: 'reject', reason: 'same-sequence authority changed' };
  }
  const currentDigest = computeAgentProfileHeadObjectDigestV1(current);
  if (identity === 'transition-differs') {
    return { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  const currentVersion = parseCanonicalDecimalU64(current.version);
  const candidateVersion = parseCanonicalDecimalU64(candidateState.version);
  if (candidateState.state === 'tombstone') {
    // THE ADAPTER RESOLVES THE PREDECESSOR, THE RULE DECIDES WITH IT. Falling
    // back to the accepted head when no predecessor evidence was supplied needs
    // the head OBJECT, which only this evaluator holds; the rule takes the
    // resolved operand so that a caller who has no such object -- every receiver
    // -- reaches the same decision through the same code.
    return evaluateSameSequenceTombstoneRuleV1(
      candidateState,
      evidenceState.tombstonePredecessor === undefined
        ? current.state === 'active'
          ? current
          : undefined
        : validateAgentProfileHeadObjectV1(evidenceState.tombstonePredecessor),
      current.state,
      currentVersion,
      currentDigest,
      candidateVersion,
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
 * which `evaluateAgentProfileHeadAdvanceV1` does before dispatching and a
 * standalone caller cannot. Keeping it in the adapter means the exported entry
 * cannot answer for a head this rule says nothing about.
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
  // VERIFIABILITY IS ESTABLISHED BEFORE ANYTHING IS CLASSIFIED, AND THAT ORDER IS
  // THE POINT RATHER THAN TIDINESS.
  //
  // Below this line, a refusal can only be about what the transition BINDS,
  // which is what makes the structural arms sound BY CONSTRUCTION instead of by
  // the coincidence that today's only reachable non-binding refusal happens not
  // to move a verdict. Previously the verifier ran first and its result was
  // discarded on two of three arms, so a transition that could not be verified
  // at all was still read structurally -- and on the `names-another-head` arm
  // that reading is an ADMISSION that deletes the record. Harmless while the
  // verifier's only such refusal is temporal; not harmless the day it learns one
  // that ought to mean refuse, a signature check being the obvious candidate.
  //
  // TWO ENTRY-LAYER CELLS MOVE, both toward refusal and both pinned in the seam
  // suite: a transition naming ANOTHER head that is dated beyond the future skew
  // stops being an `accept`, and an UNRELATED transition that is also
  // unverifiable now refuses on the verifiability reason rather than asserting a
  // structural fact derived from an object nothing could check. No cell any
  // caller can reach today moves at all, because a receiver has no channel for a
  // retained transition and never gets this far.
  const unverifiable = rejectUnverifiableAuthorityTransitionV1(
    transition,
    retainedTransition.nowMs,
  );
  if (unverifiable !== undefined) return unverifiable;
  // THE AFFIRMATIVE NEEDS EVIDENCE FROM THIS RECORD, NOT MERELY A NON-MATCH.
  //
  // ADR 0002 :131-132 makes the descendant valid only when the retained
  // transition NAMES this tombstone, "otherwise the tombstone takes precedence"
  // -- and that "otherwise" presupposes the transition belongs to THIS record's
  // rotation out of THIS sequence. Three answers, not two:
  //
  //   names-another-head -- same authority, same sequence, different head. No
  //     valid descendant of the tombstone exists, so the tombstone wins.
  //   unrelated -- a different record, sequence or issuer. It proves nothing
  //     about this record, and reading it as precedence would let an unrelated
  //     object decide a tombstone's fate. Measured before the split: a retained
  //     transition carrying a foreign issuer returned `accept`.
  //   names-this-head -- it does name us and it is verifiable, so the only
  //     question left is whether an expired-prior rotation is admissible against
  //     this head. That refusal is propagated verbatim; anything else is a valid
  //     descendant, and the tombstone is superseded.
  //
  // A PLAIN `default` WOULD ABSORB A FOURTH BINDING. It would route one into
  // whichever arm it fell through to, silently and at run time, and this is the
  // site where the ADR mapping has to be decided rather than defaulted. The
  // `never` assignment below is the compile error that makes a new binding this
  // function's problem; the throw is what a non-TS caller gets, since an
  // unrecognised binding must not resolve to an admission. Refusing with a new
  // reason literal was the other option and was rejected: it would widen the
  // observable reject codomain by a case no test can construct.
  //
  // The measured inversions behind this shape, and the sweep showing this is the
  // only site in the package with an affirmative outcome available to invert
  // into, are recorded in the late-tombstone seam suite beside the constructions
  // that prove them.
  const binding = classifyAuthorityTransitionBindingV1(transition, candidateState);
  switch (binding) {
    case 'names-another-head':
      return { decision: 'accept' };
    case 'unrelated':
      return {
        decision: 'reject',
        reason: 'late tombstone retained transition belongs to another authority',
      };
    case 'names-this-head': {
      // The binding was asked ONCE, above. Re-running the whole verifier here to
      // learn the expired-prior answer would recompute exactly that
      // classification in order to reconstruct a reason it had already thrown
      // away -- the duplication this shape removes.
      const inadmissible = rejectInadmissibleExpiredPriorTransitionV1(
        transition,
        candidateState,
        retainedTransition.nowMs,
      );
      // A valid descendant of the tombstoned sequence exists, so the tombstone
      // is superseded.
      return inadmissible ?? { decision: 'stale' };
    }
    default: {
      const unmapped: never = binding;
      throw new Error(
        `unmapped authority transition binding: ${JSON.stringify(unmapped)}`,
      );
    }
  }
}

function evaluateLowerSequenceAgentProfileHeadAdvanceV1(
  candidateState: AgentProfileHeadObjectV1,
  evidenceState: AgentProfileHeadAdvanceEvidenceV1,
  lineage: readonly AgentProfileAppliedTransitionV1[],
  candidateSequence: bigint,
): SystemRecordAuthorityDecisionV1 {
  // The sequence comparison's own answer, and it stays HERE. Reaching this
  // function means the full evaluator has already established that the candidate
  // and the accepted head are the same record -- which is what makes
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
 * the current authority sequence -- the identity enforced by
 * `evaluateAgentProfileHeadAdvanceV1`. The candidate's own sequence is read off
 * the candidate, so a caller cannot pass one that disagrees with the head it is
 * deciding, and a candidate at or above the accepted sequence is refused rather
 * than evaluated.
 *
 * `evidence.tombstonePredecessor` is REQUIRED in substance: without it the
 * decision is `reject | late tombstone lacks its exact verified active
 * predecessor`.
 *
 * `evidence.retainedTransition.transition` MUST be the retained transition OUT
 * of the candidate's sequence -- `lineage[candidateSequence]`, the rotation into
 * the NEXT sequence -- not the rotation into the candidate's own. Supplying the
 * wrong one is refused rather than misread, because the rule compares prior
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
 * as "the tombstone takes precedence". The verifier also refuses on
 * an unusable clock -- so a caller that supplied a binding transition together
 * with an invalid `nowMs` would have a clock failure INVERT the verdict from
 * `stale` into `accept`, admitting a tombstone that a valid clock supersedes.
 * Measured before it was fixed: NaN and -1 both returned `accept` where the same
 * inputs with a real clock returned `stale`, while the full evaluator rejected
 * them at its front door. So the two operands are ONE optional field, and the
 * clock gates the full evaluator runs are applied through the shared
 * `rejectInvalidHeadClockV1` rather than delegated. The invariant this buys,
 * asserted in the suite: **`accept` and `stale` are reachable only when a
 * retained transition AND a valid clock were both supplied.** A caller with
 * neither cannot express an admission at all.
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
 *
 * THIS IS A RECEIVER-SEAM ENTRY, NOT THE GENERAL AUTHORITY API. Like its
 * same-sequence sibling it answers one ADR clause for a caller that holds
 * persisted evidence rather than the accepted head object. A caller holding that
 * head should use {@link evaluateAgentProfileHeadAdvanceV1}, which owns sequence
 * dispatch and the preconditions this entry cannot check for itself.
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

/**
 * IS THIS CANDIDATE THE SAME RECORD, ON THE SAME AUTHORITY BRANCH, AS THE STATE
 * IT IS BEING COMPARED WITH? One implementation, both callers -- the full
 * evaluator, which holds the applied head object, and the same-sequence entry,
 * which holds only the persisted row.
 *
 * IT RETURNS A CLASSIFICATION RATHER THAN A DECISION, and that is what lets it
 * be shared. The two callers owe their callers different answers: the evaluator
 * has the record's disposition and the conflicting transitions in hand and can
 * say `transition-equivocation`; the entry has two digests and can honestly say
 * only that they differ. Returning a verdict here would force one of them to
 * publish a claim its operands do not support. Returning the FACT lets each map
 * it to what it can defend, while the comparison itself exists exactly once.
 *
 * THAT SINGULARITY IS THE POINT, NOT A TIDINESS. The defect this closes was an
 * extracted rule that lost the identity preconditions its original call site
 * established; answering it with a SECOND copy of those preconditions would
 * reproduce the same failure one layer over, because two copies prove that they
 * agree, never that either is right -- and a copy that tracks the root but not
 * the transition digest fails open on exactly the cell that deletes a
 * projection.
 *
 * WHY THE ROOT COMPARISON CARRIES THE ISSUER. The evaluator historically tested
 * `evmIssuer || rootSubject`; the head codec refuses any head whose
 * `rootSubject` is not `did:dkg:agent:${evmIssuer}`, so across codec-valid heads
 * those are the same test. The weld is pinned by its own row rather than relied
 * upon: if it were ever relaxed, this single comparison would stop covering the
 * issuer, and it would do so silently.
 */
type AgentProfileSameSequenceIdentityV1 =
  | 'same-record'
  | 'authority-changed'
  | 'transition-differs';

function classifyAgentProfileSameSequenceIdentityV1(
  candidateState: AgentProfileHeadObjectV1,
  appliedRoot: string,
  appliedAcceptedTransitionDigest: Digest32V1 | undefined,
): AgentProfileSameSequenceIdentityV1 {
  if (candidateState.rootSubject !== appliedRoot) return 'authority-changed';
  if (candidateState.acceptedTransitionDigest !== appliedAcceptedTransitionDigest) {
    return 'transition-differs';
  }
  return 'same-record';
}

/**
 * The shared identity classification above, mapped to the answers THIS entry can
 * defend from the operands it holds.
 *
 * Both arms refuse, and neither claims to have classified an equivocation. That
 * naming belongs to the full evaluator, which reaches it holding the record's
 * disposition and the conflicting transitions; from a digest comparison alone
 * "these differ" is the whole of what is known. Refusing withholds the advance
 * just as completely as a quarantine would, and it does not publish a verdict
 * its inputs cannot ground.
 */
function refuseSameSequenceIdentityMismatchV1(
  candidateState: AgentProfileHeadObjectV1,
  row: AgentProfileSameSequenceAppliedRowV1,
): Extract<SystemRecordAuthorityDecisionV1, { readonly decision: 'reject' }> | undefined {
  const identity = classifyAgentProfileSameSequenceIdentityV1(
    candidateState,
    row.currentRoot,
    row.acceptedTransitionDigest,
  );
  if (identity === 'authority-changed') {
    return {
      decision: 'reject',
      reason: 'same-sequence tombstone belongs to another authority branch',
    };
  }
  if (identity === 'transition-differs') {
    return {
      decision: 'reject',
      reason: 'same-sequence tombstone accepted a different authority transition',
    };
  }
  return undefined;
}

/**
 * THIS IS A RECEIVER-SEAM ENTRY, NOT THE GENERAL AUTHORITY API. It answers one
 * ADR clause for a caller that holds a persisted applied ROW and no head object.
 * A caller holding the accepted head should use
 * {@link evaluateAgentProfileHeadAdvanceV1}, which is the canonical evaluator and
 * establishes record identity, sequence dispatch and the clock gates itself;
 * this entry assumes only what its operands can express and refuses the rest.
 * Choosing between the two is not a judgement call: it follows from whether you
 * have the head.
 *
 * The ADR 0002 :112-114 / :126-128 decision on a tombstone learned AT the
 * applied authority sequence, for a caller holding a persisted applied row.
 *
 * Its sibling entry answers for a tombstone learned BELOW that sequence. This
 * one answers the question the sequence comparison alone cannot: ADR :112-114
 * makes a tombstone dominate every active head in its sequence "regardless of
 * delivery order or version", so a verified tombstone at a LOWER version than
 * the applied active head is a revocation to honour, not an old head to discard.
 * A receiver deciding that from two integers discards it permanently.
 *
 * THE OPERANDS ARE WHAT A RECEIVER HAS, and that is the point of the entry
 * existing at all. `applied` is the persisted row rather than the accepted head
 * object; see {@link AgentProfileSameSequenceAppliedRowV1} for why manufacturing
 * the object is the trap this shape avoids.
 *
 * `evidence.tombstonePredecessor` is REQUIRED in substance: without it the
 * decision is `reject | tombstone lacks its exact verified active predecessor`.
 * The full evaluator can fall back to its own accepted head when the evidence
 * omits one; this entry has no such object and does not invent one.
 *
 * BINDINGNESS IS ASKED ONCE, HERE, AND BEFORE ANY VERSION IS READ. That
 * ordering is {@link evaluateSameSequenceTombstoneRuleV1}'s pinned contract, so
 * a caller mapping these answers never has to ask the binding question itself --
 * which matters because the predicate that answers it is deliberately not part
 * of this package's surface. An unbound candidate yields the same reject at
 * every version relation.
 *
 * IT ANSWERS ONLY FOR ROWS V1 HAS DECIDED. A quarantined or shadow-dirty applied
 * row is refused rather than read, and the refusal is a `reject`, not a throw:
 * those rows are well-formed, they are simply not this rule's to decide. A
 * malformed operand throws, as everywhere else in this module.
 *
 * THE RESULT IS THE FULL AUTHORITY UNION, MEASURED RATHER THAN ASSUMED. All four
 * decisions are produced: `accept` on a dominating tombstone, `quarantine |
 * head-fork` on the equal-version fork, `stale` under :127-128 when a lower
 * tombstone already holds the sequence, and `reject` on the refusals above. A
 * caller must map every one of them; there is no arm here that cannot happen.
 */
export function evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
  candidate: AgentProfileTombstoneHeadObjectV1,
  evidence: AgentProfileSameSequenceTombstoneEvidenceV1,
  applied: AgentProfileSameSequenceAppliedRowV1,
): SystemRecordAuthorityDecisionV1 {
  const candidateState = validateAgentProfileHeadObjectV1(candidate);
  if (candidateState.state !== 'tombstone') {
    return {
      decision: 'reject',
      reason: 'same-sequence tombstone entry requires a tombstone candidate',
    };
  }
  const supplied = snapshotSameSequenceTombstoneEvidenceV1(evidence);
  const row = snapshotSameSequenceAppliedRowV1(applied);
  if (candidateState.authoritySequence !== row.authoritySequence) {
    return {
      decision: 'reject',
      reason: 'same-sequence tombstone entry requires a candidate at the applied sequence',
    };
  }
  const appliedState = sameSequenceAppliedHeadStateV1(row.status);
  if (appliedState === undefined) {
    return {
      decision: 'reject',
      reason: 'same-sequence tombstone entry requires an active or tombstone applied row',
    };
  }
  // RECORD IDENTITY IS ESTABLISHED BEFORE THE RULE IS CONSULTED, exactly as the
  // full evaluator establishes it before dispatching to the same rule. These
  // conjuncts are that evaluator's, moved onto the operands a receiver holds:
  // the rule below decides whether a tombstone DOMINATES its sequence, and that
  // question presupposes that the tombstone and the applied row are the same
  // record on the same authority branch. Without them a verified tombstone bound
  // to its own predecessor on a competing branch is accepted, mapped to advance,
  // and DELETES the applied projection -- measured through the real receiver
  // path, not argued.
  // THE STABLE RECORD KEY IS ASKED FIRST, which is the full evaluator's own
  // order: it refuses `stable record key changed` before it classifies the
  // branch, because "is this the same record" precedes "is this the same branch
  // of that record". The literal is the evaluator's verbatim so the two agree.
  if (
    candidateState.networkId !== row.networkId
    || candidateState.peerId !== row.peerId
  ) {
    return { decision: 'reject', reason: 'stable record key changed' };
  }
  const identityRefusal = refuseSameSequenceIdentityMismatchV1(candidateState, row);
  if (identityRefusal !== undefined) return identityRefusal;
  return evaluateSameSequenceTombstoneRuleV1(
    candidateState,
    supplied.tombstonePredecessor === undefined
      ? undefined
      : validateAgentProfileHeadObjectV1(supplied.tombstonePredecessor),
    appliedState,
    parseCanonicalDecimalU64(row.version),
    row.headDigest,
    parseCanonicalDecimalU64(candidateState.version),
    computeAgentProfileHeadObjectDigestV1(candidateState),
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

/**
 * THE SAME-SEQUENCE TOMBSTONE RULE ITSELF, over exactly its own operands.
 *
 * Both entries call this, so there is ONE implementation: the full evaluator
 * adapts its accepted head into these arguments, and the same-sequence entry
 * passes what a receiver already persists. Nothing here reads an evidence
 * object, a clock or a lineage -- the rule's whole input is the candidate, its
 * predecessor and three facts about the applied head.
 *
 * THE PREDECESSOR IS DECIDED BEFORE THE VERSION IS READ, AND THAT ORDERING IS A
 * CONTRACT RATHER THAN AN ACCIDENT OF THE BRANCH LAYOUT. A tombstone that does
 * not bind its exact verified active predecessor is refused on the predecessor,
 * whatever version it carries and whatever version the applied row is at, so the
 * three version relations answer identically on an unbound candidate. A caller
 * mapping this rule's answers may therefore treat bindingness as ALREADY ASKED,
 * and does not have to re-derive it or model when the version branches run. The
 * property is asserted in the seam suite, not merely stated here: reordering the
 * version test above the predecessor test turns those rows red.
 *
 * WHAT EACH ARM IS. With the predecessor bound, ADR 0002 :112-114 makes the
 * tombstone dominate every active head in its sequence "regardless of delivery
 * order or version" and :126 resolves active/tombstone conflicts to the
 * tombstone -- so an ACTIVE applied head yields `accept` at any unequal version,
 * and the equal-version case is the genuine fork (same sequence, same version,
 * different head). Against a TOMBSTONE applied head the governing rule is
 * :127-128 instead, where the lowest tombstone wins and the digest breaks a tie,
 * which is why a higher tombstone over a lower one is `stale` rather than an
 * advance.
 */
function evaluateSameSequenceTombstoneRuleV1(
  candidateState: AgentProfileTombstoneHeadObjectV1,
  tombstonePredecessor: AgentProfileHeadObjectV1 | undefined,
  appliedState: AgentProfileHeadObjectV1['state'],
  appliedVersion: bigint,
  appliedHeadDigest: Digest32V1,
  candidateVersion: bigint,
  candidateDigest: Digest32V1,
): SystemRecordAuthorityDecisionV1 {
  if (
    tombstonePredecessor === undefined ||
    tombstonePredecessor.state !== 'active' ||
    !isTombstoneBoundToPredecessorV1(candidateState, tombstonePredecessor)
  ) {
    return {
      decision: 'reject',
      reason: 'tombstone lacks its exact verified active predecessor',
    };
  }
  if (appliedState === 'active') {
    if (candidateVersion === appliedVersion) {
      return { decision: 'quarantine', reason: 'head-fork' };
    }
    return { decision: 'accept' };
  }
  if (candidateVersion !== appliedVersion) {
    return candidateVersion < appliedVersion ? { decision: 'accept' } : { decision: 'stale' };
  }
  if (candidateDigest === appliedHeadDigest) return { decision: 'stale' };
  return candidateDigest < appliedHeadDigest ? { decision: 'accept' } : { decision: 'stale' };
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
