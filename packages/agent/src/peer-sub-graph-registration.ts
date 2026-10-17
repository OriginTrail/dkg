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
 *    graph's owner and connected peers before it is refused, and registers
 *    that sub-graph, and any other one a write on this node is waiting for,
 *    when a peer holds it ({@link resolveUnregisteredSubGraphFromPeers}, the
 *    publisher's `resolveUnregisteredSubGraph`).
 *
 * A registration is bookkeeping, not authority: nothing reads `createdBy` or
 * `authorizedWriter` to admit a write, and the live paths register a
 * sub-graph for whoever shares into it. So any peer may serve one. What is
 * taken is still bounded: complete, well-formed registrations of the graph
 * only, at most {@link PEER_SUB_GRAPH_REGISTRATION_LIMIT} from a definition
 * and only the names writes wait for from a lookup, never a writer list,
 * never a name that is a context graph of its own on this node, and an
 * existing registration is left as it is.
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
import { rememberBounded } from './bounded-map.js';
import { isBoundedOperationTimeoutError, runBoundedOperation, throwIfOperationAborted } from './bounded-operation.js';
import { stripLiteral } from './dkg-agent-utils.js';
import { runSyncSingleFlight, syncSingleFlightKey } from './sync-single-flight.js';
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
 * How long one resolution may take, the waits for an earlier lookup of the
 * graph and for sync capacity included: it runs inside the write that names
 * the sub-graph.
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
 * the limit never leaves it out; the rest follow in name order.
 */
export function readPeerSubGraphRegistrations(
  contextGraphId: string,
  quads: readonly Quad[],
  options: { readonly first?: string } = {},
): PeerSubGraphRegistration[] {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const prefix = `${contextGraphDataGraphUri(contextGraphId)}/`;
  const rowsByName = new Map<string, Quad[]>();
  for (const quad of quads) {
    if (quad.graph !== metaGraph || !quad.subject.startsWith(prefix)) continue;
    const name = quad.subject.slice(prefix.length);
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
    const registration = parsePeerSubGraphRegistration(name, rowsByName.get(name)!);
    if (registration !== undefined) found.push(registration);
  }
  return found;
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

/**
 * The registrations of the sub-graphs `names` that `quads` hold, however many
 * others they hold: what a write asks for is never left out by the limit of
 * {@link readPeerSubGraphRegistrations}.
 */
function readRequestedPeerSubGraphRegistrations(
  contextGraphId: string,
  quads: readonly Quad[],
  names: ReadonlySet<string>,
): PeerSubGraphRegistration[] {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const prefix = `${contextGraphDataGraphUri(contextGraphId)}/`;
  return [...names].flatMap((name) => {
    const rows = quads.filter((quad) => quad.graph === metaGraph && quad.subject === `${prefix}${name}`);
    return rows.length === 0 ? [] : parsePeerSubGraphRegistration(name, rows) ?? [];
  });
}

/** The registration `rows` make for `name`, when they make a complete, well-formed one. */
function parsePeerSubGraphRegistration(name: string, rows: readonly Quad[]): PeerSubGraphRegistration | undefined {
  if (name.length > MAX_PEER_SUB_GRAPH_NAME_LENGTH || !validateSubGraphName(name).valid) return undefined;
  const objects = (predicate: string) => rows.filter((row) => row.predicate === predicate).map((row) => row.object);
  if (!objects(RDF_TYPE).includes(SUB_GRAPH_TYPE)) return undefined;
  if (!objects(SCHEMA_NAME).some((value) => value.startsWith('"') && stripLiteral(value) === name)) return undefined;
  const createdAt = objects(CREATED_AT)
    .map((value) => new Date(stripLiteral(value)))
    .find((date) => Number.isFinite(date.getTime()));
  const description = objects(SCHEMA_DESCRIPTION)
    .filter((value) => value.startsWith('"'))
    .map(stripLiteral)
    .find((text) => text.length > 0 && text.length <= MAX_PEER_SUB_GRAPH_DESCRIPTION_LENGTH);
  return {
    name,
    createdBy: objects(CREATED_BY).find((value) => PLAIN_AGENT_DID.test(value)) ?? PEER_SUB_GRAPH_CREATED_BY_FALLBACK,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(description === undefined ? {} : { description }),
  };
}

/** A resolution that did not find its sub-graph, remembered for a while. */
interface RememberedMiss {
  readonly at: number;
  readonly forMs: number;
  readonly detail: string;
}

interface PeerSubGraphResolutionState {
  /**
   * One lookup of a graph at a time (`withKeyedLocks`, by graph). Each lookup
   * opens a fresh session at the peer it asks, and the peer keeps one
   * metadata session per requester and graph, so a second lookup would
   * supersede the first one's remaining pages.
   */
  readonly lookupLocks: Map<string, Promise<void>>;
  /**
   * The names the resolutions of each graph are waiting for. A lookup
   * registers every one of them that its peer holds, so the lookups queued
   * behind it usually find their sub-graph without asking again.
   */
  readonly wanted: Map<string, Set<string>>;
  /** The last resolution of each `<graph>\0<name>` that did not find it. */
  readonly misses: Map<string, RememberedMiss>;
}

const resolutionStates = new WeakMap<object, PeerSubGraphResolutionState>();

function resolutionStateOf(agent: object): PeerSubGraphResolutionState {
  let state = resolutionStates.get(agent);
  if (state === undefined) {
    state = { lookupLocks: new Map(), wanted: new Map(), misses: new Map() };
    resolutionStates.set(agent, state);
  }
  return state;
}

/**
 * Resolve a sub-graph that a write names and this node has not registered:
 * ask the graph's owner, then connected peers, for the graph's `_meta`, and
 * register the sub-graph when one holds it. Asks only for a graph this node
 * follows and did not create (the creator registers its own sub-graphs). One
 * resolution of a sub-graph runs at a time, and a write that comes meanwhile
 * shares it; one lookup of a graph runs at a time.
 * Never throws for a peer that cannot be asked, or for running out of its
 * `timeoutMs` (default {@link SUB_GRAPH_RESOLUTION_TIMEOUT_MS}), which bounds
 * the whole resolution; the outcome says what was found. A sub-graph that no
 * peer asked held is not asked for again for
 * {@link SUB_GRAPH_RESOLUTION_MISS_COOLDOWN_MS}, nor for
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
  return runSyncSingleFlight(
    agentObject,
    syncSingleFlightKey('sub-graph-resolution', { contextGraphId, subGraphName }),
    () => resolveWithinBudget(agent, state, key, contextGraphId, subGraphName, options.timeoutMs ?? SUB_GRAPH_RESOLUTION_TIMEOUT_MS),
    { scope: 'durable' },
  );
}

/** What one lookup of the graph's peers found. */
type PeerLookupOutcome =
  | { readonly registered: true }
  | { readonly registered: false; readonly asked: number; readonly answered: number; readonly lastFailure: string };

async function resolveWithinBudget(
  agent: PeerSubGraphResolutionAgent,
  state: PeerSubGraphResolutionState,
  key: string,
  contextGraphId: string,
  subGraphName: string,
  timeoutMs: number,
): Promise<UnregisteredSubGraphResolution> {
  const ctx = createOperationContext('sync');
  const deadline = Date.now() + timeoutMs;
  const stopWaiting = waitFor(state, contextGraphId, subGraphName);
  let outcome: PeerLookupOutcome | undefined;
  try {
    // One budget for the whole resolution: the wait for an earlier lookup of
    // the graph, the owner's lookup, the waits for sync capacity and for the
    // peer, every fetch, the registrations and the check after them. Its end
    // is an answer, not an error; what it cut short goes on without the
    // caller, and a registration it started still completes.
    outcome = await runBoundedOperation(
      (signal) => withKeyedLocks(state.lookupLocks, [contextGraphId], () =>
        lookUpPeers(agent, state, ctx, contextGraphId, subGraphName, deadline, signal)),
      { timeoutMs, label: 'Sub-graph lookup' },
    );
  } catch (error) {
    if (!isBoundedOperationTimeoutError(error)) throw error;
  } finally {
    stopWaiting();
  }
  if (outcome?.registered === true) {
    state.misses.delete(key);
    return { registered: true };
  }
  if (outcome !== undefined && outcome.answered > 0) {
    const detail = `none of the ${outcome.answered} peer(s) of the context graph asked holds it`;
    rememberMiss(state, key, { at: Date.now(), forMs: SUB_GRAPH_RESOLUTION_MISS_COOLDOWN_MS, detail });
    return { registered: false, detail };
  }
  if (outcome !== undefined && outcome.asked === 0) {
    return { registered: false, detail: 'no peer of the context graph was there to ask' };
  }
  const failure = outcome?.lastFailure ?? 'out of time';
  const detail = `no peer of the context graph could be asked: ${failure}`;
  rememberMiss(state, key, { at: Date.now(), forMs: SUB_GRAPH_RESOLUTION_FAILURE_COOLDOWN_MS, detail });
  agent.log.warn(ctx, `Could not look up sub-graph "${subGraphName}" of context graph "${contextGraphId}": ${failure}`);
  return { registered: false, detail };
}

/**
 * Ask the graph's peers, the owner first, until one holds the sub-graph, and
 * register each sub-graph of the graph that a resolution waits for and the
 * answer holds. Runs as the graph's one lookup; stops once `signal` ends the
 * resolution.
 */
async function lookUpPeers(
  agent: PeerSubGraphResolutionAgent,
  state: PeerSubGraphResolutionState,
  ctx: OperationContext,
  contextGraphId: string,
  subGraphName: string,
  deadline: number,
  signal: AbortSignal,
): Promise<PeerLookupOutcome> {
  // The resolution may have ended while this lookup waited for the one before it.
  throwIfOperationAborted(signal);
  // The lookup before this one may have registered it.
  if (await hasSubGraphRegistration(agent.store, contextGraphId, subGraphName)) return { registered: true };
  const peerIds = await resolutionPeers(agent, contextGraphId, signal);
  let answered = 0;
  let lastFailure = '';
  for (const peerId of peerIds) {
    throwIfOperationAborted(signal);
    let quads: readonly Quad[] | undefined;
    try {
      quads = await fetchPeerMeta(agent, ctx, peerId, contextGraphId, deadline, signal);
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (quads === undefined) {
      lastFailure = `peer ${peerId.slice(-8)} sent an incomplete answer`;
      continue;
    }
    answered += 1;
    const wanted = new Set(state.wanted.get(contextGraphId)).add(subGraphName);
    const found = readRequestedPeerSubGraphRegistrations(contextGraphId, quads, wanted);
    await registerPeerSubGraphs(agent, contextGraphId, found, peerId, ctx);
    if (found.some((registration) => registration.name === subGraphName)
      && await hasSubGraphRegistration(agent.store, contextGraphId, subGraphName)) {
      return { registered: true };
    }
  }
  return { registered: false, asked: peerIds.length, answered, lastFailure };
}

/** Note that a resolution waits for `subGraphName`; the returned function ends that. */
function waitFor(state: PeerSubGraphResolutionState, contextGraphId: string, subGraphName: string): () => void {
  const names = state.wanted.get(contextGraphId) ?? new Set<string>();
  state.wanted.set(contextGraphId, names.add(subGraphName));
  return () => {
    names.delete(subGraphName);
    if (names.size === 0 && state.wanted.get(contextGraphId) === names) state.wanted.delete(contextGraphId);
  };
}

function rememberMiss(state: PeerSubGraphResolutionState, key: string, miss: RememberedMiss): void {
  rememberBounded(state.misses, key, miss, SUB_GRAPH_RESOLUTION_REMEMBERED_MISSES);
}

/** The graph's owner first, when this node can name its peer, then connected peers; never this node. */
async function resolutionPeers(
  agent: PeerSubGraphResolutionAgent,
  contextGraphId: string,
  signal: AbortSignal,
): Promise<string[]> {
  // An owner this node cannot name still leaves the connected peers to ask.
  const owner = await agent.resolveCuratorPeerId(contextGraphId, { signal }).catch(() => undefined);
  const candidates = [
    ...(owner === undefined ? [] : [owner]),
    ...agent.resolveRfc64UnregisteredAuthoritySeedPeersV1({ contextGraphId }),
  ];
  return [...new Set(candidates)]
    .filter((peerId) => peerId !== agent.peerId)
    .slice(0, SUB_GRAPH_RESOLUTION_MAX_PEERS);
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
