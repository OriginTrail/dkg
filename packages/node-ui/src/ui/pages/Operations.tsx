import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useFetch, formatTime, formatDuration, shortId } from '../hooks.js';
import {
  fetchOperationsWithPhases, fetchOperation, fetchNodeLog,
  fetchOperationStats, fetchStatus, fetchErrorHotspots, fetchFailedOperations,
  fetchSuccessRates, fetchPerTypeStats, fetchMetricsHistory,
} from '../api.js';

const PHASE_COLORS: Record<string, string> = {
  prepare: '#3b82f6',
  store: '#8b5cf6',
  chain: '#f59e0b',
  broadcast: '#22c55e',
  parse: '#3b82f6',
  execute: '#8b5cf6',
  transfer: '#3b82f6',
  verify: '#22c55e',
};

const STATUS_COLORS: Record<string, string> = {
  success: '#22c55e',
  error: '#ef4444',
  in_progress: '#f59e0b',
};

const PHASE_DESCRIPTIONS: Record<string, string> = {
  prepare: 'Partitioning triples, computing Merkle hashes, validating & signing.',
  store: 'Inserting triples into the local triple store and data graph.',
  chain: 'Submitting on-chain tx and waiting for confirmation.',
  broadcast: 'Broadcasting to network peers via GossipSub.',
  parse: 'Validating and parsing the SPARQL query syntax.',
  execute: 'Running the SPARQL query against the local triple store.',
  transfer: 'Fetching triple pages from the remote peer.',
  verify: 'Verifying Merkle proofs and inserting synced triples.',
};

const OP_TYPE_COLORS: Record<string, string> = {
  publish: '#3b82f6',
  update: '#14b8a6',
  query: '#8b5cf6',
  workspace: '#f59e0b',
  enshrine: '#22c55e',
  connect: '#06b6d4',
  sync: '#ec4899',
  gossip: '#f97316',
  system: '#6b7280',
};

const TOOLTIP_STYLE = { background: '#111827', border: '1px solid #1f2937', borderRadius: 6, fontSize: 12, color: '#e5e7eb' };

const TIME_PERIODS = [
  { value: '5m', label: '5 min', ms: 5 * 60_000 },
  { value: '15m', label: '15 min', ms: 15 * 60_000 },
  { value: '30m', label: '30 min', ms: 30 * 60_000 },
  { value: '1h', label: '1 hour', ms: 60 * 60_000 },
  { value: '3h', label: '3 hours', ms: 3 * 60 * 60_000 },
  { value: '6h', label: '6 hours', ms: 6 * 60 * 60_000 },
  { value: '12h', label: '12 hours', ms: 12 * 60 * 60_000 },
  { value: '24h', label: '24 hours', ms: 24 * 60 * 60_000 },
  { value: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: '30 days', ms: 30 * 86_400_000 },
];

const PERIOD_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function periodToMs(period: string): number {
  const preset = TIME_PERIODS.find(p => p.value === period);
  if (preset) return preset.ms;
  const match = period.match(/^(\d+)\s*([mhdw])$/i);
  if (match) {
    const val = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (val > 0 && PERIOD_UNITS[unit]) return val * PERIOD_UNITS[unit];
  }
  return 86_400_000;
}

function PeriodSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isCustom = !TIME_PERIODS.some(p => p.value === value);
  const [customInput, setCustomInput] = useState('');
  const [showCustom, setShowCustom] = useState(isCustom);

  const applyCustom = () => {
    const trimmed = customInput.trim();
    if (trimmed && /^\d+\s*[mhdw]$/i.test(trimmed)) {
      onChange(trimmed.replace(/\s+/g, ''));
      setShowCustom(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <select
        className="input"
        value={isCustom ? '__custom__' : value}
        onChange={e => {
          if (e.target.value === '__custom__') { setShowCustom(true); return; }
          setShowCustom(false);
          onChange(e.target.value);
        }}
      >
        {TIME_PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        <option value="__custom__">Custom...</option>
      </select>
      {(showCustom || isCustom) && (
        <input
          className="input mono"
          placeholder="e.g. 2d, 45m, 3h"
          value={customInput || (isCustom ? value : '')}
          onChange={e => setCustomInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applyCustom()}
          onBlur={applyCustom}
          style={{ width: 90 }}
          autoFocus
        />
      )}
      {isCustom && (
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{value}</span>
      )}
    </div>
  );
}

export function ObservabilitySection() {
  const [tab, setTab] = useState<'operations' | 'general' | 'logs' | 'errors'>('operations');

  return (
    <div>
      <div className="tab-group" style={{ marginBottom: 16 }}>
        <button className={`tab-item ${tab === 'operations' ? 'active' : ''}`} onClick={() => setTab('operations')}>Operations</button>
        <button className={`tab-item ${tab === 'general' ? 'active' : ''}`} onClick={() => setTab('general')}>General</button>
        <button className={`tab-item ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>Logs</button>
        <button className={`tab-item ${tab === 'errors' ? 'active' : ''}`} onClick={() => setTab('errors')}>Errors</button>
      </div>
      {tab === 'operations' ? <OperationsTab /> : tab === 'general' ? <StatsTab /> : tab === 'errors' ? <HealthTab /> : <LogsTab />}
    </div>
  );
}

export function OperationsPage() {
  return (
    <div className="page-section">
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Observability</h1>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>Track operation performance, phases, and errors</p>
      <ObservabilitySection />
    </div>
  );
}

/* ================================================================
   Health Tab
   ================================================================ */

function HealthTab() {
  const [period, setPeriod] = useState('24h');
  const [search, setSearch] = useState('');
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [expandedOp, setExpandedOp] = useState<string | null>(null);
  const periodMs = periodToMs(period);

  const { data } = useFetch(() => fetchErrorHotspots(periodMs), [periodMs], 15_000);
  const hotspots = data?.hotspots ?? [];

  const { data: failedData } = useFetch(
    () => expandedPhase ? fetchFailedOperations({ phase: expandedPhase, periodMs, q: search || undefined }) : Promise.resolve(null),
    [expandedPhase, periodMs, search],
    10_000,
  );
  const failedOps = failedData?.operations ?? [];

  return (
    <div>
      <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <PeriodSelect value={period} onChange={setPeriod} />
        <input
          className="input mono"
          placeholder="Search errors, operation IDs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div className="card-title" style={{ marginBottom: 4 }}>Error Hotspots</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
          Click a phase to see all failed operations. Click an operation to expand its logs.
        </p>
        {hotspots.length === 0 ? (
          <div className="empty-state" style={{ color: 'var(--green)' }}>No errors in this period</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Phase</th><th>Errors</th><th>Last Error</th><th>Last Occurred</th></tr>
            </thead>
            <tbody>
              {hotspots.map((h: any) => (
                <React.Fragment key={h.phase}>
                  <tr
                    onClick={() => { setExpandedPhase(p => p === h.phase ? null : h.phase); setExpandedOp(null); }}
                    style={{ cursor: 'pointer', background: expandedPhase === h.phase ? 'rgba(239,68,68,.08)' : undefined }}
                  >
                    <td style={{ color: PHASE_COLORS[h.phase] ?? '#9ca3af', fontWeight: 600, padding: '10px 14px' }}>
                      <span style={{ marginRight: 6, fontSize: 10 }}>{expandedPhase === h.phase ? '▼' : '▸'}</span>
                      {h.phase}
                    </td>
                    <td style={{ padding: '10px 14px' }}><span className="badge badge-error">{h.error_count}</span></td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '10px 14px' }} title={h.last_error ?? ''}>{h.last_error ?? '—'}</td>
                    <td style={{ padding: '10px 14px' }}>{h.last_occurred ? formatTime(h.last_occurred) : '—'}</td>
                  </tr>
                  {expandedPhase === h.phase && (
                    <tr><td colSpan={4} style={{ padding: 0, background: 'rgba(0,0,0,.15)' }}>
                      <FailedOperationsList
                        operations={failedOps}
                        expandedOp={expandedOp}
                        onToggleOp={(id) => setExpandedOp(o => o === id ? null : id)}
                      />
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function FailedOperationsList({ operations, expandedOp, onToggleOp }: {
  operations: any[]; expandedOp: string | null; onToggleOp: (id: string) => void;
}) {
  if (operations.length === 0) {
    return <div style={{ padding: '12px 16px', fontSize: 11, color: 'var(--text-muted)' }}>No matching failed operations</div>;
  }

  return (
    <div style={{ padding: '8px 0' }}>
      {operations.map((op: any) => (
        <div key={`${op.operation_id}-${op.phase_started_at}`} style={{ borderBottom: '1px solid var(--border)' }}>
          <div
            onClick={() => onToggleOp(op.operation_id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', cursor: 'pointer',
              background: expandedOp === op.operation_id ? 'rgba(239,68,68,.05)' : undefined,
            }}
          >
            <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{expandedOp === op.operation_id ? '▼' : '▸'}</span>
            <span style={{ fontWeight: 600, fontSize: 12, color: OP_TYPE_COLORS[op.operation_name] ?? '#9ca3af' }}>{op.operation_name}</span>
            <StatusBadge status={op.status} />
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-dim)' }}>{op.operation_id} <CopyButton text={op.operation_id} /></span>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto' }}>{formatTime(op.phase_started_at)}</span>
            {op.duration_ms != null && <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{formatDuration(op.duration_ms)}</span>}
          </div>

          {expandedOp === op.operation_id && (
            <div style={{ padding: '4px 20px 16px' }}>
              {op.phase_error && (
                <div style={{ padding: '6px 10px', marginBottom: 8, background: 'rgba(239,68,68,.1)', borderRadius: 6, border: '1px solid rgba(239,68,68,.2)', fontSize: 11, color: '#ef4444' }}>
                  {op.phase_error}
                </div>
              )}
              {op.error_message && op.error_message !== op.phase_error && (
                <div style={{ padding: '6px 10px', marginBottom: 8, background: 'rgba(239,68,68,.06)', borderRadius: 6, border: '1px solid rgba(239,68,68,.15)', fontSize: 11, color: '#f87171' }}>
                  {op.error_message}
                </div>
              )}
              {op.logs && op.logs.length > 0 ? (
                <LogContainer maxHeight={200}>
                  {op.logs.map((l: any) => (
                    <StyledLogEntry key={l.id} ts={l.ts} level={l.level} module={l.module} message={l.message} />
                  ))}
                </LogContainer>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '4px 0' }}>No logs for this operation</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ================================================================
   Stats Tab — compact summary, per-type breakdown, hardware metrics
   ================================================================ */

const GRANULARITY_OPTIONS = [
  { value: '0', label: 'Auto' },
  { value: String(5 * 60_000), label: '5 min' },
  { value: String(15 * 60_000), label: '15 min' },
  { value: String(30 * 60_000), label: '30 min' },
  { value: String(3_600_000), label: '1 hour' },
  { value: String(6 * 3_600_000), label: '6 hours' },
  { value: String(86_400_000), label: '1 day' },
];

function StatsTab() {
  const [period, setPeriod] = useState('3h');
  const [subTab, setSubTab] = useState<'operations' | 'hardware'>('operations');
  const [granularity, setGranularity] = useState('0');
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  const pMs = periodToMs(period);
  const bucketMs = granularity === '0' ? undefined : parseInt(granularity, 10);
  const { data: ratesData } = useFetch(() => fetchSuccessRates(pMs), [pMs], 15_000);
  const { data: perType } = useFetch(() => fetchPerTypeStats(pMs, bucketMs), [pMs, bucketMs], 15_000);
  const { data: hwData } = useFetch(
    () => fetchMetricsHistory(Date.now() - pMs, Date.now(), 200),
    [pMs], 30_000,
  );
  const rates = ratesData?.rates ?? [];

  const timeFmt = useMemo((): Intl.DateTimeFormatOptions => {
    if (pMs <= 3_600_000) return { hour: '2-digit', minute: '2-digit' };
    if (pMs <= 86_400_000) return { hour: '2-digit', minute: '2-digit' };
    return { month: 'short', day: 'numeric', hour: '2-digit' };
  }, [pMs]);

  const perTypeChartData = useMemo(() => {
    if (!perType?.buckets?.length) return [];
    return perType.buckets.map((b: number, i: number) => {
      const row: Record<string, any> = {
        time: new Date(b).toLocaleString(undefined, timeFmt),
      };
      for (const t of perType.types) {
        const d = perType.series[t]?.[i];
        row[`${t}_count`] = d?.count ?? 0;
        row[`${t}_avgMs`] = d?.avgMs ? +(d.avgMs / 1000).toFixed(2) : 0;
        row[`${t}_successPct`] = d ? Math.round(d.successRate * 100) : 0;
        row[`${t}_gas`] = d?.gasCostEth ?? 0;
      }
      return row;
    });
  }, [perType]);

  const hwChartData = useMemo(() => (hwData?.snapshots ?? []).map((s: any) => ({
    time: new Date(s.ts).toLocaleString(undefined, timeFmt),
    cpu: s.cpu_percent ?? 0,
    memGB: s.mem_used_bytes ? +(s.mem_used_bytes / (1024 ** 3)).toFixed(2) : 0,
    heapMB: s.heap_used_bytes ? +(s.heap_used_bytes / (1024 ** 2)).toFixed(1) : 0,
    diskPct: s.disk_total_bytes ? Math.round((s.disk_used_bytes / s.disk_total_bytes) * 100) : 0,
    peers: s.peer_count ?? 0,
    rpcMs: s.rpc_latency_ms ?? 0,
  })), [hwData]);

  const types = perType?.types ?? [];
  const hasCharts = perTypeChartData.length > 1;

  const handleLegendClick = useCallback((e: any) => {
    const name = e.value ?? e.dataKey;
    if (!name) return;
    setHiddenSeries(prev => {
      const next = new Set(prev);
      if (next.has(name)) { next.delete(name); } else { next.add(name); }
      return next;
    });
  }, []);

  const legendFormatter = useCallback((value: string) => {
    const dimmed = hiddenSeries.has(value);
    return <span style={{ color: dimmed ? '#555' : undefined, textDecoration: dimmed ? 'line-through' : undefined, cursor: 'pointer' }}>{value}</span>;
  }, [hiddenSeries]);

  return (
    <div>
      <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <PeriodSelect value={period} onChange={setPeriod} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>per</span>
          <select className="input" value={granularity} onChange={e => setGranularity(e.target.value)} style={{ width: 'auto' }}>
            {GRANULARITY_OPTIONS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 0, marginLeft: 8, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          {(['operations', 'hardware'] as const).map(t => (
            <button
              key={t}
              onClick={() => setSubTab(t)}
              style={{
                padding: '5px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none',
                background: subTab === t ? 'var(--green-dim)' : 'var(--surface)',
                color: subTab === t ? 'var(--green)' : 'var(--text-muted)',
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {subTab === 'operations' ? (
        <>
          {/* Per-operation-type cards */}
          {rates.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 16 }}>
              {rates.map((r: any) => {
                const color = OP_TYPE_COLORS[r.type] ?? '#9ca3af';
                const rateColor = r.rate >= 0.9 ? '#22c55e' : r.rate >= 0.7 ? '#f59e0b' : '#ef4444';
                return (
                  <div key={r.type} style={{ background: 'rgba(255,255,255,.03)', borderRadius: 8, padding: '12px 14px', border: '1px solid var(--border)', borderLeft: `3px solid ${color}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color }}>{r.type}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px', fontSize: 11 }}>
                      <div>
                        <div style={{ color: 'var(--text-dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Operations</div>
                        <div style={{ fontWeight: 700, fontSize: 16 }}>{r.total}</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Success</div>
                        <div style={{ fontWeight: 700, fontSize: 16, color: rateColor }}>{(r.rate * 100).toFixed(0)}%</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Avg Duration</div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{formatDuration(r.avgMs)}</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Errors</div>
                        <div style={{ fontWeight: 600, fontSize: 13, color: r.error > 0 ? '#ef4444' : 'var(--text-dim)' }}>{r.error}</div>
                      </div>
                    </div>
                    <div style={{ height: 3, background: 'rgba(255,255,255,.06)', borderRadius: 2, overflow: 'hidden', marginTop: 10 }}>
                      <div style={{ height: '100%', width: `${r.rate * 100}%`, background: rateColor, borderRadius: 2 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Operation charts */}
          {hasCharts ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div className="card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Operations Over Time</div>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={perTypeChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                    <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} width={28} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(255,255,255,.06)' }} />
                    <Legend wrapperStyle={{ fontSize: 9 }} onClick={handleLegendClick} formatter={legendFormatter} />
                    {types.map((t: string) => (
                      <Bar key={t} dataKey={`${t}_count`} name={t} stackId="ops" fill={OP_TYPE_COLORS[t] ?? '#6b7280'} fillOpacity={0.6} hide={hiddenSeries.has(t)} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Avg Duration by Operation Type (s)</div>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={perTypeChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                    <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} width={32} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 9 }} onClick={handleLegendClick} formatter={legendFormatter} />
                    {types.map((t: string) => (
                      <Area key={t} type="monotone" dataKey={`${t}_avgMs`} name={t} stroke={OP_TYPE_COLORS[t] ?? '#6b7280'} fill={OP_TYPE_COLORS[t] ?? '#6b7280'} fillOpacity={0.1} strokeWidth={2} dot={false} hide={hiddenSeries.has(t)} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Success Rate by Operation Type (%)</div>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={perTypeChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#9ca3af' }} width={28} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 9 }} onClick={handleLegendClick} formatter={legendFormatter} />
                    {types.map((t: string) => (
                      <Area key={t} type="monotone" dataKey={`${t}_successPct`} name={t} stroke={OP_TYPE_COLORS[t] ?? '#6b7280'} fill={OP_TYPE_COLORS[t] ?? '#6b7280'} fillOpacity={0.1} strokeWidth={2} dot={false} hide={hiddenSeries.has(t)} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Gas Cost by Operation Type (ETH)</div>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={perTypeChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                    <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} width={32} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(255,255,255,.06)' }} />
                    <Legend wrapperStyle={{ fontSize: 9 }} onClick={handleLegendClick} formatter={legendFormatter} />
                    {types.map((t: string) => (
                      <Bar key={t} dataKey={`${t}_gas`} name={t} stackId="gas" fill={OP_TYPE_COLORS[t] ?? '#6b7280'} fillOpacity={0.6} hide={hiddenSeries.has(t)} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className="card" style={{ marginBottom: 14 }}><div className="empty-state">Not enough operation data for charts yet</div></div>
          )}
        </>
      ) : (
        <>
          {hwChartData.length > 1 ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>CPU Usage (%)</div>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={hwChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#9ca3af' }} width={28} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Area type="monotone" dataKey="cpu" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.12} strokeWidth={1.5} dot={false} name="CPU %" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Memory & Heap</div>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={hwChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                    <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} width={32} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 9 }} />
                    <Area type="monotone" dataKey="memGB" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.1} strokeWidth={1.5} dot={false} name="Sys RAM (GB)" />
                    <Area type="monotone" dataKey="heapMB" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.1} strokeWidth={1.5} dot={false} name="Heap (MB)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Disk Usage (%)</div>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={hwChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#9ca3af' }} width={28} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Area type="monotone" dataKey="diskPct" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.12} strokeWidth={1.5} dot={false} name="Disk %" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Network & RPC</div>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={hwChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                    <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} width={28} yAxisId="left" />
                    <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} width={28} yAxisId="right" orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 9 }} />
                    <Area type="monotone" dataKey="peers" stroke="#22c55e" fill="#22c55e" fillOpacity={0.1} strokeWidth={1.5} dot={false} name="Peers" yAxisId="left" />
                    <Area type="monotone" dataKey="rpcMs" stroke="#ef4444" fill="#ef4444" fillOpacity={0.08} strokeWidth={1.5} dot={false} name="RPC (ms)" yAxisId="right" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className="card"><div className="empty-state">Not enough hardware metrics yet — data is collected every 30 seconds</div></div>
          )}
        </>
      )}
    </div>
  );
}

/* ================================================================
   Operations Tab
   ================================================================ */

function MiniGantt({ phases, totalMs }: { phases: any[]; totalMs: number }) {
  if (!phases?.length || totalMs <= 0) return <span style={{ color: 'var(--text-dim)' }}>—</span>;
  return (
    <div style={{ display: 'flex', height: 10, borderRadius: 3, overflow: 'hidden', background: 'rgba(255,255,255,.04)', minWidth: 80, maxWidth: 160 }}>
      {phases.map((p: any, i: number) => {
        const pct = Math.max(((p.duration_ms ?? 0) / totalMs) * 100, 3);
        const color = p.status === 'error' ? '#ef4444' : PHASE_COLORS[p.phase] ?? '#6b7280';
        return (
          <div
            key={`${p.phase}-${i}`}
            title={`${p.phase}: ${formatDuration(p.duration_ms)}${p.status === 'error' ? ' (FAILED)' : ''}`}
            style={{ width: `${pct}%`, background: color, minWidth: 2, transition: 'width .2s' }}
          />
        );
      })}
    </div>
  );
}

const PAGE_SIZE = 50;

function OperationsTab() {
  const [nameFilter, setNameFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [opIdFilter, setOpIdFilter] = useState('');
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => { setPage(0); }, [nameFilter, statusFilter, opIdFilter]);

  const params: Record<string, string> = { limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) };
  if (nameFilter) params.name = nameFilter;
  if (statusFilter) params.status = statusFilter;
  if (opIdFilter.trim()) params.operationId = opIdFilter.trim();

  const { data } = useFetch(() => fetchOperationsWithPhases(params), [nameFilter, statusFilter, opIdFilter, page], 5_000);
  const { data: detail } = useFetch(
    () => selectedOp ? fetchOperation(selectedOp) : Promise.resolve(null),
    [selectedOp],
  );
  const { data: statusData } = useFetch(fetchStatus, [], 30_000);
  const explorerUrl = statusData?.blockExplorerUrl;

  const operations = data?.operations ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <select className="input" value={nameFilter} onChange={(e) => setNameFilter(e.target.value)}>
          <option value="">All types</option>
          <option value="publish">publish</option>
          <option value="update">update</option>
          <option value="query">query</option>
          <option value="workspace">workspace</option>
          <option value="enshrine">enshrine</option>
          <option value="sync">sync</option>
          <option value="connect">connect</option>
          <option value="system">system</option>
        </select>
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="success">success</option>
          <option value="error">error</option>
          <option value="in_progress">in_progress</option>
        </select>
        <input
          className="input mono"
          placeholder="Filter by Operation ID..."
          value={opIdFilter}
          onChange={e => setOpIdFilter(e.target.value)}
          style={{ minWidth: 240, flex: 1 }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{total} total</span>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {operations.length === 0 ? (
          <div className="empty-state" style={{ padding: 32 }}>No operations recorded yet</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Status</th>
                <th>Phases</th>
                <th>Duration</th>
                <th>Cost (ETH)</th>
                <th>TX</th>
                <th>Operation ID</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op: any) => (
                <tr
                  key={op.operation_id}
                  onClick={() => setSelectedOp(op.operation_id)}
                  style={{ cursor: 'pointer', background: selectedOp === op.operation_id ? 'rgba(59,130,246,.1)' : undefined }}
                >
                  <td>{formatTime(op.started_at)}</td>
                  <td><span className="badge badge-info" style={{ background: OP_TYPE_COLORS[op.operation_name] ?? undefined }}>{op.operation_name}</span></td>
                  <td><StatusBadge status={op.status} /></td>
                  <td><MiniGantt phases={op.phases} totalMs={op.duration_ms} /></td>
                  <td>{formatDuration(op.duration_ms)}</td>
                  <td>{op.gas_cost_eth != null ? op.gas_cost_eth.toFixed(6) : '—'}</td>
                  <td>
                    {op.tx_hash ? (
                      <a href={explorerUrl ? `${explorerUrl}/tx/${op.tx_hash}` : '#'} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={op.tx_hash}>
                        <TxLinkIcon />
                      </a>
                    ) : '—'}
                  </td>
                  <td className="mono">{shortId(op.operation_id)} <CopyButton text={op.operation_id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 0', fontSize: 11, color: 'var(--text-muted)',
        }}>
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              disabled={page === 0}
              onClick={() => setPage(0)}
              style={{
                padding: '4px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: page === 0 ? 'default' : 'pointer',
                border: '1px solid var(--border)', background: 'var(--surface)', color: page === 0 ? 'var(--text-dim)' : 'var(--text-muted)',
                opacity: page === 0 ? 0.4 : 1,
              }}
            >
              ««
            </button>
            <button
              disabled={page === 0}
              onClick={() => setPage(p => Math.max(0, p - 1))}
              style={{
                padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: page === 0 ? 'default' : 'pointer',
                border: '1px solid var(--border)', background: 'var(--surface)', color: page === 0 ? 'var(--text-dim)' : 'var(--text-muted)',
                opacity: page === 0 ? 0.4 : 1,
              }}
            >
              ‹ Prev
            </button>
            <span style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600 }}>
              Page {page + 1} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              style={{
                padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                border: '1px solid var(--border)', background: 'var(--surface)', color: page >= totalPages - 1 ? 'var(--text-dim)' : 'var(--text-muted)',
                opacity: page >= totalPages - 1 ? 0.4 : 1,
              }}
            >
              Next ›
            </button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(totalPages - 1)}
              style={{
                padding: '4px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                border: '1px solid var(--border)', background: 'var(--surface)', color: page >= totalPages - 1 ? 'var(--text-dim)' : 'var(--text-muted)',
                opacity: page >= totalPages - 1 ? 0.4 : 1,
              }}
            >
              »»
            </button>
          </div>
        </div>
      )}

      {/* Slide-in drawer for operation detail */}
      {selectedOp && (
        <>
          <div
            onClick={() => setSelectedOp(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 900,
              animation: 'fadeIn .15s ease-out',
            }}
          />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: '55%', minWidth: 480, maxWidth: 800,
            background: 'var(--bg)', borderLeft: '1px solid var(--border)', zIndex: 901,
            overflowY: 'auto', padding: '20px 24px',
            boxShadow: '-8px 0 30px rgba(0,0,0,.3)',
            animation: 'slideInRight .2s ease-out',
          }}>
            {detail?.operation ? (
              <OperationDetail op={detail.operation} logs={detail.logs} phases={detail.phases ?? []} explorerUrl={explorerUrl} onBack={() => setSelectedOp(null)} />
            ) : (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>Loading...</div>
            )}
          </div>
          <style>{`
            @keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
          `}</style>
        </>
      )}
    </div>
  );
}

/* ================================================================
   Operation Detail — side-by-side timeline + details, logs below
   ================================================================ */

function PhaseTimeline({ phases, op }: { phases: any[]; op: any }) {
  if (!phases.length) return null;

  const opStart = op.started_at;
  const opEnd = opStart + (op.duration_ms || 0);
  const opDuration = opEnd - opStart;
  if (opDuration <= 0) return null;

  const formatAbsTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 1 } as any);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-dim)', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>
        <span>{formatAbsTime(opStart)}</span>
        <span>{formatDuration(opDuration)}</span>
        <span>{formatAbsTime(opEnd)}</span>
      </div>

      <div style={{ position: 'relative', background: 'rgba(255,255,255,.03)', borderRadius: 6, border: '1px solid var(--border)', padding: '6px 0' }}>
        {phases.map((p: any, i: number) => {
          const phaseStart = p.started_at ?? opStart;
          const phaseDuration = p.duration_ms ?? 0;
          const left = Math.max(0, ((phaseStart - opStart) / opDuration) * 100);
          const width = Math.max(1.5, (phaseDuration / opDuration) * 100);
          const isError = p.status === 'error';
          const isInProgress = p.status === 'in_progress';
          const color = isError ? '#ef4444' : isInProgress ? '#f59e0b' : PHASE_COLORS[p.phase] ?? '#6b7280';

          return (
            <div key={`${p.phase}-${i}`} style={{ display: 'flex', alignItems: 'center', height: 22, padding: '0 8px', position: 'relative' }}>
              <div style={{ width: 140, minWidth: 140, fontSize: 10, fontWeight: 600, color, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={p.phase}>{p.phase}</div>
              <div style={{ flex: 1, position: 'relative', height: 12 }}>
                <div
                  title={`${p.phase}: ${formatDuration(phaseDuration)}${isError ? ' — FAILED: ' + (p.details ?? '') : ''}`}
                  style={{
                    position: 'absolute', left: `${left}%`, width: `${Math.min(width, 100 - left)}%`,
                    height: '100%', borderRadius: 3, opacity: isInProgress ? 0.7 : 1, transition: 'width .3s ease',
                    background: isError ? 'repeating-linear-gradient(45deg, #ef4444, #ef4444 3px, #b91c1c 3px, #b91c1c 6px)' : color,
                  }}
                />
              </div>
              <div style={{ width: 55, textAlign: 'right', fontSize: 10, color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, marginLeft: 8 }}>
                {formatDuration(phaseDuration)}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 9, color: 'var(--text-dim)' }}>
        {phases.some((p: any) => p.status === 'success') && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: '#22c55e', display: 'inline-block' }} /> Success
          </span>
        )}
        {phases.some((p: any) => p.status === 'error') && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: '#ef4444', display: 'inline-block' }} /> Failed
          </span>
        )}
        {phases.some((p: any) => p.status === 'in_progress') && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: '#f59e0b', display: 'inline-block' }} /> In Progress
          </span>
        )}
      </div>
    </div>
  );
}

function OperationDetail({ op, logs, phases, explorerUrl, onBack }: {
  op: any; logs: any[]; phases: any[]; explorerUrl?: string; onBack: () => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Operation Detail</span>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', padding: 4, display: 'flex' }}
          title="Close"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      {/* Header: Operation metadata as compact inline badges */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{op.operation_name}</span>
          <StatusBadge status={op.status} />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{formatDuration(op.duration_ms)}</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', monospace" }}>{op.operation_id} <CopyButton text={op.operation_id} /></span>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
          <span><b style={{ color: '#9ca3af' }}>Started</b> {new Date(op.started_at).toLocaleString()}</span>
          {op.paranet_id && <span><b style={{ color: '#9ca3af' }}>Paranet</b> {op.paranet_id}</span>}
          {op.triple_count != null && <span><b style={{ color: '#9ca3af' }}>Triples</b> {op.triple_count}</span>}
          {op.peer_id && <span><b style={{ color: '#9ca3af' }}>Peer</b> <span className="mono">{shortId(op.peer_id)}</span></span>}
          {op.gas_cost_eth != null && <span><b style={{ color: '#9ca3af' }}>Gas</b> {op.gas_cost_eth.toFixed(6)} ETH</span>}
          {op.trac_cost != null && <span><b style={{ color: '#9ca3af' }}>TRAC</b> {op.trac_cost.toFixed(4)}</span>}
          {op.tx_hash && (
            <span>
              <b style={{ color: '#9ca3af' }}>TX</b>{' '}
              {explorerUrl ? (
                <a href={`${explorerUrl}/tx/${op.tx_hash}`} target="_blank" rel="noopener noreferrer" className="mono">{shortId(op.tx_hash)}</a>
              ) : <span className="mono">{shortId(op.tx_hash)}</span>}
            </span>
          )}
        </div>
        {op.error_message && (
          <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(239,68,68,.1)', borderRadius: 6, border: '1px solid rgba(239,68,68,.2)', fontSize: 12, color: '#ef4444' }}>
            {op.error_message}
          </div>
        )}
      </div>

      {/* Phase timeline + Phase details */}
      {phases.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>
          <div className="card" style={{ padding: 16 }}>
            <div className="card-title" style={{ marginBottom: 10 }}>Phase Timeline</div>
            <PhaseTimeline phases={phases} op={op} />
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div className="card-title" style={{ marginBottom: 10 }}>Phase Details</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {phases.map((p: any, i: number) => {
                const color = PHASE_COLORS[p.phase] ?? '#9ca3af';
                return (
                  <div key={`${p.phase}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'rgba(255,255,255,.02)', borderRadius: 6, borderLeft: `3px solid ${p.status === 'error' ? '#ef4444' : color}` }}>
                    <span style={{ fontWeight: 600, fontSize: 12, color, minWidth: 65 }}>{p.phase}</span>
                    <StatusBadge status={p.status} />
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: "'JetBrains Mono', monospace" }}>{formatDuration(p.duration_ms)}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto' }}>
                      {p.started_at ? new Date(p.started_at).toLocaleTimeString() : ''}
                    </span>
                    {p.status === 'error' && p.details && (
                      <span style={{ fontSize: 10, color: '#ef4444', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.details}>
                        {p.details}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {phases.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-dim)' }}>
                {PHASE_DESCRIPTIONS[phases[0]?.phase] && (
                  <span title="Phase description">Tip: hover phase bars for details</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Logs below — full width */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="card-title" style={{ margin: 0 }}>Logs ({logs.length})</span>
        </div>
        {logs.length === 0 ? (
          <div className="empty-state" style={{ padding: 24 }}>No logs for this operation</div>
        ) : (
          <LogContainer maxHeight={350}>
            {logs.map((l: any) => (
              <StyledLogEntry key={l.id} ts={l.ts} level={l.level} module={l.module} message={l.message} />
            ))}
          </LogContainer>
        )}
      </div>
    </div>
  );
}

/* ================================================================
   Logs Tab — full daemon.log viewer with auto-refresh
   ================================================================ */

function classifyLine(line: string): 'error' | 'warn' | 'info' {
  if (/\[ERROR\]/.test(line) || /\berror\b/i.test(line.slice(0, 60))) return 'error';
  if (/\[WARN\]/.test(line) || /\bwarn\b/i.test(line.slice(0, 60))) return 'warn';
  return 'info';
}

function LogsTab() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [lineCount, setLineCount] = useState(500);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showLevel, setShowLevel] = useState<'all' | 'warn' | 'error'>('all');
  const [refreshInterval, setRefreshInterval] = useState(3000);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, loading, refresh } = useFetch(
    () => fetchNodeLog({ lines: lineCount, q: debouncedSearch || undefined }),
    [lineCount, debouncedSearch],
    refreshInterval,
  );

  const lines = useMemo(() => {
    if (!data?.lines) return [];
    if (showLevel === 'all') return data.lines;
    return data.lines.filter(l => {
      const cls = classifyLine(l);
      if (showLevel === 'error') return cls === 'error';
      return cls === 'error' || cls === 'warn';
    });
  }, [data?.lines, showLevel]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const highlightSearch = (line: string) => {
    if (!debouncedSearch) return line;
    const idx = line.toLowerCase().indexOf(debouncedSearch.toLowerCase());
    if (idx === -1) return line;
    return (
      <>
        {line.slice(0, idx)}
        <mark style={{ background: '#f59e0b', color: '#000', borderRadius: 2, padding: '0 1px' }}>
          {line.slice(idx, idx + debouncedSearch.length)}
        </mark>
        {line.slice(idx + debouncedSearch.length)}
      </>
    );
  };

  return (
    <div>
      <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          className="input"
          placeholder="Search node log..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <select className="input" value={showLevel} onChange={(e) => setShowLevel(e.target.value as any)}>
          <option value="all">All levels</option>
          <option value="warn">Warnings + Errors</option>
          <option value="error">Errors only</option>
        </select>
        <select className="input" value={lineCount} onChange={(e) => setLineCount(Number(e.target.value))}>
          <option value={200}>200 lines</option>
          <option value={500}>500 lines</option>
          <option value={1000}>1,000 lines</option>
          <option value={3000}>3,000 lines</option>
          <option value={5000}>5,000 lines</option>
        </select>
        <select className="input" value={refreshInterval} onChange={(e) => setRefreshInterval(Number(e.target.value))}>
          <option value={1000}>1s refresh</option>
          <option value={3000}>3s refresh</option>
          <option value={5000}>5s refresh</option>
          <option value={10000}>10s refresh</option>
          <option value={0}>Paused</option>
        </select>
        <button
          onClick={refresh}
          title="Refresh now"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px',
            borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            transition: 'all .15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green)'; e.currentTarget.style.color = 'var(--green)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          Refresh
        </button>
        <button
          onClick={() => setAutoScroll(a => !a)}
          title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
            borderRadius: 6, border: `1px solid ${autoScroll ? 'rgba(74,222,128,.3)' : 'var(--border)'}`,
            background: autoScroll ? 'var(--green-dim)' : 'var(--surface)',
            color: autoScroll ? 'var(--green)' : 'var(--text-muted)',
            fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all .15s',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>
          </svg>
          Auto-scroll
        </button>
      </div>

      <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(139,92,246,.15)', boxShadow: '0 0 40px rgba(139,92,246,.04)' }}>
        <div style={{
          padding: '8px 16px',
          background: 'linear-gradient(135deg, rgba(139,92,246,.08) 0%, rgba(59,130,246,.05) 100%)',
          borderBottom: '1px solid rgba(139,92,246,.12)',
          fontSize: 11, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>
            {lines.length} lines{debouncedSearch ? ` matching "${debouncedSearch}"` : ''}
            {loading ? <span style={{ marginLeft: 6, color: '#8b5cf6', fontSize: 10 }}>refreshing...</span> : ''}
          </span>
          <span className="mono" style={{ fontSize: 10, color: 'rgba(139,92,246,.6)' }}>daemon.log {data?.totalSize ? `(${formatSize(data.totalSize)})` : ''}</span>
        </div>
        <div
          ref={containerRef}
          onScroll={handleScroll}
          style={{
            height: 'calc(100vh - 240px)',
            minHeight: 500,
            overflowY: 'auto',
            padding: '8px 0',
            background: 'linear-gradient(180deg, rgba(13,17,23,1) 0%, rgba(20,15,35,1) 50%, rgba(13,17,23,1) 100%)',
            fontFamily: LOG_FONT,
            fontSize: 10.5,
            lineHeight: 1.5,
          }}
        >
          {lines.length === 0 ? (
            <div className="empty-state" style={{ color: '#8b949e' }}>
              {loading ? 'Loading...' : 'No log lines found'}
            </div>
          ) : (
            lines.map((line, i) => (
              <StyledDaemonLine key={i} line={line} lineNum={i + 1} highlight={debouncedSearch ? highlightSearch : undefined} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   Shared components
   ================================================================ */

const LOG_FONT = '"SF Mono", "Consolas", "Liberation Mono", "Menlo", monospace';
const LOG_COLORS = {
  timestamp: '#6e7681',
  module: '#79c0ff',
  levelError: '#f85149',
  levelWarn: '#d29922',
  levelInfo: '#8b949e',
  message: '#c9d1d9',
  bg: '#0d1117',
};

function StyledLogEntry({ ts, level, module, message }: { ts: number; level: string; module: string; message: string }) {
  const levelColor = level === 'error' ? LOG_COLORS.levelError : level === 'warn' ? LOG_COLORS.levelWarn : LOG_COLORS.levelInfo;
  return (
    <div style={{
      padding: '1px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      background: level === 'error' ? 'rgba(248,81,73,.08)' : undefined,
    }}>
      <span style={{ color: LOG_COLORS.timestamp, marginRight: 6 }}>{formatTime(ts)}</span>
      <span style={{ color: levelColor, fontWeight: 600, marginRight: 6 }}>{level.toUpperCase().padEnd(5)}</span>
      <span style={{ color: LOG_COLORS.module, marginRight: 6 }}>[{module}]</span>
      <span style={{ color: LOG_COLORS.message }}>{message}</span>
    </div>
  );
}

function LogContainer({ children, maxHeight = 300 }: { children: React.ReactNode; maxHeight?: number }) {
  return (
    <div style={{
      maxHeight, overflowY: 'auto', background: LOG_COLORS.bg, borderRadius: 6, padding: '6px 0',
      fontFamily: LOG_FONT, fontSize: 10.5, lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

const DAEMON_LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+) (\S+) \[([^\]]+)\] (.*)$/;

function parseDaemonLogLine(line: string): { ts: string; opName: string; opId: string; module: string; message: string } | null {
  const m = DAEMON_LOG_RE.exec(line);
  if (!m) return null;
  return { ts: m[1], opName: m[2], opId: m[3], module: m[4], message: m[5] };
}

function StyledDaemonLine({ line, lineNum, highlight }: { line: string; lineNum: number; highlight?: (s: string) => React.ReactNode }) {
  const parsed = parseDaemonLogLine(line);
  const cls = classifyLine(line);
  const bg = cls === 'error' ? 'rgba(248,81,73,.08)' : undefined;

  if (!parsed) {
    const color = cls === 'error' ? LOG_COLORS.levelError : cls === 'warn' ? LOG_COLORS.levelWarn : LOG_COLORS.message;
    return (
      <div style={{ padding: '0 16px', color, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: bg }}>
        <span style={{ color: '#484f58', userSelect: 'none', marginRight: 8, display: 'inline-block', width: 40, textAlign: 'right' }}>{lineNum}</span>
        {highlight ? highlight(line) : line}
      </div>
    );
  }

  const opColor = OP_TYPE_COLORS[parsed.opName] ?? '#8b949e';
  return (
    <div style={{ padding: '0 16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: bg }}>
      <span style={{ color: '#484f58', userSelect: 'none', marginRight: 8, display: 'inline-block', width: 40, textAlign: 'right' }}>{lineNum}</span>
      <span style={{ color: LOG_COLORS.timestamp }}>{parsed.ts}</span>{' '}
      <span style={{ color: opColor, fontWeight: 600 }}>{parsed.opName}</span>{' '}
      <span style={{ color: '#484f58' }}>{parsed.opId.slice(0, 8)}</span>{' '}
      <span style={{ color: LOG_COLORS.module }}>[{parsed.module}]</span>{' '}
      <span style={{ color: LOG_COLORS.message }}>{highlight ? highlight(parsed.message) : parsed.message}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'success' ? 'badge-success' : status === 'error' ? 'badge-error' : 'badge-warning';
  return <span className={`badge ${cls}`}>{status}</span>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [text]);
  return (
    <button
      onClick={copy}
      title="Copy to clipboard"
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px',
        color: copied ? 'var(--green)' : 'var(--text-dim)', fontSize: 11,
        display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle',
        transition: 'color .15s',
      }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      )}
    </button>
  );
}

function TxLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
