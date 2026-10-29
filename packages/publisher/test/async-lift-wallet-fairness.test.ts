import { describe, expect, it, vi } from 'vitest';
import { AsyncLiftRunner, type LiftJob } from '../src/index.js';
import { createRunnerPublisher } from './_helpers/async-lift-runner-fixture.js';

const wallets = Array.from({ length: 6 }, (_, i) => `wallet-${i}`);

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
  if (scheduled) publisher.processNextScheduled = async (walletId, onClaimed) => {
    // Different preparation/RPC times must not make the fastest wallet win every sparse job.
    await new Promise((resolve) => setTimeout(resolve, wallets.indexOf(walletId) + 1));
    if (queued) onClaimed();
    return publisher.processNext(walletId);
  };
  const runner = new AsyncLiftRunner({ publisher, walletIds: wallets, pollIntervalMs: 60_000 });
  return { runner, counts, enqueue: (count: number) => { queued += count; hooks?.onWorkAvailable?.(); } };
}

describe('async publisher wallet fairness (#3591)', () => {
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
      processNextScheduled: async (walletId, claimed) => {
        if (!queued) return null;
        queued -= 1;
        expect(active.has(walletId)).toBe(false);
        active.add(walletId); peak = Math.max(peak, active.size);
        counts[wallets.indexOf(walletId)]! += 1;
        claimed();
        await new Promise((resolve) => setTimeout(resolve, walletId === wallets[0] ? 1000 : 1));
        active.delete(walletId);
        return { jobId: `job-${queued}` } as LiftJob;
      },
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
