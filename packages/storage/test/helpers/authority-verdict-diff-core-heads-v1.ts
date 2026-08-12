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
import {
  extendRotatedAuthorityChainV1,
  makeRotatedAuthorityChainV1,
} from './system-record-active-replacement-fixture.js';

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
 * THE RECORD'S PROPOSED FUTURE: sequences 3 and 4, rotating off the CURRENT head.
 *
 * This is the half axis D was missing, and it is deliberately NOT built by
 * deepening `CHAIN`. The ancestry chain's sequence-2 head is the version-ZERO
 * one; the current head is that head at version 2. Extending the ancestry would
 * therefore produce a sequence-3 rotation whose prior is an object the receiver
 * has never applied, and storage's next-sequence arm compares exactly that --
 * `summary.lastAuthorityTransitionPriorHeadDigest !== current.headDigest`. The
 * candidate would verify internally, mint a well-formed summary, and still be
 * refused as a history mismatch by this fixture's own choice of predecessor.
 * Rotating off CORE_CURRENT_HEAD_V1 is what makes the next-sequence comparison
 * the system's answer rather than the harness's.
 *
 * Issuer indices 2 and 3: the ancestry already spent 0 and 1, and the lineage
 * walk refuses a reused wallet root (verification closure :635).
 */
const FORWARD = extendRotatedAuthorityChainV1(CORE_CURRENT_HEAD_V1, 2, 2);

/**
 * THE ACTIVE HEAD AT EACH AUTHORITY SEQUENCE -- one object per sequence, doing
 * both jobs that sequence has.
 *
 * It is the head a candidate at that sequence is DERIVED FROM, because a
 * candidate must carry the issuer, root subject, owned-subject table digest and
 * accepted transition its own sequence requires; re-stamping a sequence number
 * onto a head built for another sequence leaves the head naming a transition
 * into somewhere else, which is what this layer did for every axis-D value
 * before and why three of the four relations could never mint.
 *
 * It is ALSO that candidate's PREDECESSOR: every candidate here is a later
 * version of the active head at its own sequence. Deriving both from one entry
 * is deliberate -- as two maps they could disagree, and a candidate whose
 * predecessor names a head at some other sequence is refused by the tombstone
 * binding with wording that reads like the system's.
 *
 * At sequence 2 the entry is the CURRENT head rather than the ancestry's
 * version-zero head at that sequence. Those two differ only in `version` and
 * `previousHeadDigest`, both of which the builder overrides, so the derived
 * candidate is unchanged -- but the PREDECESSOR must be the current head, which
 * is the object a receiver has actually applied.
 */
const SEQUENCE_ACTIVE_HEADS_V1: ReadonlyMap<string, AgentProfileActiveHeadObjectV1> = new Map([
  ['1', CHAIN.ancestors[0] as AgentProfileActiveHeadObjectV1],
  ['2', CORE_CURRENT_HEAD_V1],
  ['3', FORWARD.heads[1] as AgentProfileActiveHeadObjectV1],
  ['4', FORWARD.heads[2] as AgentProfileActiveHeadObjectV1],
]);

/** The real rotation INTO each authority sequence. */
const SEQUENCE_TRANSITIONS_V1: ReadonlyMap<string, AgentProfileAuthorityTransitionV1> = new Map([
  ['1', CHAIN.transitions[0] as AgentProfileAuthorityTransitionV1],
  ['2', CHAIN.transitions[1] as AgentProfileAuthorityTransitionV1],
  ['3', FORWARD.transitions[0] as AgentProfileAuthorityTransitionV1],
  ['4', FORWARD.transitions[1] as AgentProfileAuthorityTransitionV1],
]);

/**
 * The active head a candidate at `authoritySequence` descends from.
 *
 * Exported because the MINT layer needs it too: a tombstone closure resolves an
 * owned-subject table over its predecessor's root, and a minter holding the
 * current head's table for every candidate asks for a digest this fixture never
 * supplies -- a refusal produced by the harness's own omission, phrased exactly
 * like a domain refusal.
 */
export function coreSequenceActiveHeadV1(
  authoritySequence: string,
): AgentProfileActiveHeadObjectV1 {
  return requireSequenceLineageV1(authoritySequence).activeHead;
}

/**
 * THE ONE CHECKED LOOKUP, and the reason it is checked rather than cast.
 *
 * The per-sequence facts were reached through `Map.get(...) as T`, which types
 * every string as supported while only four exist. A future axis relation
 * asking for sequence `5` would compile, receive `undefined` DISGUISED AS A
 * VALID HEAD, and fail somewhere downstream in a spread or a digest with a
 * message about the wrong thing entirely. This turns that into a refusal at the
 * boundary, naming the sequence and what the fixture actually serves.
 *
 * Adding a sequence is now one data change in SEQUENCE_LINEAGE_V1 rather than
 * four maps kept in step by hand -- which is the drift pressure this PR exists
 * to remove, applied to the model this PR introduced.
 */
function requireSequenceLineageV1(authoritySequence: string): CoreSequenceLineageV1 {
  const lineage = SEQUENCE_LINEAGE_V1.get(authoritySequence);
  if (lineage === undefined) {
    throw new Error(
      `no fixture lineage for authority sequence ${authoritySequence}; `
      + `this fixture serves ${[...SEQUENCE_LINEAGE_V1.keys()].join(', ')}`,
    );
  }
  return lineage;
}

/**
 * The authority sequence the candidate for `cell` will carry, WITHOUT building it.
 *
 * Exported for the evidence layer, which needs the sequence in order to choose a
 * sequence-dependent member. Building the whole candidate head to read one field
 * back off it costs a head build PER CELL, and the projection-equivalence suite
 * builds evidence for every constructible cell -- so that shortcut is worth
 * roughly 145,000 avoided head builds, which is most of a CI budget.
 *
 * Derived from the CELL, which is also the honest source rather than merely the
 * cheap one: `buildCoreCandidateHeadV1` derives the sequence from the same axis
 * value. The two agreeing is asserted over every buildable shape in the
 * core-heads suite rather than left to inspection -- a shortcut that silently
 * drifted from the builder would hand the evidence layer a member chosen for the
 * wrong sequence, which is the exact defect class this fixture keeps meeting.
 */
export function coreCandidateSequenceV1(cell: VerdictDiffCellV1): string {
  return String(candidateSequence(cell.sequenceRelation));
}

/**
 * The REAL rotation into `authoritySequence` -- the transition a well-formed
 * candidate at that sequence names.
 *
 * Exported for the evidence layer: axis J's `acceptedTransition` member has to
 * be the transition the candidate actually names, or the member stops being
 * decision-changing and starts being a uniform refusal.
 */
export function coreSequenceTransitionV1(
  authoritySequence: string,
): AgentProfileAuthorityTransitionV1 {
  return requireSequenceLineageV1(authoritySequence).transition;
}

/**
 * The COMPETING rotation into `authoritySequence` -- the transition a G='differ'
 * candidate names.
 *
 * Exported for the same reason as its real counterpart, and the pair has to be
 * chosen together: axis G decides WHICH of the two a candidate names, so any
 * evidence member describing "the transition this candidate accepted" depends on
 * axis G as well as axis D. Supplying the real rotation to a candidate that
 * names the competing one hands core an input no caller could hold.
 */
export function coreSequenceEquivocatingTransitionV1(
  authoritySequence: string,
): AgentProfileAuthorityTransitionV1 {
  return requireSequenceLineageV1(authoritySequence).equivocatingTransition;
}

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
const EQUIVOCATING_TRANSITIONS_V1: ReadonlyMap<string, AgentProfileAuthorityTransitionV1> = new Map(
  [...SEQUENCE_TRANSITIONS_V1].map(([sequence, transition]) => [
    sequence,
    Object.freeze({
      ...transition,
      nextEvmIssuer: EQUIVOCATING_ISSUER,
      nextRoot: `did:dkg:agent:${EQUIVOCATING_ISSUER}`,
    }) as AgentProfileAuthorityTransitionV1,
  ]),
);

/**
 * Axis G's 'differ' at the CURRENT sequence, kept as its own export because
 * consumers name this object rather than a sequence.
 *
 * It is the sequence-2 entry of the map above and is byte-identical to what this
 * constant was before axis D gained per-sequence lineage -- when the chain was
 * two deep, `transitions[length - 1]` WAS the rotation into sequence 2. That
 * coincidence is why the index is now explicit: a deeper chain would have
 * silently re-based this constant on the rotation into its new top, moving every
 * digest in the D='equal' region while every count still summed.
 */
export const CORE_EQUIVOCATING_TRANSITION_V1 = EQUIVOCATING_TRANSITIONS_V1.get(
  CORE_CURRENT_HEAD_V1.authoritySequence,
) as AgentProfileAuthorityTransitionV1;

export const CORE_OTHER_TRANSITION_DIGEST_V1 = computeAgentProfileAuthorityTransitionDigestV1(
  CORE_EQUIVOCATING_TRANSITION_V1,
);

/**
 * THE PER-SEQUENCE DIGESTS, COMPUTED ONCE.
 *
 * Both were being computed INSIDE `buildCoreCandidateHeadV1`, where the previous
 * one-size-fits-all version had used module-level constants. A digest is a
 * canonicalisation plus a keccak hash, and the projection-equivalence suite
 * builds a head for every constructible cell -- so moving them into the builder
 * turned four hashes into roughly 145,000, and MEASURED it: that suite went from
 * 310s on the previous PR's CI run to 716s locally, which is what pushed this
 * lane past its budget.
 *
 * Precomputing loses no observation. These are pure functions of objects fixed
 * at module load; the builder gets the identical value it computed before.
 */
const SEQUENCE_PREDECESSOR_DIGESTS_V1: ReadonlyMap<string, string> = new Map(
  [...SEQUENCE_ACTIVE_HEADS_V1].map(([sequence, head]) => [
    sequence,
    computeAgentProfileHeadObjectDigestV1(head),
  ]),
);

const EQUIVOCATING_TRANSITION_DIGESTS_V1: ReadonlyMap<string, string> = new Map(
  [...EQUIVOCATING_TRANSITIONS_V1].map(([sequence, transition]) => [
    sequence,
    computeAgentProfileAuthorityTransitionDigestV1(transition),
  ]),
);

/**
 * ONE RECORD PER AUTHORITY SEQUENCE -- the canonical model the separate maps
 * above are folded into.
 *
 * The maps are kept as the construction steps (each needs the one before it),
 * but nothing outside this file reads them: every consumer goes through
 * `requireSequenceLineageV1`, so a sequence's active head, its real rotation,
 * its competing rotation and its predecessor digest cannot drift apart. They
 * are five facts about ONE rotation and are now typed that way.
 */
export interface CoreSequenceLineageV1 {
  readonly sequence: string;
  readonly activeHead: AgentProfileActiveHeadObjectV1;
  readonly transition: AgentProfileAuthorityTransitionV1;
  readonly equivocatingTransition: AgentProfileAuthorityTransitionV1;
  /**
   * PRECOMPUTED, both of these. They are digests, i.e. a canonicalisation plus a
   * keccak hash, and the head builder runs per cell -- computing them here
   * rather than at the call site is what keeps this lane inside its CI budget
   * (measured: moving two such digests into the builder took the
   * projection-equivalence suite from 310s to 716s).
   */
  readonly equivocatingTransitionDigest: string;
  readonly predecessorDigest: string;
}

const SEQUENCE_LINEAGE_V1: ReadonlyMap<string, CoreSequenceLineageV1> = new Map(
  [...SEQUENCE_ACTIVE_HEADS_V1].map(([sequence, activeHead]) => [sequence, Object.freeze({
    sequence,
    activeHead,
    transition: SEQUENCE_TRANSITIONS_V1.get(sequence) as AgentProfileAuthorityTransitionV1,
    equivocatingTransition:
      EQUIVOCATING_TRANSITIONS_V1.get(sequence) as AgentProfileAuthorityTransitionV1,
    equivocatingTransitionDigest:
      EQUIVOCATING_TRANSITION_DIGESTS_V1.get(sequence) as string,
    predecessorDigest:
      SEQUENCE_PREDECESSOR_DIGESTS_V1.get(sequence) as string,
  })]),
);

/** Every rotation this fixture can present, real and equivocating. */
export const CORE_ALL_TRANSITIONS_V1: readonly AgentProfileAuthorityTransitionV1[] = Object.freeze([
  ...SEQUENCE_TRANSITIONS_V1.values(),
  ...EQUIVOCATING_TRANSITIONS_V1.values(),
]);

/** Every head this fixture's lineage walks can reach. */
export const CORE_ALL_LINEAGE_HEADS_V1: readonly AgentProfileHeadObjectV1[] = Object.freeze([
  ...CHAIN.heads,
  ...FORWARD.heads.slice(1),
]);


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
 *
 * SEQUENCE-DEPENDENT, SUPPLIED AT EVERY SEQUENCE, AND MEASURABLY INERT TODAY.
 * This object carries the CURRENT head's `evmIssuer` and `authoritySequence`,
 * so at any other sequence it does not describe the candidate it is handed to.
 * It is left alone because the branch it feeds is unreachable under this axis
 * set and the mismatch therefore moves no verdict -- measured at 0 of 5,184
 * sequence-relative projections, against a positive control of 72 of 600. The
 * full statement of the measurement, and of the condition under which it stops
 * holding, is at CORE_FORK_EVIDENCE_HEADS_V1 in the evidence layer. Anyone
 * making axis K='present' constructible must make this per-sequence in the same
 * change.
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

/**
 * THE ONE ARTIFACT GRAPH BOTH MINTERS WALK.
 *
 * The two halves of the diff mint their own summaries -- core's minter is
 * module-private to its layer, and the storage driver reproduces the walk. That
 * reproduction is a DRIFT POINT, and it has already cost one defect: the
 * per-sequence tombstone predecessor was fixed in the core minter and left
 * pinned to the current head in the storage one, which refused every
 * sequence-relative tombstone for an owned-subject table this fixture never
 * supplies and survived a full lane with perfect conservation.
 *
 * Fixing that by editing both minters is a fix by VIGILANCE. This is the
 * structural form: the ancestry, the transitions and the tombstone predecessor
 * rule live HERE, once, and both minters read them. Two functions can still
 * differ in what they do with the graph, but they can no longer disagree about
 * WHAT THE GRAPH IS -- which is the only thing the drift was ever about.
 */
export const CORE_MINT_GRAPH_V1 = Object.freeze({
  /** Every head a closure walk may resolve, current head first. */
  ancestry: Object.freeze([
    CORE_CURRENT_HEAD_V1,
    ...CORE_ALL_LINEAGE_HEADS_V1,
    ...CORE_FORK_CONFLICT_HEADS_V1,
  ]) as readonly AgentProfileHeadObjectV1[],
  /** Every rotation, real and equivocating. */
  transitions: CORE_ALL_TRANSITIONS_V1,
  /**
   * The predecessor a TOMBSTONE at `authoritySequence` must be minted against,
   * and the owned-subject table that goes with it. Both minters call this rather
   * than each deciding what a tombstone descends from.
   */
  tombstonePredecessorFor(authoritySequence: string) {
    const predecessor = coreSequenceActiveHeadV1(authoritySequence);
    return { predecessor, ownedSubjectTable: [predecessor.rootSubject] as readonly string[] };
  },
});

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
 * THE REFUSALS HERE ARE OF THREE KINDS AND THE DISTINCTION IS LOAD-BEARING.
 *
 * Most are SITE refusals: the head codec throws, and the rule quotes the string
 * that site emits. Those look like every other rule in this harness.
 *
 * F2 IS A GENUINE CONTRADICTION. Axes F and G are BOTH relative to the same
 * referent: F='equal' says the candidate hashes to the current's digest, G='differ'
 * says it disagrees with the current on `acceptedTransitionDigest`. A digest covers
 * the whole head, so no object satisfies both -- against ANY referent. Nothing
 * throws; the combination is simply impossible, and what the rule owes in place of
 * a citation is a demonstration, which is what the sweep's own test gives it.
 *
 * F1 AND F3 ARE HARNESS LIMITATIONS WEARING A CONTRADICTION'S CLOTHES, and they
 * fail a discriminator this harness already carries. AXIS_CANDIDATE_HEAD_BINDING_V1
 * says a codec refusal is a RULE only where an axis pins its field ABSOLUTELY,
 * because a RELATIVE axis is satisfied by moving the REFERENT. F1 pairs relative F
 * with absolute C; F3 pairs relative F with absolute K. In both the escape is to
 * move the referent -- and this fixture never does, because it builds exactly one.
 * The current head is active and carries no fork resolution, so nothing digest-equal
 * to IT can be a tombstone or carry a resolution. THE SYSTEM FORBIDS NEITHER: the
 * codec builds a tombstone at this authority sequence, and it builds an active head
 * carrying a `forkResolutionDigest` above version zero. This very sweep builds both.
 *
 * THE COUNTS STAND; THE LABELS DID NOT. F1's 4,608 and F3's 4,608 are what this
 * fixture really retires -- the DATA is true, only the attribution was false, which
 * is why these are relabelled rather than re-pinned. They are not fixed here on
 * purpose: a resolver reopened mid-assembly stops the table being comparable with
 * itself. Their dispositions, escapes and existence proofs live in
 * CORE_HARNESS_LIMITATIONS_V1, which is a SEPARATE register from the system
 * findings for exactly this reason.
 */
export function buildCoreCandidateHeadV1(
  cell: VerdictDiffCellV1,
): CoreHeadBuildV1 | CoreHeadRefusalV1 {
  const digestEqual = cell.headDigest === 'equal';

  if (digestEqual && cell.candidateHeadState !== CORE_CURRENT_HEAD_V1.state) {
    return {
      built: false,
      ruleId: 'F1-digest-equality-forces-the-current-state',
      message: 'this fixture builds ONE referent and it is active, so nothing digest-equal '
        + 'to it can be a tombstone -- a limitation of the referent, not a refusal by the '
        + 'system, which builds such a head at this authority sequence',
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
      message: 'this fixture\'s only referent carries no fork resolution, so nothing '
        + 'digest-equal to it can carry one -- a limitation of the referent, not a refusal '
        + 'by the system, whose codec permits it above version zero',
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
  // The lineage the candidate's own authority sequence demands. Selecting these
  // three per sequence rather than pinning them to the current head is the whole
  // of the sequence-depth fix: the head supplies the issuer, root subject and
  // owned-subject table digest that sequence requires, the transition is the one
  // rotating INTO it, and the predecessor is the head it really descends from.
  const lineageHead = coreSequenceActiveHeadV1(String(sequence));
  const transitionDigest = cell.acceptedTransitionDigest === 'differ'
    ? requireSequenceLineageV1(String(sequence)).equivocatingTransitionDigest
    : lineageHead.acceptedTransitionDigest;

  const base: Record<string, unknown> = {
    ...structuredClone(lineageHead),
    authoritySequence: String(sequence),
    version: String(version),
    acceptedTransitionDigest: transitionDigest,
    // A noninitial head requires its predecessor link (:206), and the head named
    // here is a real one that mints, which keeps this a history reference rather
    // than a placeholder the codec would reject.
    previousHeadDigest: requireSequenceLineageV1(String(sequence)).predecessorDigest,
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
