import { afterEach, describe, expect, it, vi } from 'vitest';
import * as execution from '../src/exact-recovery-execution.js';
import { recoverPublicSnapshotParallelExact } from '../src/public-snapshot-parallel-exact.js';
import { createCoreChainCacheContentPeers } from '../src/core-chain-cache-peers.js';
import { exactAssetUalsForSelection } from '../src/sync/exact-assets.js';
import { createDurableSyncAccumulator, finalizeDurableSyncCompletion } from '../src/sync/durable-progress.js';

const host = { log: { info() {} } } as never;
const uals = Array.from({ length: 31 }, (_, i) => `did:dkg:evm:31337/0x${'ab'.repeat(20)}/${i + 1}`);
const options = () => ({ contextGraphId: 'parallel-snapshot', uals, evidence: {} as never,
  deadline: Date.now() + 3_600_000, signal: new AbortController().signal, assertCurrent() {},
  peerBatches: async function* () { yield ['core-a', 'core-b']; } });
const selected = (r: Parameters<typeof execution.runExactRecovery>[0]) => exactAssetUalsForSelection(r.policy.selection);
const success = (assets: readonly string[]) => ({ admission: 'work-started' as const,
  result: finalizeDurableSyncCompletion(createDurableSyncAccumulator()), disposition: 'found' as const,
  streamOutcome: 'complete' as const, committedExactAssetUals: [...assets] });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded snapshot recovery overlap', () => {
  it('uses at most two disjoint ten-asset streams and preserves every asset, held check and attempt bound', async () => {
    const gates = [deferred(), deferred()], entered = deferred();
    let active = 0, peak = 0;
    const calls: Array<{ peer: string; assets: string[]; timeout: number | undefined }> = [];
    vi.spyOn(execution, 'runExactRecovery').mockImplementation(async request => {
      const index = calls.length; active++; peak = Math.max(peak, active);
      calls.push({ peer: request.remotePeerId, assets: [...selected(request)], timeout: request.options.totalTimeoutMs });
      if (calls.length === 2) entered.resolve();
      if (index < 2) await gates[index]!.promise;
      active--; return success(selected(request));
    });
    const holds = vi.fn(async () => false);
    const job = recoverPublicSnapshotParallelExact(host, { ...options(), holds });
    await entered.promise;
    expect(calls.map(c => c.peer)).toEqual(['core-a', 'core-b']);
    expect(active).toBe(2); gates.forEach(g => g.resolve());
    const result = await job;
    expect(peak).toBe(2);
    expect(result).toEqual({ committed: new Set(uals), alreadyPresent: 0 });
    expect(calls.flatMap(c => c.assets).sort()).toEqual([...uals].sort());
    expect(calls.every(c => c.assets.length <= 10 && c.timeout! <= 120_000)).toBe(true);
    expect(holds).toHaveBeenCalledTimes(uals.length);
  });

  it('cancels the other lane and waits for its physical work before reporting a failure', async () => {
    const both = deferred(), physical = deferred(); let count = 0, settled = false;
    vi.spyOn(execution, 'runExactRecovery').mockImplementation(async request => {
      const lane = count++;
      if (count === 2) both.resolve();
      await both.promise;
      if (lane === 0) throw new Error('first lane failed');
      await physical.promise;
      expect(request.options.signal?.aborted).toBe(true);
      return success(selected(request));
    });
    const job = recoverPublicSnapshotParallelExact(host, options());
    job.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(job).rejects.toThrow('first lane failed');
    await both.promise; await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    physical.resolve(); await rejection;
    expect(count).toBe(2);
  });

  it('reports whole-job progress including held assets when one lane exhausts its suppliers', async () => {
    const otherLaneComplete = deferred();
    const assets = uals.slice(0, 21);
    vi.spyOn(execution, 'runExactRecovery').mockImplementation(async request => {
      const selection = selected(request);
      if (selection.some(ual => assets.slice(10, 20).includes(ual))) {
        await otherLaneComplete.promise;
        return { ...success([]), disposition: 'clean-absent', streamOutcome: undefined };
      }
      if (selection.includes(assets[20]!)) otherLaneComplete.resolve();
      return success(selection);
    });
    const holds = vi.fn(async (ual: string) => ual === assets[10]);
    await expect(recoverPublicSnapshotParallelExact(host, { ...options(), uals: assets, holds }))
      .rejects.toThrow('Snapshot recovery incomplete: 12/21 committed');
    expect(holds).toHaveBeenCalledTimes(assets.length);
  });

  it('does not start work after cancellation or the original deadline', async () => {
    const run = vi.spyOn(execution, 'runExactRecovery');
    const caller = new AbortController(); caller.abort(new Error('cancelled'));
    await expect(recoverPublicSnapshotParallelExact(host, { ...options(), signal: caller.signal })).rejects.toThrow('cancelled');
    await expect(recoverPublicSnapshotParallelExact(host, { ...options(), deadline: Date.now() })).rejects.toThrow('job time limit');
    expect(run).not.toHaveBeenCalled();
  });

  it('shares one discovery advance between concurrent readers without skipping or repeating hints', async () => {
    const candidates = Array.from({ length: 9 }, (_, i) => `core-${i}`);
    const connect = vi.fn(async () => {}), admit = vi.fn(async () => true);
    const peers = createCoreChainCacheContentPeers({ candidates, self: 'edge', connect, admit }, new AbortController().signal);
    const collect = async () => { const result: string[] = []; for await (const batch of peers.batches()) result.push(...batch); return result; };
    expect(await Promise.all([collect(), collect()])).toEqual([candidates, candidates]);
    expect(connect).toHaveBeenCalledTimes(candidates.length);
    expect(admit).toHaveBeenCalledTimes(candidates.length);
    expect(peers.selected).toEqual(candidates);
  });

  it('shares a busy supplier hold across lanes, including queued attempts', async () => {
    vi.useFakeTimers();
    const askedAt: number[] = [];
    vi.spyOn(execution, 'runExactRecovery').mockImplementation(async request => {
      if (request.remotePeerId === 'core-b') return { ...success([]), disposition: 'clean-absent', streamOutcome: undefined };
      askedAt.push(Date.now());
      if (askedAt.length === 1) return { ...success([]), disposition: 'incomplete', streamOutcome: 'responder-busy' };
      return success(selected(request));
    });
    const job = recoverPublicSnapshotParallelExact(host, options());
    await vi.runAllTimersAsync();
    expect((await job).committed).toEqual(new Set(uals));
    expect(askedAt.length).toBeGreaterThan(1);
    expect(askedAt[1]! - askedAt[0]!).toBeGreaterThanOrEqual(15_000);
  });
});
