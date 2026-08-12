import {
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordStableKeyHashV1,
  deriveAgentProfileAuthorityDispositionV1,
  type AgentProfileActiveHeadObjectV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { describe, expect, it } from 'vitest';

import {
  deriveSystemRecordReplacementV1,
  type SystemRecordActiveReplacementReadyV1,
} from '../src/system-record-next-state-v1-internal.js';
import {
  buildSystemRecordReservedStateQuadsV1,
} from '../src/system-record-rdf-schema-v1-internal.js';
import {
  decodeSystemRecordAppliedSnapshotV1,
  type SystemRecordAppliedSnapshotV1,
} from '../src/system-record-state-snapshot-v1-internal.js';
import {
  createSystemRecordVerifiedReplacementRegistryV1,
} from '../src/system-record-verified-replacement-v1-internal.js';
import {
  makeAuthenticActiveReplacementFixtureV1,
  makeForkResolvingSuccessorFixtureV1,
} from './helpers/system-record-active-replacement-fixture.js';

function expectReady(
  value: ReturnType<typeof deriveSystemRecordReplacementV1>,
): SystemRecordActiveReplacementReadyV1 {
  expect(value.outcome).toBe('ready');
  if (value.outcome !== 'ready') throw new Error(`expected ready, got ${value.outcome}`);
  return value;
}

/**
 * THE RESTART. Everything the process held is dropped: the derived plan is
 * written out as the reserved-state quads a real apply would persist, and the
 * snapshot is decoded back from THOSE QUADS ALONE. Nothing but the quads
 * crosses this boundary, which is what makes the re-derivation below a restart
 * rather than a second look at the same object.
 */
function restartFromPersistedQuads(
  networkId: NetworkIdV1,
  ready: SystemRecordActiveReplacementReadyV1,
): SystemRecordAppliedSnapshotV1 {
  const tuple = buildSystemRecordReservedStateQuadsV1({
    appliedState: ready.plan.next.appliedState,
    headVersion: ready.plan.next.headVersion,
    ownedSubjectTable: ready.plan.next.ownedSubjectTable,
    rootClaimSet: ready.plan.next.rootClaimSet,
    capacityState: ready.plan.next.capacityState,
    receipt: ready.plan.next.receipt,
  });
  return decodeSystemRecordAppliedSnapshotV1({
    networkId,
    stableKeyHash: ready.plan.stableKeyHash,
    materializationEpoch: ready.plan.next.appliedState.materializationEpoch,
    quads: [...tuple.record, ...tuple.capacity, ...tuple.epoch, ...tuple.receipt],
  });
}

/**
 * Applies our branch of a fork through the exported entry, then quarantines it.
 *
 * `terminalTransitionConflict` selects the SHAPE OF THE EVIDENCE, not a label:
 * true builds a transition-typed conflict entry, false a fork-typed one, and
 * storage re-derives the flag from the entries and refuses a disagreement
 * (`system-record-verified-replacement-v1-internal.ts:776-778`). So the two
 * arms below differ by the thing the substrate actually keys on.
 */
async function quarantinedForkV1(terminalTransitionConflict: boolean) {
  const { binding, epochQuad } = makeAuthenticActiveReplacementFixtureV1('authoritative');
  const fork = await makeForkResolvingSuccessorFixtureV1(
    binding,
    'based',
    terminalTransitionConflict,
  );
  const activeRegistry = createSystemRecordVerifiedReplacementRegistryV1();
  const activeFacts = activeRegistry.consumer.consume(
    activeRegistry.issuer.issueActive(fork.forkedIssue),
    binding,
  );
  const active = expectReady(deriveSystemRecordReplacementV1({
    facts: activeFacts,
    snapshot: decodeSystemRecordAppliedSnapshotV1({
      networkId: activeFacts.networkId,
      stableKeyHash: computeSystemRecordStableKeyHashV1(
        activeFacts.networkId,
        (activeFacts.head as AgentProfileActiveHeadObjectV1).peerId,
      ),
      materializationEpoch: activeFacts.materializationEpoch,
      quads: [epochQuad],
    }),
    observedRootClaimQuads: [],
  }));
  activeRegistry.consumer.release(activeFacts);

  const quarantineRegistry = createSystemRecordVerifiedReplacementRegistryV1();
  const quarantineFacts = quarantineRegistry.consumer.consume(
    quarantineRegistry.issuer.issueCandidate({ operation: 'quarantine', ...fork.quarantineIssue }),
    binding,
  );
  const quarantined = expectReady(deriveSystemRecordReplacementV1({
    facts: quarantineFacts,
    snapshot: restartFromPersistedQuads(activeFacts.networkId, active),
    observedRootClaimQuads: active.plan.next.rootClaimQuads,
  }));
  quarantineRegistry.consumer.release(quarantineFacts);
  return { networkId: quarantineFacts.networkId, active, quarantined };
}

describe('authority disposition survives a restart on persisted quads alone', () => {
  /*
   * THE PROPERTY THIS SLICE OWES (plan :204 -- an equivocation quarantine holds
   * "across later heads/restart/provider changes").
   *
   * FAIL-BEFORE, and the reason this test is the one that catches it: delete
   * the transition-digest merge at
   * `system-record-next-state-v1-internal.ts:456-464` and the quarantined row
   * persists with empty slots, so the re-derivation below returns
   * `head-fork-quarantined` and this goes red. No storage-layer assertion would
   * notice, because the consumer of the value lives in core and takes it as an
   * INPUT.
   */
  it('re-derives the equivocation quarantine from the quads after the row is dropped', async () => {
    const { networkId, quarantined } = await quarantinedForkV1(true);

    const beforeRestart = deriveAgentProfileAuthorityDispositionV1(
      quarantined.plan.next.appliedState,
    );
    expect(beforeRestart).toBe('transition-equivocation-quarantined');

    const restarted = restartFromPersistedQuads(networkId, quarantined);
    if (restarted.state !== 'present') throw new Error('expected a present row after restart');
    // The substrate genuinely crossed the boundary -- asserted on the DECODED
    // row, so the claim rests on what the quads carried rather than on the
    // object the derivation happened to still hold.
    expect(restarted.appliedState.conflictDigestSlots.length).toBeGreaterThan(0);
    expect(restarted.appliedState.status).toBe('quarantined');

    expect(deriveAgentProfileAuthorityDispositionV1(restarted.appliedState)).toBe(beforeRestart);
  }, 120_000);

  /*
   * THE COUNTERFACTUAL. Without it the test above passes for a mapping that
   * answers `transition-equivocation-quarantined` for every quarantined row,
   * and the substrate would be proving nothing. Same construction, same
   * restart, evidence shape the only difference.
   */
  it('re-derives a head fork as a head fork, so the discrimination is the evidence', async () => {
    const { networkId, quarantined } = await quarantinedForkV1(false);

    const restarted = restartFromPersistedQuads(networkId, quarantined);
    if (restarted.state !== 'present') throw new Error('expected a present row after restart');
    expect(restarted.appliedState.status).toBe('quarantined');
    expect(restarted.appliedState.conflictDigestSlots).toEqual([]);
    expect(restarted.appliedState.conflictOverflow).toBe(false);

    expect(deriveAgentProfileAuthorityDispositionV1(restarted.appliedState))
      .toBe('head-fork-quarantined');
  }, 120_000);

  /*
   * ROW 3 OUTRANKS ROW 2, ON A ROW THE READER CAN ACTUALLY RECEIVE.
   *
   * The unquarantine gate (`next-state:1098`) refuses while slots are occupied,
   * so TODAY no write path produces an `active` row carrying them -- that
   * refusal is already pinned at `system-record-next-state-v1.test.ts:840`,
   * with its clearing control at :807/:857, and is not restated here.
   *
   * What is pinned here is the part that refusal does NOT establish: the row is
   * nonetheless well-formed PERSISTED state. The active derivation carries
   * slots forward rather than clearing them (:343-345), and the reserved-state
   * codec imposes no coupling between `status` and the slots -- so a reader,
   * which consumes decoded quads and cannot see which write path produced them,
   * can be handed this row. The construction below is deliberately NOT the
   * write path: it re-binds the materialization receipt to the state it
   * describes, which is the only reason the decode admits it. It exists so the
   * mapping's precedence is defended by a built object instead of by an
   * argument that one disjunct in one classifier will never change.
   */
  it('reads a persisted active row carrying slots as quarantined, not discoverable', async () => {
    const { quarantined } = await quarantinedForkV1(true);
    const derived = quarantined.plan.next.appliedState;

    const forged = { ...derived, status: 'active' as const } as Record<string, unknown>;
    delete forged.conflictEvidenceDigest;
    delete forged.conflictForkBaseHeadDigest;

    const tuple = buildSystemRecordReservedStateQuadsV1({
      appliedState: forged as never,
      headVersion: quarantined.plan.next.headVersion,
      ownedSubjectTable: quarantined.plan.next.ownedSubjectTable,
      rootClaimSet: quarantined.plan.next.rootClaimSet,
      capacityState: quarantined.plan.next.capacityState,
      receipt: {
        ...quarantined.plan.next.receipt,
        appliedStateDigest: computeSystemRecordAppliedStateDigestV1(forged as never),
      },
    });
    const snapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: forged.networkId as NetworkIdV1,
      stableKeyHash: quarantined.plan.stableKeyHash,
      materializationEpoch: forged.materializationEpoch as string,
      quads: [...tuple.record, ...tuple.capacity, ...tuple.epoch, ...tuple.receipt],
    });

    if (snapshot.state !== 'present') throw new Error('expected a present row');
    expect(snapshot.appliedState.status).toBe('active');
    expect(snapshot.appliedState.conflictDigestSlots.length).toBeGreaterThan(0);
    expect(deriveAgentProfileAuthorityDispositionV1(snapshot.appliedState))
      .toBe('transition-equivocation-quarantined');
  }, 120_000);
});
