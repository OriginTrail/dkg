import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  decodeOpaqueKaBundleV1,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import {
  Rfc64PublicCatalogSuccessorProducerV1,
} from '../src/rfc64/public-catalog-successor-producer-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'66'.repeat(32)}`);
const ATTACKER_WALLET = new ethers.Wallet(`0x${'77'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/successor-producer' as ContextGraphIdV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const DELEGATION_DIGEST = `0x${'76'.repeat(32)}` as Digest32V1;
const KA_NUMBER = 7n;
const KA_ID = ((BigInt(AUTHOR) << 96n) | KA_NUMBER).toString();
const UAL = `did:dkg:${NETWORK_ID}/${AUTHOR}/${KA_NUMBER}`;
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

describe('RFC-64 public/open one-row successor producer', () => {
  it('verifies the exact successor before staging its bundle and signed objects', async () => {
    const genesis = await emptyGenesis();
    const events: string[] = [];
    let stagedBundle: { blobDigest: Digest32V1; bundleBytes: Uint8Array } | undefined;
    let stagedObjects: readonly { envelope: { objectType: string } }[] | undefined;
    const stageKaBundle = vi.fn(async (input) => {
      events.push('bundle');
      stagedBundle = input;
    });
    const stageVerifiedObjects = vi.fn(async (input) => {
      events.push('objects');
      stagedObjects = input;
      return Object.freeze({
        durable: true as const,
        namespaceDurability: 'test-exact-durable' as never,
        objects: Object.freeze([]),
      });
    });
    const producer = new Rfc64PublicCatalogSuccessorProducerV1({
      controlObjects: { stageVerifiedObjects } as never,
      stageKaBundle,
    });

    const result = await producer.produceAndStage({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      assertionCoordinate: 'gate-1-object' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(AUTHOR_WALLET),
      deployment: DEPLOYMENT,
      issuedAt: '1773900001000' as never,
      catalogSigner: catalogSigner(),
    });

    expect(events).toEqual(['bundle', 'objects']);
    expect(result.publication.head.payload).toMatchObject({
      subGraphName: null,
      bucketCount: '1',
      directoryHeight: '0',
      totalRows: '1',
      version: '1',
      previousHeadDigest: genesis.head.objectDigest,
    });
    expect(result.publication.bucket?.payload.rows).toEqual([result.row]);
    expect(stagedObjects?.map(({ envelope }) => envelope.objectType)).toEqual([
      AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
      AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    ]);
    expect(stagedBundle?.blobDigest).toBe(result.bundleDigest);
    expect(stagedBundle?.bundleBytes).toEqual(result.bundleBytes);
    expect(stagedBundle?.bundleBytes).not.toBe(result.bundleBytes);
    expect(decodeOpaqueKaBundleV1(result.bundleBytes).projectionBytes).toEqual(PROJECTION);
    expect(result.transfer).toMatchObject({
      blobDigest: result.bundleDigest,
      catalogRowDigest: result.sealBinding.catalogRowDigest,
    });
    expect(result.projection).toMatchObject({
      kaUal: UAL,
      publicTripleCount: '2',
      privateTripleCount: '0',
      assertionMerkleRoot: ASSERTION_ROOT,
    });
    expect(result.sealBinding).toMatchObject({
      authorAddress: AUTHOR,
      kaId: KA_ID,
      assertionCoordinate: 'gate-1-object',
    });
  });

  it('rejects a non-author attestation before either durable staging callback', async () => {
    const genesis = await emptyGenesis();
    const stageKaBundle = vi.fn(async () => {});
    const stageVerifiedObjects = vi.fn(async () => undefined as never);
    const catalogSignDigest = vi.fn(async (digest: Uint8Array) =>
      AUTHOR_WALLET.signMessage(digest));
    const producer = new Rfc64PublicCatalogSuccessorProducerV1({
      controlObjects: { stageVerifiedObjects } as never,
      stageKaBundle,
    });

    await expect(producer.produceAndStage({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      assertionCoordinate: 'gate-1-object' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(ATTACKER_WALLET),
      deployment: DEPLOYMENT,
      issuedAt: '1773900001000' as never,
      catalogSigner: { issuer: AUTHOR, signDigest: catalogSignDigest },
    })).rejects.toMatchObject({ code: 'catalog-successor-producer-binding' });

    expect(catalogSignDigest).not.toHaveBeenCalled();
    expect(stageKaBundle).not.toHaveBeenCalled();
    expect(stageVerifiedObjects).not.toHaveBeenCalled();
  });

  it('rejects a deployment/seal binding mismatch before durable staging', async () => {
    const genesis = await emptyGenesis();
    const stageKaBundle = vi.fn(async () => {});
    const stageVerifiedObjects = vi.fn(async () => undefined as never);
    const producer = new Rfc64PublicCatalogSuccessorProducerV1({
      controlObjects: { stageVerifiedObjects } as never,
      stageKaBundle,
    });

    await expect(producer.produceAndStage({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      assertionCoordinate: 'gate-1-object' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(AUTHOR_WALLET),
      deployment: {
        ...DEPLOYMENT,
        assertedAtChainId: '20431',
      } as CatalogSealDeploymentProfileV1,
      issuedAt: '1773900001000' as never,
      catalogSigner: catalogSigner(),
    })).rejects.toMatchObject({ code: 'catalog-successor-producer-binding' });

    expect(stageKaBundle).not.toHaveBeenCalled();
    expect(stageVerifiedObjects).not.toHaveBeenCalled();
  });
});

async function emptyGenesis() {
  return produceEmptyAuthorCatalogGenesisV1({
    scope: {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: GOVERNANCE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as AuthorCatalogScopeV1,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    issuedAt: '1773900000000' as never,
    signer: catalogSigner(),
  });
}

function catalogSigner() {
  return {
    issuer: AUTHOR,
    signDigest: async (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
  };
}

async function authorSeal(signingWallet: ethers.Wallet): Promise<CanonicalGraphScopedAuthorSealV1> {
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(KA_ID),
  });
  const signature = ethers.Signature.from(await signingWallet.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: KA_ID,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: UAL,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}
