import { snapshotDataArray } from './sync-wire-objects.js';
import { parseCanonicalDecimalU64, type Digest32V1 } from './sync-wire-scalars.js';
import { failSystemRecordObjectV1 as fail } from './system-record-codec-primitives-v1.js';
import { SYSTEM_RECORD_MAX_CLOCK_SKEW_MS } from './system-record-limits-v1.js';
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
import type { CanonicalRfc3339SecondsV1 } from './system-record-agent-profile-primitives-v1-internal.js';
import type { SystemRecordAuthorityDecisionV1 } from './system-record-authority-types-v1-internal.js';

/**
 * How a retained transition relates to a head, in the three ways that differ.
 *
 * `names-this-head` -- it rotates out of exactly this head.
 * `names-another-head` -- SAME record and sequence and issuer, different head.
 * `unrelated` -- a different record, sequence or issuer entirely.
 *
 * THE SECOND AND THIRD ARE NOT THE SAME ANSWER, and collapsing them is a
 * measured defect rather than a style point. ADR 0002 :131-132's "otherwise the
 * tombstone takes precedence" presupposes evidence FROM THIS RECORD'S rotation:
 * a transition that names a different head at this sequence really does prove no
 * valid descendant of the tombstone exists. Evidence from another authority
 * proves nothing about this record at all, and treating it as precedence lets an
 * unrelated object decide a tombstone's fate. Measured before the split: a
 * retained transition carrying a foreign `priorEvmIssuer` returned `accept`.
 */
export type AuthorityTransitionBindingV1 =
  | 'names-this-head'
  | 'names-another-head'
  | 'unrelated';

export function classifyAuthorityTransitionBindingV1(
  transition: AgentProfileAuthorityTransitionV1,
  priorHead: AgentProfileHeadObjectV1,
): AuthorityTransitionBindingV1 {
  const validatedTransition = validateAuthorityTransition(transition);
  const validatedPrior = validateAgentProfileHeadObjectV1(priorHead);
  // The record-and-rotation identity: who this transition belongs to and which
  // sequence it leaves. Every field here is about the AUTHORITY, not the head.
  if (
    validatedTransition.networkId !== validatedPrior.networkId ||
    validatedTransition.peerId !== validatedPrior.peerId ||
    validatedTransition.peerPublicKey !== validatedPrior.peerPublicKey ||
    validatedTransition.priorAuthoritySequence !== validatedPrior.authoritySequence ||
    validatedTransition.priorEvmIssuer !== validatedPrior.evmIssuer
  ) {
    return 'unrelated';
  }
  // Same authority, same sequence: now the head-level question.
  return validatedTransition.priorHeadDigest
    === computeAgentProfileHeadObjectDigestV1(validatedPrior)
    ? 'names-this-head'
    : 'names-another-head';
}

/**
 * THE PUBLISHED SIGNATURE KEEPS THE FULL UNION, and that is deliberate.
 *
 * This function is exported from the package barrel, so its declared return type
 * is a contract with consumers outside this repository. Narrowing it to the real
 * codomain -- which is what an earlier revision of this change did -- breaks
 * their source: a defensive `case 'quarantine':` stops compiling against a
 * narrower union even though no runtime value changed. That is a breaking change
 * and it does not belong in a fix.
 *
 * `evaluateAuthorityTransitionInternalV1` carries the precise type for callers
 * inside this package, so the seam can stay narrow without the published surface
 * moving. When the narrowing is wanted on the public entry it should be its own
 * change, in a release that says so.
 */
export function evaluateAuthorityTransitionV1(
  transition: AgentProfileAuthorityTransitionV1,
  priorHead: AgentProfileHeadObjectV1,
  nowMs: number,
): SystemRecordAuthorityDecisionV1 {
  return evaluateAuthorityTransitionInternalV1(transition, priorHead, nowMs);
}

/**
 * ACCEPT OR REJECT, never stale and never quarantine.
 *
 * Measured over its own body: one accept and six rejects. A caller narrowing its
 * own result would otherwise have to write arms for states that cannot arrive,
 * or launder them. This is the shape the late-tombstone rule consumes; it is NOT
 * exported from the package barrel.
 */
export function evaluateAuthorityTransitionInternalV1(
  transition: AgentProfileAuthorityTransitionV1,
  priorHead: AgentProfileHeadObjectV1,
  nowMs: number,
): Extract<SystemRecordAuthorityDecisionV1, { readonly decision: 'accept' | 'reject' }> {
  const validatedTransition = validateAuthorityTransition(transition);
  const validatedPrior = validateAgentProfileHeadObjectV1(priorHead);
  if (!isSafeNow(nowMs)) return { decision: 'reject', reason: 'verification clock is invalid' };
  if (isIssuedTooFarInFuture(validatedTransition.issuedAt, nowMs)) {
    return {
      decision: 'reject',
      reason: 'transition issuedAt exceeds the future clock-skew bound',
    };
  }
  if (classifyAuthorityTransitionBindingV1(validatedTransition, validatedPrior) !== 'names-this-head') {
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

export function validateAgentProfileForkResolutionEvidenceV1(
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

export function isSafeNow(nowMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0;
}

export function isIssuedTooFarInFuture(
  issuedAt: CanonicalRfc3339SecondsV1,
  nowMs: number,
): boolean {
  return Date.parse(issuedAt) > nowMs + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS;
}
