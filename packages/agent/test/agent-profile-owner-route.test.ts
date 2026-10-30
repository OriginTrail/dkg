// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's wiring of profile updates and of the owner route, on the real
 * agent, store, discovery and on-demand phonebook. Only the network edges are
 * replaced. A wallet's peers are a stale peer of an earlier run and a live one
 * of the current run, in the order that used to starve the live one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  PROTOCOL_SWM_UPDATE,
  SYSTEM_CONTEXT_GRAPHS,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { AGENT_PROFILE_STALE_THRESHOLD_MS } from '../src/dkg-agent-constants.js';
import type { DurableSyncResult } from '../src/dkg-agent-types.js';
import { DKGAgent } from '../src/index.js';
import { AGENT_PROFILE_RESEND_DELAYS_MS } from '../src/p2p/agent-profile-resends.js';
import { AGENT_REGISTRY_GRAPH, buildAgentProfile } from '../src/profile.js';
import { GRAPH_OWNER_RETRY_AFTER_MS, routeShareToGraphOwner } from '../src/swm/relay-only-share-routes.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const OWNER = '0x00000000000000000000000000000000000000ee';
const CG = `${OWNER}/owner-route`;
const LOCAL_PEER = '12D3KooWLocalEdge';
const CORE = '12D3KooWConnectedCore';
/** Real peer ids: the two dead peers of earlier runs sort ahead of the live one. */
const [DEAD_1, DEAD_2, LIVE] = (await Promise.all([1, 2, 3].map(async () => (
  peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
)))).sort() as [string, string, string];
const DKG = 'https://dkg.network/ontology#';

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

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

/** A profile under its own subject, so that its peer and its `dkg:lastSeen` stay paired. */
function pairedProfile(peerId: string, lastSeen: string): Quad[] {
  const { quads, rootEntity } = buildAgentProfile({ peerId, name: peerId, skills: [], lastSeen });
  return [...quads, { subject: rootEntity, predicate: `${DKG}agentAddress`, object: `"${OWNER}"`, graph: AGENT_REGISTRY_GRAPH }];
}

function ownerProfile(peerId: string, lastSeen: string): Quad[] {
  return buildAgentProfile({ peerId, name: 'Owner', skills: [], agentAddress: OWNER, lastSeen }).quads;
}

type Mutable = Record<string, any>;

async function createEdge(name: string, options: { reachable?: readonly string[]; agentsSync?: () => Promise<DurableSyncResult> } = {}) {
  const harness = await createVmRecoveryHostHarness<any>({
    name,
    localCgId: CG,
    peers: [CORE],
    targetCount: 0,
    targetForOrdinal: () => { throw new Error('no VM recovery here'); },
    onFetch: () => 'clean-absent',
  });
  const agent = harness.agent;
  const internals = agent as unknown as Mutable;
  delete internals.resolveCuratorPeerIdsForCg;
  internals.preferredSyncPeers.delete(CG);
  const connected = new Set<string>([CORE]);
  internals.node = {
    peerId: LOCAL_PEER,
    libp2p: {
      getConnections: () => [...connected].map((peerId) => ({ remotePeer: { toString: () => peerId } })),
      getPeers: () => [...connected].map((peerId) => ({ toString: () => peerId })),
      peerStore: { get: async () => ({ protocols: [PROTOCOL_SWM_UPDATE] }) },
    },
  };
  const dials: string[] = [];
  internals.ensurePeerConnected = vi.fn(async (peerId: string) => {
    dials.push(peerId);
    if ((options.reachable ?? []).includes(peerId)) connected.add(peerId);
  });
  internals.onDemandAgentsPhonebookEnabled = () => true;
  const agentsSync = vi.fn(options.agentsSync ?? (async () => durableResult(0)));
  vi.spyOn(agent, 'syncFromPeerDetailed').mockImplementation(async (_peerId, contextGraphIds) => {
    if (contextGraphIds[0] === SYSTEM_CONTEXT_GRAPHS.AGENTS) return agentsSync();
    throw new Error(`unexpected sync of ${contextGraphIds.join(',')}`);
  });
  return { agent, internals, connected, dials, agentsSync };
}

describe('the owner route on a wallet with stale and live peers', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => undefined)));
  });

  it('reaches the newest peer first, whatever dead peers sort ahead of it', async () => {
    const { agent, dials } = await createEdge('RouteNewestFirst', { reachable: [LIVE] });
    agents.push(agent);
    await agent.store.insert([
      ...pairedProfile(DEAD_1, ago(6 * 3_600_000)),
      ...pairedProfile(DEAD_2, ago(5 * 3_600_000)),
      ...pairedProfile(LIVE, ago(60_000)),
    ]);
    const routed = await routeShareToGraphOwner(agent.graphOwnerRoutePortsV1(), CG);
    expect(routed).toEqual([LIVE]);
    expect(dials).toEqual([LIVE]);
  });

  it('does not count a wallet with only stale peers as resolved, and fetches the phonebook for it', async () => {
    let edge!: Awaited<ReturnType<typeof createEdge>>;
    edge = await createEdge('RouteOnlyStale', {
      reachable: [LIVE],
      agentsSync: async () => {
        const quads = ownerProfile(LIVE, ago(60_000));
        await (edge.agent as unknown as Mutable).insertSyncedQuadsAndInvalidateListCache(quads);
        return durableResult(quads.length);
      },
    });
    agents.push(edge.agent);
    await edge.agent.store.insert(ownerProfile(DEAD_1, ago(AGENT_PROFILE_STALE_THRESHOLD_MS + 60_000)));
    const deps = edge.agent.createOnDemandAgentsPhonebookDeps();
    await expect(deps.phonebookHasWallet(OWNER, new AbortController().signal)).resolves.toBe(false);

    const routed = await routeShareToGraphOwner(edge.agent.graphOwnerRoutePortsV1(), CG);
    expect(edge.agentsSync).toHaveBeenCalledTimes(1);
    expect(routed).toEqual([LIVE]);
    expect(edge.dials).toEqual([LIVE]);
    await expect(deps.phonebookHasWallet(OWNER, new AbortController().signal)).resolves.toBe(true);
  });

  it('routes to a connected owner peer however old its profile, and counts its wallet as resolved', async () => {
    const { agent, connected, dials, agentsSync } = await createEdge('RouteConnectedStale');
    agents.push(agent);
    await agent.store.insert(ownerProfile(DEAD_1, ago(AGENT_PROFILE_STALE_THRESHOLD_MS + 60_000)));
    connected.add(DEAD_1);
    await expect(routeShareToGraphOwner(agent.graphOwnerRoutePortsV1(), CG)).resolves.toEqual([DEAD_1]);
    expect(dials).toEqual([]);
    expect(agentsSync).not.toHaveBeenCalled();
    await expect(agent.createOnDemandAgentsPhonebookDeps().phonebookHasWallet(OWNER, new AbortController().signal)).resolves.toBe(true);
  });

  it('dials nothing and leaves the share to go without an owner it has no current peer of', async () => {
    const { agent, dials, agentsSync } = await createEdge('RouteOnlyStaleEverywhere');
    agents.push(agent);
    await agent.store.insert(ownerProfile(DEAD_1, ago(AGENT_PROFILE_STALE_THRESHOLD_MS + 60_000)));
    await expect(routeShareToGraphOwner(agent.graphOwnerRoutePortsV1(), CG)).resolves.toEqual([]);
    expect(dials).toEqual([]);
    expect(agentsSync).toHaveBeenCalledTimes(1);
  });

  it('does not count a wallet whose peers all failed lately as resolved, unless one is connected', async () => {
    const { agent, connected } = await createEdge('RouteAllFailed');
    agents.push(agent);
    await agent.store.insert(ownerProfile(DEAD_1, ago(60_000)));
    const deps = agent.createOnDemandAgentsPhonebookDeps();
    const signal = new AbortController().signal;
    await expect(deps.phonebookHasWallet(OWNER, signal)).resolves.toBe(true);

    agent.graphOwnerRoutePortsV1().connectFailed(DEAD_1);
    await expect(deps.phonebookHasWallet(OWNER, signal)).resolves.toBe(false);

    connected.add(DEAD_1);
    await expect(deps.phonebookHasWallet(OWNER, signal)).resolves.toBe(true);
  });

  it('asks the phonebook again once every peer it knows has failed, and takes the peer it brings', async () => {
    let edge!: Awaited<ReturnType<typeof createEdge>>;
    edge = await createEdge('RouteRefetch', {
      reachable: [LIVE],
      agentsSync: async () => {
        const quads = ownerProfile(LIVE, new Date().toISOString());
        await (edge.agent as unknown as Mutable).insertSyncedQuadsAndInvalidateListCache(quads);
        return durableResult(quads.length);
      },
    });
    agents.push(edge.agent);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await edge.agent.store.insert(ownerProfile(DEAD_1, ago(60_000)));
    await expect(routeShareToGraphOwner(edge.agent.graphOwnerRoutePortsV1(), CG)).resolves.toEqual([]);
    expect(edge.dials).toEqual([DEAD_1]);
    expect(edge.agentsSync).toHaveBeenCalledTimes(0);

    vi.setSystemTime(Date.now() + GRAPH_OWNER_RETRY_AFTER_MS + 1);
    await expect(routeShareToGraphOwner(edge.agent.graphOwnerRoutePortsV1(), CG)).resolves.toEqual([LIVE]);
    expect(edge.agentsSync).toHaveBeenCalledTimes(1);
    expect(edge.dials).toEqual([DEAD_1, LIVE]);
  });

  it('routes as before for a graph this node owns, and for one without an owner wallet', async () => {
    const { agent, internals, dials, agentsSync } = await createEdge('RouteOwnGraph');
    agents.push(agent);
    internals.localAgents.set(OWNER, { agentAddress: OWNER });
    await expect(routeShareToGraphOwner(agent.graphOwnerRoutePortsV1(), CG)).resolves.toEqual([]);
    expect(dials).toEqual([]);
    expect(agentsSync).not.toHaveBeenCalled();
  });

  it('uses the resolver\'s answer for a graph without an owner wallet', async () => {
    const { agent, internals, dials } = await createEdge('RouteNoWallet', { reachable: [LIVE] });
    agents.push(agent);
    internals.resolveCuratorPeerIdsForCg = vi.fn(async () => ({ peerIds: [LOCAL_PEER, LIVE], curatorIsLocal: false, legacyTripleResolved: true }));
    await expect(routeShareToGraphOwner(agent.graphOwnerRoutePortsV1(), 'legacy-graph')).resolves.toEqual([LIVE]);
    expect(dials).toEqual([LIVE]);
  });
});

describe('a synced agent profile', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => undefined)));
  });

  it('replaces the stored peers when newer, and adds nothing when a Core serves an older copy', async () => {
    const { agent, internals } = await createEdge('SyncedProfile');
    agents.push(agent);
    const peers = async () => (await agent.discovery.findAgentPeerPageByAddress(OWNER, { limit: 8 })).peerIds;

    await internals.insertSyncedQuadsAndInvalidateListCache(ownerProfile(DEAD_1, ago(3_600_000)));
    await internals.insertSyncedQuadsAndInvalidateListCache(ownerProfile(LIVE, ago(60_000)));
    expect(await peers()).toEqual([LIVE]);

    await internals.insertSyncedQuadsAndInvalidateListCache(ownerProfile(DEAD_2, ago(1_800_000)));
    expect(await peers()).toEqual([LIVE]);
  });

  it('still drops an oversized literal and passes the other graphs of the batch', async () => {
    const { agent, internals } = await createEdge('SyncedOversize');
    agents.push(agent);
    const other = { subject: 'did:dkg:test:s', predicate: 'did:dkg:test:p', object: '"o"', graph: 'did:dkg:context-graph:other' };
    const oversized = { ...other, object: `"${'x'.repeat(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES + 1)}"` };
    await internals.insertSyncedQuadsAndInvalidateListCache([...ownerProfile(LIVE, ago(60_000)), other, oversized]);
    expect(await agent.store.countQuads('did:dkg:context-graph:other')).toBe(1);
    expect((await agent.discovery.findAgentPeerPageByAddress(OWNER, { limit: 8 })).peerIds).toEqual([LIVE]);
  });
});

describe('broadcasting this node\'s profile', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => undefined)));
  });

  it('sends it again until an admitted peer got it, and logs when it gives up', async () => {
    const { agent, internals } = await createEdge('ProfileBroadcast');
    agents.push(agent);
    internals.started = true;
    const publish = vi.fn(async (): Promise<string[]> => []);
    internals.gossip = { publish };
    const admitted = vi.spyOn(internals.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(false);
    const warn = vi.spyOn(internals.log, 'warn');
    const info = vi.spyOn(internals.log, 'info');
    vi.useFakeTimers();

    const result = { ual: 'did:dkg:mock:31337/0x1/1', publicQuads: [], kaManifest: [] };
    const ctx = createOperationContext('publish');
    await agent.broadcastAgentProfile(result as never, ctx);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(publish).toHaveBeenCalledTimes(AGENT_PROFILE_RESEND_DELAYS_MS.length + 1);
    expect(warn.mock.calls.some(([, message]) => String(message).includes('reached no admitted peer'))).toBe(true);

    publish.mockClear();
    publish.mockResolvedValue(['12D3KooWJoining']);
    admitted.mockReturnValue(true);
    await agent.broadcastAgentProfile(result as never, ctx);
    await vi.runAllTimersAsync();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(admitted).toHaveBeenCalledWith('12D3KooWJoining');
    expect(info).toHaveBeenCalled();

    publish.mockClear();
    publish.mockRejectedValueOnce(new Error('no peers subscribed'));
    await agent.broadcastAgentProfile(result as never, ctx);
    await vi.runAllTimersAsync();
    expect(publish, 'a broadcast that failed counts as reaching nobody').toHaveBeenCalledTimes(2);

    internals.started = false;
    publish.mockClear();
    publish.mockResolvedValue([]);
    await agent.broadcastAgentProfile(result as never, ctx);
    await vi.runAllTimersAsync();
    expect(publish, 'a stopped node sends nothing more').toHaveBeenCalledTimes(1);
  });
});
