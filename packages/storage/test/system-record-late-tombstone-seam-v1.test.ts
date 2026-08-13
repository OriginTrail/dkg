import { describe, expect, it } from 'vitest';

import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeSystemRecordAppliedStateDigestV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  evaluateAgentProfileLateTombstoneAdvanceV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileHeadObjectV1,
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
 */
function tombstoneOfV1(predecessor: AgentProfileHeadObjectV1): AgentProfileHeadObjectV1 {
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
  return Object.freeze(shaped) as unknown as AgentProfileHeadObjectV1;
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
        reason: 'undecided-authority-disposition',
      },
      dirty: {
        kind: 'derivation',
        verdict: 'deferred',
        reason: 'undecided-authority-disposition',
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

  function lineageFor(transition: AgentProfileAuthorityTransitionV1) {
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
        nowMs: TERMINAL_FIXTURE_NOW_MS_V1,
        acceptedTransition: binding,
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } as never,
      lineageFor(binding) as never,
    );
    const unbound = evaluateAgentProfileLateTombstoneAdvanceV1(
      candidate,
      {
        nowMs: TERMINAL_FIXTURE_NOW_MS_V1,
        acceptedTransition: retained,
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } as never,
      lineageFor(retained) as never,
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
        nowMs: TERMINAL_FIXTURE_NOW_MS_V1,
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } as never,
      lineageFor(retained) as never,
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
        nowMs: TERMINAL_FIXTURE_NOW_MS_V1,
        tombstonePredecessor: coreSequenceActiveHeadV1(LATE_SEQUENCE),
      } as never,
      Object.freeze([
        Object.freeze({
          priorAuthoritySequence: '0',
          nextAuthoritySequence: '1',
          transitionDigest: computeAgentProfileAuthorityTransitionDigestV1(
            coreSequenceTransitionV1('1'),
          ),
        }),
      ]) as never,
    )).toStrictEqual({
      decision: 'reject',
      reason: 'late tombstone entry requires a candidate below the accepted authority sequence',
    });
  });
});
