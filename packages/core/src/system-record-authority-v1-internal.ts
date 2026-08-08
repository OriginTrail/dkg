import {
  hasOwnDataProperty,
  snapshotDataArray,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';
import { parseCanonicalDecimalU64, type Digest32V1 } from './sync-wire-scalars.js';
import { failSystemRecordObjectV1 as fail } from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_MAX_CLOCK_SKEW_MS,
  SYSTEM_RECORD_MAX_ROOT_CLAIMS,
} from './system-record-limits-v1.js';

import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  validateAuthorityTransition,
  validateForkResolution,
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
  type CanonicalRfc3339SecondsV1,
} from './system-record-agent-profile-primitives-v1-internal.js';
import {
  isAgentProfileVerifiedAuthoritySummaryV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
} from './system-record-authority-summary-v1-internal.js';
import type { AgentProfileAppliedTransitionV1 } from './system-record-authority-types-v1-internal.js';

export type SystemRecordAuthorityDecisionV1 =
  | { readonly decision: 'accept' }
  | { readonly decision: 'stale' }
  | {
      readonly decision: 'quarantine';
      readonly reason: 'head-fork' | 'transition-equivocation';
    }
  | { readonly decision: 'reject'; readonly reason: string };

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

export function evaluateAuthorityTransitionV1(
  transition: AgentProfileAuthorityTransitionV1,
  priorHead: AgentProfileHeadObjectV1,
  nowMs: number,
): SystemRecordAuthorityDecisionV1 {
  const validatedTransition = validateAuthorityTransition(transition);
  const validatedPrior = validateAgentProfileHeadObjectV1(priorHead);
  if (!isSafeNow(nowMs)) return { decision: 'reject', reason: 'verification clock is invalid' };
  if (isIssuedTooFarInFuture(validatedTransition.issuedAt, nowMs)) {
    return {
      decision: 'reject',
      reason: 'transition issuedAt exceeds the future clock-skew bound',
    };
  }
  const priorDigest = computeAgentProfileHeadObjectDigestV1(validatedPrior);
  if (
    validatedTransition.networkId !== validatedPrior.networkId ||
    validatedTransition.peerId !== validatedPrior.peerId ||
    validatedTransition.peerPublicKey !== validatedPrior.peerPublicKey ||
    validatedTransition.priorAuthoritySequence !== validatedPrior.authoritySequence ||
    validatedTransition.priorHeadDigest !== priorDigest ||
    validatedTransition.priorEvmIssuer !== validatedPrior.evmIssuer
  ) {
    return {
      decision: 'reject',
      reason: 'transition does not bind the accepted predecessor',
    };
  }
  if (validatedTransition.mode === 'expired-prior') {
    if (validatedPrior.state !== 'active') {
      return {
        decision: 'reject',
        reason: 'expired-prior transition cannot resurrect a tombstone',
      };
    }
    if (validatedTransition.priorValidUntil !== validatedPrior.validUntil) {
      return {
        decision: 'reject',
        reason: 'expired-prior transition does not bind prior validity',
      };
    }
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < Date.parse(validatedPrior.validUntil) + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS
    ) {
      return {
        decision: 'reject',
        reason: 'prior authority has not passed the expiry skew',
      };
    }
  }
  return { decision: 'accept' };
}

/** Bind a successor head to the exact accepted transition for the same stable record. */
export function isAgentProfileHeadBoundToAcceptedTransitionV1(
  head: AgentProfileHeadObjectV1,
  transition: AgentProfileAuthorityTransitionV1,
): boolean {
  const validatedHead = validateAgentProfileHeadObjectV1(head);
  const validatedTransition = validateAuthorityTransition(transition);
  return (
    validatedHead.networkId === validatedTransition.networkId &&
    validatedHead.peerId === validatedTransition.peerId &&
    validatedHead.peerPublicKey === validatedTransition.peerPublicKey &&
    validatedHead.acceptedTransitionDigest ===
      computeAgentProfileAuthorityTransitionDigestV1(validatedTransition) &&
    validatedHead.authoritySequence === validatedTransition.nextAuthoritySequence &&
    validatedHead.evmIssuer === validatedTransition.nextEvmIssuer &&
    validatedHead.rootSubject === validatedTransition.nextRoot
  );
}

export function evaluateAgentProfileHeadAdvanceV1(
  accepted: AgentProfileAcceptedAuthorityStateV1,
  candidate: AgentProfileHeadObjectV1,
  evidence: AgentProfileHeadAdvanceEvidenceV1,
): SystemRecordAuthorityDecisionV1 {
  const candidateState = validateAgentProfileHeadObjectV1(candidate);
  const acceptedState = snapshotAcceptedAuthorityStateV1(accepted);
  const evidenceState = snapshotHeadAdvanceEvidenceV1(evidence);
  if (!isSafeNow(evidenceState.nowMs))
    return { decision: 'reject', reason: 'verification clock is invalid' };
  if (isIssuedTooFarInFuture(candidateState.issuedAt, evidenceState.nowMs)) {
    return {
      decision: 'reject',
      reason: 'head issuedAt exceeds the future clock-skew bound',
    };
  }
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

function evaluateLowerSequenceAgentProfileHeadAdvanceV1(
  candidateState: AgentProfileHeadObjectV1,
  evidenceState: AgentProfileHeadAdvanceEvidenceV1,
  lineage: readonly AgentProfileAppliedTransitionV1[],
  candidateSequence: bigint,
): SystemRecordAuthorityDecisionV1 {
  if (candidateState.state === 'active') return { decision: 'stale' };
  const predecessor =
    evidenceState.tombstonePredecessor === undefined
      ? undefined
      : validateAgentProfileHeadObjectV1(evidenceState.tombstonePredecessor);
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
    evidenceState.acceptedTransition === undefined
      ? undefined
      : validateAuthorityTransition(evidenceState.acceptedTransition);
  if (
    retained === undefined ||
    transition === undefined ||
    transition.priorAuthoritySequence !== retained.priorAuthoritySequence ||
    transition.nextAuthoritySequence !== retained.nextAuthoritySequence ||
    computeAgentProfileAuthorityTransitionDigestV1(transition) !== retained.transitionDigest
  ) {
    return {
      decision: 'reject',
      reason: 'late tombstone requires the exact retained resurrection transition',
    };
  }
  return evaluateAuthorityTransitionV1(transition, candidateState, evidenceState.nowMs).decision ===
    'accept'
    ? { decision: 'stale' }
    : { decision: 'accept' };
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
  if (current.state === 'active') return { decision: 'accept' };
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

export function isDirectResolvingSuccessorV1(
  successor: AgentProfileHeadObjectV1,
  resolution: AgentProfileForkResolutionV1,
): boolean {
  const validatedSuccessor = validateAgentProfileHeadObjectV1(successor);
  const validatedResolution = validateForkResolution(resolution);
  if (
    validatedSuccessor.networkId !== validatedResolution.networkId ||
    validatedSuccessor.peerId !== validatedResolution.peerId ||
    validatedSuccessor.peerPublicKey !== validatedResolution.peerPublicKey ||
    validatedSuccessor.evmIssuer !== validatedResolution.evmIssuer ||
    validatedSuccessor.authoritySequence !== validatedResolution.authoritySequence ||
    validatedSuccessor.forkResolutionDigest !==
      computeAgentProfileForkResolutionDigestV1(validatedResolution) ||
    parseCanonicalDecimalU64(validatedSuccessor.version) <=
      parseCanonicalDecimalU64(validatedResolution.resolutionVersion)
  ) {
    return false;
  }
  return validatedResolution.forkedVersion === '0'
    ? validatedSuccessor.previousHeadDigest === undefined
    : validatedSuccessor.previousHeadDigest === validatedResolution.forkBaseHeadDigest;
}

export function isTombstoneBoundToPredecessorV1(
  tombstone: AgentProfileTombstoneHeadObjectV1,
  predecessor: AgentProfileActiveHeadObjectV1,
): boolean {
  const validatedTombstone = validateAgentProfileHeadObjectV1(tombstone);
  const validatedPredecessor = validateAgentProfileHeadObjectV1(predecessor);
  if (validatedTombstone.state !== 'tombstone' || validatedPredecessor.state !== 'active')
    return false;
  return (
    validatedTombstone.previousHeadDigest ===
      computeAgentProfileHeadObjectDigestV1(validatedPredecessor) &&
    validatedTombstone.networkId === validatedPredecessor.networkId &&
    validatedTombstone.peerId === validatedPredecessor.peerId &&
    validatedTombstone.peerPublicKey === validatedPredecessor.peerPublicKey &&
    validatedTombstone.authoritySequence === validatedPredecessor.authoritySequence &&
    validatedTombstone.acceptedTransitionDigest === validatedPredecessor.acceptedTransitionDigest &&
    validatedTombstone.evmIssuer === validatedPredecessor.evmIssuer &&
    validatedTombstone.rootSubject === validatedPredecessor.rootSubject &&
    validatedTombstone.projectionSchemaDigest === validatedPredecessor.projectionSchemaDigest &&
    parseCanonicalDecimalU64(validatedTombstone.version) >
      parseCanonicalDecimalU64(validatedPredecessor.version)
  );
}

export function assertAgentProfileForkResolutionEvidenceV1(
  resolution: AgentProfileForkResolutionV1,
  evidenceHeads: readonly AgentProfileHeadObjectV1[],
  forkBase?: AgentProfileHeadObjectV1,
): void {
  validateAgentProfileForkResolutionEvidenceV1(resolution, evidenceHeads, forkBase);
}

function validateAgentProfileForkResolutionEvidenceV1(
  resolution: AgentProfileForkResolutionV1,
  evidenceHeads: readonly AgentProfileHeadObjectV1[],
  forkBase?: AgentProfileHeadObjectV1,
): Readonly<{
  resolution: AgentProfileForkResolutionV1;
  evidenceHeads: readonly AgentProfileHeadObjectV1[];
  forkBase?: AgentProfileHeadObjectV1;
}> {
  const validatedResolution = validateForkResolution(resolution);
  let rawHeads: readonly unknown[];
  try {
    rawHeads = snapshotDataArray(evidenceHeads, 'fork resolution evidence heads', {
      minLength: validatedResolution.evidenceHeadDigests.length,
      maxLength: validatedResolution.evidenceHeadDigests.length,
    });
  } catch (cause) {
    fail(
      'system-record-history',
      'fork resolution evidence set is incomplete or not closed',
      cause,
    );
  }
  const heads = Object.freeze(rawHeads.map((head) => validateAgentProfileHeadObjectV1(head)));
  const byDigest = new Map(
    heads.map((head) => {
      return [computeAgentProfileHeadObjectDigestV1(head), head] as const;
    }),
  );
  if (
    byDigest.size !== heads.length ||
    validatedResolution.evidenceHeadDigests.some((candidate) => !byDigest.has(candidate))
  ) {
    fail('system-record-history', 'fork resolution evidence digests do not match supplied heads');
  }
  const forkedVersion = parseCanonicalDecimalU64(validatedResolution.forkedVersion);
  const authoritySequence = parseCanonicalDecimalU64(validatedResolution.authoritySequence);
  let baseDigest: Digest32V1 | undefined;
  const validatedForkBase =
    forkBase === undefined ? undefined : validateAgentProfileHeadObjectV1(forkBase);
  if (forkedVersion === 0n) {
    if (validatedForkBase !== undefined)
      fail('system-record-history', 'version-zero fork must not supply a base');
  } else {
    if (validatedForkBase === undefined)
      fail('system-record-history', 'nonzero fork requires its common base');
    baseDigest = computeAgentProfileHeadObjectDigestV1(validatedForkBase);
    if (
      validatedForkBase.state !== 'active' ||
      baseDigest !== validatedResolution.forkBaseHeadDigest ||
      validatedForkBase.networkId !== validatedResolution.networkId ||
      validatedForkBase.peerId !== validatedResolution.peerId ||
      validatedForkBase.authoritySequence !== validatedResolution.authoritySequence ||
      validatedForkBase.evmIssuer !== validatedResolution.evmIssuer ||
      parseCanonicalDecimalU64(validatedForkBase.version) >= forkedVersion
    ) {
      fail('system-record-history', 'fork base is not a verified lower same-authority head');
    }
  }
  const expectedTransitionDigest = heads[0]?.acceptedTransitionDigest;
  if (
    (authoritySequence === 0n && expectedTransitionDigest !== undefined) ||
    (authoritySequence > 0n && expectedTransitionDigest === undefined)
  ) {
    fail('system-record-history', 'fork evidence has invalid accepted-transition lineage');
  }
  for (const head of heads) {
    if (head.state !== 'active') {
      fail('system-record-history', 'fork resolution cannot use tombstone evidence');
    }
    if (head.acceptedTransitionDigest !== expectedTransitionDigest) {
      fail('system-record-history', 'fork evidence changed accepted-transition lineage');
    }
    if (
      head.networkId !== validatedResolution.networkId ||
      head.peerId !== validatedResolution.peerId ||
      head.peerPublicKey !== validatedResolution.peerPublicKey ||
      head.evmIssuer !== validatedResolution.evmIssuer ||
      head.authoritySequence !== validatedResolution.authoritySequence ||
      head.version !== validatedResolution.forkedVersion ||
      (forkedVersion === 0n
        ? head.previousHeadDigest !== undefined
        : head.previousHeadDigest !== baseDigest)
    ) {
      fail(
        'system-record-history',
        'fork evidence head does not share the canonical fork tuple/base',
      );
    }
  }
  if (
    validatedForkBase !== undefined &&
    validatedForkBase.acceptedTransitionDigest !== expectedTransitionDigest
  ) {
    fail('system-record-history', 'fork base changed accepted-transition lineage');
  }
  return Object.freeze({
    resolution: validatedResolution,
    evidenceHeads: heads,
    ...(validatedForkBase === undefined ? {} : { forkBase: validatedForkBase }),
  });
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

export function isSafeNow(nowMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0;
}

export function isIssuedTooFarInFuture(
  issuedAt: CanonicalRfc3339SecondsV1,
  nowMs: number,
): boolean {
  return Date.parse(issuedAt) > nowMs + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS;
}
