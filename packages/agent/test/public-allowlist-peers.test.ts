/**
 * The members of a curated public graph as recipients of its shares (#3421):
 * the connected peers of the agents on the graph's allowlist, as the local
 * agent registry maps them. The fan-out that sends to them is covered in
 * `swm-shares-through-relay.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import {
  PUBLIC_ALLOWLIST_PEERS_TTL_MS,
  PublicAllowlistPeers,
  publicAllowlistPeersOf,
  type PublicAllowlistPeerPorts,
} from '../src/swm/public-allowlist-peers.js';

const GRAPH = '0x1111111111111111111111111111111111111111/curated';
const AGENT_1 = '0x2222222222222222222222222222222222222222';
const AGENT_2 = '0x3333333333333333333333333333333333333333';
const AGENT_3 = '0x4444444444444444444444444444444444444444';
const SELF = '12D3KooWSelfOfThisNode';

function members(overrides: Partial<PublicAllowlistPeerPorts> = {}) {
  let clock = 1_000;
  const lookups: string[] = [];
  const connected = new Set(['peer-1', 'peer-2b', 'peer-3', SELF]);
  const registry: Record<string, string[]> = {
    [AGENT_1]: ['peer-1'],
    [AGENT_2]: ['peer-2a', 'peer-2b'],
    [AGENT_3]: ['peer-3'],
  };
  const ports: PublicAllowlistPeerPorts = {
    allowlist: async () => ({
      allowedAgents: [`did:dkg:agent:${AGENT_1.toUpperCase().replace('0X', '0x')}`, AGENT_2, 'not-an-address'],
      participantAgents: [AGENT_3, AGENT_1],
      revokedAgents: [AGENT_3],
    }),
    peersOfAgent: async (agentAddress) => {
      lookups.push(agentAddress);
      return registry[agentAddress] ?? [];
    },
    isConnected: (peerId) => connected.has(peerId),
    selfPeerId: () => SELF,
    now: () => clock,
    ...overrides,
  };
  return { peers: new PublicAllowlistPeers(ports), lookups, connected, advance: (ms: number) => { clock += ms; } };
}

describe('the connected peers of a curated public graph\'s members (#3421)', () => {
  it('are the registered peers of the allowed agents and participants that are connected, not revoked ones', async () => {
    const { peers, lookups } = members();

    expect((await peers.connected(GRAPH)).sort()).toEqual(['peer-1', 'peer-2b']);
    expect(lookups.sort()).toEqual([AGENT_1, AGENT_2]);
  });

  it('look the registry up once a minute, and read the connections at every call', async () => {
    const { peers, lookups, connected, advance } = members();

    await peers.connected(GRAPH);
    connected.add('peer-2a');
    expect((await peers.connected(GRAPH)).sort()).toEqual(['peer-1', 'peer-2a', 'peer-2b']);
    expect(lookups).toHaveLength(2);
    advance(PUBLIC_ALLOWLIST_PEERS_TTL_MS);
    await peers.connected(GRAPH);
    expect(lookups).toHaveLength(4);
  });

  it('leave out an agent whose registry lookup fails, and are none when the allowlist cannot be read', async () => {
    const failingAgent = members({
      peersOfAgent: async (agentAddress) => {
        if (agentAddress === AGENT_2) throw new Error('store closed');
        return agentAddress === AGENT_1 ? ['peer-1'] : [];
      },
    });
    expect(await failingAgent.peers.connected(GRAPH)).toEqual(['peer-1']);

    const failingAllowlist = members({ allowlist: async () => { throw new Error('meta unavailable'); } });
    expect(await failingAllowlist.peers.connected(GRAPH)).toEqual([]);
  });

  it('look up at most 64 agents of a graph, and keep at most 256 graphs', async () => {
    const many = Array.from({ length: 70 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`);
    const { peers, lookups } = members({
      allowlist: async () => ({ allowedAgents: many, participantAgents: [], revokedAgents: [] }),
    });
    await peers.connected(GRAPH);
    expect(lookups).toHaveLength(64);

    for (let index = 0; index < 257; index += 1) await peers.connected(`${GRAPH}-${index}`);
    lookups.length = 0;
    await peers.connected(`${GRAPH}-256`);
    expect(lookups).toEqual([]);
    await peers.connected(`${GRAPH}-0`);
    expect(lookups).toHaveLength(64);
  });

  it('come from the agent\'s graph metadata, its agent registry and its connections', async () => {
    const agent = await DKGAgent.create({ name: 'PublicAllowlistPeersWiring', chainAdapter: new MockChainAdapter() });
    const host = agent as unknown as {
      node: object;
      getCgMeta: (contextGraphId: string) => Promise<unknown>;
      discovery: { findAgentPeerPageByAddress: (address: string, request: { limit: number }) => Promise<unknown> };
    };
    host.getCgMeta = async () => ({ allowedAgents: [AGENT_1, AGENT_2], participantAgents: [], revokedAgents: [] });
    const asked: Array<[string, number]> = [];
    host.discovery.findAgentPeerPageByAddress = async (address, { limit }) => {
      asked.push([address, limit]);
      return { peerIds: address === AGENT_1 ? ['peer-1'] : ['peer-2'], nextAfterPeerId: null };
    };
    Object.defineProperty(host.node, 'libp2p', {
      value: { getPeers: () => [{ toString: () => 'peer-2' }] },
      configurable: true,
    });
    Object.defineProperty(host.node, 'peerId', { value: SELF, configurable: true });

    expect(publicAllowlistPeersOf(agent)).toBe(publicAllowlistPeersOf(agent));
    expect(await publicAllowlistPeersOf(agent).connected(GRAPH)).toEqual(['peer-2']);
    expect(asked).toEqual([[AGENT_1, 8], [AGENT_2, 8]]);
  });
});
