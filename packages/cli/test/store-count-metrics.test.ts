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
  it('coalesces concurrent snapshot reads into one exact background reconciliation', async () => {
    const query = vi.fn(async () => countRow('"5"^^<http://www.w3.org/2001/XMLSchema#integer>'));
    const metrics = createStoreCountMetrics(query);
    const [first, second] = await Promise.all([
      metrics.getStoreCountSnapshot(), metrics.getStoreCountSnapshot(),
    ]);
    expect(first).toEqual({
      totalTriples: 5, totalKCs: 5, totalKAs: 5, confirmedKCs: 5, tentativeKCs: 5,
    });
    expect(second).toBe(first);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual({
      source: 'daemon.metrics.storeCountReconcile',
      priority: 'background',
    });
  });

  it('probes health and awaits a stale reconciliation before releasing the collected snapshot', async () => {
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
    expect((await metrics.getStoreCountSnapshot()).totalTriples).toBe(5);
    now += 100;
    value = 6;
    const refresh = metrics.getStoreCountSnapshot();
    await vi.waitFor(() => expect(reconciliations).toBe(2));
    expect(query.mock.calls.some(([sparql]) => sparql === 'ASK {}')).toBe(true);
    releaseRefresh();
    expect((await refresh).totalTriples).toBe(6);
  });

  it('never serves a maintained snapshot when the health ASK is denied', async () => {
    let now = 1_000;
    let authorized = true;
    const query = vi.fn(async (sparql: string) => {
      if (sparql === 'ASK {}') {
        return { type: 'boolean' as const, value: authorized };
      }
      return countRow('5');
    });
    const metrics = createStoreCountMetrics(query, {
      now: () => now,
      healthIntervalMs: 10,
    });
    expect((await metrics.getStoreCountSnapshot()).totalTriples).toBe(5);
    now += 10;
    authorized = false;
    await expect(metrics.getStoreCountSnapshot()).rejects.toThrow('health probe was denied');
  });

  it('suppresses failed reconciliation retries and recovers with an updated snapshot', async () => {
    let now = 1_000;
    let value = 5;
    let failReconciliation = false;
    let reconciliations = 0;
    const query = vi.fn(async (sparql: string) => {
      if (sparql === 'ASK {}') return { type: 'boolean' as const, value: true };
      reconciliations += 1;
      if (failReconciliation) throw new Error('count timeout');
      return countRow(String(value));
    });
    const metrics = createStoreCountMetrics(query, {
      now: () => now,
      reconcileIntervalMs: 100,
      healthIntervalMs: 10,
    });
    expect((await metrics.getStoreCountSnapshot()).totalTriples).toBe(5);

    now += 100;
    failReconciliation = true;
    await expect(metrics.getStoreCountSnapshot()).rejects.toThrow('count timeout');
    expect(reconciliations).toBe(2);
    await expect(metrics.getStoreCountSnapshot()).rejects.toThrow('count timeout');
    expect(reconciliations).toBe(2);

    now += 10;
    failReconciliation = false;
    value = 6;
    expect((await metrics.getStoreCountSnapshot()).totalTriples).toBe(6);
    expect(reconciliations).toBe(3);
  });
});
