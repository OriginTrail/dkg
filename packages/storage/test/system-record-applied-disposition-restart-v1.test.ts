import {
  canonicalizeAgentProfileConflictEvidenceV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordStableKeyHashV1,
  deriveAgentProfileAuthorityDispositionV1,
  SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileConflictEvidenceV1,
  type Digest32V1,
  type NetworkIdV1,
  type SystemRecordAppliedStatePresentV1,
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
  type SystemRecordActiveReplacementIssueV1,
  type SystemRecordVerifiedCandidateIssueV1,
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
  return {
    networkId: quarantineFacts.networkId,
    active,
    quarantined,
    binding,
    forkedIssue: fork.forkedIssue,
  };
}

describe('authority disposition survives a restart on persisted quads alone', () => {
  /*
   * THE PROPERTY THIS SLICE OWES (plan :204 -- an equivocation quarantine holds
   * "across later heads/restart/provider changes").
   *
   * FAIL-BEFORE, and the reason this test is the one that catches it: delete
   * the transition-digest merge at
   * `system-record-next-state-v1-internal.ts:476-484` and the quarantined row
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
    expect(beforeRestart).toEqual({
      outcome: 'decided',
      disposition: 'transition-equivocation-quarantined',
    });

    const restarted = restartFromPersistedQuads(networkId, quarantined);
    if (restarted.state !== 'present') throw new Error('expected a present row after restart');
    // The substrate genuinely crossed the boundary -- asserted on the DECODED
    // row, so the claim rests on what the quads carried rather than on the
    // object the derivation happened to still hold.
    expect(restarted.appliedState.conflictDigestSlots.length).toBeGreaterThan(0);
    expect(restarted.appliedState.status).toBe('quarantined');

    expect(deriveAgentProfileAuthorityDispositionV1(restarted.appliedState)).toEqual(beforeRestart);
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
      .toEqual({ outcome: 'decided', disposition: 'head-fork-quarantined' });
  }, 120_000);

  /*
   * ROW 3 OUTRANKS ROW 2, ON A ROW THE READER CAN ACTUALLY RECEIVE.
   *
   * The unquarantine gate (`next-state:1118`) refuses while slots are occupied,
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

    // The two quarantined-only fields come off by NAME, not by deleting keys from
    // a widened bag: `conflictEvidenceDigest` is refused on any non-quarantined
    // row (applied-state :268-270), so an active row must not carry it, and the
    // fork base is meaningless without it. Written as a typed rest so the shape
    // being constructed stays legible and no cast is needed anywhere below --
    // dropping a required scalar or leaving a quarantined-only field on would be
    // a type error here rather than something the codec discovers at runtime.
    const {
      conflictEvidenceDigest: _installedEvidence,
      conflictForkBaseHeadDigest: _forkBase,
      ...carriedFields
    } = derived;
    const forged: SystemRecordAppliedStatePresentV1 = { ...carriedFields, status: 'active' };

    const tuple = buildSystemRecordReservedStateQuadsV1({
      appliedState: forged,
      headVersion: quarantined.plan.next.headVersion,
      ownedSubjectTable: quarantined.plan.next.ownedSubjectTable,
      rootClaimSet: quarantined.plan.next.rootClaimSet,
      capacityState: quarantined.plan.next.capacityState,
      // Re-bound because the receipt commits the applied-state digest
      // (rdf-schema :179-181). This is the one place the construction departs
      // from what a write path does, and it is why the decode admits the row.
      receipt: {
        ...quarantined.plan.next.receipt,
        appliedStateDigest: computeSystemRecordAppliedStateDigestV1(forged),
      },
    });
    const snapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: forged.networkId,
      stableKeyHash: quarantined.plan.stableKeyHash,
      materializationEpoch: forged.materializationEpoch,
      quads: [...tuple.record, ...tuple.capacity, ...tuple.epoch, ...tuple.receipt],
    });

    if (snapshot.state !== 'present') throw new Error('expected a present row');
    expect(snapshot.appliedState.status).toBe('active');
    expect(snapshot.appliedState.conflictDigestSlots.length).toBeGreaterThan(0);
    expect(deriveAgentProfileAuthorityDispositionV1(snapshot.appliedState))
      .toEqual({ outcome: 'decided', disposition: 'transition-equivocation-quarantined' });
  }, 120_000);

  /*
   * THE OVERFLOW FLAG, ON A ROW THAT REALLY OVERFLOWED.
   *
   * The reader treats `conflictOverflow` as equivalent evidence to a non-empty
   * slot array, because it records digests DROPPED at the cap -- without it, a
   * record that equivocated more times than the cap allows would read as clean,
   * on exactly the worst-behaved peers. An earlier version of this slice pinned
   * that only by forging the flag and by asserting the token appeared in
   * storage's source; review pointed out that both stay green if the writer
   * stops setting it. This builds the flag instead.
   *
   * A single conflict-evidence object cannot do it: the codec refuses more than
   * SYSTEM_RECORD_MAX_CONFLICT_DIGESTS total object digests
   * (agent-profile-evidence-codecs :236-238). Overflow is therefore reachable
   * only by ACCUMULATION -- the merge unions the persisted slots with the new
   * terminal digests (next-state :476-484) -- so the construction quarantines
   * twice with distinct transition evidence.
   */
  it('re-derives the equivocation from a row whose slots overflowed the cap', async () => {
    const { networkId, quarantined, binding, forkedIssue } = await quarantinedForkV1(true);
    const first = quarantined.plan.next.appliedState;
    expect(first.conflictDigestSlots.length).toBe(2);
    expect(first.conflictOverflow).toBe(false);

    const overflowed = expectReady(overflowQuarantineV1(binding, forkedIssue, quarantined));
    const row = overflowed.plan.next.appliedState;
    // Capped, not truncated to nothing: the flag is what records the remainder.
    expect(row.conflictDigestSlots.length).toBe(SYSTEM_RECORD_MAX_CONFLICT_DIGESTS);
    expect(row.conflictOverflow).toBe(true);

    const restarted = restartFromPersistedQuads(networkId, overflowed);
    if (restarted.state !== 'present') throw new Error('expected a present row after restart');
    // Asserted on the DECODED row: the flag survived serialisation to reserved
    // quads and back, which is the boundary the property is about.
    expect(restarted.appliedState.conflictOverflow).toBe(true);
    expect(deriveAgentProfileAuthorityDispositionV1(restarted.appliedState))
      .toEqual({ outcome: 'decided', disposition: 'transition-equivocation-quarantined' });
  }, 120_000);

  /*
   * ONLY TRANSITION-TYPED DIGESTS REACH THE SLOTS -- pinned by CONSTRUCTION.
   *
   * The reader's whole premise is that a digest in the array means a terminal
   * TRANSITION conflict. The merge enforces that with a type filter, but the
   * `terminalTransitionConflict` gate runs first, so a fixture carrying only
   * fork evidence never presents a fork entry to the filter at all -- which
   * means a filter WIDENED to accept fork digests as well survives every other
   * test in this file. Measured, not assumed: widening it leaves all of them
   * green.
   *
   * This is the case that sees it. One evidence object carrying BOTH a fork
   * entry and a transition entry, past the gate because the transition entry
   * makes the conflict terminal, so the filter is the only thing standing
   * between the fork digests and the slots. An earlier version of this slice
   * covered the same property by asserting on storage's SOURCE TEXT; that was
   * withdrawn in review as not tied to the executed path, and this replaces it
   * with the behaviour.
   */
  it('merges the transition digests and leaves the fork digests out', async () => {
    const { quarantined, binding, forkedIssue } = await quarantinedForkV1(true);
    const forked = forkedIssue.head as AgentProfileActiveHeadObjectV1;
    const forkedDigest = computeAgentProfileHeadObjectDigestV1(forked);
    const forkOnlyDigest = `0x${'ee'.repeat(32)}` as Digest32V1;
    const transitionOnly = Object.freeze([
      `0x${'71'.repeat(32)}`,
      `0x${'72'.repeat(32)}`,
    ].sort()) as readonly Digest32V1[];

    // Canonical entry order is fork before transition (the codec sorts on a
    // type-keyed tuple), and the issuer requires the fork entry to name the
    // candidate's own sequence, version and digest.
    const evidence = Object.freeze({
      objectType: 'conflict-evidence',
      kind: 'agents',
      networkId: forked.networkId,
      peerId: forked.peerId,
      entries: Object.freeze([
        Object.freeze({
          type: 'fork',
          authoritySequence: forked.authoritySequence,
          version: forked.version,
          objectDigests: Object.freeze([forkedDigest, forkOnlyDigest].sort()),
        }),
        Object.freeze({
          type: 'transition',
          priorAuthoritySequence: forked.authoritySequence,
          nextAuthoritySequence: String(BigInt(forked.authoritySequence) + 1n),
          objectDigests: transitionOnly,
        }),
      ]),
    }) as AgentProfileConflictEvidenceV1;

    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const issue = {
      operation: 'quarantine',
      ...forkedIssue,
      conflictEvidenceDigest: computeAgentProfileConflictEvidenceDigestV1(evidence),
      canonicalConflictEvidenceBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
      terminalTransitionConflict: true,
    } satisfies SystemRecordVerifiedCandidateIssueV1;
    const merged = expectReady(deriveSystemRecordReplacementV1({
      facts: registry.consumer.consume(registry.issuer.issueCandidate(issue), binding),
      snapshot: restartFromPersistedQuads(forked.networkId, quarantined),
      observedRootClaimQuads: quarantined.plan.next.rootClaimQuads,
    }));

    const slots = merged.plan.next.appliedState.conflictDigestSlots;
    // Both transition digests landed...
    for (const digest of transitionOnly) expect(slots).toContain(digest);
    // ...and the digest that appears ONLY in the fork entry did not.
    expect(slots).not.toContain(forkOnlyDigest);
  }, 120_000);
});

/**
 * A second quarantine over the already-quarantined row, carrying the most
 * digests one evidence object may hold, so the union crosses the cap.
 */
function overflowQuarantineV1(
  binding: Parameters<typeof makeForkResolvingSuccessorFixtureV1>[0],
  forkedIssue: SystemRecordActiveReplacementIssueV1,
  quarantined: SystemRecordActiveReplacementReadyV1,
) {
  const forked = forkedIssue.head as AgentProfileActiveHeadObjectV1;
  const digests = Object.freeze(
    Array.from({ length: SYSTEM_RECORD_MAX_CONFLICT_DIGESTS }, (_, index) =>
      `0x${(index + 0x40).toString(16).padStart(2, '0').repeat(32)}`).sort(),
  ) as readonly Digest32V1[];
  const evidence = Object.freeze({
    objectType: 'conflict-evidence',
    kind: 'agents',
    networkId: forked.networkId,
    peerId: forked.peerId,
    entries: Object.freeze([Object.freeze({
      type: 'transition',
      priorAuthoritySequence: forked.authoritySequence,
      nextAuthoritySequence: String(BigInt(forked.authoritySequence) + 1n),
      objectDigests: digests,
    })]),
  }) as AgentProfileConflictEvidenceV1;

  const registry = createSystemRecordVerifiedReplacementRegistryV1();
  // `satisfies` rather than a cast: the registry's own issue contract is checked
  // HERE, where the fixture is assembled, so a required field added to
  // SystemRecordQuarantineReplacementIssueV1 fails at this line instead of
  // disappearing into the registry at runtime.
  const issue = {
    operation: 'quarantine',
    ...forkedIssue,
    conflictEvidenceDigest: computeAgentProfileConflictEvidenceDigestV1(evidence),
    canonicalConflictEvidenceBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
    terminalTransitionConflict: true,
  } satisfies SystemRecordVerifiedCandidateIssueV1;
  const facts = registry.consumer.consume(registry.issuer.issueCandidate(issue), binding);
  const derived = deriveSystemRecordReplacementV1({
    facts,
    snapshot: restartFromPersistedQuads(facts.networkId, quarantined),
    observedRootClaimQuads: quarantined.plan.next.rootClaimQuads,
  });
  registry.consumer.release(facts);
  return derived;
}
