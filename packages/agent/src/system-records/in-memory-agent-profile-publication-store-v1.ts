// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_MAX_OBJECT_CACHE_BYTES,
  SYSTEM_RECORD_MAX_OBJECT_CACHE_OBJECTS,
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  parseCanonicalSystemRecordInventoryInternalObjectV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryTreeSnapshotV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  type AgentProfileProducerPublicationCommitLeaseV1,
  type AgentProfileProducerPublicationCommitV1,
  type AgentProfileProducerPublicationStoreV1,
} from './agent-profile-producer-v1.js';
import { flattenAgentProfileProducerPublicationArtifactsV1 } from './agent-profile-producer-artifacts-v1-internal.js';
import {
  cloneSystemRecordArtifactV1,
  systemRecordArtifactKeyV1,
  type SystemRecordArtifactLookupV1,
  type SystemRecordArtifactRepositoryV1,
  type SystemRecordArtifactV1,
} from './artifact-v1.js';

export interface InMemoryAgentProfilePublicationStoreOptionsV1 {
  readonly maxObjects?: number;
  readonly maxBytes?: number;
}

export interface InMemoryAgentProfilePublicationStoreV1
  extends AgentProfileProducerPublicationStoreV1, SystemRecordArtifactRepositoryV1 {}

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
  const artifacts = new Map<string, SystemRecordArtifactV1>();
  const rootEnvelopes = new Map<string, SignedSystemRecordRootDescriptorEnvelopeV1>();
  let inventory: SystemRecordInventoryTreeSnapshotV1 | null = null;
  let currentHead: SignedAgentProfileHeadEnvelopeV1 | null = null;
  let rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1 | null = null;
  let bytes = 0;
  let prepared = false;
  return Object.freeze({
    snapshot() {
      return Object.freeze({
        inventory: inventory === null ? null : structuredClone(inventory),
        currentHead: currentHead === null ? null : structuredClone(currentHead),
      });
    },
    resolveArtifact(
      reference: Pick<SystemRecordArtifactV1, 'objectKind' | 'objectDigest'>,
    ): SystemRecordArtifactV1 | null {
      const artifact = artifacts.get(systemRecordArtifactKeyV1(reference));
      return artifact === undefined
        ? null
        : cloneSystemRecordArtifactV1(artifact);
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
        const publicationArtifacts = flattenAgentProfileProducerPublicationArtifactsV1(
          input.publicationArtifacts,
        );
        let addedObjects = 0;
        let addedBytes = 0;
        for (const artifact of publicationArtifacts) {
          const key = systemRecordArtifactKeyV1(artifact);
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
        const existingRoot = rootEnvelopes.get(input.rootEnvelope.objectDigest);
        if (existingRoot !== undefined && !Buffer.from(
          canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(existingRoot),
        ).equals(Buffer.from(nextRootBytes))) {
          throw new Error('content-addressed provider root collision');
        }
        const addsRoot = existingRoot === undefined;
        const nextObjectCount = artifacts.size + addedObjects + rootEnvelopes.size + (addsRoot ? 1 : 0);
        if (nextObjectCount > maxObjects
          || bytes + addedBytes + (addsRoot ? nextRootBytes.byteLength : 0) > maxBytes) {
          throw new Error('system-record provider cache capacity exhausted');
        }
        const nextHead = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
          input.publicationArtifacts.head.canonicalBytes,
        );
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
            for (const artifact of publicationArtifacts) {
              artifacts.set(
                systemRecordArtifactKeyV1(artifact),
                cloneSystemRecordArtifactV1(artifact),
              );
            }
            inventory = input.inventory;
            rootEnvelope = existingRoot ?? Object.freeze(structuredClone(input.rootEnvelope));
            if (addsRoot) rootEnvelopes.set(rootEnvelope.objectDigest, rootEnvelope);
            currentHead = nextHead;
            bytes += addedBytes + (addsRoot ? nextRootBytes.byteLength : 0);
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
    async resolve(lookup: SystemRecordArtifactLookupV1): Promise<SystemRecordArtifactV1 | null> {
      if (lookup.type === 'root') {
        if (rootEnvelope === null) return null;
        return cloneSystemRecordArtifactV1({
          objectKind: 'root-descriptor',
          objectDigest: rootEnvelope.objectDigest,
          canonicalBytes: canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(rootEnvelope),
        });
      }
      if (lookup.type === 'inventory-object') {
        const requestedRoot = rootEnvelopes.get(lookup.rootDescriptorDigest);
        if (requestedRoot === undefined
          || !inventoryLookupMatchesV1(requestedRoot, lookup, artifacts)) return null;
      }
      const artifact = artifacts.get(systemRecordArtifactKeyV1({
        objectKind: lookup.objectKind,
        objectDigest: lookup.objectDigest,
      }));
      return artifact === undefined
        ? null
        : cloneSystemRecordArtifactV1(artifact);
    },
  });
}

function inventoryLookupMatchesV1(
  rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1,
  lookup: Extract<SystemRecordArtifactLookupV1, { type: 'inventory-object' }>,
  artifacts: ReadonlyMap<string, SystemRecordArtifactV1>,
): boolean {
  let expectedDigest = rootEnvelope.object.treeRootDigest;
  let expectedKind: 'inventory-internal' | 'inventory-leaf' | undefined;
  for (let depth = 0; depth < lookup.path.length; depth += 1) {
    const parent = artifacts.get(systemRecordArtifactKeyV1({
      objectKind: 'inventory-internal',
      objectDigest: expectedDigest,
    }));
    if (parent === undefined) return false;
    try {
      const internal = parseCanonicalSystemRecordInventoryInternalObjectV1(
        parent.canonicalBytes,
        depth === 0,
      );
      const entry = internal.entries[lookup.path[depth]!];
      if (entry === undefined) return false;
      expectedDigest = entry.childDigest;
      expectedKind = entry.childKind;
    } catch {
      return false;
    }
  }
  return expectedDigest === lookup.objectDigest
    && (expectedKind === undefined || expectedKind === lookup.objectKind);
}
