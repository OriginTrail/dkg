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
 *    from the owner's node when it can name it, else from connected peers,
 *    and retries with a growing delay while it holds none;
 *  - before it serves the first page of a hosted graph's durable `_meta`, it
 *    refreshes its copy from the owner when the owner is connected and the
 *    copy is older than the cooldown ({@link refreshCoreHostedDefinitionBeforeServing}),
 *    so a sub-graph the owner registered since reaches the subscriber;
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
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { holdsAuthoritativePublicDefinitionV1 } from './context-graph-meta-confirmation.js';
import { runCuratorMetaRefreshFromPeer } from './curator-meta-refresh.js';
import { META_REFRESH_COOLDOWN_MS } from './dkg-agent-constants.js';
import { rfc64UnregisteredAuthorityOwnerV1 } from './rfc64/unregistered-authority-transport-v1.js';

/** Delay before each retry of a fetch that found no definition, then the last one again. */
export const CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 300_000, 600_000,
]);
/** A copy refreshed (or refused) this recently is served as it is. */
export const CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS = META_REFRESH_COOLDOWN_MS;
/** The most a subscriber's request waits for the Core's refresh from the owner. */
export const CORE_HOSTED_DEFINITION_SERVE_REFRESH_BUDGET_MS = 10_000;
/** Owner nodes asked per attempt (an owner wallet may run several nodes). */
export const CORE_HOSTED_DEFINITION_MAX_OWNER_PEERS = 3;
/** Connected peers asked per attempt after the owner's nodes. */
export const CORE_HOSTED_DEFINITION_MAX_FALLBACK_PEERS = 3;

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

/** What keeping a hosted definition needs of the agent. */
export interface CoreHostedDefinitionAgent {
  readonly peerId: string;
  readonly store: TripleStore;
  readonly node: {
    readonly stopSignal?: AbortSignal;
    readonly libp2p: { getConnections(): Array<{ remotePeer: { toString(): string } }> };
  };
  readonly subscribedContextGraphs: ReadonlyMap<string, { readonly coreHosted?: boolean }>;
  readonly localContextGraphProvenance: { hasLocalCreate(contextGraphId: string): boolean };
  readonly discovery: {
    findAgents(options: { agentAddress?: string; signal?: AbortSignal }): Promise<Array<{ peerId: string; agentAddress?: string }>>;
  };
  readonly log: {
    info(ctx: OperationContext, message: string): void;
    warn(ctx: OperationContext, message: string): void;
  };
  resolveRfc64UnregisteredAuthoritySeedPeersV1(options: { contextGraphId?: string }): readonly string[];
}

interface CoreHostedDefinitionState {
  /** One attempt per graph at a time; a caller that comes meanwhile shares it. */
  readonly inFlight: Map<string, Promise<CoreHostedDefinitionOutcome>>;
  /** The pending retry of each graph, with the index of its delay. */
  readonly retries: Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>;
  /** When each graph's copy was last refreshed from the owner, or the refresh refused. */
  readonly lastAttemptAt: Map<string, number>;
}

const states = new WeakMap<object, CoreHostedDefinitionState>();

/** Whether the node is stopping (a function, so that one check does not narrow the next). */
function stopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function stateOf(agent: object): CoreHostedDefinitionState {
  let state = states.get(agent);
  if (state === undefined) {
    state = { inFlight: new Map(), retries: new Map(), lastAttemptAt: new Map() };
    states.set(agent, state);
  }
  return state;
}

/**
 * The owner wallet of a hosted graph this Core should keep the definition of,
 * or the reason it keeps none.
 */
function hostedOwnerOf(
  agent: CoreHostedDefinitionAgent,
  contextGraphId: string,
): { owner: string } | { reason: 'not-hosted' | 'no-owner-namespace' | 'local-author' } {
  if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) return { reason: 'not-hosted' };
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

/** The peer ids of `owner`'s nodes this node knows, connected ones first. */
async function ownerPeerIds(
  agent: CoreHostedDefinitionAgent,
  owner: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  let agents: Array<{ peerId: string; agentAddress?: string }>;
  try {
    agents = await agent.discovery.findAgents({ agentAddress: owner, signal });
  } catch {
    signal?.throwIfAborted();
    return [];
  }
  const connected = connectedPeerIds(agent);
  const peerIds = [...new Set(
    agents.filter((entry) => entry.agentAddress?.toLowerCase() === owner.toLowerCase()).map((entry) => entry.peerId),
  )].filter((peerId) => peerId !== agent.peerId).sort();
  return [
    ...peerIds.filter((peerId) => connected.has(peerId)),
    ...peerIds.filter((peerId) => !connected.has(peerId)),
  ].slice(0, CORE_HOSTED_DEFINITION_MAX_OWNER_PEERS);
}

function connectedPeerIds(agent: CoreHostedDefinitionAgent): Set<string> {
  return new Set(agent.node.libp2p.getConnections().map((connection) => connection.remotePeer.toString()));
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

/**
 * Keep the owner's definition of a hosted graph: fetch it when it is not
 * held, from the owner's nodes first and then from connected peers, and
 * schedule a retry while no peer serves it. Never throws; one attempt per
 * graph runs at a time. `trigger` names the event for the log.
 */
export function ensureCoreHostedDefinition(
  agentObject: object,
  contextGraphId: string,
  trigger: 'recorded' | 'restored' | 'retry' | 'serve',
): Promise<CoreHostedDefinitionOutcome> {
  const agent = agentObject as CoreHostedDefinitionAgent;
  const state = stateOf(agentObject);
  const running = state.inFlight.get(contextGraphId);
  if (running !== undefined) return running;
  const attempt = attemptCoreHostedDefinition(agent, state, contextGraphId, trigger)
    .catch((error: unknown) => {
      // A refresh cut short by the node's stop is not a failure to report.
      if (error instanceof Error && error.name === 'AbortError') return 'not-hosted' as const;
      agent.log.warn(
        createOperationContext('sync'),
        `Could not keep the definition of hosted context graph "${contextGraphId}": `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return 'not-found' as const;
    })
    .finally(() => {
      if (state.inFlight.get(contextGraphId) === attempt) state.inFlight.delete(contextGraphId);
    });
  state.inFlight.set(contextGraphId, attempt);
  return attempt;
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
    return hosted.reason;
  }
  const ctx = createOperationContext('sync');
  if (await holdsCoreHostedOwnerDefinition(agent.store, contextGraphId, hosted.owner)) {
    cancelRetry(state, contextGraphId);
    return 'held';
  }
  const owners = await ownerPeerIds(agent, hosted.owner, stopSignal);
  const fallback = agent.resolveRfc64UnregisteredAuthoritySeedPeersV1({ contextGraphId })
    .filter((peerId) => peerId !== agent.peerId && !owners.includes(peerId))
    .slice(0, CORE_HOSTED_DEFINITION_MAX_FALLBACK_PEERS);
  for (const peerId of [...owners, ...fallback]) {
    if (stopped(stopSignal)) return 'not-hosted';
    state.lastAttemptAt.set(contextGraphId, Date.now());
    if (!(await refreshFromPeer(agent, contextGraphId, hosted.owner, peerId, stopSignal))) continue;
    cancelRetry(state, contextGraphId);
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
  if (previous !== undefined) clearTimeout(previous.timer);
  const attempt = previous === undefined ? 0 : previous.attempt + 1;
  const delayMs = CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS[
    Math.min(attempt, CORE_HOSTED_DEFINITION_RETRY_DELAYS_MS.length - 1)
  ]!;
  const onStop = () => cancelRetry(state, contextGraphId);
  const timer = setTimeout(() => {
    stopSignal?.removeEventListener('abort', onStop);
    if (state.retries.get(contextGraphId)?.timer === timer) {
      // Kept (not deleted) so the next schedule continues the delay sequence.
      void ensureCoreHostedDefinition(agent, contextGraphId, 'retry');
    }
  }, delayMs);
  timer.unref?.();
  stopSignal?.addEventListener('abort', onStop, { once: true });
  state.retries.set(contextGraphId, { timer, attempt });
  return delayMs;
}

function cancelRetry(state: CoreHostedDefinitionState, contextGraphId: string): void {
  const pending = state.retries.get(contextGraphId);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  state.retries.delete(contextGraphId);
}

/** Whether a retry is pending for the graph (for tests and diagnostics). */
export function hasPendingCoreHostedDefinitionRetry(agent: object, contextGraphId: string): boolean {
  return states.get(agent)?.retries.has(contextGraphId) === true;
}

/**
 * Called by the sync responder before it reads the first page of a graph's
 * durable `_meta` for a subscriber. For a hosted graph whose copy is older
 * than {@link CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS}, the Core refreshes
 * it from a connected owner node first, within
 * {@link CORE_HOSTED_DEFINITION_SERVE_REFRESH_BUDGET_MS}, so the page carries
 * what the owner registered since. No owner node connected: the copy is served
 * as it is, and a missing definition is fetched in the background. Never
 * throws; never dials.
 */
export async function refreshCoreHostedDefinitionBeforeServing(
  agentObject: object,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<void> {
  const agent = agentObject as CoreHostedDefinitionAgent;
  const hosted = hostedOwnerOf(agent, contextGraphId);
  if ('reason' in hosted) return;
  const state = stateOf(agentObject);
  const budget = AbortSignal.timeout(CORE_HOSTED_DEFINITION_SERVE_REFRESH_BUDGET_MS);
  const running = state.inFlight.get(contextGraphId);
  if (running !== undefined) {
    await withinBudget(running, budget, signal);
    return;
  }
  const lastAttemptAt = state.lastAttemptAt.get(contextGraphId);
  if (lastAttemptAt !== undefined && Date.now() - lastAttemptAt < CORE_HOSTED_DEFINITION_SERVE_COOLDOWN_MS) return;
  const connected = connectedPeerIds(agent);
  const ownerPeer = (await ownerPeerIds(agent, hosted.owner, signal).catch(() => []))
    .find((peerId) => connected.has(peerId));
  if (ownerPeer === undefined) {
    if (!(await holdsCoreHostedOwnerDefinition(agent.store, contextGraphId, hosted.owner).catch(() => true))) {
      void ensureCoreHostedDefinition(agentObject, contextGraphId, 'serve');
    }
    return;
  }
  state.lastAttemptAt.set(contextGraphId, Date.now());
  const refresh = refreshFromPeer(agent, contextGraphId, hosted.owner, ownerPeer, budget)
    .then((refreshed) => {
      if (refreshed) cancelRetry(state, contextGraphId);
      return refreshed;
    })
    .catch(() => false);
  await withinBudget(refresh, budget, signal);
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
