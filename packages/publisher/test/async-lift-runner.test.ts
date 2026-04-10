import { describe, expect, it, vi } from 'vitest';
import type { AsyncLiftPublisher, LiftJob } from '../src/index.js';
import { AsyncLiftRunner } from '../src/index.js';

function createPublisher(overrides: Partial<AsyncLiftPublisher> = {}): AsyncLiftPublisher {
  return {
    lift: vi.fn(),
    claimNext: vi.fn(),
    update: vi.fn(),
    getStatus: vi.fn(),
    list: vi.fn(async () => []),
    processNext: vi.fn(async () => null),
    recordPublishResult: vi.fn(),
    recordPublishFailure: vi.fn(),
    recover: vi.fn(async () => 0),
    getStats: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  } as unknown as AsyncLiftPublisher;
}

describe('AsyncLiftRunner', () => {
  it('runs recovery before processing wallets', async () => {
    const order: string[] = [];
    const publisher = createPublisher({
      recover: vi.fn(async () => {
        order.push('recover');
        return 0;
      }),
      processNext: vi.fn(async () => {
        order.push('process');
        return null;
      }),
    });

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
    const processNext = vi.fn(async () => null);
    const publisher = createPublisher({ processNext });
    let runner!: AsyncLiftRunner;
    const sleep = vi.fn(async () => {
      void runner.stop();
    });
    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep,
    });

    const start = runner.start();
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled());
    await runner.stop();
    await start;

    expect(processNext).toHaveBeenCalledWith('wallet-1');
  });

  it('iterates wallets and continues immediately after work is processed', async () => {
    const processNext = vi
      .fn<AsyncLiftPublisher['processNext']>()
      .mockResolvedValueOnce({ jobId: 'job-1' } as LiftJob)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const publisher = createPublisher({ processNext });
    let runner!: AsyncLiftRunner;
    const sleep = vi.fn(async () => {
      void runner.stop();
    });
    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1', 'wallet-2'],
      sleep,
    });

    const start = runner.start();
    await vi.waitFor(() => expect(processNext.mock.calls.length).toBeGreaterThanOrEqual(3));
    await runner.stop();
    await start;

    expect(processNext.mock.calls.slice(0, 3).map((call) => call[0])).toEqual(['wallet-1', 'wallet-2', 'wallet-1']);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('backs off and continues after loop-level errors', async () => {
    const processNext = vi
      .fn<AsyncLiftPublisher['processNext']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(null);
    const onError = vi.fn();
    const publisher = createPublisher({ processNext });
    let runner!: AsyncLiftRunner;
    let sleepCalls = 0;
    const sleep = vi.fn(async () => {
      sleepCalls += 1;
      if (sleepCalls > 1) {
        void runner.stop();
      }
    });
    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep,
      onError,
      errorBackoffMs: 50,
    });

    const start = runner.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    await vi.waitFor(() => expect(processNext.mock.calls.length).toBeGreaterThanOrEqual(2));
    await runner.stop();
    await start;

    expect(sleep).toHaveBeenCalledWith(50);
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
    const recover = vi
      .fn<AsyncLiftPublisher['recover']>()
      .mockRejectedValueOnce(new Error('recover failed'))
      .mockResolvedValueOnce(0);
    const processNext = vi.fn(async () => null);
    const publisher = createPublisher({ recover, processNext });
    let runner!: AsyncLiftRunner;
    const sleep = vi.fn(async () => {
      void runner.stop();
    });
    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep,
    });

    await expect(runner.start()).rejects.toThrow('recover failed');
    await expect(runner.start()).resolves.toBeUndefined();
    await runner.stop();

    expect(recover).toHaveBeenCalledTimes(2);
    expect(processNext).toHaveBeenCalled();
  });

  it('continues even if onError throws', async () => {
    const processNext = vi
      .fn<AsyncLiftPublisher['processNext']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(null);
    const onError = vi.fn(async () => {
      throw new Error('logger failed');
    });
    let runner!: AsyncLiftRunner;
    let sleepCalls = 0;
    const sleep = vi.fn(async () => {
      sleepCalls += 1;
      if (sleepCalls > 1) {
        void runner.stop();
      }
    });
    runner = new AsyncLiftRunner({
      publisher: createPublisher({ processNext }),
      walletIds: ['wallet-1'],
      onError,
      sleep,
      errorBackoffMs: 25,
    });

    const start = runner.start();
    await vi.waitFor(() => expect(processNext.mock.calls.length).toBeGreaterThanOrEqual(2));
    await runner.stop();
    await start;

    expect(onError).toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('fails startup when included jobs remain without recovery resolver support', async () => {
    const publisher = createPublisher({
      list: vi.fn(async (filter?: { status?: string }) => (filter?.status === 'included' ? [{ jobId: 'job-1', status: 'included' } as LiftJob] : [])),
    });
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
    const processNext = vi.fn(async () => null);
    const publisher = createPublisher({ processNext });
    let runner!: AsyncLiftRunner;
    let sleepStarted: (() => void) | undefined;
    const sleep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          sleepStarted = resolve;
        }),
    );
    runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      sleep,
    });

    const start = runner.start();
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled());
    const callsBeforeStop = processNext.mock.calls.length;
    const stopPromise = runner.stop();
    sleepStarted?.();
    await stopPromise;
    await start;

    expect(processNext.mock.calls.length).toBe(callsBeforeStop);
  });
});
