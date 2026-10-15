// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the safety-net pull of recently active public graphs on an Edge
 * (#3251); see `sync/recent-shared-memory-pulls.ts` for why and its bounds.
 *
 * A pull of one graph from one peer is the graph's ordinary shared-memory
 * sync from that peer, which carries its named sub-graphs (and the root while
 * the graph is not catalog-owned), plus, for a catalog-owned graph, a head
 * replay of the graph's catalog from the connected peers, which carries the
 * root scope.
 */

import {
  createOperationContext,
  DKGEvent,
  SYSTEM_CONTEXT_GRAPHS,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { ContextGraphSub, DKGAgentConfig, SharedMemorySyncResult } from './dkg-agent-types.js';
import { resolveBoundedCuratorSyncPeer } from './dkg-agent-cg-resolve.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  durableSyncEnabled,
  syncOnConnectEnabled,
  syncReconcilerEnabled,
} from './internal/lifecycle-sync-policy.js';
import type { SyncAdmissionSource } from './sync/policy.js';
import {
  RECENT_SHARED_MEMORY_PULL_TICK_MS,
  RecentSharedMemoryPulls,
  type RecentSharedMemoryPullOptions,
} from './sync/recent-shared-memory-pulls.js';
import { resolveBooleanSwitch } from './sync/sync-switches.js';

/** How long a resolved owner peer is reused before it is looked up again. */
export const RECENT_SHARED_MEMORY_OWNER_TTL_MS = 5 * 60_000;

/** The agent registry and the ontology have their own sync and no owner. */
const SYSTEM_CONTEXT_GRAPH_IDS: ReadonlySet<string> = new Set(Object.values(SYSTEM_CONTEXT_GRAPHS));

/** What the safety-net pull uses of the agent. */
interface RecentSharedMemoryPullAgent {
  readonly config: DKGAgentConfig;
  readonly peerId: string;
  readonly node: {
    readonly libp2p: { getPeers(): ReadonlyArray<{ toString(): string }> };
  };
  readonly subscribedContextGraphs: ReadonlyMap<string, ContextGraphSub>;
  readonly preferredSyncPeers: Map<string, string>;
  readonly networkAdmissionCoordinator: { isAcceptedPeer(peerId: string): boolean };
  readonly eventBus: {
    on(event: string, handler: (data: unknown) => void): void;
    off(event: string, handler: (data: unknown) => void): void;
  };
  readonly log: { debug(ctx: OperationContext, message: string): void };
  isPrivateContextGraph(contextGraphId: string): Promise<boolean>;
  canUseSharedMemoryForContextGraph(contextGraphId: string): Promise<boolean>;
  selectCatchupPeers(peers: Array<{ toString(): string }>): Array<{ toString(): string }>;
  rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId: string): boolean;
  syncSharedMemoryFromPeerDetailed(
    remotePeerId: string,
    contextGraphIds: string[],
    options?: { source?: SyncAdmissionSource },
  ): Promise<SharedMemorySyncResult>;
  requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
    contextGraphId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ requested: number; failed: number }>>;
}

export interface RecentSharedMemoryPullRuntime {
  /** The graph is in use here (a local write): keep pulling it for a while. */
  noteActivity(contextGraphId: string): void;
  /** One tick now; the timer runs them otherwise. */
  tick(): Promise<number>;
  stop(): void;
}

/**
 * On for Edges whose automatic sync of shared memory is on (the switches the
 * peer reconciler obeys). Cores host every public graph and receive its
 * writes as hosts, so they do not run it.
 * Env DKG_RECENT_SHARED_MEMORY_PULL_ENABLED=0 turns it off.
 */
export function recentSharedMemoryPullsEnabled(config: DKGAgentConfig): boolean {
  return (config.nodeRole ?? 'edge') === 'edge'
    && syncReconcilerEnabled(config)
    && syncOnConnectEnabled(config)
    && durableSyncEnabled(config)
    && (config.syncSharedMemoryOnConnect ?? true)
    && resolveBooleanSwitch(undefined, 'DKG_RECENT_SHARED_MEMORY_PULL_ENABLED', true);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start the safety net next to the peer reconciler when
 * {@link recentSharedMemoryPullsEnabled}: the reconciler re-pulls a synced
 * peer only every 10 to 15 min. Returns null when it does not run.
 */
export function startRecentSharedMemoryPullsIfEnabled(
  agentObject: DKGAgent | object,
): RecentSharedMemoryPullRuntime | null {
  const agent = agentObject as RecentSharedMemoryPullAgent & {
    readonly node: { readonly stopSignal?: AbortSignal | null };
  };
  if (!recentSharedMemoryPullsEnabled(agent.config)) return null;
  return startRecentSharedMemoryPulls(agentObject, { signal: agent.node.stopSignal ?? undefined });
}

export function startRecentSharedMemoryPulls(
  agentObject: DKGAgent | object,
  options: RecentSharedMemoryPullOptions & {
    readonly tickMs?: number;
    readonly ownerTtlMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): RecentSharedMemoryPullRuntime {
  const agent = agentObject as RecentSharedMemoryPullAgent;
  const ctx = createOperationContext('sync');
  const now = options.now ?? Date.now;
  const ownerTtlMs = options.ownerTtlMs ?? RECENT_SHARED_MEMORY_OWNER_TTL_MS;
  const owners = new Map<string, { readonly peerId?: string; readonly at: number }>();

  const ownerPeerOf = async (contextGraphId: string): Promise<string | undefined> => {
    const cached = owners.get(contextGraphId);
    if (cached !== undefined && now() - cached.at < ownerTtlMs) return cached.peerId;
    const resolution = await resolveBoundedCuratorSyncPeer(
      agentObject as DKGAgent,
      agent.preferredSyncPeers,
      contextGraphId,
      { signal: options.signal },
    );
    owners.set(contextGraphId, { peerId: resolution.peerId, at: now() });
    return resolution.peerId;
  };

  const pulls = new RecentSharedMemoryPulls({
    subscribedGraphs: () => [...agent.subscribedContextGraphs]
      .filter(([, subscription]) => subscription.subscribed && subscription.syncMode === 'always-on')
      .map(([contextGraphId]) => contextGraphId),
    eligible: async (contextGraphId) => {
      if (SYSTEM_CONTEXT_GRAPH_IDS.has(contextGraphId)) return false;
      const subscription = agent.subscribedContextGraphs.get(contextGraphId);
      if (subscription?.subscribed !== true || subscription.syncMode !== 'always-on') return false;
      if (await agent.isPrivateContextGraph(contextGraphId)) return false;
      // The owner holds every write its members send it.
      return (await ownerPeerOf(contextGraphId)) !== agent.peerId;
    },
    sources: async (contextGraphId) => {
      // Authority not confirmed yet: the sync would only be refused. Next interval.
      if (!(await agent.canUseSharedMemoryForContextGraph(contextGraphId))) return { owners: [], others: [] };
      const owner = await ownerPeerOf(contextGraphId);
      const connected = agent.selectCatchupPeers([...agent.node.libp2p.getPeers()])
        .map((peer) => peer.toString())
        .filter((peerId) => agent.networkAdmissionCoordinator.isAcceptedPeer(peerId));
      return {
        owners: connected.filter((peerId) => peerId === owner),
        others: connected.filter((peerId) => peerId !== owner),
      };
    },
    pull: async (contextGraphId, peerId) => {
      const shared = await agent.syncSharedMemoryFromPeerDetailed(peerId, [contextGraphId], {
        source: 'reconcile',
      });
      if (!agent.rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId)) {
        // The catalog owns this graph's root scope: replay its heads.
        await agent.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(contextGraphId, options.signal);
      }
      return shared.insertedTriples;
    },
    onPulled: (contextGraphId, peerId, stored) => agent.log.debug(
      ctx,
      `Safety-net shared-memory pull of "${contextGraphId}" from ${peerId.slice(-8)}: ${stored} triple(s) stored`,
    ),
    onError: (contextGraphId, error) => agent.log.debug(
      ctx,
      `Safety-net shared-memory pull of "${contextGraphId}" did not run: ${errorMessage(error)}`,
    ),
  }, options);

  // A shared-memory write that reached this node means the graph is in use.
  const onMemoryGraphChanged = (data: unknown): void => {
    const event = data as { contextGraphId?: unknown; layers?: unknown } | null;
    if (typeof event?.contextGraphId !== 'string') return;
    if (!Array.isArray(event.layers) || !event.layers.includes('swm')) return;
    pulls.noteActivity(event.contextGraphId);
  };
  agent.eventBus.on(DKGEvent.MEMORY_GRAPH_CHANGED, onMemoryGraphChanged);

  const tick = () => pulls.tick().catch((error: unknown) => {
    agent.log.debug(ctx, `Safety-net shared-memory pull tick failed: ${errorMessage(error)}`);
    return 0;
  });
  const timer = setInterval(() => { void tick(); }, options.tickMs ?? RECENT_SHARED_MEMORY_PULL_TICK_MS);
  timer.unref?.();
  return {
    noteActivity: (contextGraphId) => pulls.noteActivity(contextGraphId),
    tick,
    stop: () => {
      clearInterval(timer);
      agent.eventBus.off(DKGEvent.MEMORY_GRAPH_CHANGED, onMemoryGraphChanged);
    },
  };
}
