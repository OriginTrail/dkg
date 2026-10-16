import { Wallet } from 'ethers';
import { afterEach, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../../chain/src/evm-adapter.js';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { PublicSnapshotServingRuntime } from '../src/public-snapshot-serving-runtime.js';

afterEach(() => vi.useRealTimers());

it('retains real adapter builder slots and shutdown drain after the deadline until provider reads settle', async () => {
  vi.useFakeTimers();
  const adapter = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:59998', chainId: 'evm:31337', privateKey: Wallet.createRandom().privateKey,
    hubAddress: `0x${'1'.repeat(40)}`, finalityConfirmations: 1,
  });
  const releases: Array<() => void> = [];
  const provider = {
    send: vi.fn(async () => '0x7a69'),
    getBlock: vi.fn(() => new Promise(resolve => releases.push(() => resolve({
      number: 10, hash: `0x${'a'.repeat(64)}`,
    })))),
    call: vi.fn(),
  };
  Object.assign(adapter, { init: vi.fn(async () => {}), providers: [provider] });
  const lifetime = new AgentWorkLifetime();
  const runtime = new PublicSnapshotServingRuntime((id, chainId, signal) =>
    adapter.readPublicGraphSnapshot(id, chainId, { signal }), lifetime);
  const first = runtime.get('peer-a', 'graph-a', '1');
  const second = runtime.get('peer-b', 'graph-b', '2');
  const settled = Promise.allSettled([first, second]);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.getBlock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(lifetime.physicalRuns.size).toBe(2);
    await expect(runtime.get('peer-c', 'graph-c', '3')).rejects.toThrow('Snapshot builder busy');
    lifetime.close(new Error('shutdown'));
    let drained = false;
    const drain = lifetime.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    for (const release of releases) release();
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    await drain;
    expect(drained).toBe(true);
    expect(lifetime.physicalRuns.size).toBe(0);
    expect(provider.call).not.toHaveBeenCalled();
    expect(provider.send).toHaveBeenCalledTimes(2);
  } finally {
    lifetime.close();
    for (const release of releases) release();
    await settled;
    await lifetime.drain();
  }
});
