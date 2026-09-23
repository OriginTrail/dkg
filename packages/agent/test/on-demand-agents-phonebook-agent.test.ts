/**
 * An Edge with an empty `agents` phonebook and a public wallet-scoped Context
 * Graph whose only holder is the publisher's own Edge (Base mainnet, 2026-09-23).
 *
 * These run against the real agent, store, DiscoveryClient and curator
 * resolver. Only the network edges are replaced: the durable `agents` sync
 * (which inserts the publisher's real profile quads), dialing, admission and
 * the exact KA transport. The key cases reach the feature only through entry
 * points that predate it (subscribe, VM batch recovery, rehydration), so they
 * fail on a build without it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import type { OrdinalRecoveryTarget } from '../src/chain-reconciler.js';
import type { DurableSyncResult } from '../src/dkg-agent-types.js';
import { DKGAgent } from '../src/index.js';
import { buildAgentProfile } from '../src/profile.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const OWNER = '0x64529c023d853371228923B4FdA5FB22F929bf51';
const CG = `${OWNER}/bb-open-20260923-9c3f0`;
const LOCAL_PEER = '12D3KooWFreshBaseEdgeLocal';
const CORE = '12D3KooWAckSigningCoreOne';
const PUBLISHER_EDGE = '12D3KooWPublisherOwnEdge';
// RFC 5737 documentation address: the publisher's Edge is reachable only
// through a relay circuit.
const RELAY = '/ip4/203.0.113.7/tcp/9090/p2p/12D3KooWRelayPeerForPublisher';

interface RecoveryTarget extends OrdinalRecoveryTarget {
  readonly reason: 'no-swm';
}

function recoveryTarget(ordinal: number): RecoveryTarget {
  return {
    localCgId: CG,
    onChainCgId: '1',
    ordinal,
    ual: `did:dkg:base:8453/${OWNER.toLowerCase()}/${ordinal + 198}`,
    merkleRoot: `root-${ordinal}`,
    kaId: String(ordinal + 198),
    reason: 'no-swm',
  };
}

function publisherProfileQuads() {
  return buildAgentProfile({
    peerId: PUBLISHER_EDGE,
    name: 'publisher-base-edge',
    skills: [],
    nodeRole: 'edge',
    agentAddress: OWNER,
    relayAddress: RELAY,
    multiaddrs: [`${RELAY}/p2p-circuit/p2p/${PUBLISHER_EDGE}`],
    lastSeen: new Date().toISOString(),
  }).quads;
}

function durableResult(triples: number): DurableSyncResult {
  return {
    fetchedMetaTriples: 0,
    fetchedDataTriples: triples,
    insertedMetaTriples: 0,
    insertedDataTriples: triples,
    insertedTriples: triples,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 1,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    verifiedPrivateOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    complete: true,
  };
}

type Mutable = Record<string, any>;

/** Recovery asked someone, and only the connected Core. */
function expectOnlyCoreAsked(peers: readonly string[]): void {
  expect(peers.length).toBeGreaterThan(0);
  expect(new Set(peers)).toEqual(new Set([CORE]));
}

/**
 * A fresh Edge connected to one ACK-signing Core that answers clean-absent.
 * The Core serves the network phonebook, which contains the publisher's profile.
 */
async function createFreshEdge(name: string, options: {
  agentsSync?: (peerId: string) => Promise<DurableSyncResult>;
  accessPolicy?: 'public' | 'private';
} = {}) {
  const harness = await createVmRecoveryHostHarness<RecoveryTarget>({
    name,
    localCgId: CG,
    peers: [CORE],
    targetCount: 2,
    targetForOrdinal: recoveryTarget,
    onFetch: (peerId, requested, recovered) => {
      if (peerId !== PUBLISHER_EDGE) return 'clean-absent';
      for (const target of requested) recovered.add(target.ordinal);
      return 'found';
    },
  });
  const agent = harness.agent;
  const internals = agent as unknown as Mutable;
  // The real curator tier: owner wallet -> local phonebook -> peer.
  delete internals.resolveCuratorPeerIdsForCg;
  internals.preferredSyncPeers.delete(CG);
  const connected = [CORE];
  internals.node = {
    peerId: LOCAL_PEER,
    libp2p: {
      getConnections: () => connected.map((peerId) => ({ remotePeer: { toString: () => peerId } })),
      getPeers: () => [],
    },
  };
  internals.knownCorePeerIds.add(CORE);
  // A relay-circuit dial that succeeds adds the connection.
  const ensurePeerConnected = vi.fn(async (peerId: string) => {
    if (!connected.includes(peerId)) connected.push(peerId);
  });
  internals.ensurePeerConnected = ensurePeerConnected;
  internals.gossip = { subscribe: vi.fn(), onMessage: vi.fn(), unsubscribe: vi.fn() };
  const scheduling = { releaseLiveHold: vi.fn(), triggerLive: vi.fn() };
  internals.vmReconcileScheduling = scheduling;
  // Narrow enable seam: the runtime gate needs a started node. Assigning an
  // own property is inert on a build without the feature.
  internals.onDemandAgentsPhonebookEnabled = () => true;
  vi.spyOn(agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue(
    options.accessPolicy === 'private'
      ? { kind: 'private', onChainId: 1n, participantAgents: [OWNER] }
      : { kind: 'public', onChainId: 1n },
  );
  const agentsSync = options.agentsSync ?? (async () => {
    const quads = publisherProfileQuads();
    await agent.store.insert(quads);
    return durableResult(quads.length);
  });
  const syncFromPeerDetailed = vi.spyOn(agent, 'syncFromPeerDetailed').mockImplementation(
    async (peerId, contextGraphIds) => {
      if (contextGraphIds.length === 1 && contextGraphIds[0] === SYSTEM_CONTEXT_GRAPHS.AGENTS) {
        return agentsSync(peerId);
      }
      throw new Error(`unexpected durable sync of ${contextGraphIds.join(',')}`);
    },
  );
  const agentsFetches = () => syncFromPeerDetailed.mock.calls
    .filter(([, contextGraphIds]) => contextGraphIds.includes(SYSTEM_CONTEXT_GRAPHS.AGENTS));
  const info = vi.spyOn(internals.log, 'info');
  const fetchLogLines = () => info.mock.calls
    .map((call) => String(call[1]))
    .filter((line) => line.startsWith('On-demand agents phonebook fetch:'));
  return {
    ...harness,
    agent,
    internals,
    connected,
    ensurePeerConnected,
    scheduling,
    syncFromPeerDetailed,
    agentsFetches,
    fetchLogLines,
    exactPeers: () => harness.fetched.map(({ peerId }) => peerId),
  };
}

describe('on-demand agents phonebook on a fresh Edge', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => undefined)));
  });

  it('subscribing to a public graph fetches the phonebook once, and exact recovery then reaches the publisher', async () => {
    const edge = await createFreshEdge('PhonebookOnSubscribe');
    agents.push(edge.agent);

    edge.agent.subscribeToContextGraph(CG, { syncMode: 'always-on' });

    // Exactly one bounded durable sync of `agents`, from the connected Core.
    await vi.waitFor(() => expect(edge.scheduling.triggerLive).toHaveBeenCalledWith(CG), { timeout: 5_000 });
    expect(edge.agentsFetches()).toHaveLength(1);
    const [peerId, , , , , syncOptions] = edge.agentsFetches()[0]!;
    expect(peerId).toBe(CORE);
    expect(syncOptions).toMatchObject({
      signal: expect.any(AbortSignal),
      totalTimeoutMs: expect.any(Number),
      stopOnBackoffWorthyFailure: true,
      source: 'catchup-background',
    });
    expect(syncOptions!.totalTimeoutMs).toBeLessThanOrEqual(120_000);
    expect(edge.fetchLogLines()).toHaveLength(1);
    expect(edge.fetchLogLines()[0]).toContain('trigger=subscribe');
    expect(edge.fetchLogLines()[0]).toContain('curatorResolved=1/1');
    expect(edge.fetchLogLines()[0]).toContain('profiles=1');

    // The curator tier now resolves owner wallet -> profile -> publisher Edge;
    // recovery dials it through the profile's circuit and asks it first.
    await edge.run();
    expect(edge.ensurePeerConnected).toHaveBeenCalledWith(PUBLISHER_EDGE, expect.anything());
    expect(edge.exactPeers()[0]).toBe(PUBLISHER_EDGE);
    expect(edge.recovered).toEqual(new Set([0, 1]));
    // A resolved curator tier asks for nothing more.
    expect(edge.agentsFetches()).toHaveLength(1);
  });

  it('an empty curator tier during VM recovery fetches the phonebook, re-schedules recovery, and the next pass reaches the publisher', async () => {
    const edge = await createFreshEdge('PhonebookOnVmRecovery');
    agents.push(edge.agent);
    // Subscribed before this build (no subscribe trigger involved).
    edge.internals.subscribedContextGraphs.set(CG, {
      subscribed: true,
      synced: false,
      syncMode: 'always-on',
      onChainId: '1',
    });

    // Pass 1: the tier is empty, so only the connected Core is asked.
    await edge.run();
    expectOnlyCoreAsked(edge.exactPeers());
    expect(edge.recovered.size).toBe(0);

    await vi.waitFor(() => expect(edge.scheduling.triggerLive).toHaveBeenCalledWith(CG), { timeout: 5_000 });
    expect(edge.agentsFetches()).toHaveLength(1);
    expect(edge.fetchLogLines()[0]).toContain('trigger=vm-reconcile');
    expect(edge.scheduling.releaseLiveHold).toHaveBeenCalledWith(CG);

    // Pass 2 runs at once (no clock advance past the per-graph cooldown) and
    // asks the publisher's Edge first.
    const firstPassRequests = edge.exactPeers().length;
    await edge.run();
    expect(edge.ensurePeerConnected).toHaveBeenCalledWith(PUBLISHER_EDGE, expect.anything());
    expect(edge.exactPeers()[firstPassRequests]).toBe(PUBLISHER_EDGE);
    expect(edge.recovered).toEqual(new Set([0, 1]));
    expect(edge.agentsFetches()).toHaveLength(1);
  });

  it('restoring a saved public subscription at startup fetches the phonebook', async () => {
    const edge = await createFreshEdge('PhonebookOnStartup');
    agents.push(edge.agent);
    edge.internals.config.contextGraphSubscriptionStore = {
      loadAll: async () => [{
        id: CG,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        onChainId: '1',
        syncScoped: true,
      }],
      save: async () => undefined,
      delete: async () => undefined,
    };
    vi.spyOn(edge.agent, 'resolveContextGraphSubscriptionBootstrapAuthority').mockResolvedValue({
      outcome: 'allowed',
      source: 'registered-chain',
      reason: 'chain-public',
      metadataBootstrap: 'eligible',
      onChainId: 1n,
    });

    await edge.agent.rehydrateContextGraphSubscriptions(null);

    await vi.waitFor(() => expect(edge.agentsFetches()).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(edge.fetchLogLines()).toHaveLength(1), { timeout: 5_000 });
    expect(edge.fetchLogLines()[0]).toContain('trigger=startup');
    expect(edge.scheduling.triggerLive).toHaveBeenCalledWith(CG);
  });

  it('a curator that becomes resolvable stays behind an earlier clean-absence backoff until recovery is re-scheduled', async () => {
    // The live failure mode: a confirmed but empty curator roster, every
    // connected Core clean-absent, targets in exponential backoff (up to ten
    // minutes). The pre-network gate skips them before curator resolution
    // runs, so the phonebook arriving by itself changes nothing.
    const edge = await createFreshEdge('PhonebookBehindBackoff');
    agents.push(edge.agent);
    edge.internals.onDemandAgentsPhonebookEnabled = () => false;
    edge.internals.subscribedContextGraphs.set(CG, {
      subscribed: true,
      synced: false,
      syncMode: 'always-on',
      onChainId: '1',
    });
    const now = Date.now();
    for (const target of edge.targets) {
      edge.internals.vmReconcileRotationState.set(edge.internals.vmReconcileRotationSlotKey(target), {
        localCgId: CG,
        onChainCgId: target.onChainCgId,
        ordinal: target.ordinal,
        fingerprint: edge.internals.vmReconcileRotationFingerprint(target),
        phase: 'backoff',
        backoffKind: 'clean-absence',
        candidatePeerIds: new Set([CORE]),
        attemptedPeerIds: new Set([CORE]),
        cleanAbsentPeerIds: new Set([CORE]),
        curatorRosterConfirmed: true,
        collectionDeadlineAt: now,
        failures: 4,
        nextRetryAt: now + 10 * 60_000,
      });
    }
    await edge.agent.store.insert(publisherProfileQuads());

    await edge.run();
    expect(edge.exactPeers()).toEqual([]);
    expect(edge.ensurePeerConnected).not.toHaveBeenCalledWith(PUBLISHER_EDGE, expect.anything());

    edge.agent.scheduleVmRecoveryForResolvedCurators([CG]);
    await edge.run();
    expect(edge.ensurePeerConnected).toHaveBeenCalledWith(PUBLISHER_EDGE, expect.anything());
    expect(edge.exactPeers()[0]).toBe(PUBLISHER_EDGE);
    expect(edge.recovered).toEqual(new Set([0, 1]));
    expect(edge.scheduling.triggerLive).toHaveBeenCalledWith(CG);
    expect(edge.agentsFetches()).toHaveLength(0);
  });

  it('does not fetch for a curated graph', async () => {
    const edge = await createFreshEdge('PhonebookPrivateGraph', { accessPolicy: 'private' });
    agents.push(edge.agent);

    edge.agent.subscribeToContextGraph(CG, { syncMode: 'always-on' });
    await edge.agent.onDemandAgentsPhonebook().whenIdle();
    await edge.run();
    await edge.agent.onDemandAgentsPhonebook().whenIdle();

    expect(edge.agentsFetches()).toHaveLength(0);
    expectOnlyCoreAsked(edge.exactPeers());
  });

  it('does nothing when the kill switch is off', async () => {
    const edge = await createFreshEdge('PhonebookKillSwitch');
    agents.push(edge.agent);
    delete edge.internals.onDemandAgentsPhonebookEnabled;
    edge.internals.started = true;
    const previous = process.env.DKG_ON_DEMAND_AGENTS_PHONEBOOK;
    process.env.DKG_ON_DEMAND_AGENTS_PHONEBOOK = '0';
    try {
      expect(edge.agent.onDemandAgentsPhonebookEnabled()).toBe(false);
      edge.agent.subscribeToContextGraph(CG, { syncMode: 'always-on' });
      await edge.agent.onDemandAgentsPhonebook().whenIdle();
      expect(edge.agentsFetches()).toHaveLength(0);
    } finally {
      edge.internals.started = false;
      if (previous === undefined) delete process.env.DKG_ON_DEMAND_AGENTS_PHONEBOOK;
      else process.env.DKG_ON_DEMAND_AGENTS_PHONEBOOK = previous;
    }
  });

  it('does not repeat the fetch for another graph inside the cooldown', async () => {
    const edge = await createFreshEdge('PhonebookCooldown');
    agents.push(edge.agent);
    const otherGraph = '0x00000000000000000000000000000000000000c3/other-open';

    edge.agent.subscribeToContextGraph(CG, { syncMode: 'always-on' });
    await vi.waitFor(() => expect(edge.fetchLogLines()).toHaveLength(1), { timeout: 5_000 });
    edge.agent.subscribeToContextGraph(otherGraph, { syncMode: 'always-on' });
    await edge.agent.onDemandAgentsPhonebook().whenIdle();

    expect(edge.agentsFetches()).toHaveLength(1);
  });

  it('degrades to connected peers when no peer is usable or the fetch fails', async () => {
    const edge = await createFreshEdge('PhonebookFetchFails', {
      agentsSync: async () => { throw new Error('The stream has been reset'); },
    });
    agents.push(edge.agent);

    edge.agent.subscribeToContextGraph(CG, { syncMode: 'always-on' });
    await vi.waitFor(() => expect(edge.fetchLogLines()).toHaveLength(1), { timeout: 5_000 });
    expect(edge.fetchLogLines()[0]).toContain('outcome=failed');
    expect(edge.scheduling.triggerLive).not.toHaveBeenCalled();

    await edge.run();
    expectOnlyCoreAsked(edge.exactPeers());
    expect(edge.agentsFetches()).toHaveLength(1);

    // No usable peer at all: nothing is fetched and nothing throws.
    const isolated = await createFreshEdge('PhonebookNoPeers');
    agents.push(isolated.agent);
    isolated.connected.splice(0);
    isolated.agent.subscribeToContextGraph(CG, { syncMode: 'always-on' });
    await isolated.agent.onDemandAgentsPhonebook().whenIdle();
    expect(isolated.agentsFetches()).toHaveLength(0);
    await expect(isolated.run()).resolves.toBeDefined();
  });

  it('re-scheduling clears the suppression that would otherwise delay the new curator', async () => {
    const edge = await createFreshEdge('PhonebookRescheduleState');
    agents.push(edge.agent);
    const target = edge.targets[0]!;
    const slotKey = edge.internals.vmReconcileRotationSlotKey(target);
    edge.internals.subscribedContextGraphs.set(CG, { subscribed: true, synced: false, syncMode: 'always-on' });
    edge.internals.vmReconcileRotationState.set(slotKey, {
      localCgId: CG,
      onChainCgId: target.onChainCgId,
      ordinal: target.ordinal,
      fingerprint: 'stale',
      phase: 'backoff',
      backoffKind: 'clean-absence',
      candidatePeerIds: new Set([CORE]),
      attemptedPeerIds: new Set([CORE]),
      cleanAbsentPeerIds: new Set([CORE]),
      curatorRosterConfirmed: true,
      collectionDeadlineAt: 0,
      failures: 3,
      nextRetryAt: Date.now() + 10 * 60_000,
    });
    edge.internals.installVmReconcileActiveFetchCooldown(CG, Date.now());
    edge.internals.vmReconcileCuratorPeersByCg.set(CG, ['12D3KooWStaleCurator']);

    edge.agent.scheduleVmRecoveryForResolvedCurators([CG, 'not-subscribed']);

    expect(edge.internals.vmReconcileRotationState.has(slotKey)).toBe(false);
    expect(edge.internals.readVmReconcileActiveFetchCooldown(CG)).toBeUndefined();
    expect(edge.internals.vmReconcileCuratorPeersByCg.has(CG)).toBe(false);
    expect(edge.scheduling.releaseLiveHold).toHaveBeenCalledWith(CG);
    expect(edge.scheduling.triggerLive).toHaveBeenCalledWith(CG);
    expect(edge.scheduling.triggerLive).not.toHaveBeenCalledWith('not-subscribed');
  });
});

describe('onDemandAgentsPhonebookEnabled', () => {
  const gate = (host: Record<string, unknown>) => (
    DKGAgent.prototype.onDemandAgentsPhonebookEnabled.call(host as unknown as DKGAgent)
  );
  const envKeys = [
    'DKG_ON_DEMAND_AGENTS_PHONEBOOK',
    'DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT',
    'DKG_DURABLE_SYNC_ENABLED',
  ] as const;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of envKeys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  function setEnv(key: typeof envKeys[number], value: string): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  it('is on for a running Edge and off for a stopped one, a Core, or with durable sync off', () => {
    for (const key of envKeys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    expect(gate({ started: true, config: {} })).toBe(true);
    expect(gate({ started: true, config: { nodeRole: 'edge' } })).toBe(true);
    expect(gate({ started: false, config: {} })).toBe(false);
    expect(gate({ started: true, config: { nodeRole: 'core' } })).toBe(false);
    expect(gate({ started: true, config: { durableSyncEnabled: false } })).toBe(false);
    expect(gate({ started: true, config: { onDemandAgentsPhonebook: false } })).toBe(false);
    expect(gate({ started: true, config: { syncSystemContextGraphsOnConnect: true } })).toBe(false);
  });

  it('honours the environment over config', () => {
    setEnv('DKG_ON_DEMAND_AGENTS_PHONEBOOK', '0');
    expect(gate({ started: true, config: { onDemandAgentsPhonebook: true } })).toBe(false);
    setEnv('DKG_ON_DEMAND_AGENTS_PHONEBOOK', '1');
    expect(gate({ started: true, config: { onDemandAgentsPhonebook: false } })).toBe(true);
    setEnv('DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT', '1');
    expect(gate({ started: true, config: {} })).toBe(false);
  });
});
