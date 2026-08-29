import {
  assertCanonicalChainId,
  assertCanonicalEvmAddress,
  assertCanonicalGraphScopedAuthorSealV1,
  assertNetworkIdV1,
  buildAuthorAttestationTypedData,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { quadsToNQuads, type Quad } from '@origintrail-official/dkg-storage';

const networkId = 'otp:20430';
assertNetworkIdV1(networkId, 'Gate-1 fixture networkId');
export const GATE1_NETWORK_ID = networkId;

const kav10Address = '0x4444444444444444444444444444444444444444';
assertCanonicalEvmAddress(kav10Address, 'Gate-1 fixture KAV10 address');
export const GATE1_KAV10_ADDRESS = kav10Address;

const assertedAtChainId = '20430';
assertCanonicalChainId(assertedAtChainId, 'Gate-1 fixture chain id');

export const GATE1_DEPLOYMENT = Object.freeze({
  networkId: GATE1_NETWORK_ID,
  assertedAtChainId,
  assertedAtKav10Address: GATE1_KAV10_ADDRESS,
}) satisfies CatalogSealDeploymentProfileV1;

export const GATE1_AUTHOR_PRIVATE_KEY = `0x${'64'.repeat(32)}`;
export const GATE1_AUTHOR_WALLET = new ethers.Wallet(GATE1_AUTHOR_PRIVATE_KEY);
const authorAddress = GATE1_AUTHOR_WALLET.address.toLowerCase();
assertCanonicalEvmAddress(authorAddress, 'Gate-1 fixture author address');
export const GATE1_AUTHOR_ADDRESS = authorAddress;

export const GATE1_KA_NUMBER = 7n;
export const GATE1_KA_ID = (
  (BigInt(GATE1_AUTHOR_ADDRESS) << 96n) | GATE1_KA_NUMBER
).toString();
export const GATE1_KA_UAL =
  `did:dkg:${GATE1_NETWORK_ID}/${GATE1_AUTHOR_ADDRESS}/${GATE1_KA_NUMBER}`;
export const GATE1_ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f';
export const GATE1_PROJECTION_QUADS = Object.freeze([
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/age',
    object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
    graph: '',
  }),
  Object.freeze({
    subject: 'https://example.org/alice',
    predicate: 'https://schema.org/name',
    object: '"Alice"',
    graph: '',
  }),
] satisfies readonly Quad[]);
export const GATE1_PROJECTION_NQUADS = `${quadsToNQuads(GATE1_PROJECTION_QUADS)}\n`;

export const GATE1_ROLE_MASTER_KEYS = Object.freeze({
  author: '1a'.repeat(32),
  receiver: '2b'.repeat(32),
});

export async function createGate1AuthorSealV1(
): Promise<CanonicalGraphScopedAuthorSealV1> {
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(GATE1_DEPLOYMENT.assertedAtChainId),
    kav10Address: GATE1_DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(GATE1_ASSERTION_ROOT),
    authorAddress: GATE1_AUTHOR_ADDRESS,
    reservedKaId: BigInt(GATE1_KA_ID),
  });
  const signature = ethers.Signature.from(await GATE1_AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: GATE1_ASSERTION_ROOT,
    authorAddress: GATE1_AUTHOR_ADDRESS,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: GATE1_DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: GATE1_DEPLOYMENT.assertedAtKav10Address,
    reservedKaId: GATE1_KA_ID,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: GATE1_KA_UAL,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}
