// SPDX-License-Identifier: Apache-2.0

/**
 * #3293: a member's first write into a named sub-graph of a public graph
 * registered on chain.
 *
 * The graph's owner registers the sub-graph (`createSubGraph`, what POST
 * /api/sub-graph/create does), a member subscribes and pulls the graph's
 * definition from a connected peer (the RFC-64 metadata bootstrap, #3264),
 * and the member's first write names the sub-graph. The write was refused
 * ("Sub-graph ... has not been registered", HTTP 500 at the routes) until
 * shared memory of that sub-graph reached the member by sync: the definition
 * the member installed left out the owner's sub-graph registrations, although
 * the peer served them in the same `_meta` pages.
 *
 * Now the member registers the sub-graphs that come with the definition, and
 * a write into a sub-graph it still does not know asks the graph's owner and
 * connected peers before it is refused (`peer-sub-graph-registration.ts`).
 *
 * The member here runs the real bootstrap, curator-refresh and resolution
 * code over a fake agent surface (as in
 * rfc64-meta-bootstrap-registered-public.test.ts) and writes through a real
 * publisher over its own store, wired to the agent as `DKGAgent.create` wires
 * it. Each peer's `_meta` is served as that peer's store holds it.
 */
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  createOperationContext,
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
  SUB_GRAPH_NOT_FOUND_CODE,
  SubGraphNotFoundError,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';
import { Rfc64MetaBootstrapMethods } from '../src/dkg-agent-rfc64-meta-bootstrap.js';
import {
  learnPeerSubGraphs,
  PEER_SUB_GRAPH_CREATED_BY_FALLBACK,
  PEER_SUB_GRAPH_REGISTRATION_LIMIT,
  readPeerSubGraphRegistrations,
  registerPeerSubGraphs,
  resolveUnregisteredSubGraphFromPeers,
  SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS,
  SUB_GRAPH_RESOLUTION_MAX_PEERS,
  SUB_GRAPH_RESOLUTION_MISS_COOLDOWN_MS,
  SUB_GRAPH_RESOLUTION_REMEMBERED_MISSES,
} from '../src/peer-sub-graph-registration.js';

const OWNER = new ethers.Wallet(`0x${'93'.repeat(32)}`).address.toLowerCase() as EvmAddressV1;
const MEMBER = new ethers.Wallet(`0x${'94'.repeat(32)}`).address;
const OWNER_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const CORE_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const OTHER_PEER_IDS = [
  '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
  '12D3KooWRBhwfeP2Y4TCx1SM6s9rUoHhR5STiGwxBhgFRcw3UERE',
  '12D3KooWJWEKvSFbben74C7H4YtKjhPMTDxd7gP7zxWSUEeF27st',
];
const MEMBER_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const ON_CHAIN_ID = '11';
const contextGraphId = `${OWNER}/one-graph` as ContextGraphIdV1;
const SUB_GRAPH = 'reports';
const metaGraph = contextGraphMetaGraphUri(contextGraphId);
const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
const registeredProof = Object.freeze({ contextGraphId, onChainId: ON_CHAIN_ID });
const NAME = 'http://schema.org/name';
const CREATED_BY = 'http://dkg.io/ontology/createdBy';

function rootQuad(predicate: string, object: string): Quad {
  return { subject: contextGraphUri, predicate, object, graph: metaGraph };
}

/** The owner's root declaration of the registered public graph, chain claims included. */
const OWNER_DECLARATION: readonly Quad[] = Object.freeze([
  rootQuad(DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
  rootQuad(DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"public"'),
  rootQuad(DKG_ONTOLOGY.DKG_CURATOR, `did:dkg:agent:${OWNER}`),
  rootQuad(DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, '"registered"'),
  rootQuad(`${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, `"${ON_CHAIN_ID}"`),
]);

/** The rows `createSubGraph` on `createdBy`'s node writes into the graph's `_meta`. */
function subGraphRegistration(subGraphName: string, createdBy = OWNER_PEER_ID): Quad[] {
  return generateSubGraphRegistration({
    contextGraphId,
    subGraphName,
    createdBy,
    description: 'Reports of the graph',
    timestamp: new Date('2026-10-16T08:00:00.000Z'),
  });
}

const stores: OxigraphStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function openStore(): OxigraphStore {
  const store = new OxigraphStore();
  stores.push(store);
  return store;
}

/** A peer of the graph: its `_meta` as it serves it, read from its store on each request. */
interface PeerNode {
  readonly store: OxigraphStore;
  /** `incomplete` answers with a partial page; `fail` refuses the request. */
  answer: 'complete' | 'incomplete' | 'fail';
}

async function peerNode(rows: readonly Quad[]): Promise<PeerNode> {
  const store = openStore();
  if (rows.length > 0) await store.insert([...rows]);
  return { store, answer: 'complete' };
}

async function servedMeta(peer: PeerNode): Promise<Quad[]> {
  const result = await peer.store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error('expected the peer\'s _meta rows');
  return result.bindings.map((row) => ({ subject: row['s']!, predicate: row['p']!, object: row['o']!, graph: metaGraph }));
}

/**
 * Peers that answer a `_meta` fetch page by page and keep one metadata session
 * per requester and graph, as a responder does (`prepareResponderSession`):
 * each fresh fetch opens a new session, and a page of a session that another
 * fetch replaced is refused. `most` is the most fetches that ran at once.
 */
function pagedMetaPeers(peers: ReadonlyMap<string, PeerNode>, pageSize = 2) {
  const sessions = new Map<string, symbol>();
  const stats = { running: 0, most: 0 };
  const fetch = async (
    _ctx: OperationContext,
    peerId: string,
    _contextGraphId: string,
    _includeSharedMemory: boolean,
    _phase: string,
    _graphUri: string,
    _deadline: number,
    _options?: { forceFreshSession?: boolean; signal?: AbortSignal },
  ) => {
    const session = Symbol(peerId);
    sessions.set(peerId, session);
    stats.running += 1;
    stats.most = Math.max(stats.most, stats.running);
    try {
      const quads = await servedMeta(peers.get(peerId)!);
      for (let offset = 0; offset < quads.length; offset += pageSize) {
        // A page is a round trip: long enough for any other fetch to start meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (sessions.get(peerId) !== session) throw new Error('Durable meta sync session was superseded before page completion');
      }
      return { quads, checkpointKey: `meta-checkpoint-${peerId}`, resumedFromOffset: 0, completed: true };
    } finally {
      stats.running -= 1;
    }
  };
  return { fetch, stats };
}

interface MemberOptions {
  /** The connected peers in the order the node's peer selection returns them. */
  readonly connected?: readonly string[];
  /** The peer the member resolves as the graph's owner. */
  readonly owner?: string;
  readonly subscribed?: boolean;
  readonly localAuthor?: boolean;
}

/**
 * A member subscribed to the graph. `peers` serves each peer's `_meta`; the
 * owner is the only connected peer unless the options say otherwise.
 */
function memberNode(peers: ReadonlyMap<string, PeerNode>, options: MemberOptions = {}) {
  const store = openStore();
  const writeLocks = new Map<string, Promise<void>>();
  const syncCheckpoints = new Map<string, number>();
  const fetchSyncPages = vi.fn(async (
    _ctx: OperationContext,
    peerId: string,
    _contextGraphId: string,
    _includeSharedMemory: boolean,
    _phase: string,
    _graphUri: string,
    _deadline: number,
    _options?: { forceFreshSession?: boolean; signal?: AbortSignal },
  ) => {
    const peer = peers.get(peerId);
    if (peer === undefined || peer.answer === 'fail') throw new Error(`dial to ${peerId.slice(-8)} failed`);
    const quads = await servedMeta(peer);
    // The page fetch records where it stopped.
    syncCheckpoints.set(`meta-checkpoint-${peerId}`, quads.length);
    return {
      quads: peer.answer === 'incomplete' ? quads.slice(0, 1) : quads,
      checkpointKey: `meta-checkpoint-${peerId}`,
      resumedFromOffset: 0,
      completed: peer.answer === 'complete',
    };
  });
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const owner = 'owner' in options ? options.owner : OWNER_PEER_ID;
  const surface = {
    store,
    log,
    peerId: MEMBER_PEER_ID,
    writeLocks,
    localContextGraphProvenance: { hasLocalCreate: () => options.localAuthor === true },
    subscribedContextGraphs: new Map([[contextGraphId, { subscribed: options.subscribed !== false }]]),
    readAcceptedRfc64CatalogAccessSnapshotV1: () => null,
    hasConfirmedMetaState: vi.fn(async () => true),
    resolveRfc64UnregisteredAuthoritySeedPeersV1: vi.fn(() => [...(options.connected ?? [OWNER_PEER_ID])]),
    resolveCuratorPeerId: vi.fn(async () => owner),
    refreshMetaSyncedFlags: vi.fn(async () => undefined),
    metaRefreshTimestamps: new Map<string, number>(),
    runContextGraphSyncWithBackpressure: vi.fn(async <T>(
      _ctx: OperationContext,
      _contextGraphId: string,
      _lane: 'durable',
      _label: string,
      work: () => Promise<T>,
    ): Promise<T> => work()),
    node: { libp2p: { getConnections: () => (options.connected ?? [OWNER_PEER_ID]).map((peerId) => ({ remotePeer: { toString: () => peerId } })) } },
    discovery: {},
    fetchSyncPages,
    oversizeTombstoneLog: { record: () => undefined },
    invalidateListContextGraphsCache: () => undefined,
    contextGraphMetaProjection: { markDirty: vi.fn() },
    bindSubscriptionOnChainId: vi.fn(),
    recordCgWireId: vi.fn(),
    persistContextGraphSubscription: vi.fn(),
    syncCheckpoints,
    // The real agent method the publisher's resolver calls (`DKGAgent.create`).
    resolveSubGraphRegistration: ContextGraphRegistryMethods.prototype.resolveSubGraphRegistration,
  };
  // The real method chain over this surface; own data properties shadow the
  // base class accessors.
  const agent = Object.defineProperties(
    Object.create(Rfc64MetaBootstrapMethods.prototype) as object,
    Object.getOwnPropertyDescriptors(surface),
  ) as unknown as DKGAgent;
  return { agent, store, writeLocks, fetchSyncPages, log, surface };
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
    [{ subject: `urn:dkg:test-3293:${name}`, predicate: NAME, object: `"${name}"`, graph: '' }],
    subGraphName,
  );
}

function bootstrap(member: ReturnType<typeof memberNode>) {
  return member.agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(contextGraphId, undefined, registeredProof);
}

async function createdByOf(store: OxigraphStore, subGraphName: string): Promise<string[]> {
  const result = await store.query(
    `SELECT ?by WHERE { GRAPH <${metaGraph}> { <${contextGraphUri}/${subGraphName}> <${CREATED_BY}> ?by } }`,
  );
  if (result.type !== 'bindings') throw new Error('expected bindings');
  return result.bindings.map((row) => row['by']!);
}

const peersOf = (entries: Array<[string, PeerNode]>) => new Map(entries);

describe('a member\'s first write into a sub-graph of a registered public graph (#3293)', () => {
  it('learns the owner\'s sub-graph with the graph\'s definition, and its first write goes into it', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));

    await expect(bootstrap(member)).resolves.toBe('fetched');

    const publisher = await memberPublisher(member);
    await expect(firstWrite(publisher, 'report-1', SUB_GRAPH)).resolves.toBeUndefined();
    await expect(hasSubGraphRegistration(member.store, contextGraphId, SUB_GRAPH)).resolves.toBe(true);
    // Learned with the definition: the write asked nobody.
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();
    // As the owner registered it, not as the member found it.
    await expect(createdByOf(member.store, SUB_GRAPH)).resolves.toEqual([`did:dkg:agent:${OWNER_PEER_ID}`]);
    expect(member.surface.contextGraphMetaProjection.markDirty).toHaveBeenCalledWith(contextGraphId);
    expect(member.log.info.mock.calls.map((call) => String(call[1])))
      .toContainEqual(expect.stringContaining(`Registered sub-graph(s) "${SUB_GRAPH}" of context graph`));
  });

  it('asks the owner on its first write into a sub-graph the owner registered after the member got the definition', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(bootstrap(member)).resolves.toBe('fetched');
    await expect(hasSubGraphRegistration(member.store, contextGraphId, SUB_GRAPH)).resolves.toBe(false);

    await owner.store.insert(subGraphRegistration(SUB_GRAPH));
    const publisher = await memberPublisher(member);
    await expect(firstWrite(publisher, 'report-1', SUB_GRAPH)).resolves.toBeUndefined();

    await expect(hasSubGraphRegistration(member.store, contextGraphId, SUB_GRAPH)).resolves.toBe(true);
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(2);
    const [, peerId, graphId, includeSharedMemory, phase, graphUri, , fetchOptions] = member.fetchSyncPages.mock.calls[1]!;
    expect({ peerId, graphId, includeSharedMemory, phase, graphUri }).toEqual({
      peerId: OWNER_PEER_ID, graphId: contextGraphId, includeSharedMemory: false, phase: 'meta', graphUri: metaGraph,
    });
    expect(fetchOptions).toMatchObject({ forceFreshSession: true });
    // Admitted through the node's sync scheduler, as the curator metadata refresh is.
    expect(member.surface.runContextGraphSyncWithBackpressure).toHaveBeenLastCalledWith(
      expect.anything(), contextGraphId, 'durable', 'durable:control-plane', expect.any(Function),
      expect.objectContaining({ source: 'control-plane' }),
    );
    // The fetch leaves no resumable meta checkpoint behind.
    expect(member.surface.syncCheckpoints.has(`meta-checkpoint-${OWNER_PEER_ID}`)).toBe(false);
    // A second write into it asks nobody.
    await expect(firstWrite(publisher, 'report-2', SUB_GRAPH)).resolves.toBeUndefined();
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(2);
  });

  it('refuses a write into a sub-graph no peer holds with SUB_GRAPH_NOT_FOUND, and asks again only after the cooldown', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(bootstrap(member)).resolves.toBe('fetched');
    const publisher = await memberPublisher(member);

    const refusal = await firstWrite(publisher, 'typo-1', 'reprots').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SubGraphNotFoundError);
    expect(refusal).toMatchObject({ code: SUB_GRAPH_NOT_FOUND_CODE, contextGraphId, subGraphName: 'reprots' });
    expect((refusal as Error).message).toContain('Sub-graph "reprots" has not been registered');
    expect((refusal as Error).message).toContain('none of the 1 peer(s) of the context graph asked holds it');
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(2);
    await expect(hasSubGraphRegistration(member.store, contextGraphId, 'reprots')).resolves.toBe(false);

    await expect(firstWrite(publisher, 'typo-2', 'reprots')).rejects.toThrow(
      /\(asked \d+ s ago: none of the 1 peer\(s\) of the context graph asked holds it\)/,
    );
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(2);

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS + 1);
    await owner.store.insert(subGraphRegistration('reprots'));
    // A sub-graph no peer held is remembered longer than a failed lookup.
    await expect(firstWrite(publisher, 'typo-3', 'reprots')).rejects.toBeInstanceOf(SubGraphNotFoundError);
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(now + SUB_GRAPH_RESOLUTION_MISS_COOLDOWN_MS + 1);
    await expect(firstWrite(publisher, 'typo-4', 'reprots')).resolves.toBeUndefined();
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(3);
  });

  it('asks the owner first, then connected peers, at most three, and takes the sub-graph from whichever holds it', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH, CORE_PEER_ID)]);
    const others = await Promise.all(OTHER_PEER_IDS.map(() => peerNode([...OWNER_DECLARATION])));
    const member = memberNode(
      peersOf([[OWNER_PEER_ID, owner], [CORE_PEER_ID, core], ...OTHER_PEER_IDS.map((id, i) => [id, others[i]!] as [string, PeerNode])]),
      { connected: [OTHER_PEER_IDS[0]!, OWNER_PEER_ID, MEMBER_PEER_ID, CORE_PEER_ID, OTHER_PEER_IDS[1]!, OTHER_PEER_IDS[2]!] },
    );
    await member.store.insert([...OWNER_DECLARATION]);

    await expect(member.agent.resolveSubGraphRegistration(contextGraphId, SUB_GRAPH)).resolves.toEqual({ registered: true });
    expect(member.fetchSyncPages.mock.calls.map((call) => call[1])).toEqual([OWNER_PEER_ID, OTHER_PEER_IDS[0], CORE_PEER_ID]);
    await expect(createdByOf(member.store, SUB_GRAPH)).resolves.toEqual([`did:dkg:agent:${CORE_PEER_ID}`]);

    member.fetchSyncPages.mockClear();
    const missing = await member.agent.resolveSubGraphRegistration(contextGraphId, 'drafts');
    expect(missing).toEqual({ registered: false, detail: 'none of the 3 peer(s) of the context graph asked holds it' });
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(SUB_GRAPH_RESOLUTION_MAX_PEERS);
  });

  it('asks the connected peers when it cannot name the owner, and only them', async () => {
    const core = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const member = memberNode(peersOf([[CORE_PEER_ID, core]]), { owner: undefined, connected: [CORE_PEER_ID] });
    member.surface.resolveCuratorPeerId.mockRejectedValueOnce(new Error('registry unavailable'));

    await expect(member.agent.resolveSubGraphRegistration(contextGraphId, SUB_GRAPH)).resolves.toEqual({ registered: true });
    expect(member.fetchSyncPages.mock.calls.map((call) => call[1])).toEqual([CORE_PEER_ID]);
  });

  it('says why when no peer could be asked, and asks again shortly after', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    owner.answer = 'fail';
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const failed = `no peer of the context graph could be asked: dial to ${OWNER_PEER_ID.slice(-8)} failed`;

    await expect(member.agent.resolveSubGraphRegistration(contextGraphId, SUB_GRAPH)).resolves.toEqual({ registered: false, detail: failed });
    expect(String(member.log.warn.mock.calls.at(-1)?.[1])).toContain(`Could not look up sub-graph "${SUB_GRAPH}"`);
    // A write retried at once is answered without asking again.
    await expect(member.agent.resolveSubGraphRegistration(contextGraphId, SUB_GRAPH)).resolves.toEqual({
      registered: false, detail: `asked 0 s ago: ${failed}`,
    });
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();

    owner.answer = 'incomplete';
    clock.mockReturnValue(now + SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS + 1);
    await expect(member.agent.resolveSubGraphRegistration(contextGraphId, SUB_GRAPH)).resolves.toEqual({
      registered: false,
      detail: `no peer of the context graph could be asked: peer ${OWNER_PEER_ID.slice(-8)} sent an incomplete answer`,
    });

    owner.answer = 'complete';
    clock.mockReturnValue(now + 2 * (SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS + 1));
    await expect(member.agent.resolveSubGraphRegistration(contextGraphId, SUB_GRAPH)).resolves.toEqual({ registered: true });
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(3);
  });

  it('asks nobody for a graph it created, a graph it does not follow, a system graph, or with no peer to ask', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const peers = peersOf([[OWNER_PEER_ID, owner]]);

    const author = memberNode(peers, { localAuthor: true });
    await expect(author.agent.resolveSubGraphRegistration(contextGraphId, SUB_GRAPH)).resolves.toMatchObject({
      registered: false, detail: expect.stringContaining('created the context graph'),
    });
    const stranger = memberNode(peers, { subscribed: false });
    await expect(stranger.agent.resolveSubGraphRegistration(contextGraphId, SUB_GRAPH)).resolves.toMatchObject({
      registered: false, detail: expect.stringContaining('does not follow the context graph'),
    });
    const system = memberNode(peers);
    await expect(resolveUnregisteredSubGraphFromPeers(system.agent, 'ontology', SUB_GRAPH)).resolves.toMatchObject({
      registered: false, detail: expect.stringContaining('system context graph'),
    });
    const alone = memberNode(peers, { owner: undefined, connected: [] });
    await expect(alone.agent.resolveSubGraphRegistration(contextGraphId, SUB_GRAPH)).resolves.toEqual({
      registered: false, detail: 'no peer of the context graph was there to ask',
    });
    for (const node of [author, stranger, system, alone]) expect(node.fetchSyncPages).not.toHaveBeenCalled();
  });

  it(`remembers at most ${SUB_GRAPH_RESOLUTION_REMEMBERED_MISSES} unresolved sub-graphs, forgetting the oldest first`, async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    owner.answer = 'fail';
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    const names = Array.from({ length: SUB_GRAPH_RESOLUTION_REMEMBERED_MISSES + 1 }, (_, i) => `missing-${i}`);
    for (const name of names) await resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, name);
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(names.length);

    // The newest is still remembered; the oldest was forgotten and is asked for again.
    await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, names.at(-1)!))
      .resolves.toMatchObject({ detail: expect.stringMatching(/^asked \d+ s ago: /) });
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(names.length);
    await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, names[0]!))
      .resolves.toMatchObject({ detail: expect.stringMatching(/^no peer of the context graph could be asked/) });
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(names.length + 1);
  });

  it('finds the sub-graph a write names past the first registrations the definition brought, however many the owner has', async () => {
    // s0000 to s0257: the definition brings the first 256 in name order.
    const names = Array.from({ length: PEER_SUB_GRAPH_REGISTRATION_LIMIT + 2 }, (_, i) => `s${String(i).padStart(4, '0')}`);
    const owner = await peerNode([...OWNER_DECLARATION, ...names.flatMap((name) => subGraphRegistration(name))]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(bootstrap(member)).resolves.toBe('fetched');
    const [beyond, last] = names.slice(PEER_SUB_GRAPH_REGISTRATION_LIMIT);
    await expect(hasSubGraphRegistration(member.store, contextGraphId, names[PEER_SUB_GRAPH_REGISTRATION_LIMIT - 1]!)).resolves.toBe(true);
    await expect(hasSubGraphRegistration(member.store, contextGraphId, last!)).resolves.toBe(false);

    const publisher = await memberPublisher(member);
    await expect(firstWrite(publisher, 'report-last', last!)).resolves.toBeUndefined();
    await expect(hasSubGraphRegistration(member.store, contextGraphId, last!)).resolves.toBe(true);
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(2);
    // The lookup took what the write named; what the definition left out stays out.
    await expect(hasSubGraphRegistration(member.store, contextGraphId, beyond!)).resolves.toBe(false);
  });

  it('lets first writes into two sub-graphs at once through, without either lookup superseding the other\'s session at the owner', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    await expect(bootstrap(member)).resolves.toBe('fetched');
    // Registered after the member got the definition: each write has to ask the owner.
    await owner.store.insert([...subGraphRegistration(SUB_GRAPH), ...subGraphRegistration('drafts')]);
    const peers = pagedMetaPeers(peersOf([[OWNER_PEER_ID, owner]]));
    member.fetchSyncPages.mockImplementation(peers.fetch);
    const publisher = await memberPublisher(member);

    await expect(Promise.all([firstWrite(publisher, 'report-1', SUB_GRAPH), firstWrite(publisher, 'draft-1', 'drafts')]))
      .resolves.toEqual([undefined, undefined]);

    await expect(hasSubGraphRegistration(member.store, contextGraphId, SUB_GRAPH)).resolves.toBe(true);
    await expect(hasSubGraphRegistration(member.store, contextGraphId, 'drafts')).resolves.toBe(true);
    expect(peers.stats.most).toBe(1);
    expect(member.log.warn).not.toHaveBeenCalled();
  });

  it('never runs two fresh metadata fetches from one peer for one graph at once: lookups and the definition pull take turns', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH), ...subGraphRegistration('drafts')]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    const peers = pagedMetaPeers(peersOf([[OWNER_PEER_ID, owner]]));
    member.fetchSyncPages.mockImplementation(peers.fetch);

    // Two writes into two sub-graphs and the definition pull, all at once: each
    // opens a fresh session at the owner, and a second one supersedes the first.
    const [reports, drafts, definition] = await Promise.all([
      resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH),
      resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, 'drafts'),
      bootstrap(member),
    ]);

    expect(reports).toEqual({ registered: true });
    expect(drafts).toEqual({ registered: true });
    expect(definition).toBe('fetched');
    expect(peers.stats.most).toBe(1);
  });

  it('registers the sub-graphs that writes queued behind a lookup wait for, so they do not ask again', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH), ...subGraphRegistration('drafts')]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    const serve = member.fetchSyncPages.getMockImplementation()!;
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    member.fetchSyncPages.mockImplementationOnce(async (...args) => {
      await answered;
      return serve(...args);
    });

    const reports = resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH);
    await vi.waitFor(() => expect(member.fetchSyncPages).toHaveBeenCalledOnce());
    // A write into another sub-graph comes while the owner is asked.
    const drafts = resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, 'drafts');
    await new Promise((resolve) => setImmediate(resolve));
    answer();

    await expect(reports).resolves.toEqual({ registered: true });
    await expect(drafts).resolves.toEqual({ registered: true });
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();
  });

  it('ends a resolution within its budget while a registration of the sub-graph holds the lock, and lets the write through after', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    let release!: () => void;
    member.writeLocks.set(
      `${contextGraphId}\0${SUB_GRAPH}\0sub-graph-registration`,
      new Promise<void>((resolve) => { release = resolve; }),
    );
    try {
      // The owner answers at once; only the lock keeps the registration waiting.
      await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH, { timeoutMs: 20 }))
        .resolves.toEqual({ registered: false, detail: 'no peer of the context graph could be asked: out of time' });
      expect(member.fetchSyncPages).toHaveBeenCalledOnce();
      await expect(hasSubGraphRegistration(member.store, contextGraphId, SUB_GRAPH)).resolves.toBe(false);
    } finally {
      release();
    }
    // The registration it started completes once the lock is free, and the write tried again goes through.
    await vi.waitFor(async () => {
      await expect(hasSubGraphRegistration(member.store, contextGraphId, SUB_GRAPH)).resolves.toBe(true);
    });
    await expect(firstWrite(await memberPublisher(member), 'report-1', SUB_GRAPH)).resolves.toBeUndefined();
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();
  });

  it('ends a resolution within its budget when the check after the registration does not return', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    let registered = false;
    member.log.info.mockImplementation((_ctx: unknown, message: unknown) => {
      if (String(message).startsWith('Registered sub-graph(s)')) registered = true;
    });
    let answer!: () => void;
    const stalled = new Promise<void>((resolve) => { answer = resolve; });
    const query = member.store.query.bind(member.store);
    // The store stops answering once the registration is in.
    vi.spyOn(member.store, 'query').mockImplementation(async (...args: Parameters<OxigraphStore['query']>) => {
      if (registered) await stalled;
      return query(...args);
    });
    try {
      await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH, { timeoutMs: 20 }))
        .resolves.toEqual({ registered: false, detail: 'no peer of the context graph could be asked: out of time' });
      expect(registered).toBe(true);
    } finally {
      answer();
    }
    // The next resolution waits for that lookup to end and finds what it registered, without asking again.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS + 1);
    await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH)).resolves.toEqual({ registered: true });
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();
  });

  it('ends a resolution that waits behind another lookup of the graph within its own budget, and its lookup never starts', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH), ...subGraphRegistration('drafts')]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    const serve = member.fetchSyncPages.getMockImplementation()!;
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    member.fetchSyncPages.mockImplementationOnce(async (...args) => {
      await answered;
      return serve(...args);
    });
    const reports = resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH);
    await vi.waitFor(() => expect(member.fetchSyncPages).toHaveBeenCalledOnce());

    try {
      await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, 'drafts', { timeoutMs: 20 }))
        .resolves.toEqual({ registered: false, detail: 'no peer of the context graph could be asked: out of time' });
    } finally {
      answer();
    }
    await expect(reports).resolves.toEqual({ registered: true });
    await expect(hasSubGraphRegistration(member.store, contextGraphId, 'drafts')).resolves.toBe(false);
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();
  });

  it('passes a store failure during the lookup on to the write, and asks again on the next one', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    vi.spyOn(member.store, 'insert').mockRejectedValueOnce(new Error('store unavailable'));

    await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH)).rejects.toThrow('store unavailable');
    await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH)).resolves.toEqual({ registered: true });
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(2);
  });

  it('runs one resolution of a sub-graph at a time and lets concurrent writes share it', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));

    const [first, second] = await Promise.all([
      resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH),
      resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH),
    ]);
    expect(first).toEqual({ registered: true });
    expect(second).toBe(first);
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();
  });

  it('ends a resolution that runs out of time within its budget, though the peer\'s fetch ignores the end, and asks again on the next write', async () => {
    const owner = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner]]));
    // A peer that answers only when the test lets it, over a fetch that does not stop when asked to.
    const serve = member.fetchSyncPages.getMockImplementation()!;
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    member.fetchSyncPages.mockImplementationOnce(async (...args) => {
      await answered;
      return serve(...args);
    });

    try {
      await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH, { timeoutMs: 20 }))
        .resolves.toEqual({ registered: false, detail: 'no peer of the context graph could be asked: out of time' });
      // The wait for sync capacity has the same budget, and it has ended.
      const admission = member.surface.runContextGraphSyncWithBackpressure.mock.calls[0]?.[5] as
        { operationSignal?: AbortSignal; source?: string } | undefined;
      expect(admission).toMatchObject({ operationSignal: expect.any(AbortSignal), source: 'control-plane' });
      expect(admission?.operationSignal?.aborted).toBe(true);
    } finally {
      answer();
    }
    // The answer that came too late registered nothing.
    await expect(hasSubGraphRegistration(member.store, contextGraphId, SUB_GRAPH)).resolves.toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS + 1);
    await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH)).resolves.toEqual({ registered: true });
    expect(member.fetchSyncPages).toHaveBeenCalledTimes(2);
  });

  it('asks no further peer once the time is up, without waiting for the late answer', async () => {
    const owner = await peerNode([...OWNER_DECLARATION]);
    const core = await peerNode([...OWNER_DECLARATION, ...subGraphRegistration(SUB_GRAPH)]);
    const member = memberNode(peersOf([[OWNER_PEER_ID, owner], [CORE_PEER_ID, core]]), { connected: [OWNER_PEER_ID, CORE_PEER_ID] });
    let answer!: () => void;
    const late = new Promise<void>((resolve) => { answer = resolve; });
    // The owner answers only when the test lets it, after the budget has run out.
    member.fetchSyncPages.mockImplementationOnce(async () => {
      await late;
      throw new Error('late');
    });

    try {
      await expect(resolveUnregisteredSubGraphFromPeers(member.agent, contextGraphId, SUB_GRAPH, { timeoutMs: 20 }))
        .resolves.toEqual({ registered: false, detail: 'no peer of the context graph could be asked: out of time' });
    } finally {
      answer();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();
    await expect(hasSubGraphRegistration(member.store, contextGraphId, SUB_GRAPH)).resolves.toBe(false);
  });
});

describe('the sub-graph registrations taken from a peer\'s _meta', () => {
  const ctx = createOperationContext('sync');

  it('takes complete, well-formed registrations of the graph only, in name order', () => {
    const otherGraph = contextGraphMetaGraphUri(`${OWNER}/other`);
    const quads: Quad[] = [
      ...subGraphRegistration('zeta'),
      ...subGraphRegistration('alpha'),
      // Another graph's `_meta`, a row outside `_meta`, and the root subject.
      ...subGraphRegistration('elsewhere').map((quad) => ({ ...quad, graph: otherGraph })),
      ...subGraphRegistration('outside').map((quad) => ({ ...quad, graph: `${contextGraphUri}/outside` })),
      ...OWNER_DECLARATION,
      // A name the subject does not carry, a reserved name, an unsafe name, a name too long, a nested subject.
      ...subGraphRegistration('mismatch').map((quad) => (quad.predicate === NAME ? { ...quad, object: '"different"' } : quad)),
      ...subGraphRegistration('_private'),
      ...subGraphRegistration('context'),
      ...subGraphRegistration('x'.repeat(257)),
      { subject: `${contextGraphUri}/nested/deeper`, predicate: DKG_ONTOLOGY.RDF_TYPE, object: 'http://dkg.io/ontology/SubGraph', graph: metaGraph },
      // Typed but unnamed, named by an IRI, and named but untyped.
      { subject: `${contextGraphUri}/unnamed`, predicate: DKG_ONTOLOGY.RDF_TYPE, object: 'http://dkg.io/ontology/SubGraph', graph: metaGraph },
      { subject: `${contextGraphUri}/iri-name`, predicate: DKG_ONTOLOGY.RDF_TYPE, object: 'http://dkg.io/ontology/SubGraph', graph: metaGraph },
      { subject: `${contextGraphUri}/iri-name`, predicate: NAME, object: 'iri-name', graph: metaGraph },
      { subject: `${contextGraphUri}/untyped`, predicate: NAME, object: '"untyped"', graph: metaGraph },
    ];

    const found = readPeerSubGraphRegistrations(contextGraphId, quads);

    expect(found).toEqual([
      { name: 'alpha', createdBy: `did:dkg:agent:${OWNER_PEER_ID}`, createdAt: new Date('2026-10-16T08:00:00.000Z'), description: 'Reports of the graph' },
      { name: 'zeta', createdBy: `did:dkg:agent:${OWNER_PEER_ID}`, createdAt: new Date('2026-10-16T08:00:00.000Z'), description: 'Reports of the graph' },
    ]);
  });

  it('keeps no writer list and no creator, date or description it cannot read', () => {
    const subject = `${contextGraphUri}/plain`;
    const quads: Quad[] = [
      ...generateSubGraphRegistration({
        contextGraphId, subGraphName: 'plain', createdBy: OWNER_PEER_ID, authorizedWriters: [MEMBER], timestamp: new Date(),
      }).filter((quad) => quad.predicate !== CREATED_BY && quad.predicate !== 'http://dkg.io/ontology/createdAt'),
      { subject, predicate: CREATED_BY, object: '"not a did"', graph: metaGraph },
      { subject, predicate: 'http://dkg.io/ontology/createdAt', object: '"yesterday"', graph: metaGraph },
      { subject, predicate: 'http://schema.org/description', object: `"${'d'.repeat(1025)}"`, graph: metaGraph },
    ];

    expect(readPeerSubGraphRegistrations(contextGraphId, quads)).toEqual([
      { name: 'plain', createdBy: PEER_SUB_GRAPH_CREATED_BY_FALLBACK },
    ]);
  });

  it(`takes at most ${PEER_SUB_GRAPH_REGISTRATION_LIMIT} from one peer`, () => {
    const names = Array.from({ length: PEER_SUB_GRAPH_REGISTRATION_LIMIT + 5 }, (_, i) => `s${String(i).padStart(4, '0')}`);
    const found = readPeerSubGraphRegistrations(contextGraphId, names.flatMap((name) => subGraphRegistration(name)));
    expect(found.map((registration) => registration.name)).toEqual(names.slice(0, PEER_SUB_GRAPH_REGISTRATION_LIMIT));
  });

  it('leaves an existing registration as it is and never registers a context graph of its own', async () => {
    const store = openStore();
    await store.insert(subGraphRegistration(SUB_GRAPH, 'local-creator'));
    // `<graph>/team` is a context graph of its own on this node.
    const childUri = `${contextGraphUri}/team`;
    await store.insert([{
      subject: childUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: `${childUri}/_meta`,
    }]);
    const ports = {
      store,
      writeLocks: new Map<string, Promise<void>>(),
      contextGraphMetaProjection: { markDirty: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() },
    };
    const found = readPeerSubGraphRegistrations(contextGraphId, [
      ...subGraphRegistration(SUB_GRAPH),
      ...subGraphRegistration('team'),
      ...subGraphRegistration('drafts'),
    ]);

    await expect(registerPeerSubGraphs(ports, contextGraphId, found, OWNER_PEER_ID, ctx)).resolves.toEqual(['drafts']);
    await expect(createdByOf(store, SUB_GRAPH)).resolves.toEqual(['did:dkg:agent:local-creator']);
    await expect(hasSubGraphRegistration(store, contextGraphId, 'team')).resolves.toBe(false);
    await expect(registerPeerSubGraphs(ports, contextGraphId, found, OWNER_PEER_ID, ctx)).resolves.toEqual([]);
    expect(ports.contextGraphMetaProjection.markDirty).toHaveBeenCalledOnce();
  });

  it('logs and keeps the definition when the registration cannot be stored', async () => {
    const store = openStore();
    vi.spyOn(store, 'insert').mockRejectedValueOnce(new Error('store unavailable'));
    const ports = {
      store,
      writeLocks: new Map<string, Promise<void>>(),
      contextGraphMetaProjection: { markDirty: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() },
    };

    await expect(learnPeerSubGraphs(ports, contextGraphId, readPeerSubGraphRegistrations(contextGraphId, subGraphRegistration(SUB_GRAPH)), OWNER_PEER_ID, ctx))
      .resolves.toBeUndefined();
    expect(String(ports.log.warn.mock.calls[0]?.[1])).toContain('store unavailable');
    await expect(learnPeerSubGraphs(ports, contextGraphId, [], OWNER_PEER_ID, ctx)).resolves.toBeUndefined();
    expect(ports.log.warn).toHaveBeenCalledOnce();
  });
});
