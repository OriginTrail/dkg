// SPDX-License-Identifier: Apache-2.0

/**
 * Subscribe-after-connect convergence for an unregistered PUBLIC RFC-64
 * Context Graph (the live defect: an edge replica with default config was
 * connected to the author BEFORE `context-graph create`, the author shared
 * KA#1, the replica ran `subscribe`; the owner-signed seed was fetched and
 * accepted, the route answered 200, and then nothing converged).
 *
 * Root cause pinned here: responsibility derivation read the access policy
 * only from local `_meta`/ontology metadata or finalized chain evidence, so an
 * unregistered graph whose `_meta` had not replicated stayed `null` ->
 * no `edge-subscription` responsibility -> receiver lane inactive -> no head
 * replay, no applied rows; and because a catalog-authoritative graph is
 * excluded from legacy durable sync while the catalog lane carries no
 * declaration, `_meta` could never arrive either.
 *
 * Scenarios:
 *  1. accepted seed + subscribe while already connected => responsibility
 *     active, receiver lane active, head replay requested from connected
 *     peers, rows applied, `_meta` pulled from a connected peer (never from
 *     the deprecated ontology graph).
 *  2. no accepted policy => nothing activates and nothing is fetched.
 *  3. a connected peer serving a forged PRIVATE definition for a
 *     public-accepted graph is rejected; responsibility stays on the accepted
 *     policy and the local `_meta` is left untouched.
 */
import { multiaddr } from '@multiformats/multiaddr';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  type AssertionSeal,
  type CanonicalGraphScopedAuthorSealV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import { deriveRfc64PublicSwmGraphV1 } from
  '../src/rfc64/catalog-semantic-authority-transition-v1.js';
import { mintRfc64UnregisteredReplicaAuthoritySeedV1 } from
  '../src/rfc64/unregistered-replica-authority-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
} from './_helpers/rfc64-rollout-agent-harness.js';

const AUTHOR_NODE_WALLET = new ethers.Wallet(`0x${'70'.repeat(32)}`);
const OWNER_WALLET = new ethers.Wallet(`0x${'71'.repeat(32)}`);
const OWNER = OWNER_WALLET.address.toLowerCase() as EvmAddressV1;
const ATTACKER_NODE_WALLET = new ethers.Wallet(`0x${'72'.repeat(32)}`);
const REPLICA_NODE_WALLET = new ethers.Wallet(`0x${'73'.repeat(32)}`);
const HUB = '0x3333333333333333333333333333333333333333';
const ONTOLOGY_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

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

const { startAgent, cleanup } = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 subscribe-after-connect convergence (unregistered public CG)', () => {
  it('activates responsibility, replays heads, applies rows and pulls _meta from connected peers', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const author = await startAgent({
      name: 'sac-author',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: new NoChainAdapter(),
        chainConfig: nodeChainConfig(AUTHOR_NODE_WALLET),
      },
    });
    const replica = await startAgent({
      name: 'sac-replica',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
        chainConfig: nodeChainConfig(REPLICA_NODE_WALLET),
      },
    });
    allowAllNetworkAdmissionForTest(author);
    allowAllNetworkAdmissionForTest(replica);
    // The replica is connected BEFORE the graph exists.
    await connectBothWays(replica, author);

    const nestedAgent = await author.registerAgent('sac-nested-author');
    const owner = nestedAgent.agentAddress.toLowerCase() as EvmAddressV1;
    const contextGraphId = `${owner}/subscribe-after-connect` as ContextGraphIdV1;
    await author.createContextGraph({
      id: contextGraphId,
      name: 'Subscribe after connect',
      accessPolicy: 0,
      callerAgentAddress: owner,
    });
    await author.whenRfc64CatalogResponsibilitiesIdleV1();

    // The author shares KA#1 before the replica subscribes. The replica holds
    // no accepted policy yet, so it cannot admit the live announcement; the
    // head has to reach it later through replay.
    const ownerKey = author.getCustodialAgentPrivateKey(owner);
    if (ownerKey === undefined) throw new Error('nested author has no custodial key');
    const ownerWallet = new ethers.Wallet(ownerKey.startsWith('0x') ? ownerKey : `0x${ownerKey}`);
    const seal = await authorSealForWallet(ownerWallet, 1n, PROJECTION_QUADS);
    const head = await author.recordRfc64PublicCatalogAssetV1({
      contextGraphId,
      assertionCoordinate: 'subscribe-after-connect-ka-1' as never,
      publicQuads: PROJECTION_QUADS,
      seal: assertionSealFromCanonical(seal),
    });
    expect(head).toMatchObject({ catalogVersion: '1', inventoryRowCount: '1' });

    vi.spyOn(replica, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const replayRequests = vi.spyOn(replica, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1');
    const metaBootstrap = vi.spyOn(replica, 'bootstrapRfc64CatalogContextGraphMetadataFromPeersV1');
    expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([]);
    await expect(replica.hasConfirmedMetaState(contextGraphId)).resolves.toBe(false);

    // Route step 1 (`POST /api/context-graph/subscribe` admission): the seed
    // is fetched from the connected author and accepted.
    await expect(replica.resolveContextGraphSubscriptionBootstrapAuthority(
      contextGraphId,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({ outcome: 'allowed', source: 'rfc64-public' });
    expect(replica.readAcceptedRfc64CatalogAccessPolicyV1(contextGraphId)).toBe('public');
    await expect(replica.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId,
    })).resolves.not.toBeNull();
    // Acceptance alone must not have made the graph a responsibility: only the
    // recorded subscription below may do that.
    expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([]);
    replayRequests.mockClear();

    // Route step 2: record the subscription (no `_meta` is local yet).
    replica.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
    await replica.whenRfc64CatalogResponsibilitiesIdleV1();

    // (2) responsibility + receiver lane from the accepted policy alone.
    expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId,
        responsible: true,
        responsibilityReason: 'edge-subscription',
        active: true,
        mode: 'catalog',
      }),
    ]);
    expect(replica.readRfc64CatalogRuntimeSelectionV1()).toMatchObject({
      eligibleContextGraphs: [contextGraphId],
      selectedContextGraphs: [contextGraphId],
    });
    expect(replica.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId)).toMatchObject({
      active: true,
      mode: 'catalog',
      track2Enabled: true,
      legacySyncAllowed: false,
      reconciliationLane: 'catalog-apply',
    });
    // (3) head replay was requested from the peers connected right now ...
    expect(replayRequests).toHaveBeenCalledWith(contextGraphId);
    // ... and the replayed head was applied: the KA rows are in the replica.
    await vi.waitFor(async () => {
      await replica.whenRfc64PublicCatalogReceiverIdleV1();
      await expect(replica.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
        expect.objectContaining({
          contextGraphId,
          phase: 'complete',
          appliedCatalogHeadDigest: head!.currentCatalogHeadDigest,
        }),
      );
    }, { timeout: 30_000, interval: 100 });
    expect(replica.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({ failed: 0 });
    const swmGraph = deriveRfc64PublicSwmGraphV1(contextGraphId, seal.reservedKaId as never);
    await expect(storeOf(replica).hasGraph(swmGraph)).resolves.toBe(true);
    const rows = await storeOf(replica).query(
      `SELECT ?o WHERE { GRAPH <${swmGraph}> { <https://example.org/alice> <https://schema.org/name> ?o } }`,
    );
    if (rows.type !== 'bindings') throw new Error('expected SWM row bindings');
    expect(rows.bindings.map((row) => row['o'])).toEqual(['"Alice"']);

    // (4) `_meta` arrived through a targeted pull from a connected peer.
    await vi.waitFor(async () => {
      await expect(replica.hasConfirmedMetaState(contextGraphId)).resolves.toBe(true);
    }, { timeout: 30_000, interval: 100 });
    expect(metaBootstrap).toHaveBeenCalledWith(contextGraphId);
    await expect(Promise.all(metaBootstrap.mock.results.map(({ value }) => value)))
      .resolves.toContain('fetched');
    await expect(replica.getExplicitAccessPolicy(contextGraphId)).resolves.toBe('public');
    expect((await replica.getCgMeta(contextGraphId)).declared).toBe(true);
    expect(replica.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      metaSynced: true,
    });
    expect((await replica.listContextGraphs()).some(
      (row) => row.id === contextGraphId && row.subscribed,
    )).toBe(true);
    // Never through the deprecated ontology carrier.
    const ontologyRows = await storeOf(replica).query(
      `SELECT ?p WHERE { GRAPH <${ONTOLOGY_GRAPH}> { <${contextGraphDataGraphUri(contextGraphId)}> ?p ?o } }`,
    );
    if (ontologyRows.type !== 'bindings') throw new Error('expected ontology bindings');
    expect(ontologyRows.bindings).toHaveLength(0);
    // The metadata arrival re-projected the same responsibility, and the
    // awaited reconcile it runs must not demote the already accepted seed
    // (an `auto` re-read can never consume a replica seed): the receiver lane
    // stays active, no flap.
    await replica.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({ contextGraphId, responsibilityReason: 'edge-subscription', active: true }),
    ]);
    expect(replica.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId)).toMatchObject({
      active: true,
      reconciliationLane: 'catalog-apply',
    });
    await expect(replica.readRfc64CatalogOperationalStatusV1()).resolves.toContainEqual(
      expect.objectContaining({ contextGraphId, authorityState: 'accepted' }),
    );
    await expect(replica.canUseSharedMemoryForContextGraph(contextGraphId)).resolves.toBe(true);
  }, 90_000);

  it('does not activate, replay or fetch metadata for a subscription without an accepted policy', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const bystander = await startAgent({
      name: 'sac-bystander',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: new NoChainAdapter(),
        chainConfig: nodeChainConfig(AUTHOR_NODE_WALLET),
      },
    });
    const replica = await startAgent({
      name: 'sac-replica-unaccepted',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
        chainConfig: nodeChainConfig(REPLICA_NODE_WALLET),
      },
    });
    allowAllNetworkAdmissionForTest(bystander);
    allowAllNetworkAdmissionForTest(replica);
    await connectBothWays(replica, bystander);
    vi.spyOn(replica, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const contextGraphId = `${OWNER}/never-accepted` as ContextGraphIdV1;
    const replayRequests = vi.spyOn(replica, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1');
    const metaBootstrap = vi.spyOn(replica, 'bootstrapRfc64CatalogContextGraphMetadataFromPeersV1');
    const fetchPages = vi.spyOn(replica, 'fetchSyncPages');

    // The route would refuse here; a caller that records the subscription
    // anyway must still get nothing.
    await expect(replica.resolveContextGraphSubscriptionBootstrapAuthority(
      contextGraphId,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(replica.readAcceptedRfc64CatalogAccessPolicyV1(contextGraphId)).toBeNull();
    replica.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
    await replica.whenRfc64CatalogResponsibilitiesIdleV1();

    expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([]);
    expect(replica.readRfc64CatalogRuntimeSelectionV1().eligibleContextGraphs).toEqual([]);
    expect(replica.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId)).toMatchObject({
      active: false,
      legacySyncAllowed: false,
      reconciliationLane: 'disabled',
    });
    expect(replayRequests).not.toHaveBeenCalled();
    expect(metaBootstrap).not.toHaveBeenCalled();
    // Even an explicit bootstrap call is inert without an accepted policy.
    await expect(replica.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(contextGraphId))
      .resolves.toBe('no-accepted-public-policy');
    expect(fetchPages).not.toHaveBeenCalled();
    await expect(replica.hasConfirmedMetaState(contextGraphId)).resolves.toBe(false);
    expect(replica.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({ applied: 0 });
  }, 60_000);

  it('rejects a forged private definition served by a connected peer for a public-accepted graph', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const attacker = await startAgent({
      name: 'sac-attacker',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: new NoChainAdapter(),
        chainConfig: nodeChainConfig(ATTACKER_NODE_WALLET),
      },
    });
    const replica = await startAgent({
      name: 'sac-replica-forged-meta',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
        chainConfig: nodeChainConfig(REPLICA_NODE_WALLET),
      },
    });
    allowAllNetworkAdmissionForTest(attacker);
    allowAllNetworkAdmissionForTest(replica);
    await connectBothWays(replica, attacker);
    vi.spyOn(replica, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const contextGraphId = `${OWNER}/forged-meta` as ContextGraphIdV1;

    // The attacker holds a COMPLETE private definition for the victim's graph
    // and serves every sync request (it bypasses its own responder gate).
    await storeOf(attacker).insert(forgedPrivateMetaQuads(contextGraphId, attacker.peerId));
    vi.spyOn(attacker, 'authorizeSyncRequest').mockResolvedValue(true);

    // The replica holds the genuine owner-signed PUBLIC seed in its keyed store.
    const seed = await mintRfc64UnregisteredReplicaAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId,
      ownerAddress: OWNER,
      accessPolicy: 0,
      publishPolicy: 1,
      publishAuthorityAccountId: '0',
      memberAddresses: [],
      rosterVersion: '0',
      signer: {
        issuer: OWNER,
        signDigest: (digest) => OWNER_WALLET.signMessage(digest),
      },
    });
    await replica.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId,
      canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
    });
    await expect(replica.resolveContextGraphSubscriptionBootstrapAuthority(
      contextGraphId,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({ outcome: 'allowed', source: 'rfc64-public' });
    const metaBootstrap = vi.spyOn(replica, 'bootstrapRfc64CatalogContextGraphMetadataFromPeersV1');

    replica.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
    await replica.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({ contextGraphId, responsibilityReason: 'edge-subscription', active: true }),
    ]);
    await vi.waitFor(() => {
      expect(metaBootstrap).toHaveBeenCalledWith(contextGraphId);
    }, { timeout: 10_000 });
    await expect(metaBootstrap.mock.results[0]!.value).resolves.toBe('not-found');

    // Nothing was installed: no policy row at all in the local `_meta`, the
    // graph is not "private" locally, and the accepted public policy still
    // carries the responsibility.
    const policyRows = await storeOf(replica).query(
      `SELECT ?o WHERE { GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> { `
      + `<${contextGraphDataGraphUri(contextGraphId)}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?o } }`,
    );
    if (policyRows.type !== 'bindings') throw new Error('expected _meta bindings');
    expect(policyRows.bindings).toHaveLength(0);
    await expect(replica.getExplicitAccessPolicy(contextGraphId)).resolves.toBeNull();
    await expect(replica.hasConfirmedMetaState(contextGraphId)).resolves.toBe(false);
    await replica.whenRfc64CatalogResponsibilitiesIdleV1();
    expect(replica.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({ contextGraphId, responsibilityReason: 'edge-subscription', active: true }),
    ]);
  }, 60_000);
});

function nodeChainConfig(wallet: ethers.Wallet) {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: HUB,
    operationalKeys: [wallet.privateKey],
  };
}

/** Finalized index proves absence; every legacy or point read is a test failure. */
function coldReplicaChainAdapter(resolveFinalized: () => Promise<Map<never, never>>) {
  return Object.assign(new NoChainAdapter(), {
    getContextGraphAuthoritySnapshot: vi.fn(async () => { throw new Error('must not point-read'); }),
    resolveContextGraphIdByNameHash: vi.fn(async () => { throw new Error('must not legacy scalar-read'); }),
    resolveContextGraphIdsByNameHashes: vi.fn(async () => { throw new Error('must not legacy batch-read'); }),
    contextGraphAuthorityIndexRevisionReader: {
      resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle: vi.fn(async () => undefined),
    },
  });
}

function forgedPrivateMetaQuads(contextGraphId: string, curatorPeerId: string): Quad[] {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  return [
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: metaGraph },
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${curatorPeerId}`, graph: metaGraph },
    { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${ATTACKER_NODE_WALLET.address.toLowerCase()}`, graph: metaGraph },
  ];
}

function storeOf(agent: DKGAgent): TripleStore {
  return (agent as unknown as { store: TripleStore }).store;
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

function allowAllNetworkAdmissionForTest(agent: DKGAgent): void {
  const coordinator = (agent as any).networkAdmissionCoordinator;
  coordinator.isAcceptedPeer = () => true;
  coordinator.isRejectedPeer = () => false;
  coordinator.ensureAdmitted = async () => true;
}

async function authorSealForWallet(
  wallet: ethers.Wallet,
  kaNumber: bigint,
  publicQuads: readonly Quad[],
): Promise<CanonicalGraphScopedAuthorSealV1> {
  const authorAddress = wallet.address.toLowerCase() as EvmAddressV1;
  const kaId = ((BigInt(authorAddress) << 96n) | kaNumber).toString();
  const kaUal = `did:dkg:${NETWORK_ID}/${authorAddress}/${kaNumber}`;
  const assertionMerkleRoot = ethers.hexlify(
    computeFlatKCRootV10([...publicQuads], []),
  ) as Digest32V1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(assertionMerkleRoot),
    authorAddress,
    reservedKaId: BigInt(kaId),
  });
  const signature = ethers.Signature.from(await wallet.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot,
    authorAddress,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: DEPLOYMENT.assertedAtKav10Address,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-09-16T12:00:00.000Z',
    contentScopeVersion: '2',
    kaUal,
    assertionVersion: '1',
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
    ...(seal.privateMerkleRoot === null
      ? {}
      : { privateMerkleRoot: ethers.getBytes(seal.privateMerkleRoot) }),
    privateTripleCount: Number(seal.privateTripleCount),
    rootEntities: [],
  };
}
