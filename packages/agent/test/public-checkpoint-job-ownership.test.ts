import { CheckpointInventory, attachCheckpointInventory } from '../src/snapshot-checkpoint-inventory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockChainAdapter, sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/dkg-agent.js';
import { PublicCheckpointMethods } from '../src/dkg-agent-public-checkpoint.js';

const active: Array<{ agent: DKGAgent; directory: string }> = [];
afterEach(async () => {
  for (const { agent, directory } of active.splice(0)) {
    await agent.stop(); await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-owner-'));
  const chain = new MockChainAdapter();
  Object.defineProperties(chain, { chainId: { value: 'evm:31337' }, deploymentId: { value: 'test' } });
  const graph = 'checkpoint-owner';
  const now = Date.now();
  const snapshot = sealPublicGraphSnapshot({ version: 1, chainId: chain.chainId, deploymentId: 'test',
    contextGraphId: graph, onChainId: '1', nameHash: ethers.id(graph), contextGraphStorage: `0x${'1'.repeat(40)}`,
    assetStorage: `0x${'2'.repeat(40)}`, blockNumber: '10', blockHash: `0x${'a'.repeat(64)}`,
    observedAt: now, expiresAt: now + 120000, finalityConfirmations: 1, accessPolicy: 0, assets: [] });
  const read = vi.fn(async () => snapshot);
  Object.assign(chain, { readPublicGraphSnapshot: read });
  const agent = await DKGAgent.create({ name: 'checkpoint-owner', dataDir: directory, nodeRole: 'edge',
    listenHost: '127.0.0.1', listenPort: 0, enableMdns: false, chainAdapter: chain, randomSamplingUseWorkerThread: false,
    syncOnConnectEnabled: false, syncReconcilerEnabled: false, vmReconcilerEnabled: false });
  active.push({ agent, directory }); await agent.start();
  agent.setContextGraphSubscription(graph, { subscribed: true, synced: false, syncMode: 'on-demand', onChainId: '1' }, { persist: false });
  const options = { contextGraphId: graph, onChainId: '1', mode: 'rpc-only' as const, trustedCorePeerIds: ['fixture'] };
  return { agent, directory, graph, options, read, snapshot };
}

it('retires checkpoint preparation after a same-tick unsubscribe without staging or re-admitting the graph', async () => {
  const { agent, directory, graph, options } = await fixture();
  const pending = agent.preparePublicGraphCheckpoint(options);
  const rejected = expect(pending).rejects.toThrow('Checkpoint ownership changed');
  agent.unsubscribeFromContextGraph(graph, { persist: false });
  await rejected;
  expect(agent.getSubscribedContextGraphs().get(graph)?.subscribed ?? false).toBe(false);
  expect(await readdir(directory)).not.toContain('public-snapshot-checkpoints');
});

it('shares foreground exclusion with ordinary snapshot recovery until preparation settles', async () => {
  const { agent, directory, options, read, snapshot } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  read.mockImplementation(async () => { await gate; return snapshot; });
  const pending = agent.preparePublicGraphCheckpoint(options);
  const failed = expect(pending).rejects.toThrow('outside bootstrap limits');
  try {
    await expect.poll(() => read.mock.calls.length).toBe(1);
    await expect(agent.preparePublicGraphCheckpoint(options)).rejects.toThrow('already running');
    await expect(agent.syncPublicGraphSnapshot(options)).rejects.toThrow('already running');
  } finally { release(); await failed; }
  // The empty fixture is eligible for ordinary recovery after physical cleanup.
  await expect(agent.syncPublicGraphSnapshot(options)).resolves.toMatchObject({ current: true, assets: 0 });
  expect((await readdir(join(directory, 'public-snapshot-checkpoints'))).length).toBe(1);
});

it('drains startup discovery before observing activation, and preserves caller cancellation', async () => {
  let release!: () => void;
  const poll = new Promise<void>(resolve => { release = resolve; });
  const activation = vi.fn();
  const host = { chainPoller: { waitForCurrentPoll: () => poll }, waitForContextGraphSubscriptionActivation: activation };
  const caller = new AbortController();
  const pending = PublicCheckpointMethods.prototype.waitForPublicCheckpointStartup.call(host as never, 'graph', caller.signal);
  const rejection = expect(pending).rejects.toThrow('operator cancelled');
  await Promise.resolve();
  expect(activation).not.toHaveBeenCalled();
  let settled = false;
  void pending.catch(() => { settled = true; });
  caller.abort(new Error('operator cancelled'));
  try { await expect.poll(() => settled, { timeout: 250 }).toBe(true); }
  finally { release(); await rejection; }
  expect(activation).not.toHaveBeenCalled();
  const assertCurrent = vi.fn(); activation.mockResolvedValue({ assertCurrent });
  await PublicCheckpointMethods.prototype.waitForPublicCheckpointStartup.call(host as never, 'graph', new AbortController().signal);
  expect(assertCurrent).toHaveBeenCalledOnce();
});

it.each(['removal', 'anchor'])('rejects checkpoint %s on the FIRST fresh authority read before admission or recovery', async change => {
  const { agent, directory, options, read, snapshot } = await fixture();
  const assets = [1, 2].map(id => ({ id: String(id), root: `0x${'1'.repeat(64)}`, version: '1' }));
  const prior = sealPublicGraphSnapshot({ ...snapshot, assets });
  attachCheckpointInventory(agent, await CheckpointInventory.create(directory,
    { mode: 'rpc-only', sourceCore: null, snapshot: prior }));
  read.mockResolvedValue(sealPublicGraphSnapshot({ ...snapshot,
    assets: change === 'removal' ? assets.slice(0, 1) : assets,
    blockNumber: change === 'anchor' ? '9' : '11' }));
  const write = vi.spyOn(agent.store, 'insert');
  await expect(agent.syncPublicGraphSnapshot(options)).rejects.toThrow(change === 'removal' ? 'removed' : 'anchor');
  expect(read).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
});
