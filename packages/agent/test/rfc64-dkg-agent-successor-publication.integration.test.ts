import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
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
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/dkg-agent.js';
import { produceDirectAuthorCatalogIssuerDelegationV1 } from '../src/rfc64/public-catalog-issuer-delegation-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'66'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/dkg-successor-api' as ContextGraphIdV1;
const OTHER_CONTEXT_GRAPH_ID = `${CONTEXT_GRAPH_ID}-other` as ContextGraphIdV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const KA_NUMBER = 7n;
const KA_ID = ((BigInt(AUTHOR) << 96n) | KA_NUMBER).toString();
const KA_UAL = `did:dkg:${NETWORK_ID}/${AUTHOR}/${KA_NUMBER}`;
const SECOND_KA_NUMBER = 8n;
const THIRD_KA_NUMBER = 9n;
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);
const GENESIS_ISSUED_AT = '1773900000000' as TimestampMsV1;
const SUCCESSOR_ISSUED_AT = '1773900001000' as TimestampMsV1;
const DELEGATION_EFFECTIVE_AT = '1773899999000' as TimestampMsV1;
const DELEGATION_EXPIRES_AT = '1774000000000' as TimestampMsV1;
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

const agents: DKGAgent[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best-effort cleanup */ }
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('RFC-64 DKGAgent public/open successor publication', () => {
  it('produces deterministic exact evidence and durably reads the head and bundle after restart', async () => {
    const firstDir = await createDataDir('first');
    const secondDir = await createDataDir('second');
    const first = await startAgent('successor-first', firstDir);
    const second = await startAgent('successor-second', secondDir);
    const seal = await authorSeal();

    const firstGenesis = await publishGenesis(first);
    const secondGenesis = await publishGenesis(second);
    const firstResult = await first.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: firstGenesis.headObjectDigest,
        signatureVariantDigest: firstGenesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: firstGenesis.catalogIssuerAuthorization,
      assertionCoordinate: 'gate-1-object' as never,
      projectionBytes: PROJECTION,
      seal,
      deployment: DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [],
    });
    const secondResult = await second.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: secondGenesis.headObjectDigest,
        signatureVariantDigest: secondGenesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: secondGenesis.catalogIssuerAuthorization,
      assertionCoordinate: 'gate-1-object' as never,
      projectionBytes: PROJECTION,
      seal,
      deployment: DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [],
    });

    expect(firstResult).toMatchObject({
      announcement: {
        catalogVersion: '1',
        catalogHeadObjectDigest: firstResult.headObjectDigest,
        signatureVariantDigest: firstResult.signatureVariantDigest,
      },
      contentByteLength: PROJECTION.byteLength.toString(),
      kaUal: KA_UAL,
      inventoryRowCount: '1',
      announcedPeers: [],
      failedPeers: [],
    });
    expect(BigInt(firstResult.bundleByteLength)).toBeGreaterThan(BigInt(firstResult.contentByteLength));
    expect(exactEvidence(secondResult)).toEqual(exactEvidence(firstResult));
    expect(await first.readRfc64StagedAuthorCatalogHeadV1({
      objectDigest: firstResult.headObjectDigest,
      signatureVariantDigest: firstResult.signatureVariantDigest,
    })).toBe(firstResult.headObjectDigest);
    const stagedBundle = await first.readRfc64StagedKaBundleV1(firstResult.bundleDigest);
    expect(stagedBundle).not.toBeNull();
    expect(decodeOpaqueKaBundleV1(stagedBundle!).projectionBytes).toEqual(PROJECTION);

    await first.stop();
    const reopened = await startAgent('successor-reopened', firstDir);
    expect(await reopened.readRfc64StagedAuthorCatalogHeadV1({
      objectDigest: firstResult.headObjectDigest,
      signatureVariantDigest: firstResult.signatureVariantDigest,
    })).toBe(firstResult.headObjectDigest);
    const reopenedBundle = await reopened.readRfc64StagedKaBundleV1(firstResult.bundleDigest);
    expect(reopenedBundle).toEqual(stagedBundle);
    expect(reopenedBundle).not.toBe(stagedBundle);
  }, 60_000);

  it('reloads multi-row durable history and grows a canonical exact set one KA at a time', async () => {
    const dataDir = await createDataDir('multi-row-history');
    const agent = await startAgent('successor-multi-row-history', dataDir);
    const genesis = await publishGenesis(agent);
    const firstSeal = await authorSeal();
    const secondSeal = await authorSeal(SECOND_KA_NUMBER);
    const thirdSeal = await authorSeal(THIRD_KA_NUMBER);
    const firstAsset = {
      assertionCoordinate: 'gate-1-object' as never,
      projectionBytes: PROJECTION,
      seal: firstSeal,
    };
    const secondAsset = {
      assertionCoordinate: 'gate-2-object' as never,
      projectionBytes: PROJECTION,
      seal: secondSeal,
    };
    const thirdAsset = {
      assertionCoordinate: 'gate-2-object-3' as never,
      projectionBytes: PROJECTION,
      seal: thirdSeal,
    };
    const first = await agent.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      ...firstAsset,
      deployment: DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [],
    });
    const second = await agent.publishOpenAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: first.headObjectDigest,
        signatureVariantDigest: first.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [secondAsset, firstAsset],
      deployment: DEPLOYMENT,
      issuedAt: '1773900002000' as TimestampMsV1,
      peers: [],
    });
    const third = await agent.publishOpenAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: second.headObjectDigest,
        signatureVariantDigest: second.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [thirdAsset, firstAsset, secondAsset],
      deployment: DEPLOYMENT,
      issuedAt: '1773900003000' as TimestampMsV1,
      peers: [],
    });

    const expectedKaIds = [KA_NUMBER, SECOND_KA_NUMBER, THIRD_KA_NUMBER]
      .map((number) => ((BigInt(AUTHOR) << 96n) | number).toString());
    expect(second.announcement.catalogVersion).toBe('2');
    expect(second.inventoryRowCount).toBe('2');
    expect(third.announcement.catalogVersion).toBe('3');
    expect(third.inventoryRowCount).toBe('3');
    expect(third.assets.map(({ kaId }) => kaId)).toEqual(expectedKaIds);
    expect(third.assets.map(({ kaUal }) => kaUal)).toEqual(
      [KA_NUMBER, SECOND_KA_NUMBER, THIRD_KA_NUMBER]
        .map((number) => `did:dkg:${NETWORK_ID}/${AUTHOR}/${number}`),
    );
    expect(await agent.readRfc64StagedAuthorCatalogHeadV1({
      objectDigest: third.headObjectDigest,
      signatureVariantDigest: third.signatureVariantDigest,
    })).toBe(third.headObjectDigest);
    for (const asset of third.assets) {
      const staged = await agent.readRfc64StagedKaBundleV1(asset.bundleDigest);
      expect(staged).not.toBeNull();
      expect(decodeOpaqueKaBundleV1(staged!).projectionBytes).toEqual(PROJECTION);
    }
  }, 60_000);

  it('rejects a mismatched signed authorization before signing or durable staging', async () => {
    const dataDir = await createDataDir('mismatched-auth');
    const agent = await startAgent('successor-mismatched-auth', dataDir);
    const signMessage = vi.fn((digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest));
    const author = { address: AUTHOR_WALLET.address, signMessage };
    const genesis = await agent.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author,
      peers: [],
      issuedAt: GENESIS_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    const otherAuthorization = await directAuthorization(OTHER_CONTEXT_GRAPH_ID);
    signMessage.mockClear();
    const filesBefore = await recursiveFiles(dataDir);

    await expect(agent.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author,
      catalogIssuerAuthorization: otherAuthorization,
      assertionCoordinate: 'gate-1-object' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(),
      deployment: DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [],
    })).rejects.toThrow(/authorization does not match the predecessor delegation digest/);

    expect(signMessage).not.toHaveBeenCalled();
    expect(await recursiveFiles(dataDir)).toEqual(filesBefore);
    expect(await agent.readRfc64StagedAuthorCatalogHeadV1({
      objectDigest: genesis.headObjectDigest,
      signatureVariantDigest: genesis.signatureVariantDigest,
    })).toBe(genesis.headObjectDigest);
  }, 60_000);
});

async function createDataDir(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dkg-rfc64-${label}-`));
  tempDirs.push(path);
  return path;
}

async function startAgent(name: string, dataDir: string): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

function publishGenesis(agent: DKGAgent) {
  return agent.publishOpenAuthorCatalogGenesisV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    author: AUTHOR_WALLET,
    peers: [],
    issuedAt: GENESIS_ISSUED_AT,
    catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
    catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
  });
}

function exactEvidence(result: Awaited<ReturnType<DKGAgent['publishOpenAuthorCatalogSuccessorV1']>>) {
  return {
    announcement: result.announcement,
    headObjectDigest: result.headObjectDigest,
    signatureVariantDigest: result.signatureVariantDigest,
    catalogRowDigest: result.catalogRowDigest,
    bundleDigest: result.bundleDigest,
    contentDigest: result.contentDigest,
    contentByteLength: result.contentByteLength,
    bundleByteLength: result.bundleByteLength,
    kaUal: result.kaUal,
    inventoryRowCount: result.inventoryRowCount,
  };
}

async function directAuthorization(contextGraphId: ContextGraphIdV1) {
  const produced = await produceDirectAuthorCatalogIssuerDelegationV1({
    scope: {
      networkId: NETWORK_ID,
      contextGraphId,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as AuthorCatalogScopeV1,
    signer: {
      issuer: AUTHOR,
      signDigest: (digest) => AUTHOR_WALLET.signMessage(digest),
    },
    effectiveAt: DELEGATION_EFFECTIVE_AT,
    expiresAt: DELEGATION_EXPIRES_AT,
    catalogHeadIssuedAt: GENESIS_ISSUED_AT,
  });
  return produced.authorization;
}

async function authorSeal(kaNumber = KA_NUMBER): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const kaUal = `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`;
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
    kaUal,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

async function recursiveFiles(root: string): Promise<readonly string[]> {
  return Object.freeze((await readdir(root, { recursive: true })).sort());
}
