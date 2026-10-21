// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's definition of a registered public graph, kept by the Cores that
 * host it and served to the graph's subscribers.
 *
 * A Core hosts a public graph registered on chain by its chain policy: the
 * StorageACK gate records the graph as core-hosted (`recordCoreHostedPublicCg`)
 * and the chain-driven reconciler keeps its verified memory. Nothing made the
 * Core fetch the graph's `_meta`, so it held no declaration of the graph: no
 * curator, no publish policy, no sub-graph registrations. A member that
 * reaches the graph only through Cores (an Edge behind NAT, connected to the
 * Cores' relays) then got from them nothing but empty pages. With #3264 it
 * installs the canonical facts from the chain (a public graph), but those name
 * no curator and list no sub-graphs, and the sub-graph lookup of its first
 * write (#3293) asks the Cores and finds nothing: the write is refused with
 * SUB_GRAPH_NOT_FOUND until content of the sub-graph reaches it by sync.
 *
 * Now a Core keeps the owner's definition of every hosted graph whose id names
 * its owner (`<owner wallet>/<name>`):
 *  - when a graph is recorded as hosted, and when a hosted row is restored at
 *    start, the Core fetches the owner's `_meta` ({@link ensureCoreHostedDefinition}):
 *    from the owner's nodes when it can name them (the node the owner tied to
 *    the graph, the curator node a held definition names, the agent
 *    registry's entries for the owner wallet, the peer the definition last
 *    came from), else from connected peers; a definition counts only once the Core
 *    holds the owner's declaration (a peer may serve the canonical chain
 *    facts, which name no curator), and the Core retries with a growing delay
 *    while it holds none;
 *  - a node is tied to the graph only by a share into the graph that the
 *    owner's wallet signed, that names the node as its publisher and that the
 *    node delivered itself, recently ({@link noteCoreHostedOwnerShare},
 *    `core-hosted-owner-peer-tie.ts`). A graph created minutes ago is named
 *    by no other source yet; the owner's node offers the tie to the Cores it
 *    is connected to when it shares into the graph and before it asks for
 *    StorageACKs (`swm/owner-tie-offer.ts`). While the definition is missing,
 *    the tied node is asked once, at once if it is connected (after a running
 *    attempt or refresh), else when it next asks for a StorageACK (the request
 *    itself carries no signature, so a requester that no share ties is never
 *    asked). That fetch runs beside the attempts: it never takes their place,
 *    never ends or moves their retries (it starts an attempt when its copy
 *    replaced a declaration held meanwhile), and does not count for the
 *    cooldown below; an attempt does not ask the node again while it runs;
 *  - before it serves the first page of a hosted graph's durable `_meta`, it
 *    refreshes its copy from the owner when an owner node is connected and the
 *    copy is older than the cooldown ({@link refreshCoreHostedDefinitionBeforeServing}),
 *    within a bounded time, so a sub-graph the owner registered since reaches
 *    the subscriber; registrations the Core holds already are left out before
 *    the per-snapshot limit applies, so a graph with more sub-graphs than the
 *    limit is learned across refreshes;
 *  - the responder serves what the Core holds in the same pages as before
 *    (`readDurableMetaPage`): the root declaration and the registrations of
 *    the sub-graphs the Core registered with it.
 *
 * What a Core keeps is verified as a member verifies a declaration served by
 * any peer (the RFC-64 metadata bootstrap's relayed refresh): the declaration
 * must be unambiguously public, its curator must be the owner the graph's id
 * names, which the chain binding of the id attests, and the serving peer's
 * chain registration claims are stripped. A Core cannot re-home the graph,
 * flip it private or bind it to another slot; what it adds is availability.
 * A subscriber verifies the Core's copy the same way, so a Core cannot forge
 * a definition that a subscriber accepts either. Sub-graph registrations are
 * bookkeeping, not authority (`peer-sub-graph-registration.ts`).
 */

import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  createOperationContext,
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { holdsAuthoritativePublicDefinitionV1 } from './context-graph-meta-confirmation.js';
import {
  OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE,
  ownerPeerClaimHolds,
  OwnerPeerTies,
  OwnerTieCheckBudget,
  readOwnerPeerClaim,
  readOwnerShareHeader,
  type OwnerPeerTie,
} from './core-hosted-owner-peer-tie.js';
import { runCuratorMetaRefreshFromPeer, type CuratorMetaRefreshAgent } from './curator-meta-refresh.js';
import { META_REFRESH_COOLDOWN_MS } from './dkg-agent-constants.js';
import { rfc64UnregisteredAuthorityOwnerV1 } from './rfc64/unregistered-authority-transport-v1.js';

/** Delay before each retry of a fetch that found no definition, then the last one again. */
export const CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 300_000, 600_000,
]);
/** A copy refreshed (or refused) this recently is served as it is. */
export const CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS = META_REFRESH_COOLDOWN_MS;
/** The most a subscriber's request waits for the Core's refresh from the owner; the refresh itself goes on. */
export const CORE_HOSTED_DEFINITION_SERVE_REFRESH_BUDGET_MS = 10_000;
/** Owner nodes asked per attempt (an owner wallet may run several nodes). */
export const CORE_HOSTED_DEFINITION_MAX_OWNER_PEERS = 3;
/** Connected peers asked per attempt after the owner's nodes (the window the node's selection rotates). */
export const CORE_HOSTED_DEFINITION_MAX_FALLBACK_PEERS = 3;
/** Share signatures checked per sending node and minute; a node is checked once per graph it ties. */
export const CORE_HOSTED_OWNER_TIE_CHECKS_PER_MINUTE = OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE;

export type CoreHostedDefinitionOutcome =
  /** The graph is not core-hosted here (or the node stopped before the attempt). */
  | 'not-hosted'
  /** The id names no owner wallet, so nothing can authenticate a declaration. */
  | 'no-owner-namespace'
  /** This node created the graph: it holds its own definition. */
  | 'local-author'
  /** The owner's definition is held already. */
  | 'held'
  /** The owner's definition was installed now. */
  | 'fetched'
  /** No peer served a verified definition; a retry is scheduled. */
  | 'not-found';

/** What starts an attempt, for the log. */
type CoreHostedDefinitionTrigger = 'recorded' | 'restored' | 'retry' | 'serve';

/**
 * What keeping a hosted definition needs of the agent: the curator metadata
 * refresh's own dependencies (transport, store, locks, checkpoints), and the
 * hosted rows, the agent registry and the peer selection used here.
 */
export interface CoreHostedDefinitionAgent extends CuratorMetaRefreshAgent {
  readonly config?: { readonly nodeRole?: string };
  readonly node: CuratorMetaRefreshAgent['node'] & {
    readonly stopSignal?: AbortSignal;
    readonly libp2p: { getConnections(): Array<{ remotePeer: { toString(): string } }> };
  };
  readonly subscribedContextGraphs: Map<string, { readonly coreHosted?: boolean; onChainId?: string; onChainHash?: string }>;
  readonly localContextGraphProvenance: { hasLocalCreate(contextGraphId: string): boolean };
  readonly discovery: {
    findAgents(options: { agentAddress?: string; signal?: AbortSignal }): Promise<Array<{ peerId: string; agentAddress?: string }>>;
  };
  resolveRfc64UnregisteredAuthoritySeedPeersV1(options: { contextGraphId?: string; maxPeers?: number }): readonly string[];
}

interface CoreHostedDefinitionState {
  /**
   * One attempt (`full`) or serve-time refresh (`serve`) per graph at a time;
   * a caller that comes meanwhile shares it.
   */
  readonly inFlight: Map<string, { readonly kind: 'full' | 'serve'; readonly work: Promise<CoreHostedDefinitionOutcome> }>;
  /** The graphs whose attempt was asked for while a serve-time refresh ran: started once it ends. */
  readonly fullAfterServe: Map<string, CoreHostedDefinitionTrigger>;
  /** The one fetch from each graph's tied node; never shared with the attempts and refreshes. */
  readonly tiedFetches: Map<string, Promise<void>>;
  /** The retry of each graph: its timer until it fires, and the index of its delay. */
  readonly retries: Map<string, { timer: ReturnType<typeof setTimeout> | undefined; attempt: number }>;
  /** When each graph's copy was last refreshed from the owner, or the refresh refused. */
  readonly lastAttemptAt: Map<string, number>;
  /** The peer each graph's definition was last installed from. */
  readonly sources: Map<string, string>;
  /** The node tied to each graph, the latest one. */
  readonly ties: OwnerPeerTies;
  /** The graphs whose owner's definition the last attempt or refresh found held or installed. */
  readonly held: Set<string>;
  /** Signature checks of shares, per sending node and in all. */
  readonly tieChecks: OwnerTieCheckBudget;
}

const states = new WeakMap<object, CoreHostedDefinitionState>();

/** Whether the node is stopping (a function, so that one check does not narrow the next). */
function stopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function stateOf(agent: object): CoreHostedDefinitionState {
  let state = states.get(agent);
  if (state === undefined) {
    state = {
      inFlight: new Map(), fullAfterServe: new Map(), tiedFetches: new Map(), retries: new Map(),
      lastAttemptAt: new Map(), sources: new Map(), ties: new OwnerPeerTies(() => Date.now()), held: new Set(),
      tieChecks: new OwnerTieCheckBudget({}, () => Date.now()),
    };
    states.set(agent, state);
  }
  return state;
}

function isSystemGraph(contextGraphId: string): boolean {
  return (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId);
}

/** The graph's tied node; a tie made before the graph was hosted counts among the hosted ties once it is. */
function tieOf(agent: CoreHostedDefinitionAgent, state: CoreHostedDefinitionState, contextGraphId: string): OwnerPeerTie | undefined {
  return state.ties.get(contextGraphId, agent.subscribedContextGraphs.get(contextGraphId)?.coreHosted === true);
}

/**
 * The owner wallet of a hosted graph this Core should keep the definition of,
 * or the reason it keeps none.
 */
function hostedOwnerOf(
  agent: CoreHostedDefinitionAgent,
  contextGraphId: string,
): { owner: string } | { reason: 'not-hosted' | 'no-owner-namespace' | 'local-author' } {
  if (isSystemGraph(contextGraphId)) return { reason: 'not-hosted' };
  if (agent.subscribedContextGraphs.get(contextGraphId)?.coreHosted !== true) return { reason: 'not-hosted' };
  if (agent.localContextGraphProvenance.hasLocalCreate(contextGraphId)) return { reason: 'local-author' };
  const owner = rfc64UnregisteredAuthorityOwnerV1(contextGraphId);
  return owner === null ? { reason: 'no-owner-namespace' } : { owner };
}

/**
 * Whether the store holds the owner's declaration of the graph: the public
 * definition with a `dkg:curator` row naming `owner`. The canonical facts a
 * chain repair installs (type and policy only) do not count.
 */
export async function holdsCoreHostedOwnerDefinition(
  store: TripleStore,
  contextGraphId: string,
  owner: string,
): Promise<boolean> {
  if (!(await holdsAuthoritativePublicDefinitionV1(store, contextGraphId))) return false;
  const curator = await store.query(
    `ASK { GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> {
      <${contextGraphDataGraphUri(contextGraphId)}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator .
    } FILTER (LCASE(STR(?curator)) = ${JSON.stringify(`did:dkg:agent:${owner.toLowerCase()}`)}) }`,
    { source: 'agent.coreHostedDefinition.held' },
  );
  return curator.type === 'boolean' && curator.value === true;
}

/**
 * The peer ids of `owner`'s nodes this node can name, connected ones first:
 * the node the owner tied to the graph (the one entry the owner's signature
 * names), the curator node the graph's definition names (once a definition is
 * held), the agent registry's entries for the owner wallet, and the peer the
 * definition was last installed from.
 */
async function ownerPeerIds(
  agent: CoreHostedDefinitionAgent,
  state: CoreHostedDefinitionState,
  contextGraphId: string,
  owner: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const named = await agent.resolveCuratorPeerId(contextGraphId, { signal }).catch(() => undefined);
  signal?.throwIfAborted();
  let agents: Array<{ peerId: string; agentAddress?: string }> = [];
  try {
    agents = await agent.discovery.findAgents({ agentAddress: owner, signal });
  } catch {
    signal?.throwIfAborted();
  }
  const connected = connectedPeerIds(agent);
  const tie = tieOf(agent, state, contextGraphId);
  const peerIds = [...new Set([
    ...(tie?.owner === owner ? [tie.peerId] : []),
    ...(named === undefined ? [] : [named]),
    ...agents.filter((entry) => entry.agentAddress?.toLowerCase() === owner.toLowerCase()).map((entry) => entry.peerId).sort(),
    ...(state.sources.has(contextGraphId) ? [state.sources.get(contextGraphId)!] : []),
  ])].filter((peerId) => peerId !== agent.peerId);
  return [
    ...peerIds.filter((peerId) => connected.has(peerId)),
    ...peerIds.filter((peerId) => !connected.has(peerId)),
  ].slice(0, CORE_HOSTED_DEFINITION_MAX_OWNER_PEERS);
}

/**
 * The peer ids of `owner`'s nodes for a graph, connected ones first, as the
 * hosted definition's fetch names them: the node the owner tied to the graph,
 * the curator node of the held definition, the agent registry's entries for
 * the owner wallet, the peer the definition was last installed from.
 * A Core passes a member's share on to them (`swm/owner-share-forward.ts`).
 * Reads the local store only.
 */
export async function coreHostedOwnerPeerIds(
  agentObject: object,
  contextGraphId: string,
  owner: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return ownerPeerIds(agentObject as CoreHostedDefinitionAgent, stateOf(agentObject), contextGraphId, owner, signal);
}

function connectedPeerIds(agent: CoreHostedDefinitionAgent): Set<string> {
  return new Set(agent.node.libp2p.getConnections().map((connection) => connection.remotePeer.toString()));
}

/** Whether `peerId` is connected now; false on a node without a transport (not started, or stopped). */
function isConnected(agent: CoreHostedDefinitionAgent, peerId: string): boolean {
  try {
    return connectedPeerIds(agent).has(peerId);
  } catch {
    return false;
  }
}

/**
 * Install the owner's declaration served by `peerId`, verified as the RFC-64
 * metadata bootstrap verifies a relayed declaration: public only, curator is
 * `owner`, chain claims stripped, no subscription binding applied. False when
 * the peer served none, served a declaration that failed the checks, or could
 * not be reached.
 */
async function refreshFromPeer(
  agent: CoreHostedDefinitionAgent,
  contextGraphId: string,
  owner: string,
  peerId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return runCuratorMetaRefreshFromPeer(agent, contextGraphId, peerId, {
    force: true,
    requirePublicDefinition: true,
    ignoreRegistrationBinding: true,
    expectedCuratorAddress: owner,
    signal,
  });
}

/** The owner's definition is held: no retry is due, and the tied node may be asked once more after a loss. */
function markHeld(state: CoreHostedDefinitionState, contextGraphId: string): void {
  state.held.add(contextGraphId);
  cancelRetry(state, contextGraphId);
  const tie = state.ties.get(contextGraphId, false);
  if (tie !== undefined) tie.asked = false;
}

/**
 * Keep the owner's definition of a hosted graph: fetch it when it is not
 * held, from the owner's nodes first and then from connected peers, and
 * schedule a retry while no peer serves it. Never throws; one attempt per
 * graph runs at a time, and one that is asked for while a serve-time refresh
 * runs starts once that ends. `trigger` names the event for the log.
 */
export function ensureCoreHostedDefinition(
  agentObject: object,
  contextGraphId: string,
  trigger: CoreHostedDefinitionTrigger,
): Promise<CoreHostedDefinitionOutcome> {
  const agent = agentObject as CoreHostedDefinitionAgent;
  const state = stateOf(agentObject);
  const running = state.inFlight.get(contextGraphId);
  if (running !== undefined) {
    // A serve-time refresh asks one owner node and schedules nothing.
    if (running.kind === 'serve') state.fullAfterServe.set(contextGraphId, trigger);
    return running.work;
  }
  const work: Promise<CoreHostedDefinitionOutcome> = attemptCoreHostedDefinition(agent, state, contextGraphId, trigger)
    .catch((error: unknown) => {
      // A refresh cut short by the node's stop is not a failure to report.
      if (error instanceof Error && error.name === 'AbortError') return 'not-hosted' as const;
      // A store or registry that failed this once: the next attempt is scheduled as after a miss.
      state.held.delete(contextGraphId);
      const stopSignal = agent.node.stopSignal;
      const delayMs = agent.subscribedContextGraphs.get(contextGraphId)?.coreHosted === true
        ? scheduleRetry(agent, state, contextGraphId, stopSignal)
        : undefined;
      agent.log.warn(
        createOperationContext('sync'),
        `Could not keep the definition of hosted context graph "${contextGraphId}": `
        + `${error instanceof Error ? error.message : String(error)}`
        + (delayMs === undefined ? '' : `; next attempt in ${Math.round(delayMs / 1000)} s`),
      );
      return 'not-found' as const;
    })
    .finally(() => {
      if (state.inFlight.get(contextGraphId)?.work === work) state.inFlight.delete(contextGraphId);
      // A node tied while the attempt ran, after it chose its peers.
      askTiedOwnerPeer(agent, state, contextGraphId);
    });
  state.inFlight.set(contextGraphId, { kind: 'full', work });
  return work;
}

async function attemptCoreHostedDefinition(
  agent: CoreHostedDefinitionAgent,
  state: CoreHostedDefinitionState,
  contextGraphId: string,
  trigger: string,
): Promise<CoreHostedDefinitionOutcome> {
  // Read once: the getter answers `undefined` again after a completed stop.
  const stopSignal = agent.node.stopSignal;
  if (stopped(stopSignal)) return 'not-hosted';
  const hosted = hostedOwnerOf(agent, contextGraphId);
  if ('reason' in hosted) {
    cancelRetry(state, contextGraphId);
    state.held.delete(contextGraphId);
    return hosted.reason;
  }
  const ctx = createOperationContext('sync');
  if (await holdsCoreHostedOwnerDefinition(agent.store, contextGraphId, hosted.owner)) {
    markHeld(state, contextGraphId);
    return 'held';
  }
  state.held.delete(contextGraphId);
  const owners = await ownerPeerIds(agent, state, contextGraphId, hosted.owner, stopSignal);
  // The node's selection rotates its window on each call, so over the
  // retries every connected peer is asked, the Edges behind the Cores
  // included (the owner may be one of them).
  const fallback = agent
    .resolveRfc64UnregisteredAuthoritySeedPeersV1({ contextGraphId, maxPeers: CORE_HOSTED_DEFINITION_MAX_FALLBACK_PEERS })
    .filter((peerId) => peerId !== agent.peerId && !owners.includes(peerId));
  const connected = connectedPeerIds(agent);
  for (const peerId of [...owners, ...fallback]) {
    if (stopped(stopSignal)) return 'not-hosted';
    const tie = tieOf(agent, state, contextGraphId);
    // The tied node's own fetch asks it now: waiting behind it to ask again would only delay the others.
    if (tie?.peerId === peerId && state.tiedFetches.has(contextGraphId)) continue;
    state.lastAttemptAt.set(contextGraphId, Date.now());
    // Asked over a live connection: this is the tied node's fetch.
    if (tie?.peerId === peerId && connected.has(peerId)) tie.asked = true;
    if (!(await refreshFromPeer(agent, contextGraphId, hosted.owner, peerId, stopSignal))) continue;
    // A peer may serve a verified definition that is not the owner's: the
    // canonical facts another subscriber took from the chain name no
    // curator. That is installed (it is correct) but ends nothing here, and
    // the tied node's fetch may have marked the copy it replaced held.
    if (!(await holdsCoreHostedOwnerDefinition(agent.store, contextGraphId, hosted.owner))) {
      state.held.delete(contextGraphId);
      continue;
    }
    state.sources.set(contextGraphId, peerId);
    markHeld(state, contextGraphId);
    agent.log.info(
      ctx,
      `Hosted context graph "${contextGraphId}": installed the owner's definition from `
      + `${owners.includes(peerId) ? 'owner node' : 'peer'} ${peerId.slice(-8)} (${trigger})`,
    );
    return 'fetched';
  }
  const delayMs = scheduleRetry(agent, state, contextGraphId, stopSignal);
  agent.log.info(
    ctx,
    `Hosted context graph "${contextGraphId}": no definition from ${owners.length} owner node(s) and `
    + `${fallback.length} connected peer(s) (${trigger})`
    + (delayMs === undefined ? '' : `; next attempt in ${Math.round(delayMs / 1000)} s`),
  );
  return 'not-found';
}

/** Schedule the next attempt; returns its delay, or undefined when the node is stopping. */
function scheduleRetry(
  agent: CoreHostedDefinitionAgent,
  state: CoreHostedDefinitionState,
  contextGraphId: string,
  stopSignal: AbortSignal | undefined,
): number | undefined {
  if (stopped(stopSignal)) return undefined;
  const previous = state.retries.get(contextGraphId);
  clearTimeout(previous?.timer);
  const attempt = previous === undefined ? 0 : previous.attempt + 1;
  const delayMs = CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[
    Math.min(attempt, CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS.length - 1)
  ]!;
  const onStop = () => cancelRetry(state, contextGraphId);
  const retry: { timer: ReturnType<typeof setTimeout> | undefined; attempt: number } = { timer: undefined, attempt };
  const timer = setTimeout(() => {
    stopSignal?.removeEventListener('abort', onStop);
    if (state.retries.get(contextGraphId) !== retry) return;
    // Fired: kept (for the delay sequence) but no longer pending. The attempt
    // it starts, joins or queues behind a serve-time refresh schedules the next.
    retry.timer = undefined;
    void ensureCoreHostedDefinition(agent, contextGraphId, 'retry');
  }, delayMs);
  timer.unref?.();
  retry.timer = timer;
  stopSignal?.addEventListener('abort', onStop, { once: true });
  state.retries.set(contextGraphId, retry);
  return delayMs;
}

function cancelRetry(state: CoreHostedDefinitionState, contextGraphId: string): void {
  const pending = state.retries.get(contextGraphId);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  state.retries.delete(contextGraphId);
}

/**
 * Fetch the definition from the graph's tied node, once, beside the attempts:
 * when it is connected, was not asked since the definition went missing, the
 * definition is not known to be held, and neither its own fetch, an attempt
 * (which asks it as an owner node) nor a serve-time refresh (which it would
 * queue behind) runs; each asks again when it ends. Never throws.
 */
function askTiedOwnerPeer(agent: CoreHostedDefinitionAgent, state: CoreHostedDefinitionState, contextGraphId: string): void {
  const tie = tieOf(agent, state, contextGraphId);
  if (tie === undefined || tie.asked || state.held.has(contextGraphId) || state.tiedFetches.has(contextGraphId)) return;
  if (state.inFlight.has(contextGraphId) || stopped(agent.node.stopSignal)) return;
  const hosted = hostedOwnerOf(agent, contextGraphId);
  if ('reason' in hosted || hosted.owner !== tie.owner || !isConnected(agent, tie.peerId)) return;
  tie.asked = true;
  const fetch: Promise<void> = fetchFromTiedPeer(agent, state, contextGraphId, tie)
    .catch((error: unknown) => {
      agent.log.info(
        createOperationContext('sync'),
        `Hosted context graph "${contextGraphId}": owner-tied node ${tie.peerId.slice(-8)} not asked: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      if (state.tiedFetches.get(contextGraphId) === fetch) state.tiedFetches.delete(contextGraphId);
      // Another node tied meanwhile.
      askTiedOwnerPeer(agent, state, contextGraphId);
    });
  state.tiedFetches.set(contextGraphId, fetch);
}

/**
 * The tied node's fetch: it schedules, cancels and moves no retry unless it
 * finds the definition held, and stamps no cooldown. The node becomes the
 * definition's source only while it is still the graph's tied node. A copy
 * that replaced the owner's declaration marked held while it ran clears the
 * mark and starts an attempt, which retries until the declaration is held.
 */
async function fetchFromTiedPeer(
  agent: CoreHostedDefinitionAgent,
  state: CoreHostedDefinitionState,
  contextGraphId: string,
  tie: OwnerPeerTie,
): Promise<void> {
  if (!(await holdsCoreHostedOwnerDefinition(agent.store, contextGraphId, tie.owner))) {
    if (!(await refreshFromPeer(agent, contextGraphId, tie.owner, tie.peerId, agent.node.stopSignal))) return;
    if (!(await holdsCoreHostedOwnerDefinition(agent.store, contextGraphId, tie.owner))) {
      if (state.held.delete(contextGraphId)) void ensureCoreHostedDefinition(agent, contextGraphId, 'retry');
      return;
    }
    if (tieOf(agent, state, contextGraphId)?.peerId === tie.peerId) state.sources.set(contextGraphId, tie.peerId);
    agent.log.info(
      createOperationContext('sync'),
      `Hosted context graph "${contextGraphId}": installed the owner's definition from owner-tied node ${tie.peerId.slice(-8)}`,
    );
  }
  markHeld(state, contextGraphId);
}

/**
 * Called for each share a node receives over the direct share protocol, before
 * the share is handled. On a Core, a share into a graph that the owner's
 * wallet signed, naming as its publisher the node that delivered it, ties that
 * node to the graph (`core-hosted-owner-peer-tie.ts`); the graph need not be
 * hosted yet. A share from the node the graph is tied to renews the tie after
 * the envelope's signer's address is read, and nothing more is read of it.
 * Any other share's signature is checked after every other check, within
 * the check budget per sender and in all (`OwnerTieCheckBudget`). Never throws.
 */
export function noteCoreHostedOwnerShare(agentObject: object, wire: Uint8Array, fromPeerId: string): void {
  const agent = agentObject as CoreHostedDefinitionAgent;
  if (agent.config?.nodeRole !== 'core' || fromPeerId === agent.peerId) return;
  try {
    const header = readOwnerShareHeader(wire);
    if (header === null || isSystemGraph(header.contextGraphId)) return;
    const state = stateOf(agentObject);
    if (state.ties.renew(header.contextGraphId, fromPeerId)) return;
    if (agent.localContextGraphProvenance.hasLocalCreate(header.contextGraphId)) return;
    const claim = readOwnerPeerClaim(header, fromPeerId, Date.now());
    if (claim === null || !state.tieChecks.allow(fromPeerId) || !ownerPeerClaimHolds(claim)) return;
    const hosted = agent.subscribedContextGraphs.get(claim.contextGraphId)?.coreHosted === true;
    state.ties.record(claim.contextGraphId, claim.owner, fromPeerId, hosted);
    askTiedOwnerPeer(agent, state, claim.contextGraphId);
  } catch {
    // Bookkeeping beside the share's handling; it never fails the share.
  }
}

/**
 * Called by the StorageACK finality gate for each ACK it commits to for a
 * hosted graph, with the remote peer that asked (none for a local ACK). Only
 * the graph's tied node is asked for the definition ({@link noteCoreHostedOwnerShare}),
 * once while it is missing: any other requester costs nothing. Never throws.
 */
export function noteCoreHostedStorageAck(agentObject: object, contextGraphId: string, requesterPeerId: string | undefined): void {
  const agent = agentObject as CoreHostedDefinitionAgent;
  const state = states.get(agentObject);
  if (state === undefined || requesterPeerId === undefined || tieOf(agent, state, contextGraphId)?.peerId !== requesterPeerId) return;
  askTiedOwnerPeer(agent, state, contextGraphId);
}

/** Whether a retry is pending for the graph, its timer not fired yet (for tests and diagnostics). */
export function hasPendingCoreHostedDefinitionRetry(agent: object, contextGraphId: string): boolean {
  return states.get(agent)?.retries.get(contextGraphId)?.timer !== undefined;
}

/** The node tied to the graph, hosted or not (for tests and diagnostics). */
export function coreHostedOwnerPeerTie(agent: object, contextGraphId: string): string | undefined {
  return states.get(agent)?.ties.get(contextGraphId, false)?.peerId;
}

/** The ties held, hosted and pending (for tests and diagnostics). */
export function coreHostedOwnerPeerTieSizes(agent: object): { readonly hosted: number; readonly pending: number } {
  return stateOf(agent).ties.sizes;
}

/** The running fetch from the graph's tied node; for tests. */
export function pendingCoreHostedDefinitionHint(agent: object, contextGraphId: string): Promise<void> | undefined {
  return states.get(agent)?.tiedFetches.get(contextGraphId);
}

/**
 * Called by the sync responder before it reads the first page of a graph's
 * durable `_meta` for a subscriber. For a hosted graph whose copy is older
 * than {@link CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS}, the Core refreshes
 * it from a connected owner node first, within
 * {@link CORE_HOSTED_DEFINITION_SERVE_REFRESH_BUDGET_MS}, so the page carries
 * what the owner registered since; a refresh that takes longer goes on after
 * the wait and the next requests serve what it installed. No owner node
 * connected: the copy is served as it is. A definition missing then, or after
 * the refresh, is fetched in the background with retries. Never throws;
 * never dials.
 */
export async function refreshCoreHostedDefinitionBeforeServing(
  agentObject: object,
  contextGraphId: string,
  signal?: AbortSignal,
  budgetMs: number = CORE_HOSTED_DEFINITION_SERVE_REFRESH_BUDGET_MS,
): Promise<void> {
  // A request already cancelled by its requester starts no refresh.
  if (signal?.aborted === true) return;
  const agent = agentObject as CoreHostedDefinitionAgent;
  const hosted = hostedOwnerOf(agent, contextGraphId);
  if ('reason' in hosted) return;
  const state = stateOf(agentObject);
  // One budget for the whole refresh, the owner lookup included: a slow
  // agent registry or owner must not hold a subscriber's request.
  const budget = AbortSignal.timeout(budgetMs);
  // One task per graph, shared with the background attempts: requests that
  // arrive together join it instead of each starting a refresh, and a request
  // that stops waiting leaves it running. The tied node's fetch is not one.
  let work = state.inFlight.get(contextGraphId)?.work;
  if (work === undefined) {
    const started: Promise<CoreHostedDefinitionOutcome> = refreshFromConnectedOwner(agent, state, contextGraphId, hosted.owner, budget)
      .catch((): CoreHostedDefinitionOutcome => 'not-found')
      .then((outcome) => afterServeRefresh(agent, state, contextGraphId, started, outcome));
    state.inFlight.set(contextGraphId, { kind: 'serve', work: started });
    work = started;
  }
  await withinBudget(work, budget, signal);
}

/**
 * Free the graph's slot after a serve-time refresh, and start the attempt
 * (owner lookup, connected peers, retries) when the owner's definition is not
 * held (no owner node connected, or the refresh replaced it), or when an
 * attempt was asked for meanwhile, a retry among them, and the definition is
 * not known to be held: the retries go on until it is. (A retry is never
 * pending for a graph marked held: marking it cancels the retry.)
 */
function afterServeRefresh(
  agent: CoreHostedDefinitionAgent,
  state: CoreHostedDefinitionState,
  contextGraphId: string,
  started: Promise<CoreHostedDefinitionOutcome>,
  outcome: CoreHostedDefinitionOutcome | 'missing',
): CoreHostedDefinitionOutcome {
  if (state.inFlight.get(contextGraphId)?.work === started) state.inFlight.delete(contextGraphId);
  const queued = state.fullAfterServe.get(contextGraphId);
  state.fullAfterServe.delete(contextGraphId);
  if (outcome === 'missing' || (queued !== undefined && !state.held.has(contextGraphId))) {
    void ensureCoreHostedDefinition(agent, contextGraphId, outcome === 'missing' ? 'serve' : queued ?? 'serve');
    return outcome === 'missing' ? 'not-found' : outcome;
  }
  askTiedOwnerPeer(agent, state, contextGraphId);
  return outcome;
}

/** The graph's running attempt or refresh, which a request may have stopped waiting for; for tests. */
export function pendingCoreHostedDefinitionRefresh(agent: object, contextGraphId: string): Promise<unknown> | undefined {
  return states.get(agent)?.inFlight.get(contextGraphId)?.work;
}

/**
 * The serve-time refresh's outcome: as an attempt's, or `missing` when the
 * owner's definition is not held after it (no owner node is connected and
 * none is held, or the copy the owner node served replaced it).
 */
async function refreshFromConnectedOwner(
  agent: CoreHostedDefinitionAgent,
  state: CoreHostedDefinitionState,
  contextGraphId: string,
  owner: string,
  budget: AbortSignal,
): Promise<CoreHostedDefinitionOutcome | 'missing'> {
  const lastAttemptAt = state.lastAttemptAt.get(contextGraphId);
  if (lastAttemptAt !== undefined && Date.now() - lastAttemptAt < CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS) return 'held';
  const connected = connectedPeerIds(agent);
  // Not the tied node while its own fetch runs: the refresh would wait behind it.
  const fetching = state.tiedFetches.has(contextGraphId) ? tieOf(agent, state, contextGraphId)?.peerId : undefined;
  const ownerPeer = (await ownerPeerIds(agent, state, contextGraphId, owner, budget).catch(() => []))
    .find((peerId) => connected.has(peerId) && peerId !== fetching);
  if (ownerPeer === undefined) {
    return await holdsCoreHostedOwnerDefinition(agent.store, contextGraphId, owner).catch(() => true) ? 'held' : 'missing';
  }
  state.lastAttemptAt.set(contextGraphId, Date.now());
  // The refresh runs to its own end (the metadata fetch's deadline), not the
  // subscriber's: a `_meta` that takes longer than one request's wait is still
  // installed, and the requests after the wait serve it. Only the wait is
  // bounded, by the caller.
  const refreshed = await refreshFromPeer(agent, contextGraphId, owner, ownerPeer, undefined).catch(() => false);
  if (!refreshed) return 'not-found';
  if (!(await holdsCoreHostedOwnerDefinition(agent.store, contextGraphId, owner).catch(() => false))) {
    // Not held any more: the attempt the caller starts retries until it is.
    state.held.delete(contextGraphId);
    return 'missing';
  }
  state.sources.set(contextGraphId, ownerPeer);
  markHeld(state, contextGraphId);
  return 'fetched';
}

/** `work`'s settlement, or the end of `budget` or `signal`, whichever comes first. */
function withinBudget(work: Promise<unknown>, budget: AbortSignal, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      budget.removeEventListener('abort', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    if (budget.aborted || signal?.aborted) {
      done();
      return;
    }
    budget.addEventListener('abort', done, { once: true });
    signal?.addEventListener('abort', done, { once: true });
    work.then(done, done);
  });
}
