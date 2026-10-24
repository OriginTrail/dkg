import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, type AgentPeerDiscovery, type AgentPeerPage } from '../src/index.js';
import { readAgentPeerPage, validateAgentPeerPage } from '../src/agent-peer-discovery.js';
import { traverseBoundedCuratorRoster } from '../src/bounded-curator-roster-traversal.js';
import {
  authoritativeSyncPeerId,
  resolveBoundedCuratorSyncPeer,
} from '../src/dkg-agent-cg-resolve.js';

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
    const findAgentPeerIdsByAddress = vi.fn(async () => ['peer-001']);
    Object.defineProperty(agent, 'discovery', { value: { findAgents, findAgentPeerIdsByAddress } });
    const refresh = vi.spyOn(agent, 'refreshMetaFromCurator').mockResolvedValue(false);
    await expect(agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2 })).resolves.toMatchObject({
      peerIds: [], lookupFailed: true,
    });
    expect(findAgents).not.toHaveBeenCalled();
    expect(findAgentPeerIdsByAddress).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps metadata refresh bounded after a valid empty first page', async () => {
    const agent = await createAgent();
    const record = await agent.getCgMeta(CG);
    vi.spyOn(agent, 'getCgMeta').mockResolvedValue({
      ...record, curator: `did:dkg:agent:${WALLET}`, curators: [`did:dkg:agent:${WALLET}`],
    });
    const pages = vi.spyOn(agent.discovery, 'findAgentPeerPageByAddress').mockResolvedValue(EMPTY);
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
    const pages = vi.spyOn(agent.discovery, 'findAgentPeerPageByAddress')
      .mockResolvedValueOnce({ peerIds: ['peer-001', 'peer-003'], nextAfterPeerId: 'peer-003' })
      .mockResolvedValueOnce({ peerIds: ['peer-004'], nextAfterPeerId: null });
    const first = await agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2 });
    expect(first).toMatchObject({
      overflowed: true, nextPageAfterPeerId: 'peer-003',
      rosterStatus: 'continue', peerIds: ['peer-001', 'peer-003'],
    });
    // Earlier peers may have been deleted and new peers inserted before the
    // cursor. This tail query says nothing about those unobserved entries.
    const tail = await agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2, afterPeerId: first.nextPageAfterPeerId });
    expect(tail).toMatchObject({
      peerIds: ['peer-004'], overflowed: true, rosterStatus: 'cycle',
    });
    expect(pages).toHaveBeenCalledTimes(2);
  });

  it('wraps an exhausted cursor through a fresh bounded first-page query', async () => {
    const agent = await createAgent();
    const pages = vi.spyOn(agent.discovery, 'findAgentPeerPageByAddress')
      .mockResolvedValueOnce(EMPTY)
      .mockResolvedValueOnce({ peerIds: ['peer-002'], nextAfterPeerId: null });
    const result = await agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2, pagePeerIds: 1, afterPeerId: 'peer-099' });
    expect(result).toEqual({
      peerIds: ['peer-002'], curatorIsLocal: false, legacyTripleResolved: false,
      rosterStatus: 'complete',
    });
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
    const page = vi.spyOn(agent.discovery, 'findAgentPeerPageByAddress');
    await expect(agent.resolveCuratorPeerIdsForCg('legacy-label', { maxPeerIds: 2 })).resolves.toEqual({
      peerIds: ['peer-legacy'], curatorIsLocal: false, legacyTripleResolved: true,
    });
    expect(page).not.toHaveBeenCalled();
  });

  it('propagates cancellation through a provider that settles after abort', async () => {
    const agent = await createAgent();
    let settle!: (page: AgentPeerPage) => void;
    vi.spyOn(agent.discovery, 'findAgentPeerPageByAddress').mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const refresh = vi.spyOn(agent, 'refreshMetaFromCurator');
    const controller = new AbortController();
    const pending = agent.resolveCuratorPeerIdsForCg(CG, { maxPeerIds: 2, signal: controller.signal });
    controller.abort();
    settle(EMPTY);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    null,
    undefined,
    'page',
    [],
    {},
    { peerIds: 'peer-001', nextAfterPeerId: null },
    { peerIds: [1], nextAfterPeerId: null },
    { peerIds: ['peer-001'], nextAfterPeerId: 1 },
    { peerIds: ['peer-001', 'peer-002', 'peer-003'], nextAfterPeerId: null },
    { peerIds: ['peer-002', 'peer-001'], nextAfterPeerId: null },
    { peerIds: ['peer-001', 'peer-001'], nextAfterPeerId: null },
    { peerIds: [''], nextAfterPeerId: null },
    { peerIds: ['peer-001'], nextAfterPeerId: 'peer-001' },
    { peerIds: ['peer-001', 'peer-002'], nextAfterPeerId: 'peer-999' },
    { peerIds: ['peer-001', 'peer-002'] },
  ])('rejects a provider page outside the bounded monotonic contract: %j', invalid => {
    expect(() => validateAgentPeerPage(invalid, { limit: 2 })).toThrow();
  });

  it('copies validated peer IDs without consuming a provider-supplied iterator', () => {
    const peerIds = ['peer-001', 'peer-002'];
    const iterator = vi.fn(() => { throw new Error('unbounded provider iterator'); });
    Object.defineProperty(peerIds, Symbol.iterator, { value: iterator });
    const decoded = validateAgentPeerPage({ peerIds, nextAfterPeerId: null }, { limit: 2 });
    peerIds[0] = 'changed-after-validation';
    expect(decoded).toEqual({ peerIds: ['peer-001', 'peer-002'], nextAfterPeerId: null });
    expect(iterator).not.toHaveBeenCalled();
  });

  it('returns the bounded wallet registry candidate without assigning authority or using a bootstrap hint', async () => {
    const agent = await createAgent();
    const record = await agent.getCgMeta(CG);
    vi.spyOn(agent, 'getCgMeta').mockResolvedValue({
      ...record, curator: `did:dkg:agent:${WALLET}`, curators: [`did:dkg:agent:${WALLET}`],
      creator: undefined, creators: [],
    });
    const pages = vi.spyOn(agent.discovery, 'findAgentPeerPageByAddress').mockResolvedValue({
      peerIds: ['peer-registry'], nextAfterPeerId: 'peer-registry',
    });
    const rich = vi.spyOn(agent.discovery, 'findAgents').mockRejectedValue(new Error('unbounded registry query'));
    const hints = new Map([[CG, 'peer-bootstrap']]);
    const controller = new AbortController();
    const result = await resolveBoundedCuratorSyncPeer(agent, hints, CG, {
      signal: controller.signal,
    });
    expect(result).toEqual({ peerId: 'peer-registry', provenance: 'registry' });
    expect(authoritativeSyncPeerId(result)).toBeUndefined();
    expect(hints.has(CG)).toBe(false);
    expect(pages).toHaveBeenCalledExactlyOnceWith(WALLET, { limit: 1, signal: controller.signal });
    expect(rich).not.toHaveBeenCalled();
  });

  it('preserves every transport candidate when the proof probe is larger than one attempt', async () => {
    const pages = vi.fn<AgentPeerDiscovery['findAgentPeerPageByAddress']>()
      .mockResolvedValueOnce({ peerIds: ['peer-001', 'peer-002'], nextAfterPeerId: 'peer-002' })
      .mockResolvedValueOnce({ peerIds: ['peer-002'], nextAfterPeerId: 'peer-002' })
      .mockResolvedValueOnce({ peerIds: ['peer-003'], nextAfterPeerId: null });
    const discovery = { findAgentPeerPageByAddress: pages };
    const first = await traverseBoundedCuratorRoster(discovery, WALLET, { maxPeerIds: 2, pagePeerIds: 1 });
    expect(first).toEqual({ status: 'continue', peerIds: ['peer-001'], nextAfterPeerId: 'peer-001' });
    const second = await traverseBoundedCuratorRoster(discovery, WALLET, { maxPeerIds: 2, pagePeerIds: 1, afterPeerId: 'peer-001' });
    expect(second).toEqual({ status: 'continue', peerIds: ['peer-002'], nextAfterPeerId: 'peer-002' });
    const tail = await traverseBoundedCuratorRoster(discovery, WALLET, { maxPeerIds: 2, pagePeerIds: 1, afterPeerId: 'peer-002' });
    expect(tail).toEqual({ status: 'cycle', peerIds: ['peer-003'] });
    expect(pages.mock.calls.map(([, request]) => [request.limit, request.afterPeerId])).toEqual([
      [2, undefined], [1, 'peer-001'], [1, 'peer-002'],
    ]);
  });

  it('does not restart an exhausted cursor after the recovery owner becomes stale', async () => {
    let current = true;
    const pages = vi.fn(async () => { current = false; return EMPTY; });
    await expect(traverseBoundedCuratorRoster({ findAgentPeerPageByAddress: pages }, WALLET, {
      maxPeerIds: 2, afterPeerId: 'peer-099', isCurrent: () => current,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(pages).toHaveBeenCalledTimes(1);
  });

  it('rejects a page that repeats the exclusive cursor', async () => {
    const provider: AgentPeerDiscovery = {
      findAgentPeerPageByAddress: async () => ({ peerIds: ['peer-001'], nextAfterPeerId: null }),
    };
    await expect(readAgentPeerPage(provider, WALLET, { limit: 2, afterPeerId: 'peer-001' })).rejects.toThrow('non-monotonic');
  });

  it('rejects an empty cursor instead of restarting a supposedly continued walk', async () => {
    const findAgentPeerPageByAddress = vi.fn(async () => EMPTY);
    await expect(readAgentPeerPage({ findAgentPeerPageByAddress }, WALLET, { limit: 2, afterPeerId: '' }))
      .rejects.toThrow('cursor');
    expect(findAgentPeerPageByAddress).not.toHaveBeenCalled();
  });
});
