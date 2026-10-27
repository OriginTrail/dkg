import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicSnapshotExactJob } from '../src/public-snapshot-exact-job.js';
import * as execution from '../src/exact-recovery-execution.js';
import { recoverPublicSnapshotExact } from '../src/public-snapshot-exact.js';
import { createCoreChainCacheContentPeers } from '../src/core-chain-cache-peers.js';
import { exactAssetUalsForSelection } from '../src/sync/exact-assets.js';
import { createDurableSyncAccumulator, finalizeDurableSyncCompletion } from '../src/sync/durable-progress.js';

const host = { log: { info() {} } } as never;
const uals = Array.from({ length: 31 }, (_, i) => `did:dkg:evm:31337/0x${'ab'.repeat(20)}/${i + 1}`);
const options = () => ({ maxLanes: 2 as const, contextGraphId: 'parallel-snapshot', uals, evidence: {} as never,
  deadline: Date.now() + 3_600_000, signal: new AbortController().signal, assertCurrent() {},
  peerBatches: async function* () { yield ['core-a', 'core-b']; } });
const selected = (r: Parameters<typeof execution.runExactRecovery>[0]) => exactAssetUalsForSelection(r.policy.selection);
const success = (assets: readonly string[]) => ({ admission: 'work-started' as const,
  result: finalizeDurableSyncCompletion(createDurableSyncAccumulator()), disposition: 'found' as const,
  streamOutcome: 'complete' as const, committedExactAssetUals: [...assets] });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded snapshot recovery overlap', () => {
  it('checks held assets before any supplier discovery', async () => {
    const discover = vi.fn(() => { throw new Error('held assets must not discover suppliers'); });
    const transfer = vi.spyOn(execution, 'runExactRecovery');
    const result = await recoverPublicSnapshotExact(host, { ...options(), holds: async () => true, peerBatches: discover });
    expect(result).toEqual({ committed: new Set(uals), alreadyPresent: uals.length });
    expect(discover).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
  });

  it('serializes all transfers when both workers have one supplier', async () => {
    let active = 0, peak = 0;
    const calls: string[][] = [];
    vi.spyOn(execution, 'runExactRecovery').mockImplementation(async request => {
      active++; peak = Math.max(peak, active); calls.push([...selected(request)]);
      await new Promise<void>(resolve => setImmediate(resolve));
      active--; return success(selected(request));
    });
    const result = await recoverPublicSnapshotExact(host, { ...options(), peerBatches: async function* () { yield ['core-a']; } });
    expect(result.committed).toEqual(new Set(uals)); expect(peak).toBe(1);
    expect(calls.flat().sort()).toEqual([...uals].sort()); expect(calls.every(batch => batch.length <= 10)).toBe(true);
  });

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
    const job = recoverPublicSnapshotExact(host, { ...options(), holds });
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
    let siblingAborted: boolean | undefined;
    vi.spyOn(execution, 'runExactRecovery').mockImplementation(async request => {
      const lane = count++;
      if (count === 2) both.resolve();
      await both.promise;
      if (lane === 0) throw new Error('first lane failed');
      await physical.promise;
      siblingAborted = request.options.signal?.aborted;
      return success(selected(request));
    });
    const job = recoverPublicSnapshotExact(host, options());
    job.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(job).rejects.toThrow('first lane failed');
    await both.promise;
    // Let the failed lane propagate through its peer lock and abort the job.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    physical.resolve(); await rejection;
    expect(siblingAborted).toBe(true);
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
    await expect(recoverPublicSnapshotExact(host, { ...options(), uals: assets, holds }))
      .rejects.toThrow('Snapshot recovery incomplete: 12/21 committed');
    expect(holds).toHaveBeenCalledTimes(assets.length);
  });

  it('does not start work after cancellation or the original deadline', async () => {
    const run = vi.spyOn(execution, 'runExactRecovery');
    const caller = new AbortController(); caller.abort(new Error('cancelled'));
    await expect(recoverPublicSnapshotExact(host, { ...options(), signal: caller.signal })).rejects.toThrow('cancelled');
    await expect(recoverPublicSnapshotExact(host, { ...options(), deadline: Date.now() })).rejects.toThrow('job time limit');
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

  it.each(['complete', 'responder-busy'] as const)('serializes fallback contention after the first exchange returns %s', async firstOutcome => {
    vi.useFakeTimers();
    const entered = deferred(), release = deferred(), caller = new AbortController();
    const queue = vi.spyOn(PublicSnapshotExactJob.prototype, 'serializePeer');
    const active = new Map<string, number>(), askedAt: number[] = [];
    let peak = 0;
    vi.spyOn(execution, 'runExactRecovery').mockImplementation(async request => {
      const peer = request.remotePeerId;
      active.set(peer, (active.get(peer) ?? 0) + 1); peak = Math.max(peak, active.get(peer)!);
      try {
        if (peer === 'core-b') return { ...success([]), disposition: 'clean-absent', streamOutcome: undefined };
        askedAt.push(Date.now());
        if (askedAt.length === 1) {
          entered.resolve(); await release.promise;
          if (firstOutcome === 'responder-busy') return { ...success([]), disposition: 'incomplete', streamOutcome: firstOutcome };
        }
        return success(selected(request));
      } finally { active.set(peer, active.get(peer)! - 1); }
    });
    const assets = uals.slice(0, 20);
    const job = recoverPublicSnapshotExact(host, { ...options(), uals: assets, signal: caller.signal });
    void job.catch(() => undefined);
    try {
      await entered.promise; await vi.advanceTimersByTimeAsync(0);
      // B has answered absent, so its lane is queued on A while A is physically open.
      expect(queue.mock.calls.filter(([peer]) => peer === 'core-a')).toHaveLength(2);
      expect(askedAt).toHaveLength(1);
      expect(active.get('core-a')).toBe(1);
      release.resolve(); await vi.advanceTimersByTimeAsync(0);
      if (firstOutcome === 'responder-busy') {
        // The queued call must recheck the hold established after it joined the queue.
        expect(askedAt).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(14_999);
        expect(askedAt).toHaveLength(1);
      }
      await vi.runAllTimersAsync();
      expect((await job).committed).toEqual(new Set(assets));
      expect(peak).toBe(1);
      expect(askedAt.length).toBeGreaterThanOrEqual(2);
      if (firstOutcome === 'responder-busy') expect(askedAt[1]! - askedAt[0]!).toBeGreaterThanOrEqual(15_000);
    } finally { release.resolve(); caller.abort(); await job.catch(() => undefined); }
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
    const job = recoverPublicSnapshotExact(host, options());
    await vi.runAllTimersAsync();
    expect((await job).committed).toEqual(new Set(uals));
    expect(askedAt.length).toBeGreaterThan(1);
    expect(askedAt[1]! - askedAt[0]!).toBeGreaterThanOrEqual(15_000);
  });

  it('shares one admission timer and capacity poll between simultaneous lane refusals', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const both = deferred(), attempts: number[] = [];
    const canAdmit = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    vi.spyOn(execution, 'runExactRecovery').mockImplementation(async request => {
      const attempt = attempts.length;
      attempts.push(Date.now());
      if (attempt < 2) {
        if (attempt === 1) both.resolve();
        await both.promise;
        return { ...success([]), admission: 'local-admission-deferred', disposition: 'incomplete' };
      }
      return success(selected(request));
    });
    const assets = uals.slice(0, 20);
    const caller = new AbortController();
    const job = recoverPublicSnapshotExact(host, { ...options(), uals: assets, canAdmit, signal: caller.signal });
    void job.catch(() => undefined);
    try {
      await both.promise; await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(1);
      // Two real refusals retain the existing exponential five-second hold.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(canAdmit).toHaveBeenCalledTimes(1);
      expect(attempts).toHaveLength(2);
      await vi.runAllTimersAsync();
      expect((await job).committed).toEqual(new Set(assets));
      expect(canAdmit).toHaveBeenCalledTimes(2);
      expect(attempts).toHaveLength(4);
      expect(attempts[2]! - attempts[0]!).toBeGreaterThanOrEqual(7_500);
    } finally { caller.abort(); await vi.runAllTimersAsync(); await job.catch(() => undefined); }
  });
});
