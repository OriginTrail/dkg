import { describe, expect, it } from 'vitest';
import { PublicGraphSnapshotCache, sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { PublicSnapshotAdmission } from '../src/public-snapshot-admission.js';

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
    const admission = new PublicSnapshotAdmission(() => now);
    const cache = new PublicGraphSnapshotCache(async id => { builds++; return snapshot(id, now); }, () => now);
    const get = (refresh: boolean) => cache.get('g', '1', refresh, () => admission.acquire('peer-a'));
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
    const admission = new PublicSnapshotAdmission();
    let reject!: (error: Error) => void;
    const cache = new PublicGraphSnapshotCache(async id => id === 'held'
      ? new Promise((_resolve, fail) => { reject = fail; }) : snapshot(id, Date.now()));
    const first = cache.get('held', '1', true, () => admission.acquire('peer-a'));
    const failed = expect(first).rejects.toThrow('RPC failed');
    await expect(cache.get('other', '1', true, () => admission.acquire('peer-a'))).rejects.toThrow('peer busy');
    await expect(cache.get('other', '1', true, () => admission.acquire('peer-b'))).resolves.toMatchObject({contextGraphId:'other'});
    reject(new Error('RPC failed')); await failed;
    await expect(cache.get('next', '1', true, () => admission.acquire('peer-a'))).resolves.toMatchObject({contextGraphId:'next'});
  });
});
