import { ed25519 } from '@noble/curves/ed25519.js';
import {
  SENTINEL_NO_PRIVATE_V10,
  V10MerkleTree,
  buildAuthorAttestationTypedData,
  keccak256,
  tripleContentV10,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
} from '@origintrail-official/dkg-core';
import {
  buildSystemRecordSignatureMessageV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileHeadObjectV1,
  type Digest32V1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SystemRecordPeerPublicKeyV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { ethers } from 'ethers';

import {
  createEvmPersonalMessageSignerV1,
  type EvmPersonalMessageSignerV1,
} from '../../src/evm-message-signer-v1.js';
import { prepareAgentProfileV1, type PreparedAgentProfileV1 } from '../../src/profile.js';
import {
  type AgentProfilePublicationBindingV1,
  type AgentProfileProducerV1,
  type SystemRecordPeerSignerV1,
} from '../../src/system-records/agent-profile-producer-v1.js';
import {
  createInMemoryAgentProfilePublicationStoreV1,
  type InMemoryAgentProfilePublicationStoreV1,
} from '../../src/system-records/in-memory-agent-profile-publication-store-v1.js';
import {
  systemRecordProviderArtifactKeyV1,
  type SystemRecordProviderArtifactV1,
  type SystemRecordProviderLookupV1,
} from '../../src/system-records/provider-v1.js';

export const NETWORK = 'base:84532' as const;
export const OTHER_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
export const DEPLOYMENT = Object.freeze({
  networkId: NETWORK,
  assertedAtChainId: '84532',
  assertedAtKav10Address: `0x${'44'.repeat(20)}`,
}) as unknown as CatalogSealDeploymentProfileV1;

const SCHEMA_DIGEST = `0x${'ab'.repeat(32)}` as Digest32V1;
const PRIVATE_KEY = `0x${'11'.repeat(32)}`;

export async function produce(
  producer: AgentProfileProducerV1,
  prepared: PreparedAgentProfileV1,
  publication: AgentProfilePublicationBindingV1,
) {
  const lease = await producer.prepare(prepared);
  return lease.complete(publication);
}

export async function producerFixture(
  store = createInMemoryAgentProfilePublicationStoreV1(),
) {
  const peerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const peerSigner: SystemRecordPeerSignerV1 = Object.freeze({
    peerId: '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf',
    publicKey: 'ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ' as SystemRecordPeerPublicKeyV1,
    sign: async (message: Uint8Array) => ed25519.sign(message, peerSeed),
  });
  const evmSigner = createEvmPersonalMessageSignerV1({
    mode: 'custodial',
    address: new ethers.Wallet(PRIVATE_KEY).address,
    privateKey: PRIVATE_KEY,
    purpose: 'system-record test',
  });
  const prepared = makePrepared(peerSigner, evmSigner.address, '2026-08-07T12:00:00.000Z');
  return {
    peerSigner,
    evmSigner,
    prepared,
    publication: await publicationFor(prepared, evmSigner.address, '2026-08-07T12:00:00Z'),
    store,
  };
}

export function makePrepared(
  peerSigner: SystemRecordPeerSignerV1,
  address: string,
  lastSeen: string,
): PreparedAgentProfileV1 {
  return prepareAgentProfileV1({
    peerId: peerSigner.peerId,
    publicKey: Buffer.from(peerSigner.publicKey, 'base64url').toString('base64'),
    agentAddress: address,
    name: 'Fixture node',
    nodeRole: 'edge',
    lastSeen,
    skills: [],
  });
}

export async function publicationFor(
  prepared: PreparedAgentProfileV1,
  address: string,
  issuedAt: string,
  privateKey = PRIVATE_KEY,
): Promise<AgentProfilePublicationBindingV1> {
  const canonicalAddress = address.toLowerCase();
  const reservedKaId = (BigInt(canonicalAddress) << 96n) | 7n;
  const assertionMerkleRoot = projectionContentDigest(prepared);
  const typedData = buildAuthorAttestationTypedData({
    chainId: 84532n,
    kav10Address: `0x${'44'.repeat(20)}`,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: canonicalAddress,
    reservedKaId,
  });
  const signature = ethers.Signature.from(await new ethers.Wallet(privateKey).signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  return Object.freeze({
    publicationStatus: 'confirmed',
    assertionCoordinate: 'agent-profile-v1' as never,
    seal: Object.freeze({
      assertionMerkleRoot,
      authorAddress: canonicalAddress,
      authorAttestationR: signature.r,
      authorAttestationVS: signature.yParityAndS,
      authorSchemeVersion: '1',
      assertedAtChainId: '84532',
      assertedAtKav10Address: `0x${'44'.repeat(20)}`,
      reservedKaId: reservedKaId.toString(),
      assertionFinalizedAt: issuedAt.replace('Z', '.000Z'),
      contentScopeVersion: '2',
      kaUal: `did:dkg:base:84532/${canonicalAddress}/7`,
      assertionVersion: '1',
      publicTripleCount: String(prepared.quads.length),
      privateTripleCount: '0',
      privateMerkleRoot: null,
    }) as CanonicalGraphScopedAuthorSealV1,
    issuedAt,
    validUntil: new Date(Date.parse(issuedAt) + 24 * 60 * 60 * 1000)
      .toISOString().replace('.000Z', 'Z'),
    projectionSchemaDigest: SCHEMA_DIGEST,
  });
}

export async function signHeadEnvelope(
  object: AgentProfileHeadObjectV1,
  peerSigner: SystemRecordPeerSignerV1,
  evmSigner: EvmPersonalMessageSignerV1,
): Promise<SignedAgentProfileHeadEnvelopeV1> {
  const objectDigest = computeAgentProfileHeadObjectDigestV1(object);
  const [peerSignature, evmSignature] = await Promise.all([
    peerSigner.sign(buildSystemRecordSignatureMessageV1(object, objectDigest, 'peer')),
    evmSigner.signMessage(buildSystemRecordSignatureMessageV1(object, objectDigest, 'current-evm')),
  ]);
  return Object.freeze({
    object,
    objectDigest,
    signatures: Object.freeze([
      Object.freeze({
        role: 'peer' as const,
        suite: 'ed25519-v1' as const,
        signer: peerSigner.peerId,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: Buffer.from(peerSignature).toString('base64url'),
      }),
      Object.freeze({
        role: 'current-evm' as const,
        suite: 'eip191-personal-sign-digest-v1' as const,
        signer: evmSigner.address,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: evmSignature,
      }),
    ]),
  });
}

export async function signTransitionEnvelope(
  object: AgentProfileAuthorityTransitionV1,
  peerSigner: SystemRecordPeerSignerV1,
  priorSigner: EvmPersonalMessageSignerV1,
  nextSigner: EvmPersonalMessageSignerV1,
): Promise<SignedAgentProfileAuthorityTransitionEnvelopeV1> {
  const objectDigest = computeAgentProfileAuthorityTransitionDigestV1(object);
  const [peerSignature, priorSignature, nextSignature] = await Promise.all([
    peerSigner.sign(buildSystemRecordSignatureMessageV1(object, objectDigest, 'peer')),
    priorSigner.signMessage(buildSystemRecordSignatureMessageV1(object, objectDigest, 'prior-evm')),
    nextSigner.signMessage(buildSystemRecordSignatureMessageV1(object, objectDigest, 'next-evm')),
  ]);
  return Object.freeze({
    object,
    objectDigest,
    signatures: Object.freeze([
      Object.freeze({
        role: 'peer' as const,
        suite: 'ed25519-v1' as const,
        signer: peerSigner.peerId,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: Buffer.from(peerSignature).toString('base64url'),
      }),
      Object.freeze({
        role: 'prior-evm' as const,
        suite: 'eip191-personal-sign-digest-v1' as const,
        signer: priorSigner.address,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: priorSignature,
      }),
      Object.freeze({
        role: 'next-evm' as const,
        suite: 'eip191-personal-sign-digest-v1' as const,
        signer: nextSigner.address,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: nextSignature,
      }),
    ]),
  });
}

export function envelopeArtifact(
  objectKind: 'agent-profile-head' | 'authority-transition',
  envelope: SignedAgentProfileHeadEnvelopeV1 | SignedAgentProfileAuthorityTransitionEnvelopeV1,
): SystemRecordProviderArtifactV1 {
  return Object.freeze({
    objectKind,
    objectDigest: envelope.objectDigest,
    canonicalBytes: canonicalizeSignedSystemRecordEnvelopeV1(envelope),
  });
}

export function observingStore(
  inner: InMemoryAgentProfilePublicationStoreV1,
  events: string[],
): InMemoryAgentProfilePublicationStoreV1 {
  return Object.freeze({
    snapshot: () => inner.snapshot(),
    resolve: (lookup, signal) => inner.resolve(lookup, signal),
    resolveArtifact: (reference) => inner.resolveArtifact(reference),
    async prepareCommit(input) {
      const lease = await inner.prepareCommit(input);
      return Object.freeze({
        commit: async () => {
          events.push('advertise');
          await lease.commit();
        },
        abort: () => lease.abort(),
      });
    },
  });
}

export function rootRequest(): SystemRecordProviderLookupV1 {
  return { type: 'root' };
}

export function controlRequest(digest: Digest32V1): SystemRecordProviderLookupV1 {
  return { type: 'object', objectKind: 'agent-profile-head', objectDigest: digest };
}

function projectionContentDigest(prepared: PreparedAgentProfileV1): Digest32V1 {
  const quads = [...prepared.quads].sort((left, right) => Buffer.compare(
    tripleContentV10(left.subject, left.predicate, left.object),
    tripleContentV10(right.subject, right.predicate, right.object),
  ));
  const leaves = quads.map((quad) => keccak256(
    tripleContentV10(quad.subject, quad.predicate, quad.object),
  ));
  return `0x${Buffer.from(V10MerkleTree.computeKARoot(
    new V10MerkleTree(leaves).root,
    SENTINEL_NO_PRIVATE_V10,
  )).toString('hex')}` as Digest32V1;
}
