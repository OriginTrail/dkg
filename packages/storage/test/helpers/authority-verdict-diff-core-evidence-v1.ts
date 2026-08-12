import {
  buildAgentProfileVerificationClosureV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileHeadObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { VerdictDiffCellV1 } from './authority-verdict-diff-cells-v1.js';
import {
  buildCoreCandidateHeadV1,
  coreHeadShapeKeyV1,
  coreCandidateSequenceV1,
  coreSequenceActiveHeadV1,
  coreSequenceTransitionV1,
  CORE_MINT_GRAPH_V1,
  CORE_CHAIN_V1,
  CORE_CURRENT_HEAD_V1,
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
 * The transition supplied when axis J names `acceptedTransition`, SELECTED PER
 * CANDIDATE SEQUENCE.
 *
 * THIS WAS A SINGLE CONSTANT AND IT WAS WRONG THE MOMENT AXIS D GAINED
 * PER-SEQUENCE LINEAGE. It was the 1->2 transition for every cell, and the old
 * doc justified that with: "on the next-sequence path :336 compares its digest
 * to the candidate's acceptedTransitionDigest, which axis G ties to the current
 * head's -- the same digest." Axis G is now SEQUENCE-RELATIVE, so that premise
 * is false: a candidate at sequence 3 carries the 2->3 digest while this handed
 * core the 1->2. The comment documented its own breakage, and the effect was the
 * fixture's mismatch recorded as a system verdict on the axis-J-present half of
 * the sequence-relative region.
 *
 * WHICH OBJECT EACH PATH DEMANDS, read at the sites rather than inferred. On the
 * LOWER-sequence path :295 retains `lineage[candidateSequence]` and :303-305
 * demands a transition agreeing with it on prior sequence, next sequence AND
 * digest. On the NEXT-sequence path :336 compares the supplied transition's
 * digest to the candidate's own `acceptedTransitionDigest`. Both questions are
 * about the candidate's OWN sequence, so both are answered by the rotation INTO
 * that sequence -- which is exactly what the candidate names.
 *
 * Supplying the transition the candidate actually names is what makes the
 * member's PRESENCE decision-changing rather than uniformly refusing: a
 * mismatched transition collapses every J-present cell in the region onto one
 * refusal and measures this fixture's wrongness instead of core's
 * discrimination. Found by review, not by the derivation -- a derivation checks
 * counts and cannot check evidence fidelity.
 */
export function coreAcceptedTransitionV1(
  cell: VerdictDiffCellV1,
): AgentProfileAuthorityTransitionV1 {
  return coreSequenceTransitionV1(coreCandidateSequenceV1(cell));
}

/**
 * The predecessor supplied when axis J names `tombstonePredecessor`.
 *
 * `isTombstoneBoundToPredecessorV1` requires the tombstone's
 * `previousHeadDigest` to be the predecessor's digest, so the member is only
 * meaningful when it is the head the candidate actually descends from. That
 * used to be `CORE_CURRENT_HEAD_V1` for every cell, because the builder pointed
 * every candidate at the current head. Now that a candidate descends from the
 * active head at its OWN authority sequence, so does this -- otherwise every
 * sequence-relative J-present cell would collapse onto one refusal and the table
 * would measure the fixture's wrongness instead of core's discrimination.
 *
 * The absent-snapshot region keeps the current head: its candidates sit at the
 * current sequence, so the two agree there by construction rather than by
 * coincidence.
 */
export function coreTombstonePredecessorV1(
  cell: VerdictDiffCellV1,
): AgentProfileHeadObjectV1 {
  // The sequence comes from the CELL, not from a built head. Building the
  // candidate here to read one field back off it cost a head build per cell,
  // which the projection-equivalence suite pays for every constructible cell --
  // measured as most of this lane's CI budget. The two are asserted equal over
  // every buildable shape in the core-heads suite.
  return coreSequenceActiveHeadV1(coreCandidateSequenceV1(cell));
}

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
/**
 * BOTH OF THESE, AND `CORE_FORK_RESOLUTION_V1`, EMBED SEQUENCE-2 VALUES AND ARE
 * SUPPLIED AT EVERY SEQUENCE. READ THIS BEFORE MAKING THE FORK BRANCH REACHABLE.
 *
 * The class sweep over every cell-driving constant classified these three as
 * SEQUENCE-DEPENDENT: `CORE_FORK_RESOLUTION_V1` carries the current head's
 * `evmIssuer`, `authoritySequence`, `forkedVersion` and `resolutionVersion` plus
 * a `forkBaseHeadDigest` off the chain base; the conflict heads are built from
 * the chain base at version 2; and the fork base head IS the current head. A
 * rotation moves `evmIssuer` and the root subject, so at any other sequence
 * these objects do not describe the candidate they are handed to.
 *
 * THEY ARE NOT FIXED HERE BECAUSE THEY ARE MEASURABLY INERT, NOT BECAUSE THE
 * MISMATCH IS ACCEPTABLE. Measured through the exported entry, present-vs-absent
 * over one representative per core projection in the sequence-relative region:
 * forkResolution 0 of 5,184 projections moved, forkEvidenceHeads 0 of 5,184,
 * forkBaseHead 0 of 5,184, and ALL THREE dropped together 0 of 9,072 -- the
 * joint row included because individually-inert members can mask one another.
 * Positive control on the same instrument: 72 of 600 moved. So the zero is the
 * region's and not the comparison's.
 *
 * WHY IT IS ZERO, which is also the condition under which it STOPS being zero:
 * these members feed core's fork-resolution-successor branch, and that branch is
 * unreachable under this axis set -- :456 forces forkedVersion == current.version,
 * the control codec forces resolutionVersion > forkedVersion, and :458 forces the
 * candidate above that, so it needs a candidate two versions above the current
 * while axis E reaches one. A branch nothing reaches cannot be moved by the
 * objects it would have read.
 *
 * THE MOMENT AXIS K='present' MAKES THAT BRANCH REACHABLE, THESE THREE BECOME
 * LIVE AND THEIR SEQUENCE-DEPENDENCE BECOMES A REAL DEFECT -- a fixture-authored
 * mismatch recorded as a system verdict, which is the class this fixture has met
 * four times. Whoever does that work must make them per-sequence in the same
 * change, alongside the per-sequence resolution and its own evidence heads that
 * `isDirectResolvingSuccessorV1`'s identity conjuncts require.
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
 * The mint index, and the audit that says WHOSE refusals are in it.
 *
 * `unresolvedArtifacts` names every `objectKind:digest` the closure walk asked
 * for while minting and this fixture could not answer. It is a MECHANISM
 * record rather than a message record, and the distinction is the whole reason
 * it exists: a refusal reached through an unanswered lookup is this harness's
 * own omission wearing a domain refusal's wording, and no amount of reading the
 * message tells the two apart.
 */
export interface CoreSummaryIndexV1 {
  readonly summaries: ReadonlyMap<string, CoreSummaryMintV1 | CoreSummaryRefusalV1>;
  readonly unresolvedArtifacts: readonly string[];
}

/**
 * Mints one verified authority summary per candidate head SHAPE.
 *
 * A summary is a WeakSet-branded, factory-only capability: it cannot be
 * fabricated, so a cell naming `verifiedAuthoritySummary` receives one only
 * where the closure builder will mint one for that head. Where it refuses, the
 * refusal is recorded with the builder's own message rather than swallowed --
 * and audited, because a refusal and a missing artifact read alike.
 *
 * Keyed on the shape rather than the cell because the summary depends only on
 * the candidate head and its lineage, which is what keeps 25,920 projections to
 * a few dozen mints.
 */
export async function buildCoreSummaryIndexV1(
  cells: readonly VerdictDiffCellV1[],
): Promise<CoreSummaryIndexV1> {
  const summaries = new Map<string, CoreSummaryMintV1 | CoreSummaryRefusalV1>();
  const unresolved = new Set<string>();
  for (const cell of cells) {
    const shapeKey = coreHeadShapeKeyV1(cell);
    if (summaries.has(shapeKey)) continue;
    const build = buildCoreCandidateHeadV1(cell);
    if (!build.built) continue;
    summaries.set(shapeKey, await mintForHeadV1(build.candidate, (key) => unresolved.add(key)));
  }
  return { summaries, unresolvedArtifacts: [...unresolved].sort() };
}

async function mintForHeadV1(
  candidate: AgentProfileHeadObjectV1,
  onUnresolved: (reference: string) => void,
): Promise<CoreSummaryMintV1 | CoreSummaryRefusalV1> {
  // The walk follows previousHeadDigest and the transitions, so the current head
  // AND the chain base must both be resolvable: the current's own
  // previousHeadDigest names the base. Omitting the base is not a domain refusal
  // -- it surfaces as a TypeError inside the collector, which reads like a code
  // defect rather than a missing artifact.
  // The shared graph, not a local reproduction of it -- see CORE_MINT_GRAPH_V1.
  const ancestry = CORE_MINT_GRAPH_V1.ancestry;
  // Every digest a head NAMES has to be resolvable, or the closure refuses with
  // a missing-object message that reads exactly like a domain refusal while
  // being nothing but a gap in this map. Axis G='differ' names the competing
  // transition and axis K='present' names the fork resolution, so both travel
  // with the ancestry rather than being left for the collector to miss.
  // Every rotation the fixture can present -- the four real ones and the four
  // competing ones. A candidate at any sequence names one of them, and a digest
  // a head names that this map cannot answer is refused with wording that reads
  // exactly like a domain refusal.
  const transitions = [...CORE_MINT_GRAPH_V1.transitions];
  try {
    if ((candidate as { state: string }).state === 'tombstone') {
      // The predecessor is the active head at the TOMBSTONE'S OWN sequence, and
      // the deletion table is that head's. Holding the current head's table for
      // every candidate makes the closure ask for an owned-subject-table digest
      // this fixture never supplies, which surfaces as
      // 'verification closure is missing 0x...' -- the harness's own omission in
      // a domain refusal's clothing, and the exact shape that once retired
      // ~46,000 cells with every count summing.
      const { predecessor, ownedSubjectTable } =
        CORE_MINT_GRAPH_V1.tombstonePredecessorFor(candidate.authoritySequence);
      const closure = await mintAgentProfileTombstoneClosureV1({
        tombstone: candidate,
        predecessor,
        ownedSubjectTable: [...ownedSubjectTable],
        ancestors: ancestry,
        transitions,
        onUnresolvedArtifact: onUnresolved,
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
      systemRecordClosureResolveOptionsV1(
        artifacts,
        TERMINAL_FIXTURE_NOW_MS_V1,
        onUnresolved,
      ) as never,
    );
    return { minted: true, summary: closure.authoritySummary };
  } catch (error) {
    return { minted: false, message: String((error as { message?: string }).message) };
  }
}

/**
 * The evidence object a cell names. AXIS J IS TOTAL: every member is data this
 * fixture always holds, so nothing in this layer retires a cell.
 *
 * WHY AN UNMINTABLE SUMMARY IS OMITTED RATHER THAN REFUSED. Until this rule was
 * removed, a cell naming `verifiedAuthoritySummary` whose head shape could not
 * mint one was retired here -- rule S1, 61,920 cells, 38% of the space. The
 * rule was wrong, and wrong in the direction this harness exists to catch: a
 * summary is a factory-only capability, so a REAL caller holding an unmintable
 * head has exactly one evidence object it can assemble, the one WITHOUT that
 * member. The cell was always instantiable; the harness was declining to build
 * the only form it has, and then pinning the decline as though it were the
 * system's.
 *
 * OMITTING DOES NOT MOVE THE VERDICT, AND THAT IS MEASURED RATHER THAN ARGUED.
 * All 9,792 affected projections were driven twice -- once with a summary minted
 * for a DIFFERENT head, once with the member absent -- and the verdicts were
 * identical 9,792/9,792 with zero throws, against two discrimination controls
 * that prove the instrument is not simply blind. The result is pinned as
 * CORE_SUMMARY_INDEPENDENCE_V1 and re-run by
 * authority-verdict-diff-summary-independence-v1.test.ts.
 *
 * NO FOREIGN SUBSTITUTE, ON EITHER PATH. Handing a cell a summary minted for
 * another head would pin evidence no caller could ever assemble, which is the
 * same error S1 made from the other side. On the absent path the omission
 * yields reject('cold noninitial head requires its verified authority closure')
 * at core :237 -- an honest verdict the table already carries as its own row.
 */
export function buildCoreEvidenceV1(
  cell: VerdictDiffCellV1,
  summaries: ReadonlyMap<string, CoreSummaryMintV1 | CoreSummaryRefusalV1>,
): Record<string, unknown> {
  const evidence: Record<string, unknown> = { nowMs: CORE_CLOCK_MS_V1[cell.clock] };
  const wants = new Set(cell.evidence);
  if (wants.has('acceptedTransition')) evidence.acceptedTransition = coreAcceptedTransitionV1(cell);
  if (wants.has('tombstonePredecessor')) {
    evidence.tombstonePredecessor = coreTombstonePredecessorV1(cell);
  }
  if (wants.has('forkResolution')) evidence.forkResolution = CORE_FORK_RESOLUTION_V1;
  if (wants.has('forkEvidenceHeads')) evidence.forkEvidenceHeads = CORE_FORK_EVIDENCE_HEADS_V1;
  if (wants.has('forkBaseHead')) evidence.forkBaseHead = CORE_FORK_BASE_HEAD_V1;
  if (wants.has('verifiedAuthoritySummary')) {
    const mint = summaries.get(coreHeadShapeKeyV1(cell));
    if (mint !== undefined && mint.minted) evidence.verifiedAuthoritySummary = mint.summary;
  }
  return evidence;
}
