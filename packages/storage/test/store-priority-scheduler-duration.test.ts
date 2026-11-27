import { describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';

describe('store execution timing', () => {
  it('separates queued time from execution and records successful and failed normal work', async () => {
    const samples: Array<{ name: string; value: number; attributes: Record<string, unknown> }> = [];
    const instrument = (name: string) => ({
      record: (value: number, attributes: Record<string, unknown> = {}) => {
        samples.push({ name, value, attributes });
      },
      add: () => {},
    });
    metrics.setGlobalMeterProvider({ getMeter: () => ({
      createGauge: instrument, createHistogram: instrument,
      createCounter: instrument, createUpDownCounter: instrument,
    }) } as never);
    rebuildMetrics();
    let now = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 1, ackReservedSlots: 0, healthReservedSlots: 0,
      normalReservedSlots: 0, backgroundReservedSlots: 0, now: () => now,
    });
    try {
      const first = scheduler.run('normal', 'publisher.claim', async () => { await gate; });
      const second = scheduler.run('normal', 'publisher.retry', async () => {
        now = 75;
        throw new Error('store unavailable');
      });
      const rejection = expect(second).rejects.toThrow('store unavailable');
      now = 50;
      release();
      await first;
      await rejection;
      expect(samples.filter((sample) => sample.name === 'dkg.store.scheduler_queue_wait_ms')).toEqual([
        { name: 'dkg.store.scheduler_queue_wait_ms', value: 0, attributes: { priority: 'normal', operation: 'publisher.claim' } },
        { name: 'dkg.store.scheduler_queue_wait_ms', value: 50, attributes: { priority: 'normal', operation: 'publisher.retry' } },
      ]);
      expect(samples.filter((sample) => sample.name === 'dkg.store.scheduler_operation_duration_ms')).toEqual([
        { name: 'dkg.store.scheduler_operation_duration_ms', value: 50, attributes: { priority: 'normal', operation: 'publisher.claim', outcome: 'ok' } },
        { name: 'dkg.store.scheduler_operation_duration_ms', value: 25, attributes: { priority: 'normal', operation: 'publisher.retry', outcome: 'error' } },
      ]);
    } finally {
      release();
      metrics.disable();
      rebuildMetrics();
    }
  });
});
