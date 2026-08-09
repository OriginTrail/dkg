import { vi } from 'vitest';

import {
  decodeOpaqueKaBundleV1,
  encodeOpaqueKaBundleV1,
} from '@origintrail-official/dkg-core';
import {
  computeSystemRecordStableKeyHashV1,
  digestSystemRecordBytesV1,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  type AgentProfileAuthorityTransitionV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { ethers } from 'ethers';

import { createEvmPersonalMessageSignerV1 } from '../../src/evm-message-signer-v1.js';
import { prepareAgentProfileV1 } from '../../src/profile.js';
import type { SystemRecordArtifactLookupV1 } from '../../src/system-records/artifact-v1.js';
import { createInMemoryAgentProfilePublicationStoreV1 } from '../../src/system-records/in-memory-agent-profile-publication-store-v1.js';
import type { AgentProfileReceiverPreparedApplyV1 } from '../../src/system-records/receiver-v1.js';
import {
  createFixtureAgentProfileProducerV1,
  DEPLOYMENT,
  envelopeArtifact,
  makePrepared,
  NETWORK,
  OTHER_PRIVATE_KEY,
  produce,
  producerFixture,
  publicationFor,
  signHeadEnvelope,
  signTransitionEnvelope,
} from './agent-profile-producer-v1-fixture.js';

export const DEFAULT_MONOTONIC_APPLY_TIMING = Object.freeze({
  existingMonotonicDeadlineMs: 10_000,
  monotonicNowMs: 1_000,
});

export function preparedFixtureApply(
  stateRevision: string,
  digestCharacter: string,
): AgentProfileReceiverPreparedApplyV1 {
  return Object.freeze({
    ...DEFAULT_MONOTONIC_APPLY_TIMING,
    apply: () => Object.freeze({
      outcome: 'applied' as const,
      stateRevision,
      appliedStateDigest: `0x${digestCharacter.repeat(64)}`,
    }),
  });
}

export async function publishedReceiverFixture(withDerivedSubjects = false) {
  const fixture = await producerFixture();
  const prepared = withDerivedSubjects
    ? prepareAgentProfileV1({
      peerId: fixture.peerSigner.peerId,
      publicKey: Buffer.from(fixture.peerSigner.publicKey, 'base64url').toString('base64'),
      agentAddress: fixture.evmSigner.address,
      name: 'Receiver multi-subject fixture',
      nodeRole: 'edge',
      lastSeen: '2026-08-07T12:00:00.000Z',
      skills: [{
        skillType: 'GraphQuery',
        pricePerCall: 1,
        currency: 'TRAC',
        successRate: 0.99,
        pricingModel: 'PerInvocation',
      }],
      contextGraphsServed: ['receiver-test-graph'],
    })
    : fixture.prepared;
  const publication = withDerivedSubjects
    ? await publicationFor(prepared, fixture.evmSigner.address, '2026-08-07T12:00:00Z')
    : fixture.publication;
  const producer = createFixtureAgentProfileProducerV1({
    networkId: NETWORK,
    publicationDeployment: DEPLOYMENT,
    peerSigner: fixture.peerSigner,
    evmSigner: fixture.evmSigner,
    store: fixture.store,
    fence: () => undefined,
    install: () => undefined,
  });
  await produce(producer, prepared, publication);
  const envelope = fixture.store.snapshot().currentHead;
  if (envelope === null) throw new Error('fixture producer did not publish a head');
  const head = envelope.object;
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    stableKeyHash: computeSystemRecordStableKeyHashV1(head.networkId, head.peerId),
    peerId: head.peerId,
    authoritySequence: head.authoritySequence,
    version: head.version,
    headDigest: envelope.objectDigest,
    tombstone: false,
    quarantined: false,
  });
  return { ...fixture, prepared, publication, envelope, row };
}

export async function rotatedPublishedReceiverFixture() {
  const prior = await publishedReceiverFixture();
  const nextSigner = createEvmPersonalMessageSignerV1({
    mode: 'custodial',
    address: new ethers.Wallet(OTHER_PRIVATE_KEY).address,
    privateKey: OTHER_PRIVATE_KEY,
    purpose: 'receiver post-transition test',
  });
  const prepared = makePrepared(
    prior.peerSigner,
    nextSigner.address,
    '2026-08-07T12:20:00.000Z',
  );
  const publication = await publicationFor(
    prepared,
    nextSigner.address,
    '2026-08-07T12:20:00Z',
    OTHER_PRIVATE_KEY,
  );
  const currentStore = createInMemoryAgentProfilePublicationStoreV1();
  await produce(createFixtureAgentProfileProducerV1({
    networkId: NETWORK,
    publicationDeployment: DEPLOYMENT,
    peerSigner: prior.peerSigner,
    evmSigner: nextSigner,
    store: currentStore,
    fence: () => undefined,
    install: () => undefined,
  }), prepared, publication);
  const bootstrapEnvelope = currentStore.snapshot().currentHead;
  if (bootstrapEnvelope === null) throw new Error('rotated fixture did not publish a head');
  const transition: AgentProfileAuthorityTransitionV1 = Object.freeze({
    objectType: 'authority-transition',
    kind: 'agents',
    mode: 'co-signed',
    networkId: NETWORK,
    peerId: prior.peerSigner.peerId,
    peerPublicKey: prior.peerSigner.publicKey,
    priorAuthoritySequence: '0',
    nextAuthoritySequence: '1',
    priorHeadDigest: prior.envelope.objectDigest,
    priorEvmIssuer: prior.evmSigner.address,
    nextEvmIssuer: nextSigner.address,
    nextRoot: prepared.rootEntity,
    issuedAt: '2026-08-07T12:10:00Z',
  });
  const transitionEnvelope = await signTransitionEnvelope(
    transition,
    prior.peerSigner,
    prior.evmSigner,
    nextSigner,
  );
  const envelope = await signHeadEnvelope(Object.freeze({
    ...bootstrapEnvelope.object,
    authoritySequence: '1',
    acceptedTransitionDigest: transitionEnvelope.objectDigest,
  }), prior.peerSigner, nextSigner);
  const currentHeadArtifact = envelopeArtifact('agent-profile-head', envelope);
  const transitionArtifact = envelopeArtifact('authority-transition', transitionEnvelope);
  const priorHeadArtifact = envelopeArtifact('agent-profile-head', prior.envelope);
  const resolve = vi.fn(async (lookup: SystemRecordArtifactLookupV1, signal: AbortSignal) => {
    if (lookup.type === 'object') {
      if (lookup.objectKind === currentHeadArtifact.objectKind
        && lookup.objectDigest === currentHeadArtifact.objectDigest) return currentHeadArtifact;
      if (lookup.objectKind === transitionArtifact.objectKind
        && lookup.objectDigest === transitionArtifact.objectDigest) return transitionArtifact;
      if (lookup.objectKind === priorHeadArtifact.objectKind
        && lookup.objectDigest === priorHeadArtifact.objectDigest) return priorHeadArtifact;
    }
    return currentStore.resolve(lookup, signal);
  });
  const head = envelope.object;
  const row: SystemRecordInventoryRowV1 = Object.freeze({
    stableKeyHash: computeSystemRecordStableKeyHashV1(head.networkId, head.peerId),
    peerId: head.peerId,
    authoritySequence: head.authoritySequence,
    version: head.version,
    headDigest: envelope.objectDigest,
    tombstone: false,
    quarantined: false,
  });
  return { prior, prepared, envelope, transitionEnvelope, resolve, row };
}

export async function publishedReceiverFixtureWithProjectionBytes(
  transform: (canonicalProjectionBytes: Uint8Array) => Uint8Array,
) {
  const fixture = await publishedReceiverFixture();
  const originalBundle = await fixture.store.resolve({
    type: 'object',
    objectKind: 'profile-bundle',
    objectDigest: fixture.envelope.object.bundleDigest,
  }, new AbortController().signal);
  if (originalBundle === null) throw new Error('fixture bundle was not retained');
  const decoded = decodeOpaqueKaBundleV1(originalBundle.canonicalBytes);
  const projectionBytes = transform(Uint8Array.from(decoded.projectionBytes));
  const encoded = encodeOpaqueKaBundleV1(projectionBytes, decoded.sealBytes);
  const bundleDigest = digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
    encoded.bundleBytes,
  );
  const envelope = await signHeadEnvelope(Object.freeze({
    ...fixture.envelope.object,
    bundleDigest,
    projectionBytes: String(projectionBytes.byteLength),
  }), fixture.peerSigner, fixture.evmSigner);
  const headArtifact = envelopeArtifact('agent-profile-head', envelope);
  const bundleArtifact = Object.freeze({
    objectKind: 'profile-bundle' as const,
    objectDigest: bundleDigest,
    canonicalBytes: encoded.bundleBytes,
  });
  const resolve = vi.fn(async (lookup: SystemRecordArtifactLookupV1, signal: AbortSignal) => {
    if (lookup.type === 'object') {
      if (lookup.objectKind === headArtifact.objectKind
        && lookup.objectDigest === headArtifact.objectDigest) return headArtifact;
      if (lookup.objectKind === bundleArtifact.objectKind
        && lookup.objectDigest === bundleArtifact.objectDigest) return bundleArtifact;
    }
    return fixture.store.resolve(lookup, signal);
  });
  return Object.freeze({
    ...fixture,
    envelope,
    projectionBytes,
    artifacts: Object.freeze({ resolve }),
    row: Object.freeze({ ...fixture.row, headDigest: envelope.objectDigest }),
  });
}

export function compareReceiverQuad(
  left: { subject: string; predicate: string; object: string; graph: string },
  right: { subject: string; predicate: string; object: string; graph: string },
): number {
  return left.subject.localeCompare(right.subject)
    || left.predicate.localeCompare(right.predicate)
    || left.object.localeCompare(right.object)
    || left.graph.localeCompare(right.graph);
}

export function compareReceiverUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
