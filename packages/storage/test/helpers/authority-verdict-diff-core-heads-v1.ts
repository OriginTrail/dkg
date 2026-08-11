import {
  assertAgentProfileHeadObjectV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { VerdictDiffCellV1 } from './authority-verdict-diff-cells-v1.js';
import { makeRotatedAuthorityChainV1 } from './system-record-active-replacement-fixture.js';

/** The wallet root the competing transition rotates to; not on the real chain. */
const EQUIVOCATING_ISSUER = `0x${'77'.repeat(20)}`;

/**
 * THE CANDIDATE-HEAD LAYER OF THE CORE SWEEP.
 *
 * Core's evaluator takes (accepted, candidate, evidence). Only the two HEADS are
 * built here, because they are where the head codec's welds bite and therefore
 * where cells stop being constructible. Evidence presence (axis J) and the
 * clock (axis L) never fail construction -- they are verdict territory.
 *
 * THE HEAD SHAPE IS THE MEMOISATION KEY. A minted authority summary depends only
 * on the candidate head and its predecessor, so it is shared across every cell
 * with the same shape. The shaping axes are C, D, E, F, G and K only: axes I, J
 * and L multiply CELLS without multiplying MINTS, which is what makes 164,160
 * cells cost 25,920 evaluations over a few dozen distinct heads.
 *
 * WHY THE CURRENT HEAD IS NON-GENESIS, AND WHY IT COSTS A ROTATION. Axis D needs
 * a 'below' sequence and axis E needs a 'below' version, so the current head must
 * sit above zero on both. Axis G compares the candidate's acceptedTransitionDigest
 * to the current's, so the current must HAVE one -- and a head only has one above
 * authority sequence zero, where the codec requires it (:197). A sequence above
 * zero requires a real authority transition, and a transition must rotate to a
 * new wallet root, so the current head here is a ROTATED head with a rebuilt
 * author seal and a re-derived owned-subject table. None of that is optional: an
 * edited genesis head is refused with 'graph-scoped seal author must equal
 * evmIssuer' before any of these axes can be expressed.
 */

const CHAIN = makeRotatedAuthorityChainV1(2);

/**
 * The accepted CURRENT head: authority sequence 2, version 2.
 *
 * Both coordinates are deliberately mid-range so every relation has room on
 * BOTH sides -- sequence 1/2/3/4 serve axis D and version 1/2/3 serve axis E,
 * and none of them collides with zero. Version 2 requires `previousHeadDigest`
 * (:206), which the genesis chain base does not carry.
 */
export const CORE_CURRENT_HEAD_V1: AgentProfileActiveHeadObjectV1 = Object.freeze({
  ...CHAIN.base,
  version: '2',
  previousHeadDigest: computeAgentProfileHeadObjectDigestV1(CHAIN.base),
}) as AgentProfileActiveHeadObjectV1;

export const CORE_CURRENT_DIGEST_V1 = computeAgentProfileHeadObjectDigestV1(CORE_CURRENT_HEAD_V1);
export const CORE_CURRENT_SEQUENCE_V1 = BigInt(CORE_CURRENT_HEAD_V1.authoritySequence);
export const CORE_CURRENT_VERSION_V1 = BigInt(CORE_CURRENT_HEAD_V1.version);
export const CORE_CHAIN_V1 = CHAIN;

/**
 * Axis G's 'differ' value: a REAL competing transition into the current's own
 * authority sequence, rotating to a different wallet root.
 *
 * It is a real object rather than a well-formed constant, and the difference is
 * not cosmetic. A verification closure RESOLVES every digest a head names, so a
 * head naming an invented transition digest is refused with
 * '[system-record-closure] verification closure is missing 0x...' -- a refusal
 * produced by the fixture's own omission, not by the system. Measured before
 * this was fixed: 18 of 40 buildable head shapes were refused that way, which
 * would have retired roughly 46,000 cells while every count summed and every
 * citation quoted a real message from a real site.
 *
 * A competing rotation is also what axis G's 'differ' MEANS: two transitions out
 * of the same prior head into the same sequence is transition equivocation,
 * which is the decision the axis exists to reach.
 */
export const CORE_EQUIVOCATING_TRANSITION_V1 = Object.freeze({
  ...CHAIN.transitions[CHAIN.transitions.length - 1],
  nextEvmIssuer: EQUIVOCATING_ISSUER,
  nextRoot: `did:dkg:agent:${EQUIVOCATING_ISSUER}`,
}) as AgentProfileAuthorityTransitionV1;

export const CORE_OTHER_TRANSITION_DIGEST_V1 = computeAgentProfileAuthorityTransitionDigestV1(
  CORE_EQUIVOCATING_TRANSITION_V1,
);

/** Two same-sequence conflicting heads -- the evidence a fork resolution names. */
export const CORE_FORK_CONFLICT_HEADS_V1: readonly AgentProfileActiveHeadObjectV1[] = Object.freeze(
  ['12:07:00Z', '12:08:00Z'].map((time) => Object.freeze({
    ...CHAIN.base,
    version: '2',
    previousHeadDigest: computeAgentProfileHeadObjectDigestV1(CHAIN.base),
    issuedAt: `2026-08-05T${time}`,
  }) as AgentProfileActiveHeadObjectV1),
);

/**
 * Axis K's 'present' value, as a REAL fork resolution over the current frontier
 * -- same reason as the transition above: the closure resolves what the head
 * names, and 7 further shapes were being refused for a missing 0xcdcd... object.
 *
 * `forkedVersion` is the current's version because core :456 refuses anything
 * else; `resolutionVersion` is one above it because the control codec refuses
 * `resolutionVersion <= forkedVersion` (:262).
 */
export const CORE_FORK_RESOLUTION_V1 = Object.freeze({
  objectType: 'fork-resolution',
  kind: 'agents',
  networkId: CORE_CURRENT_HEAD_V1.networkId,
  peerId: CORE_CURRENT_HEAD_V1.peerId,
  peerPublicKey: CORE_CURRENT_HEAD_V1.peerPublicKey,
  evmIssuer: CORE_CURRENT_HEAD_V1.evmIssuer,
  authoritySequence: CORE_CURRENT_HEAD_V1.authoritySequence,
  forkedVersion: CORE_CURRENT_HEAD_V1.version,
  resolutionVersion: String(BigInt(CORE_CURRENT_HEAD_V1.version) + 1n),
  // The base must be a verified LOWER head of the same authority, so it is the
  // chain base at version zero -- not the current head, which sits AT the forked
  // version and is refused as a base by the closure collector.
  forkBaseHeadDigest: computeAgentProfileHeadObjectDigestV1(CHAIN.base),
  evidenceHeadDigests: Object.freeze(
    CORE_FORK_CONFLICT_HEADS_V1.map(computeAgentProfileHeadObjectDigestV1).sort(),
  ),
  issuedAt: '2026-08-05T12:05:00Z',
}) as unknown as AgentProfileForkResolutionV1;

export const CORE_FORK_RESOLUTION_DIGEST_V1 = computeAgentProfileForkResolutionDigestV1(
  CORE_FORK_RESOLUTION_V1,
);

/** The candidate's authority sequence for each axis-D value. */
function candidateSequence(relation: VerdictDiffCellV1['sequenceRelation']): bigint {
  switch (relation) {
    case 'below': return CORE_CURRENT_SEQUENCE_V1 - 1n;
    case 'equal': return CORE_CURRENT_SEQUENCE_V1;
    case 'plusOne': return CORE_CURRENT_SEQUENCE_V1 + 1n;
    case 'abovePlusOne': return CORE_CURRENT_SEQUENCE_V1 + 2n;
    // An absent snapshot has no referent, so the candidate stands alone. It is
    // put at the current's sequence rather than at zero so the absent region
    // exercises a noninitial head, which is the branch with the interesting
    // verdicts -- an initial one short-circuits to accept at :228.
    default: return CORE_CURRENT_SEQUENCE_V1;
  }
}

function candidateVersion(cell: VerdictDiffCellV1): bigint {
  switch (cell.versionRelation) {
    case 'below': return CORE_CURRENT_VERSION_V1 - 1n;
    case 'equal': return CORE_CURRENT_VERSION_V1;
    case 'above': return CORE_CURRENT_VERSION_V1 + 1n;
    // Where axis E does not apply the version is free; 1 keeps the head
    // noninitial without colliding with the current's own version.
    default: return 1n;
  }
}

export interface CoreHeadRefusalV1 {
  readonly built: false;
  /** The rule id that owns this refusal, so a retirement is never anonymous. */
  readonly ruleId: string;
  readonly message: string;
}

export interface CoreHeadBuildV1 {
  readonly built: true;
  readonly candidate: AgentProfileHeadObjectV1;
  readonly digest: string;
  /** Distinct heads sharing this key are byte-identical, so mints memoise on it. */
  readonly shapeKey: string;
}

/**
 * The shape key: exactly the axes that reach the candidate head.
 *
 * Derived from the cell rather than from the built head on purpose. Deriving it
 * from the head would make it agree with the head by construction and could
 * never detect a builder that ignored an axis -- the same self-reference that
 * makes a count computed from the generator worthless as a pin.
 */
export function coreHeadShapeKeyV1(cell: VerdictDiffCellV1): string {
  return [
    cell.snapshot,
    cell.candidateHeadState,
    cell.sequenceRelation ?? '-',
    cell.versionRelation ?? '-',
    cell.headDigest ?? '-',
    cell.acceptedTransitionDigest ?? '-',
    cell.candidateForkResolutionDigest,
  ].join('|');
}

/**
 * Builds the candidate head a cell names, or names the rule that refuses it.
 *
 * THE REFUSALS HERE ARE OF TWO KINDS AND THE DISTINCTION IS LOAD-BEARING.
 *
 * Most are SITE refusals: the head codec throws, and the rule quotes the string
 * that site emits. Those look like every other rule in this harness.
 *
 * Axis F's are not. `headDigest: 'equal'` says the candidate hashes to the
 * current's digest, and a digest covers the whole head -- so a candidate can
 * only be digest-equal to the current by BEING the current, field for field.
 * Any cell asking for digest equality AND a different state, transition digest
 * or fork-resolution presence is asking for two things that cannot both be true
 * of one object. Nothing throws; the combination is simply contradictory.
 *
 * These are recorded as their own rule class rather than folded in with the
 * codec refusals, because a contradiction rule cannot cite a failure string and
 * pretending otherwise would mean inventing one. What it CAN do is demonstrate
 * the contradiction -- build the head the other axis asks for and show the
 * digest moves -- which is what the sweep's own test does with them.
 */
export function buildCoreCandidateHeadV1(
  cell: VerdictDiffCellV1,
): CoreHeadBuildV1 | CoreHeadRefusalV1 {
  const digestEqual = cell.headDigest === 'equal';

  if (digestEqual && cell.candidateHeadState !== CORE_CURRENT_HEAD_V1.state) {
    return {
      built: false,
      ruleId: 'F1-digest-equality-forces-the-current-state',
      message: 'a head digest-equal to the current must BE the current, which is active',
    };
  }
  if (digestEqual && cell.acceptedTransitionDigest === 'differ') {
    return {
      built: false,
      ruleId: 'F2-digest-equality-forces-the-current-transition-digest',
      message: 'a head digest-equal to the current cannot differ on any committed field',
    };
  }
  if (digestEqual && cell.candidateForkResolutionDigest === 'present') {
    return {
      built: false,
      ruleId: 'F3-digest-equality-forces-the-current-fork-resolution-absence',
      message: 'a head digest-equal to the current cannot carry a key the current omits',
    };
  }
  if (digestEqual) {
    return {
      built: true,
      candidate: CORE_CURRENT_HEAD_V1,
      digest: CORE_CURRENT_DIGEST_V1,
      shapeKey: coreHeadShapeKeyV1(cell),
    };
  }

  const sequence = candidateSequence(cell.sequenceRelation);
  const version = candidateVersion(cell);
  const transitionDigest = cell.acceptedTransitionDigest === 'differ'
    ? CORE_OTHER_TRANSITION_DIGEST_V1
    : CORE_CURRENT_HEAD_V1.acceptedTransitionDigest;

  const base: Record<string, unknown> = {
    ...structuredClone(CHAIN.base),
    authoritySequence: String(sequence),
    version: String(version),
    acceptedTransitionDigest: transitionDigest,
    // A noninitial head requires its predecessor link (:206); the current head
    // is a real one that mints, which keeps this a history reference rather
    // than a placeholder the codec would reject.
    previousHeadDigest: CORE_CURRENT_DIGEST_V1,
    // Differ from the current by issue time, which moves the digest without
    // touching any field an axis pins. Perturbing an axis-owned field instead
    // would make axis F's 'differ' silently duplicate another axis.
    issuedAt: '2026-08-05T12:06:00Z',
  };
  if (cell.candidateForkResolutionDigest === 'present') {
    base.forkResolutionDigest = CORE_FORK_RESOLUTION_DIGEST_V1;
  }

  const head = cell.candidateHeadState === 'tombstone'
    ? tombstoneShape(base)
    : base;

  try {
    assertAgentProfileHeadObjectV1(head as never);
  } catch (error) {
    return {
      built: false,
      ruleId: 'H1-head-codec-refuses-the-shape',
      message: String((error as { message?: string }).message),
    };
  }
  return {
    built: true,
    candidate: head as unknown as AgentProfileHeadObjectV1,
    digest: computeAgentProfileHeadObjectDigestV1(head as never),
    shapeKey: coreHeadShapeKeyV1(cell),
  };
}

/**
 * The tombstone obligations, applied rather than left to fail.
 *
 * These are FIXTURE OBLIGATIONS, not rules: no axis names a projection count or
 * a subject-table digest, so the builder satisfies them and no cell is retired
 * by them. Recorded here so the distinction stays visible -- a builder that let
 * them throw would manufacture retirements out of its own omissions.
 */
function tombstoneShape(base: Record<string, unknown>): Record<string, unknown> {
  const shaped: Record<string, unknown> = {
    ...base,
    state: 'tombstone',
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0',
    projectionBytes: '0',
    projectionQuads: '0',
  };
  // A tombstone commits none of the active head's projection or seal fields.
  for (const key of [
    'contentDigest', 'bundleDigest', 'graphScopedAuthorSeal', 'validUntil',
    'assertionCoordinate',
  ]) {
    delete shaped[key];
  }
  return shaped;
}
