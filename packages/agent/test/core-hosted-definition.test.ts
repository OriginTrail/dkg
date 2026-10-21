// SPDX-License-Identifier: Apache-2.0

/**
 * A Core keeps the owner's definition of the registered public graphs it hosts
 * and serves it to subscribers (`core-hosted-definition.ts`), so that a member
 * that reaches a graph only through Cores makes its first write into a
 * sub-graph the owner registered (the gap left between #3264 and #3293).
 *
 * The Core and the member run the real keeping, bootstrap, curator-refresh,
 * lookup and responder page code over fake agent surfaces, each with a real
 * store (as in registered-public-sub-graph-first-write.test.ts). A peer's
 * `_meta` is served as that peer's store holds it, so the Core's copy is what
 * the member reads.
 */
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeGossipSigningPayload,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  DKG_ONTOLOGY,
  encodeGossipEnvelope,
  encodeWorkspacePublishRequest,
  generateEd25519Keypair,
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  TypedEventBus,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  generateSubGraphRegistration,
  hasSubGraphRegistration,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import { holdsAuthoritativePublicDefinitionV1 } from '../src/context-graph-meta-confirmation.js';
import {
  CORE_HOSTED_DEFINITION_MAX_FALLBACK_PEERS,
  CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS,
  CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS,
  CORE_HOSTED_DEFINITION_SERVE_REFRESH_BUDGET_MS,
  CORE_HOSTED_OWNER_TIE_CHECKS_PER_MINUTE,
  coreHostedOwnerPeerIds,
  coreHostedOwnerPeerTie,
  coreHostedOwnerPeerTieSizes,
  ensureCoreHostedDefinition,
  hasPendingCoreHostedDefinitionRetry,
  holdsCoreHostedOwnerDefinition,
  noteCoreHostedOwnerShare,
  noteCoreHostedStorageAck,
  pendingCoreHostedDefinitionHint,
  pendingCoreHostedDefinitionRefresh,
  refreshCoreHostedDefinitionBeforeServing,
} from '../src/core-hosted-definition.js';
import { OWNER_TIE_CHECKS_PER_MINUTE, OWNER_TIE_PENDING_MAX } from '../src/core-hosted-owner-peer-tie.js';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';
import { Rfc64MetaBootstrapMethods } from '../src/dkg-agent-rfc64-meta-bootstrap.js';
import { Rfc64SeedFetchMethods } from '../src/dkg-agent-rfc64-seed-fetch.js';
import {
  PEER_SUB_GRAPH_REGISTRATION_LIMIT,
  SUB_GRAPH_RESOLUTION_MAX_PEERS,
} from '../src/peer-sub-graph-registration.js';
import { readDurableMetaPage } from '../src/sync/responder/graph-plan.js';
import { RELAYED_SHARE_FUTURE_SKEW_MS } from '../src/swm/owner-share-forward.js';
import {
  encryptedPayload,
  relayedShareRequest,
  senderKeyPayload,
  signedEnvelope,
  unsignedEnvelope,
} from './_helpers/relayed-share-fixtures.js';

const OWNER_SIGNER = new ethers.Wallet(`0x${'95'.repeat(32)}`);
const STRANGER_SIGNER = new ethers.Wallet(`0x${'96'.repeat(32)}`);
const OWNER = OWNER_SIGNER.address.toLowerCase() as EvmAddressV1;
const STRANGER = STRANGER_SIGNER.address.toLowerCase();
const MEMBER = new ethers.Wallet(`0x${'97'.repeat(32)}`).address;
const OWNER_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const CORE_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const SECOND_CORE_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const STRANGER_PEER_ID = '12D3KooWRBhwfeP2Y4TCx1SM6s9rUoHhR5STiGwxBhgFRcw3UERE';
const OTHER_PEER_ID = '12D3KooWJWEKvSFbben74C7H4YtKjhPMTDxd7gP7zxWSUEeF27st';
const MEMBER_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
/** A second node of the owner's wallet. */
const OWNER_SECOND_PEER_ID = '12D3KooWOwnerSecondNode00000000000000000000000000000';
const ON_CHAIN_ID = '12';
const contextGraphId = `${OWNER}/one-graph` as ContextGraphIdV1;
const REPORTS = 'reports';
const metaGraph = contextGraphMetaGraphUri(contextGraphId);
const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
const registeredProof = Object.freeze({ contextGraphId, onChainId: ON_CHAIN_ID });
const NAME = 'http://schema.org/name';
const ON_CHAIN_ID_PREDICATE = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;

function rootQuad(predicate: string, object: string): Quad {
  return { subject: contextGraphUri, predicate, object, graph: metaGraph };
}

/** The owner's root declaration of the registered public graph, chain claims included. */
const OWNER_DECLARATION: readonly Quad[] = Object.freeze([
  rootQuad(DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
  rootQuad(DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"public"'),
  rootQuad(DKG_ONTOLOGY.DKG_CURATOR, `did:dkg:agent:${OWNER}`),
  rootQuad(DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, '"registered"'),
  rootQuad(ON_CHAIN_ID_PREDICATE, `"${ON_CHAIN_ID}"`),
]);

/** A declaration that names another wallet as the graph's curator. */
/** What a subscriber that took its definition from the chain holds: the canonical facts, no curator. */
const CANONICAL_CHAIN_FACTS: readonly Quad[] = Object.freeze(OWNER_DECLARATION.slice(0, 2));

const FORGED_CURATOR_DECLARATION: readonly Quad[] = Object.freeze([
  rootQuad(DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
  rootQuad(DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"public"'),
  rootQuad(DKG_ONTOLOGY.DKG_CURATOR, `did:dkg:agent:${STRANGER}`),
]);

/** A declaration that would flip the public graph private. */
const PRIVATE_DECLARATION: readonly Quad[] = Object.freeze([
  rootQuad(DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
  rootQuad(DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"private"'),
  rootQuad(DKG_ONTOLOGY.DKG_CURATOR, `did:dkg:agent:${OWNER}`),
]);

/** The rows `createSubGraph` on the owner's node writes into the graph's `_meta`. */
function subGraphRegistration(subGraphName: string): Quad[] {
  return generateSubGraphRegistration({
    contextGraphId,
    subGraphName,
    createdBy: OWNER_PEER_ID,
    description: `${subGraphName} of the graph`,
    timestamp: new Date('2026-10-17T08:00:00.000Z'),
  });
}

const stores: OxigraphStore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function openStore(): OxigraphStore {
  const store = new OxigraphStore();
  stores.push(store);
  return store;
}

/** A node of the network: its `_meta` as it serves it, read from its store on each request. */
interface PeerNode {
  readonly store: OxigraphStore;
  /** `incomplete` answers with a partial page; `fail` refuses the request. */
  answer: 'complete' | 'incomplete' | 'fail';
}

async function peerNode(rows: readonly Quad[] = []): Promise<PeerNode> {
  const store = openStore();
  if (rows.length > 0) await store.insert([...rows]);
  return { store, answer: 'complete' };
}

async function servedMeta(peer: PeerNode): Promise<Quad[]> {
  const result = await peer.store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error('expected the peer\'s _meta rows');
  return result.bindings.map((row) => ({ subject: row['s']!, predicate: row['p']!, object: row['o']!, graph: metaGraph }));
}

type Peers = ReadonlyMap<string, PeerNode>;

/** The transport and store ports both the Core and the member share with the curator refresh. */
function nodeSurface(store: OxigraphStore, peerId: string, peers: Peers, connected: () => readonly string[]) {
  const writeLocks = new Map<string, Promise<void>>();
  const syncCheckpoints = new Map<string, number>();
  const fetchSyncPages = vi.fn(async (
    _ctx: OperationContext,
    remotePeerId: string,
    _contextGraphId: string,
    _includeSharedMemory: boolean,
    _phase: string,
    _graphUri: string,
    _deadline: number,
    _options?: { forceFreshSession?: boolean; signal?: AbortSignal },
  ) => {
    const peer = peers.get(remotePeerId);
    if (peer === undefined || peer.answer === 'fail') throw new Error(`dial to ${remotePeerId.slice(-8)} failed`);
    const quads = await servedMeta(peer);
    syncCheckpoints.set(`meta-checkpoint-${remotePeerId}`, quads.length);
    return {
      quads: peer.answer === 'incomplete' ? quads.slice(0, 1) : quads,
      checkpointKey: `meta-checkpoint-${remotePeerId}`,
      resumedFromOffset: 0,
      completed: peer.answer === 'complete',
    };
  });
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const peerResolver = {
    // A dial succeeds for a peer that exists and answers; connected peers are never dialled.
    connect: vi.fn(async (remotePeerId: string) => ({
      status: peers.get(remotePeerId)?.answer === 'fail' || !peers.has(remotePeerId) ? 'failed' : 'connected',
    })),
  };
  return {
    store,
    log,
    peerId,
    writeLocks,
    syncCheckpoints,
    fetchSyncPages,
    peerResolver,
    metaRefreshTimestamps: new Map<string, number>(),
    runContextGraphSyncWithBackpressure: vi.fn(async <T>(
      _ctx: OperationContext,
      _contextGraphId: string,
      _lane: 'durable',
      _label: string,
      work: () => Promise<T>,
    ): Promise<T> => work()),
    node: {
      libp2p: {
        peerId: { toString: () => peerId },
        getPeers: () => [],
        getConnections: () => connected().map((remotePeerId) => ({ remotePeer: { toString: () => remotePeerId } })),
      },
    },
    oversizeTombstoneLog: { record: () => undefined },
    invalidateListContextGraphsCache: vi.fn(),
    contextGraphMetaProjection: { markDirty: vi.fn() },
    bindSubscriptionOnChainId: vi.fn(),
    recordCgWireId: vi.fn(),
    persistContextGraphSubscription: vi.fn(),
  };
}

interface CoreOptions {
  /** The peers the Core is connected to; default the owner. */
  connected?: readonly string[];
  /** The nodes the Core's agent registry lists for the owner wallet; default the owner's node. */
  ownerNodes?: readonly string[];
  /** The curator node the Core's metadata projection names; default none. */
  curatorNode?: string;
  /** The connected peers the Core's seed selection returns; default none. */
  seedPeers?: readonly string[];
  /** Run the node's real peer selection over the connected peers instead of `seedPeers`; `cores` are the peers it ranks as Cores. */
  realSelector?: boolean;
  cores?: readonly string[];
  /** The graph's configured complete providers, which the real selection asks first. */
  pinnedProviders?: readonly string[];
  hosted?: boolean;
  localAuthor?: boolean;
  graphId?: string;
  /** The node's configured role; default a Core. */
  nodeRole?: 'core' | 'edge';
}

/** A Core that hosts the graph by its chain policy (`recordCoreHostedPublicCg` wrote its row). */
function coreNode(peers: Peers, options: CoreOptions = {}) {
  const store = openStore();
  const connected = [...(options.connected ?? [OWNER_PEER_ID])];
  const stop = new AbortController();
  const ownerNodes = options.ownerNodes ?? [OWNER_PEER_ID];
  const base = nodeSurface(store, CORE_PEER_ID, peers, () => connected);
  const graphId = options.graphId ?? contextGraphId;
  const surface = {
    ...base,
    config: { nodeRole: options.nodeRole ?? 'core' },
    node: { ...base.node, stopSignal: stop.signal },
    subscribedContextGraphs: new Map([[graphId, {
      syncMode: 'always-on', subscribed: false, synced: false, onChainId: ON_CHAIN_ID, coreHosted: options.hosted !== false,
    }]]),
    localContextGraphProvenance: { hasLocalCreate: () => options.localAuthor === true },
    discovery: {
      findAgents: vi.fn(async (query: { agentAddress?: string }) => (
        query.agentAddress?.toLowerCase() === OWNER
          ? ownerNodes.map((remotePeerId) => ({ peerId: remotePeerId, agentAddress: OWNER }))
          : []
      )),
    },
    resolveRfc64UnregisteredAuthoritySeedPeersV1: options.realSelector === true
      ? realSelector
      : vi.fn(() => [...(options.seedPeers ?? [])]),
    peerCapabilityRegistry: { supportsCore: (remotePeerId: string) => options.cores?.includes(remotePeerId) === true },
    rfc64SwmRecoveryRuntimeV1: { resolveConfiguredCompleteProviderPeerIds: () => [...(options.pinnedProviders ?? [])] },
    resolveCuratorPeerId: vi.fn(async () => options.curatorNode),
  };
  const node: PeerNode = { store, answer: 'complete' };
  return { agent: surface as unknown as object, surface, store, node, connected, stop, fetchSyncPages: base.fetchSyncPages, log: base.log };
}

interface MemberOptions {
  /** The connected peers in the order the node's peer selection returns them. */
  connected?: readonly string[];
  /** The peer the member resolves as the graph's owner; default the owner's node. */
  owner?: string;
  /** Run the node's real peer selection over the connected peers; `cores` are the peers it ranks as Cores. */
  realSelector?: boolean;
  cores?: readonly string[];
}

/** The node's real peer selection (`Rfc64SeedFetchMethods`), run over a fixture's libp2p surface. */
function realSelector(this: object, options: { contextGraphId?: string; maxPeers?: number }): readonly string[] {
  return Rfc64SeedFetchMethods.prototype.resolveRfc64UnregisteredAuthoritySeedPeersV1.call(this as never, options);
}

/**
 * A member subscribed to the graph, running the real bootstrap, lookup and
 * refresh code (`Rfc64MetaBootstrapMethods`, `ContextGraphRegistryMethods`).
 */
function memberNode(peers: Peers, options: MemberOptions = {}) {
  const store = openStore();
  const connected = options.connected ?? [CORE_PEER_ID];
  const base = nodeSurface(store, MEMBER_PEER_ID, peers, () => connected);
  const owner = 'owner' in options ? options.owner : OWNER_PEER_ID;
  const surface = {
    ...base,
    localContextGraphProvenance: { hasLocalCreate: () => false },
    subscribedContextGraphs: new Map([[contextGraphId, { subscribed: true }]]),
    readAcceptedRfc64CatalogAccessSnapshotV1: () => null,
    hasConfirmedMetaState: vi.fn(async () => true),
    resolveRfc64UnregisteredAuthoritySeedPeersV1: options.realSelector === true
      ? realSelector
      : vi.fn(() => [...connected]),
    peerCapabilityRegistry: { supportsCore: (remotePeerId: string) => options.cores?.includes(remotePeerId) === true },
    resolveCuratorPeerId: vi.fn(async () => owner),
    refreshMetaSyncedFlags: vi.fn(async () => undefined),
    // The chain attests nothing in this fake: a member without a serving peer holds no definition.
    resolveActivePublicContextGraphChainProof: vi.fn(async () => ({ state: 'unknown', reason: 'unprovable' })),
    discovery: {},
    resolveSubGraphRegistration: ContextGraphRegistryMethods.prototype.resolveSubGraphRegistration,
  };
  const agent = Object.defineProperties(
    Object.create(Rfc64MetaBootstrapMethods.prototype) as object,
    Object.getOwnPropertyDescriptors(surface),
  ) as unknown as DKGAgent;
  return { agent, store, surface, fetchSyncPages: base.fetchSyncPages, log: base.log, writeLocks: base.writeLocks };
}

/** The member's own publisher, wired to the agent as `DKGAgent.create` wires it. */
async function memberPublisher(member: ReturnType<typeof memberNode>) {
  return new DKGPublisher({
    store: member.store,
    chain: new MockChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    writeLocks: member.writeLocks,
    resolveUnregisteredSubGraph: (graphId, subGraphName) => member.agent.resolveSubGraphRegistration(graphId, subGraphName),
  });
}

/** POST /api/knowledge-assets with `subGraphName`: create the draft, then write its triple. */
async function firstWrite(publisher: DKGPublisher, name: string, subGraphName: string): Promise<void> {
  await publisher.assertionCreate(contextGraphId, name, MEMBER, subGraphName);
  await publisher.assertionWrite(
    contextGraphId,
    name,
    MEMBER,
    [{ subject: `urn:dkg:test-core-hosted:${name}`, predicate: NAME, object: `"${name}"`, graph: '' }],
    subGraphName,
  );
}

/** What the Core's sync responder serves for the graph's durable `_meta` (first page). */
async function servedByCore(core: ReturnType<typeof coreNode>, registeredSubGraphNames: string[]) {
  const rows = await readDurableMetaPage({ store: core.store, contextGraphId, registeredSubGraphNames, offset: 0, limit: 500 });
  return rows.map((row) => `${row.s} ${row.p} ${row.o}`);
}

const askedPeers = (fetchSyncPages: ReturnType<typeof vi.fn>) => fetchSyncPages.mock.calls.map((call) => call[1]);
const peersOf = (entries: Array<[string, PeerNode]>) => new Map(entries);

describe('a Core keeps the owner\'s definition of a hosted registered public graph', () => {
  it('fetches it from the owner\'s node with the sub-graph registrations, and serves it to subscribers', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));

    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');

    await expect(holdsAuthoritativePublicDefinitionV1(core.store, contextGraphId)).resolves.toBe(true);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID]);
    // The owner was connected: nothing was dialled.
    expect(core.surface.peerResolver.connect).not.toHaveBeenCalled();
    expect(core.log.info.mock.calls.map((call) => String(call[1])))
      .toContainEqual(expect.stringContaining(`installed the owner's definition from owner node ${OWNER_PEER_ID.slice(-8)}`));

    // The responder's durable `_meta` page carries the declaration and the registration.
    const served = await servedByCore(core, [REPORTS]);
    expect(served).toContainEqual(`${contextGraphUri} ${DKG_ONTOLOGY.DKG_ACCESS_POLICY} "public"`);
    expect(served).toContainEqual(`${contextGraphUri} ${DKG_ONTOLOGY.DKG_CURATOR} did:dkg:agent:${OWNER}`);
    expect(served).toContainEqual(`${contextGraphUri}/${REPORTS} ${NAME} "${REPORTS}"`);
    // The owner's chain claims are the peer's claims, not chain truth: not kept, not served.
    expect(served.some((row) => row.includes(ON_CHAIN_ID_PREDICATE))).toBe(false);

    // Held now: a second call asks nobody.
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'restored')).resolves.toBe('held');
    expect(core.fetchSyncPages).toHaveBeenCalledOnce();
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
  });

  it('refuses a forged definition: another curator, or a private policy, from any peer', async () => {
    const impostor = await peerNode([...FORGED_CURATOR_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const core = coreNode(peersOf([[STRANGER_PEER_ID, impostor]]), {
      connected: [STRANGER_PEER_ID], ownerNodes: [STRANGER_PEER_ID],
    });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    await expect(holdsAuthoritativePublicDefinitionV1(core.store, contextGraphId)).resolves.toBe(false);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(false);
    expect(core.log.warn.mock.calls.map((call) => String(call[1])))
      .toContainEqual(expect.stringContaining('its curator is not the owner the accepted policy names'));
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);

    const downgrade = await peerNode([...PRIVATE_DECLARATION]);
    const other = coreNode(peersOf([[OWNER_PEER_ID, downgrade]]));
    await expect(ensureCoreHostedDefinition(other.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    await expect(holdsAuthoritativePublicDefinitionV1(other.store, contextGraphId)).resolves.toBe(false);
    expect(other.log.warn.mock.calls.map((call) => String(call[1])))
      .toContainEqual(expect.stringContaining('missing an unambiguous public definition'));
  });

  it('asks the owner\'s nodes first, then connected peers, and takes the first verified definition', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    owner.answer = 'fail';
    const empty = await peerNode();
    const otherCore = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const core = coreNode(
      peersOf([[OWNER_PEER_ID, owner], [OTHER_PEER_ID, empty], [SECOND_CORE_PEER_ID, otherCore]]),
      { connected: [OTHER_PEER_ID, SECOND_CORE_PEER_ID], seedPeers: [OTHER_PEER_ID, SECOND_CORE_PEER_ID, OWNER_PEER_ID, STRANGER_PEER_ID] },
    );

    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'restored')).resolves.toBe('fetched');
    // The owner's node (not connected) is dialled and fails; the owner is not asked again among the connected peers.
    expect(core.surface.peerResolver.connect).toHaveBeenCalledWith(OWNER_PEER_ID, expect.anything());
    expect(askedPeers(core.fetchSyncPages)).toEqual([OTHER_PEER_ID, SECOND_CORE_PEER_ID]);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(core.log.info.mock.calls.map((call) => String(call[1])))
      .toContainEqual(expect.stringContaining(`installed the owner's definition from peer ${SECOND_CORE_PEER_ID.slice(-8)}`));
  });

  it(`asks at most ${CORE_HOSTED_DEFINITION_MAX_FALLBACK_PEERS} connected peers besides the owner's nodes`, async () => {
    const peers = [OTHER_PEER_ID, STRANGER_PEER_ID, SECOND_CORE_PEER_ID, MEMBER_PEER_ID];
    const core = coreNode(
      peersOf(await Promise.all(peers.map(async (peerId) => [peerId, await peerNode()] as [string, PeerNode]))),
      { connected: peers, ownerNodes: [], realSelector: true },
    );
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(CORE_HOSTED_DEFINITION_MAX_FALLBACK_PEERS);
  });

  it('keeps nothing for a graph it does not host, created itself, or whose id names no owner', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const peers = peersOf([[OWNER_PEER_ID, owner]]);
    const notHosted = coreNode(peers, { hosted: false });
    await expect(ensureCoreHostedDefinition(notHosted.agent, contextGraphId, 'recorded')).resolves.toBe('not-hosted');
    const author = coreNode(peers, { localAuthor: true });
    await expect(ensureCoreHostedDefinition(author.agent, contextGraphId, 'recorded')).resolves.toBe('local-author');
    const numeric = coreNode(peers, { graphId: ON_CHAIN_ID });
    await expect(ensureCoreHostedDefinition(numeric.agent, ON_CHAIN_ID, 'recorded')).resolves.toBe('no-owner-namespace');
    const unknown = coreNode(peers);
    await expect(ensureCoreHostedDefinition(unknown.agent, `${OWNER}/another-graph`, 'recorded')).resolves.toBe('not-hosted');
    await expect(ensureCoreHostedDefinition(unknown.agent, 'ontology', 'recorded')).resolves.toBe('not-hosted');
    for (const node of [notHosted, author, numeric, unknown]) expect(node.fetchSyncPages).not.toHaveBeenCalled();
  });

  it('retries with a growing delay while no peer serves it, shares one attempt, and stops with the node', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    owner.answer = 'fail';
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));

    const [first, second] = await Promise.all([
      ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded'),
      ensureCoreHostedDefinition(core.agent, contextGraphId, 'restored'),
    ]);
    expect([first, second]).toEqual(['not-found', 'not-found']);
    expect(core.fetchSyncPages).toHaveBeenCalledOnce();
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);
    expect(core.log.info.mock.calls.map((call) => String(call[1])))
      .toContainEqual(expect.stringContaining(`next attempt in ${CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]! / 1000} s`));

    // The first retry fails too; the second comes later than the first.
    await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]!);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);
    expect(core.log.info.mock.calls.map((call) => String(call[1])))
      .toContainEqual(expect.stringContaining(`next attempt in ${CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[1]! / 1000} s`));
    await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]!);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);

    // The owner is back: the next retry installs the definition and the chain of retries ends.
    owner.answer = 'complete';
    await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[1]! - CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]!);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(3);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);

    // A node that stops cancels its pending retry.
    const stopping = coreNode(peersOf([[OWNER_PEER_ID, { store: owner.store, answer: 'fail' }]]));
    await expect(ensureCoreHostedDefinition(stopping.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    expect(hasPendingCoreHostedDefinitionRetry(stopping.agent, contextGraphId)).toBe(true);
    stopping.stop.abort();
    expect(hasPendingCoreHostedDefinitionRetry(stopping.agent, contextGraphId)).toBe(false);
    await expect(ensureCoreHostedDefinition(stopping.agent, contextGraphId, 'retry')).resolves.toBe('not-hosted');
  });

  it('refreshes its copy from a connected owner before serving, once per cooldown, and never dials for it', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');

    // The owner registers a sub-graph after the Core took the definition.
    await owner.store.insert(subGraphRegistration(REPORTS));
    // Within the cooldown of the fetch above: served as it is.
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    expect(core.fetchSyncPages).toHaveBeenCalledOnce();
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(false);

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect((await servedByCore(core, [REPORTS]))).toContainEqual(`${contextGraphUri}/${REPORTS} ${NAME} "${REPORTS}"`);
    // Refreshed just now: the next request is served from the copy.
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);

    // The owner went away: the copy is served as it is, and no dial is made for a subscriber's request.
    clock.mockReturnValue(now + 2 * (CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1));
    core.connected.splice(0);
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);
    expect(core.surface.peerResolver.connect).not.toHaveBeenCalled();

    // Not hosted here, or a request already cancelled by its requester: no refresh starts.
    await refreshCoreHostedDefinitionBeforeServing(core.agent, `${OWNER}/another-graph`);
    const cancelled = new AbortController();
    cancelled.abort();
    core.connected.push(OWNER_PEER_ID);
    clock.mockReturnValue(now + 3 * (CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1));
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId, cancelled.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);
  });

  it('fetches a missing definition in the background when a subscriber asks and no owner node is connected', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const otherCore = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [SECOND_CORE_PEER_ID, otherCore]]), {
      connected: [SECOND_CORE_PEER_ID], ownerNodes: [], seedPeers: [SECOND_CORE_PEER_ID],
    });
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    await vi.waitFor(() => expect(core.fetchSyncPages).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).toBe(true));
    // A request that comes while the fetch runs waits for it (within its budget).
    core.fetchSyncPages.mockClear();
    await core.store.dropGraph(metaGraph);
    const inFlight = ensureCoreHostedDefinition(core.agent, contextGraphId, 'restored');
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    await expect(inFlight).resolves.toBe('fetched');
    expect(core.fetchSyncPages).toHaveBeenCalledOnce();
  });
  it('does not take the canonical chain facts a peer serves for the owner\'s definition, and goes on to a peer that holds it', async () => {
    const subscriber = await peerNode([...CANONICAL_CHAIN_FACTS]);
    const otherCore = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const core = coreNode(peersOf([[OTHER_PEER_ID, subscriber], [SECOND_CORE_PEER_ID, otherCore]]), {
      connected: [OTHER_PEER_ID, SECOND_CORE_PEER_ID], ownerNodes: [], seedPeers: [OTHER_PEER_ID, SECOND_CORE_PEER_ID],
    });

    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    expect(askedPeers(core.fetchSyncPages)).toEqual([OTHER_PEER_ID, SECOND_CORE_PEER_ID]);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);

    // Only the canonical facts anywhere: installed (they are correct), but not the owner's definition; the retry stays.
    const alone = coreNode(peersOf([[OTHER_PEER_ID, subscriber]]), { connected: [OTHER_PEER_ID], ownerNodes: [], seedPeers: [OTHER_PEER_ID] });
    await expect(ensureCoreHostedDefinition(alone.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    await expect(holdsAuthoritativePublicDefinitionV1(alone.store, contextGraphId)).resolves.toBe(true);
    await expect(holdsCoreHostedOwnerDefinition(alone.store, contextGraphId, OWNER)).resolves.toBe(false);
    expect(hasPendingCoreHostedDefinitionRetry(alone.agent, contextGraphId)).toBe(true);
  });

  it('names the owner\'s node through the definition it holds when the agent registry lists none, and remembers the peer a definition came from', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]), { ownerNodes: [], seedPeers: [OWNER_PEER_ID] });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    expect(core.log.info.mock.calls.map((call) => String(call[1])))
      .toContainEqual(expect.stringContaining(`installed the owner's definition from peer ${OWNER_PEER_ID.slice(-8)}`));

    // The owner registers a sub-graph. The projection now names the curator
    // node, and the peer the definition came from is remembered: either names
    // the connected owner for the refresh before serving.
    await owner.store.insert(subGraphRegistration(REPORTS));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);

    const named = coreNode(peersOf([[OWNER_PEER_ID, owner]]), { ownerNodes: [], curatorNode: OWNER_PEER_ID });
    await expect(ensureCoreHostedDefinition(named.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    expect(named.log.info.mock.calls.map((call) => String(call[1])))
      .toContainEqual(expect.stringContaining(`installed the owner's definition from owner node ${OWNER_PEER_ID.slice(-8)}`));
  });

  it(`learns a graph's sub-graphs past the per-snapshot limit of ${PEER_SUB_GRAPH_REGISTRATION_LIMIT} across refreshes`, async () => {
    const names = Array.from({ length: PEER_SUB_GRAPH_REGISTRATION_LIMIT + 1 }, (_, i) => `s${String(i).padStart(4, '0')}`);
    const last = names.at(-1)!;
    const owner = await peerNode([...OWNER_DECLARATION, ...names.flatMap((name) => subGraphRegistration(name))]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    await expect(hasSubGraphRegistration(core.store, contextGraphId, names[0]!)).resolves.toBe(true);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, last)).resolves.toBe(false);

    // The next refresh takes the registrations the Core does not hold yet.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, last)).resolves.toBe(true);

    // A member connected to the Core only writes into the last one.
    const member = memberNode(peersOf([[CORE_PEER_ID, core.node]]), { connected: [CORE_PEER_ID] });
    await member.store.insert([...OWNER_DECLARATION]);
    const publisher = await memberPublisher(member);
    await expect(firstWrite(publisher, 'report-last', last)).resolves.toBeUndefined();
    expect(askedPeers(member.fetchSyncPages)).toEqual([CORE_PEER_ID]);
  });

  it('answers a subscriber\'s request within the refresh budget when the agent registry, the owner or a running attempt stalls', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const budgetMs = 60;
    const within = async (work: Promise<void>) => {
      const startedAt = performance.now();
      await work;
      return performance.now() - startedAt;
    };

    // The agent registry never answers: the stored copy is served after the budget.
    const stalledRegistry = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(ensureCoreHostedDefinition(stalledRegistry.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    stalledRegistry.surface.discovery.findAgents.mockImplementation(() => new Promise(() => undefined));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);
    expect(await within(refreshCoreHostedDefinitionBeforeServing(stalledRegistry.agent, contextGraphId, undefined, budgetMs)))
      .toBeLessThan(budgetMs * 10);
    expect(stalledRegistry.fetchSyncPages).toHaveBeenCalledOnce();

    // The owner never answers the fetch: the stored copy is served after the budget.
    const stalledOwner = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(ensureCoreHostedDefinition(stalledOwner.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    stalledOwner.fetchSyncPages.mockImplementation(() => new Promise(() => undefined));
    clock.mockReturnValue(now + 2 * (CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1));
    expect(await within(refreshCoreHostedDefinitionBeforeServing(stalledOwner.agent, contextGraphId, undefined, budgetMs)))
      .toBeLessThan(budgetMs * 10);
    // Past the cooldown (the clock is), the hanging fetch was started and the request did not wait for it.
    expect(stalledOwner.fetchSyncPages).toHaveBeenCalledTimes(2);

    // An attempt already running stalls: the request waits for it only within the budget.
    const stalledAttempt = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    stalledAttempt.fetchSyncPages.mockImplementation(() => new Promise(() => undefined));
    const attempt = ensureCoreHostedDefinition(stalledAttempt.agent, contextGraphId, 'recorded');
    expect(await within(refreshCoreHostedDefinitionBeforeServing(stalledAttempt.agent, contextGraphId, undefined, budgetMs)))
      .toBeLessThan(budgetMs * 10);
    expect(stalledAttempt.fetchSyncPages).toHaveBeenCalledOnce();
    // A request cancelled by its requester ends the wait at once.
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await within(refreshCoreHostedDefinitionBeforeServing(stalledAttempt.agent, contextGraphId, cancelled.signal)))
      .toBeLessThan(budgetMs);
    clock.mockRestore();
    void attempt;
  });
  it('reaches every connected peer over its retries through the node\'s real peer selection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const coreId = (i: number) => `12D3KooWCore${String(i).padStart(44, '0')}`;
    const edgeId = (i: number) => `12D3KooWEdge${String(i).padStart(44, '0')}`;
    /** Retries until the Core holds the owner's definition; the attempts it took. */
    const retryUntilHeld = async (core: ReturnType<typeof coreNode>): Promise<number> => {
      let attempts = 1;
      await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
      for (let i = 0; i < 12 && !(await holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)); i += 1) {
        const delay = CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[Math.min(i, CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS.length - 1)]!;
        await vi.advanceTimersByTimeAsync(delay);
        attempts += 1;
      }
      await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
      expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
      return attempts;
    };

    // Twenty-four Cores and two Edges; only the fourth Core holds the definition; no owner node is named.
    const cores = Array.from({ length: 24 }, (_, i) => coreId(i));
    const edges = [edgeId(0), edgeId(1)];
    const holder = coreId(3);
    const many = coreNode(
      peersOf(await Promise.all([...cores, ...edges].map(async (peerId) =>
        [peerId, await peerNode(peerId === holder ? [...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)] : [])] as [string, PeerNode]))),
      { connected: [...cores, ...edges], ownerNodes: [], realSelector: true, cores },
    );
    const manyAttempts = await retryUntilHeld(many);
    expect(askedPeers(many.fetchSyncPages)).toContain(holder);
    // Every attempt asked at most the fallback window, Cores first, with one slot for an Edge.
    expect(many.fetchSyncPages.mock.calls.length).toBeLessThanOrEqual(manyAttempts * CORE_HOSTED_DEFINITION_MAX_FALLBACK_PEERS);
    expect(manyAttempts).toBeLessThanOrEqual(3);

    // Six Cores and eight Edges; the owner is the last Edge and the agent registry lists no node for it.
    const sixCores = Array.from({ length: 6 }, (_, i) => coreId(i));
    const eightEdges = [...Array.from({ length: 7 }, (_, i) => edgeId(i)), OWNER_PEER_ID];
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const behind = coreNode(
      peersOf([
        ...await Promise.all([...sixCores, ...eightEdges.slice(0, 7)].map(async (peerId) => [peerId, await peerNode()] as [string, PeerNode])),
        [OWNER_PEER_ID, owner],
      ]),
      { connected: [...sixCores, ...eightEdges], ownerNodes: [], realSelector: true, cores: sixCores },
    );
    const behindAttempts = await retryUntilHeld(behind);
    expect(askedPeers(behind.fetchSyncPages).at(-1)).toBe(OWNER_PEER_ID);
    expect(behindAttempts).toBeLessThanOrEqual(eightEdges.length);
  });

  it('schedules the next attempt when a store read fails, and recovers on it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    const query = core.store.query.bind(core.store);
    let failures = 1;
    core.store.query = (async (...args: Parameters<typeof query>) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('store unavailable');
      }
      return query(...args);
    }) as typeof core.store.query;

    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    expect(String(core.log.warn.mock.calls.at(-1)?.[1])).toMatch(/store unavailable; next attempt in 30 s/);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);
    expect(core.fetchSyncPages).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]!);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
  });
  it('reaches a peer behind the graph\'s pinned providers when they would fill the window', async () => {
    const providers = ['12D3KooWProviderA000000000000000000000000000000000000', '12D3KooWProviderB000000000000000000000000000000000000', '12D3KooWProviderC000000000000000000000000000000000000'];
    const holder = OTHER_PEER_ID;
    const core = coreNode(
      peersOf([
        ...await Promise.all(providers.map(async (peerId) => [peerId, await peerNode()] as [string, PeerNode])),
        [holder, await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)])],
      ]),
      { connected: [...providers, holder], ownerNodes: [], realSelector: true, pinnedProviders: providers },
    );
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    const asked = askedPeers(core.fetchSyncPages);
    expect(asked).toHaveLength(CORE_HOSTED_DEFINITION_MAX_FALLBACK_PEERS);
    expect(asked.slice(0, 2).every((peerId) => providers.includes(peerId))).toBe(true);
    expect(asked.at(-1)).toBe(holder);
  });

  it('lets a refresh that outlasts a subscriber\'s wait finish, so the next request serves what it installed', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    await owner.store.insert(subGraphRegistration(REPORTS));
    const serve = core.fetchSyncPages.getMockImplementation()!;
    core.fetchSyncPages.mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return serve(...args);
    });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);

    // The request stops waiting at its budget; the fetch, started, goes on.
    const startedAt = performance.now();
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId, undefined, 30);
    expect(performance.now() - startedAt).toBeLessThan(110);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(false);
    await pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
  });

  it('shares one refresh between requests that arrive together, and with a background attempt', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    await owner.store.insert(subGraphRegistration(REPORTS));
    const serve = core.fetchSyncPages.getMockImplementation()!;
    core.fetchSyncPages.mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return serve(...args);
    });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);

    // Three requests at once: one owner lookup, one fetch; the background attempt joins the same task.
    await Promise.all([
      refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId),
      refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId),
      refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId),
      ensureCoreHostedDefinition(core.agent, contextGraphId, 'restored'),
    ]);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);
    expect(core.surface.discovery.findAgents).toHaveBeenCalledTimes(2);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId)).toBeUndefined();
  });
});

describe('a member that reaches a registered public graph only through Cores', () => {
  it('takes the owner\'s definition from a Core, and its first write goes into the owner\'s sub-graph', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');

    // The member is connected to the Core only; it can name the owner's node but not reach it.
    const member = memberNode(peersOf([[CORE_PEER_ID, core.node]]), { connected: [CORE_PEER_ID] });
    await expect(member.agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(contextGraphId, undefined, registeredProof))
      .resolves.toBe('fetched');
    expect(askedPeers(member.fetchSyncPages)).toEqual([CORE_PEER_ID]);
    await expect(holdsCoreHostedOwnerDefinition(member.store, contextGraphId, OWNER)).resolves.toBe(true);
    await expect(hasSubGraphRegistration(member.store, contextGraphId, REPORTS)).resolves.toBe(true);

    const publisher = await memberPublisher(member);
    await expect(firstWrite(publisher, 'report-1', REPORTS)).resolves.toBeUndefined();
    // Learned with the definition: the write asked nobody.
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();
  });

  it('finds a sub-graph the owner registered later at the Core, before trying to reach the owner', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    const member = memberNode(peersOf([[CORE_PEER_ID, core.node]]), { connected: [CORE_PEER_ID] });
    await expect(member.agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(contextGraphId, undefined, registeredProof))
      .resolves.toBe('fetched');

    // The owner registers the sub-graph; the Core refreshes its copy when the member's lookup asks it.
    await owner.store.insert(subGraphRegistration(REPORTS));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);
    const serve = member.fetchSyncPages.getMockImplementation()!;
    member.fetchSyncPages.mockImplementation(async (...args) => {
      // What the Core's responder does before it reads the first page.
      if (args[1] === CORE_PEER_ID) await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
      return serve(...args);
    });

    const publisher = await memberPublisher(member);
    await expect(firstWrite(publisher, 'report-1', REPORTS)).resolves.toBeUndefined();
    await expect(hasSubGraphRegistration(member.store, contextGraphId, REPORTS)).resolves.toBe(true);
    // The Core was asked, and held it; the owner, out of reach, was not.
    expect(askedPeers(member.fetchSyncPages)).toEqual([CORE_PEER_ID, CORE_PEER_ID]);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, OWNER_PEER_ID]);
  });

  it('writes into the owner\'s sub-graph once a Core holds the definition, even if it took its own from the chain', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]));
    // The member subscribed while the Core held nothing: no peer served the definition.
    const member = memberNode(peersOf([[CORE_PEER_ID, core.node]]), { connected: [CORE_PEER_ID] });
    await expect(member.agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(contextGraphId, undefined, registeredProof))
      .resolves.toBe('not-found');
    // What #3264 installs from the chain: the graph is a public graph, nothing more.
    await member.store.insert(OWNER_DECLARATION.slice(0, 2));
    await expect(hasSubGraphRegistration(member.store, contextGraphId, REPORTS)).resolves.toBe(false);

    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    const publisher = await memberPublisher(member);
    await expect(firstWrite(publisher, 'report-1', REPORTS)).resolves.toBeUndefined();
    await expect(hasSubGraphRegistration(member.store, contextGraphId, REPORTS)).resolves.toBe(true);
    // The write's lookup asked the connected Core first; the owner it cannot reach came last and was not needed.
    expect(askedPeers(member.fetchSyncPages)).toEqual([CORE_PEER_ID, CORE_PEER_ID]);
  });

  it('asks the owner first only when connected to it; otherwise the connected peers first and the owner last', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const others = await Promise.all([OTHER_PEER_ID, STRANGER_PEER_ID, SECOND_CORE_PEER_ID].map(() => peerNode([...OWNER_DECLARATION])));
    const peers = peersOf([[OWNER_PEER_ID, owner], [OTHER_PEER_ID, others[0]!], [STRANGER_PEER_ID, others[1]!], [SECOND_CORE_PEER_ID, others[2]!]]);

    const withOwner = memberNode(peers, { connected: [OTHER_PEER_ID, OWNER_PEER_ID, STRANGER_PEER_ID] });
    await withOwner.store.insert([...OWNER_DECLARATION]);
    await expect(withOwner.agent.resolveSubGraphRegistration(contextGraphId, REPORTS)).resolves.toEqual({ registered: true });
    expect(askedPeers(withOwner.fetchSyncPages)).toEqual([OWNER_PEER_ID]);

    const withoutOwner = memberNode(peers, { connected: [OTHER_PEER_ID, STRANGER_PEER_ID, SECOND_CORE_PEER_ID] });
    await withoutOwner.store.insert([...OWNER_DECLARATION]);
    await expect(withoutOwner.agent.resolveSubGraphRegistration(contextGraphId, REPORTS)).resolves.toEqual({ registered: true });
    // Two connected peers, then the owner: the owner is always among the peers asked.
    expect(askedPeers(withoutOwner.fetchSyncPages)).toEqual([OTHER_PEER_ID, STRANGER_PEER_ID, OWNER_PEER_ID]);
    expect(askedPeers(withoutOwner.fetchSyncPages)).toHaveLength(SUB_GRAPH_RESOLUTION_MAX_PEERS);

    const unnamed = memberNode(peers, { connected: [OTHER_PEER_ID, SECOND_CORE_PEER_ID], owner: undefined });
    await unnamed.store.insert([...OWNER_DECLARATION]);
    await expect(unnamed.agent.resolveSubGraphRegistration(contextGraphId, REPORTS)).resolves.toMatchObject({ registered: false });
    expect(askedPeers(unnamed.fetchSyncPages)).toEqual([OTHER_PEER_ID, SECOND_CORE_PEER_ID]);
  });

  it('reaches every connected peer over repeated lookups, and takes a complete registration over an incomplete local one', async () => {
    // Twenty-four Cores; only the fourth holds the registration; the owner cannot be named.
    const cores = Array.from({ length: 24 }, (_, i) => `12D3KooWCore${String(i).padStart(44, '0')}`);
    const holder = cores[3]!;
    const peers = peersOf(await Promise.all(cores.map(async (peerId) =>
      [peerId, await peerNode(peerId === holder ? [...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)] : [...OWNER_DECLARATION])] as [string, PeerNode])));
    const member = memberNode(peers, { connected: cores, owner: undefined, realSelector: true, cores });
    await member.store.insert([...OWNER_DECLARATION]);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

    let lookups = 0;
    let outcome = await member.agent.resolveSubGraphRegistration(contextGraphId, REPORTS);
    for (lookups = 1; lookups < 10 && outcome.registered === false; lookups += 1) {
      clock.mockReturnValue(now + lookups * 31_000);
      outcome = await member.agent.resolveSubGraphRegistration(contextGraphId, REPORTS);
    }
    expect(outcome).toEqual({ registered: true });
    expect(askedPeers(member.fetchSyncPages)).toContain(holder);
    expect(member.fetchSyncPages.mock.calls.length).toBeLessThanOrEqual(lookups * SUB_GRAPH_RESOLUTION_MAX_PEERS);
    expect(lookups).toBeLessThanOrEqual(2);

    // An incomplete local row (type and name, no creator) is not a registration: the peer's complete one repairs it.
    const incomplete = memberNode(peersOf([[holder, peers.get(holder)!]]), { connected: [holder], owner: undefined });
    await incomplete.store.insert([
      ...OWNER_DECLARATION,
      { subject: `${contextGraphUri}/drafts`, predicate: DKG_ONTOLOGY.RDF_TYPE, object: 'http://dkg.io/ontology/SubGraph', graph: metaGraph },
      { subject: `${contextGraphUri}/drafts`, predicate: NAME, object: '"drafts"', graph: metaGraph },
    ]);
    await peers.get(holder)!.store.insert(subGraphRegistration('drafts'));
    await expect(hasSubGraphRegistration(incomplete.store, contextGraphId, 'drafts')).resolves.toBe(false);
    await expect(incomplete.agent.resolveSubGraphRegistration(contextGraphId, 'drafts')).resolves.toEqual({ registered: true });
    await expect(hasSubGraphRegistration(incomplete.store, contextGraphId, 'drafts')).resolves.toBe(true);
  });
});


/** A share into a graph naming `publisherPeerId`, in the envelope `signer` signs: the owner's wallet, now, by default. */
async function ownerShare(publisherPeerId: string, options: {
  readonly signer?: ethers.Wallet;
  readonly graphId?: string;
  readonly payloadGraphId?: string;
  readonly signedAt?: number;
} = {}): Promise<Uint8Array> {
  const graphId = options.graphId ?? contextGraphId;
  const payload = await relayedShareRequest({ contextGraphId: options.payloadGraphId ?? graphId, publisherPeerId });
  return signedEnvelope(payload, options.signer ?? OWNER_SIGNER, {
    contextGraphId: graphId,
    signedAt: options.signedAt === undefined ? undefined : new Date(options.signedAt),
  });
}

/** A small share of `graphId` naming `publisherPeerId`, signed by `signer` (the owner's wallet) now. */
async function smallOwnerShare(graphId: string, publisherPeerId: string, signer: ethers.Wallet = OWNER_SIGNER): Promise<Uint8Array> {
  const payload = encodeWorkspacePublishRequest({
    contextGraphId: graphId, nquads: new Uint8Array(), manifest: [], publisherPeerId, shareOperationId: 'op-1', timestampMs: 0,
  });
  return signedEnvelope(payload, signer, { contextGraphId: graphId });
}

/** A small share naming `publisherPeerId` whose envelope claims the owner's wallet over bytes that are no signature. */
function badSignatureShare(publisherPeerId: string): Uint8Array {
  const payload = encodeWorkspacePublishRequest({
    contextGraphId, nquads: new Uint8Array(), manifest: [], publisherPeerId, shareOperationId: 'op-1', timestampMs: 0,
  });
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    agentAddress: OWNER_SIGNER.address,
    timestamp: new Date().toISOString(),
    signature: new Uint8Array(65).fill(1),
    payload,
  });
}

/** An envelope that names the owner's wallet as its signer over a signature `signer` made. */
async function claimedOwnerShare(publisherPeerId: string, signer: ethers.Wallet): Promise<Uint8Array> {
  const payload = await relayedShareRequest({ contextGraphId, publisherPeerId });
  const timestamp = new Date().toISOString();
  const signature = await signer.signMessage(computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, contextGraphId, timestamp, payload));
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    agentAddress: OWNER_SIGNER.address,
    timestamp,
    signature: ethers.getBytes(signature),
    payload,
  });
}

/** Real event-loop turns until `condition` holds; fake timers leave `setImmediate` real. */
async function until(condition: () => boolean): Promise<void> {
  const startedAt = performance.now();
  while (!condition()) {
    if (performance.now() - startedAt > 10_000) throw new Error('condition not met within 10 s');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Fetches from `peerId` wait until `release()`, then fail; fetches after it are answered as the peer holds. */
function holdFetchesFrom(core: ReturnType<typeof coreNode>, peerId: string): { release(): void; held(): number } {
  const serve = core.fetchSyncPages.getMockImplementation()!;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let released = false;
  let held = 0;
  core.fetchSyncPages.mockImplementation(async (...args) => {
    if (args[1] !== peerId || released) return serve(...args);
    held += 1;
    await gate;
    throw new Error(`no answer from ${peerId.slice(-8)}`);
  });
  return { release: () => { released = true; open(); }, held: () => held };
}

describe('a Core asks the owner\'s node that an owner-signed share ties to a hosted graph', () => {
  const infoLines = (core: ReturnType<typeof coreNode>) => core.log.info.mock.calls.map((call) => String(call[1]));

  it('asks the tied node at once, installs the owner\'s sub-graph, and takes it for the definition\'s source', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    // The graph was created minutes ago: nothing names the owner's node, and the window misses it.
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OTHER_PEER_ID, await peerNode()]]), {
      connected: [OTHER_PEER_ID, OWNER_PEER_ID], ownerNodes: [], seedPeers: [OTHER_PEER_ID],
    });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    expect(askedPeers(core.fetchSyncPages)).toEqual([OTHER_PEER_ID]);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);
    expect(await coreHostedOwnerPeerIds(core.agent, contextGraphId, OWNER)).toEqual([]);

    // The owner's node delivers a share into the graph that the owner's wallet signed.
    const startedAt = performance.now();
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBe(OWNER_PEER_ID);
    await pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OTHER_PEER_ID, OWNER_PEER_ID]);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();
    expect(core.surface.peerResolver.connect).not.toHaveBeenCalled();
    expect(infoLines(core)).toContainEqual(expect.stringContaining(
      `installed the owner's definition from owner-tied node ${OWNER_PEER_ID.slice(-8)}`,
    ));
    // The owner lookups (the serve-time refresh, the forward of members' shares) name it now.
    expect(await coreHostedOwnerPeerIds(core.agent, contextGraphId, OWNER)).toEqual([OWNER_PEER_ID]);
  });

  it('counts the tied node\'s fetch for no cooldown: a subscriber\'s request right after it refreshes from the owner', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]), { ownerNodes: [], seedPeers: [] });
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    await pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);

    await owner.store.insert(subGraphRegistration(REPORTS));
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, OWNER_PEER_ID]);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
  });

  it('records the tie before the graph is hosted, and the attempt hosting starts asks the tied node before the connected peers', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OTHER_PEER_ID, await peerNode()]]), {
      connected: [OTHER_PEER_ID, OWNER_PEER_ID], ownerNodes: [], seedPeers: [OTHER_PEER_ID], hosted: false,
    });
    // The owner's share reaches the Core before its first StorageACK: the graph is not hosted yet.
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBe(OWNER_PEER_ID);
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();
    expect(core.fetchSyncPages).not.toHaveBeenCalled();

    // The StorageACK gate records the graph as hosted, then notes the ACK: one fetch, by the attempt.
    core.surface.subscribedContextGraphs.get(contextGraphId)!.coreHosted = true;
    const recorded = ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded');
    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_PEER_ID);
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();
    await expect(recorded).resolves.toBe('fetched');
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID]);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(infoLines(core)).toContainEqual(expect.stringContaining(`from owner node ${OWNER_PEER_ID.slice(-8)} (recorded)`));
  });

  it('makes one fetch for StorageACKs of the tied node while the definition is missing, and one more once it was held and lost', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    owner.answer = 'fail';
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OTHER_PEER_ID, await peerNode()]]), {
      connected: [OWNER_PEER_ID, OTHER_PEER_ID], ownerNodes: [], seedPeers: [], hosted: false,
    });
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    core.surface.subscribedContextGraphs.get(contextGraphId)!.coreHosted = true;

    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_PEER_ID);
    await pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID]);
    // The fetch is no attempt: it schedules no retry.
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
    for (const requester of [OWNER_PEER_ID, OWNER_PEER_ID, OTHER_PEER_ID, undefined]) {
      noteCoreHostedStorageAck(core.agent, contextGraphId, requester);
    }
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();
    expect(core.fetchSyncPages).toHaveBeenCalledOnce();

    // The owner answers again: the next attempt asks the node as an owner node and installs the definition.
    owner.answer = 'complete';
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'retry')).resolves.toBe('fetched');
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, OWNER_PEER_ID]);
    // Held: an ACK reads nothing and asks nobody.
    const queries = vi.spyOn(core.store, 'query');
    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_PEER_ID);
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();
    expect(queries).not.toHaveBeenCalled();
    queries.mockRestore();

    // The Core loses its copy while the owner's node is away: the attempt that finds it missing cannot reach the node.
    core.connected.splice(core.connected.indexOf(OWNER_PEER_ID), 1);
    owner.answer = 'fail';
    await core.store.dropGraph(metaGraph);
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'retry')).resolves.toBe('not-found');
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(2);
    // The node is back and asks for ACKs: one more fetch, which installs the definition and ends the retries.
    core.connected.push(OWNER_PEER_ID);
    owner.answer = 'complete';
    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_PEER_ID);
    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_PEER_ID);
    await pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, OWNER_PEER_ID, OWNER_PEER_ID]);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
    core.stop.abort();
  });

  it('runs a full attempt for a retry that comes due during the tied node\'s fetch, and keeps the retries armed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    owner.answer = 'fail';
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OTHER_PEER_ID, await peerNode()]]), {
      connected: [OWNER_PEER_ID, OTHER_PEER_ID], ownerNodes: [], seedPeers: [OTHER_PEER_ID],
    });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    const slow = holdFetchesFrom(core, OWNER_PEER_ID);
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    const fetching = pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    expect(fetching).toBeDefined();
    await until(() => slow.held() === 1);

    await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]!);
    // The retry joined nothing: an attempt of its own runs. It does not ask
    // the tied node a second time while that node's own fetch runs.
    const attempt = pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId);
    expect(attempt).toBeDefined();
    expect(attempt).not.toBe(fetching);
    slow.release();
    await fetching;
    await expect(attempt).resolves.toBe('not-found');
    expect(askedPeers(core.fetchSyncPages)).toEqual([OTHER_PEER_ID, OWNER_PEER_ID, OTHER_PEER_ID]);
    // The attempt scheduled the next retry, the second delay; the fetch that installed nothing moved nothing.
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);
    expect(infoLines(core).filter((line) => line.includes('next attempt in'))).toEqual([
      expect.stringContaining(`next attempt in ${CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]! / 1000} s`),
      expect.stringContaining(`next attempt in ${CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[1]! / 1000} s`),
    ]);

    // That retry runs as well, and installs the definition once the owner answers.
    owner.answer = 'complete';
    await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[1]!);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
  });

  it('runs a full attempt right after a subscriber\'s refresh during which a retry came due, and keeps the retries armed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const owner = await peerNode([...OWNER_DECLARATION]);
    owner.answer = 'fail';
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OTHER_PEER_ID, await peerNode()]]), {
      connected: [OWNER_PEER_ID, OTHER_PEER_ID], ownerNodes: [OWNER_PEER_ID], seedPeers: [OTHER_PEER_ID],
    });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, OTHER_PEER_ID]);

    // A subscriber asks past the cooldown, and the owner's node is slow to answer the refresh.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);
    const slow = holdFetchesFrom(core, OWNER_PEER_ID);
    const serving = refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    const refresh = pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId);
    await until(() => slow.held() === 1);
    await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]!);
    // The retry came due: no timer is pending, and it waits for the refresh.
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
    expect(pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId)).toBe(refresh);

    slow.release();
    await serving;
    await refresh;
    await pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, OTHER_PEER_ID, OWNER_PEER_ID, OWNER_PEER_ID, OTHER_PEER_ID]);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);
    await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[1]!);
    expect(core.fetchSyncPages).toHaveBeenCalledTimes(7);
    core.stop.abort();
  });

  it('starts its own refresh for a subscriber\'s request during the tied node\'s fetch, from the owner node the registry names', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OWNER_SECOND_PEER_ID, await peerNode()]]), {
      connected: [OWNER_PEER_ID, OWNER_SECOND_PEER_ID], ownerNodes: [OWNER_PEER_ID], seedPeers: [],
    });
    // The owner's second node ties itself to the graph and is slow to answer.
    const slow = holdFetchesFrom(core, OWNER_SECOND_PEER_ID);
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_SECOND_PEER_ID), OWNER_SECOND_PEER_ID);
    const fetching = pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    await until(() => slow.held() === 1);

    const startedAt = performance.now();
    const serving = refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    const refresh = pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId);
    expect(refresh).toBeDefined();
    expect(refresh).not.toBe(fetching);
    // Two fetches of one graph's metadata run one after the other; the slow one gives up within its deadline.
    setTimeout(() => slow.release(), 50);
    await serving;
    expect(performance.now() - startedAt).toBeLessThan(CORE_HOSTED_DEFINITION_SERVE_REFRESH_BUDGET_MS);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_SECOND_PEER_ID, OWNER_PEER_ID]);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    await fetching;
    // The owner lookups name the tied node first: the one entry the owner's signature names.
    expect(await coreHostedOwnerPeerIds(core.agent, contextGraphId, OWNER)).toEqual([OWNER_SECOND_PEER_ID, OWNER_PEER_ID]);
  });

  it('never asks a StorageACK requester that no owner-signed share ties, installs nothing it holds, and takes it for no source', async () => {
    const requester = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration('drafts')]);
    const core = coreNode(peersOf([[STRANGER_PEER_ID, requester]]), { connected: [STRANGER_PEER_ID], ownerNodes: [], seedPeers: [] });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    for (let i = 0; i < 3; i += 1) noteCoreHostedStorageAck(core.agent, contextGraphId, STRANGER_PEER_ID);
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();
    expect(pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId)).toBeUndefined();
    // Its own share, signed by its own wallet, ties nothing either.
    noteCoreHostedOwnerShare(core.agent, await ownerShare(STRANGER_PEER_ID, { signer: STRANGER_SIGNER }), STRANGER_PEER_ID);
    noteCoreHostedStorageAck(core.agent, contextGraphId, STRANGER_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBeUndefined();
    expect(core.fetchSyncPages).not.toHaveBeenCalled();
    await expect(hasSubGraphRegistration(core.store, contextGraphId, 'drafts')).resolves.toBe(false);
    expect(await coreHostedOwnerPeerIds(core.agent, contextGraphId, OWNER)).toEqual([]);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);
    core.stop.abort();
  });

  const STRANGERS_GRAPH = `${STRANGER}/one-graph`;
  const untied: Array<[string, () => Promise<{ wire: Uint8Array; from: string; options?: CoreOptions }>]> = [
    ['the owner\'s share replayed by another node', async () => ({ wire: await ownerShare(OWNER_PEER_ID), from: STRANGER_PEER_ID })],
    ['a share another wallet signed, naming its sender', async () => ({
      wire: await ownerShare(STRANGER_PEER_ID, { signer: STRANGER_SIGNER }), from: STRANGER_PEER_ID,
    })],
    ['an envelope that names the owner\'s wallet over another wallet\'s signature', async () => ({
      wire: await claimedOwnerShare(STRANGER_PEER_ID, STRANGER_SIGNER), from: STRANGER_PEER_ID,
    })],
    ['an envelope older than the freshness window', async () => ({
      wire: await ownerShare(OWNER_PEER_ID, { signedAt: Date.now() - GOSSIP_ENVELOPE_FRESHNESS_MS - 60_000 }), from: OWNER_PEER_ID,
    })],
    ['an envelope signed ahead of the clock by more than the skew', async () => ({
      wire: await ownerShare(OWNER_PEER_ID, { signedAt: Date.now() + RELAYED_SHARE_FUTURE_SKEW_MS + 60_000 }), from: OWNER_PEER_ID,
    })],
    ['a payload that names another graph than its envelope', async () => ({
      wire: await ownerShare(OWNER_PEER_ID, { payloadGraphId: `${OWNER}/another-graph` }), from: OWNER_PEER_ID,
    })],
    ['an envelope for a graph whose id names another wallet', async () => ({
      wire: await ownerShare(OWNER_PEER_ID, { graphId: STRANGERS_GRAPH }), from: OWNER_PEER_ID, options: { graphId: STRANGERS_GRAPH },
    })],
    ['a node that is not a Core', async () => ({ wire: await ownerShare(OWNER_PEER_ID), from: OWNER_PEER_ID, options: { nodeRole: 'edge' } })],
    ['a graph this node created', async () => ({ wire: await ownerShare(OWNER_PEER_ID), from: OWNER_PEER_ID, options: { localAuthor: true } })],
    ['a sender-key payload', async () => ({
      wire: await signedEnvelope(senderKeyPayload(contextGraphId), OWNER_SIGNER, { contextGraphId }), from: OWNER_PEER_ID,
    })],
    ['an encrypted payload', async () => ({
      wire: await signedEnvelope(encryptedPayload(contextGraphId), OWNER_SIGNER, { contextGraphId }), from: OWNER_PEER_ID,
    })],
    ['an unsigned envelope', async () => ({
      wire: unsignedEnvelope(await relayedShareRequest({ contextGraphId, publisherPeerId: OWNER_PEER_ID }), contextGraphId), from: OWNER_PEER_ID,
    })],
  ];

  it.each(untied)('ties no node for %s, and asks that node nothing for its StorageACK', async (_label, make) => {
    const { wire, from, options } = await make();
    const graphId = options?.graphId ?? contextGraphId;
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration('drafts')]);
    const core = coreNode(peersOf([[from, owner]]), { connected: [from], ownerNodes: [], seedPeers: [], ...options });
    noteCoreHostedOwnerShare(core.agent, wire, from);
    noteCoreHostedStorageAck(core.agent, graphId, from);
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBeUndefined();
    expect(coreHostedOwnerPeerTie(core.agent, STRANGERS_GRAPH)).toBeUndefined();
    expect(pendingCoreHostedDefinitionHint(core.agent, graphId)).toBeUndefined();
    expect(core.fetchSyncPages).not.toHaveBeenCalled();
  });

  it('keeps the retries on the owner\'s node through alternating StorageACKs of slow untied peers and of a slow tied node', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const SLOW_MS = 20_000;
    const owner = await peerNode([...OWNER_DECLARATION]);
    owner.answer = 'fail';
    const slowPeers = [OWNER_SECOND_PEER_ID, OTHER_PEER_ID, STRANGER_PEER_ID];
    const core = coreNode(
      peersOf([[OWNER_PEER_ID, owner], ...await Promise.all(slowPeers.map(async (peerId) => [peerId, await peerNode()] as [string, PeerNode]))]),
      { connected: [OWNER_PEER_ID, ...slowPeers], ownerNodes: [OWNER_PEER_ID], seedPeers: [] },
    );
    const serve = core.fetchSyncPages.getMockImplementation()!;
    core.fetchSyncPages.mockImplementation(async (...args) => {
      if (!slowPeers.includes(args[1])) return serve(...args);
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      throw new Error('timed out');
    });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_SECOND_PEER_ID), OWNER_SECOND_PEER_ID);

    const rounds = 4;
    for (let round = 0; round < rounds; round += 1) {
      for (const requester of [OTHER_PEER_ID, STRANGER_PEER_ID, OWNER_SECOND_PEER_ID, OTHER_PEER_ID, STRANGER_PEER_ID]) {
        noteCoreHostedStorageAck(core.agent, contextGraphId, requester);
      }
      await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[round]! + SLOW_MS);
    }
    const asked = askedPeers(core.fetchSyncPages);
    // Every attempt asked the owner's node the registry names: the first one and one per retry.
    expect(asked.filter((peerId) => peerId === OWNER_PEER_ID)).toHaveLength(rounds + 1);
    // The untied requesters were never asked; the tied node once by its own fetch, then by each retry.
    expect(asked.filter((peerId) => peerId === OTHER_PEER_ID || peerId === STRANGER_PEER_ID)).toEqual([]);
    expect(asked.filter((peerId) => peerId === OWNER_SECOND_PEER_ID)).toHaveLength(rounds + 1);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);
    core.stop.abort();
  });

  it('keeps one tie per graph, the latest node, and ties of graphs nobody hosts never push out a hosted graph\'s tie', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    owner.answer = 'fail';
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OWNER_SECOND_PEER_ID, owner]]), {
      connected: [OWNER_PEER_ID, OWNER_SECOND_PEER_ID], ownerNodes: [], seedPeers: [],
    });
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    await pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    // Another node of the owner ties itself later: it takes the first one's place and is asked once in turn.
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_SECOND_PEER_ID), OWNER_SECOND_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBe(OWNER_SECOND_PEER_ID);
    await pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, OWNER_SECOND_PEER_ID]);
    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_PEER_ID);
    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_SECOND_PEER_ID);
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();

    // The owner shares into a graph it has just created, which the Core does not host yet.
    const fresh = `${OWNER}/created-now`;
    noteCoreHostedOwnerShare(core.agent, await smallOwnerShare(fresh, OWNER_PEER_ID), OWNER_PEER_ID);
    // Another wallet's nodes tie themselves to many graphs that wallet's id names, none of them hosted.
    for (let node = 0; node < 18; node += 1) {
      const peerId = `12D3KooWJunkNode${String(node).padStart(36, '0')}`;
      for (let i = 0; i < 20; i += 1) {
        noteCoreHostedOwnerShare(core.agent, await smallOwnerShare(`${STRANGER}/junk-${node}-${i}`, peerId, STRANGER_SIGNER), peerId);
      }
    }
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBe(OWNER_SECOND_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, fresh)).toBe(OWNER_PEER_ID);
    const sizes = coreHostedOwnerPeerTieSizes(core.agent);
    expect(sizes.hosted).toBe(1);
    expect(sizes.pending).toBeGreaterThan(1);
    expect(sizes.pending).toBeLessThanOrEqual(OWNER_TIE_PENDING_MAX);
    // Its first StorageACK makes the Core host the graph: the tie counts among the hosted ones.
    core.surface.subscribedContextGraphs.set(fresh, { ...core.surface.subscribedContextGraphs.get(contextGraphId)! });
    expect(await coreHostedOwnerPeerIds(core.agent, fresh, OWNER)).toEqual([OWNER_PEER_ID]);
    expect(coreHostedOwnerPeerTieSizes(core.agent)).toEqual({ hosted: 2, pending: sizes.pending - 1 });
    core.stop.abort();
  }, 120_000);

  it(`checks at most ${OWNER_TIE_CHECKS_PER_MINUTE} signatures a minute in all, whichever nodes send envelopes whose signature fails`, async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]), { connected: [], ownerNodes: [], seedPeers: [] });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    // Envelopes whose signature fails, from more nodes than one node's limit covers.
    const senders = Math.ceil((2 * OWNER_TIE_CHECKS_PER_MINUTE) / CORE_HOSTED_OWNER_TIE_CHECKS_PER_MINUTE);
    for (let i = 0; i < senders; i += 1) {
      const peerId = `12D3KooWSender${String(i).padStart(38, '0')}`;
      const share = badSignatureShare(peerId);
      for (let j = 0; j < CORE_HOSTED_OWNER_TIE_CHECKS_PER_MINUTE; j += 1) noteCoreHostedOwnerShare(core.agent, share, peerId);
    }
    expect(coreHostedOwnerPeerTieSizes(core.agent)).toEqual({ hosted: 0, pending: 0 });
    // The owner's share is not checked either until the minute ends.
    const genuine = await ownerShare(OWNER_PEER_ID);
    noteCoreHostedOwnerShare(core.agent, genuine, OWNER_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBeUndefined();
    clock.mockReturnValue(now + 60_000);
    noteCoreHostedOwnerShare(core.agent, genuine, OWNER_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBe(OWNER_PEER_ID);
    core.stop.abort();
  });

  it(`checks at most ${CORE_HOSTED_OWNER_TIE_CHECKS_PER_MINUTE} signatures per node a minute, and none for the node a graph is tied to`, async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]), { connected: [], ownerNodes: [], seedPeers: [] });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    // A tied node's further shares are not checked again, so they use up nothing.
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    const again = await ownerShare(OWNER_PEER_ID);
    for (let i = 0; i < CORE_HOSTED_OWNER_TIE_CHECKS_PER_MINUTE + 1; i += 1) noteCoreHostedOwnerShare(core.agent, again, OWNER_PEER_ID);
    noteCoreHostedOwnerShare(core.agent, await smallOwnerShare(`${OWNER}/second-graph`, OWNER_PEER_ID), OWNER_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, `${OWNER}/second-graph`)).toBe(OWNER_PEER_ID);

    // Envelopes whose signature fails use up the sender's checks for the minute.
    const forged = await claimedOwnerShare(STRANGER_PEER_ID, STRANGER_SIGNER);
    for (let i = 0; i < CORE_HOSTED_OWNER_TIE_CHECKS_PER_MINUTE; i += 1) noteCoreHostedOwnerShare(core.agent, forged, STRANGER_PEER_ID);
    const genuine = await smallOwnerShare(`${OWNER}/third-graph`, STRANGER_PEER_ID);
    noteCoreHostedOwnerShare(core.agent, genuine, STRANGER_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, `${OWNER}/third-graph`)).toBeUndefined();
    clock.mockReturnValue(now + 60_000);
    noteCoreHostedOwnerShare(core.agent, genuine, STRANGER_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, `${OWNER}/third-graph`)).toBe(STRANGER_PEER_ID);
  });

  it('never throws on a node without a transport, and serves a subscriber\'s request as it is', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]), { ownerNodes: [], seedPeers: [] });
    core.surface.node.libp2p.getConnections = () => { throw new Error('not started'); };
    expect(() => noteCoreHostedOwnerShare(core.agent, new Uint8Array([1, 2, 3]), OWNER_PEER_ID)).not.toThrow();
    const share = await ownerShare(OWNER_PEER_ID);
    expect(() => noteCoreHostedOwnerShare(core.agent, share, OWNER_PEER_ID)).not.toThrow();
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBe(OWNER_PEER_ID);
    expect(() => noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_PEER_ID)).not.toThrow();
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();
    await expect(refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId)).resolves.toBeUndefined();
    expect(pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId)).toBeUndefined();
    expect(core.fetchSyncPages).not.toHaveBeenCalled();
    // A share from this node itself ties nothing.
    noteCoreHostedOwnerShare(core.agent, await ownerShare(CORE_PEER_ID, { graphId: `${OWNER}/own-share` }), CORE_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, `${OWNER}/own-share`)).toBeUndefined();
  });

  it('ends the tied node\'s fetch quietly when a store read fails, and leaves the retries as they were', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner]]), { seedPeers: [] });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    // The copy is lost; a refresh finds it missing and the retries are armed again.
    await core.store.dropGraph(metaGraph);
    core.connected.splice(0);
    owner.answer = 'fail';
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'retry')).resolves.toBe('not-found');
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);

    core.connected.push(OWNER_PEER_ID);
    core.store.query = (async () => { throw new Error('store unavailable'); }) as typeof core.store.query;
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    await expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).resolves.toBeUndefined();
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();
    expect(infoLines(core)).toContainEqual(expect.stringContaining('store unavailable'));
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);
    core.stop.abort();
  });

  it('never refreshes a held definition from an untied requester before serving', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const subscriber = await peerNode([...CANONICAL_CHAIN_FACTS]);
    const renaming = await peerNode([...OWNER_DECLARATION, rootQuad(NAME, '"renamed by requester"')]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [MEMBER_PEER_ID, subscriber], [STRANGER_PEER_ID, renaming]]), {
      connected: [OWNER_PEER_ID, MEMBER_PEER_ID, STRANGER_PEER_ID], ownerNodes: [OWNER_PEER_ID], seedPeers: [],
    });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');

    // The owner's node goes away; a subscriber that holds the chain's facts only, then a peer
    // that serves a renamed copy, ask for ACKs; subscribers' requests come past the cooldown.
    core.connected.splice(core.connected.indexOf(OWNER_PEER_ID), 1);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    for (const [round, requester] of [MEMBER_PEER_ID, STRANGER_PEER_ID].entries()) {
      noteCoreHostedStorageAck(core.agent, contextGraphId, requester);
      clock.mockReturnValue(now + (round + 1) * (CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1));
      await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    }
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID]);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    expect(await servedByCore(core, [])).not.toContainEqual(`${contextGraphUri} ${NAME} "renamed by requester"`);
    expect(core.surface.peerResolver.connect).not.toHaveBeenCalled();
    core.stop.abort();
  });

  it('fetches again when a refresh replaces the held definition with one that names no curator, asking the tied node then', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const peers = peersOf([[OWNER_PEER_ID, owner], [SECOND_CORE_PEER_ID, await peerNode([...OWNER_DECLARATION])]]);
    const core = coreNode(peers, { connected: [SECOND_CORE_PEER_ID, OWNER_PEER_ID], ownerNodes: [], seedPeers: [SECOND_CORE_PEER_ID] });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'restored')).resolves.toBe('fetched');
    // Held: the owner's share ties its node and fetches nothing.
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();

    // The peer the copy came from now serves the chain's facts only, and the owner's node is not connected.
    peers.set(SECOND_CORE_PEER_ID, await peerNode([...CANONICAL_CHAIN_FACTS]));
    core.connected.splice(core.connected.indexOf(OWNER_PEER_ID), 1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    await expect(pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId)).resolves.toBe('fetched');
    expect(askedPeers(core.fetchSyncPages)).toEqual([SECOND_CORE_PEER_ID, SECOND_CORE_PEER_ID, SECOND_CORE_PEER_ID, OWNER_PEER_ID]);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(infoLines(core)).toContainEqual(expect.stringContaining(`from owner node ${OWNER_PEER_ID.slice(-8)} (serve)`));

    // Nobody serves it then: the retries go on, and the tied node's StorageACK asks it once it is back.
    const alonePeers = peersOf([[SECOND_CORE_PEER_ID, await peerNode([...OWNER_DECLARATION])], [OWNER_PEER_ID, owner]]);
    const alone = coreNode(alonePeers, { connected: [SECOND_CORE_PEER_ID], ownerNodes: [], seedPeers: [SECOND_CORE_PEER_ID] });
    await expect(ensureCoreHostedDefinition(alone.agent, contextGraphId, 'restored')).resolves.toBe('fetched');
    noteCoreHostedOwnerShare(alone.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    alonePeers.set(SECOND_CORE_PEER_ID, await peerNode([...CANONICAL_CHAIN_FACTS]));
    owner.answer = 'fail';
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * (CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1));
    await refreshCoreHostedDefinitionBeforeServing(alone.agent, contextGraphId);
    await expect(pendingCoreHostedDefinitionRefresh(alone.agent, contextGraphId)).resolves.toBe('not-found');
    await expect(holdsCoreHostedOwnerDefinition(alone.store, contextGraphId, OWNER)).resolves.toBe(false);
    expect(hasPendingCoreHostedDefinitionRetry(alone.agent, contextGraphId)).toBe(true);
    alone.connected.push(OWNER_PEER_ID);
    owner.answer = 'complete';
    noteCoreHostedStorageAck(alone.agent, contextGraphId, OWNER_PEER_ID);
    await pendingCoreHostedDefinitionHint(alone.agent, contextGraphId);
    await expect(holdsCoreHostedOwnerDefinition(alone.store, contextGraphId, OWNER)).resolves.toBe(true);
    expect(hasPendingCoreHostedDefinitionRetry(alone.agent, contextGraphId)).toBe(false);
    alone.stop.abort();
  });

  it('keeps the held mark when the store loses the definition; the next subscriber\'s request finds it missing and fetches it', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const otherCore = await peerNode([...OWNER_DECLARATION]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [SECOND_CORE_PEER_ID, otherCore]]), {
      connected: [OWNER_PEER_ID, SECOND_CORE_PEER_ID], ownerNodes: [OWNER_PEER_ID], seedPeers: [SECOND_CORE_PEER_ID],
    });
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);

    // The owner's node goes away and stops answering; the Core's copy is lost while it still hosts the graph.
    core.connected.splice(core.connected.indexOf(OWNER_PEER_ID), 1);
    owner.answer = 'fail';
    await core.store.dropGraph(metaGraph);
    // The mark is in memory: the tied node's ACK starts nothing.
    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_PEER_ID);
    expect(pendingCoreHostedDefinitionHint(core.agent, contextGraphId)).toBeUndefined();

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);
    await refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    await expect(pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId)).resolves.toBe('fetched');
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, SECOND_CORE_PEER_ID]);
    expect(infoLines(core)).toContainEqual(expect.stringContaining(`from peer ${SECOND_CORE_PEER_ID.slice(-8)} (serve)`));
    core.stop.abort();
  });

  it('asks a node tied during a subscriber\'s refresh once the refresh ends, so it never replaces the declaration the refresh installs', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    // The owner's second node holds the chain's facts only.
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OWNER_SECOND_PEER_ID, await peerNode([...CANONICAL_CHAIN_FACTS])]]), {
      connected: [OWNER_PEER_ID, OWNER_SECOND_PEER_ID], ownerNodes: [OWNER_PEER_ID], seedPeers: [],
    });
    owner.answer = 'fail';
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');

    // A subscriber asks past the cooldown, and the owner's node is slow to answer the refresh.
    owner.answer = 'complete';
    const serve = core.fetchSyncPages.getMockImplementation()!;
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    core.fetchSyncPages.mockImplementation(async (...args) => {
      if (args[1] === OWNER_PEER_ID) await answered;
      return serve(...args);
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1);
    const share = await ownerShare(OWNER_SECOND_PEER_ID, { signedAt: Date.now() });
    const serving = refreshCoreHostedDefinitionBeforeServing(core.agent, contextGraphId);
    const refresh = pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId);
    await until(() => core.fetchSyncPages.mock.calls.length === 2);
    // Meanwhile the second node delivers a share the owner's wallet signed, then asks for a StorageACK.
    noteCoreHostedOwnerShare(core.agent, share, OWNER_SECOND_PEER_ID);
    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_SECOND_PEER_ID);
    expect(coreHostedOwnerPeerTie(core.agent, contextGraphId)).toBe(OWNER_SECOND_PEER_ID);
    const tied = pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    answer();
    await serving;
    await refresh;
    await tied;
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, OWNER_PEER_ID]);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
    core.stop.abort();

    // A refresh that installs nothing: the node tied while it ran is asked once it ends.
    const away = await peerNode([...OWNER_DECLARATION]);
    away.answer = 'fail';
    const lone = coreNode(peersOf([[OWNER_PEER_ID, away], [OWNER_SECOND_PEER_ID, await peerNode([...OWNER_DECLARATION])]]), {
      connected: [OWNER_PEER_ID, OWNER_SECOND_PEER_ID], ownerNodes: [OWNER_PEER_ID], seedPeers: [],
    });
    await expect(ensureCoreHostedDefinition(lone.agent, contextGraphId, 'recorded')).resolves.toBe('not-found');
    clock.mockReturnValue(now + 2 * (CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS + 1));
    const loneShare = await ownerShare(OWNER_SECOND_PEER_ID, { signedAt: Date.now() });
    const slow = holdFetchesFrom(lone, OWNER_PEER_ID);
    const loneServing = refreshCoreHostedDefinitionBeforeServing(lone.agent, contextGraphId);
    await until(() => slow.held() === 1);
    noteCoreHostedOwnerShare(lone.agent, loneShare, OWNER_SECOND_PEER_ID);
    slow.release();
    await loneServing;
    await pendingCoreHostedDefinitionHint(lone.agent, contextGraphId);
    expect(askedPeers(lone.fetchSyncPages)).toEqual([OWNER_PEER_ID, OWNER_PEER_ID, OWNER_SECOND_PEER_ID]);
    await expect(holdsCoreHostedOwnerDefinition(lone.store, contextGraphId, OWNER)).resolves.toBe(true);
    expect(hasPendingCoreHostedDefinitionRetry(lone.agent, contextGraphId)).toBe(false);
    lone.stop.abort();
  });

  it('clears the held mark and retries when the tied node\'s copy replaces the owner\'s declaration installed while its fetch ran', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    // The owner's second node holds the chain's facts only.
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OWNER_SECOND_PEER_ID, await peerNode([...CANONICAL_CHAIN_FACTS])]]), {
      connected: [OWNER_PEER_ID, OWNER_SECOND_PEER_ID], ownerNodes: [OWNER_PEER_ID], seedPeers: [],
    });
    // The tied node's fetch finds the definition missing, and goes on only after an attempt installed it.
    const share = await ownerShare(OWNER_SECOND_PEER_ID);
    const query = core.store.query.bind(core.store);
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(core.store, 'query').mockImplementationOnce(async (...args) => {
      const result = await query(...args);
      await resumed;
      return result;
    });
    noteCoreHostedOwnerShare(core.agent, share, OWNER_SECOND_PEER_ID);
    const tied = pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    expect(tied).toBeDefined();
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID]);

    // The owner's node stops answering; the tied node's copy, the chain's facts, replaces the declaration.
    owner.answer = 'fail';
    resume();
    await tied;
    await pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId);
    expect(askedPeers(core.fetchSyncPages).slice(0, 2)).toEqual([OWNER_PEER_ID, OWNER_SECOND_PEER_ID]);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(false);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(true);

    // The owner's node answers again: the retry installs its declaration.
    owner.answer = 'complete';
    await vi.advanceTimersByTimeAsync(CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[0]!);
    await pendingCoreHostedDefinitionRefresh(core.agent, contextGraphId);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
    core.stop.abort();
  });

  it('clears the held mark when an attempt\'s copy replaces the declaration the tied node\'s fetch installed meanwhile, and asks that node again', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OTHER_PEER_ID, await peerNode([...CANONICAL_CHAIN_FACTS])]]), {
      connected: [OWNER_PEER_ID, OTHER_PEER_ID], ownerNodes: [], seedPeers: [OTHER_PEER_ID],
    });
    // The tied node is slow to answer its fetch; an attempt asks the connected peer meanwhile, after it.
    const serve = core.fetchSyncPages.getMockImplementation()!;
    let answerOwner!: () => void;
    let answerPeer!: () => void;
    const ownerAnswers = new Promise<void>((resolve) => { answerOwner = resolve; });
    const peerAnswers = new Promise<void>((resolve) => { answerPeer = resolve; });
    core.fetchSyncPages.mockImplementation(async (...args) => {
      await (args[1] === OWNER_PEER_ID ? ownerAnswers : peerAnswers);
      return serve(...args);
    });
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    const tied = pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    await until(() => core.fetchSyncPages.mock.calls.length === 1);
    const attempt = ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded');
    await until(() => vi.mocked(core.surface.resolveRfc64UnregisteredAuthoritySeedPeersV1).mock.calls.length === 1);
    // The tied node installs the owner's declaration; then the peer's copy, the chain's facts, replaces it.
    answerOwner();
    await tied;
    answerPeer();
    await expect(attempt).resolves.toBe('not-found');
    await pendingCoreHostedDefinitionHint(core.agent, contextGraphId);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID, OTHER_PEER_ID, OWNER_PEER_ID]);
    await expect(holdsCoreHostedOwnerDefinition(core.store, contextGraphId, OWNER)).resolves.toBe(true);
    expect(hasPendingCoreHostedDefinitionRetry(core.agent, contextGraphId)).toBe(false);
    core.stop.abort();
  });

  it('lets a member that reaches only the Core write into the owner\'s new sub-graph right after the owner\'s first StorageACK', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(REPORTS)]);
    const others = await Promise.all([OTHER_PEER_ID, STRANGER_PEER_ID].map(() => peerNode()));
    // The graph was created minutes ago: no registry entry names the owner, and the window misses it.
    const core = coreNode(peersOf([[OWNER_PEER_ID, owner], [OTHER_PEER_ID, others[0]!], [STRANGER_PEER_ID, others[1]!]]), {
      connected: [OTHER_PEER_ID, STRANGER_PEER_ID, OWNER_PEER_ID], ownerNodes: [], seedPeers: [OTHER_PEER_ID, STRANGER_PEER_ID], hosted: false,
    });
    // The owner's share, then its first StorageACK, which makes the Core host the graph.
    noteCoreHostedOwnerShare(core.agent, await ownerShare(OWNER_PEER_ID), OWNER_PEER_ID);
    core.surface.subscribedContextGraphs.get(contextGraphId)!.coreHosted = true;
    await expect(ensureCoreHostedDefinition(core.agent, contextGraphId, 'recorded')).resolves.toBe('fetched');
    noteCoreHostedStorageAck(core.agent, contextGraphId, OWNER_PEER_ID);

    // The member holds the chain's facts only, cannot name the owner, and is connected to the Core only.
    const member = memberNode(peersOf([[CORE_PEER_ID, core.node]]), { connected: [CORE_PEER_ID], owner: undefined });
    await member.store.insert(CANONICAL_CHAIN_FACTS);
    const publisher = await memberPublisher(member);
    await expect(firstWrite(publisher, 'report-1', REPORTS)).resolves.toBeUndefined();
    await expect(hasSubGraphRegistration(member.store, contextGraphId, REPORTS)).resolves.toBe(true);
    expect(askedPeers(member.fetchSyncPages)).toEqual([CORE_PEER_ID]);
    expect(askedPeers(core.fetchSyncPages)).toEqual([OWNER_PEER_ID]);
  });
});
