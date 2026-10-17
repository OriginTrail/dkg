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
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  DKG_ONTOLOGY,
  generateEd25519Keypair,
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
  ensureCoreHostedDefinition,
  hasPendingCoreHostedDefinitionRetry,
  holdsCoreHostedOwnerDefinition,
  pendingCoreHostedDefinitionRefresh,
  refreshCoreHostedDefinitionBeforeServing,
} from '../src/core-hosted-definition.js';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';
import { Rfc64MetaBootstrapMethods } from '../src/dkg-agent-rfc64-meta-bootstrap.js';
import { Rfc64SeedFetchMethods } from '../src/dkg-agent-rfc64-seed-fetch.js';
import {
  PEER_SUB_GRAPH_REGISTRATION_LIMIT,
  SUB_GRAPH_RESOLUTION_MAX_PEERS,
} from '../src/peer-sub-graph-registration.js';
import { readDurableMetaPage } from '../src/sync/responder/graph-plan.js';

const OWNER = new ethers.Wallet(`0x${'95'.repeat(32)}`).address.toLowerCase() as EvmAddressV1;
const STRANGER = new ethers.Wallet(`0x${'96'.repeat(32)}`).address.toLowerCase();
const MEMBER = new ethers.Wallet(`0x${'97'.repeat(32)}`).address;
const OWNER_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const CORE_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const SECOND_CORE_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const STRANGER_PEER_ID = '12D3KooWRBhwfeP2Y4TCx1SM6s9rUoHhR5STiGwxBhgFRcw3UERE';
const OTHER_PEER_ID = '12D3KooWJWEKvSFbben74C7H4YtKjhPMTDxd7gP7zxWSUEeF27st';
const MEMBER_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
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
    await pendingCoreHostedDefinitionRefresh(core.agent);
    await expect(hasSubGraphRegistration(core.store, contextGraphId, REPORTS)).resolves.toBe(true);
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
