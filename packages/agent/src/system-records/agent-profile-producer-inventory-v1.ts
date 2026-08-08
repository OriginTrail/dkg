import {
  buildAgentProfileVerificationClosureV1,
  buildSystemRecordInventoryTreeV1,
  buildSystemRecordProviderSignatureMessageV1,
  canonicalizeSystemRecordRootDescriptorObjectV1,
  computeSystemRecordStableKeyHashV1,
  updateSystemRecordInventoryTreeV1,
  verifySignedSystemRecordEnvelopeV1,
  verifySignedSystemRecordRootDescriptorEnvelopeV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type Digest32V1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordInventoryTreeSnapshotV1,
  type SystemRecordObjectKindV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  flattenAgentProfileProducerPublicationArtifactsV1,
  type AgentProfileProducerArtifactV1,
  type AgentProfileProducerInventoryDependenciesV1,
  type AgentProfileProducerPublicationArtifactsV1,
} from './agent-profile-producer-contract-v1.js';
import type { AgentProfileProductionPreparationV1 } from './agent-profile-producer-preparation-v1.js';
import type { SignedAgentProfileProductionV1 } from './agent-profile-producer-signing-v1.js';
import { systemRecordArtifactKeyV1 } from './artifact-v1.js';

export interface AgentProfileProductionInventoryV1 {
  readonly inventory: SystemRecordInventoryTreeSnapshotV1;
  readonly rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1;
  readonly publicationArtifacts: AgentProfileProducerPublicationArtifactsV1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly inventoryWrites: number;
  readonly inventoryWriteBytes: number;
}

export async function prepareAgentProfileProductionInventoryV1(
  dependencies: AgentProfileProducerInventoryDependenciesV1,
  preparation: AgentProfileProductionPreparationV1,
  signed: SignedAgentProfileProductionV1,
  signal: AbortSignal,
): Promise<AgentProfileProductionInventoryV1> {
  const row: SystemRecordInventoryRowV1 = {
    stableKeyHash: computeSystemRecordStableKeyHashV1(
      dependencies.networkId,
      dependencies.peerSigner.peerId,
    ),
    peerId: dependencies.peerSigner.peerId,
    authoritySequence: preparation.head.authoritySequence,
    version: preparation.head.version,
    headDigest: preparation.headDigest,
    tombstone: false,
    quarantined: false,
  };
  const inventoryUpdate = preparation.snapshot.inventory === null
    ? null
    : updateSystemRecordInventoryTreeV1(preparation.snapshot.inventory, {
        operation: 'upsert',
        row,
      });
  const inventory = inventoryUpdate === null
    ? buildSystemRecordInventoryTreeV1(dependencies.networkId, [row])
    : applyInventoryUpdate(preparation.snapshot.inventory!, inventoryUpdate);
  const inventoryWrites = inventoryUpdate?.writes.length
    ?? inventory.objects.size + 1;
  const inventoryWriteBytes = inventoryUpdate?.accounting.encodedBytes
    ?? [...inventory.objects.values()].reduce(
      (sum, object) => sum + object.canonicalBytes.byteLength,
      0,
    ) + canonicalizeSystemRecordRootDescriptorObjectV1(inventory.descriptor).byteLength;
  const rootSignature = await dependencies.peerSigner.sign(
    buildSystemRecordProviderSignatureMessageV1(
      inventory.descriptor,
      inventory.descriptorDigest,
      dependencies.peerSigner.peerId,
    ),
  );
  signal.throwIfAborted();
  const rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1 = {
    object: inventory.descriptor,
    objectDigest: inventory.descriptorDigest,
    providerPeerId: dependencies.peerSigner.peerId,
    signatureSuite: 'ed25519-v1',
    signature: Buffer.from(rootSignature).toString('base64url'),
  };
  if (!await verifySignedSystemRecordRootDescriptorEnvelopeV1(
    rootEnvelope,
    dependencies.peerSigner.publicKey,
  )) {
    throw new Error('new profile inventory root signature verification failed');
  }
  const publicationArtifacts = publicationArtifactSet({
    signed,
    preparation,
    inventory,
    inventoryUpdate,
  });
  const artifacts = flattenAgentProfileProducerPublicationArtifactsV1(publicationArtifacts);
  const artifactsByKey = new Map(
    artifacts.map((artifact) => [systemRecordArtifactKeyV1(artifact), artifact]),
  );
  const verifiedClosure = await buildAgentProfileVerificationClosureV1(
    preparation.headDigest,
    {
      nowMs: preparation.verifierNowMs,
      resolve: async ({ objectKind, digest }) => {
        const reference = {
          objectKind,
          objectDigest: digest,
        } as const;
        const artifact = artifactsByKey.get(systemRecordArtifactKeyV1(reference))
          ?? await dependencies.resolveArtifact(reference);
        return artifact === undefined
          || artifact === null
          ? undefined
          : {
              objectKind: artifact.objectKind,
              digest: artifact.objectDigest,
              canonicalBytes: Uint8Array.from(artifact.canonicalBytes),
            };
      },
      verifyAuthorityEnvelope: (envelope) => verifySignedSystemRecordEnvelopeV1<
        AgentProfileHeadObjectV1 | AgentProfileAuthorityTransitionV1 | AgentProfileForkResolutionV1
      >(envelope),
      verifyCurrentBundle: (_candidate, canonicalBundleBytes) =>
        Buffer.from(canonicalBundleBytes).equals(Buffer.from(preparation.bundle)),
    },
  );
  signal.throwIfAborted();
  return Object.freeze({
    inventory,
    rootEnvelope,
    publicationArtifacts,
    verifiedAuthoritySummary: verifiedClosure.authoritySummary,
    inventoryWrites,
    inventoryWriteBytes,
  });
}

interface PublicationArtifactSetInputV1 {
  readonly signed: SignedAgentProfileProductionV1;
  readonly preparation: AgentProfileProductionPreparationV1;
  readonly inventory: SystemRecordInventoryTreeSnapshotV1;
  readonly inventoryUpdate: ReturnType<typeof updateSystemRecordInventoryTreeV1> | null;
}

function publicationArtifactSet(
  input: PublicationArtifactSetInputV1,
): AgentProfileProducerPublicationArtifactsV1 {
  const inventoryObjects = input.inventoryUpdate === null
    ? [...input.inventory.objects.entries()].map(([digest, stored]) => ({ digest, ...stored }))
    : input.inventoryUpdate.writes;
  return Object.freeze({
    head: freezeArtifact(
      'agent-profile-head',
      input.signed.envelope.objectDigest,
      input.signed.envelopeBytes,
    ),
    bundle: freezeArtifact(
      'profile-bundle',
      input.preparation.bundleDigest,
      input.preparation.bundle,
    ),
    ownedSubjectTable: freezeArtifact(
      'owned-subject-table',
      input.preparation.ownedSubjectTableDigest,
      input.preparation.ownedSubjectTableBytes,
    ),
    inventoryObjects: Object.freeze(inventoryObjects.map((object) => freezeArtifact(
      object.objectKind,
      object.digest,
      object.canonicalBytes,
    ))),
  });
}

function freezeArtifact<const Kind extends SystemRecordObjectKindV1>(
  objectKind: Kind,
  objectDigest: Digest32V1,
  bytes: Uint8Array,
): AgentProfileProducerArtifactV1<Kind> {
  return Object.freeze({
    objectKind,
    objectDigest,
    canonicalBytes: Uint8Array.from(bytes),
  });
}

function applyInventoryUpdate(
  previous: SystemRecordInventoryTreeSnapshotV1,
  update: ReturnType<typeof updateSystemRecordInventoryTreeV1>,
): SystemRecordInventoryTreeSnapshotV1 {
  if (!update.changed) return previous;
  const objects = new Map(previous.objects);
  for (const write of update.writes) {
    objects.set(write.digest, Object.freeze({
      objectKind: write.objectKind,
      object: write.object,
      canonicalBytes: Uint8Array.from(write.canonicalBytes),
    }));
  }
  return Object.freeze({
    networkId: previous.networkId,
    descriptor: update.descriptor,
    descriptorDigest: update.descriptorDigest,
    objects,
  });
}
