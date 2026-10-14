import { describe, expect, it } from 'vitest';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { PublicSnapshotServingRuntime } from '../src/public-snapshot-serving-runtime.js';
const lifetime = () => ({ signal: new AbortController().signal, physicalRuns: new Set<Promise<unknown>>() });

function snapshot(id: string, now: number) {
  return sealPublicGraphSnapshot({ version: 1, chainId: 'evm:31337', deploymentId: 'test',
    contextGraphId: id, onChainId: '1', nameHash: `0x${'1'.repeat(64)}`,
    contextGraphStorage: `0x${'1'.repeat(40)}`, assetStorage: `0x${'2'.repeat(40)}`,
    blockNumber: '10', blockHash: `0x${'a'.repeat(64)}`, finalityConfirmations: 1,
    observedAt: now, expiresAt: now + 120000, accessPolicy: 0, assets: [] });
}

describe('public snapshot physical build budgets', () => {
  it('allows a cold and fresh observation, then refuses repeated forced RPC work until the window ends', async () => {
    let now = 1000, builds = 0;
    const cache = new PublicSnapshotServingRuntime(async id => { builds++; return snapshot(id, now); }, lifetime(), () => now);
    const get = (refresh: boolean) => cache.get('peer-a', 'g', '1', refresh);
    const cold = await get(false);
    expect(await get(false)).toBe(cold);
    const fresh = await get(true);
    expect(fresh).not.toBe(cold);
    for (let i = 0; i < 20; i++) await expect(get(true)).rejects.toThrow('peer busy');
    expect(builds).toBe(2);
    now += 60_000;
    await get(true);
    expect(builds).toBe(3);
  });

  it('reserves capacity for a different peer until physical work settles, including failure', async () => {
    let reject!: (error: Error) => void;
    const cache = new PublicSnapshotServingRuntime(async id => id === 'held'
      ? new Promise((_resolve, fail) => { reject = fail; }) : snapshot(id, Date.now()), lifetime());
    const first = cache.get('peer-a', 'held', '1', true);
    const failed = expect(first).rejects.toThrow('RPC failed');
    await expect(cache.get('peer-a', 'other', '1', true)).rejects.toThrow('peer busy');
    await expect(cache.get('peer-b', 'other', '1', true)).resolves.toMatchObject({contextGraphId:'other'});
    reject(new Error('RPC failed')); await failed;
    await expect(cache.get('peer-a', 'next', '1', true)).resolves.toMatchObject({contextGraphId:'next'});
  });
});
