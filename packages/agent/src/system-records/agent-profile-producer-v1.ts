// SPDX-License-Identifier: Apache-2.0

import {
  SENTINEL_NO_PRIVATE_V10,
  V10MerkleTree,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  encodeOpaqueKaBundleV1,
  keccak256,
  tripleContentV10,
  type AssertionCoordinateV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_OBJECT_CACHE_BYTES,
  SYSTEM_RECORD_MAX_OBJECT_CACHE_OBJECTS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  buildSystemRecordProviderSignatureMessageV1,
  buildSystemRecordSignatureMessageV1,
  buildSystemRecordInventoryTreeV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  canonicalizeSystemRecordRootDescriptorObjectV1,
  classifyAgentProfileOwnedSubjectV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordStableKeyHashV1,
  digestSystemRecordBytesV1,
  isAllowedAgentProfilePredicateV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  updateSystemRecordInventoryTreeV1,
  verifySignedSystemRecordEnvelopeV1,
  verifySignedSystemRecordRootDescriptorEnvelopeV1,
  type AgentProfileActiveHeadObjectV1,
  type Digest32V1,
  type NetworkIdV1,
  type OwnedSubjectTableObjectV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordInventoryTreeSnapshotV1,
  type SystemRecordObjectKindV1,
  type SystemRecordPeerPublicKeyV1,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { Quad } from '@origintrail-official/dkg-storage';

import type { EvmPersonalMessageSignerV1 } from '../evm-message-signer-v1.js';
import type { PreparedAgentProfileV1 } from '../profile.js';
import { assertRecoverableGraphScopedAuthorAttestationV1 } from '../rfc64/recoverable-author-attestation-v1.js';
import type {
  SystemRecordProviderArtifactV1,
  SystemRecordProviderRepositoryV1,
} from './provider-v1.js';

const UTF8 = new TextEncoder();

export interface SystemRecordPeerSignerV1 {
  readonly peerId: string;
  readonly publicKey: SystemRecordPeerPublicKeyV1;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface AgentProfilePublicationBindingV1 {
  /** Only a finalized VM publication may become signed-record authority. */
  readonly publicationStatus: 'confirmed';
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly projectionSchemaDigest: Digest32V1;
}

export interface AgentProfileProducerInstallInputV1 {
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly envelope: SignedAgentProfileHeadEnvelopeV1;
  readonly canonicalProjectionBytes: Uint8Array;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly signal: AbortSignal;
}

export interface AgentProfileProducerPublicationV1 {
  readonly headDigest: Digest32V1;
  readonly rootDescriptorDigest: Digest32V1;
  readonly version: string;
  readonly authoritySequence: string;
  readonly inventoryWrites: number;
  readonly inventoryWriteBytes: number;
}

export interface AgentProfileProducerPublicationCommitV1 {
  readonly artifacts: readonly SystemRecordProviderArtifactV1[];
  readonly inventory: SystemRecordInventoryTreeSnapshotV1;
  readonly rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1;
}

export interface AgentProfileProducerPublicationCommitLeaseV1 {
  commit(): void | Promise<void>;
  abort(): void;
}

export interface AgentProfileProducerPublicationStoreV1
  extends SystemRecordProviderRepositoryV1 {
  snapshot(): Readonly<{
    inventory: SystemRecordInventoryTreeSnapshotV1 | null;
    currentHead: SignedAgentProfileHeadEnvelopeV1 | null;
  }>;
  prepareCommit(
    input: AgentProfileProducerPublicationCommitV1,
  ): AgentProfileProducerPublicationCommitLeaseV1 | Promise<AgentProfileProducerPublicationCommitLeaseV1>;
}

export interface CreateAgentProfileProducerOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly peerSigner: SystemRecordPeerSignerV1;
  readonly evmSigner: EvmPersonalMessageSignerV1;
  readonly store: AgentProfileProducerPublicationStoreV1;
  /** Storage-runtime bridge: fence before publish, install before advertisement. */
  readonly fence: (
    prepared: PreparedAgentProfileV1,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly install: (input: AgentProfileProducerInstallInputV1) => void | Promise<void>;
}

export interface AgentProfileProducerLeaseV1 {
  complete(
    publication: AgentProfilePublicationBindingV1,
  ): Promise<AgentProfileProducerPublicationV1>;
  abort(reason?: unknown): void;
}

export interface AgentProfileProducerV1 {
  /** Fence one immutable profile before the legacy publication begins. */
  prepare(
    prepared: PreparedAgentProfileV1,
  ): Promise<AgentProfileProducerLeaseV1>;
}

/**
 * Author one local profile record. No protocol, timer, queue, or independent
 * runtime is created here; lifecycle supplies the B4 fence/install closures.
 */
export function createAgentProfileProducerV1(
  options: CreateAgentProfileProducerOptionsV1,
): AgentProfileProducerV1 {
  let active = false;
  const completePrepared = async (
    prepared: PreparedAgentProfileV1,
    projectionQuads: readonly Readonly<Quad>[],
    publication: AgentProfilePublicationBindingV1,
    signal: AbortSignal,
  ): Promise<AgentProfileProducerPublicationV1> => {
    signal.throwIfAborted();
    const snapshot = options.store.snapshot();
    const previous = snapshot.currentHead;
    if (previous !== null
      && (previous.object.networkId !== options.networkId
        || previous.object.peerId !== options.peerSigner.peerId)) {
      throw new Error('stored profile head belongs to a different stable record');
    }
    if (previous !== null && !await verifySignedSystemRecordEnvelopeV1(previous)) {
      throw new Error('stored profile head signature verification failed');
    }
    if (previous?.object.state === 'tombstone') {
      throw new Error('a tombstoned profile requires an explicit authority transition');
    }
    if (previous !== null && previous.object.evmIssuer !== options.evmSigner.address) {
      throw new Error('agent-profile authority transition must be authored explicitly');
    }

    if (publication.publicationStatus !== 'confirmed') {
      throw new Error('agent-profile system record requires a confirmed publication');
    }
    const projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(projectionQuads);
    const contentDigest = computeProjectionContentDigest(projectionQuads);
    if (contentDigest !== publication.seal.assertionMerkleRoot
      || publication.seal.authorAddress !== options.evmSigner.address
      || publication.seal.publicTripleCount !== String(projectionQuads.length)
      || publication.seal.privateTripleCount !== '0'
      || publication.seal.privateMerkleRoot !== null) {
      throw new Error('profile publication seal does not bind the exact public projection');
    }
    assertRecoverableGraphScopedAuthorAttestationV1(publication.seal);
    const ownedSubjectTable = ownedSubjects(prepared.rootEntity, projectionQuads);
    const ownedSubjectTableBytes = canonicalizeOwnedSubjectTableObjectV1(
      prepared.rootEntity,
      ownedSubjectTable,
    );
    const ownedSubjectTableDigest = computeOwnedSubjectTableDigestV1(
      prepared.rootEntity,
      ownedSubjectTable,
    );
    const sealBytes = UTF8.encode(canonicalizeCanonicalGraphScopedAuthorSealV1(publication.seal));
    const bundle = encodeOpaqueKaBundleV1(projectionBytes, sealBytes).bundleBytes;
    if (bundle.byteLength > SYSTEM_RECORD_OBJECT_CAPS_V1['profile-bundle']) {
      throw new Error('profile bundle exceeds the system-record V1 cap');
    }
    const bundleDigest = digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
      bundle,
    );
    const authoritySequence = previous?.object.authoritySequence ?? '0';
    const version = previous === null
      ? '0'
      : (BigInt(previous.object.version) + 1n).toString();
    if (previous !== null
      && (previous.object.rootSubject !== prepared.rootEntity
        || previous.object.projectionSchemaDigest !== publication.projectionSchemaDigest)) {
      throw new Error('ordinary profile update changed its root or projection schema');
    }
    const head: AgentProfileActiveHeadObjectV1 = {
      objectType: 'agent-profile-head',
      kind: 'agents',
      state: 'active',
      networkId: options.networkId,
      peerId: options.peerSigner.peerId,
      peerPublicKey: options.peerSigner.publicKey,
      authoritySequence: authoritySequence as never,
      version: version as never,
      ...(previous === null ? {} : { previousHeadDigest: previous.objectDigest }),
      evmIssuer: options.evmSigner.address as never,
      rootSubject: prepared.rootEntity,
      projectionSchemaDigest: publication.projectionSchemaDigest,
      issuedAt: publication.issuedAt as never,
      ownedSubjectTableDigest,
      ownedSubjectCount: String(ownedSubjectTable.length) as never,
      projectionBytes: String(projectionBytes.byteLength) as never,
      projectionQuads: String(projectionQuads.length) as never,
      validUntil: publication.validUntil as never,
      assertionCoordinate: publication.assertionCoordinate,
      graphScopedAuthorSeal: publication.seal,
      contentDigest,
      bundleDigest,
    };
    const headDigest = computeAgentProfileHeadObjectDigestV1(head);
    const [peerSignature, evmSignature] = await Promise.all([
      options.peerSigner.sign(
        buildSystemRecordSignatureMessageV1(head, headDigest, 'peer'),
      ),
      options.evmSigner.signMessage(
        buildSystemRecordSignatureMessageV1(head, headDigest, 'current-evm'),
      ),
    ]);
    signal.throwIfAborted();
    const envelope: SignedAgentProfileHeadEnvelopeV1 = {
      object: head,
      objectDigest: headDigest,
      signatures: Object.freeze([
        Object.freeze({
          role: 'peer',
          suite: 'ed25519-v1',
          signer: options.peerSigner.peerId,
          evidence: Object.freeze({ kind: 'none' }),
          signature: Buffer.from(peerSignature).toString('base64url'),
        }),
        Object.freeze({
          role: 'current-evm',
          suite: 'eip191-personal-sign-digest-v1',
          signer: options.evmSigner.address,
          evidence: Object.freeze({ kind: 'none' }),
          signature: evmSignature,
        }),
      ]),
    };
    if (!await verifySignedSystemRecordEnvelopeV1(envelope)) {
      throw new Error('new profile head signature verification failed');
    }
    const envelopeBytes = canonicalizeSignedSystemRecordEnvelopeV1(envelope);
    const row: SystemRecordInventoryRowV1 = {
      stableKeyHash: computeSystemRecordStableKeyHashV1(
        options.networkId,
        options.peerSigner.peerId,
      ),
      peerId: options.peerSigner.peerId,
      authoritySequence: head.authoritySequence,
      version: head.version,
      headDigest,
      tombstone: false,
      quarantined: false,
    };
    const inventoryUpdate = snapshot.inventory === null
      ? null
      : updateSystemRecordInventoryTreeV1(snapshot.inventory, {
          operation: 'upsert',
          row,
        });
    const inventory = inventoryUpdate === null
      ? buildSystemRecordInventoryTreeV1(options.networkId, [row])
      : applyInventoryUpdate(snapshot.inventory!, inventoryUpdate);
    const inventoryWrites = inventoryUpdate?.writes.length
      ?? inventory.objects.size + 1;
    const inventoryWriteBytes = inventoryUpdate?.accounting.encodedBytes
      ?? [...inventory.objects.values()].reduce(
        (sum, object) => sum + object.canonicalBytes.byteLength,
        0,
      ) + canonicalizeSystemRecordRootDescriptorObjectV1(inventory.descriptor).byteLength;
    const rootSignature = await options.peerSigner.sign(
      buildSystemRecordProviderSignatureMessageV1(
        inventory.descriptor,
        inventory.descriptorDigest,
        options.peerSigner.peerId,
      ),
    );
    signal.throwIfAborted();
    const rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1 = {
      object: inventory.descriptor,
      objectDigest: inventory.descriptorDigest,
      providerPeerId: options.peerSigner.peerId,
      signatureSuite: 'ed25519-v1',
      signature: Buffer.from(rootSignature).toString('base64url'),
    };
    if (!await verifySignedSystemRecordRootDescriptorEnvelopeV1(
      rootEnvelope,
      options.peerSigner.publicKey,
    )) {
      throw new Error('new profile inventory root signature verification failed');
    }
    const artifacts = publicationArtifacts({
      envelope,
      envelopeBytes,
      bundle,
      bundleDigest,
      ownedSubjectTableBytes,
      ownedSubjectTableDigest,
      inventory,
      inventoryUpdate,
    });

    const commitLease = await options.store.prepareCommit({ artifacts, inventory, rootEnvelope });
    let committed = false;
    try {
      signal.throwIfAborted();
      await options.install({
        head,
        envelope,
        canonicalProjectionBytes: projectionBytes,
        projectionQuads,
        ownedSubjectTable,
        signal,
      });
      signal.throwIfAborted();
      await commitLease.commit();
      committed = true;
    } finally {
      if (!committed) commitLease.abort();
    }
    return Object.freeze({
      headDigest,
      rootDescriptorDigest: inventory.descriptorDigest,
      version,
      authoritySequence,
      inventoryWrites,
      inventoryWriteBytes,
    });
  };

  return Object.freeze({
    async prepare(prepared: PreparedAgentProfileV1): Promise<AgentProfileProducerLeaseV1> {
      if (active) throw new Error('agent-profile producer is busy');
      const projectionQuads = validateAndProject(prepared);
      assertAdvertisedIdentity(
        prepared.rootEntity,
        projectionQuads,
        options.peerSigner,
        options.evmSigner.address,
      );
      active = true;
      const controller = new AbortController();
      try {
        await options.fence(prepared, controller.signal);
      } catch (error) {
        active = false;
        throw error;
      }
      let state: 'prepared' | 'completing' | 'settled' = 'prepared';
      return Object.freeze({
        async complete(
          publication: AgentProfilePublicationBindingV1,
        ): Promise<AgentProfileProducerPublicationV1> {
          if (state !== 'prepared') throw new Error('agent-profile producer lease is not live');
          state = 'completing';
          try {
            return await completePrepared(
              prepared,
              projectionQuads,
              publication,
              controller.signal,
            );
          } finally {
            state = 'settled';
            active = false;
          }
        },
        abort(reason?: unknown): void {
          if (state === 'settled') return;
          controller.abort(reason ?? new Error('agent-profile production aborted'));
          if (state === 'prepared') {
            state = 'settled';
            active = false;
          }
        },
      });
    },
  });
}

interface PublicationArtifactsInputV1 {
  readonly envelope: SignedAgentProfileHeadEnvelopeV1;
  readonly envelopeBytes: Uint8Array;
  readonly bundle: Uint8Array;
  readonly bundleDigest: Digest32V1;
  readonly ownedSubjectTableBytes: Uint8Array;
  readonly ownedSubjectTableDigest: Digest32V1;
  readonly inventory: SystemRecordInventoryTreeSnapshotV1;
  readonly inventoryUpdate: ReturnType<typeof updateSystemRecordInventoryTreeV1> | null;
}

function publicationArtifacts(
  input: PublicationArtifactsInputV1,
): readonly SystemRecordProviderArtifactV1[] {
  const artifacts: SystemRecordProviderArtifactV1[] = [
    freezeArtifact('agent-profile-head', input.envelope.objectDigest, input.envelopeBytes),
    freezeArtifact('profile-bundle', input.bundleDigest, input.bundle),
    freezeArtifact('owned-subject-table', input.ownedSubjectTableDigest, input.ownedSubjectTableBytes),
  ];
  const inventoryObjects = input.inventoryUpdate === null
    ? [...input.inventory.objects.entries()].map(([digest, stored]) => ({ digest, ...stored }))
    : input.inventoryUpdate.writes;
  for (const object of inventoryObjects) {
    artifacts.push(freezeArtifact(object.objectKind, object.digest, object.canonicalBytes));
  }
  return Object.freeze(artifacts);
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

function validateAndProject(
  prepared: PreparedAgentProfileV1,
): readonly Readonly<Quad>[] {
  if (!Object.isFrozen(prepared) || !Object.isFrozen(prepared.quads)) {
    throw new Error('prepared profile must be immutable');
  }
  const projected = prepared.quads.map((quad) => {
    const kind = classifyAgentProfileOwnedSubjectV1(prepared.rootEntity, quad.subject);
    if (kind === null || !isAllowedAgentProfilePredicateV1(kind, quad.predicate)) {
      throw new Error('profile projection contains a subject or predicate outside schema V1');
    }
    return Object.freeze({ ...quad, graph: '' });
  });
  return Object.freeze(projected.sort(compareQuads));
}

function ownedSubjects(
  rootSubject: string,
  quads: readonly Readonly<Quad>[],
): OwnedSubjectTableObjectV1 {
  const subjects = [...new Set(quads.map((quad) => quad.subject))].sort(compareUtf8);
  if (!subjects.includes(rootSubject)) {
    throw new Error('profile projection does not contain its canonical root subject');
  }
  return Object.freeze(subjects);
}

function computeProjectionContentDigest(
  quads: readonly Readonly<Quad>[],
): Digest32V1 {
  const leaves = quads.map((quad) => keccak256(
    tripleContentV10(quad.subject, quad.predicate, quad.object),
  ));
  const root = V10MerkleTree.computeKARoot(
    new V10MerkleTree(leaves).root,
    SENTINEL_NO_PRIVATE_V10,
  );
  return `0x${Buffer.from(root).toString('hex')}` as Digest32V1;
}

function compareQuads(left: Readonly<Quad>, right: Readonly<Quad>): number {
  return Buffer.compare(
    tripleContentV10(left.subject, left.predicate, left.object),
    tripleContentV10(right.subject, right.predicate, right.object),
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export interface InMemoryAgentProfilePublicationStoreOptionsV1 {
  readonly maxObjects?: number;
  readonly maxBytes?: number;
}

/** Default-off test/composition store. Production lifecycle must supply durable storage. */
export function createInMemoryAgentProfilePublicationStoreV1(
  options: InMemoryAgentProfilePublicationStoreOptionsV1 = {},
): AgentProfileProducerPublicationStoreV1 {
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
      const nextObjectCount = artifacts.size + addedObjects + (rootEnvelope === null ? 1 : 0);
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
              freezeArtifact(artifact.objectKind, artifact.objectDigest as Digest32V1, artifact.canonicalBytes),
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
        : freezeArtifact(artifact.objectKind, artifact.objectDigest as Digest32V1, artifact.canonicalBytes);
    },
  });
}

function artifactKey(kind: SystemRecordObjectKindV1, digest: string): string {
  return `${kind}:${digest}`;
}

function assertAdvertisedIdentity(
  rootSubject: string,
  quads: readonly Readonly<Quad>[],
  peerSigner: SystemRecordPeerSignerV1,
  evmAddress: string,
): void {
  const DKG = 'https://dkg.network/ontology#';
  const expected = new Map<string, string>([
    [`${DKG}peerId`, `"${peerSigner.peerId}"`],
    [`${DKG}agentAddress`, `"${evmAddress}"`],
    [
      `${DKG}publicKey`,
      `"${Buffer.from(peerSigner.publicKey, 'base64url').toString('base64')}"`,
    ],
  ]);
  for (const [predicate, object] of expected) {
    const matches = quads.filter((quad) =>
      quad.subject === rootSubject && quad.predicate === predicate && quad.object === object);
    if (matches.length !== 1) {
      throw new Error(`profile projection does not bind the signed ${predicate.slice(DKG.length)}`);
    }
  }
}
