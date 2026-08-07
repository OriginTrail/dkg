// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_MAX_OBJECT_CACHE_BYTES,
  SYSTEM_RECORD_MAX_OBJECT_CACHE_OBJECTS,
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  type Digest32V1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryTreeSnapshotV1,
  type SystemRecordObjectKindV1,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  AgentProfileProducerPublicationCommitLeaseV1,
  AgentProfileProducerPublicationCommitV1,
  AgentProfileProducerPublicationStoreV1,
} from './agent-profile-producer-v1.js';
import type {
  SystemRecordProviderArtifactV1,
  SystemRecordProviderRepositoryV1,
} from './provider-v1.js';

export interface InMemoryAgentProfilePublicationStoreOptionsV1 {
  readonly maxObjects?: number;
  readonly maxBytes?: number;
}

export interface InMemoryAgentProfilePublicationStoreV1
  extends AgentProfileProducerPublicationStoreV1, SystemRecordProviderRepositoryV1 {}

/** Default-off test/composition store. Production lifecycle must supply durable storage. */
export function createInMemoryAgentProfilePublicationStoreV1(
  options: InMemoryAgentProfilePublicationStoreOptionsV1 = {},
): InMemoryAgentProfilePublicationStoreV1 {
  const maxObjects = options.maxObjects ?? SYSTEM_RECORD_MAX_OBJECT_CACHE_OBJECTS;
  const maxBytes = options.maxBytes ?? SYSTEM_RECORD_MAX_OBJECT_CACHE_BYTES;
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1
    || maxObjects > SYSTEM_RECORD_MAX_OBJECT_CACHE_OBJECTS
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || maxBytes > SYSTEM_RECORD_MAX_OBJECT_CACHE_BYTES) {
    throw new TypeError('publication-store caps must be positive safe integers');
  }
  const artifacts = new Map<string, SystemRecordProviderArtifactV1>();
  let inventory: SystemRecordInventoryTreeSnapshotV1 | null = null;
  let currentHead: SignedAgentProfileHeadEnvelopeV1 | null = null;
  let rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1 | null = null;
  let bytes = 0;
  let rootBytes = 0;
  let prepared = false;
  return Object.freeze({
    snapshot() {
      return Object.freeze({ inventory, currentHead });
    },
    prepareCommit(input: AgentProfileProducerPublicationCommitV1): AgentProfileProducerPublicationCommitLeaseV1 {
      if (prepared) throw new Error('publication store already has a prepared commit');
      let addedObjects = 0;
      let addedBytes = 0;
      for (const artifact of input.artifacts) {
        const key = artifactKey(artifact.objectKind, artifact.objectDigest);
        const existing = artifacts.get(key);
        if (existing !== undefined) {
          if (!Buffer.from(existing.canonicalBytes).equals(Buffer.from(artifact.canonicalBytes))) {
            throw new Error('content-addressed provider object collision');
          }
          continue;
        }
        addedObjects += 1;
        addedBytes += artifact.canonicalBytes.byteLength;
      }
      const nextRootBytes = canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(input.rootEnvelope);
      const nextObjectCount = artifacts.size + addedObjects + 1;
      if (nextObjectCount > maxObjects
        || bytes + addedBytes - rootBytes + nextRootBytes.byteLength > maxBytes) {
        throw new Error('system-record provider cache capacity exhausted');
      }
      const headArtifact = input.artifacts.find((artifact) => artifact.objectKind === 'agent-profile-head');
      if (headArtifact === undefined) throw new Error('publication commit omitted the active head');
      const nextHead = parseCanonicalSignedAgentProfileHeadEnvelopeV1(headArtifact.canonicalBytes);
      prepared = true;
      let live = true;
      return Object.freeze({
        commit(): void {
          if (!live || !prepared) throw new Error('publication commit lease is not live');
          for (const artifact of input.artifacts) {
            artifacts.set(
              artifactKey(artifact.objectKind, artifact.objectDigest),
              freezeArtifact(artifact.objectKind, artifact.objectDigest, artifact.canonicalBytes),
            );
          }
          inventory = input.inventory;
          rootEnvelope = Object.freeze(structuredClone(input.rootEnvelope));
          currentHead = nextHead;
          bytes += addedBytes - rootBytes + nextRootBytes.byteLength;
          rootBytes = nextRootBytes.byteLength;
          live = false;
          prepared = false;
        },
        abort(): void {
          if (!live) return;
          live = false;
          prepared = false;
        },
      });
    },
    async resolve(request: SystemRecordRequestHeaderV1): Promise<SystemRecordProviderArtifactV1 | null> {
      if (request.operation === 'get-root') {
        if (rootEnvelope === null) return null;
        return freezeArtifact(
          'root-descriptor',
          rootEnvelope.objectDigest,
          canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(rootEnvelope),
        );
      }
      if (request.operation === 'get-inventory-object') {
        if (rootEnvelope === null || request.rootDescriptorDigest !== rootEnvelope.objectDigest) return null;
      }
      const artifact = artifacts.get(artifactKey(request.objectKind, request.objectDigest));
      return artifact === undefined
        ? null
        : freezeArtifact(artifact.objectKind, artifact.objectDigest, artifact.canonicalBytes);
    },
  });
}

function freezeArtifact(
  objectKind: SystemRecordObjectKindV1,
  objectDigest: Digest32V1,
  bytes: Uint8Array,
): SystemRecordProviderArtifactV1 {
  return Object.freeze({
    objectKind,
    objectDigest,
    canonicalBytes: Uint8Array.from(bytes),
  });
}

function artifactKey(kind: SystemRecordObjectKindV1, digest: string): string {
  return `${kind}:${digest}`;
}
