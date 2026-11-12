// @vitest-environment happy-dom
//
// Operations → Hardware: snapshots become per-unit chart rows and stat cards,
// and readings past a threshold show a warning or critical indicator (C7).
import React, { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  HW_THRESHOLDS,
  hardwareChartRow,
  hardwareLevels,
  latestHardwareReading,
  metricLevel,
  type MetricsSnapshot,
} from '../src/ui/pages/hardware-metrics.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const snap = (over: Partial<MetricsSnapshot> = {}): MetricsSnapshot => ({
  ts: Date.UTC(2026, 10, 3, 10, 0),
  cpu_percent: 20,
  mem_used_bytes: 2 * GB,
  mem_total_bytes: 10 * GB,
  heap_used_bytes: 300 * MB,
  disk_used_bytes: 10 * GB,
  disk_total_bytes: 100 * GB,
  peer_count: 5,
  rpc_latency_ms: 120,
  ...over,
});

describe('hardware levels', () => {
  it('turns CPU at 59 %, 61 % and 81 % into normal, warning and critical', () => {
    expect(HW_THRESHOLDS.cpu).toEqual([60, 80]);
    const cpu = (v: number) => hardwareLevels(latestHardwareReading([snap({ cpu_percent: v })])).cpu;
    expect([cpu(59), cpu(61), cpu(81)]).toEqual(['ok', 'warn', 'crit']);
    // Thresholds are exclusive: exactly at the line is still the lower level.
    expect([metricLevel(60, 60, 80), metricLevel(80, 60, 80)]).toEqual(['ok', 'warn']);
  });

  it('applies RAM and disk thresholds to their own percentages', () => {
    const levels = hardwareLevels(latestHardwareReading([snap({ mem_used_bytes: 8 * GB, disk_used_bytes: 90 * GB })]));
    expect(levels).toMatchObject({ mem: 'warn', disk: 'crit' });
  });

  it('marks no peers and slow RPC as critical, and an unavailable reading as no alarm', () => {
    expect(hardwareLevels(latestHardwareReading([snap({ peer_count: 0, rpc_latency_ms: 501 })]))).toMatchObject({ peers: 'crit', rpc: 'crit' });
    expect(hardwareLevels(latestHardwareReading([snap({ rpc_latency_ms: 500 })])).rpc).toBe('ok');
    const missing = hardwareLevels(latestHardwareReading([snap({ disk_total_bytes: null, disk_used_bytes: null, rpc_latency_ms: null })]));
    expect(missing).toMatchObject({ disk: 'ok', rpc: 'ok' });
    expect(hardwareLevels(null)).toEqual({ cpu: 'ok', mem: 'ok', disk: 'ok', peers: 'ok', rpc: 'ok' });
  });
});

describe('hardware chart rows', () => {
  it('plots RAM as a share of total memory, independently of heap usage', () => {
    const row = hardwareChartRow(snap({ mem_used_bytes: 8 * GB, mem_total_bytes: 10 * GB, heap_used_bytes: 900 * MB }), { hour: '2-digit' });
    expect(row.memPct).toBe(80);
    expect(row.heapMB).toBe(900);
    const lighterHeap = hardwareChartRow(snap({ mem_used_bytes: 8 * GB, mem_total_bytes: 10 * GB, heap_used_bytes: 50 * MB }), { hour: '2-digit' });
    expect(lighterHeap.memPct).toBe(80);
  });

  it('keeps every series in its own unit', () => {
    const row = hardwareChartRow(snap({ cpu_percent: 42.5, disk_used_bytes: 25 * GB, disk_total_bytes: 100 * GB, peer_count: 3, rpc_latency_ms: 210 }), { hour: '2-digit' });
    expect(row).toMatchObject({ cpu: 42.5, diskPct: 25, peers: 3, rpcMs: 210 });
    expect(Object.keys(row).sort()).toEqual(['cpu', 'diskPct', 'heapMB', 'memPct', 'peers', 'rpcMs', 'time']);
  });

  it('leaves unreported readings empty instead of plotting zero', () => {
    const row = hardwareChartRow(snap({ disk_total_bytes: null, disk_used_bytes: null, mem_total_bytes: null, rpc_latency_ms: null }), { hour: '2-digit' });
    expect(row).toMatchObject({ diskPct: null, memPct: null, rpcMs: null });
    expect(latestHardwareReading([])).toBeNull();
  });
});

// The rendered tab, with the metrics API answering controlled snapshots.
const metrics = vi.hoisted(() => ({ snapshots: [] as MetricsSnapshot[] }));
vi.mock('../src/ui/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/api.js')>()),
  fetchMetricsHistory: vi.fn(async () => ({ snapshots: metrics.snapshots })),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Hardware tab', () => {
  let root: Root;
  let container: HTMLDivElement;
  let HardwareTab: typeof import('../src/ui/pages/Operations.js').HardwareTab;
  // The page pulls in the chart library; load it once, outside the test timeouts.
  beforeAll(async () => { ({ HardwareTab } = await import('../src/ui/pages/Operations.js')); }, 60_000);
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  async function render(snapshots: MetricsSnapshot[]) {
    metrics.snapshots = snapshots;
    await act(async () => { root.render(React.createElement(HardwareTab)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  /** The stat card whose label is `label`: its value line and indicator. */
  const card = (label: string) => {
    const el = [...container.querySelectorAll('.ds-card')].find(c => c.firstElementChild?.textContent === label)!;
    const indicator = el.querySelector('[aria-label="warning"], [aria-label="critical"]')?.getAttribute('aria-label') ?? 'normal';
    return { text: el.textContent ?? '', indicator };
  };

  it('shows normal, warning and critical indicators on the cards', async () => {
    await render([snap(), snap({ cpu_percent: 81, mem_used_bytes: 8 * GB, peer_count: 0, rpc_latency_ms: 900 })]);
    expect(card('CPU')).toMatchObject({ indicator: 'critical' });
    expect(card('CPU').text).toContain('81.0%');
    expect(card('RAM')).toMatchObject({ indicator: 'warning' });
    expect(card('RAM').text).toContain('8 / 10 GB');
    expect(card('RAM').text).toContain('80% used');
    expect(card('Disk')).toMatchObject({ indicator: 'normal' });
    expect(card('Peers')).toMatchObject({ indicator: 'critical' });
    expect(card('RPC Latency')).toMatchObject({ indicator: 'critical' });
    expect(container.textContent).not.toContain('History charts appear after a second snapshot');
  });

  it('says a reading is unavailable rather than showing it as healthy', async () => {
    await render([snap({ disk_total_bytes: null, disk_used_bytes: null, rpc_latency_ms: null })]);
    expect(card('Disk').text).toContain('n/a');
    expect(card('Disk').text).toContain('not configured');
    expect(card('Disk').indicator).toBe('normal');
    expect(card('RPC Latency').text).toContain('—');
    // One snapshot is not yet a history.
    expect(container.textContent).toContain('History charts appear after a second snapshot');
  });

  it('waits without alarms before the first snapshot', async () => {
    await render([]);
    for (const label of ['CPU', 'RAM', 'Heap', 'Disk', 'Peers', 'RPC Latency']) {
      expect(card(label).indicator, label).toBe('normal');
      expect(card(label).text, label).toContain('—');
    }
  });
});
