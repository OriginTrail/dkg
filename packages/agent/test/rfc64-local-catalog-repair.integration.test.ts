import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  computeNetworkId,
  computeSwmAuthorInventoryScopeDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createOperationContext,
  type AssertionSeal,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import type {
  Rfc64PublicCatalogActivationInputV1,
} from '../src/rfc64/public-catalog-activation-config-v1.js';
import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '../src/rfc64/open-catalog-policy-v1.js';
import type {
  Rfc64PublicCatalogAutoPublishConfigV1,
  Rfc64PublicCatalogBootstrapConfigV1,
} from '../src/dkg-agent-types.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-wiring' as ContextGraphIdV1;
const LEGACY_CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/legacy-repair' as ContextGraphIdV1;
const REMOTE_AUTHOR =
  '0x9999999999999999999999999999999999999999' as EvmAddressV1;
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const NATIVE_DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;
const PROJECTION_QUADS: readonly Quad[] = Object.freeze([
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
]);

const agents: DKGAgent[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best effort */ }
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

interface StartRepairAgentOptionsV1 {
  readonly name: string;
  readonly dataDir?: string;
  readonly storePath?: string;
  readonly autoPublish?: Rfc64PublicCatalogAutoPublishConfigV1;
  readonly bootstrap?: Rfc64PublicCatalogBootstrapConfigV1;
  readonly activation?: Rfc64PublicCatalogActivationInputV1;
  readonly beforeStart?: (agent: DKGAgent) => void | Promise<void>;
}

async function startRepairAgentV1(options: StartRepairAgentOptionsV1): Promise<DKGAgent> {
  const dataDir = options.dataDir
    ?? await mkdtemp(join(tmpdir(), `dkg-rfc64-repair-${options.name}-`));
  if (options.dataDir === undefined) tempDirs.push(dataDir);
  const agent = await DKGAgent.create({
    name: options.name,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(options.storePath),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
    syncContextGraphs: options.activation !== undefined && options.activation.enabled !== false
      ? options.activation.bootstrap?.acceptedPublicPolicies.map(
        ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId,
      ) ?? []
      : [],
    ...(options.activation === undefined ? {} : {
      networkIdentity: {
        networkId: await computeNetworkId(),
        chainId: NATIVE_DEPLOYMENT.networkId,
      },
    }),
    ...(options.activation === undefined ? {
      rfc64CatalogDeploymentProfile: NATIVE_DEPLOYMENT,
      rfc64PublicCatalogAutoPublish: options.autoPublish,
      rfc64PublicCatalogBootstrap: options.bootstrap,
    } : {
      rfc64PublicCatalogActivation: options.activation,
    }),
  });
  agents.push(agent);
  await options.beforeStart?.(agent);
  await agent.start();
  return agent;
}

function catalogScopeDigestV1(): Digest32V1 {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  });
}

function bootstrapConfigV1(
  retryIntervalMs?: number,
  includeRemoteTarget = true,
): Rfc64PublicCatalogBootstrapConfigV1 {
  const policy = buildOpenOwnerContextGraphPolicyV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
  });
  return {
    acceptedPublicPolicies: [{
      policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
      targets: includeRemoteTarget ? [{
        authorAddress: AUTHOR,
        providers: ['12D3KooWRepairProvider'],
      }] : [],
    }],
    ...(retryIntervalMs === undefined ? {} : { retryIntervalMs }),
  };
}

async function authorSealV1(kaNumber: bigint): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const assertionMerkleRoot = ethers.hexlify(
    computeFlatKCRootV10([...PROJECTION_QUADS], []),
  ) as Digest32V1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(NATIVE_DEPLOYMENT.assertedAtChainId),
    kav10Address: NATIVE_DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: NATIVE_DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: String(PROJECTION_QUADS.length),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function assertionSealV1(seal: CanonicalGraphScopedAuthorSealV1): AssertionSeal {
  return {
    merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
    authorAddress: seal.authorAddress,
    authorAttestationR: ethers.getBytes(seal.authorAttestationR),
    authorAttestationVS: ethers.getBytes(seal.authorAttestationVS),
    authorSchemeVersion: 1,
    chainId: BigInt(seal.assertedAtChainId),
    kav10Address: seal.assertedAtKav10Address,
    reservedKaId: BigInt(seal.reservedKaId),
    finalizedAtIso: seal.assertionFinalizedAt,
    contentScopeVersion: 2,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    publicTripleCount: Number(seal.publicTripleCount),
    privateTripleCount: Number(seal.privateTripleCount),
    rootEntities: [],
  };
}

async function seedInventoryAssetV1(
  agent: DKGAgent,
  suffix: string,
  reservedKaId: bigint,
): Promise<Readonly<{ seal: AssertionSeal; scopeDigest: Digest32V1 }>> {
  const assertionCoordinate = `repair-${suffix}`;
  const shareOperationId = `repair-operation-${suffix}`;
  const canonicalSeal = await authorSealV1(reservedKaId);
  const seal = assertionSealV1(canonicalSeal);
  const assertionUri = contextGraphAssertionUri(
    CONTEXT_GRAPH_ID,
    AUTHOR,
    assertionCoordinate,
  );
  await agent.store.insert(buildAssertionSealQuads({
    assertionUri,
    metaGraph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
    merkleRoot: seal.merkleRoot,
    authorAddress: seal.authorAddress,
    authorAttestationR: seal.authorAttestationR,
    authorAttestationVS: seal.authorAttestationVS,
    authorSchemeVersion: seal.authorSchemeVersion,
    chainId: seal.chainId,
    kav10Address: seal.kav10Address,
    reservedKaId: seal.reservedKaId!,
    finalizedAtIso: seal.finalizedAtIso,
    contentScopeVersion: seal.contentScopeVersion!,
    kaUal: seal.kaUal!,
    assertionVersion: seal.assertionVersion!,
    publicTripleCount: seal.publicTripleCount!,
    privateTripleCount: seal.privateTripleCount!,
  }));
  const graphManager = new GraphManager(agent.store);
  await storeKnowledgeAssetOperationPublicQuads({
    store: agent.store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    shareOperationId,
    kaUal: canonicalSeal.kaUal,
    assertionVersion: canonicalSeal.assertionVersion,
    quads: PROJECTION_QUADS,
    privateTripleCount: 0,
    publisherPeerId: agent.peerId,
    accessPolicy: 'public',
    agentAddress: AUTHOR,
    timestamp: new Date('2026-07-19T12:35:00.000Z'),
  });
  await storeKnowledgeAssetWorkspaceHead({
    store: agent.store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    kaUal: canonicalSeal.kaUal,
    assertionVersion: canonicalSeal.assertionVersion,
    shareOperationId,
  });
  await expect(agent.recordRfc64SwmAuthorInventoryShadowV1({
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate,
    lifecycleAgentAddress: AUTHOR,
    shareOperationId,
  })).resolves.toMatchObject({ status: 'applied' });
  return Object.freeze({
    seal,
    scopeDigest: computeSwmAuthorInventoryScopeDigestV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
    }),
  });
}

describe('RFC-64 local SWM catalog projection repair', () => {
  it('retries without widening graph or author scope', async () => {
    const policy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const legacyPolicy = buildOpenOwnerContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: LEGACY_CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const inventoryHeadObjectDigest = `0x${'91'.repeat(32)}` as Digest32V1;
    let repairSpy!: ReturnType<typeof vi.spyOn>;
    const agent = await startRepairAgentV1({
      name: 'bounded-retry',
      activation: {
        deploymentProfile: NATIVE_DEPLOYMENT,
        autoPublish: {
          peers: [],
          catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
        },
        rollout: {
          contextGraphModes: {
            [CONTEXT_GRAPH_ID]: 'catalog',
            [LEGACY_CONTEXT_GRAPH_ID]: 'legacy',
          },
        },
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
            targets: [{ authorAddress: AUTHOR, providers: ['local-provider'] }, {
              authorAddress: REMOTE_AUTHOR,
              providers: ['remote-provider'],
            }],
          }, {
            policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(legacyPolicy),
            targets: [{ authorAddress: AUTHOR, providers: ['legacy-provider'] }],
          }],
          retryIntervalMs: 1_000,
        },
      },
      beforeStart: (startingAgent) => {
        vi.spyOn(startingAgent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(startingAgent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
        repairSpy = vi.spyOn(
          startingAgent,
          'reconcileRfc64PublicCatalogFromSwmInventoryV1',
        )
          .mockRejectedValueOnce(new Error('simulated projection failure'))
          .mockResolvedValue({
            status: 'existing',
            appliedHead: {
              catalogScopeDigest: catalogScopeDigestV1(),
              authorAddress: AUTHOR,
              currentCatalogHeadDigest: `0x${'92'.repeat(32)}` as Digest32V1,
              appliedInventoryDigest: `0x${'93'.repeat(32)}` as Digest32V1,
              catalogVersion: '1',
              inventoryRowCount: '1',
            },
            successorsApplied: 0,
            targetAssetCount: 1,
            inventoryHeadObjectDigest,
          });
      },
    });

    await vi.waitFor(() => {
      expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
        .toEqual([expect.objectContaining({
          contextGraphId: CONTEXT_GRAPH_ID,
          authorAddress: AUTHOR,
          outcome: 'reconciled',
          attempts: 2,
          inventoryHeadObjectDigest,
        })]);
    }, { timeout: 10_000, interval: 20 });
    expect(repairSpy.mock.calls.map(([input]) => ({
      contextGraphId: input.contextGraphId,
      authorAddress: input.authorAddress,
    }))).toEqual([
      { contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR },
      { contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR },
    ]);
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs).toHaveLength(1);
  }, 30_000);

  it('coalesces a live mutation burst into one latest-state follow-up pass', async () => {
    const firstInventoryHeadObjectDigest = `0x${'94'.repeat(32)}` as Digest32V1;
    const latestInventoryHeadObjectDigest = `0x${'97'.repeat(32)}` as Digest32V1;
    let markFirstRepairEntered!: () => void;
    let releaseFirstRepair!: () => void;
    const firstRepairEntered = new Promise<void>((resolve) => {
      markFirstRepairEntered = resolve;
    });
    const firstRepairGate = new Promise<void>((resolve) => {
      releaseFirstRepair = resolve;
    });
    let repairSpy!: ReturnType<typeof vi.spyOn>;
    const agent = await startRepairAgentV1({
      name: 'coalesced-live-burst',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
      beforeStart: (startingAgent) => {
        let call = 0;
        repairSpy = vi.spyOn(startingAgent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
          .mockImplementation(async () => {
            call += 1;
            if (call === 1) {
              markFirstRepairEntered();
              await firstRepairGate;
            }
            return {
              status: 'existing' as const,
              appliedHead: {
                catalogScopeDigest: catalogScopeDigestV1(),
                authorAddress: AUTHOR,
                currentCatalogHeadDigest: `0x${'95'.repeat(32)}` as Digest32V1,
                appliedInventoryDigest: `0x${'96'.repeat(32)}` as Digest32V1,
                catalogVersion: String(call),
                inventoryRowCount: String(call),
              },
              successorsApplied: 0,
              targetAssetCount: call,
              inventoryHeadObjectDigest: call === 1
                ? firstInventoryHeadObjectDigest
                : latestInventoryHeadObjectDigest,
            };
          });
      },
    });

    agent.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(true);
    await firstRepairEntered;
    for (let index = 0; index < 16; index += 1) {
      expect(agent.requestRfc64SwmCatalogProjectionV1({
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress: AUTHOR,
      })).toBe(true);
    }
    releaseFirstRepair();
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(repairSpy).toHaveBeenCalledTimes(2);
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()).toEqual(
      expect.objectContaining({
        pass: 2,
        repairs: [expect.objectContaining({
          attempts: 2,
          outcome: 'reconciled',
          inventoryHeadObjectDigest: latestInventoryHeadObjectDigest,
          catalogVersion: '2',
          inventoryRowCount: '2',
        })],
      }),
    );
    await agent.closeRfc64SwmCatalogProjectionSupervisorV1();
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(false);
  }, 30_000);

  it('bounds distinct repair scopes to four concurrent reconciliations', async () => {
    const agent = await startRepairAgentV1({
      name: 'bounded-distinct-repairs',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    vi.spyOn(agent as any, 'resolveRfc64CatalogAuthoringLaneV1').mockReturnValue({} as never);
    let active = 0;
    let maxActive = 0;
    let call = 0;
    let markFirstEntered!: () => void;
    let releaseFirst!: () => void;
    let markFourEntered!: () => void;
    let releaseRepairs!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fourEntered = new Promise<void>((resolve) => { markFourEntered = resolve; });
    const repairGate = new Promise<void>((resolve) => { releaseRepairs = resolve; });
    const reconcile = vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          markFirstEntered();
          await firstGate;
          return null;
        }
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 4) markFourEntered();
        await repairGate;
        active -= 1;
        return null;
      });
    const contextGraphIds = Array.from({ length: 6 }, (_, index) => (
      `0x1111111111111111111111111111111111111111/bounded-${index}` as ContextGraphIdV1
    ));
    for (const contextGraphId of contextGraphIds) {
      expect(agent.requestRfc64SwmCatalogProjectionV1({
        contextGraphId,
        authorAddress: AUTHOR,
      })).toBe(true);
    }
    await firstEntered;
    releaseFirst();
    await fourEntered;
    expect(reconcile).toHaveBeenCalledTimes(5);
    expect(maxActive).toBe(4);
    releaseRepairs();
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(4);
  }, 30_000);

  it('drains an admitted SWM observer before persistence closes and rejects late admission', async () => {
    const autoPublish = {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const agent = await startRepairAgentV1({
      name: 'observer-lifecycle-drain',
      autoPublish,
    });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(
      AUTHOR_WALLET.privateKey,
    );
    agent.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await seedInventoryAssetV1(agent, 'shutdown', 29n);

    const originalRecord = agent.recordRfc64SwmAuthorInventoryShadowV1.bind(agent);
    let markObserverEntered!: () => void;
    let releaseObserver!: () => void;
    const observerEntered = new Promise<void>((resolve) => {
      markObserverEntered = resolve;
    });
    const observerGate = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    const recordSpy = vi.spyOn(agent, 'recordRfc64SwmAuthorInventoryShadowV1')
      .mockImplementation(async (params) => {
        markObserverEntered();
        await observerGate;
        return originalRecord(params);
      });
    let markProjectionEntered!: () => void;
    let releaseProjection!: () => void;
    const projectionEntered = new Promise<void>((resolve) => {
      markProjectionEntered = resolve;
    });
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockImplementation(async () => {
        markProjectionEntered();
        await projectionGate;
        return null;
      });
    const persistenceCloseSpy = vi.spyOn(agent, 'closeRfc64PersistenceV1');
    const schedule = (agent as unknown as {
      scheduleRfc64SwmInventoryObserverV1(params: Readonly<{
        contextGraphId: string;
        assertionCoordinate: string;
        lifecycleAgentAddress: string;
        shareOperationId: string;
        ctx: ReturnType<typeof createOperationContext>;
      }>): void;
    }).scheduleRfc64SwmInventoryObserverV1.bind(agent);
    const observerParams = Object.freeze({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'repair-shutdown',
      lifecycleAgentAddress: AUTHOR,
      shareOperationId: 'repair-operation-shutdown',
      ctx: createOperationContext('share'),
    });

    schedule(observerParams);
    await observerEntered;
    let stopSettled = false;
    const stopping = agent.stop().finally(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(persistenceCloseSpy).not.toHaveBeenCalled();

    releaseObserver();
    await projectionEntered;
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(persistenceCloseSpy).not.toHaveBeenCalled();
    releaseProjection();
    await expect(stopping).resolves.toBeUndefined();
    agents.splice(agents.indexOf(agent), 1);
    expect(recordSpy).toHaveBeenCalledOnce();
    expect(persistenceCloseSpy).toHaveBeenCalledOnce();
    expect(agent.rfc64SwmAuthorInventoryShadowStatusV1()).toMatchObject({
      failed: 0,
      existingUpserts: 1,
    });

    schedule(observerParams);
    await Promise.resolve();
    expect(recordSpy).toHaveBeenCalledOnce();
    expect(agent.inFlightRfc64SwmInventoryObserverCountV1()).toBe(0);
  }, 30_000);

  it('reports missing inventory through the canonical supervisor path', async () => {
    const agent = await startRepairAgentV1({
      name: 'no-inventory',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
      bootstrap: bootstrapConfigV1(),
      beforeStart: (startingAgent) => {
        vi.spyOn(startingAgent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(startingAgent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
      },
    });
    await agent.whenRfc64CatalogSupervisorsIdleV1();
    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
      .toEqual([expect.objectContaining({ outcome: 'no-inventory', attempts: 1 })]);
  });

  it('reports a rejected canonical reconciliation as a failed repair', async () => {
    const agent = await startRepairAgentV1({
      name: 'failed-reconciliation-status',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    agent.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockRejectedValue(new Error('projection unavailable'));

    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(true);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
      .toEqual([expect.objectContaining({
        outcome: 'failed',
        attempts: 1,
        lastError: 'projection unavailable',
      })]);
  });

  it('reopens live-only inventory and projection admission on same-instance restart', async () => {
    const agent = await startRepairAgentV1({
      name: 'same-instance-restart',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    const reconcile = vi.spyOn(agent, 'reconcileRfc64PublicCatalogFromSwmInventoryV1')
      .mockResolvedValue(null);
    const acceptPolicy = (): void => {
      agent.acceptOpenContextGraphPolicyV1({
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        ownerAddress: AUTHOR,
      });
    };
    acceptPolicy();
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(true);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    await agent.stop();
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(false);
    await agent.start();
    acceptPolicy();
    expect(agent.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).toBe(true);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();

    const inventoryDigest = `0x${'a1'.repeat(32)}` as Digest32V1;
    const record = vi.spyOn(agent, 'recordRfc64SwmAuthorInventoryShadowV1')
      .mockResolvedValue({
        status: 'existing',
        action: 'upsert',
        attempts: 1,
        headObjectDigest: inventoryDigest,
        error: null,
      });
    const schedule = (agent as unknown as {
      scheduleRfc64SwmInventoryObserverV1(params: Readonly<{
        contextGraphId: string;
        assertionCoordinate: string;
        lifecycleAgentAddress: string;
        shareOperationId: string;
        ctx: ReturnType<typeof createOperationContext>;
      }>): void;
    }).scheduleRfc64SwmInventoryObserverV1.bind(agent);
    schedule({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'same-instance-share',
      lifecycleAgentAddress: AUTHOR,
      shareOperationId: 'same-instance-operation',
      ctx: createOperationContext('share'),
    });
    await agent.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(record).toHaveBeenCalledOnce();

    const remove = vi.spyOn(agent, 'removeRfc64SwmAuthorInventoryShadowV1')
      .mockResolvedValue({
        status: 'absent',
        action: 'remove',
        attempts: 1,
        headObjectDigest: inventoryDigest,
        error: null,
      });
    const canonicalSeal = await authorSealV1(35n);
    await agent.observeRfc64ConfirmedVmV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: 'same-instance-share',
      seal: assertionSealV1(canonicalSeal),
      assertionUri: contextGraphAssertionUri(
        CONTEXT_GRAPH_ID,
        AUTHOR,
        'same-instance-share',
      ),
      ctx: createOperationContext('publish'),
      publicationLabel: 'publish',
    });
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect(remove).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('does not tear down persistence under a non-cooperative catalog read', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-cancel-repair-'));
    tempDirs.push(dataDir);
    const storePath = join(dataDir, 'oxigraph');
    const autoPublish = {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const author = await startRepairAgentV1({
      name: 'cancel-author',
      dataDir,
      storePath,
      autoPublish,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    await seedInventoryAssetV1(author, 'cancellation', 30n);
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    let markCatalogReadEntered!: () => void;
    let releaseCatalogRead!: () => void;
    const catalogReadEntered = new Promise<void>((resolve) => {
      markCatalogReadEntered = resolve;
    });
    const catalogReadGate = new Promise<void>((resolve) => {
      releaseCatalogRead = resolve;
    });
    const restarted = await startRepairAgentV1({
      name: 'cancel-restarted',
      dataDir,
      storePath,
      autoPublish,
      bootstrap: bootstrapConfigV1(),
      beforeStart: (startingAgent) => {
        vi.spyOn(startingAgent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(startingAgent, 'getCustodialAgentPrivateKey').mockReturnValue(
          AUTHOR_WALLET.privateKey,
        );
        const originalQuery = startingAgent.store.query.bind(startingAgent.store);
        let blockCatalogRead = true;
        vi.spyOn(startingAgent.store, 'query').mockImplementation(
          async (sparql: string, ...args: unknown[]) => {
            const options = args[0] as Readonly<{ source?: string }> | undefined;
            if (
              blockCatalogRead
              && options?.source === 'agent.rfc64.swmInventory.catalogReconcile.seal'
            ) {
              blockCatalogRead = false;
              markCatalogReadEntered();
              await catalogReadGate;
            }
            return originalQuery(sparql, ...args);
          },
        );
      },
    });
    await catalogReadEntered;
    const persistenceClose = vi.spyOn(restarted, 'closeRfc64PersistenceV1');
    let stopped = false;
    const stopping = restarted.stop().finally(() => { stopped = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    expect(persistenceClose).not.toHaveBeenCalled();

    releaseCatalogRead();
    await stopping;
    agents.splice(agents.indexOf(restarted), 1);
    expect(persistenceClose).toHaveBeenCalledOnce();
  }, 30_000);

  it('repairs durable additions and removals without remote author targets', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-restart-repair-'));
    tempDirs.push(dataDir);
    const storePath = join(dataDir, 'oxigraph');
    const autoPublish = {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    };
    const author = await startRepairAgentV1({
      name: 'restart-author',
      dataDir,
      storePath,
      autoPublish,
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    const seeded = await seedInventoryAssetV1(author, 'restart', 31n);
    await author.stop();
    agents.splice(agents.indexOf(author), 1);

    const additionRepair = await startRepairAgentV1({
      name: 'addition-repair',
      dataDir,
      storePath,
      autoPublish,
      bootstrap: bootstrapConfigV1(undefined, false),
      beforeStart: (agent) => {
        vi.spyOn(agent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
        vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(
          AUTHOR_WALLET.privateKey,
        );
      },
    });
    await vi.waitFor(() => {
      expect(additionRepair.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
        .toEqual([expect.objectContaining({
          outcome: 'reconciled',
          catalogVersion: '1',
          inventoryRowCount: '1',
        })]);
    }, { timeout: 10_000, interval: 50 });
    await expect(additionRepair.removeRfc64SwmAuthorInventoryShadowV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      seal: seeded.seal,
    })).resolves.toMatchObject({ status: 'applied' });
    await additionRepair.stop();
    agents.splice(agents.indexOf(additionRepair), 1);

    const removalRepair = await startRepairAgentV1({
      name: 'removal-repair',
      dataDir,
      storePath,
      autoPublish,
      bootstrap: bootstrapConfigV1(undefined, false),
      beforeStart: (agent) => {
        vi.spyOn(agent, 'listLocalAgents').mockReturnValue([
          { agentAddress: AUTHOR } as never,
        ]);
        vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockResolvedValue(null);
        vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(
          AUTHOR_WALLET.privateKey,
        );
      },
    });
    await vi.waitFor(() => {
      expect(removalRepair.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs)
        .toEqual([expect.objectContaining({
          outcome: 'reconciled',
          catalogVersion: '2',
          inventoryRowCount: '0',
        })]);
    }, { timeout: 10_000, interval: 50 });
    expect(removalRepair.readRfc64SwmAuthorInventorySnapshotV1({
      inventoryScopeDigest: seeded.scopeDigest,
      authorAddress: AUTHOR,
    })?.rows).toEqual([]);
  }, 30_000);

  it('linearizes an inventory mutation that races an already-staged successor', async () => {
    const author = await startRepairAgentV1({
      name: 'staged-successor-race',
      autoPublish: {
        peers: [],
        catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      },
    });
    vi.spyOn(author, 'getCustodialAgentPrivateKey').mockReturnValue(
      AUTHOR_WALLET.privateKey,
    );
    author.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR,
    });
    // Keep the test deterministic: ordinary live admission is fenced, while
    // the explicit reconciliation entry point remains available.
    await author.closeRfc64SwmCatalogProjectionSupervisorV1();
    await seedInventoryAssetV1(author, 'race-first', 41n);
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({
      appliedHead: { catalogVersion: '1', inventoryRowCount: '1' },
    });
    await seedInventoryAssetV1(author, 'race-second', 42n);

    const originalPublish = author.publishAuthorCatalogExactSetSuccessorV1.bind(author);
    const authored: Array<Readonly<{
      previousHeadDigest: Digest32V1;
      headObjectDigest: Digest32V1;
      catalogVersion: string;
    }>> = [];
    let injectedLatestInventory = false;
    vi.spyOn(author, 'publishAuthorCatalogExactSetSuccessorV1')
      .mockImplementation(async (params) => {
        const successor = await originalPublish(params);
        authored.push(Object.freeze({
          previousHeadDigest: params.previousHead.objectDigest,
          headObjectDigest: successor.headObjectDigest,
          catalogVersion: successor.announcement.catalogVersion,
        }));
        if (!injectedLatestInventory) {
          injectedLatestInventory = true;
          // This lands after v2 is signed and durably staged, but before its
          // applied-head callback validates the source inventory generation.
          await seedInventoryAssetV1(author, 'race-third', 43n);
        }
        return successor;
      });

    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({
      targetAssetCount: 3,
      appliedHead: { catalogVersion: '3', inventoryRowCount: '3' },
    });
    expect(authored).toHaveLength(2);
    expect(authored.map(({ catalogVersion }) => catalogVersion)).toEqual(['2', '3']);
    // The retry resumes from the committed, already-signed v2. It never signs
    // a competing v2 from the original v1 predecessor.
    expect(authored[1]!.previousHeadDigest).toBe(authored[0]!.headObjectDigest);
    expect(new Set(authored.map(({ previousHeadDigest, catalogVersion }) => (
      `${previousHeadDigest}\n${catalogVersion}`
    ))).size).toBe(2);

    const persistence = (author as unknown as {
      rfc64PersistenceV1?: {
        controlObjects: {
          getVerifiedObjectByDigest(input: {
            objectDigest: Digest32V1;
            verifyIssuerSignature: typeof import('@origintrail-official/dkg-chain')
              .verifyControlEnvelopeIssuerSignatureV1;
          }): Promise<unknown>;
        };
      };
    }).rfc64PersistenceV1;
    expect(persistence).toBeDefined();
    const { verifyControlEnvelopeIssuerSignatureV1 } = await import(
      '@origintrail-official/dkg-chain'
    );
    for (const { headObjectDigest } of authored) {
      await expect(persistence!.controlObjects.getVerifiedObjectByDigest({
        objectDigest: headObjectDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      })).resolves.not.toBeNull();
    }
  }, 30_000);
});
