/**
 * Hardware view model (Operations → Hardware): metric snapshots from
 * `/api/metrics/history` → chart rows and the latest readings, plus the
 * thresholds that turn a reading amber (warning) or red (critical).
 *
 * C7: one colour per metric; amber / red only past a threshold, with ⚠.
 * Each chart has one unit: the three percentages share a 0–100 scale; heap,
 * peers and RPC latency get their own charts. A reading that isn't reported
 * (no disk configured, no RPC measurement) is null, never 0, so a chart shows
 * a gap and a card says unavailable instead of a healthy-looking zero.
 */

export interface MetricsSnapshot {
  ts: number | string;
  cpu_percent?: number | null;
  mem_used_bytes?: number | null;
  mem_total_bytes?: number | null;
  heap_used_bytes?: number | null;
  disk_used_bytes?: number | null;
  disk_total_bytes?: number | null;
  peer_count?: number | null;
  rpc_latency_ms?: number | null;
}

export type MetricLevel = 'ok' | 'warn' | 'crit';

/** Warning / critical thresholds, shared by the cards and the chart reference lines. */
export const HW_THRESHOLDS = {
  cpu: [60, 80],
  mem: [70, 85],
  disk: [70, 85],
  rpcMs: 500,
} as const;

/** Above `crit` is critical, above `warn` a warning; a missing reading is not an alarm. */
export function metricLevel(v: number | null | undefined, warn: number, crit: number): MetricLevel {
  if (v == null) return 'ok';
  return v > crit ? 'crit' : v > warn ? 'warn' : 'ok';
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const pctOf = (used: number | null | undefined, total: number | null | undefined): number | null =>
  total ? Math.round(((used ?? 0) / total) * 100) : null;

/** One chart row per snapshot, every series in its own unit. */
export interface HardwareChartRow {
  time: string;
  cpu: number;
  memPct: number | null;
  diskPct: number | null;
  heapMB: number;
  peers: number;
  rpcMs: number | null;
}

export function hardwareChartRow(s: MetricsSnapshot, timeFmt: Intl.DateTimeFormatOptions): HardwareChartRow {
  return {
    time: new Date(s.ts).toLocaleString(undefined, timeFmt),
    cpu: s.cpu_percent ?? 0,
    // RAM is a share of total memory, independent of the Node.js heap.
    memPct: pctOf(s.mem_used_bytes, s.mem_total_bytes),
    diskPct: pctOf(s.disk_used_bytes, s.disk_total_bytes),
    heapMB: s.heap_used_bytes ? +(s.heap_used_bytes / MB).toFixed(1) : 0,
    peers: s.peer_count ?? 0,
    rpcMs: s.rpc_latency_ms ?? null,
  };
}

/** The latest readings, for the stat cards. */
export interface HardwareReading {
  cpu: number;
  memUsedGB: number;
  memTotalGB: number;
  memPct: number | null;
  heapMB: number;
  diskUsedGB: number | null;
  diskTotalGB: number | null;
  diskPct: number | null;
  peers: number;
  rpcMs: number | null;
}

export function latestHardwareReading(snapshots: readonly MetricsSnapshot[]): HardwareReading | null {
  const s = snapshots[snapshots.length - 1];
  if (!s) return null;
  return {
    cpu: s.cpu_percent ?? 0,
    memUsedGB: s.mem_used_bytes ? +(s.mem_used_bytes / GB).toFixed(1) : 0,
    memTotalGB: s.mem_total_bytes ? +(s.mem_total_bytes / GB).toFixed(1) : 0,
    memPct: pctOf(s.mem_used_bytes, s.mem_total_bytes),
    heapMB: s.heap_used_bytes ? +(s.heap_used_bytes / MB).toFixed(0) : 0,
    diskUsedGB: s.disk_total_bytes ? +((s.disk_used_bytes ?? 0) / GB).toFixed(1) : null,
    diskTotalGB: s.disk_total_bytes ? +(s.disk_total_bytes / GB).toFixed(1) : null,
    diskPct: pctOf(s.disk_used_bytes, s.disk_total_bytes),
    peers: s.peer_count ?? 0,
    rpcMs: s.rpc_latency_ms ?? null,
  };
}

/** Alarm level per card. No peers, or RPC slower than its limit, is critical. */
export function hardwareLevels(hw: HardwareReading | null): Record<'cpu' | 'mem' | 'disk' | 'peers' | 'rpc', MetricLevel> {
  return {
    cpu: metricLevel(hw?.cpu, ...HW_THRESHOLDS.cpu),
    mem: metricLevel(hw?.memPct, ...HW_THRESHOLDS.mem),
    disk: metricLevel(hw?.diskPct, ...HW_THRESHOLDS.disk),
    peers: hw && hw.peers === 0 ? 'crit' : 'ok',
    rpc: hw && hw.rpcMs !== null && hw.rpcMs > HW_THRESHOLDS.rpcMs ? 'crit' : 'ok',
  };
}
