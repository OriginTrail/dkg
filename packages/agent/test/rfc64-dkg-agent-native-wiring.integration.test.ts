import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MemoryLayer,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  contextGraphLayerUri,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
  type NetworkIdV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/dkg-agent.js';
import {
  snapshotRfc64CatalogAccessPolicyAuthorityV1,
  snapshotRfc64CatalogDeploymentProfileV1,
} from '../src/dkg-agent-rfc64-catalog.js';
import type {
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
  Rfc64CatalogAccessPolicyAuthorityConfigV1,
} from '../src/dkg-agent-types.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
} from '../../chain/test/loopback-rpc-harness.js';
import {
  FinalizedVmLoopbackMockChainAdapterV1,
  createFinalizedVmLoopbackRpcV1,
  type FinalizedVmLoopbackFixtureConfigV1,
} from './support/rfc64-finalized-vm-loopback-fixture.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-wiring' as ContextGraphIdV1;
const FIXED_HEAD_ISSUED_AT = '1773900000000' as TimestampMsV1;
const DELEGATION_EFFECTIVE_AT = '1773899999999' as TimestampMsV1;
const DELEGATION_EXPIRES_AT = '1773900000001' as TimestampMsV1;
const MULTI_DELEGATION_EXPIRES_AT = '1774000000000' as TimestampMsV1;
const SUCCESSOR_ISSUED_AT = '1773900001000' as TimestampMsV1;
const SECOND_SUCCESSOR_ISSUED_AT = '1773900002000' as TimestampMsV1;
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const KA_STORAGE = '0x5555555555555555555555555555555555555555' as EvmAddressV1;
const CONTEXT_GRAPH_STORAGE =
  '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const ON_CHAIN_CONTEXT_GRAPH_ID = '14';
const FINALIZED_BLOCK_HASH = `0x${'77'.repeat(32)}` as Digest32V1;
const FINALIZED_POLICY_DIGEST = `0x${'cd'.repeat(32)}` as Digest32V1;
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
);
const NATIVE_DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

const agents: DKGAgent[] = [];
const tempDirs: string[] = [];
const rpcHarness = createLoopbackJsonRpcTestHarness();

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best-effort */ }
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  await rpcHarness.stopAll();
});

async function startNativeAgent(
  name: string,
  deployment: CatalogSealDeploymentProfileV1 = NATIVE_DEPLOYMENT,
  existingDataDir?: string,
  accessPolicyAuthority?: Rfc64CatalogAccessPolicyAuthorityConfigV1,
  finalizedRuntime?: Readonly<{
    rpcUrl: string;
    chainAdapter: FinalizedVmLoopbackMockChainAdapterV1;
    initialSubscription?: ContextGraphIdV1;
  }>,
): Promise<DKGAgent> {
  const dataDir = existingDataDir
    ?? await mkdtemp(join(tmpdir(), `dkg-rfc64-native-${name}-`));
  if (existingDataDir === undefined) tempDirs.push(dataDir);
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
    rfc64CatalogDeploymentProfile: deployment,
    rfc64CatalogAccessPolicyAuthority: accessPolicyAuthority,
    ...(finalizedRuntime === undefined ? {} : {
      chainAdapter: finalizedRuntime.chainAdapter,
      chainConfig: {
        rpcUrl: finalizedRuntime.rpcUrl,
        hubAddress: CONTEXT_GRAPH_STORAGE,
        operationalKeys: [`0x${'12'.repeat(32)}`],
      },
      ...(finalizedRuntime.initialSubscription === undefined ? {} : {
        contextGraphSubscriptionStore: seededSubscriptionStore(
          finalizedRuntime.initialSubscription,
        ),
      }),
    }),
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

function seededSubscriptionStore(contextGraphId: string): ContextGraphSubscriptionStore {
  const records = new Map<string, ContextGraphSubscriptionRecord>([[contextGraphId, {
    id: contextGraphId,
    subscribed: true,
    synced: false,
    syncScoped: true,
  }]]);
  return {
    loadAll: async () => [...records.values()].map((record) => ({ ...record })),
    load: async (id) => {
      const record = records.get(id);
      return record === undefined ? null : { ...record };
    },
    save: async (record) => { records.set(record.id, { ...record }); },
    delete: async (id) => { records.delete(id); },
  };
}

function tcpMultiaddr(agent: DKGAgent): string {
  const address = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('agent has no TCP multiaddr');
  return address;
}

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  await a.node.libp2p.dial(multiaddr(tcpMultiaddr(b)));
  await b.node.libp2p.dial(multiaddr(tcpMultiaddr(a)));
}

function catalogScopeDigest() {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    era: '0' as never,
    bucketCount: '1' as never,
  });
}

function privateCatalogPolicy(): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: '7',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 1,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'owner-signed-unregistered',
      ownerAddress: AUTHOR,
      ownerAuthorityEra: '0',
    },
    effectiveAt: '0',
    issuedAt: '0',
  };
}

function finalizedPublicCatalogPolicy(): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: CONTEXT_GRAPH_STORAGE,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'finalized-chain',
      chainId: '20430',
      contractAddress: CONTEXT_GRAPH_STORAGE,
      blockNumber: '120',
      blockHash: `0x${'76'.repeat(32)}`,
    },
    effectiveAt: '1773900000000',
    issuedAt: '1773900000000',
  };
}

function privateCatalogRoster(
  policy: ContextGraphPolicyV1,
  policyDigest: Digest32V1,
): MemberRosterV1 {
  return {
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    era: policy.era,
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: policy.administrativeDelegationDigest,
    members: [{ agentAddress: AUTHOR, roles: ['holder', 'provider'] }],
    issuedAt: '0',
  };
}

describe('RFC-64 DKGAgent production native catalog wiring', () => {
  it('snapshots and canonicalizes the deterministic local deployment override', () => {
    const callerOwned = {
      networkId: NETWORK_ID,
      assertedAtChainId: '20430',
      assertedAtKav10Address: ethers.getAddress(
        '0x4444444444444444444444444444444444444444',
      ),
    } as CatalogSealDeploymentProfileV1;
    const snapshot = snapshotRfc64CatalogDeploymentProfileV1(callerOwned)!;
    (callerOwned as { networkId: NetworkIdV1 }).networkId = 'hostile:1' as NetworkIdV1;
    expect(snapshot).toEqual(NATIVE_DEPLOYMENT);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshotRfc64CatalogDeploymentProfileV1({
      ...NATIVE_DEPLOYMENT,
      assertedAtKav10Address: `0x${'00'.repeat(20)}` as never,
    })).toThrow(/non-zero EVM address/);
  });

  it('snapshots the explicit access authority and fails closed before private activation', async () => {
    const resolver = async () => AUTHOR;
    const callerOwned = {
      localAgentAddress: ethers.getAddress(AUTHOR) as EvmAddressV1,
      resolveRemoteAgentAddress: resolver,
    };
    const snapshot = snapshotRfc64CatalogAccessPolicyAuthorityV1(callerOwned)!;
    callerOwned.localAgentAddress = ethers.ZeroAddress as EvmAddressV1;
    expect(snapshot).toEqual({
      localAgentAddress: AUTHOR,
      resolveRemoteAgentAddress: resolver,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshotRfc64CatalogAccessPolicyAuthorityV1({
      localAgentAddress: ethers.ZeroAddress as EvmAddressV1,
      resolveRemoteAgentAddress: resolver,
    })).toThrow(/localAgentAddress is invalid/);

    const policy = privateCatalogPolicy();
    const policyDigest = `0x${'ab'.repeat(32)}` as Digest32V1;
    const roster = privateCatalogRoster(policy, policyDigest);
    const legacyOpenOnly = await startNativeAgent('private-denied');
    expect(() => legacyOpenOnly.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster,
    })).toThrow(/requires explicit access-policy authority/);

    const configured = await startNativeAgent(
      'private-configured',
      NATIVE_DEPLOYMENT,
      undefined,
      {
        localAgentAddress: AUTHOR,
        resolveRemoteAgentAddress: resolver,
      },
    );
    expect(configured.acceptRfc64CatalogAccessSnapshotV1({
      policy,
      policyDigest,
      roster,
    })).toMatchObject({ policyDigest, roster: { policyDigest } });

    const privateGenesis = {
      scope: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: 'service-lane',
        authorAddress: AUTHOR,
        era: '0',
        bucketCount: '1',
      },
      author: AUTHOR_WALLET,
      peers: [],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    } as const;
    await expect(configured.publishAuthorCatalogGenesisV1({
      ...privateGenesis,
      peers: ['12D3KooPrivateReceiver'],
    })).rejects.toThrow(/private catalog peer fan-out requires scope-bound/u);
    const published = await configured.publishAuthorCatalogGenesisV1(privateGenesis);
    expect(published.announcement).toMatchObject({
      policyDigest,
      subGraphName: 'service-lane',
      catalogEra: '0',
    });

    const privateSuccessor = {
      previousHead: {
        objectDigest: published.headObjectDigest,
        signatureVariantDigest: published.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: published.catalogIssuerAuthorization,
      assets: [{
        assertionCoordinate: 'private-subgraph-object' as never,
        projectionBytes: PROJECTION,
        seal: await authorSeal(7n),
      }],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [],
    } as const;
    await expect(configured.publishOpenAuthorCatalogExactSetSuccessorV1(privateSuccessor))
      .rejects.toThrow(/public\/open compatibility successor requires the root lane/u);
    await expect(configured.publishAuthorCatalogExactSetSuccessorV1({
      ...privateSuccessor,
      peers: ['12D3KooPrivateReceiver'],
    })).rejects.toThrow(/private catalog peer fan-out requires scope-bound/u);
    const successor = await configured.publishAuthorCatalogExactSetSuccessorV1(privateSuccessor);
    expect(successor).toMatchObject({
      announcement: {
        policyDigest,
        subGraphName: 'service-lane',
        catalogEra: '0',
      },
      catalogScope: {
        subGraphName: 'service-lane',
        era: '0',
      },
      inventoryRowCount: '1',
    });
  }, 60_000);

  it('uses the trusted override to fetch provider content and durably apply native genesis', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('author'),
      startNativeAgent('receiver'),
    ]);
    const receiverPolicy = receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, receiver);

    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    expect(published.announcement.policyDigest).toBe(receiverPolicy.policyDigest);
    expect(published.announcedPeers).toEqual([]);
    const delivery = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [receiver.peerId],
    });
    expect(delivery.announcedPeers).toEqual([receiver.peerId]);
    expect(delivery.failedPeers).toEqual([]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const scopeDigest = catalogScopeDigest();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })).toMatchObject({
      catalogScopeDigest: scopeDigest,
      currentCatalogHeadDigest: published.headObjectDigest,
      catalogVersion: '0',
      inventoryRowCount: '0',
    });
    expect(receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toMatchObject({
      catalogHeadDigest: published.headObjectDigest,
      inventoryRowCount: 0,
      activatedTripleCount: 0,
      stagedObjectCount: 3,
      appliedHeadStatus: 'applied',
    });
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      stagedOnly: 0,
      failed: 0,
    });

    const replay = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [receiver.peerId],
    });
    expect(replay.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      dedupedAlreadyApplied: 1,
    });
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
  }, 60_000);

  it('reads the exact staged head variant to dedupe a durably applied multi-row set', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('multi-author'),
      startNativeAgent('multi-receiver'),
    ]);
    receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await connectBothWays(author, receiver);

    const genesis = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const firstAsset = {
      assertionCoordinate: 'gate-2-object-1' as never,
      projectionBytes: PROJECTION,
      seal: await authorSeal(7n),
    };
    const firstSuccessor = await author.publishOpenAuthorCatalogSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      ...firstAsset,
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [receiver.peerId],
    });
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const successor = await author.publishAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: firstSuccessor.headObjectDigest,
        signatureVariantDigest: firstSuccessor.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [
        {
          assertionCoordinate: 'gate-2-object-2' as never,
          projectionBytes: PROJECTION,
          seal: await authorSeal(8n),
        },
        firstAsset,
      ],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SECOND_SUCCESSOR_ISSUED_AT,
      peers: [receiver.peerId],
    });
    expect(successor.inventoryRowCount).toBe('2');
    expect(successor.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const evidence = receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      successor.headObjectDigest,
    );
    expect(evidence).toMatchObject({
      catalogHeadDigest: successor.headObjectDigest,
      inventoryRowCount: 2,
      appliedHeadStatus: 'applied',
    });
    expect(evidence?.rows.map(({ kaId, bundleDigest }) => ({ kaId, bundleDigest }))).toEqual(
      successor.assets.map(({ kaId, bundleDigest }) => ({ kaId, bundleDigest })),
    );
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 3,
      dedupedAlreadyApplied: 0,
    });

    const replay = await author.announceRfc64PublicCatalogHeadV1({
      announcement: successor.announcement,
      peers: [receiver.peerId],
    });
    expect(replay.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 3,
      dedupedAlreadyApplied: 1,
    });
  }, 60_000);

  it('materializes finalized VM through production two-agent wiring before applying the head', async () => {
    const kaNumber = 7n;
    const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase();
    const fixture = Object.freeze({
      accessPolicy: 0,
      active: true,
      assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
      assertedAtKav10Address: KAV10,
      knowledgeAssetStorageAddress: KA_STORAGE,
      assets: Object.freeze([Object.freeze({
        assertionRoot: ASSERTION_ROOT,
        assertionVersion: '1',
        authorAddress: AUTHOR,
        kaId,
        publisherAddress: `0x${'66'.repeat(20)}` as EvmAddressV1,
      })]),
      blockHash: FINALIZED_BLOCK_HASH,
      blockNumberQuantity: '0x7b',
      contextGraphStorageAddress: CONTEXT_GRAPH_STORAGE,
      nameHash: nameHash as Digest32V1,
      networkId: NETWORK_ID,
      onChainContextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
      publishPolicy: 1,
    } satisfies FinalizedVmLoopbackFixtureConfigV1);
    const finalizedRpc = createFinalizedVmLoopbackRpcV1(fixture);
    const contextGraphInterface = new ethers.Interface([
      'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
    ]);
    expect(() => finalizedRpc.respond('eth_call', [{
      to: KAV10,
      data: contextGraphInterface.encodeFunctionData(
        'getNameHash',
        [BigInt(ON_CHAIN_CONTEXT_GRAPH_ID)],
      ),
    }, 'finalized'])).toThrow('context graph target');
    const callsBeforeRuntime = finalizedRpc.calls.length;
    const rpc = await rpcHarness.start((call, response) => {
      try {
        sendJsonRpcResult(response, call, finalizedRpc.respond(call.method, call.params));
      } catch (cause) {
        sendJsonRpcError(
          response,
          call,
          -32602,
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    });
    const authorChain = new FinalizedVmLoopbackMockChainAdapterV1(fixture);
    const receiverChain = new FinalizedVmLoopbackMockChainAdapterV1(fixture);
    const created = await receiverChain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash,
    });
    expect(created.contextGraphId.toString()).toBe(ON_CHAIN_CONTEXT_GRAPH_ID);
    const [author, receiver] = await Promise.all([
      startNativeAgent(
        'vm-author',
        NATIVE_DEPLOYMENT,
        undefined,
        undefined,
        { rpcUrl: rpc.url, chainAdapter: authorChain },
      ),
      startNativeAgent(
        'vm-receiver',
        NATIVE_DEPLOYMENT,
        undefined,
        undefined,
        {
          rpcUrl: rpc.url,
          chainAdapter: receiverChain,
          initialSubscription: CONTEXT_GRAPH_ID,
        },
      ),
    ]);
    const policy = finalizedPublicCatalogPolicy();
    for (const agent of [author, receiver]) {
      agent.acceptRfc64CatalogAccessSnapshotV1({
        policy,
        policyDigest: FINALIZED_POLICY_DIGEST,
        roster: null,
      });
    }
    await receiver.awaitInitialChainPoll();
    const storeQuery = vi.spyOn((receiver as any).store, 'query');
    await expect(receiver.getContextGraphOnChainId(CONTEXT_GRAPH_ID)).resolves.toBe(
      ON_CHAIN_CONTEXT_GRAPH_ID,
    );
    await expect(receiver.getContextGraphOnChainId(nameHash)).resolves.toBe(
      ON_CHAIN_CONTEXT_GRAPH_ID,
    );
    expect(storeQuery.mock.calls.some(([query]) => String(query).includes('OnChainId'))).toBe(false);
    storeQuery.mockRestore();
    await connectBothWays(author, receiver);

    const scope = {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: CONTEXT_GRAPH_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as const;
    const genesis = await author.publishAuthorCatalogGenesisV1({
      scope,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: MULTI_DELEGATION_EXPIRES_AT,
    });
    expect(genesis.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    const successor = await author.publishAuthorCatalogExactSetSuccessorV1({
      previousHead: {
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      },
      author: AUTHOR_WALLET,
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [{
        assertionCoordinate: 'finalized-vm-production-wire' as never,
        projectionBytes: PROJECTION,
        seal: await authorSeal(kaNumber),
      }],
      deployment: NATIVE_DEPLOYMENT,
      issuedAt: SUCCESSOR_ISSUED_AT,
      peers: [receiver.peerId],
    });
    expect(successor.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const vmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      AUTHOR,
      Number(kaNumber),
    );
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      successor.headObjectDigest,
    )).toBeNull();
    await expect((receiver as any).store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${vmGraph}> { ?s ?p ?o } }`,
    )).resolves.toMatchObject({
      type: 'bindings',
      bindings: expect.arrayContaining([
        expect.objectContaining({ s: 'https://example.org/alice' }),
      ]),
    });
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
      authorAddress: AUTHOR,
    })).toMatchObject({
      currentCatalogHeadDigest: successor.headObjectDigest,
      inventoryRowCount: '1',
    });
    const finalizedCallTargets = finalizedRpc.calls.slice(callsBeforeRuntime)
      .filter(({ method }) => method === 'eth_call')
      .map(({ params }) => (params[0] as { readonly to?: string }).to?.toLowerCase());
    expect(finalizedCallTargets).toContain(CONTEXT_GRAPH_STORAGE);
    expect(finalizedCallTargets).toContain(KA_STORAGE);
    expect(finalizedCallTargets).not.toContain(KAV10);
  }, 60_000);

  it('exposes bounded typed failure evidence when wire scope differs from local deployment', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('mismatch-author'),
      startNativeAgent('mismatch-receiver', {
        ...NATIVE_DEPLOYMENT,
        networkId: 'base:8453' as NetworkIdV1,
      }),
    ]);
    receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, receiver);
    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    expect(published.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })).toBeNull();
    expect(receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 0,
      failed: 1,
    });
    const failure = receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    );
    expect(failure).toEqual({
      catalogHeadDigest: published.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-authorization',
    });
    expect(Object.isFrozen(failure)).toBe(true);

    await receiver.stop();
    agents.splice(agents.indexOf(receiver), 1);
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
  }, 60_000);

  it('rejects a stale-network durable dedupe after restart under a new local pin', async () => {
    const receiverDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-native-repin-'));
    tempDirs.push(receiverDataDir);
    const [author, firstReceiver] = await Promise.all([
      startNativeAgent('repin-author'),
      startNativeAgent('repin-receiver', NATIVE_DEPLOYMENT, receiverDataDir),
    ]);
    firstReceiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, firstReceiver);
    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [firstReceiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    await firstReceiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(firstReceiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })?.currentCatalogHeadDigest).toBe(published.headObjectDigest);

    await firstReceiver.stop();
    agents.splice(agents.indexOf(firstReceiver), 1);
    const restartedReceiver = await startNativeAgent('repin-receiver', {
      ...NATIVE_DEPLOYMENT,
      networkId: 'base:8453' as NetworkIdV1,
    }, receiverDataDir);
    restartedReceiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, restartedReceiver);
    const delivery = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [restartedReceiver.peerId],
    });
    expect(delivery.announcedPeers).toEqual([restartedReceiver.peerId]);
    await restartedReceiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(restartedReceiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 0,
      dedupedAlreadyApplied: 0,
      failed: 1,
    });
    expect(restartedReceiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(restartedReceiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toEqual({
      catalogHeadDigest: published.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-authorization',
    });
  }, 60_000);
});

async function authorSeal(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const kaUal = `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(NATIVE_DEPLOYMENT.assertedAtChainId),
    kav10Address: NATIVE_DEPLOYMENT.assertedAtKav10Address,
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
    assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
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
