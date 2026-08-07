// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_MAX_OBJECT_CACHE_BYTES,
  SYSTEM_RECORD_MAX_OBJECT_CACHE_OBJECTS,
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryTreeSnapshotV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  AgentProfileProducerPublicationCommitLeaseV1,
  AgentProfileProducerPublicationCommitV1,
  AgentProfileProducerPublicationStoreV1,
} from './agent-profile-producer-v1.js';
import {
  cloneSystemRecordProviderArtifactV1,
  systemRecordProviderArtifactKeyV1,
  type SystemRecordProviderArtifactV1,
  type SystemRecordProviderLookupV1,
  type SystemRecordProviderRepositoryV1,
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
      return Object.freeze({
        inventory: inventory === null ? null : structuredClone(inventory),
        currentHead: currentHead === null ? null : structuredClone(currentHead),
      });
    },
    resolveArtifact(
      reference: Pick<SystemRecordProviderArtifactV1, 'objectKind' | 'objectDigest'>,
    ): SystemRecordProviderArtifactV1 | null {
      const artifact = artifacts.get(systemRecordProviderArtifactKeyV1(reference));
      return artifact === undefined
        ? null
        : cloneSystemRecordProviderArtifactV1(artifact);
    },
    prepareCommit(input: AgentProfileProducerPublicationCommitV1): AgentProfileProducerPublicationCommitLeaseV1 {
      if (prepared) throw new Error('publication store already has a prepared commit');
      if ((currentHead?.objectDigest ?? null) !== input.expectedHeadDigest
        || (inventory?.descriptorDigest ?? null) !== input.expectedRootDescriptorDigest) {
        throw new Error('publication store snapshot is stale');
      }
      // Reserve the expected state before materialization. A competing writer
      // cannot obtain a second lease and make the installed projection stale.
      prepared = true;
      try {
        let addedObjects = 0;
        let addedBytes = 0;
        for (const artifact of input.artifacts) {
          const key = systemRecordProviderArtifactKeyV1(artifact);
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
        let live = true;
        return Object.freeze({
          commit(): void {
            if (!live || !prepared) throw new Error('publication commit lease is not live');
            if ((currentHead?.objectDigest ?? null) !== input.expectedHeadDigest
              || (inventory?.descriptorDigest ?? null) !== input.expectedRootDescriptorDigest) {
              live = false;
              prepared = false;
              throw new Error('publication store snapshot changed during commit');
            }
            for (const artifact of input.artifacts) {
              artifacts.set(
                systemRecordProviderArtifactKeyV1(artifact),
                cloneSystemRecordProviderArtifactV1(artifact),
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
      } catch (error) {
        prepared = false;
        throw error;
      }
    },
    async resolve(lookup: SystemRecordProviderLookupV1): Promise<SystemRecordProviderArtifactV1 | null> {
      if (lookup.type === 'root') {
        if (rootEnvelope === null) return null;
        return cloneSystemRecordProviderArtifactV1({
          objectKind: 'root-descriptor',
          objectDigest: rootEnvelope.objectDigest,
          canonicalBytes: canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(rootEnvelope),
        });
      }
      if (lookup.rootDescriptorDigest !== undefined) {
        if (rootEnvelope === null || lookup.rootDescriptorDigest !== rootEnvelope.objectDigest) return null;
      }
      const artifact = artifacts.get(systemRecordProviderArtifactKeyV1({
        objectKind: lookup.objectKind,
        objectDigest: lookup.objectDigest,
      }));
      return artifact === undefined
        ? null
        : cloneSystemRecordProviderArtifactV1(artifact);
    },
  });
}
