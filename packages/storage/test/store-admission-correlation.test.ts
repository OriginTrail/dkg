import { describe, expect, it, vi } from 'vitest';
import { createAsyncAdmissionDiagnosticTrace, getMetrics } from '@origintrail-official/dkg-core';
import { StorePriorityScheduler, StoreSchedulerBusyError, activeDefaultStoreWorkPriority, withDefaultStoreWorkPriority, withoutDefaultStoreWorkPriority } from '../src/store-priority-scheduler.js';
import type { StoreSchedulerTimeoutDiagnostic } from '../src/store-scheduler-timeout-diagnostics.js';

function expectPrivateError(error: Error, requestId: string) {
  expect(error.message).not.toContain(requestId); // Error.message is not enumerable but reaches HTTP responses.
  expect(JSON.stringify(error)).not.toContain(requestId);
}

describe('store timeout admission correlation', () => {
  it('detects a request ID appended only to the non-enumerable public error message', () => {
    const { requestId } = createAsyncAdmissionDiagnosticTrace('publish_async');
    const contaminated = new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'blazegraph.query');
    contaminated.message += ` ${requestId}`;
    expect(JSON.stringify(contaminated)).not.toContain(requestId);
    expect(() => expectPrivateError(contaminated, requestId)).toThrow();
  });

  it('links waiting and at most three active admissions without changing public errors, metrics or pressure', async () => {
    vi.useFakeTimers();
    const events: StoreSchedulerTimeoutDiagnostic[] = [];
    const metrics = vi.spyOn(getMetrics().storeSchedulerQueueWaitMs, 'record');
    const releases: Array<() => void> = [];
    const tasks: Promise<unknown>[] = [];
    let now = 0;
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 4, ackReservedSlots: 0, healthReservedSlots: 0,
      normalReservedSlots: 0, backgroundReservedSlots: 0, queueWaitTimeoutMs: 20,
      now: () => now, timeoutDiagnosticSink: (event) => { events.push(event); },
    });
    const active = Array.from({ length: 4 }, () => createAsyncAdmissionDiagnosticTrace('publish_async'));
    try {
      for (const trace of active) {
        tasks.push(trace.run('intent_resolution', () => scheduler.run('normal', 'blazegraph.query',
          () => new Promise<void>((resolve) => { releases.push(resolve); }))));
        now += 10;
      }
      const waiting = createAsyncAdmissionDiagnosticTrace('publish_async');
      const rejected = waiting.run('snapshot_preflight', () => scheduler.run('normal', 'blazegraph.query', async () => 'unused'));
      const error = rejected.catch((value: unknown) => value);
      now += 20;
      await vi.advanceTimersByTimeAsync(20);
      expect(await error).toMatchObject({ code: 'STORE_SCHEDULER_BUSY', reason: 'queue_wait_timeout', outcome: 'not_started' });
      expect(events[0]?.waiting.admission).toEqual({ requestId: waiting.requestId, route: 'publish_async', phase: 'snapshot_preflight' });
      expect(events[0]?.activeAdmissions?.map((entry) => [entry.requestId, entry.queueWaitMs, entry.activeAgeMs]))
        .toEqual(active.slice(0, 3).map((trace, i) => [trace.requestId, 0, 60 - i * 10]));
      const failure = await error;
      if (!(failure instanceof Error)) throw new Error('Expected scheduler Error');
      for (const trace of [...active, waiting]) {
        expectPrivateError(failure, trace.requestId);
        expect(JSON.stringify(scheduler.getBackpressureSnapshot())).not.toContain(trace.requestId);
        expect(JSON.stringify(metrics.mock.calls)).not.toContain(trace.requestId);
      }
      // A fresh request ID cannot bypass the existing per-operation warning gate.
      const again = createAsyncAdmissionDiagnosticTrace('share_async').run('enqueue',
        () => scheduler.run('normal', 'blazegraph.query', async () => undefined)).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(20);
      await again;
      expect(events).toHaveLength(1);
    } finally {
      releases.forEach((release) => release());
      await Promise.all(tasks);
      metrics.mockRestore();
      vi.useRealTimers();
    }
  });

  it('removes successful and rejected admissions before reporting replacement blockers', async () => {
    vi.useFakeTimers();
    const events: StoreSchedulerTimeoutDiagnostic[] = [];
    const releases: Array<() => void> = [];
    const tasks: Promise<unknown>[] = [];
    let now = 0;
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2, ackReservedSlots: 0, healthReservedSlots: 0,
      normalReservedSlots: 0, backgroundReservedSlots: 0, queueWaitTimeoutMs: 20,
      now: () => now, timeoutDiagnosticSink: (event) => { events.push(event); },
    });
    const settled = [createAsyncAdmissionDiagnosticTrace('publish_async'), createAsyncAdmissionDiagnosticTrace('share_async')];
    try {
      for (const [i, trace] of settled.entries()) {
        tasks.push(trace.run('enqueue', () => scheduler.run('normal', 'blazegraph.query',
          () => new Promise<void>((resolve, reject) => { releases.push(() => i === 0 ? resolve() : reject(new Error('work failed'))); }))));
      }
      const results = Promise.allSettled(tasks);
      const timeout = () => scheduler.run('normal', 'blazegraph.query', async () => 'unused').catch(() => undefined);
      const first = timeout();
      now += 20;
      await vi.advanceTimersByTimeAsync(20);
      await first;
      expect(events[0]?.activeAdmissions?.map((entry) => entry.requestId)).toEqual(settled.map((trace) => trace.requestId));
      releases.forEach((release) => release());
      expect((await results).map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
      await vi.advanceTimersByTimeAsync(0); // Let scheduler finally-cleanup finish before replacing the work.
      const active = settled.map(() => createAsyncAdmissionDiagnosticTrace('publish_async'));
      for (const trace of active) {
        tasks.push(trace.run('snapshot_preflight', () => scheduler.run('normal', 'blazegraph.query',
          () => new Promise<void>((resolve) => { releases.push(resolve); }))));
      }
      now += 60_000; // Permit a second warning for the same operation.
      await vi.advanceTimersByTimeAsync(60_000);
      const second = timeout();
      now += 20;
      await vi.advanceTimersByTimeAsync(20);
      await second;
      expect(events).toHaveLength(2);
      expect(events[1]?.activeAdmissions?.map((entry) => entry.requestId)).toEqual(active.map((trace) => trace.requestId));
      for (const trace of settled) expect(JSON.stringify(events[1])).not.toContain(trace.requestId);
    } finally {
      releases.forEach((release) => release());
      await Promise.allSettled(tasks);
      vi.useRealTimers();
    }
  });

  it('clears only priority while preserving independent diagnostic context', async () => {
    const trace = createAsyncAdmissionDiagnosticTrace('share_async');
    const { currentAsyncAdmissionDiagnosticContext } = await import('@origintrail-official/dkg-core');
    await trace.run('enqueue', () => withDefaultStoreWorkPriority('background', async () => {
      await withoutDefaultStoreWorkPriority(async () => {
        await Promise.resolve();
        expect(activeDefaultStoreWorkPriority()).toBeUndefined();
        expect(currentAsyncAdmissionDiagnosticContext()?.requestId).toBe(trace.requestId);
      });
      expect(activeDefaultStoreWorkPriority()).toBe('background');
      expect(currentAsyncAdmissionDiagnosticContext()?.requestId).toBe(trace.requestId);
    }));
  });
});
