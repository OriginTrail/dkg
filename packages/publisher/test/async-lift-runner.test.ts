import { describe, expect, it } from 'vitest';
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

  it('iterates wallets and continues immediately after work is processed', async () => {
    const processNextCalls: unknown[][] = [];
    let pnIdx = 0;
    const pnResponses: (LiftJob | null)[] = [{ jobId: 'job-1' } as LiftJob, null, null];

    const publisher = createPublisher({
      processNext: async (...args: unknown[]) => {
        processNextCalls.push(args);
        if (pnIdx < pnResponses.length) return pnResponses[pnIdx++];
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
        void runner.stop();
      },
    } as any);

    const start = runner.start();
    await waitFor(() => expect(processNextCalls.length).toBeGreaterThanOrEqual(3));
    await runner.stop();
    await start;

    expect(processNextCalls.slice(0, 3).map((call) => call[0])).toEqual(['wallet-1', 'wallet-2', 'wallet-1']);
    expect(sleepCalls.length).toBe(1);
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
