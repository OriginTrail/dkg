import { readFileSync } from 'node:fs';

import {
  keccak256,
  SENTINEL_NO_PRIVATE_V10,
  tripleContentV10,
  V10MerkleTree,
} from '@origintrail-official/dkg-core';
import {
  buildAgentProfileVerificationClosureV1,
  canonicalizeAgentProfileConflictEvidenceV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordMaterializationReceiptDigestV1,
  computeSystemRecordStableKeyHashV1,
  digestSystemRecordBytesV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
  SYSTEM_RECORD_MAX_ATOMIC_PREPARED_BYTES,
  SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES,
  SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileConflictEvidenceV1,
  type Digest32V1,
  type NetworkIdV1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SystemRecordAppliedStatePresentV1,
  type SystemRecordCapacityStateV1,
  type SystemRecordMaterializationReceiptV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { describe, expect, it } from 'vitest';

import {
  buildSystemRecordConditionalApplyUpdateV1,
} from '../src/system-record-apply-command-v1-internal.js';
import {
  assertAuthenticSystemRecordActiveReplacementCompleteV1,
  deriveSystemRecordActiveReplacementV1,
  deriveSystemRecordReplacementV1,
  type SystemRecordActiveReplacementCompleteV1,
  type SystemRecordActiveReplacementReadyV1,
} from '../src/system-record-next-state-v1-internal.js';
import {
  buildSystemRecordReservedStateQuadsV1,
  systemRecordEpochSubjectV1,
  systemRecordRootClaimSubjectV1,
  SYSTEM_RECORD_V1_PREDICATES,
} from '../src/system-record-rdf-schema-v1-internal.js';
import {
  decodeSystemRecordAppliedSnapshotV1,
  type SystemRecordAppliedSnapshotV1,
} from '../src/system-record-state-snapshot-v1-internal.js';
import {
  createSystemRecordVerifiedReplacementRegistryV1,
  type SystemRecordVerifiedReplacementFactsV1,
} from '../src/system-record-verified-replacement-v1-internal.js';
import { SYSTEM_RECORD_V1_STATE_GRAPH } from '../src/internal-graph-policy.js';
import { agentProfileIdentityProjectionV1 } from './helpers/agent-profile-identity-projection-v1.js';
import {
  makeAuthenticActiveReplacementFixtureV1,
  makeForkResolvingSuccessorFixtureV1,
} from './helpers/system-record-active-replacement-fixture.js';
import { makeAuthenticTerminalReplacementFixtureV1 } from './helpers/system-record-terminal-replacement-fixture.js';

interface Vectors {
  readonly variants: {
    readonly active: { readonly object: AgentProfileActiveHeadObjectV1 };
    readonly coSignedTransition: { readonly object: AgentProfileAuthorityTransitionV1 };
  };
  readonly signed: {
    readonly activeEip191: { readonly envelope: SignedAgentProfileHeadEnvelopeV1 };
    readonly coSignedTransitionEip191: {
      readonly envelope: SignedAgentProfileAuthorityTransitionEnvelopeV1;
    };
  };
}

const vectors = JSON.parse(readFileSync(new URL(
  '../../core/test/fixtures/system-record-v1/vectors.json',
  import.meta.url,
), 'utf8')) as Vectors;
const EPOCH = '13';
const BUNDLE_BYTES = new TextEncoder().encode('next-state-verified-profile-bundle');
const BUNDLE_DIGEST = digestSystemRecordBytesV1(
  SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
  BUNDLE_BYTES,
);
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CAPABILITY_LINK = 'https://eips.ethereum.org/erc-8004#capabilities';
const OFFERING_LINK = 'https://dkg.origintrail.io/skill#offersSkill';

const initialProjection = smallProjection(vectors.variants.active.object);
const INITIAL = prepareHead(vectors.variants.active.object, initialProjection);
const INITIAL_FACTS = await factsFor(INITIAL, initialProjection);

describe('system-record active next-state derivation', () => {
  it('cold-applies an initial head into one complete authentic deterministic tuple', () => {
    const snapshot = absentSnapshot(INITIAL.networkId);
    const first = deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot,
      observedRootClaimQuads: [],
    });
    const second = deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot,
      observedRootClaimQuads: [],
    });
    const ready = expectReady(first);
    const repeated = expectReady(second);

    expect(ready.plan.next.appliedState).toMatchObject({
      stateRevision: '1', status: 'active',
    });
    expect(ready.plan.next.appliedState.transitionLineage).toHaveLength(0);
    expect(ready.plan.next.headVersion).toBe('0');
    expect(ready.plan.next.capacityState).toMatchObject({ revision: '1', liveRecordCount: '1' });
    expect(ready.plan.prior.reservedQuads).toHaveLength(1);
    expect(ready.plan.next.reservedQuads).toHaveLength(15);
    expect(ready.plan.prior.requiredAbsentReservedSubjects).toHaveLength(4);
    expect(ready.plan.next.projectionQuads).toBe(INITIAL_FACTS.projectionQuads);
    expect(ready.plan.success).toEqual({
      stateRevision: '1',
      appliedStateDigest: computeSystemRecordAppliedStateDigestV1(ready.plan.next.appliedState),
    });
    expect(ready.plan.next.receiptDigest).toBe(
      computeSystemRecordMaterializationReceiptDigestV1(ready.plan.next.receipt),
    );
    expect(repeated.plan.next.receiptDigest).toBe(ready.plan.next.receiptDigest);
    expect(repeated.plan.next.reservedQuads).toEqual(ready.plan.next.reservedQuads);
    expect(() => assertAuthenticSystemRecordActiveReplacementCompleteV1(ready)).not.toThrow();
    expect(() => assertAuthenticSystemRecordActiveReplacementCompleteV1({ ...ready }))
      .toThrow(/verified state derivation/);
    expect(() => deriveSystemRecordActiveReplacementV1({
      facts: { ...INITIAL_FACTS },
      snapshot,
      observedRootClaimQuads: [],
    })).toThrow(/not produced by this registry/);
  });

  it('cold-applies a complete noninitial active closure', async () => {
    const rotated = await rotatedFixture(INITIAL);
    const result = expectReady(deriveSystemRecordActiveReplacementV1({
      facts: rotated.facts,
      snapshot: absentSnapshot(INITIAL.networkId),
      observedRootClaimQuads: [],
    }));
    expect(result.plan.next.appliedState).toMatchObject({
      currentRoot: rotated.head.rootSubject,
      historicalRoots: [INITIAL.rootSubject],
    });
    expect(result.plan.next.appliedState.transitionLineage).toHaveLength(1);
    expect(result.plan.next.headVersion).toBe('0');
    expect(result.plan.prior.requiredAbsentReservedSubjects).toHaveLength(5);
    expect(result.plan.next.rootClaimQuads).toHaveLength(6);
  });

  it('returns a complete authentic already-applied result for one equal head', () => {
    const cold = coldReady();
    const snapshot = snapshotFrom(cold);
    const result = deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot,
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    });
    expect(result.outcome).toBe('already-applied');
    if (result.outcome !== 'already-applied') throw new Error('expected already-applied');
    expect(result.plan.next.reservedQuads).toEqual(result.plan.prior.reservedQuads);
    expect(result.plan.success).toEqual(cold.plan.success);
    expect(result.plan.next.projectionQuads).toBe(INITIAL_FACTS.projectionQuads);
    expect(() => assertAuthenticSystemRecordActiveReplacementCompleteV1(result)).not.toThrow();
  });

  it('atomically rematerializes an equal head retained from a prior durable epoch', () => {
    const cold = coldReady();
    const snapshot = snapshotAtPriorEpoch(cold, '12');
    const result = expectReady(deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot,
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    }));

    expect(snapshot).toMatchObject({
      materializationEpoch: EPOCH,
      appliedTupleEpoch: '12',
      appliedState: { materializationEpoch: '12', stateRevision: '1' },
    });
    expect(result.plan.next.appliedState).toMatchObject({
      materializationEpoch: EPOCH,
      stateRevision: '2',
      headDigest: cold.plan.next.appliedState.headDigest,
    });
    expect(result.plan.next.capacityState).toMatchObject({ revision: '2', liveRecordCount: '1' });
    expect(result.plan.prior.reservedQuads).toHaveLength(
      snapshot.previousReservedQuads.length + cold.plan.next.rootClaimQuads.length,
    );
    expect(result.plan.prior.reservedQuads).toEqual(expect.arrayContaining([
      ...snapshot.previousReservedQuads,
      ...cold.plan.next.rootClaimQuads,
    ]));
    expect(result.plan.next.reservedQuads).not.toEqual(result.plan.prior.reservedQuads);
    expect(result.plan.success.stateRevision).toBe('2');
    expect(() => assertAuthenticSystemRecordActiveReplacementCompleteV1(result)).not.toThrow();
  });

  it('never acknowledges an equal digest whose canonical persisted tuple disagrees with the head', () => {
    const cold = coldReady();
    const inconsistent = snapshotWithAppliedState(cold, {
      ...cold.plan.next.appliedState,
      projectionDigest: `0x${'ab'.repeat(32)}`,
    });
    expect(deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot: inconsistent,
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'verified-state-mismatch' });
  });

  it('accepts same-authority higher-version fast-forward and rejects stale/equal-version fork', async () => {
    const cold = coldReady();
    const snapshot = snapshotFrom(cold);
    const fastHead = prepareHead({
      ...INITIAL,
      version: '2',
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(INITIAL),
      issuedAt: '2026-08-05T12:20:00Z',
      validUntil: '2026-08-08T12:20:00Z',
    }, initialProjection);
    const fastFacts = await factsFor(fastHead, initialProjection, [INITIAL]);
    const fast = expectReady(deriveSystemRecordActiveReplacementV1({
      facts: fastFacts,
      snapshot,
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    }));
    expect(fast.plan.next.headVersion).toBe('2');

    const fastSnapshot = snapshotFrom(fast);
    expect(deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot: fastSnapshot,
      observedRootClaimQuads: fast.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'stale' });

    const forkHead = prepareHead({
      ...INITIAL,
      issuedAt: '2026-08-05T12:00:01Z',
      validUntil: '2026-08-06T12:00:01Z',
    }, initialProjection);
    const forkFacts = await factsFor(forkHead, initialProjection);
    expect(deriveSystemRecordActiveReplacementV1({
      facts: forkFacts,
      snapshot,
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'authority-fork' });
  });

  it('accepts exact +1 authority progression and rejects wrong predecessor and >+1', async () => {
    const cold = coldReady();
    const snapshot = snapshotFrom(cold);
    const rotated = await rotatedFixture(INITIAL);
    const accepted = expectReady(deriveSystemRecordActiveReplacementV1({
      facts: rotated.facts,
      snapshot,
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    }));
    expect(accepted.plan.next.appliedState.historicalRoots).toEqual([INITIAL.rootSubject]);
    expect(accepted.plan.prior.requiredAbsentReservedSubjects).toContain(
      systemRecordRootClaimSubjectV1(INITIAL.networkId, rotated.head.rootSubject),
    );

    const alternatePrior = prepareHead({
      ...INITIAL,
      version: '1',
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(INITIAL),
      issuedAt: '2026-08-05T12:10:00Z',
      validUntil: '2026-08-08T12:10:00Z',
    }, initialProjection);
    const wrong = await rotatedFixture(alternatePrior, [INITIAL]);
    expect(deriveSystemRecordActiveReplacementV1({
      facts: wrong.facts,
      snapshot,
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'authority-history-mismatch' });

    const twice = await twiceRotatedFixture();
    expect(deriveSystemRecordActiveReplacementV1({
      facts: twice.facts,
      snapshot,
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'authority-history-mismatch' });
  });

  it('classifies root collision and aggregate capacity refusal with zero prepared output', () => {
    const cold = coldReady();
    const foreignClaim = cold.plan.next.rootClaimQuads.map((quad) => (
      quad.predicate === SYSTEM_RECORD_V1_PREDICATES.claimedBy
        ? Object.freeze({ ...quad, object: 'urn:test:foreign-record' })
        : quad
    ));
    const collision = deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot: absentSnapshot(INITIAL.networkId),
      observedRootClaimQuads: foreignClaim,
    });
    expect(collision).toMatchObject({ outcome: 'root-collision' });
    expect(deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot: absentSnapshot(INITIAL.networkId),
      observedRootClaimQuads: foreignClaim.slice(0, 1),
    })).toEqual({ outcome: 'deferred', reason: 'root-state-changed' });

    const capacity = {
      objectType: 'system-record-capacity-state', kind: 'agents', networkId: INITIAL.networkId,
      revision: '9', liveRecordCount: '8192',
      stateBytes: SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES.toString(),
      tableBytes: '0', projectionBytes: '0', projectionQuads: '0',
    } as const;
    const saturated = absentSnapshotWithCapacity(cold, capacity);
    expect(deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot: saturated,
      observedRootClaimQuads: [],
    })).toEqual({ outcome: 'capacity-exhausted', reason: 'aggregate-cap' });
  });

  it('refuses state and capacity revision overflow before producing a command', async () => {
    const cold = coldReady();
    const nextHead = prepareHead({
      ...INITIAL,
      version: '1',
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(INITIAL),
      issuedAt: '2026-08-05T12:10:00Z',
      validUntil: '2026-08-08T12:10:00Z',
    }, initialProjection);
    const nextFacts = await factsFor(nextHead, initialProjection, [INITIAL]);
    const maxU64 = '18446744073709551615';

    expect(deriveSystemRecordActiveReplacementV1({
      facts: nextFacts,
      snapshot: snapshotWithAppliedState(cold, {
        ...cold.plan.next.appliedState,
        stateRevision: maxU64,
      }),
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'capacity-exhausted', reason: 'state-revision-overflow' });

    expect(deriveSystemRecordActiveReplacementV1({
      facts: nextFacts,
      snapshot: snapshotWithCapacityState(cold, {
        ...cold.plan.next.capacityState,
        revision: maxU64,
      }),
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'capacity-exhausted', reason: 'capacity-revision-overflow' });
  });

  it('refuses a 2,049-subject replacement union before producing a command', async () => {
    const priorData = largeProjection(INITIAL, 'capability', 1_024);
    const priorHead = prepareHead(INITIAL, priorData.quads, priorData.subjects);
    const priorFacts = await factsFor(priorHead, priorData.quads, [], [], priorData.subjects);
    const priorReady = expectReady(deriveSystemRecordActiveReplacementV1({
      facts: priorFacts,
      snapshot: absentSnapshot(INITIAL.networkId),
      observedRootClaimQuads: [],
    }));
    const nextData = largeProjection(INITIAL, 'offering', 1_024);
    const nextHead = prepareHead({
      ...priorHead,
      version: '1',
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(priorHead),
      issuedAt: '2026-08-05T12:10:00Z',
      validUntil: '2026-08-08T12:10:00Z',
    }, nextData.quads, nextData.subjects);
    const nextFacts = await factsFor(
      nextHead,
      nextData.quads,
      [priorHead],
      [],
      nextData.subjects,
      [priorData.subjects],
    );
    expect(deriveSystemRecordActiveReplacementV1({
      facts: nextFacts,
      snapshot: snapshotFrom(priorReady),
      observedRootClaimQuads: priorReady.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'capacity-exhausted', reason: 'subject-union-cap' });
  }, 20_000);

  it(
    'prepares the exact 10,000-quad protocol maximum within the 4 MiB request bound', async () => {
    const projection = maximumProjection(INITIAL);
    const head = prepareHead(INITIAL, projection);
    const facts = await factsFor(head, projection);
    const ready = expectReady(deriveSystemRecordActiveReplacementV1({
      facts,
      snapshot: absentSnapshot(INITIAL.networkId),
      observedRootClaimQuads: [],
    }));
    const update = buildSystemRecordConditionalApplyUpdateV1(ready);

    expect(ready.plan.next.projectionQuads).toHaveLength(10_000);
    expect(update.requestBytes).toBe(Buffer.byteLength(update.sparql, 'utf8'));
    expect(update.requestBytes).toBeLessThanOrEqual(SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES);
    expect(update.requestBytes * 3).toBeLessThanOrEqual(SYSTEM_RECORD_MAX_ATOMIC_PREPARED_BYTES);
    }, 30_000,
  );

  it('defers quarantined, dirty, and tombstone local states without producing write facts', () => {
    const cold = coldReady();
    for (const status of ['quarantined', 'dirty', 'tombstone'] as const) {
      const snapshot = nonActiveSnapshot(cold, status);
      expect(deriveSystemRecordActiveReplacementV1({
        facts: INITIAL_FACTS,
        snapshot,
        observedRootClaimQuads: cold.plan.next.rootClaimQuads,
      })).toEqual({ outcome: 'deferred', reason: 'non-active-state' });
    }
  });
});

describe('system-record terminal and quarantine next-state derivation', () => {
  it('cold-applies an authoritative tombstone with deletion scope and zero transient projection', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1('authoritative');
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const facts = registry.consumer.consume(registry.issuer.issueCandidate({
      operation: 'tombstone',
      ...fixture.tombstone,
    }), fixture.binding);
    const snapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: facts.networkId,
      stableKeyHash: computeSystemRecordStableKeyHashV1(facts.networkId, facts.head.peerId),
      materializationEpoch: facts.materializationEpoch,
      quads: [fixture.epochQuad],
    });
    const ready = expectReady(deriveSystemRecordReplacementV1({
      facts,
      snapshot,
      observedRootClaimQuads: [],
    }));
    const update = buildSystemRecordConditionalApplyUpdateV1(ready);

    expect(ready.plan.next.appliedState).toMatchObject({
      status: 'tombstone',
      projectionBytes: '0',
      projectionQuads: '0',
      ownedSubjectCount: '0',
      ownedSubjectTableBytes: '0',
    });
    expect(ready.plan.next.projectionQuads).toEqual([]);
    expect(ready.plan.projectionDeletionTable).toEqual(
      fixture.tombstone.deletionOwnedSubjectTable,
    );
    expect(update.subjectUnion).toEqual(fixture.tombstone.deletionOwnedSubjectTable);
    expect(update.sparql).not.toContain('VALUES (?insertProjectionSubject');
    expect(ready.plan.next.appliedState).not.toHaveProperty('conflictSidecarIntentOperation');
    registry.consumer.release(facts);
  });

  it('tombstones an active row by freeing only that row projection/table contribution', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1('authoritative');
    const activeRegistry = createSystemRecordVerifiedReplacementRegistryV1();
    const activeFacts = activeRegistry.consumer.consume(
      activeRegistry.issuer.issueActive(fixture.active),
      fixture.binding,
    );
    const cold = expectReady(deriveSystemRecordReplacementV1({
      facts: activeFacts,
      snapshot: decodeSystemRecordAppliedSnapshotV1({
        networkId: activeFacts.networkId,
        stableKeyHash: computeSystemRecordStableKeyHashV1(
          activeFacts.networkId,
          activeFacts.head.peerId,
        ),
        materializationEpoch: activeFacts.materializationEpoch,
        quads: [fixture.epochQuad],
      }),
      observedRootClaimQuads: [],
    }));
    const activeTuple = buildSystemRecordReservedStateQuadsV1({
      appliedState: cold.plan.next.appliedState,
      headVersion: cold.plan.next.headVersion,
      ownedSubjectTable: cold.plan.next.ownedSubjectTable,
      rootClaimSet: cold.plan.next.rootClaimSet,
      capacityState: cold.plan.next.capacityState,
      receipt: cold.plan.next.receipt,
    });
    const activeSnapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: activeFacts.networkId,
      stableKeyHash: cold.plan.stableKeyHash,
      materializationEpoch: activeFacts.materializationEpoch,
      quads: [
        ...activeTuple.record,
        ...activeTuple.capacity,
        ...activeTuple.epoch,
        ...activeTuple.receipt,
      ],
    });
    activeRegistry.consumer.release(activeFacts);

    const terminalRegistry = createSystemRecordVerifiedReplacementRegistryV1();
    const terminalFacts = terminalRegistry.consumer.consume(
      terminalRegistry.issuer.issueCandidate({
        operation: 'tombstone',
        ...fixture.tombstone,
      }),
      fixture.binding,
    );
    const ready = expectReady(deriveSystemRecordReplacementV1({
      facts: terminalFacts,
      snapshot: activeSnapshot,
      observedRootClaimQuads: cold.plan.next.rootClaimQuads,
    }));
    expect(ready.plan.next.capacityState.liveRecordCount).toBe(
      cold.plan.next.capacityState.liveRecordCount,
    );
    expect(BigInt(ready.plan.next.capacityState.stateBytes)).toBe(
      BigInt(cold.plan.next.capacityState.stateBytes),
    );
    expect(BigInt(cold.plan.next.capacityState.tableBytes)
      - BigInt(ready.plan.next.capacityState.tableBytes)).toBe(
      BigInt(cold.plan.next.appliedState.ownedSubjectTableBytes),
    );
    expect(BigInt(cold.plan.next.capacityState.projectionBytes)
      - BigInt(ready.plan.next.capacityState.projectionBytes)).toBe(
      BigInt(cold.plan.next.appliedState.projectionBytes),
    );
    terminalRegistry.consumer.release(terminalFacts);
  });

  it('persists a shadow deletion table across restart and clears it at authoritative cutover', async () => {
    const shadowFixture = await makeAuthenticTerminalReplacementFixtureV1('shadow');
    const shadowRegistry = createSystemRecordVerifiedReplacementRegistryV1();
    const shadowFacts = shadowRegistry.consumer.consume(
      shadowRegistry.issuer.issueCandidate({
        operation: 'tombstone',
        ...shadowFixture.tombstone,
      }),
      shadowFixture.binding,
    );
    const shadowReady = expectReady(deriveSystemRecordReplacementV1({
      facts: shadowFacts,
      snapshot: decodeSystemRecordAppliedSnapshotV1({
        networkId: shadowFacts.networkId,
        stableKeyHash: computeSystemRecordStableKeyHashV1(
          shadowFacts.networkId,
          shadowFacts.head.peerId,
        ),
        materializationEpoch: shadowFacts.materializationEpoch,
        quads: [shadowFixture.epochQuad],
      }),
      observedRootClaimQuads: [],
    }));
    expect(shadowReady.plan.next.appliedState.status).toBe('dirty');
    expect(shadowReady.plan.next.pendingDeletionTable).toEqual(
      shadowFixture.tombstone.deletionOwnedSubjectTable,
    );
    const shadowTuple = buildSystemRecordReservedStateQuadsV1({
      appliedState: shadowReady.plan.next.appliedState,
      headVersion: shadowReady.plan.next.headVersion,
      ownedSubjectTable: shadowReady.plan.next.ownedSubjectTable,
      pendingDeletionTable: shadowReady.plan.next.pendingDeletionTable!,
      rootClaimSet: shadowReady.plan.next.rootClaimSet,
      capacityState: shadowReady.plan.next.capacityState,
      receipt: shadowReady.plan.next.receipt,
    });
    const restarted = decodeSystemRecordAppliedSnapshotV1({
      networkId: shadowFacts.networkId,
      stableKeyHash: shadowReady.plan.stableKeyHash,
      materializationEpoch: shadowFacts.materializationEpoch,
      quads: [
        ...shadowTuple.record,
        ...shadowTuple.capacity,
        ...shadowTuple.epoch,
        ...shadowTuple.receipt,
      ],
    });
    expect(restarted.state).toBe('present');
    if (restarted.state !== 'present') throw new Error('expected restarted dirty state');
    expect(restarted.pendingDeletionTable).toEqual(
      shadowFixture.tombstone.deletionOwnedSubjectTable,
    );
    shadowRegistry.consumer.release(shadowFacts);

    const authoritativeFixture = await makeAuthenticTerminalReplacementFixtureV1('authoritative');
    const authoritativeRegistry = createSystemRecordVerifiedReplacementRegistryV1();
    const authoritativeFacts = authoritativeRegistry.consumer.consume(
      authoritativeRegistry.issuer.issueCandidate({
        operation: 'tombstone',
        ...authoritativeFixture.tombstone,
      }),
      authoritativeFixture.binding,
    );
    const cutover = expectReady(deriveSystemRecordReplacementV1({
      facts: authoritativeFacts,
      snapshot: restarted,
      observedRootClaimQuads: shadowReady.plan.next.rootClaimQuads,
    }));
    expect(cutover.plan.next.appliedState.status).toBe('tombstone');
    expect(cutover.plan.next).not.toHaveProperty('pendingDeletionTable');
    expect(cutover.plan.next.appliedState).not.toHaveProperty('pendingDeletionTableDigest');
    expect(cutover.plan.next.appliedState).not.toHaveProperty('conflictSidecarIntentOperation');
    authoritativeRegistry.consumer.release(authoritativeFacts);
  });

  // The tombstone cutover plans its deletion from the incoming candidate's table
  // and never compares it with the scope the row recorded. It does not need to,
  // because a row cannot persist a pending table that disagrees with its own
  // applied-state binding -- refused here on the way in, and again by the
  // decoder on the way out. Pin the write half; the read half is pinned in
  // system-record-state-snapshot-v1.test.ts.
  it('refuses to encode a pending deletion table that does not bind the applied state', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1('shadow');
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const facts = registry.consumer.consume(
      registry.issuer.issueCandidate({ operation: 'tombstone', ...fixture.tombstone }),
      fixture.binding,
    );
    const ready = expectReady(deriveSystemRecordReplacementV1({
      facts,
      snapshot: decodeSystemRecordAppliedSnapshotV1({
        networkId: facts.networkId,
        stableKeyHash: computeSystemRecordStableKeyHashV1(facts.networkId, facts.head.peerId),
        materializationEpoch: facts.materializationEpoch,
        quads: [fixture.epochQuad],
      }),
      observedRootClaimQuads: [],
    }));
    const recorded = ready.plan.next.pendingDeletionTable!;
    const widened = Object.freeze([
      ...recorded,
      `${ready.plan.next.appliedState.currentRoot}/.well-known/genid/cap1`,
    ]) as unknown as typeof recorded;
    expect(() => buildSystemRecordReservedStateQuadsV1({
      appliedState: ready.plan.next.appliedState,
      headVersion: ready.plan.next.headVersion,
      ownedSubjectTable: ready.plan.next.ownedSubjectTable,
      pendingDeletionTable: widened,
      rootClaimSet: ready.plan.next.rootClaimSet,
      capacityState: ready.plan.next.capacityState,
      receipt: ready.plan.next.receipt,
    })).toThrow(/does not bind the applied state/);
    registry.consumer.release(facts);
  });

  it('persists quarantine evidence without a sidecar intent and blocks ordinary unquarantine', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1('authoritative');
    const initialRegistry = createSystemRecordVerifiedReplacementRegistryV1();
    const initialFacts = initialRegistry.consumer.consume(
      initialRegistry.issuer.issueActive(fixture.active),
      fixture.binding,
    );
    const active = expectReady(deriveSystemRecordReplacementV1({
      facts: initialFacts,
      snapshot: decodeSystemRecordAppliedSnapshotV1({
        networkId: initialFacts.networkId,
        stableKeyHash: computeSystemRecordStableKeyHashV1(
          initialFacts.networkId,
          initialFacts.head.peerId,
        ),
        materializationEpoch: initialFacts.materializationEpoch,
        quads: [fixture.epochQuad],
      }),
      observedRootClaimQuads: [],
    }));
    const activeTuple = buildSystemRecordReservedStateQuadsV1({
      appliedState: active.plan.next.appliedState,
      headVersion: active.plan.next.headVersion,
      ownedSubjectTable: active.plan.next.ownedSubjectTable,
      rootClaimSet: active.plan.next.rootClaimSet,
      capacityState: active.plan.next.capacityState,
      receipt: active.plan.next.receipt,
    });
    const activeSnapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: initialFacts.networkId,
      stableKeyHash: active.plan.stableKeyHash,
      materializationEpoch: initialFacts.materializationEpoch,
      quads: [
        ...activeTuple.record,
        ...activeTuple.capacity,
        ...activeTuple.epoch,
        ...activeTuple.receipt,
      ],
    });
    initialRegistry.consumer.release(initialFacts);

    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const quarantineFacts = registry.consumer.consume(
      registry.issuer.issueCandidate({ operation: 'quarantine', ...fixture.quarantine }),
      fixture.binding,
    );
    const quarantined = expectReady(deriveSystemRecordReplacementV1({
      facts: quarantineFacts,
      snapshot: activeSnapshot,
      observedRootClaimQuads: active.plan.next.rootClaimQuads,
    }));
    expect(quarantined.plan.next.appliedState).toMatchObject({
      status: 'quarantined',
      stateRevision: '2',
      conflictEvidenceDigest: fixture.quarantine.conflictEvidenceDigest,
    });
    expect(quarantined.plan.next.appliedState).not.toHaveProperty(
      'conflictSidecarIntentOperation',
    );
    const tuple = buildSystemRecordReservedStateQuadsV1({
      appliedState: quarantined.plan.next.appliedState,
      headVersion: quarantined.plan.next.headVersion,
      ownedSubjectTable: quarantined.plan.next.ownedSubjectTable,
      rootClaimSet: quarantined.plan.next.rootClaimSet,
      capacityState: quarantined.plan.next.capacityState,
      receipt: quarantined.plan.next.receipt,
    });
    const snapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: quarantineFacts.networkId,
      stableKeyHash: quarantined.plan.stableKeyHash,
      materializationEpoch: quarantineFacts.materializationEpoch,
      quads: [...tuple.record, ...tuple.capacity, ...tuple.epoch, ...tuple.receipt],
    });
    registry.consumer.release(quarantineFacts);

    const activeRegistry = createSystemRecordVerifiedReplacementRegistryV1();
    const activeFacts = activeRegistry.consumer.consume(
      activeRegistry.issuer.issueActive(fixture.active),
      fixture.binding,
    );
    expect(deriveSystemRecordReplacementV1({
      facts: activeFacts,
      snapshot,
      observedRootClaimQuads: quarantined.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'non-active-state' });
    activeRegistry.consumer.release(activeFacts);
  });

  // Pins the precondition that makes the absent-resolution refusal unreachable
  // today: a summary minted through the closure for a head advertising a
  // resolution always carries the facts. The refusal guards a summary minted on
  // some other traversal, which cannot be built here -- so the precondition is
  // pinned instead of faking a removal test for it.
  it('carries verified fork-resolution facts on the fork-resolving successor', async () => {
    const { binding } = makeAuthenticActiveReplacementFixtureV1('authoritative');
    const fork = await makeForkResolvingSuccessorFixtureV1(binding);
    expect(fork.issue.verifiedAuthoritySummary.forkResolution).toEqual({
      resolutionDigest: fork.head.forkResolutionDigest,
      authoritySequence: '0',
      forkedVersion: '0',
      resolutionVersion: '2',
    });
    expect(fork.head.version).toBe('3');
  });

  // Two real authority rotations before the fork, so the persisted row's lineage
  // length (2) differs from the forked version (1). Without that the two
  // comparisons read the same number and a predicate matching the resolution's
  // sequence against the wrong operand still passes.
  it('clears a fork quarantine on a row whose lineage outruns its version', async () => {
    const fork = await quarantinedForkFixtureV1('rotated');
    if (fork.quarantinedSnapshot.state !== 'present') throw new Error('expected a present row');
    expect(fork.quarantinedSnapshot.headVersion).toBe('1');
    expect(fork.quarantinedSnapshot.appliedState.transitionLineage).toHaveLength(2);
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const cleared = expectReady(deriveSystemRecordReplacementV1({
      facts: registry.consumer.consume(
        registry.issuer.issueActive(fork.successorIssue),
        fork.binding,
      ),
      snapshot: fork.quarantinedSnapshot,
      observedRootClaimQuads: fork.observedRootClaimQuads,
    }));
    expect(cleared.plan.next.appliedState.status).toBe('active');
  });

  it('clears a fork quarantine for the successor resolving that exact fork', async () => {
    const fork = await quarantinedForkFixtureV1();
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const cleared = expectReady(deriveSystemRecordReplacementV1({
      facts: registry.consumer.consume(
        registry.issuer.issueActive(fork.successorIssue),
        fork.binding,
      ),
      snapshot: fork.quarantinedSnapshot,
      observedRootClaimQuads: fork.observedRootClaimQuads,
    }));
    expect(cleared.plan.next.appliedState.status).toBe('active');
  });

  // The precondition every unreachable conjunct in this file rests on: an active
  // row carries no conflict saga, so a later reader can treat empty slots and an
  // absent fork base as facts rather than hopes. It holds because the active
  // state is built as a fresh literal (:324-332) rather than by spreading the
  // persisted row -- turn that into a spread and this goes red.
  //
  // The pin has two arms because a single one cannot exist: a row carrying slots
  // is terminal and never unquarantines, so "unquarantine a slots-carrying row
  // and find it clean" is unbuildable. Arm one is what makes an active row's
  // slots always empty -- a genuinely slots-carrying row, derived through
  // terminal transition evidence rather than assigned, is refused even though
  // every other clause of the advance passes.
  //
  // That isolation is measured, not assumed: the slots disjunct is the only true
  // one here, and disabling it turns this test and only this test red. Anyone
  // re-proving that must mutate the clause inside classifyAuthorityAdvance
  // specifically -- the tombstone gate carries a textually identical slots
  // clause, and disabling that one instead leaves the whole suite green, which
  // reads as though this pin were inert.
  it('refuses to unquarantine a row whose conflict slots are occupied', async () => {
    const fork = await quarantinedForkFixtureV1('based', true);
    if (fork.quarantinedSnapshot.state !== 'present') throw new Error('expected a present row');
    expect(fork.quarantinedSnapshot.appliedState.conflictDigestSlots.length)
      .toBeGreaterThan(0);
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    expect(deriveSystemRecordReplacementV1({
      facts: registry.consumer.consume(
        registry.issuer.issueActive(fork.successorIssue),
        fork.binding,
      ),
      snapshot: fork.quarantinedSnapshot,
      observedRootClaimQuads: fork.observedRootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'non-active-state' });
  });

  // Arm two: what a row that DOES clear looks like afterwards.
  it('unquarantines to an active row carrying no conflict saga at all', async () => {
    const fork = await quarantinedForkFixtureV1();
    if (fork.quarantinedSnapshot.state !== 'present') throw new Error('expected a present row');
    const quarantined = fork.quarantinedSnapshot.appliedState;
    expect(fork.forkBaseHeadDigest).toBeDefined();
    expect(quarantined.conflictForkBaseHeadDigest).toBe(fork.forkBaseHeadDigest);
    expect(quarantined.conflictEvidenceDigest).toBeDefined();

    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const cleared = expectReady(deriveSystemRecordReplacementV1({
      facts: registry.consumer.consume(
        registry.issuer.issueActive(fork.successorIssue),
        fork.binding,
      ),
      snapshot: fork.quarantinedSnapshot,
      observedRootClaimQuads: fork.observedRootClaimQuads,
    }));
    expect(cleared.plan.next.appliedState.status).toBe('active');
    expect(cleared.plan.next.appliedState.conflictForkBaseHeadDigest).toBeUndefined();
    expect(cleared.plan.next.appliedState.conflictEvidenceDigest).toBeUndefined();
    expect(cleared.plan.next.appliedState.conflictDigestSlots).toEqual([]);
    expect(cleared.plan.next.appliedState.conflictOverflow).toBe(false);
  });

  // Three resolutions that all verify on their own terms, each disagreeing with
  // our quarantine on exactly one coordinate of the fork event. One conjunct
  // decides each case, so removing that conjunct turns that case -- and only
  // that case -- green.
  it.each([
    ['a different fork of the same history', 'genesis'],
    ['a fork at a different version off our base', 'other-version'],
    ['a fork at our version off a different base', 'other-base'],
  ] as const)('refuses a resolution of %s', async (_label, shape) => {
    const fork = await quarantinedForkFixtureV1();
    const other = await makeForkResolvingSuccessorFixtureV1(fork.binding, shape);
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    expect(deriveSystemRecordReplacementV1({
      facts: registry.consumer.consume(
        registry.issuer.issueActive(other.issue),
        fork.binding,
      ),
      snapshot: fork.quarantinedSnapshot,
      observedRootClaimQuads: fork.observedRootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'non-active-state' });
  });

  // The tombstone classifier is a parallel path to the active one and had no
  // quarantine gate, so a peer that equivocated could delete the quarantined row
  // -- and the evidence of its own equivocation -- by publishing a tombstone for
  // the head it had quarantined. Every conjunct of the advance matches here,
  // which is the point: without the gate this fixture advances and plans a
  // deletion.

  it('never lets a tombstone advance over a fork-quarantined row', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1('authoritative');
    const initialRegistry = createSystemRecordVerifiedReplacementRegistryV1();
    const initialFacts = initialRegistry.consumer.consume(
      initialRegistry.issuer.issueActive(fixture.active),
      fixture.binding,
    );
    const active = expectReady(deriveSystemRecordReplacementV1({
      facts: initialFacts,
      snapshot: decodeSystemRecordAppliedSnapshotV1({
        networkId: initialFacts.networkId,
        stableKeyHash: computeSystemRecordStableKeyHashV1(
          initialFacts.networkId,
          initialFacts.head.peerId,
        ),
        materializationEpoch: initialFacts.materializationEpoch,
        quads: [fixture.epochQuad],
      }),
      observedRootClaimQuads: [],
    }));
    const activeTuple = buildSystemRecordReservedStateQuadsV1({
      appliedState: active.plan.next.appliedState,
      headVersion: active.plan.next.headVersion,
      ownedSubjectTable: active.plan.next.ownedSubjectTable,
      rootClaimSet: active.plan.next.rootClaimSet,
      capacityState: active.plan.next.capacityState,
      receipt: active.plan.next.receipt,
    });
    const activeSnapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: initialFacts.networkId,
      stableKeyHash: active.plan.stableKeyHash,
      materializationEpoch: initialFacts.materializationEpoch,
      quads: [
        ...activeTuple.record,
        ...activeTuple.capacity,
        ...activeTuple.epoch,
        ...activeTuple.receipt,
      ],
    });
    initialRegistry.consumer.release(initialFacts);

    const quarantineRegistry = createSystemRecordVerifiedReplacementRegistryV1();
    const quarantineFacts = quarantineRegistry.consumer.consume(
      quarantineRegistry.issuer.issueCandidate({ operation: 'quarantine', ...fixture.quarantine }),
      fixture.binding,
    );
    const quarantined = expectReady(deriveSystemRecordReplacementV1({
      facts: quarantineFacts,
      snapshot: activeSnapshot,
      observedRootClaimQuads: active.plan.next.rootClaimQuads,
    }));
    expect(quarantined.plan.next.appliedState.status).toBe('quarantined');
    const quarantineTuple = buildSystemRecordReservedStateQuadsV1({
      appliedState: quarantined.plan.next.appliedState,
      headVersion: quarantined.plan.next.headVersion,
      ownedSubjectTable: quarantined.plan.next.ownedSubjectTable,
      rootClaimSet: quarantined.plan.next.rootClaimSet,
      capacityState: quarantined.plan.next.capacityState,
      receipt: quarantined.plan.next.receipt,
    });
    const quarantinedSnapshot = decodeSystemRecordAppliedSnapshotV1({
      networkId: quarantineFacts.networkId,
      stableKeyHash: quarantined.plan.stableKeyHash,
      materializationEpoch: quarantineFacts.materializationEpoch,
      quads: [
        ...quarantineTuple.record,
        ...quarantineTuple.capacity,
        ...quarantineTuple.epoch,
        ...quarantineTuple.receipt,
      ],
    });
    quarantineRegistry.consumer.release(quarantineFacts);
    if (quarantinedSnapshot.state !== 'present') throw new Error('expected a quarantined row');

    // The tombstone names exactly the head the row quarantined, so nothing but
    // the status gate stands between it and a deletion.
    const tombstoneRegistry = createSystemRecordVerifiedReplacementRegistryV1();
    const tombstoneFacts = tombstoneRegistry.consumer.consume(
      tombstoneRegistry.issuer.issueCandidate({ operation: 'tombstone', ...fixture.tombstone }),
      fixture.binding,
    );
    expect(tombstoneFacts.verifiedAuthoritySummary.tombstonePredecessor)
      .toBeDefined();
    expect(quarantinedSnapshot.appliedState.headDigest).toBe(
      computeAgentProfileHeadObjectDigestV1(
        tombstoneFacts.verifiedAuthoritySummary.tombstonePredecessor!,
      ),
    );
    expect(quarantinedSnapshot.headVersion).toBe(
      tombstoneFacts.verifiedAuthoritySummary.tombstonePredecessor!.version,
    );
    expect(deriveSystemRecordReplacementV1({
      facts: tombstoneFacts,
      snapshot: quarantinedSnapshot,
      observedRootClaimQuads: quarantined.plan.next.rootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'non-active-state' });
    tombstoneRegistry.consumer.release(tombstoneFacts);
  });

  it('persists terminal transition object digests in the bounded quarantine slots', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1('authoritative');
    const transitionDigests = Object.freeze([
      `0x${'bc'.repeat(32)}`,
      `0x${'de'.repeat(32)}`,
    ].sort()) as readonly Digest32V1[];
    const evidence: AgentProfileConflictEvidenceV1 = Object.freeze({
      objectType: 'conflict-evidence',
      kind: 'agents',
      networkId: fixture.active.head.networkId,
      peerId: fixture.active.head.peerId,
      entries: Object.freeze([Object.freeze({
        type: 'transition',
        priorAuthoritySequence: fixture.active.head.authoritySequence,
        nextAuthoritySequence: String(BigInt(fixture.active.head.authoritySequence) + 1n),
        objectDigests: transitionDigests,
      })]),
    });
    const canonicalConflictEvidenceBytes = canonicalizeAgentProfileConflictEvidenceV1(evidence);
    const conflictEvidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const facts = registry.consumer.consume(registry.issuer.issueCandidate({
      operation: 'quarantine',
      ...fixture.active,
      conflictEvidenceDigest,
      canonicalConflictEvidenceBytes,
      terminalTransitionConflict: true,
    }), fixture.binding);
    const ready = expectReady(deriveSystemRecordReplacementV1({
      facts,
      snapshot: decodeSystemRecordAppliedSnapshotV1({
        networkId: facts.networkId,
        stableKeyHash: computeSystemRecordStableKeyHashV1(
          facts.networkId,
          facts.head.peerId,
        ),
        materializationEpoch: facts.materializationEpoch,
        quads: [fixture.epochQuad],
      }),
      observedRootClaimQuads: [],
    }));

    expect(ready.plan.next.appliedState.conflictDigestSlots).toEqual(transitionDigests);
    expect(ready.plan.next.appliedState.conflictOverflow).toBe(false);
    expect(ready.plan.next.appliedState).not.toHaveProperty(
      'conflictSidecarIntentOperation',
    );
    registry.consumer.release(facts);
  });
});

function coldReady(): SystemRecordActiveReplacementReadyV1 {
  return expectReady(deriveSystemRecordActiveReplacementV1({
    facts: INITIAL_FACTS,
    snapshot: absentSnapshot(INITIAL.networkId),
    observedRootClaimQuads: [],
  }));
}

function expectReady(value: ReturnType<typeof deriveSystemRecordActiveReplacementV1>) {
  expect(value.outcome).toBe('ready');
  if (value.outcome !== 'ready') throw new Error(`expected ready, got ${value.outcome}`);
  return value;
}

function absentSnapshot(networkId: string): SystemRecordAppliedSnapshotV1 {
  return decodeSystemRecordAppliedSnapshotV1({
    networkId,
    stableKeyHash: computeStableKey(INITIAL),
    materializationEpoch: EPOCH,
    quads: [{
      subject: systemRecordEpochSubjectV1(networkId),
      predicate: SYSTEM_RECORD_V1_PREDICATES.materializationEpoch,
      object: `"${EPOCH}"`,
      graph: SYSTEM_RECORD_V1_STATE_GRAPH,
    }],
  });
}

function absentSnapshotWithCapacity(
  ready: SystemRecordActiveReplacementReadyV1,
  capacityState: SystemRecordCapacityStateV1,
): SystemRecordAppliedSnapshotV1 {
  const quads = buildSystemRecordReservedStateQuadsV1({
    appliedState: ready.plan.next.appliedState,
    headVersion: ready.plan.next.headVersion,
    ownedSubjectTable: ready.plan.next.ownedSubjectTable,
    rootClaimSet: ready.plan.next.rootClaimSet,
    capacityState,
    receipt: ready.plan.next.receipt,
  });
  return decodeSystemRecordAppliedSnapshotV1({
    networkId: INITIAL.networkId,
    stableKeyHash: computeStableKey(INITIAL),
    materializationEpoch: EPOCH,
    quads: [...quads.capacity, ...quads.epoch],
  });
}

function snapshotFrom(value: SystemRecordActiveReplacementCompleteV1): SystemRecordAppliedSnapshotV1 {
  const rootKeys = new Set(value.plan.next.rootClaimQuads.map(quadKey));
  return decodeSystemRecordAppliedSnapshotV1({
    networkId: value.plan.next.appliedState.networkId,
    stableKeyHash: value.plan.next.appliedState.stableKeyHash,
    materializationEpoch: value.plan.next.materializationEpoch,
    quads: value.plan.next.reservedQuads.filter((quad) => !rootKeys.has(quadKey(quad))),
  });
}

function snapshotAtPriorEpoch(
  ready: SystemRecordActiveReplacementReadyV1,
  priorEpoch: string,
): SystemRecordAppliedSnapshotV1 {
  const appliedState: SystemRecordAppliedStatePresentV1 = {
    ...ready.plan.next.appliedState,
    materializationEpoch: priorEpoch,
  };
  const receipt: SystemRecordMaterializationReceiptV1 = {
    ...ready.plan.next.receipt,
    materializationEpoch: priorEpoch,
    appliedStateDigest: computeSystemRecordAppliedStateDigestV1(appliedState),
  };
  const prior = buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion: ready.plan.next.headVersion,
    ownedSubjectTable: ready.plan.next.ownedSubjectTable,
    rootClaimSet: ready.plan.next.rootClaimSet,
    capacityState: ready.plan.next.capacityState,
    receipt,
  });
  const currentEpoch = buildSystemRecordReservedStateQuadsV1({
    appliedState: ready.plan.next.appliedState,
    headVersion: ready.plan.next.headVersion,
    ownedSubjectTable: ready.plan.next.ownedSubjectTable,
    rootClaimSet: ready.plan.next.rootClaimSet,
    capacityState: ready.plan.next.capacityState,
    receipt: ready.plan.next.receipt,
  }).epoch;
  return decodeSystemRecordAppliedSnapshotV1({
    networkId: INITIAL.networkId,
    stableKeyHash: computeStableKey(INITIAL),
    materializationEpoch: EPOCH,
    quads: [...prior.record, ...prior.capacity, ...currentEpoch, ...prior.receipt],
  });
}

function snapshotWithAppliedState(
  ready: SystemRecordActiveReplacementReadyV1,
  appliedState: SystemRecordAppliedStatePresentV1,
): SystemRecordAppliedSnapshotV1 {
  const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
  const receipt: SystemRecordMaterializationReceiptV1 = {
    ...ready.plan.next.receipt,
    appliedStateDigest,
    headDigest: appliedState.headDigest,
    stateRevision: appliedState.stateRevision,
  };
  const quads = buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion: ready.plan.next.headVersion,
    ownedSubjectTable: ready.plan.next.ownedSubjectTable,
    rootClaimSet: ready.plan.next.rootClaimSet,
    capacityState: ready.plan.next.capacityState,
    receipt,
  });
  return decodeSystemRecordAppliedSnapshotV1({
    networkId: INITIAL.networkId,
    stableKeyHash: computeStableKey(INITIAL),
    materializationEpoch: EPOCH,
    quads: [...quads.record, ...quads.capacity, ...quads.epoch, ...quads.receipt],
  });
}

function snapshotWithCapacityState(
  ready: SystemRecordActiveReplacementReadyV1,
  capacityState: SystemRecordCapacityStateV1,
): SystemRecordAppliedSnapshotV1 {
  const quads = buildSystemRecordReservedStateQuadsV1({
    appliedState: ready.plan.next.appliedState,
    headVersion: ready.plan.next.headVersion,
    ownedSubjectTable: ready.plan.next.ownedSubjectTable,
    rootClaimSet: ready.plan.next.rootClaimSet,
    capacityState,
    receipt: ready.plan.next.receipt,
  });
  return decodeSystemRecordAppliedSnapshotV1({
    networkId: INITIAL.networkId,
    stableKeyHash: computeStableKey(INITIAL),
    materializationEpoch: EPOCH,
    quads: [...quads.record, ...quads.capacity, ...quads.epoch, ...quads.receipt],
  });
}

function nonActiveSnapshot(
  ready: SystemRecordActiveReplacementReadyV1,
  status: 'quarantined' | 'dirty' | 'tombstone',
): SystemRecordAppliedSnapshotV1 {
  const base = ready.plan.next.appliedState;
  let appliedState: SystemRecordAppliedStatePresentV1;
  let table = ready.plan.next.ownedSubjectTable;
  let capacityState = ready.plan.next.capacityState;
  if (status === 'quarantined') {
    appliedState = {
      ...base,
      status,
      conflictSidecarIntentOperation: 'deferred',
      conflictSidecarIntentEvidenceDigest: `0x${'ee'.repeat(32)}`,
      conflictSidecarIntentStateRevision: base.stateRevision,
    };
  } else if (status === 'dirty') {
    appliedState = { ...base, status };
  } else {
    table = Object.freeze([]);
    appliedState = {
      ...base,
      status,
      projectionDigest: SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
      projectionBytes: '0',
      projectionQuads: '0',
      ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
      ownedSubjectCount: '0',
      ownedSubjectTableBytes: '0',
      accountedBytes: '65536',
    };
    capacityState = {
      ...capacityState,
      tableBytes: '0', projectionBytes: '0', projectionQuads: '0',
    };
  }
  const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
  const receipt: SystemRecordMaterializationReceiptV1 = {
    ...ready.plan.next.receipt,
    appliedStateDigest,
    headDigest: appliedState.headDigest,
  };
  const quads = buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion: ready.plan.next.headVersion,
    ownedSubjectTable: table,
    rootClaimSet: ready.plan.next.rootClaimSet,
    capacityState,
    receipt,
  });
  return decodeSystemRecordAppliedSnapshotV1({
    networkId: INITIAL.networkId,
    stableKeyHash: computeStableKey(INITIAL),
    materializationEpoch: EPOCH,
    quads: [...quads.record, ...quads.capacity, ...quads.epoch, ...quads.receipt],
  });
}

async function rotatedFixture(
  prior: AgentProfileActiveHeadObjectV1,
  earlier: readonly AgentProfileActiveHeadObjectV1[] = [],
) {
  const template = vectors.variants.coSignedTransition.object;
  const transition: AgentProfileAuthorityTransitionV1 = {
    ...template,
    priorAuthoritySequence: prior.authoritySequence,
    nextAuthoritySequence: (BigInt(prior.authoritySequence) + 1n).toString(),
    priorHeadDigest: computeAgentProfileHeadObjectDigestV1(prior),
    priorEvmIssuer: prior.evmIssuer,
    issuedAt: '2026-08-07T12:00:00Z',
  } as AgentProfileAuthorityTransitionV1;
  const transitionDigest = computeAgentProfileAuthorityTransitionDigestV1(transition);
  const nextSource = {
    ...prior,
    authoritySequence: transition.nextAuthoritySequence,
    version: '0',
    acceptedTransitionDigest: transitionDigest,
    evmIssuer: transition.nextEvmIssuer,
    rootSubject: transition.nextRoot,
    issuedAt: '2026-08-07T12:01:00Z',
    validUntil: '2026-08-10T12:01:00Z',
    previousHeadDigest: undefined,
  } as unknown as AgentProfileActiveHeadObjectV1;
  const projection = smallProjection(nextSource);
  const head = prepareHead(nextSource, projection);
  return {
    head,
    transition,
    facts: await factsFor(head, projection, [prior, ...earlier], [transition]),
  };
}

async function twiceRotatedFixture() {
  const first = await rotatedFixture(INITIAL);
  const nextIssuer = '0x3333333333333333333333333333333333333333';
  const transition: AgentProfileAuthorityTransitionV1 = {
    ...first.transition,
    priorAuthoritySequence: '1',
    nextAuthoritySequence: '2',
    priorHeadDigest: computeAgentProfileHeadObjectDigestV1(first.head),
    priorEvmIssuer: first.head.evmIssuer,
    nextEvmIssuer: nextIssuer,
    nextRoot: `did:dkg:agent:${nextIssuer}`,
    issuedAt: '2026-08-08T12:00:00Z',
  };
  const nextSource = {
    ...first.head,
    authoritySequence: '2',
    version: '0',
    acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
    evmIssuer: nextIssuer,
    rootSubject: transition.nextRoot,
    issuedAt: '2026-08-08T12:01:00Z',
    validUntil: '2026-08-11T12:01:00Z',
    previousHeadDigest: undefined,
  } as unknown as AgentProfileActiveHeadObjectV1;
  const projection = smallProjection(nextSource);
  const head = prepareHead(nextSource, projection);
  return {
    head,
    facts: await factsFor(
      head,
      projection,
      [first.head, INITIAL],
      [first.transition, transition],
    ),
  };
}

async function factsFor(
  head: AgentProfileActiveHeadObjectV1,
  projection: readonly Readonly<{ subject: string; predicate: string; object: string; graph: string }>[],
  history: readonly AgentProfileActiveHeadObjectV1[] = [],
  transitions: readonly AgentProfileAuthorityTransitionV1[] = [],
  table: readonly string[] = [head.rootSubject],
  historyTables: readonly (readonly string[])[] = [],
): Promise<SystemRecordVerifiedReplacementFactsV1> {
  const authority = await mintAuthority(head, table, history, historyTables, transitions);
  const registry = createSystemRecordVerifiedReplacementRegistryV1();
  const sessionIdentity = Object.freeze(Object.create(null) as object);
  const bindings = {
    networkId: head.networkId as NetworkIdV1,
    kind: 'agents' as const,
    mode: 'shadow' as const,
    sessionIdentity,
    activationGeneration: '7',
    childGeneration: '11',
    materializationEpoch: EPOCH,
  };
  const bytes = canonicalProjectionBytes(projection);
  const handle = registry.issuer.issueActive({
    ...bindings,
    admittedDeadlineMs: 42_000,
    head,
    verifiedAuthoritySummary: authority,
    canonicalProjectionBytes: bytes,
    projectionQuads: projection,
    ownedSubjectTable: table,
  });
  return registry.consumer.consume(handle, bindings);
}

async function mintAuthority(
  current: AgentProfileActiveHeadObjectV1,
  currentTable: readonly string[],
  history: readonly AgentProfileActiveHeadObjectV1[],
  historyTables: readonly (readonly string[])[],
  transitions: readonly AgentProfileAuthorityTransitionV1[],
) {
  const artifacts = new Map<string, {
    objectKind: 'agent-profile-head' | 'authority-transition' | 'profile-bundle' | 'owned-subject-table';
    digest: `0x${string}`;
    canonicalBytes: Uint8Array;
  }>();
  for (const [index, head] of [current, ...history].entries()) {
    const table = index === 0 ? currentTable : historyTables[index - 1] ?? [head.rootSubject];
    const digest = computeAgentProfileHeadObjectDigestV1(head);
    artifacts.set(`agent-profile-head:${digest}`, {
      objectKind: 'agent-profile-head', digest, canonicalBytes: headEnvelopeBytes(head),
    });
    artifacts.set(`owned-subject-table:${head.ownedSubjectTableDigest}`, {
      objectKind: 'owned-subject-table',
      digest: head.ownedSubjectTableDigest,
      canonicalBytes: canonicalizeOwnedSubjectTableObjectV1(head.rootSubject, table),
    });
  }
  for (const transition of transitions) {
    const digest = computeAgentProfileAuthorityTransitionDigestV1(transition);
    artifacts.set(`authority-transition:${digest}`, {
      objectKind: 'authority-transition', digest, canonicalBytes: transitionEnvelopeBytes(transition),
    });
  }
  artifacts.set(`profile-bundle:${current.bundleDigest}`, {
    objectKind: 'profile-bundle', digest: current.bundleDigest, canonicalBytes: BUNDLE_BYTES,
  });
  const closure = await buildAgentProfileVerificationClosureV1(
    computeAgentProfileHeadObjectDigestV1(current),
    {
      nowMs: Date.parse('2026-08-09T12:00:00Z'),
      resolve: async (reference) => artifacts.get(`${reference.objectKind}:${reference.digest}`),
      verifyAuthorityEnvelope: () => true,
      verifyCurrentBundle: (_head, bytes) => Buffer.from(bytes).equals(Buffer.from(BUNDLE_BYTES)),
    },
  );
  return closure.authoritySummary;
}

function headEnvelopeBytes(head: AgentProfileActiveHeadObjectV1): Uint8Array {
  const template = structuredClone(vectors.signed.activeEip191.envelope);
  const envelope = {
    ...template,
    object: head,
    objectDigest: computeAgentProfileHeadObjectDigestV1(head),
    signatures: template.signatures.map((signature) => ({
      ...signature,
      signer: signature.role === 'peer' ? head.peerId : head.evmIssuer,
    })),
  } as SignedAgentProfileHeadEnvelopeV1;
  return canonicalizeSignedSystemRecordEnvelopeV1(envelope);
}

function transitionEnvelopeBytes(transition: AgentProfileAuthorityTransitionV1): Uint8Array {
  const template = structuredClone(vectors.signed.coSignedTransitionEip191.envelope);
  const envelope = {
    ...template,
    object: transition,
    objectDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
    signatures: template.signatures.map((signature) => ({
      ...signature,
      signer: signature.role === 'peer'
        ? transition.peerId
        : signature.role === 'prior-evm'
          ? transition.priorEvmIssuer
          : transition.nextEvmIssuer,
    })),
  } as SignedAgentProfileAuthorityTransitionEnvelopeV1;
  return canonicalizeSignedSystemRecordEnvelopeV1(envelope);
}

function prepareHead(
  source: AgentProfileActiveHeadObjectV1,
  projection: readonly Readonly<{ subject: string; predicate: string; object: string; graph: string }>[],
  table: readonly string[] = [source.rootSubject],
): AgentProfileActiveHeadObjectV1 {
  const {
    previousHeadDigest,
    acceptedTransitionDigest,
    forkResolutionDigest,
    ...required
  } = source;
  const bytes = canonicalProjectionBytes(projection);
  const contentDigest = projectionContentDigest(projection);
  const address = source.evmIssuer;
  const history = {
    ...(previousHeadDigest === undefined ? {} : { previousHeadDigest }),
    ...(acceptedTransitionDigest === undefined ? {} : {
      acceptedTransitionDigest,
    }),
    ...(forkResolutionDigest === undefined ? {} : { forkResolutionDigest }),
  };
  return {
    ...required,
    ...history,
    ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(source.rootSubject, table),
    ownedSubjectCount: table.length.toString(),
    projectionBytes: bytes.byteLength.toString(),
    projectionQuads: projection.length.toString(),
    contentDigest,
    bundleDigest: BUNDLE_DIGEST,
    graphScopedAuthorSeal: {
      ...source.graphScopedAuthorSeal,
      assertionMerkleRoot: contentDigest,
      authorAddress: address,
      kaUal: `did:dkg:${source.networkId}/${address}/7`,
      reservedKaId: ((BigInt(address) << 96n) | 7n).toString(),
      publicTripleCount: projection.length.toString(),
    },
  } as AgentProfileActiveHeadObjectV1;
}

function smallProjection(head: Pick<AgentProfileActiveHeadObjectV1,
  'rootSubject' | 'peerId' | 'peerPublicKey' | 'evmIssuer'>) {
  return sortProjection([
    { subject: head.rootSubject, predicate: RDF_TYPE, object: 'https://dkg.network/ontology#Agent', graph: '' },
    ...agentProfileIdentityProjectionV1(head),
    { subject: head.rootSubject, predicate: 'https://schema.org/description', object: '"b"', graph: '' },
    { subject: head.rootSubject, predicate: 'https://schema.org/name', object: '"a"', graph: '' },
  ]);
}

function maximumProjection(head: Pick<AgentProfileActiveHeadObjectV1,
  'rootSubject' | 'peerId' | 'peerPublicKey' | 'evmIssuer'>) {
  const root = head.rootSubject;
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [
    { subject: root, predicate: RDF_TYPE, object: 'https://dkg.network/ontology#Agent', graph: '' },
    ...agentProfileIdentityProjectionV1(head),
  ];
  for (let index = 0; index < 9_996; index += 1) {
    quads.push({
      subject: root,
      predicate: 'https://schema.org/description',
      object: `"maximum-${index.toString().padStart(4, '0')}"`,
      graph: '',
    });
  }
  return sortProjection(quads);
}

function largeProjection(
  head: Pick<AgentProfileActiveHeadObjectV1,
    'rootSubject' | 'peerId' | 'peerPublicKey' | 'evmIssuer'>,
  kind: 'capability' | 'offering',
  count: number,
) {
  const root = head.rootSubject;
  const subjects = [root];
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [
    { subject: root, predicate: 'https://schema.org/name', object: '"large"', graph: '' },
    ...agentProfileIdentityProjectionV1(head),
  ];
  for (let index = 1; index <= count; index += 1) {
    const subject = `${root}/.well-known/genid/${kind === 'capability' ? 'cap' : 'offering'}${index}`;
    subjects.push(subject);
    quads.push({
      subject,
      predicate: RDF_TYPE,
      object: kind === 'capability'
        ? 'https://eips.ethereum.org/erc-8004#Capability'
        : 'https://dkg.origintrail.io/skill#SkillOffering',
      graph: '',
    }, {
      subject: root,
      predicate: kind === 'capability' ? CAPABILITY_LINK : OFFERING_LINK,
      object: subject,
      graph: '',
    });
  }
  subjects.sort(compareUtf8);
  return { subjects: Object.freeze(subjects), quads: sortProjection(quads) };
}

function sortProjection<T extends Readonly<{ subject: string; predicate: string; object: string; graph: string }>>(
  quads: readonly T[],
): readonly T[] {
  return Object.freeze([...quads].sort((left, right) => Buffer.compare(
    tripleContentV10(left.subject, left.predicate, left.object),
    tripleContentV10(right.subject, right.predicate, right.object),
  )));
}

function canonicalProjectionBytes(
  quads: readonly Readonly<{ subject: string; predicate: string; object: string }>[],
): Uint8Array {
  return new TextEncoder().encode(quads.map((quad) => (
    `${new TextDecoder().decode(tripleContentV10(quad.subject, quad.predicate, quad.object))}\n`
  )).join(''));
}

function projectionContentDigest(
  quads: readonly Readonly<{ subject: string; predicate: string; object: string }>[],
): `0x${string}` {
  const leaves = quads.map((quad) => keccak256(
    tripleContentV10(quad.subject, quad.predicate, quad.object),
  ));
  const root = V10MerkleTree.computeKARoot(new V10MerkleTree(leaves).root, SENTINEL_NO_PRIVATE_V10);
  return `0x${Buffer.from(root).toString('hex')}`;
}

function computeStableKey(head: AgentProfileActiveHeadObjectV1) {
  return computeSystemRecordStableKeyHashV1(head.networkId, head.peerId);
}

function quadKey(quad: Readonly<{ subject: string; predicate: string; object: string; graph: string }>) {
  return `${quad.graph}\u0000${quad.subject}\u0000${quad.predicate}\u0000${quad.object}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** Apply our branch of a fork, then quarantine it, and hand back that row. */
async function quarantinedForkFixtureV1(
  shape: 'based' | 'rotated' = 'based',
  terminalTransitionConflict = false,
  expectedHeadVersion = '1',
  expectedLineageLength = shape === 'rotated' ? 2 : 0,
) {
  const { binding, epochQuad } = makeAuthenticActiveReplacementFixtureV1('authoritative');
  const fork = await makeForkResolvingSuccessorFixtureV1(
    binding,
    shape,
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
      stableKeyHash: computeStableKey(activeFacts.head as AgentProfileActiveHeadObjectV1),
      materializationEpoch: activeFacts.materializationEpoch,
      quads: [epochQuad],
    }),
    observedRootClaimQuads: [],
  }));
  activeRegistry.consumer.release(activeFacts);

  const quarantineRegistry = createSystemRecordVerifiedReplacementRegistryV1();
  const quarantineFacts = quarantineRegistry.consumer.consume(
    quarantineRegistry.issuer.issueCandidate({
      operation: 'quarantine',
      ...fork.quarantineIssue,
    }),
    binding,
  );
  const quarantined = expectReady(deriveSystemRecordReplacementV1({
    facts: quarantineFacts,
    snapshot: replayedSnapshot(activeFacts.networkId, active),
    observedRootClaimQuads: active.plan.next.rootClaimQuads,
  }));
  quarantineRegistry.consumer.release(quarantineFacts);
  const quarantinedSnapshot = replayedSnapshot(quarantineFacts.networkId, quarantined);
  // The numbers the predicate tests turn on live on the summary side. They only
  // constrain the comparison if the persisted row genuinely took those values by
  // derivation, so assert the row before any test reads it. Without this a
  // fixture change could quietly align the two sides again and every predicate
  // test would keep passing for the wrong reason.
  if (quarantinedSnapshot.state !== 'present'
    || quarantinedSnapshot.appliedState.status !== 'quarantined'
    || quarantinedSnapshot.headVersion !== expectedHeadVersion
    || quarantinedSnapshot.appliedState.transitionLineage.length !== expectedLineageLength) {
    throw new Error(
      `fork fixture derived version ${quarantinedSnapshot.state === 'present'
        ? quarantinedSnapshot.headVersion : 'absent'} rather than the intended row`,
    );
  }
  return {
    binding,
    forkBaseHeadDigest: fork.forkBaseHeadDigest,
    successorIssue: fork.issue,
    observedRootClaimQuads: quarantined.plan.next.rootClaimQuads,
    quarantinedSnapshot,
  };
}

function replayedSnapshot(
  networkId: NetworkIdV1,
  ready: SystemRecordActiveReplacementReadyV1,
) {
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
