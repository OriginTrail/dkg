import {
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  buildSystemRecordInventoryTreeV1,
  buildSystemRecordProviderSignatureMessageV1,
  canonicalizeAgentProfileConflictEvidenceV1,
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeSystemRecordStableKeyHashV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileTombstoneHeadObjectV1,
  type Digest32V1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  systemRecordArtifactKeyV1,
  type SystemRecordArtifactLookupV1,
  type SystemRecordArtifactRepositoryV1,
  type SystemRecordArtifactV1,
} from '../../src/system-records/artifact-v1.js';
import {
  createFixtureAgentProfileProducerV1,
  DEPLOYMENT,
  NETWORK,
  envelopeArtifact,
  produce,
  producerFixture,
  signHeadEnvelope,
} from './agent-profile-producer-v1-fixture.js';

export async function conflictReconcileFixture(
  conflict: 'active' | 'tombstone',
) {
  const fixture = await producerFixture();
  const producer = createFixtureAgentProfileProducerV1({
    networkId: NETWORK,
    publicationDeployment: DEPLOYMENT,
    peerSigner: fixture.peerSigner,
    evmSigner: fixture.evmSigner,
    store: fixture.store,
    fence: () => undefined,
    install: () => undefined,
  });
  await produce(producer, fixture.prepared, fixture.publication);
  const predecessorEnvelope = fixture.store.snapshot().currentHead;
  if (predecessorEnvelope === null) throw new Error('conflict fixture lacks its predecessor');
  const predecessor = predecessorEnvelope.object;
  const version = String(BigInt(predecessor.version) + 1n);
  const current: AgentProfileActiveHeadObjectV1 = Object.freeze({
    ...predecessor,
    version,
    previousHeadDigest: predecessorEnvelope.objectDigest,
    issuedAt: '2026-08-07T12:09:00Z',
  });
  const currentEnvelope = await signHeadEnvelope(current, fixture.peerSigner, fixture.evmSigner);
  const conflicting = conflict === 'active'
    ? Object.freeze({
      ...current,
      issuedAt: '2026-08-07T12:10:00Z',
    })
    : Object.freeze({
      objectType: 'agent-profile-head' as const,
      kind: 'agents' as const,
      state: 'tombstone' as const,
      networkId: predecessor.networkId,
      peerId: predecessor.peerId,
      peerPublicKey: predecessor.peerPublicKey,
      authoritySequence: predecessor.authoritySequence,
      version,
      ...(predecessor.acceptedTransitionDigest === undefined ? {} : {
        acceptedTransitionDigest: predecessor.acceptedTransitionDigest,
      }),
      previousHeadDigest: predecessorEnvelope.objectDigest,
      evmIssuer: predecessor.evmIssuer,
      rootSubject: predecessor.rootSubject,
      projectionSchemaDigest: predecessor.projectionSchemaDigest,
      issuedAt: '2026-08-07T12:10:00Z',
      ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
      ownedSubjectCount: '0',
      projectionBytes: '0',
      projectionQuads: '0',
    } satisfies AgentProfileTombstoneHeadObjectV1);
  const conflictingEnvelope = await signHeadEnvelope(
    conflicting,
    fixture.peerSigner,
    fixture.evmSigner,
  );
  const evidence: AgentProfileConflictEvidenceV1 = Object.freeze({
    objectType: 'conflict-evidence',
    kind: 'agents',
    networkId: NETWORK,
    peerId: predecessor.peerId,
    entries: Object.freeze([Object.freeze({
      type: 'fork',
      authoritySequence: current.authoritySequence,
      version,
      objectDigests: Object.freeze([
        currentEnvelope.objectDigest,
        conflictingEnvelope.objectDigest,
      ].sort()) as readonly Digest32V1[],
    })]),
  });
  const evidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    stableKeyHash: computeSystemRecordStableKeyHashV1(NETWORK, predecessor.peerId),
    peerId: predecessor.peerId,
    authoritySequence: current.authoritySequence,
    version,
    headDigest: currentEnvelope.objectDigest,
    tombstone: false,
    quarantined: true,
    conflictEvidenceDigest: evidenceDigest,
  });
  const inventory = buildSystemRecordInventoryTreeV1(NETWORK, [row]);
  const rootEnvelope = await signRoot(fixture, inventory.descriptor, inventory.descriptorDigest);
  const overlays: SystemRecordArtifactV1[] = [
    envelopeArtifact('agent-profile-head', currentEnvelope),
    envelopeArtifact('agent-profile-head', conflictingEnvelope),
    Object.freeze({
      objectKind: 'conflict-evidence',
      objectDigest: evidenceDigest,
      canonicalBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
    }),
    ...[...inventory.objects.entries()].map(([objectDigest, stored]) => Object.freeze({
      objectKind: stored.objectKind,
      objectDigest,
      canonicalBytes: Uint8Array.from(stored.canonicalBytes),
    })),
  ];
  const repository = overlayRepository(fixture.store, rootEnvelope, overlays);
  return Object.freeze({
    ...fixture,
    predecessorEnvelope,
    current,
    conflicting,
    currentEnvelope,
    conflictingEnvelope,
    evidence,
    row,
    rootEnvelope,
    repository,
  });
}

async function signRoot(
  fixture: Awaited<ReturnType<typeof producerFixture>>,
  object: SignedSystemRecordRootDescriptorEnvelopeV1['object'],
  objectDigest: Digest32V1,
): Promise<SignedSystemRecordRootDescriptorEnvelopeV1> {
  const signature = await fixture.peerSigner.sign(buildSystemRecordProviderSignatureMessageV1(
    object,
    objectDigest,
    fixture.peerSigner.peerId,
  ));
  return Object.freeze({
    object,
    objectDigest,
    providerPeerId: fixture.peerSigner.peerId,
    signatureSuite: 'ed25519-v1',
    signature: Buffer.from(signature).toString('base64url'),
  });
}

function overlayRepository(
  base: SystemRecordArtifactRepositoryV1,
  rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1,
  artifacts: readonly SystemRecordArtifactV1[],
): SystemRecordArtifactRepositoryV1 {
  const overlay = new Map(artifacts.map((artifact) => [
    systemRecordArtifactKeyV1(artifact),
    artifact,
  ]));
  return Object.freeze({
    async resolve(lookup: SystemRecordArtifactLookupV1, signal: AbortSignal) {
      signal.throwIfAborted();
      if (lookup.type === 'root') {
        return Object.freeze({
          objectKind: 'root-descriptor',
          objectDigest: rootEnvelope.objectDigest,
          canonicalBytes: canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(rootEnvelope),
        });
      }
      const artifact = overlay.get(systemRecordArtifactKeyV1({
        objectKind: lookup.objectKind,
        objectDigest: lookup.objectDigest,
      }));
      if (artifact !== undefined) return artifact;
      return base.resolve(lookup, signal);
    },
  });
}
