/**
 * Event-driven wallet turnover: the release poke and the interruptible per-wallet idle wait.
 *
 * A released wallet used to idle out `pollIntervalMs` before its loop re-claimed, coupling
 * throughput to the operator's idle-load tuning. These rows pin the wake channel that removes
 * that: every row parks the poll at ten minutes, so any claim after the first can only come
 * from the poke — and the wait itself must be cancellable, never abandoning poll timers.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AsyncLiftPublisher, LiftJob } from '../src/index.js';
import { AsyncLiftRunner } from '../src/index.js';

type SchedulerHooks = {
  onReconciliationDemand(): void;
  onWalletRelease(walletId: string): void;
};

/**
 * Typed wallet-wake fixture: a fake scheduling-capable publisher whose captured scheduler
 * hooks the rows drive directly, plus a runner with the poll and sweeps parked so only the
 * poke can move anything.
 */
function createWalletWakeFixture(options: {
  processNext?: (walletId: string) => Promise<LiftJob | null>;
  walletIds?: string[];
} = {}) {
  const state = {
    scheduler: undefined as SchedulerHooks | undefined,
    processCalls: [] as string[],
  };
  const publisher = {
    claimNext: async () => null,
    update: async () => {},
    getStatus: async () => null,
    list: async () => [],
    processNext: options.processNext
      ?? (async (walletId: string) => {
        state.processCalls.push(walletId);
        return null;
      }),
    recordPublishResult: async () => {},
    recordPublishFailure: async () => {},
    recover: async () => 0,
    reconcileTransactions: async () => 0,
    drainDetachedExecutions: async () => {},
    reconciliationScheduling: {
      attachScheduler: (scheduler: SchedulerHooks) => {
        state.scheduler = scheduler;
        return () => {
          if (state.scheduler === scheduler) state.scheduler = undefined;
        };
      },
      reconcile: async () => ({ reconciled: 0, pendingWork: false }),
      recover: async () => ({ reconciled: 0, pendingWork: false }),
    },
    getStats: async () => ({}),
    pause: async () => {},
    resume: async () => {},
    cancel: async () => {},
    retry: async () => {},
    clear: async () => {},
  } as unknown as AsyncLiftPublisher;
  const runner = new AsyncLiftRunner({
    publisher,
    walletIds: options.walletIds ?? ['wallet-1'],
    pollIntervalMs: 600_000,
    recoveryIntervalMs: 600_000,
    errorBackoffMs: 1,
  });
  const release = (walletId: string) => state.scheduler?.onWalletRelease(walletId);
  return { publisher, runner, state, release };
}

describe('AsyncLiftRunner wallet-release wake', () => {
  it('claims immediately on a wallet-release poke instead of idling out the poll', async () => {
    vi.useFakeTimers();
    let claimable = false;
    const processCalls: string[] = [];
    const { runner, release } = createWalletWakeFixture({
      processNext: async (walletId) => {
        processCalls.push(walletId);
        if (claimable) {
          claimable = false;
          return { jobId: 'job-1' } as LiftJob;
        }
        return null;
      },
    });
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(5);
      const before = processCalls.length;
      expect(before).toBeGreaterThanOrEqual(1);
      claimable = true;
      release('wallet-1');
      await vi.advanceTimersByTimeAsync(5);
      expect(processCalls.length).toBeGreaterThan(before);
    } finally {
      await runner.stop();
      vi.useRealTimers();
    }
  });

  it('latches a release poke that lands during processNext and skips the next idle wait', async () => {
    vi.useFakeTimers();
    let processCalls = 0;
    let release!: (walletId: string) => void;
    const fixture = createWalletWakeFixture({
      processNext: async () => {
        processCalls += 1;
        if (processCalls === 1) {
          // The release lands while the loop is still INSIDE processNext: no sleeper is parked
          // yet, so the poke must latch and skip the upcoming idle wait entirely.
          release('wallet-1');
        }
        return null;
      },
    });
    release = fixture.release;
    try {
      await fixture.runner.start();
      await vi.advanceTimersByTimeAsync(5);
      // Call 2 happened without any timer elapsing; call 3 requires the (parked) poll.
      expect(processCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(processCalls).toBe(2);
    } finally {
      await fixture.runner.stop();
      vi.useRealTimers();
    }
  });

  it('ignores a release poke for a wallet this runner does not drive', async () => {
    vi.useFakeTimers();
    const { runner, state, release } = createWalletWakeFixture();
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(5);
      const before = state.processCalls.length;
      release('some-other-wallet');
      await vi.advanceTimersByTimeAsync(10);
      expect(state.processCalls.length).toBe(before);
    } finally {
      await runner.stop();
      vi.useRealTimers();
    }
  });

  it('cancels the losing poll delay on every wake and leaves no timers behind at stop', async () => {
    vi.useFakeTimers();
    const { runner, release } = createWalletWakeFixture();
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(5);
      const parked = vi.getTimerCount();
      // Repeated wakes must not accumulate abandoned poll timers: each wake cancels the delay
      // it interrupts, and the loop parks a fresh one.
      for (let i = 0; i < 5; i += 1) {
        release('wallet-1');
        await vi.advanceTimersByTimeAsync(2);
      }
      expect(vi.getTimerCount()).toBeLessThanOrEqual(parked);
    } finally {
      await runner.stop();
    }
    // Shutdown clears every pending handle — a stopped runner must not keep the process alive
    // for the residue of a ten-minute poll.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('stops promptly while wallet loops are parked in the idle wait', async () => {
    vi.useFakeTimers();
    const { runner } = createWalletWakeFixture({ walletIds: ['wallet-1', 'wallet-2'] });
    await runner.start();
    await vi.advanceTimersByTimeAsync(5);
    // Both loops are parked in a 600s idle wait. stop() must resolve them itself: under fake
    // timers, waiting out the poll would hang this test forever.
    await runner.stop();
    vi.useRealTimers();
  });
});
