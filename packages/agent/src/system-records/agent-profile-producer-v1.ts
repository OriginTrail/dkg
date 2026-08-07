// SPDX-License-Identifier: Apache-2.0

import {
  SENTINEL_NO_PRIVATE_V10,
  V10MerkleTree,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  encodeOpaqueKaBundleV1,
  keccak256,
  parseDeterministicKnowledgeAssetUal,
  tripleContentV10,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  type AssertionCoordinateV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
} from '@origintrail-official/dkg-core';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_CLOCK_SKEW_MS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  assertAgentProfileProjectionSchemaV1,
  assertCanonicalRfc3339SecondsV1,
  buildSystemRecordProviderSignatureMessageV1,
  buildSystemRecordSignatureMessageV1,
  buildSystemRecordInventoryTreeV1,
  buildAgentProfileVerificationClosureV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  canonicalizeSystemRecordRootDescriptorObjectV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordStableKeyHashV1,
  digestSystemRecordBytesV1,
  updateSystemRecordInventoryTreeV1,
  verifySignedSystemRecordEnvelopeV1,
  verifySignedSystemRecordRootDescriptorEnvelopeV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type CanonicalRfc3339SecondsV1,
  type Digest32V1,
  type NetworkIdV1,
  type OwnedSubjectTableObjectV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordInventoryTreeSnapshotV1,
  type SystemRecordObjectKindV1,
  type SystemRecordPeerPublicKeyV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { Quad } from '@origintrail-official/dkg-storage';

import type { EvmPersonalMessageSignerV1 } from '../evm-message-signer-v1.js';
import {
  agentProfileAdvertisedIdentityV1,
  type PreparedAgentProfileV1,
} from '../profile.js';
import { assertRecoverableGraphScopedAuthorAttestationV1 } from '../rfc64/recoverable-author-attestation-v1.js';
import {
  cloneSystemRecordProviderArtifactV1,
  systemRecordProviderArtifactKeyV1,
  type SystemRecordProviderArtifactV1,
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
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
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
  /** Snapshot preconditions reserved before materialization begins. */
  readonly expectedHeadDigest: Digest32V1 | null;
  readonly expectedRootDescriptorDigest: Digest32V1 | null;
  readonly artifacts: readonly SystemRecordProviderArtifactV1[];
  readonly inventory: SystemRecordInventoryTreeSnapshotV1;
  readonly rootEnvelope: SignedSystemRecordRootDescriptorEnvelopeV1;
}

export interface AgentProfileProducerPublicationCommitLeaseV1 {
  commit(): void | Promise<void>;
  abort(): void;
}

export interface AgentProfileProducerPublicationStoreV1 {
  snapshot(): Readonly<{
    inventory: SystemRecordInventoryTreeSnapshotV1 | null;
    currentHead: SignedAgentProfileHeadEnvelopeV1 | null;
  }>;
  /** Resolve retained authority history by content address, without wire semantics. */
  resolveArtifact(
    reference: Pick<SystemRecordProviderArtifactV1, 'objectKind' | 'objectDigest'>,
  ): SystemRecordProviderArtifactV1 | null | Promise<SystemRecordProviderArtifactV1 | null>;
  /** Atomically verify and reserve the expected snapshot until commit or abort. */
  prepareCommit(
    input: AgentProfileProducerPublicationCommitV1,
  ): AgentProfileProducerPublicationCommitLeaseV1 | Promise<AgentProfileProducerPublicationCommitLeaseV1>;
}

export interface CreateAgentProfileProducerOptionsV1 {
  readonly networkId: NetworkIdV1;
  /** Locally pinned VM publication lane; never derived from an untrusted seal. */
  readonly publicationDeployment: Readonly<CatalogSealDeploymentProfileV1>;
  readonly peerSigner: SystemRecordPeerSignerV1;
  readonly evmSigner: EvmPersonalMessageSignerV1;
  readonly store: AgentProfileProducerPublicationStoreV1;
  /** Independent verifier clock; publication timestamps are untrusted input. */
  readonly nowMs?: () => number;
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
    if (publication.publicationStatus !== 'confirmed') {
      throw new Error('agent-profile system record requires a confirmed publication');
    }
    const issuedAt = normalizePublicationTimestampV1(publication.issuedAt, 'issuedAt');
    const validUntil = normalizePublicationTimestampV1(publication.validUntil, 'validUntil');
    const verifierNowMs = producerNowMs(options.nowMs?.() ?? Date.now());
    if (Date.parse(issuedAt) > verifierNowMs + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS) {
      throw new Error('agent-profile issuedAt exceeds the future clock-skew bound');
    }
    if (Date.parse(validUntil) <= Date.parse(issuedAt)) {
      throw new Error('agent-profile validUntil must be later than issuedAt');
    }
    const evmIssuer = options.evmSigner.address;
    assertCanonicalEvmAddress(evmIssuer, 'profile EVM issuer');
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
    if (previous !== null && previous.object.evmIssuer !== evmIssuer) {
      throw new Error('agent-profile authority transition must be authored explicitly');
    }
    const projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(projectionQuads);
    const contentDigest = computeProjectionContentDigest(projectionQuads);
    if (contentDigest !== publication.seal.assertionMerkleRoot
      || publication.seal.authorAddress !== evmIssuer
      || publication.seal.publicTripleCount !== String(projectionQuads.length)
      || publication.seal.privateTripleCount !== '0'
      || publication.seal.privateMerkleRoot !== null) {
      throw new Error('profile publication seal does not bind the exact public projection');
    }
    assertPublicationLaneV1(
      publication.seal,
      options.networkId,
      options.publicationDeployment,
      evmIssuer,
    );
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
    const ownedSubjectCount = String(ownedSubjectTable.length);
    const projectionByteCount = String(projectionBytes.byteLength);
    const projectionQuadCount = String(projectionQuads.length);
    assertCanonicalDecimalU64(authoritySequence, 'profile authoritySequence');
    assertCanonicalDecimalU64(version, 'profile version');
    assertCanonicalDecimalU64(ownedSubjectCount, 'profile ownedSubjectCount');
    assertCanonicalDecimalU64(projectionByteCount, 'profile projectionBytes');
    assertCanonicalDecimalU64(projectionQuadCount, 'profile projectionQuads');
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
      authoritySequence,
      version,
      ...(previous === null ? {} : { previousHeadDigest: previous.objectDigest }),
      ...(previous?.object.acceptedTransitionDigest === undefined ? {} : {
        acceptedTransitionDigest: previous.object.acceptedTransitionDigest,
      }),
      evmIssuer,
      rootSubject: prepared.rootEntity,
      projectionSchemaDigest: publication.projectionSchemaDigest,
      issuedAt,
      ownedSubjectTableDigest,
      ownedSubjectCount,
      projectionBytes: projectionByteCount,
      projectionQuads: projectionQuadCount,
      validUntil,
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
    const artifactsByKey = new Map(
      artifacts.map((artifact) => [systemRecordProviderArtifactKeyV1(artifact), artifact]),
    );
    const verifiedClosure = await buildAgentProfileVerificationClosureV1(headDigest, {
      nowMs: verifierNowMs,
      resolve: async ({ objectKind, digest }) => {
        const reference = {
          objectKind,
          objectDigest: digest,
        } as const;
        const artifact = artifactsByKey.get(systemRecordProviderArtifactKeyV1(reference))
          ?? await options.store.resolveArtifact(reference);
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
        Buffer.from(canonicalBundleBytes).equals(Buffer.from(bundle)),
    });
    signal.throwIfAborted();

    const commitLease = await options.store.prepareCommit({
      expectedHeadDigest: previous?.objectDigest ?? null,
      expectedRootDescriptorDigest: snapshot.inventory?.descriptorDigest ?? null,
      artifacts,
      inventory,
      rootEnvelope,
    });
    let committed = false;
    try {
      signal.throwIfAborted();
      await options.install({
        head,
        envelope,
        canonicalProjectionBytes: projectionBytes,
        projectionQuads,
        ownedSubjectTable,
        verifiedAuthoritySummary: verifiedClosure.authoritySummary,
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
      const preparedSnapshot = snapshotPreparedProfileV1(prepared);
      const projectionQuads = validateAndProject(preparedSnapshot);
      assertAdvertisedIdentity(
        preparedSnapshot.rootEntity,
        projectionQuads,
        options.peerSigner,
        options.evmSigner.address,
      );
      active = true;
      const controller = new AbortController();
      try {
        await options.fence(preparedSnapshot, controller.signal);
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
              preparedSnapshot,
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
  return cloneSystemRecordProviderArtifactV1({
    objectKind,
    objectDigest,
    canonicalBytes: bytes,
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
  const projected = prepared.quads.map((quad) => Object.freeze({ ...quad, graph: '' }));
  projected.sort(compareQuads);
  for (let index = 1; index < projected.length; index += 1) {
    if (compareQuads(projected[index - 1]!, projected[index]!) === 0) {
      throw new Error('profile projection must be canonical and duplicate-free');
    }
  }
  try {
    assertAgentProfileProjectionSchemaV1(
      prepared.rootEntity,
      ownedSubjects(prepared.rootEntity, projected),
      projected,
    );
  } catch (cause) {
    throw new Error('profile projection is outside schema V1', { cause });
  }
  return Object.freeze(projected);
}

function snapshotPreparedProfileV1(prepared: PreparedAgentProfileV1): PreparedAgentProfileV1 {
  if (!Array.isArray(prepared.quads)
    || typeof prepared.rootEntity !== 'string'
    || typeof prepared.lastSeen !== 'string') {
    throw new TypeError('prepared profile has an invalid structural shape');
  }
  return Object.freeze({
    quads: Object.freeze(prepared.quads.map((quad) => Object.freeze({ ...quad }))),
    rootEntity: prepared.rootEntity,
    lastSeen: prepared.lastSeen,
  });
}

function producerNowMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('agent-profile producer clock returned an invalid value');
  }
  return value;
}

function assertPublicationLaneV1(
  seal: Readonly<CanonicalGraphScopedAuthorSealV1>,
  networkId: NetworkIdV1,
  deployment: Readonly<CatalogSealDeploymentProfileV1>,
  evmIssuer: string,
): void {
  const ual = parseDeterministicKnowledgeAssetUal(seal.kaUal);
  if (deployment.networkId !== networkId
    || ual.ual !== seal.kaUal
    || ual.chainId !== networkId
    || ual.agentAddress !== evmIssuer
    || seal.assertedAtChainId !== deployment.assertedAtChainId
    || seal.assertedAtKav10Address !== deployment.assertedAtKav10Address) {
    throw new Error('profile publication seal belongs to a different network or deployment');
  }
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
  const digest = `0x${Buffer.from(root).toString('hex')}`;
  assertCanonicalDigest(digest, 'profile content digest');
  return digest;
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

function normalizePublicationTimestampV1(
  value: string,
  label: string,
): CanonicalRfc3339SecondsV1 {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be a valid RFC3339 UTC timestamp`);
  const canonical = new Date(Math.floor(millis / 1_000) * 1_000)
    .toISOString()
    .replace('.000Z', 'Z');
  if (canonical !== `${value.slice(0, 19)}Z`) {
    throw new Error(`${label} must be a calendar-valid RFC3339 UTC timestamp`);
  }
  assertCanonicalRfc3339SecondsV1(canonical, label);
  return canonical;
}

function assertAdvertisedIdentity(
  rootSubject: string,
  quads: readonly Readonly<Quad>[],
  peerSigner: SystemRecordPeerSignerV1,
  evmAddress: string,
): void {
  const identity = agentProfileAdvertisedIdentityV1({
    peerId: peerSigner.peerId,
    publicKey: Buffer.from(peerSigner.publicKey, 'base64url').toString('base64'),
    agentAddress: evmAddress,
  });
  if (identity.rootEntity !== rootSubject
    || identity.publicKey === undefined
    || identity.agentAddress === undefined) {
    throw new Error('profile projection does not bind the signed root identity');
  }
  const expected = [
    ['peerId', identity.peerId],
    ['agentAddress', identity.agentAddress],
    ['publicKey', identity.publicKey],
  ] as const;
  for (const [field, fact] of expected) {
    const advertised = quads.filter((quad) =>
      quad.subject === rootSubject && quad.predicate === fact.predicate);
    if (advertised.length !== 1 || advertised[0]?.object !== fact.object) {
      throw new Error(`profile projection does not bind the signed ${field}`);
    }
  }
}
