import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { Logger } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { createChainDiscoveryScanRunner } from '../src/daemon/chain-discovery-scan.js';

/** More blocks than the live `contextGraphDiscovery` lane looks back on a cold start. */
const BEYOND_LIVE_LOOKBACK_BLOCKS = 600;

const HASHES = ['mainnet-public', 'mainnet-private', 'mainnet-curated']
  .map((name) => ethers.keccak256(ethers.toUtf8Bytes(name)).toLowerCase());

/**
 * Shaped like Base or Gnosis mainnet on 2026-09-23: Context Graphs created long
 * before this node booted, and no ContextGraphNameRegistry in the Hub (the
 * mock's registry scans return nothing, like the archived contract's).
 */
async function mainnetShapedChain(): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter();
  // Give the mock a head, as a real RPC has, so the live lane seeds near it.
  (chain as unknown as { getBlockNumber: () => Promise<number> }).getBlockNumber =
    async () => (chain as unknown as { nextBlock: number }).nextBlock - 1;
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: HASHES[0] });
  await chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 0, nameHash: HASHES[1] });
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 0, nameHash: HASHES[2] });
  for (let i = 0; i < BEYOND_LIVE_LOOKBACK_BLOCKS; i++) chain.advanceBlock();
  return chain;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  Logger.setSink(null);
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

describe('daemon Context Graph discovery on a fresh node', () => {
  it('lists the Context Graphs that already existed on chain after its first discovery pass', async () => {
    const agentLogs: Array<{ level: string; message: string }> = [];
    Logger.setSink((record) => agentLogs.push(record));
    const chain = await mainnetShapedChain();
    const agent = await DKGAgent.create({
      name: 'FreshMainnetNode',
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      chainAdapter: chain,
      rfc64CatalogActivation: { enabled: false },
    });
    cleanups.push(() => agent.stop());
    await agent.start();
    await agent.awaitInitialChainPoll();

    const listed = async () => (await agent.listContextGraphs({ callerAgentAddress: null }))
      .map((row) => row.id)
      .filter((id) => HASHES.includes(id))
      .sort();
    // The live tail alone never reaches graphs this old.
    expect(await listed()).toEqual([]);

    const daemonLog: string[] = [];
    const runner = createChainDiscoveryScanRunner({
      agent,
      log: (line) => daemonLog.push(line),
      pageBudget: 30,
    });
    cleanups.push(() => runner.close());
    await runner.run();

    expect(await listed()).toEqual([...HASHES].sort());
    expect(daemonLog).toContain('Chain storage scan: discovered 3 new context graph(s)');
    // The archived registry is reported once, not scanned in silence every tick.
    await runner.run();
    const notices = agentLogs.filter((record) =>
      /ContextGraphNameRegistry is not registered in the Hub/.test(record.message));
    expect(notices).toHaveLength(1);
  }, 60_000);
});
