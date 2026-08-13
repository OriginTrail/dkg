import { describe, expect, it } from 'vitest';

import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeSystemRecordAppliedStateDigestV1,
  evaluateAgentProfileHeadAdvanceV1,
  evaluateAgentProfileLateTombstoneAdvanceV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileAppliedTransitionV1,
  type AgentProfileLateTombstoneEvidenceV1,
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
import { buildTombstoneHeadFromPredecessorV1 } from './helpers/tombstone-head-fixture-v1.js';

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
/**
 * A VALID FOREIGN PEER IDENTITY, and the reason it is a constant rather than a
 * perturbation of the fixture's own.
 *
 * The record identity is one peer across every head this fixture serves, so
 * there is no second identity to borrow. The codec's binding check requires only
 * that the public key DERIVES the peer id -- no private key is involved -- so a
 * fixed 32-byte public key gives a stable foreign identity. These two were
 * produced together by `peerIdFromPublicKey(publicKeyFromRaw(key))`; changing
 * either one alone makes the pair invalid rather than foreign.
 */
const FOREIGN_PEER_ID_V1 = '12D3KooWAZafD5MBdoVVsnVNUrY7WbPB4sL98p4w4nbwBp6iMJqH';
const FOREIGN_PEER_KEY_V1 = 'CxIZICcuNTxDSlFYX2ZtdHuCiZCXnqWss7rByM_W3eQ';

const tombstoneOfV1 = buildTombstoneHeadFromPredecessorV1;

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
   * THE SAME-SEQUENCE CASE IS A DIFFERENT RULE, AND IT IS ALSO CORE'S.
   *
   * THIS ROW USED TO ASSERT `stale`, AND THE REVERSAL IS THE POINT. The original
   * split was right that a tombstone learned AT the applied sequence is governed
   * by different ADR text than one learned below it, and wrong that the
   * difference licensed leaving it on a version comparison: ADR :112-114 makes a
   * tombstone dominate every active head in its sequence "regardless of delivery
   * order or version", so discarding a verified revocation as `stale` -- settled,
   * and therefore permanent -- decided that clause the other way. The exclusion
   * was correct and did not dispose of the region it excluded.
   *
   * The construction is kept exactly as it was, so the movement is legible at the
   * one place that previously pinned the old answer. Its cell-by-cell form, over
   * all three applied statuses and all three version relations, is in the
   * same-sequence seam suite.
   */
  it('routes the same-sequence case through core instead of the comparison', async () => {
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

    // ADR :112-114: the tombstone dominates its sequence regardless of version,
    // so a verified revocation below the applied version now ADVANCES rather than
    // being discarded. The candidate reaching core at all is what the assertion
    // above about the disjunct's shape guarantees.
    expect({ outcome: derived.outcome }).toStrictEqual({ outcome: 'ready' });
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

  /**
   * EVIDENCE FROM ANOTHER AUTHORITY IS NOT "THE TOMBSTONE TAKES PRECEDENCE".
   *
   * FOUND BY REVIEW. The seam asked one structural question -- "does this
   * transition name this head?" -- and read every NO as the ADR's "otherwise".
   * That "otherwise" presupposes evidence from THIS record's rotation: a
   * transition naming a different head at this sequence really does prove no
   * valid descendant exists, while a transition from another authority proves
   * nothing about this record at all. Measured before the split: a retained
   * transition carrying a foreign `priorEvmIssuer` returned `accept`.
   *
   * EVERY IDENTITY FIELD IS DRIVEN SEPARATELY, because a fixture differing by one
   * field cannot prove the others are compared -- the lesson this suite already
   * learned on the digest conjunct. The last row perturbs only the head digest
   * and demands `accept`, so the two halves of the classification are pinned
   * against each other rather than in isolation.
   */
  it('refuses retained evidence from another authority, per identity field', () => {
    const predecessor = coreSequenceActiveHeadV1(LATE_SEQUENCE);
    const otherIssuer = coreSequenceActiveHeadV1('3') as unknown as { evmIssuer: string };
    const decide = (overrides: Record<string, unknown>) => {
      const perturbed = Object.freeze({
        ...structuredClone(binding as unknown as Record<string, unknown>),
        ...overrides,
      }) as unknown as AgentProfileAuthorityTransitionV1;
      return evaluateAgentProfileLateTombstoneAdvanceV1(
        candidate,
        {
          retainedTransition: { transition: perturbed, nowMs: TERMINAL_FIXTURE_NOW_MS_V1 },
          tombstonePredecessor: predecessor,
        } satisfies AgentProfileLateTombstoneEvidenceV1,
        lineageFor(perturbed),
      );
    };
    const unrelated = {
      decision: 'reject',
      reason: 'late tombstone retained transition belongs to another authority',
    };
    expect({
      networkId: decide({ networkId: 'another-network' }),
      // ONE CASE FOR TWO COMPARISONS, AND IT CANNOT BE SPLIT. The codec asserts
      // that the public key DERIVES the peer id, so a transition changing
      // either one alone is refused at validation and never reaches the
      // classifier at all.
      //
      // MEASURED, not reasoned: deleting either comparison on its own leaves
      // this suite GREEN, and deleting BOTH turns it RED. The solo survivors are
      // a property of the binding the codec enforces -- no input distinguishes
      // them -- while the joint mutant is what shows the pair is covered rather
      // than merely unreachable. Solo removal of `networkId` and of
      // `priorEvmIssuer` each turn it red.
      foreignPeer: decide({ peerId: FOREIGN_PEER_ID_V1, peerPublicKey: FOREIGN_PEER_KEY_V1 }),
      priorEvmIssuer: decide({ priorEvmIssuer: otherIssuer.evmIssuer }),
      // Same authority, DIFFERENT head: this one is the ADR's "otherwise".
      anotherHead: decide({ priorHeadDigest: retained.priorHeadDigest }),
    }).toStrictEqual({
      networkId: unrelated,
      foreignPeer: unrelated,
      priorEvmIssuer: unrelated,
      anotherHead: { decision: 'accept' },
    });
  });

  /**
   * THE EVIDENCE SHAPE IS ENFORCED AT RUN TIME, NOT ONLY BY THE COMPILER.
   *
   * The type-level pins live in the export-types fixture and protect TypeScript
   * consumers. They do nothing for a JavaScript caller, or for a TypeScript one
   * that reaches the entry through `as never` -- and the shape is a safety
   * contract, not a convenience: a top-level clock beside a retained transition
   * is the exact arrangement that once turned a `stale` into an `accept`.
   *
   * So the refusal is asserted where it actually happens, at the boundary.
   */
  it('refuses evidence shapes the type contract forbids, at run time', () => {
    const predecessor = coreSequenceActiveHeadV1(LATE_SEQUENCE);
    const call = (evidence: unknown) => () => evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      evidence as AgentProfileLateTombstoneEvidenceV1,
      lineageFor(binding),
    );
    // A bare transition and a standalone clock beside it: the pre-refactor shape.
    expect(call({
      tombstonePredecessor: predecessor,
      acceptedTransition: binding,
      nowMs: TERMINAL_FIXTURE_NOW_MS_V1,
    })).toThrow(/late tombstone evidence/);
    // The pairing broken from the inside: a transition with no clock.
    expect(call({
      tombstonePredecessor: predecessor,
      retainedTransition: { transition: binding },
    })).toThrow(/late tombstone retained transition/);
    // And the mirror: a clock with no transition to verify.
    expect(call({
      tombstonePredecessor: predecessor,
      retainedTransition: { nowMs: TERMINAL_FIXTURE_NOW_MS_V1 },
    })).toThrow(/late tombstone retained transition/);
  });

  /**
   * THE FIFTH IDENTITY CONJUNCT CANNOT BE FALSIFIED THROUGH THIS ENTRY, and the
   * reason is structural rather than a gap in the row above.
   *
   * The classifier also compares the transition's `priorAuthoritySequence`
   * against the candidate head's `authoritySequence`. Two invariants upstream
   * force those equal before it is ever consulted: the lineage validator
   * requires entry `i` to carry `priorAuthoritySequence === String(i)`,
   * contiguous from zero, and the rule reads its retained entry at exactly
   * `lineage[candidateSequence]` and refuses any transition disagreeing with it.
   * So the transition's prior sequence IS the candidate's sequence by the time
   * the classifier runs.
   *
   * A mutant deleting that one conjunct therefore survives every input reachable
   * from here. It is recorded rather than papered over, because the alternative
   * -- a fabricated row that "covers" it by tripping the lineage check instead
   * -- would assert the wrong refusal and read as coverage.
   */
  it('cannot reach the classifier with a prior sequence that differs', () => {
    const predecessor = coreSequenceActiveHeadV1(LATE_SEQUENCE);
    const mismatched = Object.freeze({
      ...structuredClone(binding as unknown as Record<string, unknown>),
      priorAuthoritySequence: '7',
      nextAuthoritySequence: '8',
    }) as unknown as AgentProfileAuthorityTransitionV1;
    expect(() => evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      {
        retainedTransition: { transition: mismatched, nowMs: TERMINAL_FIXTURE_NOW_MS_V1 },
        tombstonePredecessor: predecessor,
      } satisfies AgentProfileLateTombstoneEvidenceV1,
      lineageFor(mismatched),
    )).toThrow(/contiguous from sequence zero/);
  });

  /**
   * A TEMPORAL REFUSAL IS NOT "THE TOMBSTONE TAKES PRECEDENCE".
   *
   * FOUND BY REVIEW, AND IT IS THE SAME DEFECT AS THE CLOCK INVERSION ONE LAYER
   * DOWN. The previous round fixed the caller-supplied `nowMs` with a preflight.
   * The verifier ALSO refuses on the transition's own `issuedAt`, which the
   * preflight does not cover -- so a binding transition dated a year ahead was
   * read as "does not bind" and returned `accept`, admitting a tombstone that
   * the same transition at a valid time marks `stale`. Measured before the fix:
   * `stale` issued now, `accept` issued in 2027.
   *
   * WHAT THIS ROW PROVES, SCOPED TO THE ARM IT ACTUALLY DRIVES. It builds from
   * the binding fixture, so the classification is `names-this-head` -- the ONE
   * arm on which the verifier's decision is propagated. On that arm a temporal
   * refusal reaches the caller with its own reason, and this row pins it by that
   * exact reason.
   *
   * IT DOES NOT PROVE THE GENERAL CLAIM IT USED TO ASSERT. The earlier wording
   * said a new temporal refusal "cannot quietly become an admission", and that
   * is false as written: on the other two arms the seam never reads the
   * verifier's decision at all, so EVERY refusal it can produce is discarded
   * there. That is harmless today only by coincidence -- exactly one non-binding
   * refusal is reachable and ignoring it does not move the verdict -- and it
   * stops being harmless the moment the verifier learns a refusal that ought to
   * mean refuse.
   *
   * The claim was corrected rather than the coverage widened, because the two
   * are different work: this row's scope is now written down, and whether the
   * seam should establish verifiability BEFORE consulting the classifier is a
   * structural question recorded against the rule itself.
   */
  it('propagates a temporal refusal instead of reading it as precedence', () => {
    const futureDated = Object.freeze({
      ...structuredClone(binding as unknown as Record<string, unknown>),
      issuedAt: '2027-08-05T12:00:00Z',
    }) as unknown as AgentProfileAuthorityTransitionV1;
    expect(evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      {
        retainedTransition: { transition: futureDated, nowMs: TERMINAL_FIXTURE_NOW_MS_V1 },
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } satisfies AgentProfileLateTombstoneEvidenceV1,
      lineageFor(futureDated),
    )).toStrictEqual({
      decision: 'reject',
      reason: 'transition issuedAt exceeds the future clock-skew bound',
    });
  });

  /**
   * A PRESENT-BUT-WRONG TRANSITION, WHICH IS A DIFFERENT CONTRACT FROM AN ABSENT
   * ONE.
   *
   * FOUND BY REVIEW, AND CONFIRMED BY A SURVIVING MUTANT: every other row in this
   * file pairs the supplied transition with a lineage built FROM that same
   * transition, so the comparison at authority :303-305 always matched and
   * deleting the digest conjunct left the whole lane green. The ADR's word is
   * "the EXACT retained transition"; a suite that never supplies an inexact one
   * cannot tell exactness from presence.
   *
   * Everything here is valid except the pairing: a well-formed transition, its
   * real predecessor, a real clock -- against a lineage whose entry names a
   * DIFFERENT transition. The refusal must be the retained-transition one rather
   * than a predecessor or clock refusal, which is what makes it a test of this
   * conjunct rather than of whichever guard happens to fire first.
   */
  it('rejects a well-formed transition that is not the one the lineage retained', () => {
    expect(evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      {
        retainedTransition: { transition: binding, nowMs: TERMINAL_FIXTURE_NOW_MS_V1 },
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } satisfies AgentProfileLateTombstoneEvidenceV1,
      // The lineage retains `retained`, not `binding`.
      lineageFor(retained),
    )).toStrictEqual({
      decision: 'reject',
      reason: 'late tombstone requires the exact retained resurrection transition',
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
