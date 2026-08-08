import {
  SENTINEL_NO_PRIVATE_V10,
  V10MerkleTree,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  encodeOpaqueKaBundleV1,
  keccak256,
  parseDeterministicKnowledgeAssetUal,
  tripleContentV10,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
} from '@origintrail-official/dkg-core';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_CLOCK_SKEW_MS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  assertAgentProfileProjectionIdentityV1,
  assertAgentProfileProjectionSchemaV1,
  assertCanonicalRfc3339SecondsV1,
  canonicalizeOwnedSubjectTableObjectV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  digestSystemRecordBytesV1,
  verifySignedSystemRecordEnvelopeV1,
  type AgentProfileActiveHeadObjectV1,
  type CanonicalRfc3339SecondsV1,
  type Digest32V1,
  type NetworkIdV1,
  type OwnedSubjectTableObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { Quad } from '@origintrail-official/dkg-storage';

import type { PreparedAgentProfileV1 } from '../profile.js';
import { assertRecoverableGraphScopedAuthorAttestationV1 } from '../rfc64/recoverable-author-attestation-v1.js';
import type {
  AgentProfileProducerPreparationDependenciesV1,
  AgentProfilePublicationBindingV1,
  SystemRecordPeerSignerV1,
} from './agent-profile-producer-contract-v1.js';

const UTF8 = new TextEncoder();

export interface AgentProfileProductionPreparationV1 {
  readonly snapshot: ReturnType<AgentProfileProducerPreparationDependenciesV1['snapshot']>;
  readonly verifierNowMs: number;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly projectionBytes: Uint8Array;
  readonly ownedSubjectTable: OwnedSubjectTableObjectV1;
  readonly ownedSubjectTableBytes: Uint8Array;
  readonly ownedSubjectTableDigest: Digest32V1;
  readonly bundle: Uint8Array;
  readonly bundleDigest: Digest32V1;
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly headDigest: Digest32V1;
}

export async function prepareAgentProfileProductionV1(
  dependencies: AgentProfileProducerPreparationDependenciesV1,
  prepared: PreparedAgentProfileV1,
  projectionQuads: readonly Readonly<Quad>[],
  inputPublication: AgentProfilePublicationBindingV1,
): Promise<AgentProfileProductionPreparationV1> {
  const publication = snapshotConfirmedPublicationBindingV1(inputPublication);
  const issuedAt = normalizePublicationTimestampV1(publication.issuedAt, 'issuedAt');
  const validUntil = normalizePublicationTimestampV1(publication.validUntil, 'validUntil');
  normalizePublicationTimestampV1(
    publication.seal.assertionFinalizedAt,
    'assertionFinalizedAt',
  );
  const assertionFinalizedAtMs = Date.parse(publication.seal.assertionFinalizedAt);
  const verifierNowMs = producerNowMs(dependencies.nowMs?.() ?? Date.now());
  if (Date.parse(issuedAt) > verifierNowMs + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS) {
    throw new Error('agent-profile issuedAt exceeds the future clock-skew bound');
  }
  if (Date.parse(issuedAt) < assertionFinalizedAtMs) {
    throw new Error('agent-profile issuedAt predates assertion finalization');
  }
  if (Date.parse(validUntil) <= Date.parse(issuedAt)) {
    throw new Error('agent-profile validUntil must be later than issuedAt');
  }
  if (Date.parse(validUntil) <= verifierNowMs) {
    throw new Error('agent-profile validUntil is already expired');
  }
  const evmIssuer = dependencies.evmIssuer;
  assertCanonicalEvmAddress(evmIssuer, 'profile EVM issuer');
  const snapshot = dependencies.snapshot();
  const previous = snapshot.currentHead;
  if (previous !== null
    && (previous.object.networkId !== dependencies.networkId
      || previous.object.peerId !== dependencies.peerId)) {
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
    dependencies.networkId,
    dependencies.publicationDeployment,
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
    networkId: dependencies.networkId,
    peerId: dependencies.peerId,
    peerPublicKey: dependencies.peerPublicKey,
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
  return Object.freeze({
    snapshot,
    verifierNowMs,
    projectionQuads,
    projectionBytes,
    ownedSubjectTable,
    ownedSubjectTableBytes,
    ownedSubjectTableDigest,
    bundle,
    bundleDigest,
    head,
    headDigest,
  });
}

export function validateAgentProfileProjectionV1(
  prepared: PreparedAgentProfileV1,
): readonly Readonly<Quad>[] {
  const projected = prepared.projectionQuads.map((quad) => Object.freeze({ ...quad }));
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

export function snapshotPreparedProfileV1(
  prepared: PreparedAgentProfileV1,
): PreparedAgentProfileV1 {
  if (!Array.isArray(prepared.publicationQuads)
    || !Array.isArray(prepared.projectionQuads)
    || typeof prepared.rootEntity !== 'string'
    || typeof prepared.lastSeen !== 'string') {
    throw new TypeError('prepared profile has an invalid structural shape');
  }
  return Object.freeze({
    publicationQuads: Object.freeze(
      prepared.publicationQuads.map((quad) => Object.freeze({ ...quad })),
    ),
    projectionQuads: Object.freeze(
      prepared.projectionQuads.map((quad) => Object.freeze({ ...quad })),
    ),
    rootEntity: prepared.rootEntity,
    lastSeen: prepared.lastSeen,
  });
}

export function assertAdvertisedAgentProfileIdentityV1(
  rootSubject: string,
  quads: readonly Readonly<Quad>[],
  peerSigner: SystemRecordPeerSignerV1,
  evmAddress: string,
): void {
  assertCanonicalEvmAddress(evmAddress, 'profile EVM issuer');
  assertAgentProfileProjectionIdentityV1({
    rootSubject,
    peerId: peerSigner.peerId,
    peerPublicKey: peerSigner.publicKey,
    evmIssuer: evmAddress,
  }, quads);
}

type ConfirmedAgentProfilePublicationBindingV1 = Readonly<
  Omit<AgentProfilePublicationBindingV1, 'publicationStatus'> & {
    readonly publicationStatus: 'confirmed';
  }
>;

function snapshotConfirmedPublicationBindingV1(
  publication: AgentProfilePublicationBindingV1,
): ConfirmedAgentProfilePublicationBindingV1 {
  if (publication.publicationStatus !== 'confirmed') {
    throw new Error('agent-profile system record requires a confirmed publication');
  }
  return Object.freeze({
    publicationStatus: 'confirmed',
    assertionCoordinate: publication.assertionCoordinate,
    seal: Object.freeze({ ...publication.seal }),
    issuedAt: publication.issuedAt,
    validUntil: publication.validUntil,
    projectionSchemaDigest: publication.projectionSchemaDigest,
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
