import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';

const graph = 'snapshot-discovery-race';
const agents: DKGAgent[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (agents.length) await agents.pop()!.stop();
});

async function fixture() {
  const chain = new MockChainAdapter();
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: ethers.id(graph) });
  // Historical enumeration, rather than the live event tail, owns this record.
  for (let i = 0; i < 600; i++) chain.advanceBlock();
  Object.assign(chain, { getBlockNumber: async () => 600 });
  const snapshot = () => sealPublicGraphSnapshot({
    version: 1, chainId: chain.chainId, deploymentId: chain.deploymentId,
    contextGraphId: graph, onChainId: '1', nameHash: ethers.id(graph),
    contextGraphStorage: `0x${'1'.repeat(40)}`, assetStorage: `0x${'2'.repeat(40)}`,
    blockNumber: '600', blockHash: `0x${'a'.repeat(64)}`, finalityConfirmations: 1,
    observedAt: Date.now(), expiresAt: Date.now() + 120000, accessPolicy: 0,
    assets: [{ id: '1', root: `0x${'b'.repeat(64)}`, version: '1' }],
  });
  Object.assign(chain, { readPublicGraphSnapshot: async () => snapshot() });
  const agent = await DKGAgent.create({ name: 'SnapshotDiscovery', nodeRole: 'edge',
    listenHost: '127.0.0.1', listenPort: 0, chainAdapter: chain,
    syncReconcilerEnabled: false, vmReconcilerEnabled: false,
    randomSamplingUseWorkerThread: false });
  agents.push(agent);
  await agent.start();
  await agent.awaitInitialChainPoll();
  return { agent, snapshot };
}

describe('snapshot admission racing historical graph discovery', () => {
  it.each([
    ['core-cache', false], ['core-cache', true], ['rpc-only', false], ['rpc-only', true],
  ] as const)('survives same-binding discovery (%s, existing subscription: %s)', async (mode, existing) => {
    const { agent, snapshot } = await fixture();
    if (mode === 'core-cache') vi.spyOn(agent.router, 'send').mockImplementation(async () => Buffer.from(JSON.stringify(snapshot())));
    if (existing) agent.subscribeToContextGraph(graph, { onChainId: '1', syncMode: 'on-demand' });
    const fetch = vi.spyOn(agent, 'syncExactKnowledgeAssetsFromPeerDetailed').mockImplementation(async (_peer, _graph, uals, options) => {
      await agent.discoverContextGraphsFromStorage();
      return { applied: 0, committedExactAssetUals: options?.isCurrent?.() ? uals : [] } as Awaited<ReturnType<typeof agent.syncExactKnowledgeAssetsFromPeerDetailed>>;
    });
    await expect(agent.syncPublicGraphSnapshot({ contextGraphId: graph, onChainId: '1',
      trustedCorePeerIds: ['core'], mode })).resolves.toMatchObject({ committed: 1, current: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(agent.getSubscribedContextGraphs().get(graph)?.onChainHash).toBe(ethers.id(graph));
  });

  it.each(['unsubscribe', 'resubscribe', 'rebind'] as const)('still cancels on %s during a batch', async change => {
    const { agent } = await fixture();
    vi.spyOn(agent, 'syncExactKnowledgeAssetsFromPeerDetailed').mockImplementation(async () => {
      if (change === 'rebind') agent.subscribeToContextGraph(graph, { onChainId: '2', syncMode: 'on-demand' });
      else {
        agent.unsubscribeFromContextGraph(graph);
        if (change === 'resubscribe') agent.subscribeToContextGraph(graph, { onChainId: '1', syncMode: 'on-demand' });
      }
      return { applied: 0, committedExactAssetUals: [] } as Awaited<ReturnType<typeof agent.syncExactKnowledgeAssetsFromPeerDetailed>>;
    });
    await expect(agent.syncPublicGraphSnapshot({ contextGraphId: graph, onChainId: '1',
      trustedCorePeerIds: ['core'], mode: 'rpc-only' })).rejects.toThrow('Snapshot job ownership changed');
  });
});
