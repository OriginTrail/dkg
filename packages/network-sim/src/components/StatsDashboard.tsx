import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useStore, type LiveOpMetrics, type SimulationRun, type PerTypeMetrics } from '../store';
import * as api from '../api';
import type { MetricSnapshot } from '../api';
import { OP_COLORS, type OperationType } from '../types';

/**
 * Tracks a previous value and returns a CSS class when it changes.
 * Triggers a brief flash animation on the stat card.
 */
function useValueFlash(value: string): string {
  const prevRef = useRef(value);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    if (prevRef.current !== value && prevRef.current !== '-' && value !== '-') {
      const prev = parseFloat(prevRef.current.replace(/[^0-9.-]/g, ''));
      const curr = parseFloat(value.replace(/[^0-9.-]/g, ''));
      if (!isNaN(prev) && !isNaN(curr) && prev !== curr) {
        setFlash(curr > prev ? 'flash-up' : 'flash-down');
        const id = setTimeout(() => setFlash(''), 700);
        prevRef.current = value;
        return () => clearTimeout(id);
      }
    }
    prevRef.current = value;
  }, [value]);

  return flash;
}

interface NodeMetrics {
  nodeId: number;
  name: string;
  online: boolean;
  storeBackend?: string;
  metrics: MetricSnapshot | null;
}


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

const StatCard = memo(function StatCard({ label, value, detail, color }: {
  label: string; value: string; detail?: string; color?: string;
}) {
  const flash = useValueFlash(value);
  return (
    <div className={`stat-card ${flash}`}>
      <div className="stat-card-value" style={color ? { color } : undefined}>{value}</div>
      <div className="stat-card-label">{label}</div>
      {detail && <div className="stat-card-detail">{detail}</div>}
    </div>
  );
});

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
              title={`${r.config.opCount} ops, ${r.config.enabledOps.join('+')} @ ${r.config.opsPerSec}/s, ${r.config.kasPerPublish ?? 1} KAs/pub`}
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

function avgMs(pt: PerTypeMetrics): number {
  return pt.total > 0 ? pt.totalDurationMs / pt.total : 0;
}

function avgSuccessMs(pt: PerTypeMetrics): number {
  return pt.success > 0 ? pt.successDurationMs / pt.success : 0;
}

function successRate(pt: PerTypeMetrics): number {
  return pt.total > 0 ? pt.success / pt.total : 0;
}

function LiveMetricsSection({ lm, title }: { lm: LiveOpMetrics; title?: string }) {
  const rate = opsPerSec(lm);
  const overallSuccessRate = lm.total > 0 ? lm.success / lm.total : 0;

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
        <StatCard label="Overall Success Rate" value={fmtPct(overallSuccessRate)}
          color={overallSuccessRate >= 0.95 ? '#10b981' : overallSuccessRate >= 0.8 ? '#f59e0b' : '#ef4444'} />
        <StatCard label="Errors" value={fmtNum(lm.errors)}
          color={lm.errors > 0 ? '#ef4444' : '#10b981'} />
      </div>
      {typeEntries.length > 0 && (
        <div className="per-op-table">
          <div className="per-op-header">
            <span>Operation</span>
            <span>Count</span>
            <span>Success</span>
            <span>Errors</span>
            <span>Success Rate</span>
            <span>Avg Time</span>
            <span>Avg Time (ok)</span>
            <span>Phases</span>
          </div>
          {typeEntries.map(([type, s]) => {
            const sr = successRate(s);
            const color = OP_COLORS[type as OperationType] ?? '#6366f1';
            const phaseNames = Object.keys(s.phaseTotals ?? {}).sort();
            return (
              <div key={type} className="per-op-row">
                <span className="per-op-name">
                  <span className="per-op-dot" style={{ background: color }} />
                  {type}
                </span>
                <span>{fmtNum(s.total)}</span>
                <span style={{ color: '#10b981' }}>{fmtNum(s.success)}</span>
                <span style={{ color: s.errors > 0 ? '#ef4444' : '#64748b' }}>{fmtNum(s.errors)}</span>
                <span style={{
                  color: sr >= 0.95 ? '#10b981' : sr >= 0.8 ? '#f59e0b' : '#ef4444',
                  fontWeight: 600,
                }}>{fmtPct(sr)}</span>
                <span>{fmtMs(avgMs(s))}</span>
                <span>{fmtMs(avgSuccessMs(s))}</span>
                <span className="phase-breakdown">
                  {phaseNames.length > 0
                    ? phaseNames.map((p) => {
                        const avg = (s.phaseTotals[p] ?? 0) / (s.phaseCounts[p] ?? 1);
                        return <span key={p} className="phase-chip">{p}: {fmtMs(avg)}</span>;
                      })
                    : '-'}
                </span>
              </div>
            );
          })}
          <div className="per-op-row per-op-total">
            <span className="per-op-name" style={{ fontWeight: 700 }}>Total</span>
            <span style={{ fontWeight: 700 }}>{fmtNum(lm.total)}</span>
            <span style={{ color: '#10b981', fontWeight: 700 }}>{fmtNum(lm.success)}</span>
            <span style={{ color: lm.errors > 0 ? '#ef4444' : '#64748b', fontWeight: 700 }}>{fmtNum(lm.errors)}</span>
            <span style={{
              color: overallSuccessRate >= 0.95 ? '#10b981' : overallSuccessRate >= 0.8 ? '#f59e0b' : '#ef4444',
              fontWeight: 700,
            }}>{fmtPct(overallSuccessRate)}</span>
            <span>-</span>
            <span>-</span>
            <span>-</span>
          </div>
        </div>
      )}

      {typeEntries.filter(([, s]) => Object.keys(s.phaseTotals ?? {}).length > 0).map(([type, s]) => {
        const color = OP_COLORS[type as OperationType] ?? '#6366f1';
        const phaseNames = Object.keys(s.phaseTotals).sort();
        const totalAvg = avgMs(s);
        const phasesSum = phaseNames.reduce((sum, p) => sum + (s.phaseTotals[p] ?? 0) / (s.phaseCounts[p] ?? 1), 0);
        const overhead = Math.max(0, totalAvg - phasesSum);

        return (
          <div key={`phase-${type}`} className="phase-detail-section">
            <div className="phase-detail-title">
              <span className="per-op-dot" style={{ background: color }} />
              {type} — Time Breakdown
              <span className="phase-detail-total">avg total: {fmtMs(totalAvg)}</span>
            </div>
            <div className="phase-bar-container">
              {phaseNames.map((p) => {
                const avg = (s.phaseTotals[p] ?? 0) / (s.phaseCounts[p] ?? 1);
                const pct = totalAvg > 0 ? (avg / totalAvg) * 100 : 0;
                return (
                  <div key={p} className="phase-bar-item">
                    <div className="phase-bar-label">
                      <span>{p}</span>
                      <span>{fmtMs(avg)} ({pct.toFixed(1)}%)</span>
                    </div>
                    <div className="phase-bar-track">
                      <div className="phase-bar-fill" style={{ width: `${pct}%`, background: color, opacity: 0.7 }} />
                    </div>
                  </div>
                );
              })}
              {overhead > 10 && (
                <div className="phase-bar-item">
                  <div className="phase-bar-label">
                    <span style={{ color: '#ef4444' }}>overhead (HTTP + queue)</span>
                    <span style={{ color: '#ef4444' }}>{fmtMs(overhead)} ({((overhead / totalAvg) * 100).toFixed(1)}%)</span>
                  </div>
                  <div className="phase-bar-track">
                    <div className="phase-bar-fill" style={{ width: `${(overhead / totalAvg) * 100}%`, background: '#ef4444', opacity: 0.4 }} />
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
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
        <span>{run.config.kasPerPublish ?? 1} KAs/publish</span>
        <span>{run.config.paranet}</span>
        <span>{run.config.enabledOps.join(', ')}</span>
        <span>{fmtDuration(elapsed)} {isActive ? 'so far' : 'total'}</span>
      </div>
      <LiveMetricsSection lm={run.metrics} title={`${run.name} Metrics`} />
    </div>
  );
}

function MiniBar({ data, maxVal, color, height = 40 }: { data: number[]; maxVal: number; color: string; height?: number }) {
  const barW = data.length > 0 ? Math.max(4, Math.floor(200 / data.length) - 1) : 4;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${data.length * (barW + 1)} ${height}`} preserveAspectRatio="none">
      {data.map((v, i) => {
        const bh = maxVal > 0 ? (v / maxVal) * height : 0;
        return <rect key={i} x={i * (barW + 1)} y={height - bh} width={barW} height={bh} fill={color} opacity={0.8} rx={1} />;
      })}
    </svg>
  );
}

function SystemResourcesSection({ nodeMetrics }: { nodeMetrics: NodeMetrics[] }) {
  const online = nodeMetrics.filter((nm) => nm.online && nm.metrics);
  if (online.length === 0) return null;

  const cpuData = online.map((nm) => nm.metrics!.cpu_percent ?? 0);
  const memData = online.map((nm) => (nm.metrics!.mem_used_bytes ?? 0) / (1024 * 1024));
  const heapData = online.map((nm) => (nm.metrics!.heap_used_bytes ?? 0) / (1024 * 1024));

  const avgCpu = cpuData.length > 0 ? cpuData.reduce((a, b) => a + b, 0) / cpuData.length : 0;
  const totalMem = memData.reduce((a, b) => a + b, 0);
  const totalHeap = heapData.reduce((a, b) => a + b, 0);
  const maxCpu = Math.max(...cpuData, 1);
  const maxMem = Math.max(...memData, 1);
  const maxHeap = Math.max(...heapData, 1);

  return (
    <div className="stats-section">
      <div className="stats-section-title">System Resources (per node)</div>
      <div className="stats-grid">
        <StatCard label="Avg CPU" value={`${avgCpu.toFixed(1)}%`}
          color={avgCpu > 80 ? '#ef4444' : avgCpu > 50 ? '#f59e0b' : '#10b981'} />
        <StatCard label="Total RSS Memory" value={`${(totalMem).toFixed(0)} MB`}
          detail={`${(totalMem / online.length).toFixed(0)} MB avg per node`} />
        <StatCard label="Total Heap Used" value={`${totalHeap.toFixed(0)} MB`}
          detail={`${(totalHeap / online.length).toFixed(0)} MB avg per node`} />
      </div>
      <div className="stats-charts-row">
        <div className="stats-chart-card">
          <div className="stats-chart-title">CPU % per node</div>
          <MiniBar data={cpuData} maxVal={100} color="#6366f1" />
          <div className="stats-chart-range">
            {online.map((nm, i) => <span key={nm.nodeId} className="chart-node-label">N{nm.nodeId}</span>)}
          </div>
        </div>
        <div className="stats-chart-card">
          <div className="stats-chart-title">RSS Memory (MB) per node</div>
          <MiniBar data={memData} maxVal={maxMem * 1.2} color="#10b981" />
          <div className="stats-chart-range">
            {online.map((nm) => <span key={nm.nodeId} className="chart-node-label">N{nm.nodeId}</span>)}
          </div>
        </div>
        <div className="stats-chart-card">
          <div className="stats-chart-title">Heap (MB) per node</div>
          <MiniBar data={heapData} maxVal={maxHeap * 1.2} color="#f59e0b" />
          <div className="stats-chart-range">
            {online.map((nm) => <span key={nm.nodeId} className="chart-node-label">N{nm.nodeId}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function StatsDashboard() {
  const { state } = useStore();
  const [nodeMetrics, setNodeMetrics] = useState<NodeMetrics[]>([]);
  const [selectedSimId, setSelectedSimId] = useState<string | null>(null);
  const [lastPollTs, setLastPollTs] = useState(0);

  const nodesRef = useRef(state.nodes);
  nodesRef.current = state.nodes;

  const pollingRef = useRef(false);
  const pollMetrics = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      const nodes = nodesRef.current;
      const settled = await Promise.allSettled(
        nodes.map(async (node): Promise<NodeMetrics> => {
          if (!node.online) return { nodeId: node.id, name: node.name, online: false, metrics: null };
          const [metrics, status] = await Promise.all([
            api.fetchNodeMetrics(node.id).catch(() => null),
            api.fetchNodeStatus(node.id).catch(() => null),
          ]);
          return { nodeId: node.id, name: node.name, online: true, storeBackend: status?.storeBackend, metrics };
        }),
      );
      setNodeMetrics(settled.map((r) => r.status === 'fulfilled' ? r.value : { nodeId: 0, name: '?', online: false, metrics: null }));
      setLastPollTs(Date.now());
    } finally {
      pollingRef.current = false;
    }
  }, []);

  useEffect(() => {
    pollMetrics();
    const iv = setInterval(pollMetrics, 3000);
    return () => clearInterval(iv);
  }, [pollMetrics]);

  const selectedRun = selectedSimId
    ? state.simulationRuns.find((r) => r.id === selectedSimId) ?? null
    : null;
  const displayMetrics = selectedRun ? selectedRun.metrics : state.liveMetrics;

  const onlineWithMetrics = nodeMetrics.filter((nm) => nm.online && nm.metrics);

  const agg = nodeMetrics.reduce(
    (acc, nm) => {
      if (nm.metrics) {
        acc.totalTriples = Math.max(acc.totalTriples, nm.metrics.total_triples ?? 0);
        acc.totalKCs = Math.max(acc.totalKCs, nm.metrics.total_kcs ?? 0);
        acc.totalKAs = Math.max(acc.totalKAs, nm.metrics.total_kas ?? 0);
        acc.confirmedKCs = Math.max(acc.confirmedKCs, nm.metrics.confirmed_kcs ?? 0);
        acc.tentativeKCs = Math.max(acc.tentativeKCs, nm.metrics.tentative_kcs ?? 0);
        acc.totalStoreBytes += nm.metrics.store_bytes ?? 0;
      }
      return acc;
    },
    { totalTriples: 0, totalKCs: 0, totalKAs: 0, confirmedKCs: 0, tentativeKCs: 0, totalStoreBytes: 0 },
  );
  const totalPeers = onlineWithMetrics.length > 0
    ? Math.round(onlineWithMetrics.reduce((s, nm) => s + (nm.metrics!.peer_count ?? 0), 0) / onlineWithMetrics.length)
    : 0;
  const totalTripleSum = onlineWithMetrics.reduce((s, nm) => s + (nm.metrics!.total_triples ?? 0), 0);

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
          <StatCard label="Knowledge Assets" value={fmtNum(agg.totalKAs)}
            detail={`max single node (replicated)`} />
          <StatCard label="Store Size" value={fmtBytes(agg.totalStoreBytes)} detail="all nodes combined" />
          <StatCard label="Avg Peers / Node" value={fmtNum(totalPeers)} />
        </div>
      </div>

      <SystemResourcesSection nodeMetrics={nodeMetrics} />

      <div className="stats-section">
        <div className="stats-section-title">Per-Node Breakdown</div>
        <div className="node-stats-table">
          <div className="node-stats-header">
            <span>Node</span>
            <span>Status</span>
            <span>Backend</span>
            <span>Triples</span>
            <span>KCs</span>
            <span>KAs</span>
            <span>Store</span>
          </div>
          {nodeMetrics.map((nm) => (
            <NodeRow key={nm.nodeId} nm={nm} />
          ))}
        </div>
      </div>

      <ErrorsList />
    </div>
  );
}

const NodeRow = memo(function NodeRow({ nm }: { nm: NodeMetrics }) {
  const fingerprint = `${nm.metrics?.total_triples}|${nm.metrics?.total_kcs}|${nm.metrics?.total_kas}`;
  const prevRef = useRef(fingerprint);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prevRef.current !== fingerprint && prevRef.current !== 'undefined|undefined|undefined') {
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 600);
      prevRef.current = fingerprint;
      return () => clearTimeout(id);
    }
    prevRef.current = fingerprint;
  }, [fingerprint]);

  return (
    <div className={`node-stats-row ${nm.online ? '' : 'offline'} ${flash ? 'row-flash' : ''}`}>
      <span className="node-stats-name">N{nm.nodeId}</span>
      <span>
        <span className={`status-dot-sm ${nm.online ? 'online' : 'offline'}`} />
        {nm.online ? 'online' : 'offline'}
      </span>
      <span className="backend-badge">{nm.storeBackend ?? '—'}</span>
      <span>{fmtNum(nm.metrics?.total_triples ?? null)}</span>
      <span>{fmtNum(nm.metrics?.total_kcs ?? null)}</span>
      <span>{fmtNum(nm.metrics?.total_kas ?? null)}</span>
      <span>{fmtBytes(nm.metrics?.store_bytes ?? null)}</span>
    </div>
  );
});

function ErrorsList() {
  const { state } = useStore();
  const errors = state.activities.filter((a) => a.status === 'error').slice(0, 50);

  return (
    <div className="stats-section">
      <div className="stats-section-title">
        Recent Errors
        {errors.length > 0 && <span className="error-count-badge">{errors.length}</span>}
      </div>
      {errors.length === 0 && (
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
