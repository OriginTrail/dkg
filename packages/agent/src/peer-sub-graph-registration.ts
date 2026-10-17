// SPDX-License-Identifier: Apache-2.0

/**
 * Named sub-graphs a node learns from its peers' copy of a graph's `_meta`.
 *
 * A sub-graph exists as a registration in its graph's `_meta`. The owner
 * writes one with `createSubGraph` (POST /api/sub-graph/create); a node writes
 * one when content of a sub-graph reaches it (`workspace-handler.ts`, the
 * gossip publish handler, `sync/requester/synced-sub-graph-registration.ts`).
 * A node refuses a write into a sub-graph it has not registered. Nothing else
 * carried a registration, so a member of a public graph could not make the
 * first write into a sub-graph the owner had registered until content of the
 * sub-graph reached it by sync (#3293).
 *
 * A peer's `_meta` carries them: a responder serves the registrations of the
 * sub-graphs it holds in the same pages as the graph's definition
 * (`readDurableMetaPage`). This module takes them from there, in two places:
 *  - a `_meta` snapshot the node installs as the graph's definition
 *    (`curator-meta-refresh.ts`, which the RFC-64 metadata bootstrap uses)
 *    registers the sub-graphs it carries ({@link learnPeerSubGraphs});
 *  - a write that names a sub-graph this node has not registered asks the
 *    graph's owner and connected peers before it is refused
 *    ({@link resolveUnregisteredSubGraphFromPeers}, the publisher's
 *    `resolveUnregisteredSubGraph`).
 *
 * A registration is bookkeeping, not authority: nothing reads `createdBy` or
 * `authorizedWriter` to admit a write, and the live paths register a
 * sub-graph for whoever shares into it. So any peer may serve one. What is
 * taken is still bounded: complete, well-formed registrations of the graph
 * only, at most {@link PEER_SUB_GRAPH_REGISTRATION_LIMIT} per snapshot, never
 * a writer list, never a name that is a context graph of its own on this node,
 * and an existing registration is left as it is.
 */

import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  createOperationContext,
  SYSTEM_CONTEXT_GRAPHS,
  validateSubGraphName,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  ensureSubGraphRegistration,
  hasSubGraphRegistration,
  withKeyedLocks,
  type UnregisteredSubGraphResolution,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { stripLiteral } from './dkg-agent-utils.js';
import { fetchFreshContextGraphMeta, type FreshMetaFetchAgent } from './sync/requester/fresh-meta-fetch.js';
import { isKnownContextGraphUri } from './sync/requester/swm-target-executor.js';

/** The most sub-graph registrations taken from one peer's `_meta`. */
export const PEER_SUB_GRAPH_REGISTRATION_LIMIT = 256;
/** Longest sub-graph name taken from a peer (as long as an assertion name may be). */
const MAX_PEER_SUB_GRAPH_NAME_LENGTH = 256;
const MAX_PEER_SUB_GRAPH_DESCRIPTION_LENGTH = 1024;
/** `createdBy` when the peer's registration names no plain agent DID; informational only. */
export const PEER_SUB_GRAPH_CREATED_BY_FALLBACK = 'meta-discovery';
/**
 * How long one resolution may take, the wait for sync capacity included: it
 * runs inside the write that names the sub-graph.
 */
export const SUB_GRAPH_RESOLUTION_TIMEOUT_MS = 30_000;
/** Peers one resolution asks: the graph's owner first, then connected peers. */
export const SUB_GRAPH_RESOLUTION_MAX_PEERS = 3;
/** A sub-graph that no peer asked held is not asked for again for this long. */
export const SUB_GRAPH_RESOLUTION_MISS_COOLDOWN_MS = 30_000;
/** After a resolution in which no peer could be asked, so that a write retried in a loop does not ask on every try. */
export const SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS = 5_000;
/** Resolutions remembered at most; the oldest is forgotten first. */
export const SUB_GRAPH_RESOLUTION_REMEMBERED_MISSES = 1024;

// The terms `generateSubGraphRegistration` writes and the responder serves.
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SUB_GRAPH_TYPE = 'http://dkg.io/ontology/SubGraph';
const SCHEMA_NAME = 'http://schema.org/name';
const SCHEMA_DESCRIPTION = 'http://schema.org/description';
const CREATED_BY = 'http://dkg.io/ontology/createdBy';
const CREATED_AT = 'http://dkg.io/ontology/createdAt';
const PLAIN_AGENT_DID = /^did:dkg:agent:[A-Za-z0-9]{1,128}$/;

/** One sub-graph registration a peer's `_meta` holds. */
export interface PeerSubGraphRegistration {
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt?: Date;
  readonly description?: string;
}

/** What registering sub-graphs needs of the agent. */
export interface PeerSubGraphRegistrationPorts {
  readonly store: TripleStore;
  /** The agent's write locks: the sync path registers a sub-graph under the same key. */
  readonly writeLocks: Map<string, Promise<void>>;
  readonly contextGraphMetaProjection: { markDirty(contextGraphId: string): void };
  readonly log: {
    info(ctx: OperationContext, message: string): void;
    warn(ctx: OperationContext, message: string): void;
  };
}

/** What a resolution needs of the agent besides that. */
interface PeerSubGraphResolutionAgent extends PeerSubGraphRegistrationPorts, FreshMetaFetchAgent {
  readonly peerId: string;
  readonly node: { libp2p: { getConnections(): Array<{ remotePeer: { toString(): string } }> } };
  readonly localContextGraphProvenance: { hasLocalCreate(contextGraphId: string): boolean };
  readonly subscribedContextGraphs: ReadonlyMap<string, { readonly subscribed?: boolean }>;
  resolveCuratorPeerId(contextGraphId: string, options: { signal?: AbortSignal }): Promise<string | undefined>;
  resolveRfc64UnregisteredAuthoritySeedPeersV1(options: { contextGraphId?: string }): readonly string[];
}

/**
 * The sub-graph registrations of `contextGraphId` in `quads`, a peer's copy of
 * the graph's `_meta`: subject `<graph>/<name>` typed `dkg:SubGraph` and named
 * `<name>`, at most {@link PEER_SUB_GRAPH_REGISTRATION_LIMIT}. `options.first`
 * (the sub-graph a write names) is taken first when the snapshot holds it, so
 * the limit never leaves it out; the rest follow in name order. Names in
 * `options.exclude` (the registrations this node holds) are left out before
 * the limit applies, so repeated reads of a large snapshot progress through it.
 */
export function readPeerSubGraphRegistrations(
  contextGraphId: string,
  quads: readonly Quad[],
  options: { readonly first?: string; readonly exclude?: ReadonlySet<string> } = {},
): PeerSubGraphRegistration[] {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const prefix = `${contextGraphDataGraphUri(contextGraphId)}/`;
  const rowsByName = new Map<string, Quad[]>();
  for (const quad of quads) {
    if (quad.graph !== metaGraph || !quad.subject.startsWith(prefix)) continue;
    const name = quad.subject.slice(prefix.length);
    if (options.exclude?.has(name)) continue;
    const rows = rowsByName.get(name) ?? [];
    rows.push(quad);
    rowsByName.set(name, rows);
  }
  const found: PeerSubGraphRegistration[] = [];
  const names = [...rowsByName.keys()].sort();
  if (options.first !== undefined && rowsByName.has(options.first)) {
    names.splice(names.indexOf(options.first), 1);
    names.unshift(options.first);
  }
  for (const name of names) {
    if (found.length >= PEER_SUB_GRAPH_REGISTRATION_LIMIT) break;
    if (name.length > MAX_PEER_SUB_GRAPH_NAME_LENGTH || !validateSubGraphName(name).valid) continue;
    const rows = rowsByName.get(name)!;
    const objects = (predicate: string) => rows.filter((row) => row.predicate === predicate).map((row) => row.object);
    if (!objects(RDF_TYPE).includes(SUB_GRAPH_TYPE)) continue;
    if (!objects(SCHEMA_NAME).some((value) => value.startsWith('"') && stripLiteral(value) === name)) continue;
    const createdAt = objects(CREATED_AT)
      .map((value) => new Date(stripLiteral(value)))
      .find((date) => Number.isFinite(date.getTime()));
    const description = objects(SCHEMA_DESCRIPTION)
      .filter((value) => value.startsWith('"'))
      .map(stripLiteral)
      .find((text) => text.length > 0 && text.length <= MAX_PEER_SUB_GRAPH_DESCRIPTION_LENGTH);
    found.push({
      name,
      createdBy: objects(CREATED_BY).find((value) => PLAIN_AGENT_DID.test(value)) ?? PEER_SUB_GRAPH_CREATED_BY_FALLBACK,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(description === undefined ? {} : { description }),
    });
  }
  return found;
}

/** The names of the sub-graphs this node has registered in the graph's `_meta`. */
export async function readLocalSubGraphNames(store: TripleStore, contextGraphId: string): Promise<Set<string>> {
  const prefix = `${contextGraphDataGraphUri(contextGraphId)}/`;
  const result = await store.query(
    `SELECT ?s WHERE { GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> { ?s <${RDF_TYPE}> <${SUB_GRAPH_TYPE}> } }`,
    { source: 'agent.peerSubGraphRegistration.localNames' },
  );
  const names = new Set<string>();
  if (result.type !== 'bindings') return names;
  for (const row of result.bindings) {
    const subject = row['s'];
    if (typeof subject === 'string' && subject.startsWith(prefix)) names.add(subject.slice(prefix.length));
  }
  return names;
}

/**
 * Register each sub-graph of `found` that this node has not registered.
 * Returns the names it registered; a store failure is thrown.
 */
export async function registerPeerSubGraphs(
  ports: PeerSubGraphRegistrationPorts,
  contextGraphId: string,
  found: readonly PeerSubGraphRegistration[],
  sourcePeerId: string,
  ctx: OperationContext,
): Promise<string[]> {
  const registered: string[] = [];
  for (const subGraph of found) {
    const key = `${contextGraphId}\0${subGraph.name}\0sub-graph-registration`;
    const made = await withKeyedLocks(ports.writeLocks, [key], async () => {
      const childUri = `${contextGraphDataGraphUri(contextGraphId)}/${subGraph.name}`;
      if (await isKnownContextGraphUri(ports.store, childUri)) return false;
      const outcome = await ensureSubGraphRegistration(ports.store, {
        contextGraphId,
        subGraphName: subGraph.name,
        createdBy: subGraph.createdBy,
        timestamp: subGraph.createdAt ?? new Date(),
        ...(subGraph.description === undefined ? {} : { description: subGraph.description }),
      }, { source: 'agent.peerSubGraphRegistration' });
      if (outcome.registered) await new GraphManager(ports.store).ensureSubGraph(contextGraphId, subGraph.name);
      return outcome.registered;
    });
    if (made) registered.push(subGraph.name);
  }
  if (registered.length > 0) {
    ports.contextGraphMetaProjection.markDirty(contextGraphId);
    ports.log.info(
      ctx,
      `Registered sub-graph(s) ${registered.map((name) => `"${name}"`).join(', ')} of context graph `
      + `"${contextGraphId}" from the metadata of peer ${sourcePeerId.slice(-8)}`,
    );
  }
  return registered;
}

/**
 * {@link registerPeerSubGraphs} for a `_meta` snapshot just installed as the
 * graph's definition. The definition stands whatever happens here, so a
 * failure is logged, not thrown: a write into one of these sub-graphs then
 * resolves it again.
 */
export async function learnPeerSubGraphs(
  ports: PeerSubGraphRegistrationPorts,
  contextGraphId: string,
  found: readonly PeerSubGraphRegistration[],
  sourcePeerId: string,
  ctx: OperationContext,
): Promise<void> {
  if (found.length === 0) return;
  try {
    await registerPeerSubGraphs(ports, contextGraphId, found, sourcePeerId, ctx);
  } catch (error) {
    ports.log.warn(
      ctx,
      `Could not register the sub-graphs of context graph "${contextGraphId}" that peer ${sourcePeerId.slice(-8)} `
      + `holds: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A resolution that did not find its sub-graph, remembered for a while. */
interface RememberedMiss {
  readonly at: number;
  readonly forMs: number;
  readonly detail: string;
}

interface PeerSubGraphResolutionState {
  /** One resolution per sub-graph at a time; a write that comes meanwhile shares it. */
  readonly inFlight: Map<string, Promise<UnregisteredSubGraphResolution>>;
  /** The last resolution of each `<graph>\0<name>` that did not find it. */
  readonly misses: Map<string, RememberedMiss>;
}

const resolutionStates = new WeakMap<object, PeerSubGraphResolutionState>();

function resolutionStateOf(agent: object): PeerSubGraphResolutionState {
  let state = resolutionStates.get(agent);
  if (state === undefined) {
    state = { inFlight: new Map(), misses: new Map() };
    resolutionStates.set(agent, state);
  }
  return state;
}

/**
 * Resolve a sub-graph that a write names and this node has not registered:
 * ask the graph's owner, then connected peers, for the graph's `_meta`, and
 * register the sub-graphs their answers hold. Asks only for a graph this node
 * follows and did not create (the creator registers its own sub-graphs).
 * Never throws for a peer that cannot be asked, or for running out of its
 * `timeoutMs` (default {@link SUB_GRAPH_RESOLUTION_TIMEOUT_MS}); the outcome
 * says what was found. A sub-graph that no peer asked held is not asked for
 * again for {@link SUB_GRAPH_RESOLUTION_MISS_COOLDOWN_MS}, nor for
 * {@link SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS} after no peer could be asked.
 */
export function resolveUnregisteredSubGraphFromPeers(
  agentObject: object,
  contextGraphId: string,
  subGraphName: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<UnregisteredSubGraphResolution> {
  const agent = agentObject as PeerSubGraphResolutionAgent;
  if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
    return Promise.resolve({ registered: false, detail: 'a system context graph has no sub-graphs to look up' });
  }
  if (agent.localContextGraphProvenance.hasLocalCreate(contextGraphId)) {
    return Promise.resolve({ registered: false, detail: 'this node created the context graph and registers its sub-graphs itself' });
  }
  if (agent.subscribedContextGraphs.get(contextGraphId)?.subscribed !== true) {
    return Promise.resolve({ registered: false, detail: 'this node does not follow the context graph, so it asked no peer' });
  }
  const state = resolutionStateOf(agentObject);
  const key = `${contextGraphId}\0${subGraphName}`;
  const missed = state.misses.get(key);
  if (missed !== undefined) {
    const sinceMs = Date.now() - missed.at;
    if (sinceMs < missed.forMs) {
      return Promise.resolve({ registered: false, detail: `asked ${Math.round(sinceMs / 1000)} s ago: ${missed.detail}` });
    }
  }
  const running = state.inFlight.get(key);
  if (running !== undefined) return running;
  const resolution = resolveFromPeers(agent, state, key, contextGraphId, subGraphName, options.timeoutMs ?? SUB_GRAPH_RESOLUTION_TIMEOUT_MS)
    .finally(() => {
      if (state.inFlight.get(key) === resolution) state.inFlight.delete(key);
    });
  state.inFlight.set(key, resolution);
  return resolution;
}

const OUT_OF_TIME = Symbol('out of time');

/**
 * `work`'s outcome, or {@link OUT_OF_TIME} when `budget` ends first. `work`
 * goes on to its end either way (a rejection after that is still handled).
 */
async function withinBudget<T>(work: Promise<T>, budget: AbortSignal): Promise<T | typeof OUT_OF_TIME> {
  if (budget.aborted) {
    work.catch(() => undefined);
    return OUT_OF_TIME;
  }
  let onAbort!: () => void;
  const ended = new Promise<typeof OUT_OF_TIME>((resolve) => {
    onAbort = () => resolve(OUT_OF_TIME);
    budget.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, ended]);
  } finally {
    budget.removeEventListener('abort', onAbort);
  }
}

async function resolveFromPeers(
  agent: PeerSubGraphResolutionAgent,
  state: PeerSubGraphResolutionState,
  key: string,
  contextGraphId: string,
  subGraphName: string,
  timeoutMs: number,
): Promise<UnregisteredSubGraphResolution> {
  const ctx = createOperationContext('sync');
  const deadline = Date.now() + timeoutMs;
  // One budget for the whole resolution: the owner's lookup, the wait for sync
  // capacity and for a peer's turn, every fetch and the registrations. Its end
  // is an answer, not an error; what it cut short goes on without the caller.
  const budget = AbortSignal.timeout(timeoutMs);
  const peerIds = await withinBudget(resolutionPeers(agent, contextGraphId, budget), budget);
  let answered = 0;
  let lastFailure = 'out of time';
  let outOfTime = peerIds === OUT_OF_TIME;
  for (const peerId of peerIds === OUT_OF_TIME ? [] : peerIds) {
    if (budget.aborted) {
      outOfTime = true;
      break;
    }
    let quads: readonly Quad[] | undefined | typeof OUT_OF_TIME;
    try {
      quads = await withinBudget(fetchPeerMeta(agent, ctx, peerId, contextGraphId, deadline, budget), budget);
    } catch (error) {
      if (budget.aborted) {
        outOfTime = true;
        break;
      }
      lastFailure = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (quads === OUT_OF_TIME) {
      outOfTime = true;
      break;
    }
    if (quads === undefined) {
      lastFailure = `peer ${peerId.slice(-8)} sent an incomplete answer`;
      continue;
    }
    answered += 1;
    const found = readPeerSubGraphRegistrations(contextGraphId, quads, {
      first: subGraphName,
      exclude: await readLocalSubGraphNames(agent.store, contextGraphId).catch(() => new Set<string>()),
    });
    if (await withinBudget(registerPeerSubGraphs(agent, contextGraphId, found, peerId, ctx), budget) === OUT_OF_TIME) {
      outOfTime = true;
      break;
    }
    if (await hasSubGraphRegistration(agent.store, contextGraphId, subGraphName)) {
      state.misses.delete(key);
      return { registered: true };
    }
  }
  if (outOfTime) lastFailure = 'out of time';
  else if (answered > 0) {
    const detail = `none of the ${answered} peer(s) of the context graph asked holds it`;
    rememberMiss(state, key, { at: Date.now(), forMs: SUB_GRAPH_RESOLUTION_MISS_COOLDOWN_MS, detail });
    return { registered: false, detail };
  } else if (peerIds !== OUT_OF_TIME && peerIds.length === 0) {
    return { registered: false, detail: 'no peer of the context graph was there to ask' };
  }
  const detail = `no peer of the context graph could be asked: ${lastFailure}`;
  rememberMiss(state, key, { at: Date.now(), forMs: SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS, detail });
  agent.log.warn(ctx, `Could not look up sub-graph "${subGraphName}" of context graph "${contextGraphId}": ${lastFailure}`);
  return { registered: false, detail };
}

function rememberMiss(state: PeerSubGraphResolutionState, key: string, miss: RememberedMiss): void {
  state.misses.delete(key);
  state.misses.set(key, miss);
  while (state.misses.size > SUB_GRAPH_RESOLUTION_REMEMBERED_MISSES) {
    const oldest = state.misses.keys().next().value;
    if (oldest === undefined) break;
    state.misses.delete(oldest);
  }
}

/**
 * The peers to ask, never this node: the graph's owner first when this node
 * can name its peer and is connected to it, then connected peers (the node's
 * selection puts Cores, which keep and serve the owner's definition of the
 * registered graphs they host, before other peers). An owner this node is not
 * connected to is asked last, so a member that reaches the graph only through
 * Cores (an Edge behind NAT) does not spend its budget on a dial before it
 * asks them; a dial to the owner is still tried when no connected peer holds
 * the sub-graph.
 */
async function resolutionPeers(
  agent: PeerSubGraphResolutionAgent,
  contextGraphId: string,
  signal: AbortSignal,
): Promise<string[]> {
  // An owner this node cannot name still leaves the connected peers to ask.
  const owner = await agent.resolveCuratorPeerId(contextGraphId, { signal }).catch(() => undefined);
  const connected = new Set(agent.node.libp2p.getConnections().map((connection) => connection.remotePeer.toString()));
  const peers = [...new Set(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1({ contextGraphId }))]
    .filter((peerId) => peerId !== agent.peerId && peerId !== owner);
  if (owner === undefined || owner === agent.peerId) return peers.slice(0, SUB_GRAPH_RESOLUTION_MAX_PEERS);
  if (connected.has(owner)) return [owner, ...peers].slice(0, SUB_GRAPH_RESOLUTION_MAX_PEERS);
  return [...peers.slice(0, SUB_GRAPH_RESOLUTION_MAX_PEERS - 1), owner];
}

/**
 * The peer's complete `_meta` of the graph in a fresh session
 * ({@link fetchFreshContextGraphMeta}, the curator metadata refresh's fetch),
 * or undefined when its answer was incomplete.
 */
async function fetchPeerMeta(
  agent: PeerSubGraphResolutionAgent,
  ctx: OperationContext,
  peerId: string,
  contextGraphId: string,
  deadline: number,
  signal: AbortSignal,
): Promise<readonly Quad[] | undefined> {
  const result = await fetchFreshContextGraphMeta(agent, ctx, peerId, contextGraphId, { deadline: () => deadline, signal });
  agent.syncCheckpoints.delete(result.checkpointKey);
  return result.completed && result.resumedFromOffset === 0 ? result.quads : undefined;
}
