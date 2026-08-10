import { ethers } from 'ethers';

import {
  canonicalizeAgentProfileConflictEvidenceV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileConflictEvidenceDigestV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileTombstoneHeadObjectV1,
  type Digest32V1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { createEvmPersonalMessageSignerV1 } from '../../src/evm-message-signer-v1.js';
import type {
  SystemRecordArtifactRepositoryV1,
  SystemRecordArtifactV1,
} from '../../src/system-records/artifact-v1.js';
import { createInMemoryAgentProfilePublicationStoreV1 } from '../../src/system-records/in-memory-agent-profile-publication-store-v1.js';
import {
  createFixtureAgentProfileProducerV1,
  DEPLOYMENT,
  envelopeArtifact,
  makePrepared,
  NETWORK,
  OTHER_PRIVATE_KEY,
  produce,
  publicationFor,
  signHeadEnvelope,
  signTransitionEnvelope,
} from './agent-profile-producer-v1-fixture.js';
import { publishedReceiverFixture as publishedFixture } from './agent-profile-receiver-v1-fixture.js';

export function overlayRepository(
  base: SystemRecordArtifactRepositoryV1,
  artifacts: readonly SystemRecordArtifactV1[],
): SystemRecordArtifactRepositoryV1 {
  const overlay = new Map(artifacts.map((artifact) => [
    `${artifact.objectKind}\u0000${artifact.objectDigest}`,
    artifact,
  ]));
  return Object.freeze({
    async resolve(lookup, signal) {
      if (lookup.type === 'object') {
        const artifact = overlay.get(`${lookup.objectKind}\u0000${lookup.objectDigest}`);
        if (artifact !== undefined) return artifact;
      }
      return base.resolve(lookup, signal);
    },
  });
}

export function layeredRepository(
  repositories: readonly SystemRecordArtifactRepositoryV1[],
): SystemRecordArtifactRepositoryV1 {
  return Object.freeze({
    async resolve(lookup, signal) {
      for (const repository of repositories) {
        const artifact = await repository.resolve(lookup, signal);
        if (artifact !== null) return artifact;
      }
      return null;
    },
  });
}

export async function tombstoneFixture() {
  const fixture = await publishedFixture(true);
  const active = fixture.envelope.object;
  const tombstone: AgentProfileTombstoneHeadObjectV1 = Object.freeze({
    objectType: 'agent-profile-head',
    kind: 'agents',
    state: 'tombstone',
    networkId: active.networkId,
    peerId: active.peerId,
    peerPublicKey: active.peerPublicKey,
    authoritySequence: active.authoritySequence,
    version: String(BigInt(active.version) + 1n),
    ...(active.acceptedTransitionDigest === undefined ? {} : {
      acceptedTransitionDigest: active.acceptedTransitionDigest,
    }),
    previousHeadDigest: fixture.envelope.objectDigest,
    evmIssuer: active.evmIssuer,
    rootSubject: active.rootSubject,
    projectionSchemaDigest: active.projectionSchemaDigest,
    issuedAt: '2026-08-07T12:10:00Z',
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0',
    projectionBytes: '0',
    projectionQuads: '0',
  });
  const envelope = await signHeadEnvelope(tombstone, fixture.peerSigner, fixture.evmSigner);
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    stableKeyHash: fixture.row.stableKeyHash,
    peerId: fixture.row.peerId,
    authoritySequence: tombstone.authoritySequence,
    version: tombstone.version,
    headDigest: envelope.objectDigest,
    tombstone: true,
    quarantined: false,
  });
  return {
    ...fixture,
    tombstone,
    envelope,
    row,
    artifacts: overlayRepository(fixture.store, [envelopeArtifact('agent-profile-head', envelope)]),
  };
}

export async function quarantineFixture(reverseDelivery = false) {
  const fixture = await publishedFixture();
  const alternate = Object.freeze({
    ...fixture.envelope.object,
    issuedAt: '2026-08-07T12:01:00Z',
  });
  const alternateEnvelope = await signHeadEnvelope(
    alternate,
    fixture.peerSigner,
    fixture.evmSigner,
  );
  const evidence: AgentProfileConflictEvidenceV1 = Object.freeze({
    objectType: 'conflict-evidence',
    kind: 'agents',
    networkId: NETWORK,
    peerId: fixture.row.peerId,
    entries: Object.freeze([Object.freeze({
      type: 'fork',
      authoritySequence: fixture.row.authoritySequence,
      version: fixture.row.version,
      objectDigests: Object.freeze([
        fixture.envelope.objectDigest,
        alternateEnvelope.objectDigest,
      ].sort()) as readonly Digest32V1[],
    })]),
  });
  const evidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);
  const evidenceArtifact: SystemRecordArtifactV1 = Object.freeze({
    objectKind: 'conflict-evidence',
    objectDigest: evidenceDigest,
    canonicalBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
  });
  const extra = [envelopeArtifact('agent-profile-head', alternateEnvelope), evidenceArtifact];
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    ...fixture.row,
    quarantined: true,
    conflictEvidenceDigest: evidenceDigest,
  });
  return {
    ...fixture,
    alternateEnvelope,
    evidence,
    evidenceDigest,
    row,
    artifacts: overlayRepository(fixture.store, reverseDelivery ? [...extra].reverse() : extra),
  };
}

export async function activeTombstoneConflictFixture() {
  const fixture = await publishedFixture(true);
  const predecessor = fixture.envelope.object;
  const version = String(BigInt(predecessor.version) + 1n);
  const active: AgentProfileActiveHeadObjectV1 = Object.freeze({
    ...predecessor,
    version,
    previousHeadDigest: fixture.envelope.objectDigest,
    issuedAt: '2026-08-07T12:09:00Z',
  });
  const tombstone: AgentProfileTombstoneHeadObjectV1 = Object.freeze({
    objectType: 'agent-profile-head',
    kind: 'agents',
    state: 'tombstone',
    networkId: predecessor.networkId,
    peerId: predecessor.peerId,
    peerPublicKey: predecessor.peerPublicKey,
    authoritySequence: predecessor.authoritySequence,
    version,
    ...(predecessor.acceptedTransitionDigest === undefined ? {} : {
      acceptedTransitionDigest: predecessor.acceptedTransitionDigest,
    }),
    previousHeadDigest: fixture.envelope.objectDigest,
    evmIssuer: predecessor.evmIssuer,
    rootSubject: predecessor.rootSubject,
    projectionSchemaDigest: predecessor.projectionSchemaDigest,
    issuedAt: '2026-08-07T12:10:00Z',
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0',
    projectionBytes: '0',
    projectionQuads: '0',
  });
  const activeEnvelope = await signHeadEnvelope(active, fixture.peerSigner, fixture.evmSigner);
  const tombstoneEnvelope = await signHeadEnvelope(
    tombstone,
    fixture.peerSigner,
    fixture.evmSigner,
  );
  const evidence: AgentProfileConflictEvidenceV1 = Object.freeze({
    objectType: 'conflict-evidence',
    kind: 'agents',
    networkId: NETWORK,
    peerId: fixture.row.peerId,
    entries: Object.freeze([Object.freeze({
      type: 'fork',
      authoritySequence: active.authoritySequence,
      version,
      objectDigests: Object.freeze([
        activeEnvelope.objectDigest,
        tombstoneEnvelope.objectDigest,
      ].sort()) as readonly Digest32V1[],
    })]),
  });
  const evidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);
  const evidenceArtifact: SystemRecordArtifactV1 = Object.freeze({
    objectKind: 'conflict-evidence',
    objectDigest: evidenceDigest,
    canonicalBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
  });
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    stableKeyHash: fixture.row.stableKeyHash,
    peerId: fixture.row.peerId,
    authoritySequence: active.authoritySequence,
    version,
    headDigest: activeEnvelope.objectDigest,
    tombstone: false,
    quarantined: true,
    conflictEvidenceDigest: evidenceDigest,
  });
  return {
    ...fixture,
    active,
    tombstone,
    row,
    artifacts: overlayRepository(fixture.store, [
      envelopeArtifact('agent-profile-head', activeEnvelope),
      envelopeArtifact('agent-profile-head', tombstoneEnvelope),
      evidenceArtifact,
    ]),
  };
}

export interface TransitionQuarantineFixtureOptions {
  readonly reverseDelivery?: boolean;
  readonly withTombstoneFork?: boolean;
  readonly unrelatedTransitionEvidence?: boolean;
  readonly invalidCompetingPredecessor?: boolean;
}

export async function transitionQuarantineFixture(
  options: TransitionQuarantineFixtureOptions = {},
) {
  const {
    reverseDelivery = false,
    withTombstoneFork = false,
    unrelatedTransitionEvidence = false,
    invalidCompetingPredecessor = false,
  } = options;
  const prior = await publishedFixture();
  const nextSigner = createEvmPersonalMessageSignerV1({
    mode: 'custodial',
    address: new ethers.Wallet(OTHER_PRIVATE_KEY).address,
    privateKey: OTHER_PRIVATE_KEY,
    purpose: 'transition receiver fixture',
  });
  const alternatePrivateKey = `0x${'33'.repeat(32)}`;
  const alternateSigner = createEvmPersonalMessageSignerV1({
    mode: 'custodial',
    address: new ethers.Wallet(alternatePrivateKey).address,
    privateKey: alternatePrivateKey,
    purpose: 'transition receiver alternate fixture',
  });
  const unrelatedPrivateKey = `0x${'44'.repeat(32)}`;
  const unrelatedSigner = createEvmPersonalMessageSignerV1({
    mode: 'custodial',
    address: new ethers.Wallet(unrelatedPrivateKey).address,
    privateKey: unrelatedPrivateKey,
    purpose: 'transition receiver unrelated fixture',
  });
  const nextPrepared = makePrepared(
    prior.peerSigner,
    nextSigner.address,
    '2026-08-07T12:05:00.000Z',
  );
  const nextStore = createInMemoryAgentProfilePublicationStoreV1();
  const nextProducer = createFixtureAgentProfileProducerV1({
    networkId: NETWORK,
    publicationDeployment: DEPLOYMENT,
    peerSigner: prior.peerSigner,
    evmSigner: nextSigner,
    store: nextStore,
    fence: () => undefined,
    install: () => undefined,
  });
  await produce(
    nextProducer,
    nextPrepared,
    await publicationFor(
      nextPrepared,
      nextSigner.address,
      '2026-08-07T12:05:00Z',
      OTHER_PRIVATE_KEY,
    ),
  );
  const nextSeedEnvelope = nextStore.snapshot().currentHead;
  if (nextSeedEnvelope === null) throw new Error('next-authority fixture did not publish a head');
  const transitionBase = Object.freeze({
    objectType: 'authority-transition' as const,
    kind: 'agents' as const,
    mode: 'co-signed' as const,
    networkId: NETWORK,
    peerId: prior.row.peerId,
    peerPublicKey: prior.envelope.object.peerPublicKey,
    priorAuthoritySequence: prior.envelope.object.authoritySequence,
    nextAuthoritySequence: '1',
    priorHeadDigest: prior.envelope.objectDigest,
    priorEvmIssuer: prior.envelope.object.evmIssuer,
    issuedAt: '2026-08-07T12:06:00Z',
  });
  const retainedTransition: AgentProfileAuthorityTransitionV1 = Object.freeze({
    ...transitionBase,
    nextEvmIssuer: nextSigner.address.toLowerCase(),
    nextRoot: `did:dkg:agent:${nextSigner.address.toLowerCase()}`,
  });
  const competingTransition: AgentProfileAuthorityTransitionV1 = Object.freeze({
    ...transitionBase,
    ...(invalidCompetingPredecessor
      ? { priorHeadDigest: nextSeedEnvelope.objectDigest }
      : {}),
    nextEvmIssuer: alternateSigner.address.toLowerCase(),
    nextRoot: `did:dkg:agent:${alternateSigner.address.toLowerCase()}`,
  });
  const unrelatedTransition: AgentProfileAuthorityTransitionV1 = Object.freeze({
    ...transitionBase,
    nextEvmIssuer: unrelatedSigner.address.toLowerCase(),
    nextRoot: `did:dkg:agent:${unrelatedSigner.address.toLowerCase()}`,
  });
  const retainedEnvelope = await signTransitionEnvelope(
    retainedTransition,
    prior.peerSigner,
    prior.evmSigner,
    nextSigner,
  );
  const competingEnvelope = await signTransitionEnvelope(
    competingTransition,
    prior.peerSigner,
    prior.evmSigner,
    alternateSigner,
  );
  const unrelatedEnvelope = await signTransitionEnvelope(
    unrelatedTransition,
    prior.peerSigner,
    prior.evmSigner,
    unrelatedSigner,
  );
  const acceptedTransitionDigest = computeAgentProfileAuthorityTransitionDigestV1(
    retainedTransition,
  );
  const sequencePredecessor: AgentProfileActiveHeadObjectV1 = Object.freeze({
    ...nextSeedEnvelope.object,
    authoritySequence: '1',
    acceptedTransitionDigest,
    issuedAt: '2026-08-07T12:09:00Z',
  });
  const sequencePredecessorEnvelope = await signHeadEnvelope(
    sequencePredecessor,
    prior.peerSigner,
    nextSigner,
  );
  const currentHead: AgentProfileActiveHeadObjectV1 = Object.freeze({
    ...sequencePredecessor,
    ...(withTombstoneFork
      ? {
        version: String(BigInt(sequencePredecessor.version) + 1n),
        previousHeadDigest: sequencePredecessorEnvelope.objectDigest,
      }
      : {}),
    issuedAt: '2026-08-07T12:10:00Z',
  });
  const currentEnvelope = await signHeadEnvelope(currentHead, prior.peerSigner, nextSigner);
  const tombstone: AgentProfileTombstoneHeadObjectV1 | undefined = withTombstoneFork
    ? Object.freeze({
      objectType: 'agent-profile-head',
      kind: 'agents',
      state: 'tombstone',
      networkId: currentHead.networkId,
      peerId: currentHead.peerId,
      peerPublicKey: currentHead.peerPublicKey,
      authoritySequence: currentHead.authoritySequence,
      version: currentHead.version,
      acceptedTransitionDigest,
      previousHeadDigest: sequencePredecessorEnvelope.objectDigest,
      evmIssuer: currentHead.evmIssuer,
      rootSubject: currentHead.rootSubject,
      projectionSchemaDigest: currentHead.projectionSchemaDigest,
      issuedAt: '2026-08-07T12:11:00Z',
      ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
      ownedSubjectCount: '0',
      projectionBytes: '0',
      projectionQuads: '0',
    })
    : undefined;
  const tombstoneEnvelope = tombstone === undefined
    ? undefined
    : await signHeadEnvelope(tombstone, prior.peerSigner, nextSigner);
  const transitionEvidenceEnvelopes = unrelatedTransitionEvidence
    ? [competingEnvelope, unrelatedEnvelope]
    : [retainedEnvelope, competingEnvelope];
  const entries: AgentProfileConflictEvidenceV1['entries'][number][] = [];
  if (tombstoneEnvelope !== undefined) {
    entries.push(Object.freeze({
      type: 'fork',
      authoritySequence: currentHead.authoritySequence,
      version: currentHead.version,
      objectDigests: Object.freeze([
        currentEnvelope.objectDigest,
        tombstoneEnvelope.objectDigest,
      ].sort()) as readonly Digest32V1[],
    }));
  }
  entries.push(Object.freeze({
    type: 'transition',
    priorAuthoritySequence: '0',
    nextAuthoritySequence: '1',
    objectDigests: Object.freeze(
      transitionEvidenceEnvelopes.map(({ objectDigest }) => objectDigest).sort(),
    ) as readonly Digest32V1[],
  }));
  const evidence: AgentProfileConflictEvidenceV1 = Object.freeze({
    objectType: 'conflict-evidence',
    kind: 'agents',
    networkId: NETWORK,
    peerId: prior.row.peerId,
    entries: Object.freeze(entries),
  });
  const evidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);
  const evidenceArtifact: SystemRecordArtifactV1 = Object.freeze({
    objectKind: 'conflict-evidence',
    objectDigest: evidenceDigest,
    canonicalBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
  });
  const conflictArtifacts = [
    envelopeArtifact('authority-transition', retainedEnvelope),
    envelopeArtifact('authority-transition', competingEnvelope),
    ...(unrelatedTransitionEvidence
      ? [envelopeArtifact('authority-transition', unrelatedEnvelope)]
      : []),
    evidenceArtifact,
  ];
  const base = layeredRepository([nextStore, prior.store]);
  const artifacts = overlayRepository(base, [
    envelopeArtifact('agent-profile-head', sequencePredecessorEnvelope),
    envelopeArtifact('agent-profile-head', currentEnvelope),
    ...(tombstoneEnvelope === undefined
      ? []
      : [envelopeArtifact('agent-profile-head', tombstoneEnvelope)]),
    ...(reverseDelivery ? [...conflictArtifacts].reverse() : conflictArtifacts),
  ]);
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    stableKeyHash: prior.row.stableKeyHash,
    peerId: prior.row.peerId,
    authoritySequence: '1',
    version: currentHead.version,
    headDigest: currentEnvelope.objectDigest,
    tombstone: false,
    quarantined: true,
    conflictEvidenceDigest: evidenceDigest,
  });
  return {
    ...prior,
    retainedEnvelope,
    competingEnvelope,
    unrelatedEnvelope,
    currentHead,
    tombstone,
    tombstoneDigest: tombstoneEnvelope?.objectDigest,
    evidence,
    evidenceDigest,
    row,
    artifacts,
  };
}
