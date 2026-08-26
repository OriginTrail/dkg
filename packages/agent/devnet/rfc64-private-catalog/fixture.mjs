// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MEMBER_ROSTER_OBJECT_TYPE_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeContextGraphPolicyObjectDigestV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

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
export const PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);
export const PROJECTION_NQUADS = new TextDecoder().decode(PROJECTION)
  .trim()
  .split('\n')
  .sort()
  .join('\n');
export const PROJECTION_DIGEST = createHash('sha256')
  .update(PROJECTION_NQUADS, 'utf8')
  .digest('hex');
export const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: CHAIN_ID,
  assertedAtKav10Address: KAV10,
});

export function roleAgentAddress(role) {
  const privateKey = ROLE_KEYS[role];
  if (privateKey === undefined) throw new Error(`unknown RFC-64 devnet role ${role}`);
  return new ethers.Wallet(privateKey).address.toLowerCase();
}

export function ownerWallet() {
  return new ethers.Wallet(ROLE_KEYS.owner);
}

export function createPrivatePolicyAndRoster() {
  const ownerAddress = roleAgentAddress('owner');
  const policy = Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: CHAIN_ID,
    governanceContractAddress: CONTEXT_GRAPH_STORAGE,
    ownershipTransitionDigest: null,
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
    effectiveAt: '1773900000000',
    issuedAt: '1773900000000',
  });
  const policyEnvelope = Object.freeze({
    issuer: CONTEXT_GRAPH_STORAGE,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: policy,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  });
  const policyDigest = computeContextGraphPolicyObjectDigestV1(policyEnvelope);
  const roster = Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: null,
    members: Object.freeze([
      Object.freeze({ agentAddress: ownerAddress, roles: Object.freeze(['holder', 'provider']) }),
      Object.freeze({
        agentAddress: roleAgentAddress('provider2'),
        roles: Object.freeze(['holder', 'provider']),
      }),
      Object.freeze({
        agentAddress: roleAgentAddress('receiver'),
        roles: Object.freeze(['holder']),
      }),
    ]),
    issuedAt: '1773900000000',
  });
  const rosterEnvelope = Object.freeze({
    issuer: CONTEXT_GRAPH_STORAGE,
    objectType: MEMBER_ROSTER_OBJECT_TYPE_V1,
    payload: roster,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  });
  return Object.freeze({ policy, policyEnvelope, policyDigest, roster, rosterEnvelope });
}

export function createFinalizedChainFixture() {
  const ownerAddress = roleAgentAddress('owner');
  return Object.freeze({
    accessPolicy: 1,
    active: true,
    assertedAtChainId: CHAIN_ID,
    assertedAtKav10Address: KAV10,
    knowledgeAssetStorageAddress: KA_STORAGE,
    assets: Object.freeze(ASSET_NUMBERS.map((kaNumber) => Object.freeze({
      assertionRoot: ASSERTION_ROOT,
      assertionVersion: '1',
      authorAddress: ownerAddress,
      kaId: ((BigInt(ownerAddress) << 96n) | BigInt(kaNumber)).toString(),
      publisherAddress: ownerAddress,
    }))),
    blockHash: FINALIZED_BLOCK_HASH,
    blockNumberQuantity: '0x7c',
    contextGraphStorageAddress: CONTEXT_GRAPH_STORAGE,
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase(),
    networkId: NETWORK_ID,
    onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
    ownerAddress,
    publishPolicy: 0,
    publishAuthority: ownerAddress,
    publishAuthorityAccountId: '0',
  });
}

export async function createCatalogAssets() {
  const wallet = ownerWallet();
  const ownerAddress = wallet.address.toLowerCase();
  return Promise.all(ASSET_NUMBERS.map(async (kaNumber) => {
    const kaId = ((BigInt(ownerAddress) << 96n) | BigInt(kaNumber)).toString();
    const typedData = buildAuthorAttestationTypedData({
      chainId: BigInt(CHAIN_ID),
      kav10Address: KAV10,
      merkleRoot: ethers.getBytes(ASSERTION_ROOT),
      authorAddress: ownerAddress,
      reservedKaId: BigInt(kaId),
    });
    const signature = ethers.Signature.from(await wallet.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
    ));
    const seal = {
      assertionMerkleRoot: ASSERTION_ROOT,
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
      assertionVersion: '1',
      publicTripleCount: '2',
      privateTripleCount: '0',
      privateMerkleRoot: null,
    };
    assertCanonicalGraphScopedAuthorSealV1(seal);
    return Object.freeze({
      assertionCoordinate: `private-release-gate-${kaNumber}`,
      projectionBytes: PROJECTION,
      seal: Object.freeze(seal),
    });
  }));
}
