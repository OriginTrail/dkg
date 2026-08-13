import { describe, expect, it } from 'vitest';

import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeSystemRecordAppliedStateDigestV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  evaluateAgentProfileHeadAdvanceV1,
  evaluateAgentProfileLateTombstoneAdvanceV1,
  type AgentProfileAuthorityTransitionV1,
  assertAgentProfileHeadObjectV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileAppliedTransitionV1,
  type AgentProfileLateTombstoneEvidenceV1,
  type AgentProfileTombstoneHeadObjectV1,
  type SystemRecordMaterializationReceiptV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { deriveSystemRecordReplacementV1 } from '../src/system-record-next-state-v1-internal.js';
import { buildSystemRecordReservedStateQuadsV1 } from '../src/system-record-rdf-schema-v1-internal.js';
import { decodeSystemRecordAppliedSnapshotV1 } from '../src/system-record-state-snapshot-v1-internal.js';
import { createSystemRecordVerifiedReplacementRegistryV1 } from '../src/system-record-verified-replacement-v1-internal.js';

import { SYSTEM_RECORD_FIXTURE_NETWORK } from './helpers/system-record-active-replacement-fixture.js';
import {
  coreSequenceActiveHeadV1,
  coreSequenceTransitionV1,
  CORE_CURRENT_HEAD_V1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';
import {
  CORE_ACCEPTED_LINEAGE_V1,
  CORE_HISTORICAL_ROOTS_V1,
} from './helpers/authority-verdict-diff-core-evidence-v1.js';
import {
  ADMITTED_DEADLINE_MS_V1,
  prepareStorageDriverV1,
  requireStorageSummaryForHeadV1,
  STORAGE_LANE_BINDING_V1,
  type StorageDriverV1,
} from './helpers/authority-verdict-diff-storage-driver-v1.js';
import { TERMINAL_FIXTURE_NOW_MS_V1 } from './helpers/system-record-terminal-replacement-fixture.js';

/**
 * THE LATE-TOMBSTONE SEAM: ADR 0002 :129-133, ROUTED THROUGH CORE.
 *
 * "When a tombstone is learned below the current applied sequence, the receiver
 * verifies its exact active predecessor and the exact retained transition out of
 * that sequence. The descendant is valid only when that transition names the
 * tombstone as its predecessor; otherwise the tombstone takes precedence.
 * Missing retained-transition evidence rejects for retry rather than treating
 * the tombstone as stale."
 *
 * WHAT THIS FILE IS. Storage used to answer that whole rule with a comparison of
 * two sequence numbers, returning a flat `stale`. This is the construction that
 * showed it -- built before the routing existed, against the real exported entry
 * -- plus the behaviour that replaced it. The construction is kept because the
 * compliance claim otherwise rests on reading two documents side by side, and
 * reading is not a measurement.
 *
 * WHAT THE PRE-ROUTING TREE ANSWERED, so the fail-before is recoverable rather
 * than asserted: on the state built in `buildLateTombstoneStateV1` the exported
 * entry returned `{ outcome: 'stale' }`, and it returned the SAME `stale` with
 * the applied row's retained-transition digest perturbed -- the sequence
 * comparison reads `transitionLineage.length` and never its contents. Reverting
 * `classifyLateTombstoneAdvance` reproduces both.
 */

const CURRENT_SEQUENCE = CORE_CURRENT_HEAD_V1.authoritySequence; // '2'
const LATE_SEQUENCE = '1';

/**
 * The ADR's state, built rather than described: a present row at the current
 * sequence, a tombstone candidate BELOW it, that tombstone's exact active
 * predecessor, and the retained transition out of the tombstone's sequence.
 *
 * THE UNSAFE CAST IS CONFINED HERE AND VALIDATED BEFORE IT ESCAPES. Building a
 * head means editing an object the codec owns, so the shaping has to happen on a
 * loose record; what must not happen is that looseness reaching the test bodies,
 * where a fixture that drifted out of shape would be caught by an unrelated
 * assertion or not at all. `validateAgentProfileHeadObjectV1` runs on the way
 * out, so every caller receives a head the codec has accepted and a malformed
 * fixture fails at construction with the codec's own message.
 */
function tombstoneOfV1(predecessor: AgentProfileHeadObjectV1): AgentProfileTombstoneHeadObjectV1 {
  const shaped: Record<string, unknown> = {
    ...structuredClone(predecessor),
    state: 'tombstone',
    version: String(BigInt((predecessor as { version: string }).version) + 1n),
    previousHeadDigest: computeAgentProfileHeadObjectDigestV1(predecessor),
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0',
    projectionBytes: '0',
    projectionQuads: '0',
  };
  // A tombstone commits none of the active head's projection or seal fields,
  // and the head codec refuses the shape if any of them survives.
  for (const key of [
    'contentDigest', 'bundleDigest', 'graphScopedAuthorSeal', 'validUntil',
    'assertionCoordinate',
  ]) {
    delete shaped[key];
  }
  const built = Object.freeze(shaped) as unknown as AgentProfileHeadObjectV1;
  assertAgentProfileHeadObjectV1(built);
  if (built.state !== 'tombstone') {
    throw new Error(`fixture built a ${built.state} head where a tombstone was required`);
  }
  return built;
}

function buildLateTombstoneCandidateV1(): AgentProfileHeadObjectV1 {
  return tombstoneOfV1(coreSequenceActiveHeadV1(LATE_SEQUENCE) as AgentProfileHeadObjectV1);
}

async function driveLateTombstoneV1(
  driver: StorageDriverV1,
  appliedStatus: 'active' | 'tombstone' | 'dirty',
) {
  const candidate = buildLateTombstoneCandidateV1();
  const summary = await requireStorageSummaryForHeadV1(candidate);
  return driver.drive({
    snapshotForm: { kind: 'present', appliedStatus },
    operation: 'tombstone',
    candidate,
    summary,
  } as never);
}

describe('the late-tombstone seam (ADR 0002 :129-133)', () => {
  it('builds the ADR state and no longer answers it from the sequence comparison', async () => {
    const candidate = buildLateTombstoneCandidateV1();
    const predecessor = coreSequenceActiveHeadV1(LATE_SEQUENCE);
    const retained = coreSequenceTransitionV1(String(BigInt(LATE_SEQUENCE) + 1n));

    // THE STATE IS THE ADR'S, CHECKED RATHER THAN ASSUMED.
    expect({
      candidateIsTombstone: (candidate as { state: string }).state === 'tombstone',
      candidateBelowCurrent:
        BigInt((candidate as { authoritySequence: string }).authoritySequence)
          < BigInt(CURRENT_SEQUENCE),
      namesItsExactActivePredecessor:
        (candidate as { previousHeadDigest?: string }).previousHeadDigest
          === computeAgentProfileHeadObjectDigestV1(predecessor),
      retainedTransitionIsOutOfThatSequence:
        retained.priorAuthoritySequence === LATE_SEQUENCE
        && retained.nextAuthoritySequence === CURRENT_SEQUENCE,
      // AND IT DOES NOT NAME THE TOMBSTONE, which is the ADR's "otherwise":
      // the retained rotation descends from the ACTIVE head at that sequence.
      retainedDoesNotNameTheTombstone:
        retained.priorHeadDigest !== computeAgentProfileHeadObjectDigestV1(candidate),
    }).toStrictEqual({
      candidateIsTombstone: true,
      candidateBelowCurrent: true,
      namesItsExactActivePredecessor: true,
      retainedTransitionIsOutOfThatSequence: true,
      retainedDoesNotNameTheTombstone: true,
    });

    const driver = await prepareStorageDriverV1();
    const outcome = await driveLateTombstoneV1(driver, 'active');

    // THE BEHAVIOUR THAT CHANGED. `stale` DISCARDS the candidate; the ADR's own
    // clause for absent retained-transition evidence is a RETRY. Asserting the
    // exact outcome and separately asserting it is not `stale` states both the
    // new behaviour and the old defect, so a future change that reintroduces the
    // discard fails on the second assertion with the defect named.
    expect(outcome).toStrictEqual({
      kind: 'derivation',
      verdict: 'deferred',
      reason: 'late-tombstone-evidence-incomplete',
    });
    expect((outcome as { verdict: string }).verdict).not.toBe('stale');
  });

  /**
   * P2's reader is CONSUMED, and its undecided outcomes are not collapsed.
   *
   * This is also the axis-B discrimination the verdict-diff artifact had
   * measured as INERT on this path: before the routing, `current.status` was
   * read once and only against 'quarantined', so all three of these produced
   * the same answer. The three distinct outcomes below are what makes the
   * disposition branch live rather than decorative.
   */
  it('distinguishes a decided disposition from the two V1 leaves undecided', async () => {
    const driver = await prepareStorageDriverV1();
    const byStatus = {
      active: await driveLateTombstoneV1(driver, 'active'),
      tombstone: await driveLateTombstoneV1(driver, 'tombstone'),
      dirty: await driveLateTombstoneV1(driver, 'dirty'),
    };
    expect(byStatus).toStrictEqual({
      active: {
        kind: 'derivation',
        verdict: 'deferred',
        reason: 'late-tombstone-evidence-incomplete',
      },
      tombstone: {
        kind: 'derivation',
        verdict: 'deferred',
        reason: 'undecided-authority-classification',
      },
      dirty: {
        kind: 'derivation',
        verdict: 'deferred',
        reason: 'undecided-authority-classification',
      },
    });
  });

  /**
   * THE SAME-SEQUENCE, LOWER-VERSION CASE IS A DIFFERENT RULE AND MUST NOT MOVE.
   *
   * ADR :126-128 resolves an active/tombstone conflict within one sequence to
   * the tombstone; it is not a tombstone "learned below the current applied
   * sequence". The routing splits the two disjuncts precisely so this one keeps
   * its comparison, and a mutant that routed the whole condition would turn this
   * into a deferral.
   */
  it('leaves the same-sequence lower-version comparison on the arithmetic', async () => {
    const driver = await prepareStorageDriverV1();
    const candidate = tombstoneOfV1(CORE_CURRENT_HEAD_V1 as AgentProfileHeadObjectV1);
    const summary = await requireStorageSummaryForHeadV1(candidate);

    // THE APPLIED ROW HAS TO BE AHEAD OF THE CANDIDATE, and the DEFAULT DRIVER
    // CANNOT PUT IT THERE. A tombstone's version must exceed its predecessor's,
    // and the driver's present row is materialised from the very head that
    // predecessor is -- so through `buildSnapshot` the candidate is always the
    // HIGHER version and the second disjunct is unreachable. That is a depth
    // limitation of the fixture's one-head-per-sequence chain, not a property of
    // the system: a peer that advanced its active head and then tombstoned from
    // an earlier version reaches it in production.
    //
    // FOUND BY A SURVIVING MUTANT, not by inspection. An earlier version of this
    // test drove the default row, asserted the outcome was neither of the seam's
    // reasons, and passed -- while a mutant that routed the second disjunct too
    // ALSO passed, because the candidate never reached either arm. It asserted a
    // true thing about a state that could not exercise the split.
    const base = driver.currentReady.plan.next;
    const AHEAD_VERSION = '9';
    const receipt: SystemRecordMaterializationReceiptV1 = {
      ...base.receipt,
      appliedStateDigest: computeSystemRecordAppliedStateDigestV1(base.appliedState),
      headDigest: base.appliedState.headDigest,
      stateRevision: base.appliedState.stateRevision,
    };
    const quads = buildSystemRecordReservedStateQuadsV1({
      appliedState: base.appliedState,
      headVersion: AHEAD_VERSION,
      ownedSubjectTable: base.ownedSubjectTable,
      rootClaimSet: base.rootClaimSet,
      capacityState: base.capacityState,
      receipt,
    } as never);
    const snapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
      stableKeyHash: driver.stableKeyHash,
      materializationEpoch: STORAGE_LANE_BINDING_V1.materializationEpoch,
      quads: [...quads.record, ...quads.capacity, ...quads.epoch, ...quads.receipt],
    } as never);

    // The state really is the second disjunct's: same sequence, candidate BELOW
    // the applied version. Asserted so a future fixture change cannot silently
    // move this back to the unreachable shape the mutant exposed.
    expect({
      sameSequence: (candidate as { authoritySequence: string }).authoritySequence
        === String(base.appliedState.transitionLineage.length),
      candidateBelowAppliedVersion:
        BigInt((candidate as { version: string }).version) < BigInt(AHEAD_VERSION),
    }).toStrictEqual({ sameSequence: true, candidateBelowAppliedVersion: true });

    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const facts = registry.consumer.consume(
      registry.issuer.issueCandidate({
        operation: 'tombstone',
        ...STORAGE_LANE_BINDING_V1,
        admittedDeadlineMs: ADMITTED_DEADLINE_MS_V1,
        verifiedAuthoritySummary: summary,
        head: structuredClone(candidate) as never,
        deletionOwnedSubjectTable: [
          (summary as never as { tombstonePredecessor: { rootSubject: string } })
            .tombstonePredecessor.rootSubject,
        ],
      } as never),
      STORAGE_LANE_BINDING_V1 as never,
    );
    const derived = deriveSystemRecordReplacementV1({
      facts,
      snapshot,
      observedRootClaimQuads: base.rootClaimQuads,
    });

    // ADR :126-128 resolves an active/tombstone conflict WITHIN one sequence to
    // the tombstone; it is not a tombstone "learned below the current applied
    // sequence", so it keeps the comparison and must stay `stale`.
    expect(derived).toStrictEqual({ outcome: 'stale' });
  });
});

/**
 * CORE'S OWN ARM, BOTH SIDES OF ITS FINAL BRANCH.
 *
 * NO CELL IN THE VERDICT-DIFF FIXTURE DRIVES THE `stale` SIDE. Core returns
 * `stale` only when the retained transition NAMES the tombstone as its prior
 * head, and every retained transition that fixture builds names the ACTIVE head
 * at that sequence instead -- so the whole 1,728-cell seam exercises the accept
 * side alone. Routing makes that branch production-reachable, so it is
 * constructed here rather than left to the first producer of a retained
 * transition to discover.
 *
 * IT ALSO PINS THE MECHANISM IN THE DIRECTION IT ACTUALLY RUNS. The sentence
 * "core accepts once the retained transition validates" was recorded, believed
 * and cited before being measured, and it is BACKWARDS: a validating transition
 * means a valid descendant exists, which makes the tombstone STALE. The pair
 * below fails on either half if that inversion is ever written back in.
 */
describe('core decides the late tombstone, and the direction is not the intuitive one', () => {
  const candidate = buildLateTombstoneCandidateV1();
  const candidateDigest = computeAgentProfileHeadObjectDigestV1(candidate);
  const retained = coreSequenceTransitionV1(String(BigInt(LATE_SEQUENCE) + 1n));

  /** The same rotation, re-pointed at the TOMBSTONE as its prior head. */
  const binding = Object.freeze({
    ...structuredClone(retained),
    priorHeadDigest: candidateDigest,
  }) as unknown as AgentProfileAuthorityTransitionV1;

  function lineageFor(
    transition: AgentProfileAuthorityTransitionV1,
  ): readonly AgentProfileAppliedTransitionV1[] {
    return Object.freeze([
      Object.freeze({
        priorAuthoritySequence: '0',
        nextAuthoritySequence: '1',
        transitionDigest: computeAgentProfileAuthorityTransitionDigestV1(
          coreSequenceTransitionV1('1'),
        ),
      }),
      Object.freeze({
        priorAuthoritySequence: transition.priorAuthoritySequence,
        nextAuthoritySequence: transition.nextAuthoritySequence,
        transitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
      }),
    ]);
  }

  it('is STALE when the retained transition binds the tombstone, ACCEPT when it does not', () => {
    const bound = evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      {
        retainedTransition: { transition: binding, nowMs: TERMINAL_FIXTURE_NOW_MS_V1 },
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } satisfies AgentProfileLateTombstoneEvidenceV1,
      lineageFor(binding),
    );
    const unbound = evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      {
        retainedTransition: { transition: retained, nowMs: TERMINAL_FIXTURE_NOW_MS_V1 },
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } satisfies AgentProfileLateTombstoneEvidenceV1,
      lineageFor(retained),
    );
    expect({ bound, unbound }).toStrictEqual({
      // A valid descendant of the tombstoned sequence exists, so the tombstone
      // is superseded.
      bound: { decision: 'stale' },
      // ADR :131-132 "otherwise the tombstone takes precedence".
      unbound: { decision: 'accept' },
    });
  });

  it('rejects for retry, not stale, when the retained transition is absent', () => {
    expect(evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      {
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } satisfies AgentProfileLateTombstoneEvidenceV1,
      lineageFor(retained),
    )).toStrictEqual({
      decision: 'reject',
      reason: 'late tombstone requires the exact retained resurrection transition',
    });
  });

  /**
   * THE ENTRY'S OWN PRECONDITION, PROVEN BY FIRING IT.
   *
   * The only production caller reaches this function on the below-sequence
   * branch, so the guard would otherwise be a line no test can distinguish from
   * a comment. The candidate here sits AT the accepted sequence -- lineage
   * length 1 against a candidate at sequence 1 -- and the predicted observation
   * is this exact reason rather than the arm's predecessor or transition
   * refusals, which is what separates "the guard ran" from "the arm happened to
   * refuse anyway".
   */
  it('refuses a candidate that is not below the accepted authority sequence', () => {
    expect(evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      {
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } satisfies AgentProfileLateTombstoneEvidenceV1,
      Object.freeze([
        Object.freeze({
          priorAuthoritySequence: '0',
          nextAuthoritySequence: '1',
          transitionDigest: computeAgentProfileAuthorityTransitionDigestV1(
            coreSequenceTransitionV1('1'),
          ),
        }),
      ]),
    )).toStrictEqual({
      decision: 'reject',
      reason: 'late tombstone entry requires a candidate below the accepted authority sequence',
    });
  });

  /**
   * A CLOCK FAILURE MUST REFUSE, NOT INVERT THE VERDICT.
   *
   * FOUND BY REVIEW, AND IT WAS REAL. This arm reads a NON-ACCEPT from the
   * transition verifier as "the tombstone takes precedence", and that verifier
   * also refuses on an unusable clock. So while the entry took a bare `nowMs`,
   * the SAME binding transition returned `stale` with a real clock and `accept`
   * with `Number.NaN` or `-1` -- a clock failure silently admitting a tombstone
   * that a valid clock supersedes, on inputs the full evaluator refuses at its
   * front door. Three values are pinned because they fail `isSafeNow` for
   * different reasons -- not-a-number, negative, non-integer -- and a guard
   * written for one of those is not a guard for the others.
   */
  it('refuses an unusable clock instead of reading it as tombstone precedence', () => {
    const withClock = (nowMs: number) => evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      {
        retainedTransition: { transition: binding, nowMs },
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } satisfies AgentProfileLateTombstoneEvidenceV1,
      lineageFor(binding),
    );
    expect({
      nan: withClock(Number.NaN),
      negative: withClock(-1),
      fractional: withClock(1.5),
    }).toStrictEqual({
      nan: { decision: 'reject', reason: 'verification clock is invalid' },
      negative: { decision: 'reject', reason: 'verification clock is invalid' },
      fractional: { decision: 'reject', reason: 'verification clock is invalid' },
    });
  });

  it('refuses a candidate head issued beyond the future clock-skew bound', () => {
    const future = Object.freeze({
      ...structuredClone(candidate as unknown as Record<string, unknown>),
      issuedAt: '2027-08-05T12:11:00Z',
    }) as unknown as AgentProfileHeadObjectV1;
    expect(evaluateAgentProfileLateTombstoneAdvanceV1(
      future,
      {
        retainedTransition: { transition: binding, nowMs: TERMINAL_FIXTURE_NOW_MS_V1 },
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } satisfies AgentProfileLateTombstoneEvidenceV1,
      lineageFor(binding),
    )).toStrictEqual({
      decision: 'reject',
      reason: 'head issuedAt exceeds the future clock-skew bound',
    });
  });

  /**
   * THE INVARIANT THE PAIRING BUYS, asserted rather than described.
   *
   * `accept` and `stale` are the only decisions that admit a candidate or settle
   * it, and both are reachable only when a retained transition AND its clock
   * arrived together -- because they are ONE field. A caller holding neither,
   * which is every caller in this repository today, cannot express an admission
   * at all. That makes the storage seam's reject-for-retry a property of the type
   * boundary rather than of which branch happens to run first.
   */
  it('cannot reach accept or stale without a retained transition', () => {
    const observed = [
      {},
      { tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE) },
    ].map((evidence) => (evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      evidence,
      lineageFor(binding),
    ) as { decision: string }).decision);
    expect(observed).toStrictEqual(['reject', 'reject']);
  });

  /**
   * THE ENTRY ANSWERS FOR TOMBSTONES ONLY, AND THE FULL EVALUATOR IS UNCHANGED.
   *
   * BOTH HALVES, because either alone is satisfiable the wrong way. Found by
   * review: this entry reused a shortcut returning `stale` for a lower-sequence
   * ACTIVE head, so an entry whose name promises a tombstone verdict answered
   * for a head its rule says nothing about, on EMPTY evidence.
   *
   * The shortcut itself is not wrong -- it is sound inside the full evaluator,
   * which has already established that the candidate and the accepted head are
   * the same record before it dispatches. This entry has no accepted head to
   * make that comparison against, which is exactly why the shortcut cannot
   * travel with it. So the fix MOVED the shortcut up rather than deleting it,
   * and the second assertion is what proves the move did not cost the full
   * evaluator its behaviour: delete the shortcut instead of relocating it and
   * this row goes red while the first still passes.
   */
  it('refuses an active candidate while the full evaluator still calls one stale', () => {
    const activeBelow = coreSequenceActiveHeadV1(LATE_SEQUENCE);
    expect(evaluateAgentProfileLateTombstoneAdvanceV1(
      activeBelow as never,
      {},
      lineageFor(binding),
    )).toStrictEqual({
      decision: 'reject',
      reason: 'late tombstone entry requires a tombstone candidate',
    });

    // Same head, same lineage, through the full evaluator with its accepted
    // current head present: still `stale`, because there the record identity has
    // been checked and "below the sequence" really does mean superseded.
    expect(evaluateAgentProfileHeadAdvanceV1(
      {
        current: CORE_CURRENT_HEAD_V1,
        disposition: 'discoverable',
        transitionLineage: CORE_ACCEPTED_LINEAGE_V1,
        historicalRoots: CORE_HISTORICAL_ROOTS_V1,
      } as never,
      activeBelow,
      { nowMs: TERMINAL_FIXTURE_NOW_MS_V1 } as never,
    )).toStrictEqual({ decision: 'stale' });
  });
});
