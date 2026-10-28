// @vitest-environment happy-dom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatsDashboard } from '../src/components/StatsDashboard';
import * as api from '../src/api';
import type { LiveOpMetrics, SimulationRun } from '../src/store';
import { makeStore, mountUi, type MountedUi } from './ui-test-support';
vi.mock('../src/api');
vi.mock('../src/store', () => ({ useStore: () => store }));
let store = makeStore();
let ui: MountedUi;
const blank: api.MetricSnapshot = { ts: 0, cpu_percent: null, mem_used_bytes: null, mem_total_bytes: null, heap_used_bytes: null,
  uptime_seconds: null, peer_count: null, direct_peers: null, relayed_peers: null, context_graph_count: null,
  total_triples: null, total_kcs: null, total_kas: null, store_bytes: null, confirmed_kcs: null, tentative_kcs: null,
  rpc_latency_ms: null, rpc_healthy: null };
function metrics(overrides: Partial<api.MetricSnapshot> = {}): api.MetricSnapshot { return { ...blank, ...overrides }; }
async function mount() { ui = await mountUi(React.createElement(StatsDashboard)); }
async function update() { await ui.render(React.createElement(StatsDashboard)); }
async function tick(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
function card(label: string) {
  const card = Array.from(ui.container.querySelectorAll('.stat-card')).find(c => c.querySelector('.stat-card-label')?.textContent === label);
  expect(card).toBeDefined(); return card!;
}
function value(label: string) { return card(label).querySelector('.stat-card-value')?.textContent; }
function live(total: number, success: number, timestamps: number[] = []): LiveOpMetrics {
  return { total, success, errors: total - success, recentTimestamps: timestamps,
    byType: { publish: { total, success, errors: total - success, totalDurationMs: 2000, successDurationMs: 200,
      phaseTotals: { store: 500, chain: 1000 }, phaseCounts: { store: 2, chain: 2 } } } };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); store = makeStore();
  vi.mocked(api.fetchNodeMetrics).mockResolvedValue(metrics());
  vi.mocked(api.fetchNodeStatus).mockResolvedValue(store.state.nodes[0].status!);
});
afterEach(() => { ui?.unmount(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('node metrics aggregation and polling', () => {
  it('uses maximum replicated counts, summed storage, average peers and per-node chart values', async () => {
    vi.mocked(api.fetchNodeMetrics).mockImplementation(async id => metrics({ total_triples: id === 1 ? 1500 : 2000,
      total_kcs: id === 1 ? 8 : 10, total_kas: id === 1 ? 20 : 30, confirmed_kcs: 7, tentative_kcs: 3,
      store_bytes: id === 1 ? 1024 : 2048, peer_count: id === 1 ? 2 : 4, cpu_percent: id === 1 ? 40 : 80,
      mem_used_bytes: id * 1024 * 1024, heap_used_bytes: id * 512 * 1024 }));
    vi.mocked(api.fetchNodeStatus).mockResolvedValue({ ...store.state.nodes[0].status!, storeBackend: 'oxigraph' });
    await mount();
    expect(vi.mocked(api.fetchNodeMetrics).mock.calls).toEqual([[1], [2]]);
    expect(value('Triples (max node)')).toBe('2.0K'); expect(card('Triples (max node)').textContent).toContain('3.5K total');
    expect(value('Knowledge Collections')).toBe('10'); expect(card('Knowledge Collections').textContent).toContain('7 confirmed / 3 tentative');
    expect(value('Knowledge Assets')).toBe('30'); expect(value('Store Size')).toBe('3.0 KB'); expect(value('Avg Peers / Node')).toBe('3');
    expect(value('Avg CPU')).toBe('60.0%'); expect(value('Total RSS Memory')).toBe('3 MB');
    expect(ui.container.querySelectorAll('.node-stats-row.offline')).toHaveLength(1);
    expect(ui.container.querySelector('.backend-badge')?.textContent).toBe('oxigraph');
    const cpu = ui.container.querySelectorAll('.stats-chart-card')[0].querySelectorAll('rect');
    expect(Array.from(cpu).map(r => r.getAttribute('height'))).toEqual(['16', '32']);
  });
  it('uses latest online nodes, handles unavailable metrics, and cancels polling on unmount', async () => {
    await mount();
    vi.mocked(api.fetchNodeMetrics).mockRejectedValue(new Error('offline'));
    vi.mocked(api.fetchNodeStatus).mockRejectedValue(new Error('offline'));
    store.state.nodes = store.state.nodes.map(n => ({ ...n, online: n.id === 3 })); await update();
    await tick(2999); expect(api.fetchNodeMetrics).toHaveBeenCalledTimes(2);
    await tick(1); expect(api.fetchNodeMetrics).toHaveBeenLastCalledWith(3);
    expect(value('Store Size')).toBe('0 B'); expect(value('Nodes Online')).toBe('1/3');
    expect(ui.container.textContent).not.toContain('System Resources (per node)');
    expect(Array.from(ui.container.querySelectorAll('.node-stats-row')).at(-1)?.textContent).toContain('—---0 B');
    const calls = vi.mocked(api.fetchNodeMetrics).mock.calls.length;
    ui.unmount(); await tick(10000); expect(api.fetchNodeMetrics).toHaveBeenCalledTimes(calls);
  });
  it('does not overlap unresolved polls', async () => {
    let resolve!: (m: api.MetricSnapshot) => void;
    vi.mocked(api.fetchNodeMetrics).mockReturnValue(new Promise(done => { resolve = done; }));
    await mount(); await tick(9000); expect(api.fetchNodeMetrics).toHaveBeenCalledTimes(2);
    await act(async () => resolve(metrics({ store_bytes: 512 })));
    expect(value('Store Size')).toBe('1.0 KB');
    await tick(3000); expect(api.fetchNodeMetrics).toHaveBeenCalledTimes(4);
  });
  it('flashes increases/decreases, then clears card and row flashes', async () => {
    vi.mocked(api.fetchNodeMetrics).mockResolvedValue(metrics({ total_triples: 1, store_bytes: 1, cpu_percent: 90 }));
    await mount(); expect(value('Avg CPU')).toBe('90.0%');
    vi.mocked(api.fetchNodeMetrics).mockResolvedValue(metrics({ total_triples: 2_000_000, store_bytes: 1024 ** 3 }));
    await tick(3000);
    expect(value('Triples (max node)')).toBe('2.0M'); expect(value('Store Size')).toBe('2.0 GB');
    expect(card('Triples (max node)').classList.contains('flash-up')).toBe(true);
    expect(ui.container.querySelectorAll('.row-flash')).toHaveLength(2);
    await tick(700); expect(ui.container.querySelectorAll('.row-flash, .flash-up')).toHaveLength(0);
    vi.mocked(api.fetchNodeMetrics).mockResolvedValue(metrics({ total_triples: 1, store_bytes: 512 * 1024 }));
    await tick(2300); expect(value('Store Size')).toBe('1.0 MB');
    expect(card('Triples (max node)').classList.contains('flash-down')).toBe(true);
    await tick(700); expect(card('Triples (max node)').classList.contains('flash-down')).toBe(false);
  });
});

describe('live operation metrics and run history', () => {
  it('reports successful latency separately from all-attempt latency and computes phase overhead', async () => {
    store.state.liveMetrics = live(2, 1, [Date.now() - 1000, Date.now()]);
    await mount();
    expect(value('Total Ops')).toBe('2'); expect(value('Throughput')).toBe('2.0/s'); expect(value('Overall Success Rate')).toBe('50.0%');
    const row = ui.container.querySelector('.per-op-row')!;
    expect(row.children[5].textContent).toBe('1.00s'); // 2000 / 2 attempts
    expect(row.children[6].textContent).toBe('200ms'); // 200 / 1 successful attempt
    expect(row.textContent).toContain('chain: 500ms'); expect(row.textContent).toContain('store: 250ms');
    expect(ui.container.textContent).toContain('overhead (HTTP + queue)');
    expect(Array.from(ui.container.querySelectorAll('.phase-bar-fill')).map(e => (e as HTMLElement).style.width)).toEqual(['50%', '25%', '25%']);
  });
  it.each([
    [[], '0.0/s'], [[-20000, -19999], '0.0/s'], [[-20000, 0], '0.1/s'],
    [[0, 0], '0.0/s'], [[-100, 0], '20.0/s'], [[-400, 0], '5.0/s'],
  ])('calculates rolling throughput from %j', async (timestamps, expected) => {
    store.state.liveMetrics = live(10, 10, (timestamps as number[]).map(offset => Date.now() + offset)); await mount();
    expect(value('Throughput')).toBe(expected); expect(value('Overall Success Rate')).toBe('100.0%');
  });
  it('handles zero-count and legacy per-type metrics without NaN or Infinity', async () => {
    store.state.liveMetrics = live(10, 8);
    store.state.liveMetrics.byType = {
      unknown: { total: 0, success: 0, errors: 0, totalDurationMs: 0, successDurationMs: 0, phaseTotals: { old: 0 }, phaseCounts: {} },
      query: { total: 10, success: 8, errors: 2, totalDurationMs: 10, successDurationMs: 8, phaseTotals: {}, phaseCounts: {} },
    };
    await mount(); expect(value('Overall Success Rate')).toBe('80.0%');
    expect(ui.container.textContent).not.toMatch(/NaN|Infinity/);
    expect(ui.container.querySelectorAll('.per-op-name')[0].textContent).toBe('query');
    expect(ui.container.textContent).not.toContain('overhead (HTTP + queue)');
  });
  it('selects immutable completed or active run metrics and falls back when a run is removed', async () => {
    const config: SimulationRun['config'] = { opCount: 10, opsPerSec: 2, concurrency: 3, kasPerPublish: 2, contextGraphId: 'team', enabledOps: ['query'] };
    const first: SimulationRun = { id: 'finished', name: 'Finished', startedAt: Date.now() - 120000, finishedAt: Date.now() - 60000, config, metrics: live(3, 3) };
    const second: SimulationRun = { id: 'active', name: 'Current', startedAt: Date.now() - 500, config, metrics: live(2, 2) };
    store.state.simulationRuns = [first, second]; store.state.liveMetrics = live(9, 9);
    await mount();
    const pills = () => Array.from(ui.container.querySelectorAll<HTMLButtonElement>('.sim-picker-pills button'));
    await act(async () => pills()[1].click());
    expect(value('Total Ops')).toBe('3'); expect(ui.container.querySelector('.sim-run-badge')?.textContent).toBe('Completed');
    expect(ui.container.querySelector('.sim-run-config')?.textContent).toContain('1.0m total');
    await act(async () => pills()[2].click()); expect(value('Total Ops')).toBe('2');
    expect(ui.container.querySelector('.sim-run-config')?.textContent).toContain('500ms so far');
    store.state.simulationRuns[1] = { ...second, startedAt: Date.now() - 2000 }; await update();
    expect(ui.container.querySelector('.sim-run-config')?.textContent).toContain('2.0s so far');
    await ui.click('All / Live'); expect(value('Total Ops')).toBe('9');
    await act(async () => pills()[2].click()); store.state.simulationRuns = [first]; await update();
    expect(value('Total Ops')).toBe('9');
  });
  it('shows only the most recent 50 error activities', async () => {
    store.state.activities = Array.from({ length: 55 }, (_, i) => ({ id: String(i), ts: Date.now(), type: 'query', sourceNode: 1, status: 'error', label: `failed-${i}`, detail: `reason-${i}` }));
    store.state.activities.unshift({ id: 'success', ts: Date.now(), type: 'query', sourceNode: 1, status: 'success', label: 'successful' });
    await mount();
    expect(ui.container.querySelectorAll('.error-row')).toHaveLength(50);
    expect(Array.from(ui.container.querySelectorAll('.error-detail')).map(e => e.textContent)).toEqual(Array.from({ length: 50 }, (_, i) => `reason-${i}`));
    expect(ui.container.querySelector('.errors-list')?.textContent).not.toContain('successful');
  });
});
