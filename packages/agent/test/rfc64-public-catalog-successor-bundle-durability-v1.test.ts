import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
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
import { produceDirectAuthorCatalogIssuerDelegationV1 } from '../src/rfc64/public-catalog-issuer-delegation-v1.js';
import { Rfc64PublicCatalogSuccessorProducerV1 } from '../src/rfc64/public-catalog-successor-producer-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'66'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/successor-durability' as ContextGraphIdV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
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

type BundleStageInput = {
  readonly blobDigest: Digest32V1;
  readonly bundleBytes: Uint8Array;
};

describe('RFC-64 public catalog successor bundle durability', () => {
  it.each([
    ['exact durable bytes', (bytes: Uint8Array) => new Uint8Array(bytes), 1],
    ['missing durable bytes', (_bytes: Uint8Array) => null, 2],
    ['mismatched durable bytes', (bytes: Uint8Array) => {
      const corrupted = new Uint8Array(bytes);
      corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
      return corrupted;
    }, 2],
  ] as const)(
    'rechecks unchanged predecessor bundles after restart: %s',
    async (_label, durableRead, expectedSuccessorStages) => {
      const durableBundles = new Map<string, Uint8Array>();
      const firstStageKaBundle = vi.fn(async (input: BundleStageInput) => {
        durableBundles.set(input.blobDigest, new Uint8Array(input.bundleBytes));
        return durableBundleReceipt(input);
      });
      const history = await oneRowHistory(firstStageKaBundle);
      const successorStageKaBundle = vi.fn(durableBundleReceipt);
      const readKaBundleByDigest = vi.fn(async (digest: string) => {
        const bytes = durableBundles.get(digest);
        return bytes === undefined ? null : durableRead(bytes);
      });
      const restartedProducer = new Rfc64PublicCatalogSuccessorProducerV1({
        controlObjects: durableControlObjects(),
        stageKaBundle: successorStageKaBundle,
        readKaBundleByDigest: readKaBundleByDigest as never,
      });

      await restartedProducer.produceAndStageExactSet(successorInput(history));

      expect(readKaBundleByDigest).toHaveBeenCalledOnce();
      expect(firstStageKaBundle).toHaveBeenCalledOnce();
      expect(successorStageKaBundle).toHaveBeenCalledTimes(expectedSuccessorStages);
    },
  );

  it('drains every started bundle mutation before reporting a staging failure', async () => {
    const history = await oneRowHistory(durableBundleReceipt);
    const slowStage = deferred<void>();
    const slowStageStarted = deferred<void>();
    let slowStageFinished = false;
    let stageCalls = 0;
    const stageKaBundle = vi.fn(async (input: BundleStageInput) => {
      stageCalls += 1;
      if (stageCalls === 1) throw new Error('first durable write failed');
      slowStageStarted.resolve(undefined);
      await slowStage.promise;
      slowStageFinished = true;
      return durableBundleReceipt(input);
    });
    const stageVerifiedObjects = vi.fn(async () => undefined as never);
    const producer = new Rfc64PublicCatalogSuccessorProducerV1({
      controlObjects: { stageVerifiedObjects } as never,
      stageKaBundle,
    });

    const producing = producer.produceAndStageExactSet(successorInput(history));
    let settled = false;
    void producing.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await slowStageStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);

    slowStage.resolve(undefined);
    await expect(producing).rejects.toMatchObject({
      code: 'catalog-successor-producer-bundle-stage',
    });
    expect(slowStageFinished).toBe(true);
    expect(stageKaBundle).toHaveBeenCalledTimes(2);
    expect(stageVerifiedObjects).not.toHaveBeenCalled();
  });
});

async function oneRowHistory(
  stageKaBundle: (input: BundleStageInput) => Promise<unknown>,
) {
  const authorization = await directCatalogAuthorization();
  const genesis = await produceEmptyAuthorCatalogGenesisV1({
    scope: catalogScope(),
    catalogIssuerDelegationDigest: authorization.catalogIssuerDelegation.objectDigest,
    issuedAt: '1773900000000' as never,
    signer: catalogSigner(),
  });
  const firstSeal = await authorSeal(7n);
  const secondSeal = await authorSeal(8n);
  const firstProducer = new Rfc64PublicCatalogSuccessorProducerV1({
    controlObjects: durableControlObjects(),
    stageKaBundle: stageKaBundle as never,
  });
  const first = await firstProducer.produceAndStageExactSet({
    previousHead: genesis.head,
    previousDirectoryPath: genesis.directoryPath,
    previousBucket: null,
    assets: [{
      assertionCoordinate: 'gate-1-object' as never,
      projectionBytes: PROJECTION,
      seal: firstSeal,
    }],
    deployment: DEPLOYMENT,
    issuedAt: '1773900001000' as never,
    catalogSigner: catalogSigner(),
    catalogIssuerAuthorization: authorization,
  });
  return Object.freeze({ authorization, first, firstSeal, secondSeal });
}

function successorInput(history: Awaited<ReturnType<typeof oneRowHistory>>) {
  return {
    previousHead: history.first.publication.head,
    previousDirectoryPath: history.first.publication.directoryPath,
    previousBucket: history.first.publication.bucket,
    assets: [{
      assertionCoordinate: 'gate-1-object' as never,
      projectionBytes: PROJECTION,
      seal: history.firstSeal,
    }, {
      assertionCoordinate: 'gate-2-object' as never,
      projectionBytes: PROJECTION,
      seal: history.secondSeal,
    }],
    deployment: DEPLOYMENT,
    issuedAt: '1773900002000' as never,
    catalogSigner: catalogSigner(),
    catalogIssuerAuthorization: history.authorization,
  } as const;
}

function catalogScope(): AuthorCatalogScopeV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  } as AuthorCatalogScopeV1;
}

async function directCatalogAuthorization() {
  const produced = await produceDirectAuthorCatalogIssuerDelegationV1({
    scope: catalogScope(),
    signer: catalogSigner(),
    effectiveAt: '1773899999000' as never,
    expiresAt: '1774000000000' as never,
    catalogHeadIssuedAt: '1773900000000' as never,
  });
  return produced.authorization;
}

function durableControlObjects() {
  return {
    stageVerifiedObjects: async () => Object.freeze({
      durable: true as const,
      namespaceDurability: 'test-exact-durable' as never,
      objects: Object.freeze([]),
    }),
  } as never;
}

function durableBundleReceipt(input: BundleStageInput) {
  return Promise.resolve(Object.freeze({
    durable: true as const,
    blobDigest: input.blobDigest,
    byteLength: input.bundleBytes.byteLength,
  }));
}

function catalogSigner() {
  return {
    issuer: AUTHOR,
    signDigest: async (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
  };
}

async function authorSeal(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
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
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
