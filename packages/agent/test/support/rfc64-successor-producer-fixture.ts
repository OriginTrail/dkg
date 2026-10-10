import {
  KA_TRANSFER_CHUNK_SIZE_BYTES_V1,
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  canonicalizeAuthorCatalogRowV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaChunkTreeRootV1,
  encodeOpaqueKaBundleV1,
  parseCanonicalAuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import type { PreparedSuccessorRowV1 } from '../../src/internal/verified-catalog-rows.js';
import { produceEmptyAuthorCatalogGenesisV1 } from '../../src/rfc64/author-catalog-producer.js';
import { produceDirectAuthorCatalogIssuerDelegationV1 } from
  '../../src/rfc64/public-catalog-issuer-delegation-v1.js';
import {
  Rfc64PublicCatalogSuccessorProducerV1,
  type ProduceAndStagePublicOpenExactSetSuccessorInputV1,
  type Rfc64PublicCatalogSuccessorAssetInputV1,
  type Rfc64PublicCatalogSuccessorProducerOptionsV1,
} from '../../src/rfc64/public-catalog-successor-producer-v1.js';

/** A real author catalog, its seals and an in-memory successor producer over it. */

export const PRODUCER_AUTHOR_WALLET = new ethers.Wallet(`0x${'67'.repeat(32)}`);
export const PRODUCER_AUTHOR = PRODUCER_AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
export const PRODUCER_NETWORK_ID = 'otp:20430' as NetworkIdV1;
export const PRODUCER_CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/successor-rows' as ContextGraphIdV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
export const PRODUCER_PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);
export const PRODUCER_DEPLOYMENT = Object.freeze({
  networkId: PRODUCER_NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

export type ProducerInputV1 = ProduceAndStagePublicOpenExactSetSuccessorInputV1;
export type ProducerHistoryV1 = Pick<ProducerInputV1, 'previousHead' | 'previousDirectoryPath' | 'previousBucket'>;

export function producerSignerV1(
  signDigest: (digest: Uint8Array) => Promise<string> = (digest) => PRODUCER_AUTHOR_WALLET.signMessage(digest),
) {
  return { issuer: PRODUCER_AUTHOR, signDigest };
}

/** The signed genesis of one lane and the delegation that authorizes its catalog key. */
export async function producerGenesisV1(
  contextGraphId: ContextGraphIdV1 = PRODUCER_CONTEXT_GRAPH_ID,
) {
  const scope = {
    networkId: PRODUCER_NETWORK_ID,
    contextGraphId,
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: PRODUCER_AUTHOR,
    era: '0',
    bucketCount: '1',
  } as AuthorCatalogScopeV1;
  const { authorization } = await produceDirectAuthorCatalogIssuerDelegationV1({
    scope,
    signer: producerSignerV1(),
    effectiveAt: '1773899999000' as never,
    expiresAt: '1774000000000' as never,
    catalogHeadIssuedAt: '1773900000000' as never,
  });
  const genesis = await produceEmptyAuthorCatalogGenesisV1({
    scope,
    catalogIssuerDelegationDigest: authorization.catalogIssuerDelegation.objectDigest as Digest32V1,
    issuedAt: '1773900000000' as never,
    signer: producerSignerV1(),
  });
  const history: ProducerHistoryV1 = {
    previousHead: genesis.head,
    previousDirectoryPath: genesis.directoryPath,
    previousBucket: null,
  };
  return { scope, authorization, history };
}

export async function producerSealV1(
  kaNumber: bigint,
  assertionVersion = '1',
  wallet: ethers.Wallet = PRODUCER_AUTHOR_WALLET,
): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(PRODUCER_AUTHOR) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(PRODUCER_DEPLOYMENT.assertedAtChainId),
    kav10Address: PRODUCER_DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: PRODUCER_AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await wallet.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: PRODUCER_AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: PRODUCER_DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${PRODUCER_NETWORK_ID}/${PRODUCER_AUTHOR}/${kaNumber}`,
    assertionVersion,
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

export async function producerAssetV1(
  kaNumber: number,
  assertionVersion = '1',
): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> {
  return {
    assertionCoordinate: `row-${kaNumber}` as never,
    projectionBytes: PRODUCER_PROJECTION,
    seal: await producerSealV1(BigInt(kaNumber), assertionVersion),
  };
}

/** A producer whose stores accept everything and keep nothing. */
export function producerOverMemoryV1(
  options: Partial<Rfc64PublicCatalogSuccessorProducerOptionsV1> = {},
): Rfc64PublicCatalogSuccessorProducerV1 {
  return new Rfc64PublicCatalogSuccessorProducerV1({
    controlObjects: {
      stageVerifiedObjects: async () => Object.freeze({
        durable: true as const,
        namespaceDurability: 'test-exact-durable' as never,
        objects: Object.freeze([]),
      }),
    } as never,
    stageKaBundle: async (input) => Object.freeze({
      durable: true as const,
      blobDigest: input.blobDigest,
      byteLength: input.bundleBytes.byteLength,
    }),
    ...options,
  });
}

/** One row as the producer prepares it: built from the digests of the bytes it holds. */
export function preparedSuccessorRowV1(
  asset: Rfc64PublicCatalogSuccessorAssetInputV1,
  scope: AuthorCatalogScopeV1,
  deployment: CatalogSealDeploymentProfileV1 = PRODUCER_DEPLOYMENT,
): PreparedSuccessorRowV1 {
  const sealBytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(asset.seal);
  const encoded = encodeOpaqueKaBundleV1(asset.projectionBytes, sealBytes);
  const byteLength = BigInt(encoded.bundleBytes.byteLength);
  const row = parseCanonicalAuthorCatalogRowV1(canonicalizeAuthorCatalogRowV1({
    kaId: asset.seal.reservedKaId,
    assertionCoordinate: asset.assertionCoordinate,
    assertionVersion: asset.seal.assertionVersion,
    projectionId: KA_TRANSFER_PROJECTION_V1,
    projectionDigest: encoded.projectionDigest,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(asset.seal),
    transfer: {
      codec: KA_TRANSFER_CODEC_V1,
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest: encoded.projectionDigest,
      byteLength: byteLength.toString() as never,
      chunkSize: KA_TRANSFER_CHUNK_SIZE_V1,
      chunkCount: (((byteLength - 1n) / KA_TRANSFER_CHUNK_SIZE_BYTES_V1) + 1n).toString() as never,
      blobDigest: encoded.blobDigest,
      chunkTreeRoot: computeKaChunkTreeRootV1(encoded.bundleBytes),
    },
  }));
  return Object.freeze({
    deployment,
    scope,
    row: Object.freeze(row),
    sealBytes,
    bundleBytes: new Uint8Array(encoded.bundleBytes),
  });
}
