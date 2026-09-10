import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, type AgentPeerDiscovery, type AgentPeerPage } from '../src/index.js';
import { readAgentPeerPage } from '../src/agent-peer-discovery.js';

const WALLET = '0x00000000000000000000000000000000000000ab';
const CG = `${WALLET}/bounded-curator`;
const EMPTY: AgentPeerPage = { peerIds: [], nextAfterPeerId: null };

describe('bounded curator discovery contract', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    for (const agent of agents.splice(0)) {
      await agent.stop();
      await agent.store.close();
    }
  });
  async function createAgent() {
    const agent = await DKGAgent.create({
      name: 'Bounded curator discovery', listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(), rfc64CatalogActivation: { enabled: false },
    });
    agents.push(agent);
    return agent;
  }

  it('never falls back to rich profiles when an older provider lacks pagination', async () => {
    const agent = await createAgent();
    const findAgents = vi.fn(async () => [{ peerId: 'peer-001', agentAddress: WALLET }]);
    // Deliberately model an untyped older integration. The public type fixture
    // separately proves this provider cannot satisfy AgentPeerDiscovery.
    Object.defineProperty(agent, 'discovery', { value: { findAgents } });
    const refresh = vi.spyOn(agent, 'refreshMetaFromCurator').mockResolvedValue(false);
    await expect(agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2 })).resolves.toMatchObject({
      peerIds: [], lookupFailed: true,
    });
    expect(findAgents).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps metadata refresh bounded after a valid empty first page', async () => {
    const agent = await createAgent();
    const record = await agent.getCgMeta(CG);
    vi.spyOn(agent, 'getCgMeta').mockResolvedValue({
      ...record, curator: `did:dkg:agent:${WALLET}`, curators: [`did:dkg:agent:${WALLET}`],
    });
    const pages = vi.spyOn(agent.discovery, 'findAgentPeerIdsByAddress').mockResolvedValue(EMPTY);
    const rich = vi.spyOn(agent.discovery, 'findAgents').mockRejectedValue(new Error('unbounded registry query'));
    // Run the real refresh/resolution path. No resolved peer means no transport.
    await expect(agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2 })).resolves.toMatchObject({
      peerIds: [], lookupFailed: true,
    });
    expect(pages.mock.calls.map(([, request]) => request.limit)).toEqual([2, 1, 2]);
    expect(rich).not.toHaveBeenCalled();
  });

  it('does not certify a short tail page as a complete roster after registry churn', async () => {
    const agent = await createAgent();
    const pages = vi.spyOn(agent.discovery, 'findAgentPeerIdsByAddress')
      .mockResolvedValueOnce({ peerIds: ['peer-001', 'peer-003'], nextAfterPeerId: 'peer-003' })
      .mockResolvedValueOnce({ peerIds: ['peer-004'], nextAfterPeerId: null });
    const first = await agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2 });
    expect(first).toMatchObject({ overflowed: true, nextPageAfterPeerId: 'peer-003' });
    // Earlier peers may have been deleted and new peers inserted before the
    // cursor. This tail query says nothing about those unobserved entries.
    const tail = await agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2, afterPeerId: first.nextPageAfterPeerId });
    expect(tail).toMatchObject({ peerIds: ['peer-004'], overflowed: true, nextPageAfterPeerId: 'peer-004' });
    expect(pages).toHaveBeenCalledTimes(2);
  });

  it('wraps an exhausted cursor through a fresh bounded first-page query', async () => {
    const agent = await createAgent();
    const pages = vi.spyOn(agent.discovery, 'findAgentPeerIdsByAddress')
      .mockResolvedValueOnce(EMPTY)
      .mockResolvedValueOnce({ peerIds: ['peer-002'], nextAfterPeerId: null });
    const result = await agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2, pagePeerIds: 1, afterPeerId: 'peer-099' });
    expect(result).toEqual({ peerIds: ['peer-002'], curatorIsLocal: false, legacyTripleResolved: false });
    expect(pages.mock.calls.map(([, request]) => request)).toEqual([
      { limit: 1, afterPeerId: 'peer-099', signal: undefined },
      { limit: 2, signal: undefined },
    ]);
  });

  it('keeps the legacy single-curator triple route independent of page discovery', async () => {
    const agent = await createAgent();
    vi.spyOn(agent, 'peerId', 'get').mockReturnValue('peer-self');
    vi.spyOn(agent, 'isCuratorOf').mockResolvedValue(false);
    vi.spyOn(agent, 'resolveCuratorPeerId').mockResolvedValue('peer-legacy');
    const page = vi.spyOn(agent.discovery, 'findAgentPeerIdsByAddress');
    await expect(agent.resolveCuratorPeerIdsForCg('legacy-label', { maxPeerIds: 2 })).resolves.toEqual({
      peerIds: ['peer-legacy'], curatorIsLocal: false, legacyTripleResolved: true,
    });
    expect(page).not.toHaveBeenCalled();
  });

  it('propagates cancellation through a provider that settles after abort', async () => {
    const agent = await createAgent();
    let settle!: (page: AgentPeerPage) => void;
    vi.spyOn(agent.discovery, 'findAgentPeerIdsByAddress').mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const refresh = vi.spyOn(agent, 'refreshMetaFromCurator');
    const controller = new AbortController();
    const pending = agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2, signal: controller.signal });
    controller.abort();
    settle(EMPTY);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    { peerIds: ['peer-001', 'peer-002', 'peer-003'], nextAfterPeerId: null },
    { peerIds: ['peer-002', 'peer-001'], nextAfterPeerId: null },
    { peerIds: ['peer-001', 'peer-001'], nextAfterPeerId: null },
    { peerIds: [''], nextAfterPeerId: null },
    { peerIds: ['peer-001'], nextAfterPeerId: 'peer-001' },
    { peerIds: ['peer-001', 'peer-002'], nextAfterPeerId: 'peer-999' },
    { peerIds: ['peer-001', 'peer-002'] },
  ])('rejects a provider page outside the bounded monotonic contract: %j', async invalid => {
    const provider: AgentPeerDiscovery = {
      findAgentPeerIdsByAddress: async () => invalid as AgentPeerPage,
    };
    await expect(readAgentPeerPage(provider, WALLET, { limit: 2 })).rejects.toThrow();
  });

  it('rejects a page that repeats the exclusive cursor', async () => {
    const provider: AgentPeerDiscovery = {
      findAgentPeerIdsByAddress: async () => ({ peerIds: ['peer-001'], nextAfterPeerId: null }),
    };
    await expect(readAgentPeerPage(provider, WALLET, { limit: 2, afterPeerId: 'peer-001' })).rejects.toThrow('non-monotonic');
  });

  it('rejects an empty cursor instead of restarting a supposedly continued walk', async () => {
    const findAgentPeerIdsByAddress = vi.fn(async () => EMPTY);
    await expect(readAgentPeerPage({ findAgentPeerIdsByAddress }, WALLET, { limit: 2, afterPeerId: '' }))
      .rejects.toThrow('cursor');
    expect(findAgentPeerIdsByAddress).not.toHaveBeenCalled();
  });
});
