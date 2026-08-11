import {
  buildAgentProfileVerificationClosureV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  type AgentProfileHeadObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { VerdictDiffCellV1 } from './authority-verdict-diff-cells-v1.js';
import {
  buildCoreCandidateHeadV1,
  coreHeadShapeKeyV1,
  CORE_CHAIN_V1,
  CORE_CURRENT_HEAD_V1,
  CORE_EQUIVOCATING_TRANSITION_V1,
  CORE_FORK_CONFLICT_HEADS_V1,
  CORE_FORK_RESOLUTION_V1,
} from './authority-verdict-diff-core-heads-v1.js';

export { CORE_FORK_RESOLUTION_V1 } from './authority-verdict-diff-core-heads-v1.js';
import {
  buildSystemRecordClosureArtifactsV1,
  systemRecordClosureResolveOptionsV1,
} from './system-record-active-replacement-fixture.js';
import {
  mintAgentProfileTombstoneClosureV1,
  TERMINAL_FIXTURE_NOW_MS_V1,
} from './system-record-terminal-replacement-fixture.js';

/**
 * THE ACCEPTED-STATE AND EVIDENCE LAYERS OF THE CORE SWEEP.
 *
 * The candidate head layer (authority-verdict-diff-core-heads-v1.ts) supplies
 * one of core's three arguments. This supplies the other two: the accepted
 * authority state carrying axis I, and the evidence object carrying axes J and
 * L.
 *
 * WHAT AXIS J ACTUALLY VARIES, AND WHY THE VALUES ARE THE CORRECT ONES.
 * Axis J is a PRESENCE axis: each of the six optional members is either supplied
 * or omitted. That leaves the fixture to choose WHAT to supply, and the choice
 * is load-bearing in a direction that is easy to get wrong. Supplying
 * deliberately ill-fitting values would collapse every J-present cell onto the
 * same refusal and the table would then measure the fixture's wrongness rather
 * than the evaluator's discrimination. So each member is supplied with the value
 * that branch actually asks for, and each choice below is justified against the
 * site that reads it -- not chosen for convenience.
 */

/**
 * The retained lineage of the accepted state.
 *
 * Length MUST equal the current head's authority sequence (2) and the last
 * entry's digest MUST be the current's `acceptedTransitionDigest`, or the
 * evaluator returns at :121 / :127 before reaching any branch this table is
 * about -- every cell would carry the same reject and the sweep would measure
 * one guard 25,920 times while looking complete.
 *
 * Each digest is COMPUTED FROM ITS TRANSITION. Reading it off an ancestor head
 * instead yields `undefined` on the first entry and throws
 * '[system-record-scalar] transitionDigest is invalid' -- measured, not guessed.
 */
export const CORE_ACCEPTED_LINEAGE_V1 = Object.freeze(
  CORE_CHAIN_V1.transitions.map((transition) => Object.freeze({
    priorAuthoritySequence: transition.priorAuthoritySequence,
    nextAuthoritySequence: transition.nextAuthoritySequence,
    transitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
  })),
);

/**
 * The prior roots, in authority-sequence order, excluding the current's own.
 *
 * `validateAcceptedRootHistoryV1` (:684) requires exactly one root per lineage
 * entry, all distinct, none equal to the current head's `rootSubject`. Every
 * rotation moves the root, so the ancestors supply them; `ancestors` is stored
 * newest-first, hence the reverse.
 */
export const CORE_HISTORICAL_ROOTS_V1 = Object.freeze(
  [...CORE_CHAIN_V1.ancestors].reverse().map((head) => head.rootSubject),
);

/**
 * Axis L as concrete clocks, named for what each was MEASURED to do rather than
 * for what it was intended to do.
 *
 * `valid` is the fixture clock every head and transition here is issued against.
 * `beyondFutureSkew` sits far enough before the candidate's `issuedAt` that
 * `isIssuedTooFarInFuture` fires at :98. `priorExpirySkewUnmet` sits between the
 * two, exercising the transition-time gate inside `evaluateAuthorityTransitionV1`
 * without tripping the candidate's own future bound.
 *
 * The sweep pins which verdicts each value actually produces, so a clock that
 * turns out to change nothing is recorded as an inert axis value rather than
 * described as an active one by its name alone.
 */
export const CORE_CLOCK_MS_V1: Readonly<Record<VerdictDiffCellV1['clock'], number>> = Object.freeze({
  valid: TERMINAL_FIXTURE_NOW_MS_V1,
  beyondFutureSkew: Date.parse('2026-07-01T00:00:00Z'),
  priorExpirySkewUnmet: Date.parse('2026-08-05T12:02:30Z'),
});

/**
 * The transition supplied when axis J names `acceptedTransition`.
 *
 * This is the REAL 1->2 transition, and it is the correct choice rather than an
 * arbitrary one: on the lower-sequence path the candidate sits at sequence 1, so
 * :295 retains `lineage[1]` and :303-305 demands a transition agreeing with it
 * on prior sequence, next sequence AND digest. Only this object satisfies that.
 * On the next-sequence path :336 compares its digest to the candidate's
 * `acceptedTransitionDigest`, which axis G ties to the current head's -- the same
 * digest -- so presence is decision-changing there too.
 */
export const CORE_ACCEPTED_TRANSITION_V1 = CORE_CHAIN_V1.transitions[
  CORE_CHAIN_V1.transitions.length - 1
];

/**
 * The predecessor supplied when axis J names `tombstonePredecessor`.
 *
 * `isTombstoneBoundToPredecessorV1` requires the tombstone's
 * `previousHeadDigest` to be the predecessor's digest. The candidate builder
 * points every non-digest-equal candidate at `CORE_CURRENT_DIGEST_V1`, so the
 * current head is the ONLY object that can satisfy that conjunct -- any other
 * choice would make the member's presence meaningless.
 */
export const CORE_TOMBSTONE_PREDECESSOR_V1 = CORE_CURRENT_HEAD_V1;

/**
 * The fork evidence. The resolution and the conflicting heads live with the head
 * layer because axis K's digest is computed FROM the resolution -- one object,
 * one digest, no chance of the head naming a resolution the evidence does not
 * supply.
 *
 * THE FORK BRANCH IS UNREACHABLE UNDER THIS AXIS SET, and the arithmetic is
 * worth stating because nothing throws to announce it: :456 forces
 * forkedVersion == current.version; the control codec forces resolutionVersion >
 * forkedVersion (:262); :458 forces the candidate's version > resolutionVersion.
 * So the branch needs a candidate at least TWO versions above the current, while
 * axis E's largest value is exactly ONE above. The resolution is supplied
 * well-formed regardless, so these cells measure the refusal core really gives
 * rather than one manufactured by handing it invalid evidence.
 */
export const CORE_FORK_EVIDENCE_HEADS_V1: readonly AgentProfileHeadObjectV1[] =
  CORE_FORK_CONFLICT_HEADS_V1;
export const CORE_FORK_BASE_HEAD_V1: AgentProfileHeadObjectV1 = CORE_CURRENT_HEAD_V1;

/**
 * The accepted authority state a cell names.
 *
 * An ABSENT snapshot carries neither lineage nor root history: :217 refuses a
 * non-discoverable disposition or a non-empty lineage, and :679 refuses retained
 * roots. Those refusals are VERDICTS, not construction failures -- axis I is
 * free to name a quarantined disposition there and the table records what core
 * decides about it.
 */
export function buildCoreAcceptedStateV1(cell: VerdictDiffCellV1) {
  return cell.snapshot === 'absent'
    ? {
      disposition: cell.coreDisposition,
      transitionLineage: [],
      historicalRoots: [],
    }
    : {
      current: CORE_CURRENT_HEAD_V1,
      disposition: cell.coreDisposition,
      transitionLineage: CORE_ACCEPTED_LINEAGE_V1,
      historicalRoots: CORE_HISTORICAL_ROOTS_V1,
    };
}

export interface CoreSummaryRefusalV1 {
  readonly minted: false;
  readonly message: string;
}
export interface CoreSummaryMintV1 {
  readonly minted: true;
  readonly summary: unknown;
}

/**
 * Mints one verified authority summary per candidate head SHAPE.
 *
 * A summary is a WeakSet-branded, factory-only capability: it cannot be
 * fabricated, so a cell naming `verifiedAuthoritySummary` can only exist if the
 * closure builder will mint one for that head. Where it refuses, the refusal is
 * a construction result carrying the builder's own message -- recorded, never
 * swallowed as a skipped case.
 *
 * Keyed on the shape rather than the cell because the summary depends only on
 * the candidate head and its lineage, which is what keeps 25,920 projections to
 * a few dozen mints.
 */
export async function buildCoreSummaryIndexV1(
  cells: readonly VerdictDiffCellV1[],
): Promise<ReadonlyMap<string, CoreSummaryMintV1 | CoreSummaryRefusalV1>> {
  const index = new Map<string, CoreSummaryMintV1 | CoreSummaryRefusalV1>();
  for (const cell of cells) {
    const shapeKey = coreHeadShapeKeyV1(cell);
    if (index.has(shapeKey)) continue;
    const build = buildCoreCandidateHeadV1(cell);
    if (!build.built) continue;
    index.set(shapeKey, await mintForHeadV1(build.candidate));
  }
  return index;
}

async function mintForHeadV1(
  candidate: AgentProfileHeadObjectV1,
): Promise<CoreSummaryMintV1 | CoreSummaryRefusalV1> {
  // The walk follows previousHeadDigest and the transitions, so the current head
  // AND the chain base must both be resolvable: the current's own
  // previousHeadDigest names the base. Omitting the base is not a domain refusal
  // -- it surfaces as a TypeError inside the collector, which reads like a code
  // defect rather than a missing artifact.
  const ancestry = [
    CORE_CURRENT_HEAD_V1,
    CORE_CHAIN_V1.base,
    ...CORE_CHAIN_V1.ancestors,
    ...CORE_FORK_CONFLICT_HEADS_V1,
  ];
  // Every digest a head NAMES has to be resolvable, or the closure refuses with
  // a missing-object message that reads exactly like a domain refusal while
  // being nothing but a gap in this map. Axis G='differ' names the competing
  // transition and axis K='present' names the fork resolution, so both travel
  // with the ancestry rather than being left for the collector to miss.
  const transitions = [...CORE_CHAIN_V1.transitions, CORE_EQUIVOCATING_TRANSITION_V1];
  try {
    if ((candidate as { state: string }).state === 'tombstone') {
      const closure = await mintAgentProfileTombstoneClosureV1({
        tombstone: candidate,
        predecessor: CORE_TOMBSTONE_PREDECESSOR_V1,
        ownedSubjectTable: [CORE_TOMBSTONE_PREDECESSOR_V1.rootSubject],
        ancestors: ancestry,
        transitions,
      });
      return { minted: true, summary: closure.authoritySummary };
    }
    const artifacts = buildSystemRecordClosureArtifactsV1(
      [candidate, ...ancestry],
      CORE_FORK_RESOLUTION_V1,
      transitions,
    );
    const closure = await buildAgentProfileVerificationClosureV1(
      computeAgentProfileHeadObjectDigestV1(candidate),
      systemRecordClosureResolveOptionsV1(artifacts, TERMINAL_FIXTURE_NOW_MS_V1) as never,
    );
    return { minted: true, summary: closure.authoritySummary };
  } catch (error) {
    return { minted: false, message: String((error as { message?: string }).message) };
  }
}

export interface CoreEvidenceRefusalV1 {
  readonly built: false;
  readonly ruleId: string;
  readonly message: string;
}
export interface CoreEvidenceBuildV1 {
  readonly built: true;
  readonly evidence: Record<string, unknown>;
}

/**
 * The evidence object a cell names, or the rule that refuses it.
 *
 * The only refusal here is an unmintable summary. Every other member is plain
 * data the fixture always holds, so axis J is otherwise total.
 */
export function buildCoreEvidenceV1(
  cell: VerdictDiffCellV1,
  summaries: ReadonlyMap<string, CoreSummaryMintV1 | CoreSummaryRefusalV1>,
): CoreEvidenceBuildV1 | CoreEvidenceRefusalV1 {
  const evidence: Record<string, unknown> = { nowMs: CORE_CLOCK_MS_V1[cell.clock] };
  const wants = new Set(cell.evidence);
  if (wants.has('acceptedTransition')) evidence.acceptedTransition = CORE_ACCEPTED_TRANSITION_V1;
  if (wants.has('tombstonePredecessor')) {
    evidence.tombstonePredecessor = CORE_TOMBSTONE_PREDECESSOR_V1;
  }
  if (wants.has('forkResolution')) evidence.forkResolution = CORE_FORK_RESOLUTION_V1;
  if (wants.has('forkEvidenceHeads')) evidence.forkEvidenceHeads = CORE_FORK_EVIDENCE_HEADS_V1;
  if (wants.has('forkBaseHead')) evidence.forkBaseHead = CORE_FORK_BASE_HEAD_V1;
  if (wants.has('verifiedAuthoritySummary')) {
    const mint = summaries.get(coreHeadShapeKeyV1(cell));
    if (mint === undefined || !mint.minted) {
      return {
        built: false,
        ruleId: 'S1-verified-authority-summary-is-unmintable-for-this-head',
        message: mint === undefined ? 'no candidate head for this shape' : mint.message,
      };
    }
    evidence.verifiedAuthoritySummary = mint.summary;
  }
  return { built: true, evidence };
}
