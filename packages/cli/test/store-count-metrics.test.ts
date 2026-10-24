import { describe, expect, it, vi } from 'vitest';
import {
  MetricsCollector,
  type MetricsSource,
} from '@origintrail-official/dkg-node-ui';
import { createStoreCountMetrics } from '../src/daemon/metrics-queries.js';

const COLLECTOR_CACHE_TTL_MS = 30_000;
const countRow = (value: string) => ({ bindings: [{
  totalTriples: value,
  totalKCs: value,
  totalKAs: value,
  confirmedKCs: value,
  tentativeKCs: value,
}] });
const askRow = (value: boolean) => ({ bindings: [{ result: String(value) }] });

describe('createStoreCountMetrics snapshot lifecycle', () => {
  it('reconciles once, validates retained counts, and awaits an expired replacement', async () => {
    let now = 1_000;
    let value = 5;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let reconciliations = 0;
    const query = vi.fn(async (sparql: string) => {
      if (sparql === 'ASK {}') return askRow(true);
      reconciliations += 1;
      if (reconciliations === 2) await refreshGate;
      return countRow(String(value));
    });
    const metrics = createStoreCountMetrics(query, {
      now: () => now,
      reconcileIntervalMs: 100,
    });

    expect((await metrics.getStoreCountSnapshot()).totalTriples).toBe(5);
    expect(query).toHaveBeenCalledTimes(1);
    expect((await metrics.getStoreCountSnapshot()).totalTriples).toBe(5);
    expect(query.mock.calls[1]?.[0]).toBe('ASK {}');

    now += 100;
    value = 6;
    const refresh = metrics.getStoreCountSnapshot();
    await vi.waitFor(() => expect(reconciliations).toBe(2));
    let settled = false;
    void refresh.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseRefresh();
    expect((await refresh).totalTriples).toBe(6);
  });

  it('invalidates retained counts after a denied health check and retries without local backoff', async () => {
    let authorized = true;
    let value = 5;
    let reconciliations = 0;
    const query = vi.fn(async (sparql: string) => {
      if (sparql === 'ASK {}') return askRow(authorized);
      reconciliations += 1;
      return countRow(String(value));
    });
    const metrics = createStoreCountMetrics(query);

    expect((await metrics.getStoreCountSnapshot()).totalTriples).toBe(5);
    authorized = false;
    await expect(metrics.getStoreCountSnapshot()).rejects.toThrow('health probe was denied');
    authorized = true;
    value = 6;
    expect((await metrics.getStoreCountSnapshot()).totalTriples).toBe(6);
    expect(reconciliations).toBe(2);
  });

  it('leaves short-window caching, coalescing, and failure backoff to the collector', async () => {
    let now = 1_000;
    let value = 5;
    let authorized = true;
    let reconciliations = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const query = vi.fn(async (sparql: string) => {
      if (sparql === 'ASK {}') return askRow(authorized);
      reconciliations += 1;
      if (reconciliations === 2) await refreshGate;
      return countRow(String(value));
    });
    const counts = createStoreCountMetrics(query, {
      now: () => now,
      reconcileIntervalMs: 100,
    });
    const source: MetricsSource = {
      getPeerCount: () => 0,
      getDirectPeerCount: () => 0,
      getRelayedPeerCount: () => 0,
      getMeshPeerCount: () => 0,
      getContextGraphCount: async () => 2,
      getStoreCountSnapshot: counts.getStoreCountSnapshot,
      getStoreBytes: async () => null,
      getRpcLatencyMs: async () => 0,
      isRpcHealthy: async () => true,
    };
    const persisted: Array<{ total_triples: number | null }> = [];
    const db = {
      insertSnapshot(snapshot: { total_triples: number | null }) {
        persisted.push(snapshot);
      },
    } as unknown as ConstructorParameters<typeof MetricsCollector>[0];
    const collector = new MetricsCollector(
      db,
      source,
      undefined,
      () => true,
      { cacheClock: () => now },
    );

    expect((await collector.collectAndStore()).total_triples).toBe(5);
    expect(reconciliations).toBe(1);
    value = 6;
    now += COLLECTOR_CACHE_TTL_MS - 1;
    expect((await collector.collect()).total_triples).toBe(5);
    expect(query).toHaveBeenCalledTimes(1);

    now += 101;
    const refresh = collector.collectAndStore();
    await vi.waitFor(() => expect(reconciliations).toBe(2));
    expect(persisted).toHaveLength(1);
    releaseRefresh();
    expect((await refresh).total_triples).toBe(6);
    expect(persisted.at(-1)?.total_triples).toBe(6);

    now += COLLECTOR_CACHE_TTL_MS;
    authorized = false;
    expect((await collector.collect()).total_triples).toBeNull();
    const callsAfterFailure = query.mock.calls.length;
    authorized = true;
    value = 7;
    now += COLLECTOR_CACHE_TTL_MS - 1;
    expect((await collector.collect()).total_triples).toBeNull();
    expect(query).toHaveBeenCalledTimes(callsAfterFailure);

    now += 1;
    expect((await collector.collect()).total_triples).toBe(7);
    expect(reconciliations).toBe(3);
  });
});
