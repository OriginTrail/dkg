import { describe, expect, it, vi } from 'vitest';
import {
  StorePriorityScheduler,
  StoreSchedulerBusyError,
  isStoreSchedulerBusyError,
} from '../src/store-priority-scheduler.js';
import { STORE_WORK_PRIORITIES } from '../src/triple-store.js';
import { createRateLimitedStoreTimeoutDiagnosticSink } from '../src/store-scheduler-timeout-diagnostics.js';

describe('store scheduler busy diagnostics', () => {
  it('rate-limits repeated waiter diagnostics and bounds retained keys', () => {
    const emit = vi.fn();
    let now = 0;
    const sink = createRateLimitedStoreTimeoutDiagnosticSink({
      emit, now: () => now, intervalMs: 100, maxKeys: 2,
    });
    const diagnostic = (operation: string) => ({
      waiting: { priority: 'normal' as const, operation },
      activeAtTimeout: [{
        priority: 'background' as const, operation: 'active.private-work', count: 1, oldestAgeMs: 42,
      }],
    });
    sink({ ...diagnostic('empty'), activeAtTimeout: [] });
    sink(diagnostic('first'));
    sink(diagnostic('first'));
    expect(emit).toHaveBeenCalledTimes(1);
    now = 101;
    sink(diagnostic('first'));
    sink(diagnostic('second'));
    sink(diagnostic('third'));
    sink(diagnostic('first'));
    expect(emit.mock.calls.map(([event]) => event.waiting.operation)).toEqual([
      'first', 'first', 'second', 'third', 'first',
    ]);
  });
  it('caps warning volume when rotating waiter labels exceed the key cache', async () => {
    const emit = vi.fn(async () => { throw new Error('telemetry unavailable'); });
    let now = 0;
    const sink = createRateLimitedStoreTimeoutDiagnosticSink({
      emit, now: () => now, intervalMs: 100, maxKeys: 2, maxEmitsPerWindow: 3,
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let key = 0; key < 5; key++) sink({
        waiting: { priority: 'normal', operation: `op-${key}` },
        activeAtTimeout: [{
          priority: 'normal', operation: 'active', count: 1, oldestAgeMs: 10,
        }],
      });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(emit).toHaveBeenCalledTimes(3);
    now = 101;
    sink({
      waiting: { priority: 'normal', operation: 'new' },
      activeAtTimeout: [{ priority: 'normal', operation: 'active', count: 1, oldestAgeMs: 10 }],
    });
    expect(emit).toHaveBeenCalledTimes(4);
  });
  it('swallows synchronous diagnostic delivery failure without changing timeout handling', () => {
    const sink = createRateLimitedStoreTimeoutDiagnosticSink({
      emit: () => { throw new Error('telemetry unavailable'); },
      now: () => 0,
      intervalMs: 100,
    });
    expect(() => sink({
      waiting: { priority: 'normal', operation: 'query' },
      activeAtTimeout: [{ priority: 'background', operation: 'scan', count: 1, oldestAgeMs: 10 }],
    })).not.toThrow();
  });
  it('exports a distinguishable busy error type for boundary mapping', () => {
    const error = new StoreSchedulerBusyError('queue_full', 'ack', 'storage-ack.read');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StoreSchedulerBusyError);
    expect(error).toMatchObject({
      code: 'STORE_SCHEDULER_BUSY',
      retryable: true,
      reason: 'queue_full',
    });
    expect(isStoreSchedulerBusyError(error)).toBe(true);
  });

  it('recognizes only complete structural busy errors across package boundaries', () => {
    const structural = {
      code: 'STORE_SCHEDULER_BUSY',
      retryable: true,
      outcome: 'not_started',
      storeOperationOutcomeTag: 'dkg.store-operation-outcome.v1',
      reason: 'queue_wait_timeout',
      priority: 'normal',
      operation: 'remote-query.read',
      storeOperation: 'query',
    };

    for (const priority of STORE_WORK_PRIORITIES) {
      expect(isStoreSchedulerBusyError({ ...structural, priority })).toBe(true);
    }
    expect(isStoreSchedulerBusyError({ ...structural, retryable: false })).toBe(false);
    expect(isStoreSchedulerBusyError({ ...structural, outcome: 'indeterminate' })).toBe(false);
    expect(isStoreSchedulerBusyError({
      ...structural,
      storeOperationOutcomeTag: 'dkg.store-operation-outcome.v2',
    })).toBe(false);
    expect(isStoreSchedulerBusyError({ ...structural, storeOperation: 'unknown' })).toBe(false);
    expect(isStoreSchedulerBusyError({ ...structural, reason: undefined })).toBe(false);
    expect(isStoreSchedulerBusyError({ ...structural, priority: 'urgent' })).toBe(false);
    expect(isStoreSchedulerBusyError({ ...structural, operation: undefined })).toBe(false);
    expect(isStoreSchedulerBusyError({ code: 'STORE_SCHEDULER_BUSY' })).toBe(false);
  });

  it('records only the three oldest active operations without exposing them in the error message', async () => {
    vi.useFakeTimers();
    const diagnosticSink = vi.fn();
    let now = 0;
    const releases: Array<() => void> = [];
    try {
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 4,
        ackReservedSlots: 0,
        healthReservedSlots: 0,
        normalReservedSlots: 0,
        backgroundReservedSlots: 0,
        queueLimits: 1,
        queueWaitTimeoutMs: 20,
        now: () => now,
        timeoutDiagnosticSink: diagnosticSink,
      });
      const blockers = ['oldest', 'second', 'third', 'newest'].map((operation) => {
        const task = scheduler.run('normal', operation, () => new Promise<void>((resolve) => {
          releases.push(resolve);
        }));
        now += 10;
        return task;
      });
      const expired = scheduler.run('normal', 'waiting', async () => undefined);
      const expiredOutcome = expired.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      now += 20;
      await vi.advanceTimersByTimeAsync(20);
      const error = await expiredOutcome;
      expect(isStoreSchedulerBusyError(error)).toBe(true);
      if (!isStoreSchedulerBusyError(error)) throw new Error('Expected scheduler busy error');
      const diagnostic = diagnosticSink.mock.calls[0]?.[0];
      expect(diagnostic.activeAtTimeout.map((active: { operation: string }) => active.operation)).toEqual([
        'oldest', 'second', 'third',
      ]);
      expect(diagnostic.activeAtTimeout.map((active: { oldestAgeMs: number }) => active.oldestAgeMs))
        .toEqual([60, 50, 40]);
      expect(error.message).not.toContain('oldest');
      expect(error).not.toHaveProperty('activeAtTimeout');
      expect(diagnosticSink).toHaveBeenCalledWith(expect.objectContaining({
        waiting: { priority: 'normal', operation: 'waiting' },
      }));
      releases.forEach((release) => release());
      await Promise.all(blockers);
    } finally {
      releases.forEach((release) => release());
      vi.useRealTimers();
    }
  });

  it('accepts optional string messages while retaining prototype-free copies without messages', () => {
    const original = new StoreSchedulerBusyError('queue_full', 'normal', 'query');
    const copied = { ...original };
    expect(copied).not.toHaveProperty('message');
    expect(isStoreSchedulerBusyError(copied)).toBe(true);
    for (const message of [undefined, '', original.message]) {
      expect(isStoreSchedulerBusyError({ ...copied, message })).toBe(true);
    }
  });

  it.each([null, 42, { detail: 'not a message' }])(
    'rejects malformed optional message metadata (%j)',
    (message) => {
      const copied = { ...new StoreSchedulerBusyError('queue_full', 'normal', 'query') };
      expect(isStoreSchedulerBusyError({ ...copied, message })).toBe(false);
    },
  );

  it.each(['sink', 'async-sink', 'snapshot'] as const)(
    'still rejects and clears queue pressure when diagnostic %s fails', async (failure) => {
      vi.useFakeTimers();
      const diagnosticSink = vi.fn(() => {
        if (failure === 'sink') throw new Error('logger unavailable');
        if (failure === 'async-sink') return Promise.reject(new Error('async logger unavailable'));
      });
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 1,
        ackReservedSlots: 0,
        healthReservedSlots: 0,
        backgroundReservedSlots: 0,
        queueLimits: 1,
        queueWaitTimeoutMs: 20,
        timeoutDiagnosticSink: diagnosticSink,
      });
      let release: (() => void) | undefined;
      const blocker = scheduler.run('normal', 'active.private-work', () => new Promise<void>((resolve) => {
        release = resolve;
      }));
      const expired = scheduler.run('normal', 'waiting.read', async () => undefined);
      const expiredOutcome = expired.then(
        () => undefined,
        (error: unknown) => error,
      );
      const snapshot = failure === 'snapshot'
        ? vi.spyOn(scheduler, 'getBackpressureSnapshot').mockImplementation(() => {
          throw new Error('snapshot unavailable');
        })
        : undefined;
      try {
        await vi.advanceTimersByTimeAsync(20);
        const error = await expiredOutcome;
        expect(error).toMatchObject({
          code: 'STORE_SCHEDULER_BUSY',
          reason: 'queue_wait_timeout',
          outcome: 'not_started',
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(diagnosticSink).toHaveBeenCalledTimes(failure === 'snapshot' ? 0 : 1);
        snapshot?.mockRestore();
        expect(scheduler.snapshot.normalQueued).toBe(0);
        expect(scheduler.getBackpressureSnapshot().totals.queued).toBe(0);
        release?.();
        await blocker;
        await expect(scheduler.run('normal', 'recovered.read', async () => 'ok')).resolves.toBe('ok');
      } finally {
        snapshot?.mockRestore();
        release?.();
        await blocker;
        vi.useRealTimers();
      }
    },
  );
});
