/**
 * #3591 — idle wallets are offered work least recently used first.
 *
 * The runner used to wake idle wallets in configured order and every wallet polled on its own
 * clock, so with sparse arrivals the first configured wallet that was free took every job
 * (60/0/0/0/0/0 for 60 one-at-a-time jobs over six wallets). A burst still spread, because every
 * wallet was busy. These rows pin both shapes on a synthetic queue, a busy wallet that must never
 * be waited for, the poll path with no poke at all, and the same rotation through a real publisher.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import type { AsyncLiftPublisher, LiftJob } from '../src/index.js';
import { AsyncLiftRunner, TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../../../scripts/testing/ka-vm-publish.js';
import { createRunnerPublisher } from './_helpers/async-lift-runner-fixture.js';
import { workerHandler } from './_helpers/publisher-queue-scenarios.js';

type Scheduler = Parameters<NonNullable<AsyncLiftPublisher['reconciliationScheduling']>['attachScheduler']>[0];

const WALLETS = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];

afterEach(() => vi.useRealTimers());

/**
 * A queue the first caller of `processNext` takes from, as the claim lock serves its waiters. A job
 * holds its wallet for the wallet's service time, then the wallet is released with the same poke
 * the real publisher sends.
 */
function syntheticQueue(options: { serviceMs: (walletId: string) => number; attachScheduler?: boolean }) {
  const pending: string[] = [];
  const claims = new Map(WALLETS.map((walletId) => [walletId, 0]));
  let scheduler: Scheduler | undefined;
  let active = 0;
  let maxActive = 0;
  let admitted = 0;
  const publisher = createRunnerPublisher({
    processNext: async (walletId: string) => {
      const jobId = pending.shift();
      if (jobId === undefined) return null;
      claims.set(walletId, (claims.get(walletId) ?? 0) + 1);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, options.serviceMs(walletId)));
      active -= 1;
      scheduler?.onWalletRelease(walletId);
      return { jobId } as LiftJob;
    },
    ...(options.attachScheduler === false ? {} : {
      reconciliationScheduling: {
        attachScheduler: (hooks: Scheduler) => {
          scheduler = hooks;
          return () => { scheduler = undefined; };
        },
        recover: async () => ({ reconciled: 0, pendingWork: false }),
        reconcile: async () => ({ reconciled: 0, pendingWork: false }),
      },
    }),
  } as unknown as Partial<AsyncLiftPublisher>);
  return {
    publisher,
    claims: () => WALLETS.map((walletId) => claims.get(walletId)),
    maxActive: () => maxActive,
    pending: () => pending.length,
    admit(count: number, poke = true): void {
      for (let i = 0; i < count; i += 1) pending.push(`job-${++admitted}`);
      if (poke) scheduler?.onWorkAvailable?.();
    },
  };
}

function runnerFor(publisher: AsyncLiftPublisher, pollIntervalMs = 600_000): AsyncLiftRunner {
  return new AsyncLiftRunner({ publisher, walletIds: WALLETS, pollIntervalMs, recoveryIntervalMs: 600_000, errorBackoffMs: 1_000 });
}

describe('AsyncLiftRunner fair wallet rotation (#3591)', () => {
  it('rotates one-at-a-time arrivals across every idle wallet', async () => {
    vi.useFakeTimers();
    const queue = syntheticQueue({ serviceMs: () => 100 });
    const runner = runnerFor(queue.publisher);
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 60; i += 1) {
        queue.admit(1);
        await vi.advanceTimersByTimeAsync(150);
      }
      expect(queue.pending()).toBe(0);
      expect(queue.claims()).toEqual([10, 10, 10, 10, 10, 10]);
      expect(queue.maxActive()).toBe(1);
    } finally {
      await runner.stop();
    }
  });

  it('keeps all six wallets busy on a backlog and spreads it evenly', async () => {
    vi.useFakeTimers();
    const queue = syntheticQueue({ serviceMs: () => 100 });
    const runner = runnerFor(queue.publisher);
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(0);
      queue.admit(60);
      await vi.advanceTimersByTimeAsync(100 * 10 + 50);
      expect(queue.pending()).toBe(0);
      expect(queue.claims()).toEqual([10, 10, 10, 10, 10, 10]);
      expect(queue.maxActive()).toBe(6);
    } finally {
      await runner.stop();
    }
  });

  it('never waits for a busy wallet: arrivals go to the free wallets at once', async () => {
    vi.useFakeTimers();
    const queue = syntheticQueue({ serviceMs: (walletId) => (walletId === 'w1' ? 1_000_000 : 100) });
    const runner = runnerFor(queue.publisher);
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 26; i += 1) {
        queue.admit(1);
        await vi.advanceTimersByTimeAsync(1);
        // Claimed straight away, although the first wallet is still holding its first job.
        expect(queue.pending()).toBe(0);
        await vi.advanceTimersByTimeAsync(149);
      }
      expect(queue.claims()).toEqual([1, 5, 5, 5, 5, 5]);
    } finally {
      // Let the first wallet finish its long job so its loop can see the stop.
      const stopping = runner.stop();
      await vi.advanceTimersByTimeAsync(1_000_000);
      await stopping;
    }
  });

  it('offers work that no poke announced to the least recently used wallet first', async () => {
    vi.useFakeTimers();
    const queue = syntheticQueue({ serviceMs: () => 100, attachScheduler: false });
    const runner = runnerFor(queue.publisher, 1_000);
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 12; i += 1) {
        queue.admit(1, false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(queue.pending()).toBe(0);
      }
      expect(queue.claims()).toEqual([2, 2, 2, 2, 2, 2]);
    } finally {
      await runner.stop();
    }
  });

  it('rotates sparse admissions through the real publisher claim path', async () => {
    const store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      knowledgeAssetVmPublishHandler: workerHandler(store, []),
    });
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
    // Sparse means every wallet is parked when a job arrives: a wallet still returning from its
    // last job would legitimately take a job that is already waiting.
    let inFlight = 0;
    let lastSettledAt = Date.now();
    const processNext = publisher.processNext.bind(publisher);
    vi.spyOn(publisher, 'processNext').mockImplementation(async (walletId) => {
      inFlight += 1;
      try { return await processNext(walletId); } finally { inFlight -= 1; lastSettledAt = Date.now(); }
    });
    const settle = async (until: () => Promise<boolean>) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (!await until() || inFlight > 0 || Date.now() - lastSettledAt < 20)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const runner = new AsyncLiftRunner({
      publisher, walletIds: ['w1', 'w2', 'w3'], pollIntervalMs: 600_000, recoveryIntervalMs: 600_000,
      hasIncludedRecoveryResolver: true,
    });
    const signers: string[] = [];
    try {
      await runner.start();
      await settle(async () => true);
      for (let i = 0; i < 9; i += 1) {
        const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: `fair-${i}` }));
        await settle(async () => (await publisher.getStatus(jobId))?.status === 'finalized');
        const job = await publisher.getStatus(jobId);
        expect(job?.status).toBe('finalized');
        signers.push(job!.claim!.walletId);
      }
    } finally {
      await runner.stop();
      await store.close();
    }
    expect(signers).toEqual(['w1', 'w2', 'w3', 'w1', 'w2', 'w3', 'w1', 'w2', 'w3']);
  });
});
