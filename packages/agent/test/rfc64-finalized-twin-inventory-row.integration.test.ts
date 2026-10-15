/**
 * GH#3134 — a member shares an asset on a public graph and a curator publishes it under the
 * member's seal. The member's node then retires its shared-memory copy as a finalized twin. Left
 * in the member's SWM inventory, the asset's row has no shared-memory head to resolve: every later
 * projection of the member's catalog fails, so later shares are never placed. The twin's
 * retirement removes the row and requests the projection, as the publishing node does when its
 * publication is confirmed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  MemoryLayer,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  computeAuthorCatalogScopeDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  knowledgeAssetLayerGraphUri,
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
  generateGraphKnowledgeAssetMetadata,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DKGAgent } from '../src/index.js';
import { CatalogRepairIntegrityErrorV1 } from '../src/rfc64/catalog-repair-diagnostics-v1.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../src/rfc64/swm-inventory-shadow-runtime-v1.js';
import {
  reconcileFinalizedSwmTwinFromCatalogProjection,
  type FinalizedSwmTwinCatalogProjectionEvidence,
} from '../src/sync/requester/finalized-swm-twin-reconciliation.js';

const MEMBER_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const MEMBER = MEMBER_WALLET.address.toLowerCase() as EvmAddressV1;
const CURATOR = `0x${'c1'.repeat(20)}` as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID = `${CURATOR}/curated-public` as ContextGraphIdV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;
const DELEGATION_EXPIRES_AT = '1893456000000' as TimestampMsV1;
const INVENTORY_SCOPE_DIGEST = computeSwmAuthorInventoryScopeDigestV1({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: MEMBER,
  era: '0' as never,
});
const CATALOG_SCOPE_DIGEST = computeAuthorCatalogScopeDigestV1({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: MEMBER,
  era: '0' as never,
  bucketCount: '1' as never,
});

const agents: DKGAgent[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best-effort */ }
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('a member asset that a curator publishes (GH#3134)', () => {
  it('leaves the member inventory with its twin, so later shares place, and receivers apply the removal', async () => {
    const receiver = await startAgent('finalized-twin-receiver');
    const member = await startAgent('finalized-twin-member', [receiver.peerId]);
    await connectBothWays(member, receiver);

    const a = await share(member, 1n, 'member-asset-a');
    expect(inventoryRows(member)).toEqual([a.kaUal]);
    expect(memberCatalog(member)).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });
    await whenDelivered(member, receiver);
    expect(memberCatalog(receiver)).toMatchObject({ inventoryRowCount: '1' });

    // The curator publishes A under the member's seal. Its finalization reaches the member's node,
    // which retires its shared-memory copy of A as a byte-identical finalized twin.
    await writeCuratorPublication(member, a);
    await finalizationRetiresTwin(member, a);
    await member.awaitInFlightRfc64SwmInventoryObserversV1();

    expect(inventoryRows(member)).toEqual([]);
    expect(memberCatalog(member)).toMatchObject({ catalogVersion: '2', inventoryRowCount: '0' });
    expect(projectionRepair(member)).toMatchObject({ outcome: 'reconciled', consecutiveFailures: 0 });
    // A receiver applies the successor that no longer lists A.
    await whenDelivered(member, receiver);
    expect(memberCatalog(receiver)).toMatchObject({
      currentCatalogHeadDigest: memberCatalog(member)!.currentCatalogHeadDigest,
      inventoryRowCount: '0',
    });

    const b = await share(member, 2n, 'member-asset-b');
    expect(inventoryRows(member)).toEqual([b.kaUal]);
    expect(memberCatalog(member)).toMatchObject({ catalogVersion: '3', inventoryRowCount: '1' });
    expect(projectionRepair(member)).toMatchObject({ outcome: 'reconciled', consecutiveFailures: 0 });
    // No projection failed, so nothing was swept.
    expect(healCounts(member)).toBeUndefined();
    await whenDelivered(member, receiver);
    expect(memberCatalog(receiver)).toMatchObject({
      currentCatalogHeadDigest: memberCatalog(member)!.currentCatalogHeadDigest,
      inventoryRowCount: '1',
    });
  }, 120_000);

  it('sweeps a row left behind with its retired twin out at the next projection, so later shares place', async () => {
    const member = await startAgent('finalized-twin-heal');
    const a = await share(member, 1n, 'member-asset-a');
    const catalogWithA = memberCatalog(member);
    expect(catalogWithA).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });

    // A node before this change retired the twin and kept A's row.
    await writeCuratorPublication(member, a);
    await expect(retireTwinOnly(member, a)).resolves.toBe('retired');
    expect(inventoryRows(member)).toEqual([a.kaUal]);
    const infos = captured(member, 'info');

    // The next projection fails on A's row, sweeps it out and runs again: B is placed.
    const b = await share(member, 2n, 'member-asset-b');
    expect(inventoryRows(member)).toEqual([b.kaUal]);
    expect(memberCatalog(member)).toMatchObject({ inventoryRowCount: '1' });
    expect(memberCatalog(member)?.currentCatalogHeadDigest).not.toBe(catalogWithA?.currentCatalogHeadDigest);
    expect(projectionRepair(member)).toMatchObject({ outcome: 'reconciled', consecutiveFailures: 0 });
    expect(healCounts(member)).toEqual({ finalizedRowHealPasses: 1, finalizedRowsHealed: 1 });
    expect(infos.filter((line) => /removed 1 row\(s\) of finalized assets/u.test(line))).toHaveLength(1);
  }, 120_000);

  it('stalls on a row with no shared-memory copy and no finalized asset, which the sweep keeps, once per head', async () => {
    const member = await startAgent('finalized-twin-heal-unfinalized');
    const a = await share(member, 1n, 'member-asset-a');
    const catalogWithA = memberCatalog(member);
    // A's shared copy goes, and nothing finalized A.
    await member.retireFinalizedSwmTwinCandidate({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: a.kaUal,
      swmGraph: '',
      agentAddress: MEMBER,
      kaNumber: 1n,
    }, createOperationContext('share'));

    // A later share is never placed: every projection of the whole catalog fails on A's row.
    const b = await share(member, 2n, 'member-asset-b');
    expect(memberCatalog(member)).toEqual(catalogWithA);
    expect(projectionRepair(member)).toMatchObject({ outcome: 'failed', diagnostic: { kind: 'integrity' } });
    expect(projectionRepair(member)!.nextAttemptAtMs).not.toBeNull();
    const failure = await member.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: MEMBER,
    }).then(() => null, (error: unknown) => error);
    expect(causes(failure).some((cause) => cause instanceof CatalogRepairIntegrityErrorV1
      && /workspace head differs/u.test(cause.message))).toBe(true);

    // The sweep kept both rows, and did not run again on the same inventory head.
    expect(inventoryRows(member)).toEqual([a.kaUal, b.kaUal].sort());
    expect(healCounts(member)).toEqual({ finalizedRowHealPasses: 1, finalizedRowsHealed: 0 });
  }, 120_000);

  it('removes the row a pending share observer commits after the twin of its version was retired', async () => {
    const member = await startAgent('finalized-twin-pending-v2');
    await share(member, 1n, 'member-asset-a');

    // Version 2's observer has prepared its row and waits for its signature.
    const held = holdNextInventorySignature(member);
    const a2 = await share(member, 1n, 'member-asset-a', '2', false);
    await held.entered;
    expect(inventoryRows(member)).toEqual([a2.kaUal]);
    // No projection, and so no sweep, runs until both settle: only the retirement may take the row.
    const projections = vi.spyOn(member, 'requestRfc64SwmCatalogProjectionV1').mockReturnValue(true);
    const removals = vi.spyOn(member, 'removeRfc64SwmAuthorInventoryRowV1');
    await writeCuratorPublication(member, a2);
    await finalizationRetiresTwin(member, a2);
    held.release();
    await member.awaitInFlightRfc64SwmInventoryObserversV1();

    // It read the row the observer committed after it, and removed that version once.
    expect(inventoryRows(member)).toEqual([]);
    expect(removals.mock.calls.map(([call]) => call.expectedRow.assertionVersion)).toEqual(['2']);
    projections.mockRestore();
    const b = await share(member, 2n, 'member-asset-b');
    expect(inventoryRows(member)).toEqual([b.kaUal]);
    expect(projectionRepair(member)).toMatchObject({ outcome: 'reconciled', inventoryRowCount: '1' });
    expect(healCounts(member)).toBeUndefined();
  }, 120_000);

  it('removes a first share\'s row that its observer commits after the twin was retired', async () => {
    const member = await startAgent('finalized-twin-pending-first');
    const held = holdNextInventorySignature(member);
    const a = await share(member, 1n, 'member-asset-a', '1', false);
    await held.entered;
    // Nothing is in the inventory yet: the row is still on its way.
    expect(inventoryRows(member)).toEqual([]);
    // No projection, and so no sweep, runs until both settle: only the retirement may take the row.
    const projections = vi.spyOn(member, 'requestRfc64SwmCatalogProjectionV1').mockReturnValue(true);
    const removals = vi.spyOn(member, 'removeRfc64SwmAuthorInventoryRowV1');
    await writeCuratorPublication(member, a);
    await finalizationRetiresTwin(member, a);
    held.release();
    await member.awaitInFlightRfc64SwmInventoryObserversV1();

    // The pending write kept the retirement from skipping it: it waited, read the row, removed it.
    expect(inventoryRows(member)).toEqual([]);
    expect(removals.mock.calls.map(([call]) => call.expectedRow.assertionVersion)).toEqual(['1']);
    projections.mockRestore();
    const b = await share(member, 2n, 'member-asset-b');
    expect(inventoryRows(member)).toEqual([b.kaUal]);
    expect(projectionRepair(member)).toMatchObject({ outcome: 'reconciled', inventoryRowCount: '1' });
    expect(healCounts(member)).toBeUndefined();
  }, 120_000);

  it('stops a sweep cancelled while its removal waits on the signer, frees the inventory and commits nothing late', async () => {
    const member = await startAgent('finalized-twin-heal-cancelled');
    const a = await share(member, 1n, 'member-asset-a');
    await writeCuratorPublication(member, a);
    await expect(retireTwinOnly(member, a)).resolves.toBe('retired');

    // The author's key signs the sweep's removal and does not answer.
    const signature = holdNextWalletSignature();
    const controller = new AbortController();
    const reconcile = member.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: MEMBER,
      signal: controller.signal,
    }).then(() => null, (error: unknown) => error);
    await signature.entered;
    const reason = new Error('reconciliation cancelled');
    controller.abort(reason);
    await expect(within(reconcile, 10_000)).resolves.toBe(reason);

    // The author's inventory is free again, and the late signature commits nothing.
    await expect(within(rfc64SwmInventoryShadowRuntimeV1(member).runScopeExclusive(
      `${INVENTORY_SCOPE_DIGEST}\n${MEMBER}`,
      async () => 'free',
    ), 10_000)).resolves.toBe('free');
    signature.release();
    await member.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(inventoryRows(member)).toEqual([a.kaUal]);
    signature.restore();
  }, 120_000);

  it('keeps a finalized row without its shared copy on a finalized private lane when another row fails the projection', async () => {
    const member = await startAgent('finalized-twin-private-heal');
    const a = await share(member, 1n, 'member-asset-a');
    const x = await share(member, 2n, 'member-asset-x');
    // A is finalized and its shared copy retired; X's shared copy is gone and nothing finalized X.
    await writeCuratorPublication(member, a);
    await expect(retireTwinOnly(member, a)).resolves.toBe('retired');
    await member.retireFinalizedSwmTwinCandidate({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: x.kaUal,
      swmGraph: '',
      agentAddress: MEMBER,
      kaNumber: 2n,
    }, createOperationContext('share'));

    // On a finalized private lane A resolves from its verified copy, and X fails the projection.
    const lane = asFinalizedPrivateLane(member);
    const failure = await member.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: MEMBER,
    }).then(() => null, (error: unknown) => error);
    lane.mockRestore();
    expect(causes(failure).some((cause) => cause instanceof CatalogRepairIntegrityErrorV1)).toBe(true);

    // That lane keeps its rows: nothing was swept, and A's row stays.
    expect(inventoryRows(member)).toEqual([a.kaUal, x.kaUal].sort());
    expect(healCounts(member)).toBeUndefined();
  }, 120_000);

  it('keeps the row on a lane whose catalog places finalized assets', async () => {
    const member = await startAgent('finalized-twin-private-lane');
    const a = await share(member, 1n, 'member-asset-a');
    await writeCuratorPublication(member, a);
    await expect(retireTwinOnly(member, a)).resolves.toBe('retired');

    // A finalized private graph's lane, as the publishing node sees it: its rows stay.
    type LaneDecision = { status: string; lane?: Record<string, unknown> };
    const lanes = member as unknown as {
      resolveRfc64CatalogAuthoringLaneDecisionV1: (contextGraphId: string, subGraphName: string | null) => LaneDecision;
    };
    const decide = lanes.resolveRfc64CatalogAuthoringLaneDecisionV1.bind(member);
    const lane = vi.spyOn(lanes, 'resolveRfc64CatalogAuthoringLaneDecisionV1')
      .mockImplementation((contextGraphId, subGraphName) => {
        const decision = decide(contextGraphId, subGraphName);
        return decision.status !== 'active' ? decision
          : { ...decision, lane: { ...decision.lane, acceptsFinalizedVmRepair: true } };
      });
    await member.retireLegacySwmAfterVerifiedVmTwin({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: a.kaUal,
      assertionVersion: a.assertionVersion,
    });
    await member.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(lane).toHaveBeenCalled();
    lane.mockRestore();
    expect(inventoryRows(member)).toEqual([a.kaUal]);
  }, 120_000);

  it('logs a removal that fails, and the twin retirement goes on', async () => {
    const member = await startAgent('finalized-twin-removal-failure');
    const a = await share(member, 1n, 'member-asset-a');
    await writeCuratorPublication(member, a);
    await expect(retireTwinOnly(member, a)).resolves.toBe('retired');
    const warnings: string[] = [];
    const log = (member as unknown as { log: { warn: (ctx: unknown, message: string) => void } }).log;
    vi.spyOn(log, 'warn').mockImplementation((_ctx, message) => { warnings.push(message); });
    const retire = () => member.retireLegacySwmAfterVerifiedVmTwin({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: a.kaUal,
      assertionVersion: a.assertionVersion,
    });

    const removal = vi.spyOn(member, 'removeRfc64SwmAuthorInventoryConfirmedRowV1')
      .mockRejectedValueOnce(new Error('inventory write refused'));
    await expect(retire()).resolves.toBeUndefined();
    await member.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(removal).toHaveBeenCalledOnce();
    expect(inventoryRows(member)).toEqual([a.kaUal]);

    const lanes = member as unknown as { resolveRfc64CatalogAuthoringLaneDecisionV1: () => unknown };
    vi.spyOn(lanes, 'resolveRfc64CatalogAuthoringLaneDecisionV1').mockImplementationOnce(() => {
      throw new Error('lane unreadable');
    });
    await expect(retire()).resolves.toBeUndefined();
    await member.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(inventoryRows(member)).toEqual([a.kaUal]);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/remove failed after the user operation committed: inventory write refused/u),
      expect.stringMatching(/not removed: lane unreadable/u),
    ]));

    // The next retirement of the same twin removes the row.
    await retire();
    await member.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(inventoryRows(member)).toEqual([]);
  }, 120_000);

  it('leaves a newer share of the asset in place', async () => {
    const member = await startAgent('finalized-twin-newer-share');
    const a = await share(member, 1n, 'member-asset-a', '2');
    // A finalization of an older version retires no twin of version 2, and no row.
    await member.retireLegacySwmAfterVerifiedVmTwin({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: a.kaUal,
      assertionVersion: '1',
    });
    await member.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(inventoryRows(member)).toEqual([a.kaUal]);
    expect(memberCatalog(member)).toMatchObject({ inventoryRowCount: '1' });
  }, 120_000);
});

async function startAgent(name: string, announcementPeers: readonly string[] = []): Promise<DKGAgent> {
  const dataDir = await mkdtemp(join(tmpdir(), `dkg-rfc64-${name}-`));
  tempDirs.push(dataDir);
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
    vmReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
    rfc64CatalogDeploymentProfile: DEPLOYMENT,
    rfc64PublicCatalogAutoPublish: {
      peers: announcementPeers,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    },
  });
  agents.push(agent);
  vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(MEMBER_WALLET.privateKey);
  await agent.start();
  agent.acceptOpenContextGraphPolicyV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: CURATOR,
  });
  return agent;
}

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  const tcp = (agent: DKGAgent) => {
    const address = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
    if (address === undefined) throw new Error('agent has no TCP multiaddr');
    return multiaddr(address);
  };
  await a.node.libp2p.dial(tcp(b));
  await b.node.libp2p.dial(tcp(a));
}

async function whenDelivered(author: DKGAgent, receiver: DKGAgent): Promise<void> {
  await author.whenRfc64CatalogHeadDeliveryIdleV1();
  await receiver.whenRfc64PublicCatalogReceiverIdleV1();
}

interface SharedAssetV1 {
  readonly kaUal: CanonicalGraphScopedAuthorSealV1['kaUal'];
  readonly assertionVersion: string;
  readonly seal: CanonicalGraphScopedAuthorSealV1;
  readonly quads: readonly Quad[];
}

/** The member's share of one public asset, through the share's own durable writes and observer. */
async function share(
  agent: DKGAgent,
  kaNumber: bigint,
  assertionCoordinate: string,
  assertionVersion = '1',
  settle = true,
): Promise<SharedAssetV1> {
  const quads: readonly Quad[] = [{
    subject: `https://example.org/member-asset-${kaNumber}`,
    predicate: 'https://schema.org/name',
    object: `"Member asset ${kaNumber}"`,
    graph: '',
  }];
  const seal = await memberSeal(kaNumber, quads, assertionVersion);
  const assertionSeal = assertionSealFromCanonical(seal);
  const shareOperationId = `${assertionCoordinate}-share-${assertionVersion}`;
  const assertionUri = contextGraphAssertionUri(CONTEXT_GRAPH_ID, MEMBER, assertionCoordinate);
  // A new version's seal replaces the assertion's previous one.
  await agent.store.deleteByPattern({ graph: contextGraphMetaUri(CONTEXT_GRAPH_ID), subject: assertionUri });
  await agent.store.insert(buildAssertionSealQuads({
    assertionUri,
    metaGraph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
    merkleRoot: assertionSeal.merkleRoot,
    authorAddress: assertionSeal.authorAddress,
    authorAttestationR: assertionSeal.authorAttestationR,
    authorAttestationVS: assertionSeal.authorAttestationVS,
    authorSchemeVersion: assertionSeal.authorSchemeVersion,
    chainId: assertionSeal.chainId,
    kav10Address: assertionSeal.kav10Address,
    reservedKaId: assertionSeal.reservedKaId!,
    finalizedAtIso: assertionSeal.finalizedAtIso,
    contentScopeVersion: assertionSeal.contentScopeVersion!,
    kaUal: assertionSeal.kaUal!,
    assertionVersion: assertionSeal.assertionVersion!,
    publicTripleCount: assertionSeal.publicTripleCount!,
    privateTripleCount: assertionSeal.privateTripleCount!,
  }));
  const graphManager = new GraphManager(agent.store);
  await storeKnowledgeAssetOperationPublicQuads({
    store: agent.store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    shareOperationId,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    quads,
    privateTripleCount: 0,
    publisherPeerId: agent.peerId,
    accessPolicy: 'public',
    agentAddress: MEMBER,
    timestamp: new Date(seal.assertionFinalizedAt),
  });
  await storeKnowledgeAssetWorkspaceHead({
    store: agent.store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    shareOperationId,
  });
  await agent.afterDurableSwmPromotionV1({
    contextGraphId: CONTEXT_GRAPH_ID,
    assertionCoordinate,
    lifecycleAgentAddress: MEMBER,
    shareOperationId,
    ctx: createOperationContext('share'),
  });
  if (settle) await agent.awaitInFlightRfc64SwmInventoryObserversV1();
  return Object.freeze({ kaUal: seal.kaUal, assertionVersion: seal.assertionVersion, seal, quads });
}

/** The curator's confirmed publication of the member's asset, as the member's node stores it. */
async function writeCuratorPublication(agent: DKGAgent, asset: SharedAssetV1): Promise<void> {
  const vmGraph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(asset.kaUal, asset.assertionVersion),
  );
  await agent.store.insert([
    ...asset.quads.map((quad) => ({ ...quad, graph: vmGraph })),
    ...generateGraphKnowledgeAssetMetadata({
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: asset.kaUal,
      merkleRoot: ethers.getBytes(asset.seal.assertionMerkleRoot),
      publisherPeerId: 'curator-publisher',
      accessPolicy: 'public',
      allowedPeers: [],
      timestamp: new Date(asset.seal.assertionFinalizedAt),
      assertionVersion: asset.assertionVersion,
      authorAddress: MEMBER,
      publicTripleCount: asset.quads.length,
      privateTripleCount: 0,
      assertionGraph: vmGraph,
    }, {
      status: 'confirmed',
      confirmation: {
        kind: 'finalized-materialization',
        provenance: {
          batchId: BigInt(asset.seal.reservedKaId),
          materializedVersion: { blockNumber: 124, txIndex: 0 },
        },
      },
    }),
  ]);
}

function twinEvidence(asset: SharedAssetV1): FinalizedSwmTwinCatalogProjectionEvidence {
  return Object.freeze({
    contextGraphId: CONTEXT_GRAPH_ID,
    kaUal: asset.kaUal,
    assertionVersion: asset.assertionVersion,
    publicQuadsDigest: workspacePublicQuadsDigest(asset.quads),
    publicQuadsCount: asset.quads.length,
    privateTripleCount: 0,
    expectedMerkleRoot: asset.seal.assertionMerkleRoot,
  });
}

/** The finalization handler's own twin step on the member's node: retire the twin, then finish it. */
async function finalizationRetiresTwin(agent: DKGAgent, asset: SharedAssetV1): Promise<void> {
  const handler = agent.getOrCreateFinalizationHandler() as unknown as {
    reconcileConfirmedGraphScopedSwmTwin: (
      evidence: FinalizedSwmTwinCatalogProjectionEvidence,
      ctx: ReturnType<typeof createOperationContext>,
    ) => Promise<void>;
  };
  await handler.reconcileConfirmedGraphScopedSwmTwin(twinEvidence(asset), createOperationContext('publish'));
}

/** Only the twin's shared-memory copy goes, without the step that finishes a retirement. */
async function retireTwinOnly(agent: DKGAgent, asset: SharedAssetV1): Promise<string> {
  const ctx = createOperationContext('publish');
  return reconcileFinalizedSwmTwinFromCatalogProjection({
    store: agent.store,
    writeLocks: (agent as unknown as { writeLocks: Map<string, Promise<void>> }).writeLocks,
    evidence: twinEvidence(asset),
    retire: (candidate) => agent.retireFinalizedSwmTwinCandidate(candidate, ctx),
  });
}

function inventoryRows(agent: DKGAgent): readonly string[] {
  return (agent.readRfc64SwmAuthorInventorySnapshotV1({
    inventoryScopeDigest: INVENTORY_SCOPE_DIGEST,
    authorAddress: MEMBER,
  })?.rows ?? []).map((row) => row.kaUal).sort();
}

function memberCatalog(agent: DKGAgent) {
  return agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: CATALOG_SCOPE_DIGEST,
    authorAddress: MEMBER,
  });
}

function projectionRepair(agent: DKGAgent) {
  return agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs.find(
    (repair) => repair.contextGraphId === CONTEXT_GRAPH_ID && repair.authorAddress === MEMBER,
  );
}

/** Holds the next signature the agent's author signer makes until released. */
function holdNextInventorySignature(agent: DKGAgent) {
  let release!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const createSigner = agent.createRfc64CatalogAuthorSignerV1.bind(agent);
  vi.spyOn(agent, 'createRfc64CatalogAuthorSignerV1').mockImplementationOnce((authorAddress, signal) => {
    const signer = createSigner(authorAddress, signal);
    return Object.freeze({
      ...signer,
      signMessage: async (message: Uint8Array) => {
        markEntered();
        await gate;
        return signer.signMessage(message);
      },
    });
  });
  return { entered, release };
}

/** The graph's authoring lane, as a finalized private graph's: its catalog keeps finalized rows. */
function asFinalizedPrivateLane(agent: DKGAgent) {
  type LaneDecision = { status: string; lane?: Record<string, unknown> };
  const lanes = agent as unknown as {
    resolveRfc64CatalogAuthoringLaneDecisionV1: (contextGraphId: string, subGraphName: string | null) => LaneDecision;
  };
  const decide = lanes.resolveRfc64CatalogAuthoringLaneDecisionV1.bind(agent);
  return vi.spyOn(lanes, 'resolveRfc64CatalogAuthoringLaneDecisionV1').mockImplementation((contextGraphId, subGraphName) => {
    const decision = decide(contextGraphId, subGraphName);
    return decision.status !== 'active' ? decision : {
      ...decision,
      lane: { ...decision.lane, kind: 'private', projectionTargetPolicy: 'monotonic-union', acceptsFinalizedVmRepair: true },
    };
  });
}

function healCounts(agent: DKGAgent) {
  return agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.finalizedRowHeal;
}

/** `promise`, or a rejection once `ms` passed without it settling. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms).unref?.(); }),
  ]);
}

/** Holds the next signature any wallet makes, below the signer's own cancellation, until released. */
function holdNextWalletSignature() {
  let release!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const sign = ethers.BaseWallet.prototype.signMessage;
  const spy = vi.spyOn(ethers.BaseWallet.prototype, 'signMessage').mockImplementationOnce(async function (this: ethers.BaseWallet, message) {
    markEntered();
    await gate;
    return sign.call(this, message);
  });
  return { entered, release, restore: () => spy.mockRestore() };
}

function captured(agent: DKGAgent, level: 'info' | 'warn'): string[] {
  const lines: string[] = [];
  const log = (agent as unknown as { log: Record<'info' | 'warn', (ctx: unknown, message: string) => void> }).log;
  const original = log[level].bind(log);
  vi.spyOn(log, level).mockImplementation((ctx, message) => {
    lines.push(message);
    original(ctx, message);
  });
  return lines;
}

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current instanceof Error && chain.length < 8; current = current.cause) {
    chain.push(current);
  }
  return chain;
}

async function memberSeal(
  kaNumber: bigint,
  publicQuads: readonly Quad[],
  assertionVersion: string,
): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaId = ((BigInt(MEMBER) << 96n) | kaNumber).toString();
  const assertionMerkleRoot = ethers.hexlify(computeFlatKCRootV10([...publicQuads], [])) as Digest32V1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress: MEMBER,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await MEMBER_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot,
    authorAddress: MEMBER,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${MEMBER}/${kaNumber}`,
    assertionVersion,
    publicTripleCount: String(publicQuads.length),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

function assertionSealFromCanonical(seal: CanonicalGraphScopedAuthorSealV1): AssertionSeal {
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
