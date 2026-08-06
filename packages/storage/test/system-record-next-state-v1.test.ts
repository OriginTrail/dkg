import { readFileSync } from 'node:fs';

import {
  keccak256,
  SENTINEL_NO_PRIVATE_V10,
  tripleContentV10,
  V10MerkleTree,
} from '@origintrail-official/dkg-core';
import {
  buildAgentProfileVerificationClosureV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
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

const initialProjection = smallProjection(vectors.variants.active.object.rootSubject);
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

    expect(ready.nextAppliedState).toMatchObject({
      stateRevision: '1', status: 'active',
    });
    expect(ready.nextAppliedState.transitionLineage).toHaveLength(0);
    expect(ready.next.headVersion).toBe('0');
    expect(ready.next.capacityState).toMatchObject({ revision: '1', liveRecordCount: '1' });
    expect(ready.previousReservedQuads).toHaveLength(1);
    expect(ready.nextReservedQuads).toHaveLength(15);
    expect(ready.requiredAbsentReservedSubjects).toHaveLength(4);
    expect(ready.conditionalApply.previousReservedQuads).toBe(ready.previousReservedQuads);
    expect(ready.postReadExpectation.reservedQuads).toBe(ready.nextReservedQuads);
    expect(ready.success).toEqual({
      stateRevision: '1',
      appliedStateDigest: computeSystemRecordAppliedStateDigestV1(ready.nextAppliedState),
    });
    expect(ready.next.receiptDigest).toBe(
      computeSystemRecordMaterializationReceiptDigestV1(ready.next.receipt),
    );
    expect(repeated.next.receiptDigest).toBe(ready.next.receiptDigest);
    expect(repeated.nextReservedQuads).toEqual(ready.nextReservedQuads);
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
    expect(result.nextAppliedState).toMatchObject({
      currentRoot: rotated.head.rootSubject,
      historicalRoots: [INITIAL.rootSubject],
    });
    expect(result.nextAppliedState.transitionLineage).toHaveLength(1);
    expect(result.next.headVersion).toBe('0');
    expect(result.requiredAbsentReservedSubjects).toHaveLength(5);
    expect(result.next.rootClaimQuads).toHaveLength(6);
  });

  it('returns a complete authentic already-applied result for one equal head', () => {
    const cold = coldReady();
    const snapshot = snapshotFrom(cold);
    const result = deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot,
      observedRootClaimQuads: cold.next.rootClaimQuads,
    });
    expect(result.outcome).toBe('already-applied');
    if (result.outcome !== 'already-applied') throw new Error('expected already-applied');
    expect(result.nextReservedQuads).toEqual(result.previousReservedQuads);
    expect(result.success).toEqual(cold.success);
    expect(result.conditionalApply.nextProjectionQuads).toBe(INITIAL_FACTS.projectionQuads);
    expect(() => assertAuthenticSystemRecordActiveReplacementCompleteV1(result)).not.toThrow();
  });

  it('never acknowledges an equal digest whose canonical persisted tuple disagrees with the head', () => {
    const cold = coldReady();
    const inconsistent = snapshotWithAppliedState(cold, {
      ...cold.next.appliedState,
      projectionDigest: `0x${'ab'.repeat(32)}`,
    });
    expect(deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot: inconsistent,
      observedRootClaimQuads: cold.next.rootClaimQuads,
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
      observedRootClaimQuads: cold.next.rootClaimQuads,
    }));
    expect(fast.next.headVersion).toBe('2');

    const fastSnapshot = snapshotFrom(fast);
    expect(deriveSystemRecordActiveReplacementV1({
      facts: INITIAL_FACTS,
      snapshot: fastSnapshot,
      observedRootClaimQuads: fast.next.rootClaimQuads,
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
      observedRootClaimQuads: cold.next.rootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'authority-fork' });
  });

  it('accepts exact +1 authority progression and rejects wrong predecessor and >+1', async () => {
    const cold = coldReady();
    const snapshot = snapshotFrom(cold);
    const rotated = await rotatedFixture(INITIAL);
    const accepted = expectReady(deriveSystemRecordActiveReplacementV1({
      facts: rotated.facts,
      snapshot,
      observedRootClaimQuads: cold.next.rootClaimQuads,
    }));
    expect(accepted.nextAppliedState.historicalRoots).toEqual([INITIAL.rootSubject]);
    expect(accepted.requiredAbsentReservedSubjects).toContain(
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
      observedRootClaimQuads: cold.next.rootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'authority-history-mismatch' });

    const twice = await twiceRotatedFixture();
    expect(deriveSystemRecordActiveReplacementV1({
      facts: twice.facts,
      snapshot,
      observedRootClaimQuads: cold.next.rootClaimQuads,
    })).toEqual({ outcome: 'deferred', reason: 'authority-history-mismatch' });
  });

  it('classifies root collision and aggregate capacity refusal with zero prepared output', () => {
    const cold = coldReady();
    const foreignClaim = cold.next.rootClaimQuads.map((quad) => (
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
        ...cold.next.appliedState,
        stateRevision: maxU64,
      }),
      observedRootClaimQuads: cold.next.rootClaimQuads,
    })).toEqual({ outcome: 'capacity-exhausted', reason: 'state-revision-overflow' });

    expect(deriveSystemRecordActiveReplacementV1({
      facts: nextFacts,
      snapshot: snapshotWithCapacityState(cold, {
        ...cold.next.capacityState,
        revision: maxU64,
      }),
      observedRootClaimQuads: cold.next.rootClaimQuads,
    })).toEqual({ outcome: 'capacity-exhausted', reason: 'capacity-revision-overflow' });
  });

  it('refuses a 2,049-subject replacement union before producing a command', async () => {
    const priorData = largeProjection(INITIAL.rootSubject, 'capability', 1_024);
    const priorHead = prepareHead(INITIAL, priorData.quads, priorData.subjects);
    const priorFacts = await factsFor(priorHead, priorData.quads, [], [], priorData.subjects);
    const priorReady = expectReady(deriveSystemRecordActiveReplacementV1({
      facts: priorFacts,
      snapshot: absentSnapshot(INITIAL.networkId),
      observedRootClaimQuads: [],
    }));
    const nextData = largeProjection(INITIAL.rootSubject, 'offering', 1_024);
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
      observedRootClaimQuads: priorReady.next.rootClaimQuads,
    })).toEqual({ outcome: 'capacity-exhausted', reason: 'subject-union-cap' });
  }, 20_000);

  it(
    'prepares the exact 10,000-quad protocol maximum within the 4 MiB request bound', async () => {
    const projection = maximumProjection(INITIAL.rootSubject);
    const head = prepareHead(INITIAL, projection);
    const facts = await factsFor(head, projection);
    const ready = expectReady(deriveSystemRecordActiveReplacementV1({
      facts,
      snapshot: absentSnapshot(INITIAL.networkId),
      observedRootClaimQuads: [],
    }));
    const update = buildSystemRecordConditionalApplyUpdateV1(ready);

    expect(ready.nextProjectionQuads).toHaveLength(10_000);
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
        observedRootClaimQuads: cold.next.rootClaimQuads,
      })).toEqual({ outcome: 'deferred', reason: 'non-active-state' });
    }
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
    appliedState: ready.next.appliedState,
    headVersion: ready.next.headVersion,
    ownedSubjectTable: ready.next.ownedSubjectTable,
    rootClaimSet: ready.next.rootClaimSet,
    capacityState,
    receipt: ready.next.receipt,
  });
  return decodeSystemRecordAppliedSnapshotV1({
    networkId: INITIAL.networkId,
    stableKeyHash: computeStableKey(INITIAL),
    materializationEpoch: EPOCH,
    quads: [...quads.capacity, ...quads.epoch],
  });
}

function snapshotFrom(value: SystemRecordActiveReplacementCompleteV1): SystemRecordAppliedSnapshotV1 {
  const rootKeys = new Set(value.next.rootClaimQuads.map(quadKey));
  return decodeSystemRecordAppliedSnapshotV1({
    networkId: value.next.appliedState.networkId,
    stableKeyHash: value.next.appliedState.stableKeyHash,
    materializationEpoch: value.next.materializationEpoch,
    quads: value.nextReservedQuads.filter((quad) => !rootKeys.has(quadKey(quad))),
  });
}

function snapshotWithAppliedState(
  ready: SystemRecordActiveReplacementReadyV1,
  appliedState: SystemRecordAppliedStatePresentV1,
): SystemRecordAppliedSnapshotV1 {
  const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
  const receipt: SystemRecordMaterializationReceiptV1 = {
    ...ready.next.receipt,
    appliedStateDigest,
    headDigest: appliedState.headDigest,
    stateRevision: appliedState.stateRevision,
  };
  const quads = buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion: ready.next.headVersion,
    ownedSubjectTable: ready.next.ownedSubjectTable,
    rootClaimSet: ready.next.rootClaimSet,
    capacityState: ready.next.capacityState,
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
    appliedState: ready.next.appliedState,
    headVersion: ready.next.headVersion,
    ownedSubjectTable: ready.next.ownedSubjectTable,
    rootClaimSet: ready.next.rootClaimSet,
    capacityState,
    receipt: ready.next.receipt,
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
  const base = ready.next.appliedState;
  let appliedState: SystemRecordAppliedStatePresentV1;
  let table = ready.next.ownedSubjectTable;
  let capacityState = ready.next.capacityState;
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
    ...ready.next.receipt,
    appliedStateDigest,
    headDigest: appliedState.headDigest,
  };
  const quads = buildSystemRecordReservedStateQuadsV1({
    appliedState,
    headVersion: ready.next.headVersion,
    ownedSubjectTable: table,
    rootClaimSet: ready.next.rootClaimSet,
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
  const projection = smallProjection(transition.nextRoot);
  const head = prepareHead({
    ...prior,
    authoritySequence: transition.nextAuthoritySequence,
    version: '0',
    acceptedTransitionDigest: transitionDigest,
    evmIssuer: transition.nextEvmIssuer,
    rootSubject: transition.nextRoot,
    issuedAt: '2026-08-07T12:01:00Z',
    validUntil: '2026-08-10T12:01:00Z',
    previousHeadDigest: undefined,
  } as unknown as AgentProfileActiveHeadObjectV1, projection);
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
  const projection = smallProjection(transition.nextRoot);
  const head = prepareHead({
    ...first.head,
    authoritySequence: '2',
    version: '0',
    acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
    evmIssuer: nextIssuer,
    rootSubject: transition.nextRoot,
    issuedAt: '2026-08-08T12:01:00Z',
    validUntil: '2026-08-11T12:01:00Z',
    previousHeadDigest: undefined,
  } as unknown as AgentProfileActiveHeadObjectV1, projection);
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

function smallProjection(root: string) {
  return sortProjection([
    { subject: root, predicate: RDF_TYPE, object: 'https://dkg.network/ontology#Agent', graph: '' },
    { subject: root, predicate: 'https://schema.org/description', object: '"b"', graph: '' },
    { subject: root, predicate: 'https://schema.org/name', object: '"a"', graph: '' },
  ]);
}

function maximumProjection(root: string) {
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [
    { subject: root, predicate: RDF_TYPE, object: 'https://dkg.network/ontology#Agent', graph: '' },
  ];
  for (let index = 0; index < 9_999; index += 1) {
    quads.push({
      subject: root,
      predicate: 'https://schema.org/description',
      object: `"maximum-${index.toString().padStart(4, '0')}"`,
      graph: '',
    });
  }
  return sortProjection(quads);
}

function largeProjection(root: string, kind: 'capability' | 'offering', count: number) {
  const subjects = [root];
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [
    { subject: root, predicate: 'https://schema.org/name', object: '"large"', graph: '' },
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
