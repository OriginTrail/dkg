import { afterEach, describe, expect, it, vi } from 'vitest';

describe('production store scheduler timeout diagnostics', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('wires queue-wait timeouts to a warning with active work attribution', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '2');
    vi.stubEnv('DKG_STORE_QUEUE_WAIT_TIMEOUT_MS', '20');
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { externalStorePriorityScheduler } = await import('../src/store-priority-scheduler.js');

    let release!: () => void;
    const blocker = externalStorePriorityScheduler.run(
      'normal',
      'production.blocker',
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const waiter = externalStorePriorityScheduler.run(
      'normal',
      'production.waiter',
      async () => undefined,
    );
    const outcome = waiter.then(
      () => undefined,
      (error: unknown) => error,
    );

    try {
      await vi.advanceTimersByTimeAsync(20);
      await expect(outcome).resolves.toMatchObject({
        code: 'STORE_SCHEDULER_BUSY',
        reason: 'queue_wait_timeout',
        outcome: 'not_started',
      });
      expect(warn).toHaveBeenCalledWith(
        '[store scheduler] queue wait timeout',
        expect.objectContaining({
          waiting: { priority: 'normal', operation: 'production.waiter' },
          activeAtTimeout: [expect.objectContaining({
            priority: 'normal',
            operation: 'production.blocker',
            count: 1,
          })],
        }),
      );
    } finally {
      release();
      await blocker;
    }
  });
});

describe('production external-store capacity', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('applies the explicit policy to the shared adapter scheduler', async () => {
    vi.stubEnv('DKG_STORE_CONCURRENCY_POLICY', 'configured');
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '6');
    vi.resetModules();
    const { externalStorePriorityScheduler } = await import('../src/store-priority-scheduler.js');
    expect(externalStorePriorityScheduler.snapshot).toMatchObject({
      maxConcurrent: 6, normalInflightLimit: 4, ackReservedSlots: 1, healthReservedSlots: 1,
    });
  });
});
