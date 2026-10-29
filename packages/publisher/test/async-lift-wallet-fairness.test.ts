import { describe, expect, it, vi } from 'vitest';
import { AsyncLiftRunner, TripleStoreAsyncLiftPublisher, type AsyncLiftPublisher, type LiftJob } from '../src/index.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../../../scripts/testing/ka-vm-publish.js';
import { createRunnerPublisher } from './_helpers/async-lift-runner-fixture.js';
import { AsyncLiftWalletPool } from '../src/async-lift-wallet-pool.js';

const wallets = Array.from({ length: 6 }, (_, i) => `wallet-${i}`);

function scheduling(
  process: (wallet: string, claimed: () => void) => Promise<LiftJob | null>,
  prepare: (wallet: string) => Promise<boolean> = async () => true,
): NonNullable<AsyncLiftPublisher['claimScheduling']> {
  return { prepare: async (wallet) => await prepare(wallet) ? { process: (claimed) => process(wallet, claimed) } : null };
}

function fixture(scheduled = false) {
  let queued = 0;
  const counts = wallets.map(() => 0);
  let hooks: { onWorkAvailable?(): void } | undefined;
  const publisher = createRunnerPublisher({
    processNext: async (walletId) => {
      if (!queued) return null;
      queued -= 1;
      counts[wallets.indexOf(walletId)]! += 1;
      return { jobId: `job-${counts.reduce((a, b) => a + b, 0)}` } as LiftJob;
    },
    reconciliationScheduling: {
      attachScheduler: (scheduler) => { hooks = scheduler; return () => { hooks = undefined; }; },
      recover: async () => ({ reconciled: 0, pendingWork: false }),
      reconcile: async () => ({ reconciled: 0, pendingWork: false }),
    },
  });
  if (scheduled) publisher.claimScheduling = scheduling(async (walletId, onClaimed) => {
    if (queued) onClaimed();
    return publisher.processNext(walletId);
  }, async (walletId) => {
    // Different preparation/RPC times must not make the fastest wallet win every sparse job.
    await new Promise((resolve) => setTimeout(resolve, wallets.indexOf(walletId) + 1));
    return true;
  });
  const runner = new AsyncLiftRunner({ publisher, walletIds: wallets, pollIntervalMs: 60_000 });
  return { runner, counts, enqueue: (count: number) => { queued += count; hooks?.onWorkAvailable?.(); } };
}

describe('async publisher wallet fairness (#3591)', () => {
  it('the production coordinator acknowledges real claims before blocked executions complete', async () => {
    vi.useFakeTimers();
    const store = new OxigraphStore();
    await stageKnowledgeAssetShareSnapshot({ store });
    let release!: () => void;
    const executing = new Promise<void>((resolve) => { release = resolve; });
    const entered: string[] = [];
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      knowledgeAssetVmPublishHandler: { execute: async ({ walletId }) => {
        entered.push(walletId); await executing;
        throw new Error('End the execution-only fixture before signing');
      } },
    });
    for (let i = 0; i < 6; i += 1) await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      name: `work-${i}`, intentKey: `sha256:${String(i).padStart(64, '0')}`,
    }));
    const runner = new AsyncLiftRunner({ publisher, walletIds: wallets });
    try {
      await runner.start(); await vi.advanceTimersByTimeAsync(0);
      expect(entered).toHaveLength(6);
      expect(new Set(entered)).toEqual(new Set(wallets));
    } finally {
      const stopping = runner.stop(); release(); await stopping;
      vi.useRealTimers(); await store.close();
    }
  });
  it('visits every free wallet during staggered empty polls, so replenishment needs no new admission', () => {
    const pool = new AsyncLiftWalletPool(wallets);
    const visited = [];
    for (let i = 0; i < wallets.length; i += 1) {
      const walletId = pool.acquire()!;
      visited.push(walletId);
      pool.release(walletId, false);
    }
    expect(visited).toEqual(wallets);
  });

  it('discovers a replenished later wallet by polling without a new work notification', async () => {
    vi.useFakeTimers();
    let funded = false;
    let queued = true;
    const used: string[] = [];
    const publisher = createRunnerPublisher({
      claimScheduling: scheduling(async (walletId, claimed) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (!funded || !queued || walletId !== wallets[2]) return null;
        queued = false; used.push(walletId); claimed();
        return { jobId: 'retained-waiting-job' } as LiftJob;
      }),
    });
    const runner = new AsyncLiftRunner({ publisher, walletIds: wallets });
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(used).toEqual([]);
      funded = true;
      await vi.advanceTimersByTimeAsync(2500);
      expect(used).toEqual([wallets[2]]);
      const stopping = runner.stop();
      await vi.advanceTimersByTimeAsync(100);
      await stopping;
    } finally { vi.useRealTimers(); }
  });

  it('overlaps six funding preparations but admits durable claims in selected order', async () => {
    vi.useFakeTimers();
    let prepareDone!: () => void, executeDone!: () => void;
    const preparing = new Promise<void>((resolve) => { prepareDone = resolve; });
    const executing = new Promise<void>((resolve) => { executeDone = resolve; });
    const started: string[] = [];
    const prepareWalletClaim = vi.fn(async () => { await preparing; return true; });
    const publisher = createRunnerPublisher({
      claimScheduling: scheduling(async (walletId, claimed) => {
        started.push(walletId); claimed(); await executing;
        return { jobId: `job-${walletId}` } as LiftJob;
      }, prepareWalletClaim),
    });
    const runner = new AsyncLiftRunner({ publisher, walletIds: wallets });
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(prepareWalletClaim).toHaveBeenCalledTimes(6);
      expect(started).toEqual([]);
      prepareDone(); await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(wallets);
    } finally {
      const stopping = runner.stop(); executeDone(); prepareDone();
      await stopping; vi.useRealTimers();
    }
  });

  it('settles started funding reads on stop without admitting a claim', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const preparing = new Promise<void>((resolve) => { release = resolve; });
    const scheduled = vi.fn(async () => null);
    const publisher = createRunnerPublisher({
      claimScheduling: scheduling(scheduled, async () => { await preparing; return true; }),
    });
    const runner = new AsyncLiftRunner({ publisher, walletIds: wallets });
    try {
      await runner.start(); await vi.advanceTimersByTimeAsync(0);
      let stopped = false;
      const stopping = runner.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      release(); await stopping;
      expect(scheduled).not.toHaveBeenCalled();
    } finally { release(); await runner.stop(); vi.useRealTimers(); }
  });
  it('rotates 60 isolated arrivals across all six free wallets', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.runner.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 60; i += 1) {
        f.enqueue(1);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(f.counts).toEqual([10, 10, 10, 10, 10, 10]);
    } finally { await f.runner.stop(); vi.useRealTimers(); }
  });

  it('drains a 60-job burst without restricting worker concurrency', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.runner.start();
      f.enqueue(60);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.counts).toEqual([10, 10, 10, 10, 10, 10]);
    } finally { await f.runner.stop(); vi.useRealTimers(); }
  });

  it('preserves sparse rotation when funding/preparation latencies differ', async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    try {
      await f.runner.start();
      await vi.advanceTimersByTimeAsync(30);
      for (let i = 0; i < 60; i += 1) {
        f.enqueue(1);
        await vi.advanceTimersByTimeAsync(30);
      }
      expect(f.counts).toEqual([10, 10, 10, 10, 10, 10]);
    } finally { await f.runner.stop(); vi.useRealTimers(); }
  });

  it('starts six executions concurrently and lets free wallets continue past a slow wallet', async () => {
    vi.useFakeTimers();
    let queued = 60;
    const active = new Set<string>();
    const counts = wallets.map(() => 0);
    let peak = 0;
    const publisher = createRunnerPublisher({
      claimScheduling: scheduling(async (walletId, claimed) => {
        if (!queued) return null;
        queued -= 1;
        expect(active.has(walletId)).toBe(false);
        active.add(walletId); peak = Math.max(peak, active.size);
        counts[wallets.indexOf(walletId)]! += 1;
        claimed();
        await new Promise((resolve) => setTimeout(resolve, walletId === wallets[0] ? 1000 : 1));
        active.delete(walletId);
        return { jobId: `job-${queued}` } as LiftJob;
      }),
    });
    const runner = new AsyncLiftRunner({ publisher, walletIds: wallets });
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(peak).toBe(6);
      expect(queued).toBe(0);
      expect(counts[0]).toBe(1);
      expect(counts.slice(1).every((count) => count > 1)).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
    } finally { await runner.stop(); vi.useRealTimers(); }
  });
});
