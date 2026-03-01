import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore, type LiveOpMetrics, type SimulationRun } from '../store';
import * as api from '../api';
import type { MetricSnapshot, OperationStats } from '../api';
import { OP_COLORS, type OperationType } from '../types';

interface NodeMetrics {
  nodeId: number;
  name: string;
  online: boolean;
  metrics: MetricSnapshot | null;
  opStats: OperationStats | null;
}

interface AggregateStats {
  totalTriples: number;
  totalKCs: number;
  totalKAs: number;
  confirmedKCs: number;
  tentativeKCs: number;
  totalStoreBytes: number;
  totalOps: number;
  successOps: number;
  errorOps: number;
  avgDurationMs: number;
  avgSuccessRate: number;
  totalGasEth: number;
  totalTrac: number;
  totalPeers: number;
}

const OP_NAMES: { id: string; label: string; op: OperationType }[] = [
  { id: '', label: 'All', op: 'connect' },
  { id: 'publish', label: 'Publish', op: 'publish' },
  { id: 'query', label: 'Query', op: 'query' },
  { id: 'workspace', label: 'Workspace', op: 'workspace' },
  { id: 'sync', label: 'Sync', op: 'connect' },
];

const PERIODS: { id: string; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
];

function fmtBytes(b: number | null): string {
  if (b == null || b === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtNum(n: number | null): string {
  if (n == null) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtPct(n: number | null): string {
  if (n == null) return '-';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function StatCard({ label, value, detail, color }: {
  label: string; value: string; detail?: string; color?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-card-value" style={color ? { color } : undefined}>{value}</div>
      <div className="stat-card-label">{label}</div>
      {detail && <div className="stat-card-detail">{detail}</div>}
    </div>
  );
}

function MiniBar({ data, maxVal, color }: { data: number[]; maxVal: number; color: string }) {
  const h = 40;
  const barW = data.length > 0 ? Math.max(2, Math.floor(200 / data.length) - 1) : 4;
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${data.length * (barW + 1)} ${h}`} preserveAspectRatio="none">
      {data.map((v, i) => {
        const bh = maxVal > 0 ? (v / maxVal) * h : 0;
        return <rect key={i} x={i * (barW + 1)} y={h - bh} width={barW} height={bh} fill={color} opacity={0.8} rx={1} />;
      })}
    </svg>
  );
}

function opsPerSec(lm: LiveOpMetrics): number {
  if (lm.recentTimestamps.length < 2) return 0;
  const now = Date.now();
  const recent = lm.recentTimestamps.filter((t) => now - t < 10_000);
  if (recent.length < 2) return recent.length > 0 ? recent.length / 10 : 0;
  const span = (recent[recent.length - 1] - recent[0]) / 1000;
  return span > 0 ? recent.length / span : 0;
}

function SimulationPicker({ runs, selectedId, onSelect }: {
  runs: SimulationRun[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (runs.length === 0) return null;

  return (
    <div className="stats-section sim-picker-section">
      <div className="stats-section-title">Simulation Runs</div>
      <div className="sim-picker-pills">
        <button
          className={`target-pill ${selectedId === null ? 'active' : ''}`}
          onClick={() => onSelect(null)}
        >
          All / Live
        </button>
        {runs.map((r) => {
          const isActive = !r.finishedAt;
          const elapsed = (r.finishedAt ?? Date.now()) - r.startedAt;
          return (
            <button
              key={r.id}
              className={`target-pill ${selectedId === r.id ? 'active' : ''}`}
              style={selectedId === r.id ? { background: '#f59e0b' } : undefined}
              onClick={() => onSelect(r.id)}
              title={`${r.config.opCount} ops, ${r.config.enabledOps.join('+')} @ ${r.config.opsPerSec}/s`}
            >
              {isActive && <span className="live-dot" />}
              {r.name}
              <span className="sim-pill-meta">
                {r.metrics.total} ops &middot; {fmtDuration(elapsed)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LiveMetricsSection({ lm, title }: { lm: LiveOpMetrics; title?: string }) {
  const rate = opsPerSec(lm);
  const successRate = lm.total > 0 ? lm.success / lm.total : 0;

  if (lm.total === 0) return null;

  const typeEntries = Object.entries(lm.byType).sort((a, b) => b[1].total - a[1].total);

  return (
    <div className="stats-section live-section">
      <div className="stats-section-title">
        <span className="live-dot" /> {title ?? 'Live Simulation Metrics'}
      </div>
      <div className="stats-grid">
        <StatCard label="Total Ops" value={fmtNum(lm.total)} color={OP_COLORS.connect} />
        <StatCard label="Throughput" value={`${rate.toFixed(1)}/s`}
          color={rate > 10 ? '#10b981' : rate > 3 ? '#f59e0b' : '#94a3b8'} />
        <StatCard label="Success" value={fmtNum(lm.success)} color="#10b981" />
        <StatCard label="Errors" value={fmtNum(lm.errors)}
          color={lm.errors > 0 ? '#ef4444' : '#10b981'} />
        <StatCard label="Success Rate" value={fmtPct(successRate)}
          color={successRate >= 0.95 ? '#10b981' : successRate >= 0.8 ? '#f59e0b' : '#ef4444'} />
      </div>
      {typeEntries.length > 0 && (
        <div className="live-breakdown">
          {typeEntries.map(([type, s]) => (
            <div key={type} className="live-breakdown-row">
              <span className="live-breakdown-dot" style={{ background: OP_COLORS[type as OperationType] ?? '#6366f1' }} />
              <span className="live-breakdown-type">{type}</span>
              <span className="live-breakdown-count">{s.total}</span>
              <div className="live-breakdown-bar-bg">
                <div
                  className="live-breakdown-bar-fill"
                  style={{
                    width: `${lm.total > 0 ? (s.total / lm.total) * 100 : 0}%`,
                    background: OP_COLORS[type as OperationType] ?? '#6366f1',
                  }}
                />
              </div>
              {s.errors > 0 && <span className="live-breakdown-errors">{s.errors} err</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SimRunDetail({ run }: { run: SimulationRun }) {
  const elapsed = (run.finishedAt ?? Date.now()) - run.startedAt;
  const isActive = !run.finishedAt;

  return (
    <div className="stats-section sim-run-detail">
      <div className="stats-section-title">
        {isActive && <span className="live-dot" />}
        {run.name}
        <span className="sim-run-badge">{isActive ? 'Running' : 'Completed'}</span>
      </div>
      <div className="sim-run-config">
        <span>{run.config.opCount} ops target</span>
        <span>{run.config.opsPerSec}/s pace</span>
        <span>{run.config.concurrency} concurrency</span>
        <span>{run.config.paranet}</span>
        <span>{run.config.enabledOps.join(', ')}</span>
        <span>{fmtDuration(elapsed)} {isActive ? 'so far' : 'total'}</span>
      </div>
      <LiveMetricsSection lm={run.metrics} title={`${run.name} Metrics`} />
    </div>
  );
}

export function StatsDashboard() {
  const { state } = useStore();
  const [nodeMetrics, setNodeMetrics] = useState<NodeMetrics[]>([]);
  const [opFilter, setOpFilter] = useState('');
  const [period, setPeriod] = useState('24h');
  const [selectedSimId, setSelectedSimId] = useState<string | null>(null);
  const [lastPollTs, setLastPollTs] = useState(0);

  const nodesRef = useRef(state.nodes);
  nodesRef.current = state.nodes;
  const opFilterRef = useRef(opFilter);
  opFilterRef.current = opFilter;
  const periodRef = useRef(period);
  periodRef.current = period;

  const pollMetrics = useCallback(async () => {
    const nodes = nodesRef.current;
    const filter = opFilterRef.current;
    const p = periodRef.current;
    const results: NodeMetrics[] = [];
    for (const node of nodes) {
      if (!node.online) {
        results.push({ nodeId: node.id, name: node.name, online: false, metrics: null, opStats: null });
        continue;
      }
      try {
        const [metrics, opStats] = await Promise.all([
          api.fetchNodeMetrics(node.id).catch(() => null),
          api.fetchOperationStats(node.id, filter || undefined, p).catch(() => null),
        ]);
        results.push({ nodeId: node.id, name: node.name, online: true, metrics, opStats });
      } catch {
        results.push({ nodeId: node.id, name: node.name, online: true, metrics: null, opStats: null });
      }
    }
    setNodeMetrics(results);
    setLastPollTs(Date.now());
  }, []);

  useEffect(() => {
    pollMetrics();
    const iv = setInterval(pollMetrics, 2000);
    return () => clearInterval(iv);
  }, [pollMetrics]);

  // Re-poll immediately when filter/period changes
  useEffect(() => { pollMetrics(); }, [opFilter, period]);

  const selectedRun = selectedSimId
    ? state.simulationRuns.find((r) => r.id === selectedSimId) ?? null
    : null;
  const displayMetrics = selectedRun ? selectedRun.metrics : state.liveMetrics;

  const onlineWithMetrics = nodeMetrics.filter((nm) => nm.online && nm.metrics);
  const agg: AggregateStats = nodeMetrics.reduce(
    (acc, nm) => {
      if (nm.metrics) {
        acc.totalTriples = Math.max(acc.totalTriples, nm.metrics.total_triples ?? 0);
        acc.totalKCs = Math.max(acc.totalKCs, nm.metrics.total_kcs ?? 0);
        acc.totalKAs = Math.max(acc.totalKAs, nm.metrics.total_kas ?? 0);
        acc.confirmedKCs = Math.max(acc.confirmedKCs, nm.metrics.confirmed_kcs ?? 0);
        acc.tentativeKCs = Math.max(acc.tentativeKCs, nm.metrics.tentative_kcs ?? 0);
        acc.totalStoreBytes += nm.metrics.store_bytes ?? 0;
      }
      if (nm.opStats?.summary) {
        acc.totalOps += nm.opStats.summary.totalCount;
        acc.successOps += nm.opStats.summary.successCount;
        acc.errorOps += nm.opStats.summary.errorCount;
        acc.totalGasEth += nm.opStats.summary.totalGasCostEth;
        acc.totalTrac += nm.opStats.summary.totalTracCost;
      }
      return acc;
    },
    {
      totalTriples: 0, totalKCs: 0, totalKAs: 0, confirmedKCs: 0, tentativeKCs: 0,
      totalStoreBytes: 0, totalOps: 0, successOps: 0, errorOps: 0,
      avgDurationMs: 0, avgSuccessRate: 0, totalGasEth: 0, totalTrac: 0, totalPeers: 0,
    },
  );
  agg.totalPeers = onlineWithMetrics.length > 0
    ? Math.round(onlineWithMetrics.reduce((s, nm) => s + (nm.metrics!.peer_count ?? 0), 0) / onlineWithMetrics.length)
    : 0;
  const totalTripleSum = onlineWithMetrics.reduce((s, nm) => s + (nm.metrics!.total_triples ?? 0), 0);

  const withOps = nodeMetrics.filter((nm) => nm.opStats?.summary?.totalCount);
  agg.avgDurationMs = withOps.length > 0
    ? withOps.reduce((s, nm) => s + (nm.opStats!.summary.avgDurationMs ?? 0), 0) / withOps.length
    : 0;
  agg.avgSuccessRate = agg.totalOps > 0 ? agg.successOps / agg.totalOps : 0;

  const allTimeSeries = nodeMetrics
    .filter((nm) => nm.opStats?.timeSeries?.length)
    .flatMap((nm) => nm.opStats!.timeSeries);
  const bucketMap = new Map<number, { count: number; avgMs: number; entries: number }>();
  for (const ts of allTimeSeries) {
    const existing = bucketMap.get(ts.bucket) ?? { count: 0, avgMs: 0, entries: 0 };
    existing.count += ts.count;
    existing.avgMs += ts.avgDurationMs;
    existing.entries++;
    bucketMap.set(ts.bucket, existing);
  }
  const aggTimeSeries = Array.from(bucketMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => ({ count: v.count, avgMs: v.entries > 0 ? v.avgMs / v.entries : 0 }));
  const maxCount = aggTimeSeries.reduce((m, v) => Math.max(m, v.count), 0);
  const maxDuration = aggTimeSeries.reduce((m, v) => Math.max(m, v.avgMs), 0);

  const onlineCount = state.nodes.filter((n) => n.online).length;

  return (
    <div className="stats-dashboard">
      <SimulationPicker
        runs={state.simulationRuns}
        selectedId={selectedSimId}
        onSelect={setSelectedSimId}
      />

      {selectedRun ? (
        <SimRunDetail run={selectedRun} />
      ) : (
        <LiveMetricsSection lm={displayMetrics} />
      )}

      <div className="stats-toolbar">
        <div className="stats-toolbar-section">
          <span className="stats-toolbar-label">Operation</span>
          <div className="graph-target-pills">
            {OP_NAMES.map(({ id, label, op }) => (
              <button
                key={id}
                className={`target-pill ${opFilter === id ? 'active' : ''}`}
                style={opFilter === id && id ? { background: OP_COLORS[op] } : undefined}
                onClick={() => setOpFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="stats-toolbar-section">
          <span className="stats-toolbar-label">Period</span>
          <div className="graph-target-pills">
            {PERIODS.map(({ id, label }) => (
              <button
                key={id}
                className={`target-pill ${period === id ? 'active' : ''}`}
                onClick={() => setPeriod(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="stats-section">
        <div className="stats-section-title">
          Network Overview
          {lastPollTs > 0 && (
            <span className="stats-last-updated">
              live &middot; polled every 2s
            </span>
          )}
        </div>
        <div className="stats-grid">
          <StatCard label="Nodes Online" value={`${onlineCount}/${state.nodes.length}`}
            color={onlineCount === state.nodes.length ? '#10b981' : '#f59e0b'} />
          <StatCard label="Triples (max node)" value={fmtNum(agg.totalTriples)}
            detail={`${fmtNum(totalTripleSum)} total across network`} />
          <StatCard label="Knowledge Collections" value={fmtNum(agg.totalKCs)}
            detail={`${agg.confirmedKCs} confirmed / ${agg.tentativeKCs} tentative`} />
          <StatCard label="Knowledge Assets" value={fmtNum(agg.totalKAs)} />
          <StatCard label="Store Size" value={fmtBytes(agg.totalStoreBytes)} detail="all nodes combined" />
          <StatCard label="Avg Peers / Node" value={fmtNum(agg.totalPeers)} />
        </div>
      </div>

      <div className="stats-section">
        <div className="stats-section-title">Operation Performance (Node-Reported)</div>
        <div className="stats-grid">
          <StatCard label="Total Operations" value={fmtNum(agg.totalOps)} color={OP_COLORS.connect}
            detail="sum across all nodes" />
          <StatCard label="Success Rate" value={fmtPct(agg.avgSuccessRate)}
            color={agg.avgSuccessRate >= 0.95 ? '#10b981' : agg.avgSuccessRate >= 0.8 ? '#f59e0b' : '#ef4444'} />
          <StatCard label="Avg Duration" value={fmtMs(agg.avgDurationMs)}
            color={agg.avgDurationMs < 500 ? '#10b981' : agg.avgDurationMs < 2000 ? '#f59e0b' : '#ef4444'} />
          <StatCard label="Errors" value={fmtNum(agg.errorOps)}
            color={agg.errorOps > 0 ? '#ef4444' : '#10b981'} />
        </div>
      </div>

      {aggTimeSeries.length > 0 && (
        <div className="stats-section">
          <div className="stats-section-title">Throughput Over Time</div>
          <div className="stats-charts-row">
            <div className="stats-chart-card">
              <div className="stats-chart-title">Operations / bucket</div>
              <MiniBar data={aggTimeSeries.map((v) => v.count)} maxVal={maxCount} color={OP_COLORS.connect} />
              <div className="stats-chart-range">
                <span>0</span><span>{fmtNum(maxCount)}</span>
              </div>
            </div>
            <div className="stats-chart-card">
              <div className="stats-chart-title">Avg Duration</div>
              <MiniBar data={aggTimeSeries.map((v) => v.avgMs)} maxVal={maxDuration} color="#f59e0b" />
              <div className="stats-chart-range">
                <span>0</span><span>{fmtMs(maxDuration)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="stats-section">
        <div className="stats-section-title">Per-Node Breakdown</div>
        <div className="node-stats-table">
          <div className="node-stats-header">
            <span>Node</span>
            <span>Status</span>
            <span>Triples</span>
            <span>KCs</span>
            <span>Ops</span>
            <span>Success</span>
            <span>Avg Duration</span>
            <span>Store</span>
          </div>
          {nodeMetrics.map((nm) => (
            <div key={nm.nodeId} className={`node-stats-row ${nm.online ? '' : 'offline'}`}>
              <span className="node-stats-name">N{nm.nodeId}</span>
              <span>
                <span className={`status-dot-sm ${nm.online ? 'online' : 'offline'}`} />
                {nm.online ? 'online' : 'offline'}
              </span>
              <span>{fmtNum(nm.metrics?.total_triples ?? null)}</span>
              <span>{fmtNum(nm.metrics?.total_kcs ?? null)}</span>
              <span>{fmtNum(nm.opStats?.summary?.totalCount ?? null)}</span>
              <span>{fmtPct(nm.opStats?.summary?.successRate ?? null)}</span>
              <span>{fmtMs(nm.opStats?.summary?.avgDurationMs ?? null)}</span>
              <span>{fmtBytes(nm.metrics?.store_bytes ?? null)}</span>
            </div>
          ))}
        </div>
      </div>

      <ErrorsList nodeReportedErrors={agg.errorOps} />
    </div>
  );
}

function ErrorsList({ nodeReportedErrors }: { nodeReportedErrors: number }) {
  const { state } = useStore();
  const errors = state.activities.filter((a) => a.status === 'error').slice(0, 50);
  const totalErrors = Math.max(errors.length, nodeReportedErrors);

  return (
    <div className="stats-section">
      <div className="stats-section-title">
        Recent Errors
        {totalErrors > 0 && <span className="error-count-badge">{totalErrors}</span>}
      </div>
      {errors.length === 0 && nodeReportedErrors > 0 && (
        <div className="errors-empty">
          {nodeReportedErrors} error(s) recorded by nodes (from before this session).
          Errors from the current session will appear here in real time.
        </div>
      )}
      {errors.length === 0 && nodeReportedErrors === 0 && (
        <div className="errors-empty">No errors recorded.</div>
      )}
      {errors.length > 0 && (
        <div className="errors-list">
          {errors.map((e) => (
            <div key={e.id} className="error-row">
              <span className="error-time">{new Date(e.ts).toLocaleTimeString('en-GB')}</span>
              <span className="error-type" style={{ color: OP_COLORS[e.type] }}>{e.type}</span>
              <span className="error-node">N{e.sourceNode}</span>
              <span className="error-label">{e.label}</span>
              <span className="error-detail">{e.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
