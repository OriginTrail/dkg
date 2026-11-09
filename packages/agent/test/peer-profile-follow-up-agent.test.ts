import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { buildAgentProfile } from '../src/profile.js';
import { PEER_PROFILE_FOLLOW_UP_DELAYS_MS } from '../src/sync/peer-profile-follow-up.js';
import {
  allowAllNetworkAdmission,
  createUnstartedAgent,
  emptyDetailedSync,
  recorder,
  resetPeerSyncSessionForTest,
  type SyncOnConnectTestAgent,
} from './_helpers/sync-on-connect-test-fixture.js';

const PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
/** Past the first follow-up pull, with room for the store's query. */
const FIRST_FOLLOW_UP_MS = PEER_PROFILE_FOLLOW_UP_DELAYS_MS[0] + 600;

/**
 * An agent of `nodeRole` running the real connect-time pass from PEER, with
 * every durable pull recorded. A pull that runs after `publishedAfterPull`
 * pulls brings PEER's own profile into the local `agents` graph, as the peer
 * publishes it just after it starts serving sync.
 */
async function connectingAgent(name: string, nodeRole: 'core' | 'edge', publishedAfterPull: number) {
  const agent = await createUnstartedAgent(name);
  allowAllNetworkAdmission(agent);
  agent.started = true;
  resetPeerSyncSessionForTest(agent);
  agent.config.nodeRole = nodeRole;
  agent.config.syncContextGraphs = [];
  agent.config.syncSharedMemoryOnConnect = false;
  agent.node.node = {
    getPeers: () => [{ toString: () => PEER }],
    getConnections: () => [{ remotePeer: { toString: () => PEER } }],
  };
  agent.getPeerProtocols = async () => [PROTOCOL_SYNC];
  agent.refreshMetaSyncedFlags = async () => undefined;
  agent.discoverContextGraphsFromStore = async () => 0;
  agent.planSharedMemorySyncContextGraphs = async () => ({ targets: [] });
  const pulls = recorder(async (_peerId: string, contextGraphIds: string[], ..._rest: unknown[]) => {
    if (pulls.calls.length > publishedAfterPull && contextGraphIds.includes(SYSTEM_CONTEXT_GRAPHS.AGENTS)) {
      await agent.store.insert(buildAgentProfile({ peerId: PEER, name: 'remote-core', nodeRole: 'core', skills: [] }).quads);
    }
    return emptyDetailedSync({ completedPhases: 1 });
  });
  agent.syncFromPeerDetailed = pulls;
  return { agent, pulls };
}

const agentsPulls = (calls: unknown[][]) => calls
  .filter(([, contextGraphIds]) => (contextGraphIds as string[]).includes(SYSTEM_CONTEXT_GRAPHS.AGENTS))
  .map(([peerId, contextGraphIds, , , , options]) => ({ peerId, contextGraphIds, source: (options as { source?: string } | undefined)?.source }));

describe('follow-up pull of a peer\'s own agent profile', () => {
  const agents: SyncOnConnectTestAgent[] = [];
  afterEach(async () => {
    for (const agent of agents.splice(0)) {
      agent.peerSyncSession.close();
      await agent.store.close().catch(() => {});
    }
  });

  it('a Core pulls the agents graph again when its connect-time pull lacked the peer\'s own profile', async () => {
    const { agent, pulls } = await connectingAgent('ProfileFollowUpCore', 'core', 1);
    agents.push(agent);

    expect(await agent.trySyncFromPeer(PEER)).toBe('synced');
    expect(agentsPulls(pulls.calls)).toEqual([
      { peerId: PEER, contextGraphIds: [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY], source: 'on-connect' },
    ]);
    await expect(agent.findAgentByPeerId(PEER)).resolves.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, FIRST_FOLLOW_UP_MS));
    expect(agentsPulls(pulls.calls)).toEqual([
      { peerId: PEER, contextGraphIds: [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY], source: 'on-connect' },
      { peerId: PEER, contextGraphIds: [SYSTEM_CONTEXT_GRAPHS.AGENTS], source: 'catchup-background' },
    ]);
    await expect(agent.findAgentByPeerId(PEER)).resolves.toMatchObject({ peerId: PEER, name: 'remote-core' });
  });

  it('pulls nothing more when the connect-time pull brought the profile, or on an Edge, which does not pull the agents graph on connect', async () => {
    const withProfile = await connectingAgent('ProfileFollowUpHeld', 'core', 0);
    const edge = await connectingAgent('ProfileFollowUpEdge', 'edge', 0);
    agents.push(withProfile.agent, edge.agent);

    expect(await withProfile.agent.trySyncFromPeer(PEER)).toBe('synced');
    expect(await edge.agent.trySyncFromPeer(PEER)).toBe('synced');
    await new Promise((resolve) => setTimeout(resolve, FIRST_FOLLOW_UP_MS));

    expect(agentsPulls(withProfile.pulls.calls)).toHaveLength(1);
    expect(agentsPulls(edge.pulls.calls)).toEqual([]);
  });
});
