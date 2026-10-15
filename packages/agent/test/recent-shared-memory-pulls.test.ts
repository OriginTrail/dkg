import { afterEach, describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext, DKGEvent } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import {
  RECENT_SHARED_MEMORY_ACTIVITY_WINDOW_MS,
  RECENT_SHARED_MEMORY_PULL_INTERVAL_MS,
  RECENT_SHARED_MEMORY_PULL_TICK_MS,
  RecentSharedMemoryPulls,
  type RecentSharedMemoryPullOptions,
  type RecentSharedMemoryPullPorts,
} from '../src/sync/recent-shared-memory-pulls.js';
import {
  recentSharedMemoryPullsEnabled,
  startRecentSharedMemoryPulls,
} from '../src/recent-shared-memory-pull-runtime.js';
import { emptySharedMemorySyncResult } from '../src/sync/shared-memory-diagnostics.js';
import {
  asSyncOnConnectTestAgent,
  peerSyncSessionDriver,
} from './_helpers/sync-on-connect-test-fixture.js';

// Issue #3251, member C: an always-on member that had already synced a public
// graph and stayed connected to its owner logged no pull of the graph for six
// minutes after the owner stored a member's write. The peer reconciler pulls a
// connected peer again only 10 to 15 minutes after its last sync.

const TICK = RECENT_SHARED_MEMORY_PULL_TICK_MS;
const INTERVAL = RECENT_SHARED_MEMORY_PULL_INTERVAL_MS;

function scheduler(options: RecentSharedMemoryPullOptions = {}) {
  let clock = 1_000_000;
  const pulls: Array<[string, string]> = [];
  const errors: Array<[string, string]> = [];
  const state = {
    subscribed: new Set<string>(),
    eligible: new Set<string>(),
    owners: new Map<string, string[]>(),
    others: [] as string[],
    stored: 0,
    pull: undefined as undefined | ((contextGraphId: string, peerId: string) => Promise<number>),
  };
  const ports: RecentSharedMemoryPullPorts = {
    subscribedGraphs: () => state.subscribed,
    eligible: async (contextGraphId) => state.eligible.has(contextGraphId),
    sources: async (contextGraphId) => ({
      owners: state.owners.get(contextGraphId) ?? [],
      others: state.others,
    }),
    pull: async (contextGraphId, peerId) => {
      pulls.push([contextGraphId, peerId]);
      return state.pull ? state.pull(contextGraphId, peerId) : state.stored;
    },
    onError: (contextGraphId, error) => {
      errors.push([contextGraphId, error instanceof Error ? error.message : String(error)]);
    },
  };
  const pulls$ = new RecentSharedMemoryPulls(ports, { now: () => clock, ...options });
  return {
    pulls$,
    pulls,
    errors,
    state,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('recent shared-memory pulls (#3251)', () => {
  it('pulls a graph in use from its owner every interval and stops when the activity window ends', async () => {
    const h = scheduler();
    h.state.eligible.add('urn:cg:g');
    h.state.owners.set('urn:cg:g', ['owner']);
    h.state.others = ['other'];
    h.pulls$.noteActivity('urn:cg:g');

    expect(await h.pulls$.tick()).toBe(0);
    h.advance(TICK);
    expect(await h.pulls$.tick()).toBe(0);
    h.advance(INTERVAL - TICK);
    expect(await h.pulls$.tick()).toBe(1);
    h.advance(TICK);
    expect(await h.pulls$.tick()).toBe(0);
    h.advance(TICK);
    expect(await h.pulls$.tick()).toBe(1);
    expect(h.pulls).toEqual([['urn:cg:g', 'owner'], ['urn:cg:g', 'owner']]);

    h.advance(RECENT_SHARED_MEMORY_ACTIVITY_WINDOW_MS);
    expect(await h.pulls$.tick()).toBe(0);
    expect(h.pulls$.trackedGraphCount).toBe(0);
  });

  it('keeps a graph in use while its pulls store data', async () => {
    const h = scheduler();
    h.state.eligible.add('urn:cg:g');
    h.state.others = ['peer'];
    h.state.stored = 3;
    h.pulls$.noteActivity('urn:cg:g');

    for (let elapsed = 0; elapsed <= RECENT_SHARED_MEMORY_ACTIVITY_WINDOW_MS * 2; elapsed += INTERVAL) {
      h.advance(INTERVAL);
      await h.pulls$.tick();
    }
    expect(h.pulls$.trackedGraphCount).toBe(1);
    expect(h.pulls.length).toBeGreaterThan(RECENT_SHARED_MEMORY_ACTIVITY_WINDOW_MS / INTERVAL);
  });

  it('counts a subscription made after the first tick, not the ones a restart restores', async () => {
    const h = scheduler();
    h.state.subscribed.add('urn:cg:restored');
    h.state.eligible.add('urn:cg:restored');
    h.state.eligible.add('urn:cg:new');
    await h.pulls$.tick();
    expect(h.pulls$.trackedGraphCount).toBe(0);

    h.state.subscribed.add('urn:cg:new');
    await h.pulls$.tick();
    expect(h.pulls$.trackedGraphCount).toBe(1);

    // Unsubscribed and subscribed again: a new subscription again.
    h.advance(RECENT_SHARED_MEMORY_ACTIVITY_WINDOW_MS);
    h.state.subscribed.delete('urn:cg:new');
    await h.pulls$.tick();
    expect(h.pulls$.trackedGraphCount).toBe(0);
    h.state.subscribed.add('urn:cg:new');
    await h.pulls$.tick();
    expect(h.pulls$.trackedGraphCount).toBe(1);
  });

  it('takes the other connected peers in turn while no owner is connected', async () => {
    const h = scheduler();
    h.state.eligible.add('urn:cg:g');
    h.state.others = ['p1', 'p2'];
    h.pulls$.noteActivity('urn:cg:g');
    for (let round = 0; round < 3; round += 1) {
      h.advance(INTERVAL);
      await h.pulls$.tick();
    }
    expect(h.pulls.map(([, peerId]) => peerId)).toEqual(['p1', 'p2', 'p1']);

    h.state.others = [];
    h.advance(INTERVAL);
    expect(await h.pulls$.tick()).toBe(0);
    expect(h.pulls$.trackedGraphCount).toBe(1);
  });

  it('stops tracking a graph it may no longer pull', async () => {
    const h = scheduler();
    h.state.others = ['peer'];
    h.pulls$.noteActivity('urn:cg:g');
    h.advance(INTERVAL);
    expect(await h.pulls$.tick()).toBe(0);
    expect(h.pulls$.trackedGraphCount).toBe(0);
    expect(h.pulls).toEqual([]);
  });

  it('pulls at most pullsPerTick graphs a tick, the longest unpulled first', async () => {
    const h = scheduler({ pullsPerTick: 2 });
    h.state.others = ['peer'];
    for (const id of ['urn:cg:a', 'urn:cg:b', 'urn:cg:c']) {
      h.state.eligible.add(id);
      h.pulls$.noteActivity(id);
      h.advance(1);
    }
    h.advance(INTERVAL);
    expect(await h.pulls$.tick()).toBe(2);
    h.advance(1);
    expect(await h.pulls$.tick()).toBe(1);
    expect(h.pulls.map(([id]) => id)).toEqual(['urn:cg:a', 'urn:cg:b', 'urn:cg:c']);
  });

  it('never pulls one graph twice at once, and a slow pull does not hold up the next graph', async () => {
    const h = scheduler({ pullWaitMs: 1 });
    h.state.others = ['peer'];
    let finishSlow!: (stored: number) => void;
    h.state.pull = (contextGraphId) => (contextGraphId === 'urn:cg:slow'
      ? new Promise<number>((resolve) => { finishSlow = resolve; })
      : Promise.resolve(0));
    for (const id of ['urn:cg:slow', 'urn:cg:next']) {
      h.state.eligible.add(id);
      h.pulls$.noteActivity(id);
    }
    h.advance(INTERVAL);
    expect(await h.pulls$.tick()).toBe(2);
    h.advance(INTERVAL);
    expect(await h.pulls$.tick()).toBe(1);
    expect(h.pulls.map(([id]) => id)).toEqual(['urn:cg:slow', 'urn:cg:next', 'urn:cg:next']);

    finishSlow(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.advance(INTERVAL);
    expect(await h.pulls$.tick()).toBe(2);
  });

  it('runs one tick at a time', async () => {
    const h = scheduler();
    h.state.eligible.add('urn:cg:g');
    h.state.others = ['peer'];
    let finish!: () => void;
    h.state.pull = () => new Promise<number>((resolve) => { finish = () => resolve(0); });
    h.pulls$.noteActivity('urn:cg:g');
    h.advance(INTERVAL);
    const first = h.pulls$.tick();
    await vi.waitFor(() => expect(h.pulls).toHaveLength(1));
    expect(await h.pulls$.tick()).toBe(0);
    finish();
    expect(await first).toBe(1);
  });

  it('forgets the least recently active graph beyond maxGraphs', async () => {
    const h = scheduler({ maxGraphs: 2 });
    h.state.others = ['peer'];
    for (const id of ['urn:cg:a', 'urn:cg:b', 'urn:cg:c']) h.state.eligible.add(id);
    h.pulls$.noteActivity('urn:cg:a');
    h.pulls$.noteActivity('urn:cg:b');
    h.pulls$.noteActivity('urn:cg:a');
    h.pulls$.noteActivity('urn:cg:c');
    expect(h.pulls$.trackedGraphCount).toBe(2);
    h.advance(INTERVAL);
    await h.pulls$.tick();
    expect(h.pulls.map(([id]) => id).sort()).toEqual(['urn:cg:a', 'urn:cg:c']);
  });

  it('reports a failed source lookup or pull and goes on with the next graph', async () => {
    const h = scheduler();
    h.state.others = ['peer'];
    h.state.pull = async (contextGraphId) => {
      if (contextGraphId === 'urn:cg:failing-pull') throw new Error('stream reset');
      return 0;
    };
    for (const id of ['urn:cg:failing-pull', 'urn:cg:ok']) {
      h.state.eligible.add(id);
      h.pulls$.noteActivity(id);
    }
    h.advance(INTERVAL);
    expect(await h.pulls$.tick()).toBe(2);
    expect(h.errors).toEqual([['urn:cg:failing-pull', 'stream reset']]);

    const failingSources = new RecentSharedMemoryPulls({
      subscribedGraphs: () => [],
      eligible: async () => true,
      sources: async () => { throw new Error('meta read failed'); },
      pull: async () => 0,
      onError: (contextGraphId, error) => {
        h.errors.push([contextGraphId, (error as Error).message]);
      },
    }, { now: () => 0, intervalMs: 0 });
    failingSources.noteActivity('urn:cg:sources');
    expect(await failingSources.tick()).toBe(0);
    expect(h.errors).toContainEqual(['urn:cg:sources', 'meta read failed']);
  });
});

describe('recent shared-memory pull runtime (#3251)', () => {
  const OWNER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
  const OTHER = '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw';
  const GRAPH = '0x1111111111111111111111111111111111111111/public-unregistered';
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    delete process.env.DKG_RECENT_SHARED_MEMORY_PULL_ENABLED;
    vi.restoreAllMocks();
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => {})));
  });

  async function startedMember(name: string) {
    const agent = await DKGAgent.create({
      name,
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    await agent.start();
    const internals = agent as any;
    const coordinator = internals.networkAdmissionCoordinator;
    coordinator.isAcceptedPeer = () => true;
    coordinator.isRejectedPeer = () => false;
    coordinator.ensureAdmitted = async () => true;
    const original = agent.node.libp2p.getPeers.bind(agent.node.libp2p);
    (agent.node.libp2p as any).getPeers = () => [
      ...original(),
      peerIdFromString(OTHER),
      peerIdFromString(OWNER),
    ];
    // The member learned its owner from the join; nothing resolves it otherwise.
    internals.preferredSyncPeers.set(GRAPH, OWNER);
    internals.canUseSharedMemoryForContextGraph = async () => true;
    const sharedPulls: Array<{ peerId: string; contextGraphIds: string[]; source?: string }> = [];
    internals.syncSharedMemoryFromPeerDetailed = async (
      peerId: string,
      contextGraphIds: string[],
      options?: { source?: string },
    ) => {
      sharedPulls.push({ peerId, contextGraphIds, source: options?.source });
      return { ...emptySharedMemorySyncResult(), insertedTriples: 3 };
    };
    const rootReplays: string[] = [];
    internals.requestRfc64CatalogHeadReplaysFromConnectedPeersV1 = async (contextGraphId: string) => {
      rootReplays.push(contextGraphId);
      return { requested: 2, failed: 0 };
    };
    return { agent, internals, sharedPulls, rootReplays };
  }

  it('reproduces member C: the reconciler leaves a freshly synced owner alone, the safety net pulls from it', async () => {
    const { agent, internals, sharedPulls, rootReplays } = await startedMember('Rfc3251MemberC');
    // The agent starts one on an Edge; this test drives its own on a test clock.
    expect(internals.recentSharedMemoryPulls).not.toBeNull();
    internals.recentSharedMemoryPulls.stop();
    let clock = Date.now();
    const runtime = startRecentSharedMemoryPulls(agent, { now: () => clock, tickMs: 3_600_000 });
    try {
      await runtime.tick();
      internals.subscribedContextGraphs.set(GRAPH, {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        syncMode: 'always-on',
      });
      // Root scope owned by the catalog, as on a persistent 10.0.24 member.
      vi.spyOn(internals, 'rfc64LegacySwmGossipAllowedForContextGraph').mockReturnValue(false);

      // Already synced from the owner 30 s ago: the reconciler skips it.
      peerSyncSessionDriver(asSyncOnConnectTestAgent(agent))
        .recordFreshness(OWNER, { successfulAt: Date.now() - 30_000 });
      const reconciled: string[] = [];
      internals.trySyncFromPeer = async (peerId: string) => { reconciled.push(peerId); };
      await internals.reconcileSyncFromConnectedPeers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reconciled).not.toContain(OWNER);

      // The subscription is noticed at the next tick; the write that reaches
      // the owner right after that is pulled within one interval and one tick.
      clock += TICK;
      await runtime.tick();
      expect(sharedPulls).toEqual([]);
      clock += INTERVAL + TICK;
      expect(await runtime.tick()).toBe(1);
      expect(sharedPulls).toEqual([{ peerId: OWNER, contextGraphIds: [GRAPH], source: 'reconcile' }]);
      expect(rootReplays).toEqual([GRAPH]);

      clock += INTERVAL;
      expect(await runtime.tick()).toBe(1);
      expect(sharedPulls.map(({ peerId }) => peerId)).toEqual([OWNER, OWNER]);
    } finally {
      runtime.stop();
    }
  });

  it('pulls nothing on the owner, and no root replay while the graph is on the legacy lane', async () => {
    const { agent, internals, sharedPulls, rootReplays } = await startedMember('Rfc3251Owner');
    internals.recentSharedMemoryPulls.stop();
    let clock = Date.now();
    const runtime = startRecentSharedMemoryPulls(agent, { now: () => clock, tickMs: 3_600_000 });
    try {
      internals.subscribedContextGraphs.set(GRAPH, { subscribed: true, synced: true, syncMode: 'always-on' });
      vi.spyOn(internals, 'rfc64LegacySwmGossipAllowedForContextGraph').mockReturnValue(true);
      internals.preferredSyncPeers.set(GRAPH, agent.peerId);
      runtime.noteActivity(GRAPH);
      clock += INTERVAL;
      expect(await runtime.tick()).toBe(0);

      internals.preferredSyncPeers.set(GRAPH, OWNER);
      const member = startRecentSharedMemoryPulls(agent, { now: () => clock, tickMs: 3_600_000 });
      try {
        member.noteActivity(GRAPH);
        clock += INTERVAL;
        expect(await member.tick()).toBe(1);
      } finally {
        member.stop();
      }
      expect(sharedPulls.map(({ peerId }) => peerId)).toEqual([OWNER]);
      expect(rootReplays).toEqual([]);
    } finally {
      runtime.stop();
    }
  });

  it('takes a received shared-memory write as activity, and a Verified Memory change as none', async () => {
    const { agent, internals, sharedPulls } = await startedMember('Rfc3251Received');
    internals.recentSharedMemoryPulls.stop();
    let clock = Date.now();
    const runtime = startRecentSharedMemoryPulls(agent, { now: () => clock, tickMs: 3_600_000 });
    try {
      internals.subscribedContextGraphs.set(GRAPH, { subscribed: true, synced: true, syncMode: 'always-on' });
      agent.eventBus.emit(DKGEvent.MEMORY_GRAPH_CHANGED, { contextGraphId: GRAPH, layers: ['vm'] });
      agent.eventBus.emit(DKGEvent.MEMORY_GRAPH_CHANGED, { layers: ['swm'] });
      agent.eventBus.emit(DKGEvent.MEMORY_GRAPH_CHANGED, null);
      clock += INTERVAL;
      expect(await runtime.tick()).toBe(0);

      agent.eventBus.emit(DKGEvent.MEMORY_GRAPH_CHANGED, { contextGraphId: GRAPH, layers: ['swm'] });
      clock += INTERVAL;
      expect(await runtime.tick()).toBe(1);
      expect(sharedPulls).toHaveLength(1);

      runtime.stop();
      agent.eventBus.emit(DKGEvent.MEMORY_GRAPH_CHANGED, { contextGraphId: 'urn:cg:later', layers: ['swm'] });
      clock += INTERVAL;
      expect(await runtime.tick()).toBe(1);
      expect(sharedPulls.map(({ contextGraphIds }) => contextGraphIds[0])).toEqual([GRAPH, GRAPH]);
    } finally {
      runtime.stop();
    }
  });

  it('takes an explicit subscribe as activity, also of a graph already subscribed, but not a restore', async () => {
    const { agent, internals, sharedPulls } = await startedMember('Rfc3251Subscribe');
    internals.recentSharedMemoryPulls.stop();
    let clock = Date.now();
    const runtime = startRecentSharedMemoryPulls(agent, { now: () => clock, tickMs: 3_600_000 });
    internals.recentSharedMemoryPulls = runtime;
    try {
      // What a restart does for a persisted subscription.
      agent.subscribeToContextGraph(GRAPH, { syncMode: 'always-on', persist: false });
      await runtime.tick();
      clock += INTERVAL;
      expect(await runtime.tick()).toBe(0);

      // An application that subscribes again, as the issue's client does.
      agent.subscribeToContextGraph(GRAPH, { syncMode: 'always-on' });
      clock += INTERVAL;
      expect(await runtime.tick()).toBe(1);
      expect(sharedPulls.map(({ peerId }) => peerId)).toEqual([OWNER]);
    } finally {
      runtime.stop();
    }
  });

  it('takes a local share as activity', async () => {
    const { internals } = await startedMember('Rfc3251LocalWrite');
    const noted: string[] = [];
    internals.recentSharedMemoryPulls.stop();
    internals.recentSharedMemoryPulls = { noteActivity: (id: string) => { noted.push(id); }, stop: () => {} };
    await internals.publishWorkspaceGossip(GRAPH, new Uint8Array(), createOperationContext('sync'))
      .catch(() => undefined);
    expect(noted).toEqual([GRAPH]);
  });

  it('runs on an Edge whose periodic shared-memory sync is on', () => {
    expect(recentSharedMemoryPullsEnabled({})).toBe(true);
    expect(recentSharedMemoryPullsEnabled({ nodeRole: 'edge' })).toBe(true);
    expect(recentSharedMemoryPullsEnabled({ nodeRole: 'core' })).toBe(false);
    expect(recentSharedMemoryPullsEnabled({ syncReconcilerEnabled: false })).toBe(false);
    expect(recentSharedMemoryPullsEnabled({ syncOnConnectEnabled: false })).toBe(false);
    expect(recentSharedMemoryPullsEnabled({ durableSyncEnabled: false })).toBe(false);
    expect(recentSharedMemoryPullsEnabled({ syncSharedMemoryOnConnect: false })).toBe(false);
    process.env.DKG_RECENT_SHARED_MEMORY_PULL_ENABLED = '0';
    expect(recentSharedMemoryPullsEnabled({})).toBe(false);
  });

  it('skips graphs it may not pull and logs a pull that fails', async () => {
    const debug = vi.fn();
    const subscriptions = new Map<string, Record<string, unknown>>([
      ['agents', { subscribed: true, synced: true, syncMode: 'always-on' }],
      ['urn:cg:on-demand', { subscribed: true, synced: true, syncMode: 'on-demand' }],
      ['urn:cg:private', { subscribed: true, synced: true, syncMode: 'always-on' }],
      ['urn:cg:unconfirmed', { subscribed: true, synced: true, syncMode: 'always-on' }],
      ['urn:cg:failing', { subscribed: true, synced: true, syncMode: 'always-on' }],
    ]);
    const attempted: string[] = [];
    const agentLike = {
      peerId: 'local-peer',
      node: { libp2p: { getPeers: () => [{ toString: () => OTHER }] } },
      subscribedContextGraphs: subscriptions,
      preferredSyncPeers: new Map<string, string>(),
      networkAdmissionCoordinator: { isAcceptedPeer: () => true },
      eventBus: { on: () => {}, off: () => {} },
      log: { debug },
      getCgMeta: async () => ({ curators: [], creators: [] }),
      isPrivateContextGraph: async (contextGraphId: string) => contextGraphId === 'urn:cg:private',
      canUseSharedMemoryForContextGraph: async (contextGraphId: string) => contextGraphId !== 'urn:cg:unconfirmed',
      selectCatchupPeers: (peers: Array<{ toString(): string }>) => peers,
      rfc64LegacySwmGossipAllowedForContextGraph: () => true,
      syncSharedMemoryFromPeerDetailed: async (peerId: string, [contextGraphId]: string[]) => {
        attempted.push(`${contextGraphId}@${peerId}`);
        throw new Error('stream reset');
      },
    };
    let clock = 0;
    const runtime = startRecentSharedMemoryPulls(agentLike, { now: () => clock, tickMs: 3_600_000 });
    try {
      for (const id of [
        'agents', 'urn:cg:unsubscribed', 'urn:cg:on-demand', 'urn:cg:private', 'urn:cg:unconfirmed', 'urn:cg:failing',
      ]) {
        runtime.noteActivity(id);
      }
      clock += INTERVAL;
      expect(await runtime.tick()).toBe(1);
      // Not authorized yet: skipped this round and asked again the next one.
      clock += INTERVAL;
      await runtime.tick();
      // No owner is known, so the one connected peer is asked.
      expect(attempted).toEqual([`urn:cg:failing@${OTHER}`, `urn:cg:failing@${OTHER}`]);
      await vi.waitFor(() => expect(debug).toHaveBeenCalledWith(
        expect.anything(),
        'Safety-net shared-memory pull of "urn:cg:failing" did not run: stream reset',
      ));
    } finally {
      runtime.stop();
    }
  });

  it('logs a failed tick, keeps its timer, and lets go of the event bus when stopped', async () => {
    const debug = vi.fn();
    const listeners = new Map<string, unknown>();
    const agentLike = {
      eventBus: {
        on: (event: string, handler: unknown) => { listeners.set(event, handler); },
        off: (event: string) => { listeners.delete(event); },
      },
      log: { debug },
      subscribedContextGraphs: {
        [Symbol.iterator]: () => { throw new Error('subscriptions unavailable'); },
      },
    };
    const runtime = startRecentSharedMemoryPulls(agentLike, { tickMs: 5 });
    try {
      expect(listeners.has(DKGEvent.MEMORY_GRAPH_CHANGED)).toBe(true);
      await vi.waitFor(() => expect(debug.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(debug).toHaveBeenCalledWith(
        expect.anything(),
        'Safety-net shared-memory pull tick failed: subscriptions unavailable',
      );
    } finally {
      runtime.stop();
    }
    expect(listeners.size).toBe(0);
  });
});
