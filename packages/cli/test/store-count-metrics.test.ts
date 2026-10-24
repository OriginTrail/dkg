import { describe, expect, it, vi } from 'vitest';
import { createStoreCountMetrics } from '../src/daemon/metrics-queries.js';

const countRow = (value: string) => ({ bindings: [{
  totalTriples: value,
  totalKCs: value,
  totalKAs: value,
  confirmedKCs: value,
  tentativeKCs: value,
}] });

describe('createStoreCountMetrics snapshot lifecycle', () => {
  it('coalesces every getter into one exact background reconciliation', async () => {
    const query = vi.fn(async () => countRow('"5"^^<http://www.w3.org/2001/XMLSchema#integer>'));
    const metrics = createStoreCountMetrics(query);
    expect(await Promise.all([metrics.getTotalTriples(), metrics.getTotalKCs(), metrics.getTotalKAs(),
      metrics.getConfirmedKCs(), metrics.getTentativeKCs()])).toEqual([5, 5, 5, 5, 5]);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual({
      source: 'daemon.metrics.storeCountReconcile',
      priority: 'background',
    });
  });

  it('serves the maintained snapshot, probes health, and reconciles stale data in background', async () => {
    let now = 1_000;
    let value = 5;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let reconciliations = 0;
    const query = vi.fn(async (sparql: string) => {
      if (sparql === 'ASK {}') return { type: 'boolean' as const, value: true };
      reconciliations += 1;
      if (reconciliations === 2) await refreshGate;
      return countRow(String(value));
    });
    const metrics = createStoreCountMetrics(query, {
      now: () => now,
      reconcileIntervalMs: 100,
      healthIntervalMs: 10,
    });
    expect(await metrics.getTotalTriples()).toBe(5);
    now += 100;
    value = 6;
    // The stale exact value is immediate; reconciliation is detached.
    expect(await metrics.getTotalTriples()).toBe(5);
    expect(query.mock.calls.some(([sparql]) => sparql === 'ASK {}')).toBe(true);
    releaseRefresh();
    await metrics.reconcileStoreCounts();
    expect(await metrics.getTotalTriples()).toBe(6);
  });

  it('never serves a maintained snapshot through a store outage', async () => {
    let now = 1_000;
    let healthy = true;
    const query = vi.fn(async (sparql: string) => {
      if (sparql === 'ASK {}') {
        if (!healthy) throw new Error('store unavailable');
        return { type: 'boolean' as const, value: true };
      }
      return countRow('5');
    });
    const metrics = createStoreCountMetrics(query, {
      now: () => now,
      healthIntervalMs: 10,
    });
    expect(await metrics.getTotalTriples()).toBe(5);
    now += 10;
    healthy = false;
    await expect(metrics.getTotalTriples()).rejects.toThrow('store unavailable');
  });
});
