import { describe, expect, it, vi } from 'vitest';
import type { AsyncLiftPublisher, LiftJob } from '../src/index.js';
import { AsyncLiftRunner } from '../src/index.js';

async function waitFor(assertion: () => void, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (e) {
      if (Date.now() - start > timeout) throw e;
      await new Promise(r => setTimeout(r, 10));
    }
  }
}

function createPublisher(overrides: Partial<AsyncLiftPublisher> = {}): AsyncLiftPublisher {
  return {
    lift: async () => {},
    claimNext: async () => null,
    update: async () => {},
    getStatus: async () => null,
    list: async () => [],
    processNext: async () => null,
    recordPublishResult: async () => {},
    recordPublishFailure: async () => {},
    recover: async () => 0,
    reconcileTransactions: async () => 0,
    drainDetachedExecutions: async () => {},
    getStats: () => ({}),
    pause: () => {},
    resume: () => {},
    cancel: async () => {},
    retry: async () => {},
    clear: async () => {},
    ...overrides,
  } as unknown as AsyncLiftPublisher;
}

describe('AsyncLiftRunner', () => {
  it('rejects a recovery interval above the Node.js timer limit', () => {
    expect(() => new AsyncLiftRunner({
      publisher: createPublisher(),
      walletIds: ['wallet-1'],
      recoveryIntervalMs: 2_147_483_648,
    })).toThrow(/1 through 2147483647 ms/);
  });

  it('supports the publisher contract from before dedicated reconciliation was added', async () => {
    let recoverCalls = 0;
    const publisher = createPublisher({
      recover: async () => {
        recoverCalls += 1;
        return 0;
      },
    });
    delete publisher.reconcileTransactions;
    delete publisher.drainDetachedExecutions;

    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
      recoveryIntervalMs: 5,
    });
    await runner.start();
    await waitFor(() => expect(recoverCalls).toBeGreaterThanOrEqual(2));
    await expect(runner.stop()).resolves.toBeUndefined();
  });

  it('can recover in paused maintenance mode before wallet processing starts', async () => {
    const order: string[] = [];
    let paused = false;
    let runner!: AsyncLiftRunner;
    const publisher = createPublisher({
      pause: async () => {
        paused = true;
        order.push('pause');
      },
      recover: async () => {
        order.push('recover');
        return 0;
      },
      processNext: async () => {
        order.push(paused ? 'process-paused' : 'process-active');
        return null;
      },
    } as any);

    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      startPaused: true,
      sleep: async () => { void runner.stop(); },
    });

    await runner.start();
    await waitFor(() => expect(order).toContain('process-paused'));
    await runner.stop();

    expect(order.slice(0, 3)).toEqual(['pause', 'recover', 'process-paused']);
  });

  it('runs recovery before processing wallets', async () => {
    const order: string[] = [];
    const publisher = createPublisher({
      recover: async () => {
        order.push('recover');
        return 0;
      },
      processNext: async () => {
        order.push('process');
        return null;
      },
    } as any);

    let sleeps = 0;
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep: async () => {
        sleeps += 1;
        void runner.stop();
      },
    });

    await runner.start();
    await waitFor(() => expect(order).toContain('process'));
    await runner.stop();

    expect(order[0]).toBe('recover');
    expect(order[1]).toBe('process');
    expect(sleeps).toBeGreaterThanOrEqual(0);
  });

  it('sleeps when no jobs are processed', async () => {
    const processNextCalls: unknown[][] = [];
    const sleepCalls: unknown[][] = [];
    let runner!: AsyncLiftRunner;

    const publisher = createPublisher({
      processNext: async (...args: unknown[]) => {
        processNextCalls.push(args);
        return null;
      },
    } as any);

    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep: async (...args: unknown[]) => {
        sleepCalls.push(args);
        void runner.stop();
      },
    } as any);

    const start = runner.start();
    await waitFor(() => expect(sleepCalls.length).toBeGreaterThan(0));
    await runner.stop();
    await start;

    expect(processNextCalls).toContainEqual(['wallet-1']);
  });

  it('processes wallets concurrently and lets each continue immediately after work', async () => {
    const processNextCalls: unknown[][] = [];
    const firstCycleWallets = new Set<string>();
    let releaseFirstCycle!: () => void;
    const bothWalletsStarted = new Promise<void>((resolve) => { releaseFirstCycle = resolve; });

    const publisher = createPublisher({
      processNext: async (...args: unknown[]) => {
        processNextCalls.push(args);
        const walletId = String(args[0]);
        if (!firstCycleWallets.has(walletId)) {
          firstCycleWallets.add(walletId);
          if (firstCycleWallets.size === 2) releaseFirstCycle();
          await bothWalletsStarted;
          return { jobId: `job-${walletId}` } as LiftJob;
        }
        return null;
      },
    } as any);

    let runner!: AsyncLiftRunner;
    const sleepCalls: unknown[][] = [];

    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1', 'wallet-2'],
      sleep: async (...args: unknown[]) => {
        sleepCalls.push(args);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    } as any);

    const start = runner.start();
    await waitFor(() => expect(firstCycleWallets.size).toBe(2));
    await waitFor(() => expect(processNextCalls.length).toBeGreaterThanOrEqual(4));
    await runner.stop();
    await start;

    expect(firstCycleWallets).toEqual(new Set(['wallet-1', 'wallet-2']));
    expect(processNextCalls.filter((call) => call[0] === 'wallet-1').length).toBeGreaterThanOrEqual(2);
    expect(processNextCalls.filter((call) => call[0] === 'wallet-2').length).toBeGreaterThanOrEqual(2);
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not let a stuck wallet block another wallet from processing more jobs', async () => {
    let releaseStuckWallet!: () => void;
    const stuckWallet = new Promise<void>((resolve) => { releaseStuckWallet = resolve; });
    let walletTwoCalls = 0;
    const publisher = createPublisher({
      processNext: async (walletId: string) => {
        if (walletId === 'wallet-1') {
          await stuckWallet;
          return null;
        }
        walletTwoCalls += 1;
        return walletTwoCalls <= 3
          ? { jobId: `wallet-two-job-${walletTwoCalls}` } as LiftJob
          : null;
      },
    } as any);

    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1', 'wallet-2'],
      pollIntervalMs: 1,
    });

    await runner.start();
    await waitFor(() => expect(walletTwoCalls).toBeGreaterThanOrEqual(3));
    releaseStuckWallet();
    await runner.stop();

    expect(walletTwoCalls).toBeGreaterThanOrEqual(3);
  });

  it('reconciles transactions while a wallet attempt remains stuck', async () => {
    let releaseStuckWallet!: () => void;
    const stuckWallet = new Promise<void>((resolve) => { releaseStuckWallet = resolve; });
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      processNext: async (walletId: string) => {
        if (walletId === 'wallet-1') await stuckWallet;
        return null;
      },
      reconcileTransactions: async () => {
        reconciliationCalls += 1;
        return 0;
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1', 'wallet-2'],
      pollIntervalMs: 1,
      recoveryIntervalMs: 5,
    });

    await runner.start();
    await waitFor(() => expect(reconciliationCalls).toBeGreaterThanOrEqual(1));
    releaseStuckWallet();
    await runner.stop();

    expect(reconciliationCalls).toBeGreaterThanOrEqual(1);
  });

  it('retries periodic reconciliation after an error', async () => {
    let reconciliationCalls = 0;
    const errors: unknown[] = [];
    const publisher = createPublisher({
      reconcileTransactions: async () => {
        reconciliationCalls += 1;
        if (reconciliationCalls === 1) throw new Error('temporary reconciliation failure');
        return 0;
      },
    });
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
      recoveryIntervalMs: 5,
      errorBackoffMs: 5,
      onError: (error) => { errors.push(error); },
    });

    await runner.start();
    await waitFor(() => expect(reconciliationCalls).toBeGreaterThanOrEqual(2));
    await runner.stop();

    expect(errors).toHaveLength(1);
  });

  it('waits for detached publisher executions during shutdown', async () => {
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    let drainCalls = 0;
    const publisher = createPublisher({
      drainDetachedExecutions: async () => {
        drainCalls += 1;
        await drainGate;
      },
    });
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
    });
    await runner.start();
    const stopping = runner.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await waitFor(() => expect(drainCalls).toBe(1));
    expect(stopped).toBe(false);

    releaseDrain();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('backs off and continues after loop-level errors', async () => {
    const processNextCalls: unknown[][] = [];
    let pnIdx = 0;
    const onErrorCalls: unknown[][] = [];
    const sleepCalls: unknown[][] = [];

    const publisher = createPublisher({
      processNext: async (...args: unknown[]) => {
        processNextCalls.push(args);
        if (pnIdx++ === 0) throw new Error('boom');
        return null;
      },
    } as any);

    let runner!: AsyncLiftRunner;
    let sleepCallCount = 0;

    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep: async (...args: unknown[]) => {
        sleepCalls.push(args);
        sleepCallCount++;
        if (sleepCallCount > 1) {
          void runner.stop();
        }
      },
      onError: async (...args: unknown[]) => {
        onErrorCalls.push(args);
      },
      errorBackoffMs: 50,
    } as any);

    const start = runner.start();
    await waitFor(() => expect(onErrorCalls.length).toBeGreaterThan(0));
    await waitFor(() => expect(processNextCalls.length).toBeGreaterThanOrEqual(2));
    await runner.stop();
    await start;

    expect(sleepCalls).toContainEqual([50]);
  });

  it('rejects startup without wallets', async () => {
    const runner = new AsyncLiftRunner({
      publisher: createPublisher(),
      walletIds: [],
      sleep: async () => {},
    });

    await expect(runner.start()).rejects.toThrow('AsyncLiftRunner requires at least one walletId');
  });

  it('can retry start after recover fails once', async () => {
    const recoverCalls: unknown[][] = [];
    let recoverIdx = 0;
    const processNextCalls: unknown[][] = [];

    const publisher = createPublisher({
      recover: async (...args: unknown[]) => {
        recoverCalls.push(args);
        if (recoverIdx++ === 0) throw new Error('recover failed');
        return 0;
      },
      processNext: async (...args: unknown[]) => {
        processNextCalls.push(args);
        return null;
      },
    } as any);

    let runner!: AsyncLiftRunner;
    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep: async () => {
        void runner.stop();
      },
    });

    await expect(runner.start()).rejects.toThrow('recover failed');
    await expect(runner.start()).resolves.toBeUndefined();
    await runner.stop();

    expect(recoverCalls.length).toBe(2);
    expect(processNextCalls.length).toBeGreaterThan(0);
  });

  it('continues even if onError throws', async () => {
    const processNextCalls: unknown[][] = [];
    let pnIdx = 0;
    const onErrorCalls: unknown[][] = [];
    const sleepCalls: unknown[][] = [];

    const publisher = createPublisher({
      processNext: async (...args: unknown[]) => {
        processNextCalls.push(args);
        if (pnIdx++ === 0) throw new Error('boom');
        return null;
      },
    } as any);

    let runner!: AsyncLiftRunner;
    let sleepCallCount = 0;

    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      onError: async (...args: unknown[]) => {
        onErrorCalls.push(args);
        throw new Error('logger failed');
      },
      sleep: async (...args: unknown[]) => {
        sleepCalls.push(args);
        sleepCallCount++;
        if (sleepCallCount > 1) {
          void runner.stop();
        }
      },
      errorBackoffMs: 25,
    } as any);

    const start = runner.start();
    await waitFor(() => expect(processNextCalls.length).toBeGreaterThanOrEqual(2));
    await runner.stop();
    await start;

    expect(onErrorCalls.length).toBeGreaterThan(0);
    expect(sleepCalls).toContainEqual([25]);
  });

  it('fails startup when included jobs remain without recovery resolver support', async () => {
    const publisher = createPublisher({
      list: async (filter?: { status?: string }) =>
        filter?.status === 'included' ? [{ jobId: 'job-1', status: 'included' } as LiftJob] : [],
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep: async () => {},
      hasIncludedRecoveryResolver: false,
    });

    await expect(runner.start()).rejects.toThrow(
      'AsyncLiftRunner requires included-job recovery support when included jobs remain after startup recovery',
    );
  });

  it('runs reconciliation promptly on a demand poke instead of waiting out the idle cadence', async () => {
    let demand: (() => void) | undefined;
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: (listener: () => void) => {
          demand = listener;
          return () => { demand = undefined; };
        },
        reconcile: async () => {
          reconciliationCalls += 1;
          return { reconciled: 0, pendingWork: false };
        },
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
      // Ten minutes out: any pass inside this test can only have come from the poke.
      recoveryIntervalMs: 600_000,
    });

    await runner.start();
    expect(demand).toBeDefined();
    expect(reconciliationCalls).toBe(0);
    demand!();
    await waitFor(() => expect(reconciliationCalls).toBeGreaterThanOrEqual(1));
    await runner.stop();
  });

  it('coalesces demand pokes that arrive during an in-flight pass into one follow-up pass', async () => {
    let demand!: () => void;
    let releaseFirstPass!: () => void;
    const firstPassGate = new Promise<void>((resolve) => { releaseFirstPass = resolve; });
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: (listener: () => void) => {
          demand = listener;
          return () => {};
        },
        reconcile: async () => {
          reconciliationCalls += 1;
          if (reconciliationCalls === 1) await firstPassGate;
          return { reconciled: 0, pendingWork: false };
        },
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
      recoveryIntervalMs: 600_000,
      // Keep the attempt floor out of the way so the assertion measures coalescing, not backoff.
      errorBackoffMs: 5,
    });

    await runner.start();
    demand();
    await waitFor(() => expect(reconciliationCalls).toBe(1));
    demand();
    demand();
    demand();
    releaseFirstPass();
    await waitFor(() => expect(reconciliationCalls).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reconciliationCalls).toBe(2);
    await runner.stop();
  });

  it('holds the active cadence while pending work remains and returns to the idle sweep when none does', async () => {
    let pending = true;
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: () => () => {},
        reconcile: async () => {
          reconciliationCalls += 1;
          return { reconciled: 0, pendingWork: pending };
        },
        recover: async () => ({ reconciled: 0, pendingWork: pending }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
      recoveryIntervalMs: 600_000,
      activeRecoveryIntervalMs: 5,
      // Keep the attempt floor below the active cadence so the assertion measures the cadence.
      errorBackoffMs: 1,
    });

    await runner.start();
    // Pending was seeded before the first schedule, so passes run on the active cadence.
    await waitFor(() => expect(reconciliationCalls).toBeGreaterThanOrEqual(3));
    pending = false;
    // Let the already-due pass observe the flip, then require the cadence to go quiet.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settledCalls = reconciliationCalls;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reconciliationCalls).toBe(settledCalls);
    await runner.stop();
  });

  it('keeps the error backoff as the floor for demanded reconciliation', async () => {
    let demand!: () => void;
    let reconciliationCalls = 0;
    const errors: unknown[] = [];
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: (listener: () => void) => {
          demand = listener;
          return () => {};
        },
        reconcile: async () => {
          reconciliationCalls += 1;
          throw new Error('reconciliation keeps failing');
        },
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
      recoveryIntervalMs: 600_000,
      errorBackoffMs: 100,
      onError: (error) => { errors.push(error); },
    });

    await runner.start();
    const pokeUntil = Date.now() + 250;
    while (Date.now() < pokeUntil) {
      demand();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // 250ms of continuous pokes over a 100ms floor allows the initial pass plus at most a few
    // backed-off retries — a hot loop would have produced dozens.
    expect(reconciliationCalls).toBeGreaterThanOrEqual(1);
    expect(reconciliationCalls).toBeLessThanOrEqual(5);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    await runner.stop();
  });

  it('disposes the demand subscription on stop and ignores pokes from a kept listener reference', async () => {
    let demand: (() => void) | undefined;
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: (listener: () => void) => {
          demand = listener;
          return () => { demand = undefined; };
        },
        reconcile: async () => {
          reconciliationCalls += 1;
          return { reconciled: 0, pendingWork: false };
        },
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
      recoveryIntervalMs: 600_000,
    });

    await runner.start();
    expect(demand).toBeDefined();
    const keptListener = demand!;
    await runner.stop();
    // stop() disposed the subscription, so the publisher no longer holds the callback...
    expect(demand).toBeUndefined();
    const callsAfterStop = reconciliationCalls;
    // ...and even a reference someone kept anyway cannot poke the stopped runner into a pass.
    keptListener();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reconciliationCalls).toBe(callsAfterStop);
  });

  it('retries a demanded pass on the error backoff after a transient failure instead of dropping the demand', async () => {
    let demand!: () => void;
    let reconciliationCalls = 0;
    const errors: unknown[] = [];
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: (listener: () => void) => {
          demand = listener;
          return () => {};
        },
        reconcile: async () => {
          reconciliationCalls += 1;
          if (reconciliationCalls === 1) throw new Error('transient reconcile failure');
          return { reconciled: 0, pendingWork: false };
        },
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
      // Ten minutes out with a short backoff: the ONE poke below must survive the failed first
      // pass and produce the successful second pass on the backoff floor, not at the idle sweep.
      recoveryIntervalMs: 600_000,
      errorBackoffMs: 10,
      onError: (error) => { errors.push(error); },
    });

    await runner.start();
    demand();
    await waitFor(() => expect(reconciliationCalls).toBeGreaterThanOrEqual(2));
    expect(errors).toHaveLength(1);
    await runner.stop();
  });

  it('holds the documented 5000ms default active cadence when activeRecoveryIntervalMs is unset', async () => {
    vi.useFakeTimers();
    const blockedSleeps: Array<() => void> = [];
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: () => () => {},
        reconcile: async () => {
          reconciliationCalls += 1;
          return { reconciled: 0, pendingWork: true };
        },
        recover: async () => ({ reconciled: 0, pendingWork: true }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      // No activeRecoveryIntervalMs: the row pins the library DEFAULT the slowdown fix relies
      // on — a regression to a longer default would leave every override-based row green.
      recoveryIntervalMs: 600_000,
      errorBackoffMs: 1,
      // Park the wallet loop without real timers: each idle turn blocks until stop.
      sleep: () => new Promise<void>((resolve) => { blockedSleeps.push(resolve); }),
    });
    try {
      await runner.start();
      expect(reconciliationCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(reconciliationCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(reconciliationCalls).toBe(1);
      // Repeats on the same default while pending work remains — the ACTIVE cadence, not the
      // parked 600s idle sweep.
      await vi.advanceTimersByTimeAsync(5_001);
      expect(reconciliationCalls).toBe(2);
    } finally {
      const stopping = runner.stop();
      blockedSleeps.forEach((resolve) => resolve());
      await stopping;
      vi.useRealTimers();
    }
  });

  it('inherits an explicitly faster recoveryIntervalMs as the active cadence when the new knob is unset', async () => {
    // A consumer that configured recoveryIntervalMs below 5s already had that pending-check
    // rate; the new active default must not slow them down on upgrade.
    vi.useFakeTimers();
    const blockedSleeps: Array<() => void> = [];
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: () => () => {},
        reconcile: async () => {
          reconciliationCalls += 1;
          return { reconciled: 0, pendingWork: true };
        },
        recover: async () => ({ reconciled: 0, pendingWork: true }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      recoveryIntervalMs: 1_000,
      errorBackoffMs: 1,
      sleep: () => new Promise<void>((resolve) => { blockedSleeps.push(resolve); }),
    });
    try {
      await runner.start();
      expect(reconciliationCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(reconciliationCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(reconciliationCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(reconciliationCalls).toBe(2);
    } finally {
      const stopping = runner.stop();
      blockedSleeps.forEach((resolve) => resolve());
      await stopping;
      vi.useRealTimers();
    }
  });


  it('holds an explicitly configured active cadence exactly, not merely a fast one', async () => {
    // The knob must CONTROL the delay: a runner that ignored it for any hard-coded fast
    // cadence would pass every loose "reconciles quickly" assertion while hammering the
    // store and chain at a rate the operator never chose.
    vi.useFakeTimers();
    const blockedSleeps: Array<() => void> = [];
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: () => () => {},
        reconcile: async () => {
          reconciliationCalls += 1;
          return { reconciled: 0, pendingWork: true };
        },
        recover: async () => ({ reconciled: 0, pendingWork: true }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      recoveryIntervalMs: 600_000,
      activeRecoveryIntervalMs: 1_234,
      errorBackoffMs: 1,
      sleep: () => new Promise<void>((resolve) => { blockedSleeps.push(resolve); }),
    });
    try {
      await runner.start();
      expect(reconciliationCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1_233);
      expect(reconciliationCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(reconciliationCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_235);
      expect(reconciliationCalls).toBe(2);
    } finally {
      const stopping = runner.stop();
      blockedSleeps.forEach((resolve) => resolve());
      await stopping;
      vi.useRealTimers();
    }
  });

  it('can retry start after the capability recovery pass fails once', async () => {
    let recoverCalls = 0;
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachWalletReleaseListener: () => () => {},
        attachDemandListener: () => () => {},
        reconcile: async () => {
          reconciliationCalls += 1;
          return { reconciled: 0, pendingWork: false };
        },
        recover: async () => {
          recoverCalls += 1;
          if (recoverCalls === 1) throw new Error('startup recovery failed');
          return { reconciled: 0, pendingWork: false };
        },
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 1,
      recoveryIntervalMs: 600_000,
    });

    await expect(runner.start()).rejects.toThrow('startup recovery failed');
    await expect(runner.start()).resolves.toBeUndefined();
    expect(recoverCalls).toBe(2);
    await runner.stop();
    expect(reconciliationCalls).toBe(0);
  });

  it('rejects an active recovery interval above the Node.js timer limit', () => {
    expect(() => new AsyncLiftRunner({
      publisher: createPublisher(),
      walletIds: ['wallet-1'],
      activeRecoveryIntervalMs: 2_147_483_648,
    })).toThrow(/1 through 2147483647 ms/);
  });

  it('claims immediately on a wallet-release poke instead of idling out the poll', async () => {
    vi.useFakeTimers();
    let release!: (walletId: string) => void;
    let claimable = false;
    const processCalls: string[] = [];
    const publisher = createPublisher({
      processNext: async (walletId: string) => {
        processCalls.push(walletId);
        if (claimable) {
          claimable = false;
          return { jobId: 'job-1' } as LiftJob;
        }
        return null;
      },
      reconciliationScheduling: {
        attachDemandListener: () => () => {},
        attachWalletReleaseListener: (listener: (walletId: string) => void) => {
          release = listener;
          return () => {};
        },
        reconcile: async () => ({ reconciled: 0, pendingWork: false }),
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      // Poll parked ten minutes out: any claim attempt after the first can only come from the poke.
      pollIntervalMs: 600_000,
      recoveryIntervalMs: 600_000,
      errorBackoffMs: 1,
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
      const stopping = runner.stop();
      await stopping;
      vi.useRealTimers();
    }
  });

  it('latches a release poke that lands during processNext and skips the next idle wait', async () => {
    vi.useFakeTimers();
    let release!: (walletId: string) => void;
    let processCalls = 0;
    const publisher = createPublisher({
      processNext: async () => {
        processCalls += 1;
        if (processCalls === 1) {
          // The release lands while the loop is still INSIDE processNext: no sleeper is parked
          // yet, so the poke must latch and skip the upcoming idle wait entirely.
          release('wallet-1');
        }
        return null;
      },
      reconciliationScheduling: {
        attachDemandListener: () => () => {},
        attachWalletReleaseListener: (listener: (walletId: string) => void) => {
          release = listener;
          return () => {};
        },
        reconcile: async () => ({ reconciled: 0, pendingWork: false }),
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 600_000,
      recoveryIntervalMs: 600_000,
      errorBackoffMs: 1,
    });
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(5);
      // Call 2 happened without any timer elapsing; call 3 requires the (parked) poll.
      expect(processCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(processCalls).toBe(2);
    } finally {
      const stopping = runner.stop();
      await stopping;
      vi.useRealTimers();
    }
  });

  it('ignores a release poke for a wallet this runner does not drive', async () => {
    vi.useFakeTimers();
    let release!: (walletId: string) => void;
    let processCalls = 0;
    const publisher = createPublisher({
      processNext: async () => {
        processCalls += 1;
        return null;
      },
      reconciliationScheduling: {
        attachDemandListener: () => () => {},
        attachWalletReleaseListener: (listener: (walletId: string) => void) => {
          release = listener;
          return () => {};
        },
        reconcile: async () => ({ reconciled: 0, pendingWork: false }),
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 600_000,
      recoveryIntervalMs: 600_000,
      errorBackoffMs: 1,
    });
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(5);
      const before = processCalls;
      release('some-other-wallet');
      await vi.advanceTimersByTimeAsync(10);
      expect(processCalls).toBe(before);
    } finally {
      const stopping = runner.stop();
      await stopping;
      vi.useRealTimers();
    }
  });

  it('stops promptly while wallet loops are parked in the idle wait', async () => {
    vi.useFakeTimers();
    const publisher = createPublisher({
      processNext: async () => null,
      reconciliationScheduling: {
        attachDemandListener: () => () => {},
        attachWalletReleaseListener: () => () => {},
        reconcile: async () => ({ reconciled: 0, pendingWork: false }),
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1', 'wallet-2'],
      pollIntervalMs: 600_000,
      recoveryIntervalMs: 600_000,
      errorBackoffMs: 1,
    });
    await runner.start();
    await vi.advanceTimersByTimeAsync(5);
    // Both loops are parked in a 600s idle wait. stop() must resolve them itself: under fake
    // timers, waiting out the poll would hang this test forever.
    await runner.stop();
    vi.useRealTimers();
  });

  it('runs a demanded pass immediately after a successful pass, unfloored by errorBackoffMs', async () => {
    vi.useFakeTimers();
    let demand!: () => void;
    let reconciliationCalls = 0;
    const publisher = createPublisher({
      reconciliationScheduling: {
        attachDemandListener: (listener: () => void) => {
          demand = listener;
          return () => {};
        },
        attachWalletReleaseListener: () => () => {},
        reconcile: async () => {
          reconciliationCalls += 1;
          return { reconciled: 0, pendingWork: false };
        },
        recover: async () => ({ reconciled: 0, pendingWork: false }),
      },
    } as any);
    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 600_000,
      recoveryIntervalMs: 600_000,
      // Parked ten minutes out: the errorBackoff floor paces FAILURES only; a wake following the
      // (successful) startup recovery must not wait it out.
      errorBackoffMs: 600_000,
    });
    try {
      await runner.start();
      expect(reconciliationCalls).toBe(0);
      demand();
      await vi.advanceTimersByTimeAsync(5);
      expect(reconciliationCalls).toBe(1);
      // The load-bearing half: a SECOND demanded pass right after a SUCCESSFUL first one must
      // also run immediately. A floor keyed to attempts (rather than failures) would anchor to
      // pass 1's start and park this wake for the full parked backoff.
      demand();
      await vi.advanceTimersByTimeAsync(5);
      expect(reconciliationCalls).toBe(2);
    } finally {
      const stopping = runner.stop();
      await stopping;
      vi.useRealTimers();
    }
  });

  it('stops cleanly while idle without scheduling extra work', async () => {
    const processNextCalls: unknown[][] = [];
    const sleepCalls: unknown[][] = [];
    let sleepStarted: (() => void) | undefined;

    const publisher = createPublisher({
      processNext: async (...args: unknown[]) => {
        processNextCalls.push(args);
        return null;
      },
    } as any);

    let runner!: AsyncLiftRunner;

    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep: (...args: unknown[]) => {
        sleepCalls.push(args);
        return new Promise<void>((resolve) => {
          sleepStarted = resolve;
        });
      },
    } as any);

    const start = runner.start();
    await waitFor(() => expect(sleepCalls.length).toBeGreaterThan(0));
    const callsBeforeStop = processNextCalls.length;
    const stopPromise = runner.stop();
    sleepStarted?.();
    await stopPromise;
    await start;

    expect(processNextCalls.length).toBe(callsBeforeStop);
  });
});
