// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MEMBER_ROSTER_OBJECT_TYPE_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeContextGraphPolicyObjectDigestV1,
  computeKaProjectionDigestV1,
} from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { packKnowledgeAssetIdFromIdentity } from '../../src/ka-identity.ts';
import {
  canonicalGraphlessProjectionNQuads,
  computeGraphlessMemoryEvidence,
} from './memory-evidence.mjs';

const ROLE_KEYS = Object.freeze({
  owner: `0x${'64'.repeat(32)}`,
  provider2: `0x${'65'.repeat(32)}`,
  receiver: `0x${'66'.repeat(32)}`,
  outsider: `0x${'67'.repeat(32)}`,
});

export const NETWORK_ID = 'otp:20430';
export const CHAIN_ID = '20430';
export const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/rfc64-private-release-gate';
export const ON_CHAIN_CONTEXT_GRAPH_ID = '14';
export const CONTEXT_GRAPH_STORAGE = '0x3333333333333333333333333333333333333333';
export const KAV10 = '0x4444444444444444444444444444444444444444';
export const KA_STORAGE = '0x5555555555555555555555555555555555555555';
export const FINALIZED_BLOCK_HASH = `0x${'77'.repeat(32)}`;
export const FINALIZED_POLICY_BLOCK_HASH = `0x${'76'.repeat(32)}`;
export const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f';
export const ASSET_NUMBERS = Object.freeze([41, 42]);
export const PROJECTION_QUADS = Object.freeze([
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/age',
    object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
  }),
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/name',
    object: '"Alice"',
  }),
]);
export const PROJECTION_NQUADS = canonicalGraphlessProjectionNQuads(PROJECTION_QUADS);
export const PROJECTION = new TextEncoder().encode(`${PROJECTION_NQUADS}\n`);
export const PROJECTION_EVIDENCE = computeGraphlessMemoryEvidence(PROJECTION_QUADS);
export const PROJECTION_DIGEST = PROJECTION_EVIDENCE.digest;
export const UPDATED_PROJECTION_QUADS = Object.freeze([
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/age',
    object: '"43"^^<http://www.w3.org/2001/XMLSchema#integer>',
  }),
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/name',
    object: '"Alice v2"',
  }),
]);
export const UPDATED_PROJECTION_EVIDENCE = computeGraphlessMemoryEvidence(
  UPDATED_PROJECTION_QUADS,
);
export const UPDATED_ASSERTION_ROOT = ethers.hexlify(
  computeFlatKCRootV10([...UPDATED_PROJECTION_QUADS], []),
).toLowerCase();
export const UPDATED_PROJECTION = new TextEncoder().encode(
  `${canonicalGraphlessProjectionNQuads(UPDATED_PROJECTION_QUADS)}\n`,
);
export const PRIVATE_CATALOG_SWM_SHARE_OPERATION_PREFIX =
  'rfc64-private-release-gate-v2-';
export function privateCatalogSwmShareOperationId(kaNumber) {
  if (!ASSET_NUMBERS.includes(kaNumber)) {
    throw new Error(`unknown RFC-64 private release-gate asset ${String(kaNumber)}`);
  }
  return `${PRIVATE_CATALOG_SWM_SHARE_OPERATION_PREFIX}${kaNumber}`;
}
export const PRIVATE_CATALOG_MEMORY_EXPECTATION = Object.freeze({
  assetNumbers: ASSET_NUMBERS,
  swm: Object.freeze({
    projection: UPDATED_PROJECTION_EVIDENCE,
    assertionVersion: '2',
    authorAddress: roleAgentAddress('owner'),
    catalogProjectionDigest: computeKaProjectionDigestV1(UPDATED_PROJECTION),
    catalogVersion: '4',
    proofKind: 'catalog-row',
    shareOperationIdPrefix: PRIVATE_CATALOG_SWM_SHARE_OPERATION_PREFIX,
  }),
  vm: Object.freeze({
    projection: PROJECTION_EVIDENCE,
    assertionVersion: '1',
  }),
});
export const PRIVATE_MEMBER_ROLES = Object.freeze(['owner', 'provider2', 'receiver']);
export const RUNTIME_ROLES = Object.freeze([
  ...PRIVATE_MEMBER_ROLES,
  'outsider',
]);
export const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: CHAIN_ID,
  assertedAtKav10Address: KAV10,
});

export function roleAgentAddress(role) {
  return new ethers.Wallet(rolePrivateKey(role)).address.toLowerCase();
}

export function rolePrivateKey(role) {
  const privateKey = ROLE_KEYS[role];
  if (privateKey === undefined) throw new Error(`unknown RFC-64 devnet role ${role}`);
  return privateKey;
}

export function ownerWallet() {
  return new ethers.Wallet(ROLE_KEYS.owner);
}

/** Canonical private-catalog identity derived from the declared gate policy. */
export function createPrivateCatalogScope({
  authorAddress = roleAgentAddress('owner'),
} = {}) {
  const { policy } = createPrivatePolicyAndRoster();
  return Object.freeze({
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    governanceChainId: policy.governanceChainId,
    governanceContractAddress: policy.governanceContractAddress,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    subGraphName: null,
    authorAddress,
    era: policy.era,
    bucketCount: '1',
  });
}

/** Derive the receiver API's catalog-era spelling from the canonical scope. */
export function createPrivateCatalogSyncScope() {
  const scope = createPrivateCatalogScope();
  return Object.freeze({
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    catalogEra: scope.era,
  });
}

export function createPrivatePolicyAndRoster({
  contextGraphId = CONTEXT_GRAPH_ID,
  memberRoles = PRIVATE_MEMBER_ROLES,
} = {}) {
  const ownerAddress = roleAgentAddress('owner');
  const ownershipTransitionDigest = ethers.keccak256(ethers.toUtf8Bytes(
    `dkg:rfc64:ownership:v1\n${contextGraphId}\n${ownerAddress}\n0`,
  )).toLowerCase();
  const policy = Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId,
    governanceChainId: CHAIN_ID,
    governanceContractAddress: CONTEXT_GRAPH_STORAGE,
    ownershipTransitionDigest,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: ownerAddress,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: Object.freeze({
      kind: 'finalized-chain',
      chainId: CHAIN_ID,
      contractAddress: CONTEXT_GRAPH_STORAGE,
      blockNumber: '120',
      blockHash: FINALIZED_POLICY_BLOCK_HASH,
    }),
    effectiveAt: '0',
    issuedAt: '0',
  });
  const policyEnvelope = Object.freeze({
    issuer: ownerAddress,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: policy,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  });
  const policyDigest = computeContextGraphPolicyObjectDigestV1(policyEnvelope);
  const roster = Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId,
    ownershipTransitionDigest,
    era: '0',
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: null,
    members: Object.freeze(memberRoles
      .map(roleAgentAddress)
      .sort()
      .map((agentAddress) => Object.freeze({
        agentAddress,
        roles: Object.freeze(['holder', 'provider']),
      }))),
    issuedAt: '0',
  });
  const rosterEnvelope = Object.freeze({
    issuer: ownerAddress,
    objectType: MEMBER_ROSTER_OBJECT_TYPE_V1,
    payload: roster,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  });
  return Object.freeze({ policy, policyEnvelope, policyDigest, roster, rosterEnvelope });
}

/** Finalized roster generation after the original receiver is removed. */
export function createReceiverRevokedPolicyAndRoster() {
  const current = createPrivatePolicyAndRoster();
  const roster = Object.freeze({
    ...current.roster,
    version: '1',
    members: Object.freeze(current.roster.members.filter(
      ({ agentAddress }) => agentAddress !== roleAgentAddress('receiver'),
    )),
    issuedAt: '0',
  });
  const rosterEnvelope = Object.freeze({
    ...current.rosterEnvelope,
    payload: roster,
  });
  return Object.freeze({
    policy: current.policy,
    policyEnvelope: current.policyEnvelope,
    policyDigest: current.policyDigest,
    roster,
    rosterEnvelope,
  });
}

export function createFinalizedChainFixture() {
  const ownerAddress = roleAgentAddress('owner');
  return Object.freeze({
    accessPolicy: 1,
    active: true,
    authorityBlockHash: FINALIZED_POLICY_BLOCK_HASH,
    authorityBlockNumber: '120',
    assertedAtChainId: CHAIN_ID,
    assertedAtKav10Address: KAV10,
    knowledgeAssetStorageAddress: KA_STORAGE,
    assets: Object.freeze(ASSET_NUMBERS.map((kaNumber) => Object.freeze({
      assertionRoot: ASSERTION_ROOT,
      assertionVersion: '1',
      authorAddress: ownerAddress,
      kaId: packKnowledgeAssetIdFromIdentity({
        agentAddress: ownerAddress,
        kaNumber,
      }).toString(),
      publisherAddress: ownerAddress,
    }))),
    blockHash: FINALIZED_BLOCK_HASH,
    blockNumberQuantity: '0x7c',
    contextGraphStorageAddress: CONTEXT_GRAPH_STORAGE,
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase(),
    networkId: NETWORK_ID,
    onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
    ownerAddress,
    ownershipEra: '0',
    participantAgents: Object.freeze(PRIVATE_MEMBER_ROLES.map(roleAgentAddress)),
    policyVersion: '0',
    publishPolicy: 0,
    publishAuthority: ownerAddress,
    publishAuthorityAccountId: '0',
    rosterVersion: '0',
  });
}

export async function createCatalogAssets({
  assertionRoot = ASSERTION_ROOT,
  assertionVersion = '1',
  projectionBytes = PROJECTION,
} = {}) {
  const wallet = ownerWallet();
  const ownerAddress = wallet.address.toLowerCase();
  return Promise.all(ASSET_NUMBERS.map(async (kaNumber) => {
    const kaId = packKnowledgeAssetIdFromIdentity({
      agentAddress: ownerAddress,
      kaNumber,
    }).toString();
    const typedData = buildAuthorAttestationTypedData({
      chainId: BigInt(CHAIN_ID),
      kav10Address: KAV10,
      merkleRoot: ethers.getBytes(assertionRoot),
      authorAddress: ownerAddress,
      reservedKaId: BigInt(kaId),
    });
    const signature = ethers.Signature.from(await wallet.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
    ));
    const seal = {
      assertionMerkleRoot: assertionRoot,
      authorAddress: ownerAddress,
      authorAttestationR: signature.r,
      authorAttestationVS: signature.yParityAndS,
      authorSchemeVersion: '1',
      assertedAtChainId: CHAIN_ID,
      assertedAtKav10Address: KAV10,
      reservedKaId: kaId,
      assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
      contentScopeVersion: '2',
      kaUal: `did:dkg:${NETWORK_ID}/${ownerAddress}/${kaNumber}`,
      assertionVersion,
      publicTripleCount: '2',
      privateTripleCount: '0',
      privateMerkleRoot: null,
    };
    assertCanonicalGraphScopedAuthorSealV1(seal);
    return Object.freeze({
      assertionCoordinate: `private-release-gate-${kaNumber}`,
      projectionBytes,
      seal: Object.freeze(seal),
    });
  }));
}
