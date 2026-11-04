import { describe, expect, it, vi } from 'vitest';
import { createAsyncAdmissionDiagnosticTrace, getMetrics } from '@origintrail-official/dkg-core';
import { StorePriorityScheduler, withoutDefaultStoreWorkPriority } from '../src/store-priority-scheduler.js';
import type { StoreSchedulerTimeoutDiagnostic } from '../src/store-scheduler-timeout-diagnostics.js';

describe('store timeout admission correlation', () => {
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
      for (const trace of [...active, waiting]) {
        expect(JSON.stringify(await error)).not.toContain(trace.requestId);
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

  it('does not attach the waking request to detached long-lived work', async () => {
    const trace = createAsyncAdmissionDiagnosticTrace('share_async');
    const { currentAsyncAdmissionDiagnosticContext } = await import('@origintrail-official/dkg-core');
    await trace.run('enqueue', () => withoutDefaultStoreWorkPriority(async () => {
      await Promise.resolve();
      expect(currentAsyncAdmissionDiagnosticContext()).toBeUndefined();
    }));
  });
});
