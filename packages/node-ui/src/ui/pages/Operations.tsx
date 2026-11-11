import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import { useFetch, formatBytes, formatTime, formatDuration, shortId } from '../hooks.js';
import { opTone, opChartColor } from '../op-type-colors.js';
import { Badge, StatusGlyph } from '../components/ds/Badge.js';
import { Button } from '../components/ds/Button.js';
import {
  fetchOperationsWithPhases,
  fetchOperation,
  fetchNodeLog,
  fetchStatus,
  fetchErrorHotspots,
  fetchFailedOperations,
  fetchSuccessRates,
  fetchPerTypeStats,
  fetchMetricsHistory,
  fetchReplicationSummary,
  fetchReplicationPerCg,
  fetchReplicationTimeline,
  fetchReplicationCursors,
  fetchReplicationEvents,
  type ReplicationPerCgRow,
} from '../api.js';
// P-1 review: shared phase palette — single source of truth for
// phase → colour AND the Operations legend. Previously Dashboard
// and Operations kept two independent maps that drifted.
import {
  PHASE_COLORS,
  PHASE_FALLBACK_COLOR,
  PHASE_LEGEND_ENTRIES,
} from '../phase-colors.js';
import { humanizeStatus } from '../lib/formatLabels.js';
import { OperationStatusBadge, operationStatusLabel } from '../components/OperationStatusBadge.js';
import { HW_THRESHOLDS, hardwareChartRow, hardwareLevels, latestHardwareReading, type MetricLevel, type MetricsSnapshot } from './hardware-metrics.js';
import { ArrowDown, ChevronDown, ChevronRight, Check as CheckIcon, Copy, RefreshCw, Activity, ChartColumn, Check, FileText, Search, X } from 'lucide-react';
import { useModalDismiss } from '../components/Modals/useModalDismiss.js';
import { pressable } from '../lib/pressable.js';
import { Loading } from '../components/ds/Loading.js';
import { EmptyState } from '../components/ContextGraphPrimitives.js';
import { formatDateTime } from '../lib/format.js';
import { PageHeader } from '../components/ds/PageHeader.js';
import { StatTile } from '../components/ds/StatTile.js';
import { NetworkConnections } from './Network.js';
import { useObservabilityTab } from '../hooks/useObservabilityTab.js';

const CANCELLED_COLOR = 'var(--border-strong)';

const PHASE_DESCRIPTIONS: Record<string, string> = {
  prepare: 'Partitioning triples, computing Merkle hashes, validating & signing.',
  store: 'Inserting triples into the local triple store and data graph.',
  chain: 'Submitting on-chain tx and waiting for confirmation.',
  // Codex PR #241 review (iter-2): the legend renders one row per
  // entry in `PHASE_LEGEND_ENTRIES`, including the sub-phase
  // `chain:writeahead`. Without a matching description here the
  // hover tooltip came back empty. Describe the boundary explicitly
  // so operators can see what recovery state the WAL entry covers.
  'chain:writeahead': 'Publish/update tx about to hit the wire — recovery window for "broadcast without receipt" crashes.',
  broadcast: 'Broadcasting to network peers via GossipSub.',
  parse: 'Validating and parsing the SPARQL query syntax.',
  execute: 'Running the SPARQL query against the local triple store.',
  transfer: 'Fetching triple pages from the remote peer.',
  verify: 'Verifying Merkle proofs and inserting synced triples.',
};


const OP_TYPE_DESCRIPTIONS: Record<string, string> = {
  publish:        'Publish a Knowledge Asset on-chain to a Context Graph',
  publishFromSWM: 'Publish a Knowledge Asset derived from Shared Working Memory',
  update:         'Update an existing Knowledge Asset on-chain',
  'ka-update':    'Incremental Knowledge Asset update (ka-update path)',
  query:          'Run a SPARQL query against the knowledge graph',
  resolve:        'Resolve a Knowledge Asset from the network',
  workspace:      'Manage shared memory for staging changes',
  connect:        'Establish a connection with a network peer',
  sync:           'Synchronize knowledge data with remote peers',
  share:          'Share Shared Working Memory changes with subscribed peers',
  gossip:         'Propagate updates across the peer-to-peer network via GossipSub',
  reconstruct:    'Reconstruct a Knowledge Asset from distributed shares',
  verify:         'Verify Merkle proofs and assert data integrity',
  init:           'Node or component initialisation sequence',
  system:         'Internal system maintenance operation',
};

const TOOLTIP_STYLE = { background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-control)', fontSize: 'var(--fs-control)', color: 'var(--text-primary)' };

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
    <div className="obs-period">
      <select aria-label="Period"
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
        <input aria-label="Custom period"
          className="input mono obs-period-custom"
          placeholder="e.g. 2d, 45m, 3h"
          value={customInput || (isCustom ? value : '')}
          onChange={e => setCustomInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applyCustom()}
          onBlur={applyCustom}
          autoFocus
        />
      )}
      {isCustom && (
        <span className="obs-meta">{value}</span>
      )}
    </div>
  );
}

export function ObservabilitySection() {
  const [tab, setTab] = useObservabilityTab();

  return (
    <div>
      <div className="tab-group obs-tabs">
        <button aria-pressed={tab === 'operations'} className={`ds-tab ${tab === 'operations' ? 'active' : ''}`} onClick={() => setTab('operations')}>All operations</button>
        <button aria-pressed={tab === 'replication'} className={`ds-tab ${tab === 'replication' ? 'active' : ''}`} onClick={() => setTab('replication')}>Replication</button>
        <button aria-pressed={tab === 'hardware'} className={`ds-tab ${tab === 'hardware' ? 'active' : ''}`} onClick={() => setTab('hardware')}>Hardware</button>
        <button aria-pressed={tab === 'logs'} className={`ds-tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>Logs</button>
        <button aria-pressed={tab === 'errors'} className={`ds-tab ${tab === 'errors' ? 'active' : ''}`} onClick={() => setTab('errors')}>Errors</button>
        <button aria-pressed={tab === 'network'} className={`ds-tab ${tab === 'network' ? 'active' : ''}`} onClick={() => setTab('network')}>Network</button>
      </div>
      {tab === 'network' ? <NetworkConnections /> : tab === 'operations' ? <OperationsTabWithStats /> : tab === 'replication' ? <ReplicationTab /> : tab === 'hardware' ? <HardwareTab /> : tab === 'errors' ? <HealthTab /> : <LogsTab />}
    </div>
  );
}

/* ================================================================
   Replication Tab (chain-driven VM reconciliation) — Phase F
   ================================================================ */

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function ReplicationTab() {
  const [period, setPeriod] = useState('24h');
  const [selectedCg, setSelectedCg] = useState<string | null>(null);
  const periodMs = periodToMs(period);

  const { data: summary } = useFetch(() => fetchReplicationSummary(periodMs), [periodMs], 5_000);
  const { data: perCgData } = useFetch(() => fetchReplicationPerCg(periodMs), [periodMs], 5_000);
  const { data: cursorsData } = useFetch(() => fetchReplicationCursors(), [], 5_000);
  const { data: timelineData } = useFetch(
    () => fetchReplicationTimeline({ periodMs, bucketMs: Math.max(60_000, Math.floor(periodMs / 48)), cg: selectedCg ?? undefined }),
    [periodMs, selectedCg],
    5_000,
  );
  const { data: eventsData } = useFetch(
    () => (selectedCg ? fetchReplicationEvents(selectedCg, 100) : Promise.resolve(null)),
    [selectedCg],
    5_000,
  );

  const perCg: ReplicationPerCgRow[] = perCgData?.rows ?? [];
  const cursors = cursorsData?.cursors ?? [];
  const buckets = (timelineData?.buckets ?? []).map((b) => ({ ...b, t: formatTime(b.bucket) }));
  const events = eventsData?.events ?? [];

  const successPct = summary?.successRate != null ? `${(summary.successRate * 100).toFixed(0)}%` : '—';

  return (
    <div>
      <div className="filters obs-filters-lg">
        <PeriodSelect value={period} onChange={setPeriod} />
        <span className="obs-note">
          Chain-anchored publishes reconciled into Verifiable Memory. Auto-refreshes every 5s.
        </span>
      </div>

      {/* KPI cards */}
      <div className="obs-kpi-grid">
        <StatTile label="Promotions" value={summary?.promotes ?? '—'} sub="Landed in Verifiable Memory this period" />
        <StatTile label="Success rate" value={successPct} sub="Promoted out of all attempts" />
        <StatTile label="Promotion latency" value={fmtMs(summary?.latencyP50Ms)} sub={<>Median · 95th percentile {fmtMs(summary?.latencyP95Ms)}</>} />
        <StatTile label="Active fetches" value={summary?.fetches ?? '—'} sub="Missing Knowledge Assets pulled from Core nodes first" />
      </div>

      {/* Timeline */}
      <div className="card ds-card obs-card obs-section">
        <div className="card-title obs-card-title">
          Reconciliation timeline{selectedCg ? ` — ${selectedCg}` : ' — all Context Graphs'}
        </div>
        {buckets.length === 0 ? (
          <EmptyState compact inline title="No reconciliation activity" description="No chain-driven Verifiable Memory promotions recorded in this period." />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={buckets}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
              <XAxis dataKey="t" tick={{ fontSize: 'var(--fs-label)' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 'var(--fs-label)' }} />
              <Tooltip />
              <Legend />
              <Area type="monotone" dataKey="promotes" stackId="1" stroke="var(--layer-verified)" fill="var(--layer-verified)" fillOpacity={0.55} name="promotes" />
              <Area type="monotone" dataKey="fetches" stackId="1" stroke="var(--text-tertiary)" fill="var(--text-tertiary)" fillOpacity={0.2} name="fetches" />
              <Area type="monotone" dataKey="defers" stackId="1" stroke="var(--text-warning)" fill="var(--text-warning)" fillOpacity={0.45} name="defers" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Cursor inspector */}
      <div className="card ds-card obs-card obs-section">
        <div className="card-title obs-card-title">Cursor inspector</div>
        <p className="obs-lead">
          How far each Context Graph has been promoted to Verifiable Memory, compared with the latest chain head.
        </p>
        {cursors.length === 0 ? (
          <EmptyState compact inline title="No subscriptions" />
        ) : (
          <div className="ds-table-scroll"><table className="data-table">
            <thead><tr><th>Context Graph</th><th>On-chain id</th><th>Role</th><th className="ds-num">Watermark</th><th className="ds-num">Chain head</th><th className="ds-num">Lag</th><th>Last event</th></tr></thead>
            <tbody>
              {cursors.map((c) => {
                const wm = c.last_reconciled_ordinal ?? 0;
                const head = c.last_head ?? null;
                const lag = head != null ? Math.max(0, head - wm) : null;
                return (
                  <tr key={c.context_graph_id}>
                    <td className="mono">{c.context_graph_id}</td>
                    <td className="mono">{c.on_chain_id ?? '—'}</td>
                    <td>{c.core_hosted ? <Badge size="sm" title="Core hosts this public Context Graph and fills its own gaps from the chain">Host</Badge> : <Badge size="sm">Member</Badge>}</td>
                    <td className="ds-num">{wm}</td>
                    <td className="ds-num">{head ?? '—'}</td>
                    <td className="ds-num">{lag == null ? '—' : <Badge tone={lag === 0 ? 'success' : 'warning'} size="sm">{lag}</Badge>}</td>
                    <td>{c.last_event_ts ? formatTime(c.last_event_ts) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>

      {/* Per-CG activity */}
      <div className="card ds-card obs-card obs-section">
        <div className="card-title obs-card-title">Activity by Context Graph</div>
        <p className="obs-lead">Click a row to scope the timeline + open its event stream.</p>
        {perCg.length === 0 ? (
          <EmptyState compact inline title="No activity in this period" />
        ) : (
          <div className="ds-table-scroll"><table className="data-table">
            <thead><tr><th>Context Graph</th><th className="ds-num">Promotes</th><th className="ds-num">Fetches</th><th className="ds-num">Defers</th><th className="ds-num">Cursor moves</th><th className="ds-num">Watermark</th><th>Last event</th></tr></thead>
            <tbody>
              {perCg.map((r) => (
                <tr
                  key={r.context_graph_id}
                  {...pressable(() => setSelectedCg(selectedCg === r.context_graph_id ? null : r.context_graph_id))}
                  className={selectedCg === r.context_graph_id ? 'obs-row-press obs-row-selected' : 'obs-row-press'}
                >
                  <td className="mono">{r.context_graph_id}</td>
                  <td className="ds-num">{r.promotes}</td>
                  <td className="ds-num">{r.fetches}</td>
                  <td className="ds-num">{r.defers}</td>
                  <td className="ds-num">{r.cursor_advances}</td>
                  <td className="ds-num">{r.last_watermark ?? '—'}</td>
                  <td>{r.last_event_ts ? formatTime(r.last_event_ts) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      {/* Event stream drawer */}
      {selectedCg && (
        <div className="card ds-card obs-card">
          <div className="card-title obs-card-title">Event stream — {selectedCg}</div>
          {events.length === 0 ? (
            <EmptyState compact inline title="No events" />
          ) : (
            <div className="ds-table-scroll"><table className="data-table">
              <thead><tr><th>Time</th><th>Action</th><th className="ds-num">Ordinal</th><th className="ds-num">Cursor</th><th>UAL</th><th>Detail</th></tr></thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td>{formatTime(e.ts)}</td>
                    <td><Badge tone={e.action === 'defer' ? 'warning' : 'neutral'} size="sm" className={e.action === 'promote' ? 'obs-promote-badge' : undefined}>{humanizeStatus(String(e.action))}</Badge></td>
                    <td>{e.ordinal ?? '—'}</td>
                    <td className="mono">{e.from_watermark != null && e.to_watermark != null ? `${e.from_watermark}->${e.to_watermark}` : '—'}</td>
                    <td className="mono obs-clip obs-ual" title={e.ual ?? ''}>{e.ual ?? '—'}</td>
                    <td className="mono">{e.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      )}
    </div>
  );
}

export function OperationsPage() {
  return (
    <div className="ds-page">
      <PageHeader title="Observability" description="Track operation performance, phases, and errors" />
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

  const expandedHotspot = expandedPhase ? hotspots.find((_: any) => `${_.operation_name}-${_.phase}` === expandedPhase) : null;
  const { data: failedData } = useFetch(
    () => expandedHotspot ? fetchFailedOperations({ phase: expandedHotspot.phase, operationName: expandedHotspot.operation_name, periodMs, q: search || undefined }) : Promise.resolve(null),
    [expandedPhase, periodMs, search],
    10_000,
  );
  const failedOps = failedData?.operations ?? [];

  return (
    <div>
      <div className="filters obs-filters-lg">
        <PeriodSelect value={period} onChange={setPeriod} />
        <input aria-label="Search errors and operation IDs"
          className="input mono obs-search"
          placeholder="Search errors, operation IDs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="card ds-card obs-card">
        <div className="card-title obs-card-title-tight">Error hotspots</div>
        <p className="obs-lead obs-lead-lg">
          Click a phase to see all failed operations. Click an operation to expand its logs.
        </p>
        {hotspots.length === 0 ? (
          <EmptyState compact inline tone="success" icon={<Check size={16} />} title="No errors in this period" description="All operations completed successfully. Nice work." />
        ) : (
          <div className="ds-table-scroll"><table className="data-table obs-hot-table">
            <thead>
              <tr><th>Operation</th><th>Phase</th><th className="ds-num">Errors</th><th>Last error</th><th>Last occurred</th></tr>
            </thead>
            <tbody>
              {hotspots.map((h: any) => {
                const rowKey = `${h.operation_name}-${h.phase}`;
                return (
                <React.Fragment key={rowKey}>
                  <tr
                    aria-expanded={expandedPhase === rowKey} {...pressable(() => { setExpandedPhase(p => p === rowKey ? null : rowKey); setExpandedOp(null); })}
                    className={expandedPhase === rowKey ? 'obs-row-press obs-row-failed' : 'obs-row-press'}
                  >
                    <td className="obs-hot-op">
                      <span className="obs-hot-chevron">{expandedPhase === rowKey ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                      {h.operation_name}
                    </td>
                    <td className="obs-hot-phase">
                      {h.phase}
                    </td>
                    <td><Badge tone="danger" size="sm">{h.error_count}</Badge></td>
                    <td className="obs-hot-op obs-hot-error obs-clip" title={h.last_error ?? ''}>{h.last_error ?? '—'}</td>
                    <td>{h.last_occurred ? formatTime(h.last_occurred) : '—'}</td>
                  </tr>
                  {expandedPhase === rowKey && (
                    <tr><td colSpan={5} className="obs-hot-expand">
                      <FailedOperationsList
                        operations={failedOps}
                        expandedOp={expandedOp}
                        onToggleOp={(id) => setExpandedOp(o => o === id ? null : id)}
                      />
                    </td></tr>
                  )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

function FailedOperationsList({ operations, expandedOp, onToggleOp }: {
  operations: any[]; expandedOp: string | null; onToggleOp: (id: string) => void;
}) {
  if (operations.length === 0) {
    return <div className="obs-failed-empty">No matching failed operations</div>;
  }

  return (
    <div className="obs-failed-list">
      {operations.map((op: any) => (
        <div key={`${op.operation_id}-${op.phase_started_at}`} className="obs-failed-item">
          <div
            onClick={() => onToggleOp(op.operation_id)}
            className={expandedOp === op.operation_id ? 'obs-failed-head obs-failed-head-open' : 'obs-failed-head'}
          >
            <span className="obs-meta">{expandedOp === op.operation_id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
            <button type="button" className={`ds-row-open obs-failed-name op-tone-${opTone(op.operation_name)}`} aria-expanded={expandedOp === op.operation_id}>{op.operation_name}</button>
            <OperationStatusBadge status={op.status} />
            <span className="mono obs-meta">{op.operation_id} <CopyButton text={op.operation_id} /></span>
            <span className="obs-meta obs-push-end">{formatTime(op.phase_started_at)}</span>
            {op.duration_ms != null && <span className="obs-meta">{formatDuration(op.duration_ms)}</span>}
          </div>

          {expandedOp === op.operation_id && (
            <div className="obs-failed-detail">
              {op.phase_error && (
                <div className="obs-error-note">
                  {op.phase_error}
                </div>
              )}
              {op.error_message && op.error_message !== op.phase_error && (
                <div className="obs-error-note obs-error-note-soft">
                  {op.error_message}
                </div>
              )}
              {op.logs && op.logs.length > 0 ? (
                <LogContainer size="sm">
                  {op.logs.map((l: any) => (
                    <StyledLogEntry key={l.id} ts={l.ts} level={l.level} module={l.module} message={l.message} />
                  ))}
                </LogContainer>
              ) : (
                <div className="obs-failed-nologs">No logs for this operation</div>
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

function OperationsTabWithStats() {
  return (
    <div>
      <OperationStatsSection />
      <OperationsTab />
    </div>
  );
}

function OperationStatsSection() {
  const [period, setPeriod] = useState('3h');
  const [granularity, setGranularity] = useState('0');
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  const pMs = periodToMs(period);
  const bucketMs = granularity === '0' ? undefined : parseInt(granularity, 10);
  const { data: ratesData } = useFetch(() => fetchSuccessRates(pMs), [pMs], 15_000);
  const { data: perType } = useFetch(() => fetchPerTypeStats(pMs, bucketMs), [pMs, bucketMs], 15_000);
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
    return <span className={dimmed ? 'obs-legend-item obs-legend-dimmed' : 'obs-legend-item'}>{value}</span>;
  }, [hiddenSeries]);

  return (
    <div className="obs-section">
      <div className="filters obs-filters-lg">
        <PeriodSelect value={period} onChange={setPeriod} />
        <div className="obs-period">
          <span className="obs-kicker">per</span>
          <select aria-label="Granularity" className="input" value={granularity} onChange={e => setGranularity(e.target.value)}>
            {GRANULARITY_OPTIONS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </div>
      </div>

        <>
          {/* Per-operation-type cards */}
          {rates.length > 0 && (
            <div className="obs-type-grid">
              {rates.map((r: any) => {
                const rateTier = r.rate >= 0.9 ? 'obs-rate-good' : r.rate >= 0.7 ? 'obs-rate-fair' : 'obs-rate-poor';
                return (
                  <div key={r.type} className={`obs-type-card op-tone-${opTone(r.type)} ${rateTier}`}>
                    <div className="obs-type-name">{r.type}</div>
                    <div className="obs-type-stats">
                      <div>
                        <div className="obs-kicker obs-type-label">Operations</div>
                        <div className="obs-type-big">{r.total}</div>
                      </div>
                      <div>
                        <div className="obs-kicker obs-type-label">Success</div>
                        <div className="obs-type-big obs-type-rate">{(r.rate * 100).toFixed(0)}%</div>
                      </div>
                      <div>
                        <div className="obs-kicker obs-type-label">Avg duration</div>
                        <div className="obs-type-mid">{formatDuration(r.avgMs)}</div>
                      </div>
                      <div>
                        <div className="obs-kicker obs-type-label">Errors</div>
                        <div className={r.error > 0 ? 'obs-type-mid obs-type-errors' : 'obs-type-mid obs-type-no-errors'}>{r.error}</div>
                      </div>
                    </div>
                    <div className="obs-type-track">
                      <div className="obs-type-fill" style={{ width: `${r.rate * 100}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Operation charts */}
          {hasCharts ? (
            <div className="obs-chart-grid">
              <div className="card ds-card obs-card-compact">
                <div className="obs-chart-title">Operations over time</div>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={perTypeChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                    <XAxis dataKey="time" tick={{ fontSize: 'var(--fs-micro)', fill: 'var(--text-tertiary)' }} />
                    <YAxis tick={{ fontSize: 'var(--fs-micro)', fill: 'var(--text-tertiary)' }} width={28} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--tint-strong)' }} />
                    <Legend wrapperStyle={{ fontSize: 'var(--fs-micro)' }} onClick={handleLegendClick} formatter={legendFormatter} />
                    {types.map((t: string) => (
                      <Bar key={t} dataKey={`${t}_count`} name={t} stackId="ops" fill={opChartColor(t, types)} fillOpacity={0.75} hide={hiddenSeries.has(t)} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="card ds-card obs-card-compact">
                <div className="obs-chart-title">Avg duration by Operation Type (s)</div>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={perTypeChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                    <XAxis dataKey="time" tick={{ fontSize: 'var(--fs-micro)', fill: 'var(--text-tertiary)' }} />
                    <YAxis tick={{ fontSize: 'var(--fs-micro)', fill: 'var(--text-tertiary)' }} width={32} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 'var(--fs-micro)' }} onClick={handleLegendClick} formatter={legendFormatter} />
                    {types.map((t: string) => (
                      <Area key={t} type="monotone" dataKey={`${t}_avgMs`} name={t} stroke={opChartColor(t, types)} fill={opChartColor(t, types)} fillOpacity={0.1} strokeWidth={2} dot={false} hide={hiddenSeries.has(t)} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="card ds-card obs-card-compact">
                <div className="obs-chart-title">Success Rate by Operation Type (%)</div>
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={perTypeChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                    <XAxis dataKey="time" tick={{ fontSize: 'var(--fs-micro)', fill: 'var(--text-tertiary)' }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 'var(--fs-micro)', fill: 'var(--text-tertiary)' }} width={28} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 'var(--fs-micro)' }} onClick={handleLegendClick} formatter={legendFormatter} />
                    {types.map((t: string) => (
                      <Area key={t} type="monotone" dataKey={`${t}_successPct`} name={t} stroke={opChartColor(t, types)} fill={opChartColor(t, types)} fillOpacity={0.1} strokeWidth={2} dot={false} hide={hiddenSeries.has(t)} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="card ds-card obs-card-compact">
                <div className="obs-chart-title">Gas Cost by Operation Type (ETH)</div>
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={perTypeChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" />
                    <XAxis dataKey="time" tick={{ fontSize: 'var(--fs-micro)', fill: 'var(--text-tertiary)' }} />
                    <YAxis tick={{ fontSize: 'var(--fs-micro)', fill: 'var(--text-tertiary)' }} width={32} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--tint-strong)' }} />
                    <Legend wrapperStyle={{ fontSize: 'var(--fs-micro)' }} onClick={handleLegendClick} formatter={legendFormatter} />
                    {types.map((t: string) => (
                      <Bar key={t} dataKey={`${t}_gas`} name={t} stackId="gas" fill={opChartColor(t, types)} fillOpacity={0.75} hide={hiddenSeries.has(t)} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className="card ds-card obs-section">
              <EmptyState compact inline icon={<ChartColumn size={16} />} title="Not enough data for charts" description="Charts will render once enough operations have been processed." />
            </div>
          )}
        </>
    </div>
  );
}

export function HardwareTab() {
  const [period, setPeriod] = useState('3h');
  const pMs = periodToMs(period);
  const timeFmt = useMemo((): Intl.DateTimeFormatOptions => {
    if (pMs <= 86_400_000) return { hour: '2-digit', minute: '2-digit' };
    return { month: 'short', day: 'numeric', hour: '2-digit' };
  }, [pMs]);

  const { data: hwData } = useFetch(
    () => fetchMetricsHistory(Date.now() - pMs, Date.now(), 200),
    [pMs], 10_000,
  );

  const hwChartData = useMemo(() => (hwData?.snapshots ?? []).map((s: MetricsSnapshot) => hardwareChartRow(s, timeFmt)), [hwData, timeFmt]);
  const hw = useMemo(() => latestHardwareReading(hwData?.snapshots ?? []), [hwData]);

  const loading = !hw;
  type Level = MetricLevel;
  const LEVEL_CLASS: Record<Level, string> = { ok: 'obs-level-ok', warn: 'obs-level-warn', crit: 'obs-level-crit' };
  const hwCard = loading ? 'card ds-card obs-card-compact obs-hw-card obs-hw-waiting' : 'card ds-card obs-card-compact obs-hw-card';
  const TH = HW_THRESHOLDS;
  const levels = hardwareLevels(hw);
  const statCards = [
    { label: 'CPU', value: hw ? `${hw.cpu.toFixed(1)}%` : '—', sub: hw ? 'utilisation' : 'waiting…', pct: hw ? hw.cpu : null, lv: levels.cpu },
    { label: 'RAM', value: hw ? (hw.memPct !== null ? `${hw.memUsedGB} / ${hw.memTotalGB} GB` : 'n/a') : '—', sub: hw ? (hw.memPct !== null ? `${hw.memPct}% used` : 'not reported') : 'waiting…', pct: hw ? hw.memPct : null, lv: levels.mem },
    { label: 'Heap', value: hw ? `${hw.heapMB} MB` : '—', sub: hw ? 'Node.js heap' : 'waiting…', pct: null, lv: 'ok' as Level },
    { label: 'Disk', value: hw ? (hw.diskPct !== null ? `${hw.diskUsedGB} / ${hw.diskTotalGB} GB` : 'n/a') : '—', sub: hw ? (hw.diskPct !== null ? `${hw.diskPct}% used` : 'not configured') : 'waiting…', pct: hw ? hw.diskPct : null, lv: levels.disk },
  ];
  const peersLv = levels.peers;
  const rpcLv = levels.rpc;
  const warnIcon = (lv: Level) => lv === 'ok' ? null : <span role="img" aria-label={lv === 'crit' ? 'critical' : 'warning'} className="obs-hw-warn"><StatusGlyph tone={lv === 'crit' ? 'danger' : 'warning'} /></span>;
  const s1 = 'var(--data-1)';
  const grid = 'var(--border-subtle)', tick = 'var(--text-tertiary)';
  const warnLine = 'var(--text-warning)', critLine = 'var(--text-danger)';
  const hwCharts: Array<{ key: string; title: string; name: string; pct?: boolean; warn?: number; crit?: number }> = [
    { key: 'cpu', title: 'CPU usage (%)', name: 'CPU %', pct: true, warn: TH.cpu[0], crit: TH.cpu[1] },
    { key: 'memPct', title: 'RAM used (%)', name: 'RAM %', pct: true, warn: TH.mem[0], crit: TH.mem[1] },
    { key: 'diskPct', title: 'Disk used (%)', name: 'Disk %', pct: true, warn: TH.disk[0], crit: TH.disk[1] },
    { key: 'heapMB', title: 'Node.js heap (MB)', name: 'Heap MB' },
    { key: 'peers', title: 'Peers', name: 'Peers' },
    { key: 'rpcMs', title: 'RPC latency (ms)', name: 'RPC ms', crit: TH.rpcMs },
  ];

  return (
    <div>
      <div className="filters obs-filters-lg">
        <PeriodSelect value={period} onChange={setPeriod} />
      </div>

      <div className="obs-hw-grid obs-hw-grid-4">
        {statCards.map(stat => (
          <div key={stat.label} className={`${hwCard} ${LEVEL_CLASS[stat.lv]}`}>
            <div className="obs-hw-label">{stat.label}</div>
            <div className="obs-hw-value obs-hw-value-gap">{stat.value}{warnIcon(stat.lv)}</div>
            {stat.pct !== null ? (
              <div className="obs-hw-meter">
                <div className="obs-hw-meter-fill" style={{ width: `${Math.min(stat.pct, 100)}%` }} />
              </div>
            ) : <div className="obs-hw-meter obs-hw-meter-empty" />}
            <div className="obs-meta">{stat.sub}</div>
          </div>
        ))}
      </div>

      <div className="obs-hw-grid obs-hw-grid-2">
        <div className={`${hwCard} ${LEVEL_CLASS[peersLv]}`}>
          <div className="obs-hw-label">Peers</div>
          <div className="obs-hw-value">{hw ? hw.peers : '—'}{warnIcon(peersLv)}</div>
          <div className="obs-meta obs-hw-sub">{hw ? 'connected' : 'waiting…'}</div>
        </div>
        <div className={`${hwCard} ${LEVEL_CLASS[rpcLv]}`}>
          <div className="obs-hw-label">RPC Latency</div>
          <div className="obs-hw-value">
            {hw ? (hw.rpcMs !== null ? `${hw.rpcMs} ms` : '—') : '—'}{warnIcon(rpcLv)}
          </div>
          <div className="obs-meta obs-hw-sub">{hw ? 'last measurement' : 'waiting…'}</div>
        </div>
      </div>

      {hwChartData.length > 1 ? (
        // One unit per chart (no shared or dual axes). Top row: the three
        // percentages on the same 0–100 scale, with their warning thresholds.
        <div className="obs-hw-charts">
          {hwCharts.map(c => (
            <div key={c.key} className="card ds-card obs-card-compact">
              <div className="obs-chart-title">{c.title}</div>
              <ResponsiveContainer width="100%" height={140}>
                <AreaChart data={hwChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={grid} />
                  <XAxis dataKey="time" tick={{ fontSize: 'var(--fs-micro)', fill: tick }} minTickGap={24} />
                  <YAxis domain={c.pct ? [0, 100] : [0, 'auto']} allowDecimals={c.key !== 'peers'} tick={{ fontSize: 'var(--fs-micro)', fill: tick }} width={32} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  {c.warn != null && <ReferenceLine y={c.warn} stroke={warnLine} strokeDasharray="4 4" strokeOpacity={0.6} />}
                  {c.crit != null && <ReferenceLine y={c.crit} stroke={critLine} strokeDasharray="4 4" strokeOpacity={0.6} />}
                  <Area type="monotone" dataKey={c.key} stroke={s1} fill={s1} fillOpacity={0.12} strokeWidth={1.5} dot={false} name={c.name} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ))}
        </div>
      ) : (
        <div className="obs-hw-empty">
          History charts appear after a second snapshot (~30 s)
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Operations Tab
   ================================================================ */

function MiniGantt({ phases, totalMs }: { phases: any[]; totalMs: number }) {
  const [hover, setHover] = useState<number | null>(null);

  if (!phases?.length) return <span className="obs-meta obs-italic">event-based</span>;
  if (totalMs <= 0) return <span className="obs-faint">—</span>;
  const phaseTotal = phases.reduce((s: number, p: any) => s + (p.duration_ms ?? 0), 0) || totalMs;
  return (
    <div className="obs-gantt">
      {/* Phase label pills */}
      <div className="obs-gantt-labels">
        {phases.map((p: any, i: number) => {
          const color = p.status === 'error'
            ? 'var(--text-danger)'
            : p.status === 'cancelled'
              ? CANCELLED_COLOR
              : PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR;
          return (
            <span key={`label-${p.phase}-${i}`} className="obs-gantt-label" style={{ color }}>
              <span className="obs-gantt-dot" />
              {p.phase}
              <span className="obs-gantt-time mono">
                {formatDuration(p.duration_ms)}
              </span>
            </span>
          );
        })}
      </div>
      {/* Gantt bar */}
      <div className="obs-gantt-bar">
        {phases.map((p: any, i: number) => {
          const pct = Math.max(((p.duration_ms ?? 0) / phaseTotal) * 100, 3);
          const color = p.status === 'error'
            ? 'var(--accent-red)'
            : p.status === 'cancelled'
              ? CANCELLED_COLOR
              : PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR;
          return (
            <div
              key={`${p.phase}-${i}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="obs-gantt-seg"
              style={{ width: `${pct}%`, background: color }}
            />
          );
        })}
      </div>
      {hover !== null && phases[hover] && (() => {
        const hoveredPhase = phases[hover].phase;
        const topLevel = hoveredPhase.includes(':') ? hoveredPhase.split(':')[0] : hoveredPhase;
        const desc = PHASE_DESCRIPTIONS[hoveredPhase] ?? PHASE_DESCRIPTIONS[topLevel];
        return (
          <div className="obs-gantt-tip">
            <div className="obs-gantt-tip-line">
              <span className="obs-gantt-tip-name" style={{ color: PHASE_COLORS[hoveredPhase] ?? PHASE_FALLBACK_COLOR }}>
                {hoveredPhase}
              </span>
              <span className="obs-gantt-tip-sep">·</span>
              <span className="mono obs-gantt-tip-time">
                {formatDuration(phases[hover].duration_ms)}
              </span>
              <span className="obs-faint obs-gantt-tip-after">
                ({Math.round(((phases[hover].duration_ms ?? 0) / totalMs) * 100)}%)
              </span>
              {phases[hover].status === 'error' && (
                <span className="obs-gantt-tip-after obs-gantt-tip-failed">FAILED</span>
              )}
              {phases[hover].status === 'cancelled' && (
                <span className="obs-gantt-tip-after obs-gantt-tip-cancelled">CANCELLED</span>
              )}
            </div>
            {desc && (
              <div className="obs-gantt-tip-desc">
                {desc}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

const PAGE_SIZE = 50;

function OperationsTab() {
  const [nameFilter, setNameFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [opIdFilter, setOpIdFilter] = useState('');
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const drawer = useModalDismiss(Boolean(selectedOp), () => setSelectedOp(null));
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
  const explorerUrl = statusData?.blockExplorerUrl ?? undefined;

  const operations = data?.operations ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="filters">
        <select aria-label="Operation type" className="input" value={nameFilter} onChange={(e) => setNameFilter(e.target.value)} title="Filter by operation type">
          <option value="">All types</option>
          {Object.entries(OP_TYPE_DESCRIPTIONS).map(([type, desc]) => (
            <option key={type} value={type} title={desc}>{type} — {desc}</option>
          ))}
        </select>
        <select aria-label="Status" className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="success">{operationStatusLabel('success')}</option>
          <option value="error">{operationStatusLabel('error')}</option>
          <option value="cancelled">{operationStatusLabel('cancelled')}</option>
          <option value="in_progress">{operationStatusLabel('in_progress')}</option>
        </select>
        <input aria-label="Filter by operation ID"
          className="input mono obs-op-id-filter"
          placeholder="Filter by Operation ID..."
          value={opIdFilter}
          onChange={e => setOpIdFilter(e.target.value)}
        />
        <span className="obs-total">{total} total</span>
      </div>

      {/* Phase color legend */}
      <div className="obs-legend">
        <span className="obs-legend-title">Phases</span>
        {PHASE_LEGEND_ENTRIES.map(({ phase, label, color }) => (
          <span
            key={phase}
            title={PHASE_DESCRIPTIONS[phase] ?? ''}
            className="obs-legend-phase"
          >
            <span className="obs-legend-dot" style={{ background: color }} />
            {label}
          </span>
        ))}
      </div>

      <div className="card ds-card">
        {operations.length === 0 ? (
          <EmptyState compact inline icon={<Activity size={16} />} title="No operations recorded" description="Operations will appear here as your node processes publish, query, and other DKG requests." />
        ) : (
          <div className="ds-table-scroll ds-table-pin"><table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Status</th>
                <th>Phases</th>
                <th className="ds-num">Duration</th>
                <th className="ds-num">Cost (ETH)</th>
                <th>TX</th>
                <th>Operation ID</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op: any) => (
                <tr
                  key={op.operation_id}
                  {...pressable(() => setSelectedOp(op.operation_id))}
                  className={selectedOp === op.operation_id ? 'obs-row-press obs-row-open' : 'obs-row-press'}
                >
                  <td title={op.started_at ? formatDateTime(op.started_at, { seconds: true }) : undefined}>{formatTime(op.started_at)}</td>
                  <td><Badge size="sm" title={OP_TYPE_DESCRIPTIONS[op.operation_name] ?? ''} className={`obs-op-badge op-tone-${opTone(op.operation_name)}`}>{op.operation_name}</Badge></td>
                  <td><OperationStatusBadge status={op.status} /></td>
                  <td><MiniGantt phases={op.phases} totalMs={op.duration_ms} /></td>
                  <td className="ds-num">{formatDuration(op.duration_ms)}</td>
                  <td className="ds-num">{op.gas_cost_eth != null ? op.gas_cost_eth.toFixed(6) : '—'}</td>
                  <td>
                    {op.tx_hash ? (
                      <a href={explorerUrl ? `${explorerUrl}/tx/${op.tx_hash}` : '#'} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={op.tx_hash} className="tx-link-icon">
                        <TxLinkIcon />
                      </a>
                    ) : '—'}
                  </td>
                  <td className="mono">{shortId(op.operation_id)} <CopyButton text={op.operation_id} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="obs-pager">
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="obs-pager-buttons">
            <Button size="sm" disabled={page === 0} onClick={() => setPage(0)}>««</Button>
            <Button size="sm" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ Prev</Button>
            <span className="obs-pager-page">
              Page {page + 1} / {totalPages}
            </span>
            <Button size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>Next ›</Button>
            <Button size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>»»</Button>
          </div>
        </div>
      )}

      {/* Slide-in drawer for operation detail */}
      {selectedOp && (
        <>
          <div onClick={drawer.onBackdropClick} className="obs-drawer-scrim" />
          <div ref={drawer.dialogRef} role="dialog" aria-modal="true" aria-label="Operation detail" className="obs-drawer">
            {detail?.operation ? (
              <OperationDetail op={detail.operation} logs={detail.logs} phases={detail.phases ?? []} explorerUrl={explorerUrl} onBack={() => setSelectedOp(null)} />
            ) : (
              <Loading block label="Loading operation…" />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ================================================================
   Operation detail — side-by-side timeline + details, logs below
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
      <div className="obs-tl-range mono">
        <span>{formatAbsTime(opStart)}</span>
        <span>{formatDuration(opDuration)}</span>
        <span>{formatAbsTime(opEnd)}</span>
      </div>

      <div className="obs-tl">
        {phases.map((p: any, i: number) => {
          const phaseStart = p.started_at ?? opStart;
          const phaseDuration = p.duration_ms ?? 0;
          const left = Math.max(0, ((phaseStart - opStart) / opDuration) * 100);
          const width = Math.max(1.5, (phaseDuration / opDuration) * 100);
          const isError = p.status === 'error';
          const isCancelled = p.status === 'cancelled';
          const isInProgress = p.status === 'in_progress';
          const color = isError
            ? 'var(--accent-red)'
            : isCancelled
              ? CANCELLED_COLOR
              : isInProgress
                ? (PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR)
                : PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR;

          return (
            <div key={`${p.phase}-${i}`} className="obs-tl-row">
              <div className="obs-tl-name obs-clip" style={{ color }} title={p.phase}>{p.phase}</div>
              <div className="obs-tl-track">
                <div
                  title={`${p.phase}: ${formatDuration(phaseDuration)}${
                    isError
                      ? ` — FAILED: ${p.details ?? ''}`
                      : isCancelled
                        ? ` — CANCELLED: ${p.details ?? ''}`
                        : ''
                  }`}
                  className={isError ? 'obs-tl-bar obs-tl-bar-failed' : isInProgress ? 'obs-tl-bar obs-tl-bar-active' : 'obs-tl-bar'}
                  style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: isError ? undefined : color }}
                />
              </div>
              <div className="obs-tl-time mono">
                {formatDuration(phaseDuration)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="obs-tl-key">
        {phases.some((p: any) => p.status === 'success') && (
          <span className="obs-tl-key-item">
            <span className="obs-tl-swatch obs-tl-swatch-done" /> Success
          </span>
        )}
        {phases.some((p: any) => p.status === 'error') && (
          <span className="obs-tl-key-item">
            <span className="obs-tl-swatch obs-tl-swatch-failed" /> Failed
          </span>
        )}
        {phases.some((p: any) => p.status === 'cancelled') && (
          <span className="obs-tl-key-item">
            <span className="obs-tl-swatch obs-tl-swatch-cancelled" /> Cancelled
          </span>
        )}
        {phases.some((p: any) => p.status === 'in_progress') && (
          <span className="obs-tl-key-item">
            <span className="obs-tl-swatch obs-tl-swatch-active" /> In Progress
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
      <div className="obs-detail-bar">
        <span className="obs-detail-heading">Operation detail</span>
        <Button variant="ghost" size="sm" icon onClick={onBack} aria-label="Close" title="Close"><X size={14} /></Button>
      </div>

      {/* Header: Operation metadata as compact inline badges */}
      <div className="card ds-card obs-card obs-detail-gap">
        <div className="obs-detail-head">
          <span className="obs-detail-name">{op.operation_name}</span>
          <OperationStatusBadge status={op.status} />
          <span className="obs-detail-duration">{formatDuration(op.duration_ms)}</span>
          <span className="obs-detail-id mono">{op.operation_id} <CopyButton text={op.operation_id} /></span>
        </div>
        <div className="obs-detail-facts">
          <span><b>Started</b> {formatDateTime(op.started_at, { seconds: true })}</span>
          {op.contextGraph_id && <span><b>Context Graph</b> {op.contextGraph_id}</span>}
          {op.triple_count != null && <span><b>Triples</b> {op.triple_count}</span>}
          {op.peer_id && <span><b>Peer</b> <span className="mono">{shortId(op.peer_id)}</span></span>}
          {op.gas_cost_eth != null && <span><b>Gas</b> {op.gas_cost_eth.toFixed(6)} ETH</span>}
          {op.trac_cost != null && <span><b>TRAC</b> {op.trac_cost.toFixed(4)}</span>}
          {op.tx_hash && (
            <span>
              <b>TX</b>{' '}
              {explorerUrl ? (
                <a href={`${explorerUrl}/tx/${op.tx_hash}`} target="_blank" rel="noopener noreferrer" className="mono">{shortId(op.tx_hash)}</a>
              ) : <span className="mono">{shortId(op.tx_hash)}</span>}
            </span>
          )}
        </div>
        {op.error_message && (
          <div className="obs-detail-error">
            {op.error_message}
          </div>
        )}
      </div>

      {/* Phase timeline + Phase details */}
      {phases.length > 0 && (
        <div className="obs-detail-stack obs-detail-gap">
          <div className="card ds-card obs-card">
            <div className="card-title obs-card-title">Phase timeline</div>
            <PhaseTimeline phases={phases} op={op} />
          </div>

          <div className="card ds-card obs-card">
            <div className="card-title obs-card-title">Phase details</div>
            <div className="obs-phase-list">
              {phases.map((p: any, i: number) => {
                const color = PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR;
                const terminalColor = p.status === 'error'
                  ? 'var(--accent-red)'
                  : p.status === 'cancelled'
                    ? CANCELLED_COLOR
                    : color;
                const topLevel = p.phase.includes(':') ? p.phase.split(':')[0] : p.phase;
                // Codex PR #241 iter-6: exact-match first, then fall back
                // to the top-level phase. Same rationale as the bar-hover
                // lookup above — sub-phases like `chain:writeahead` need
                // to surface their own description instead of reducing
                // to the umbrella `chain` entry.
                const desc = PHASE_DESCRIPTIONS[p.phase] ?? PHASE_DESCRIPTIONS[topLevel];
                return (
                  <div key={`${p.phase}-${i}`} className="obs-phase-row" style={{ borderLeftColor: terminalColor }}>
                    <span className="obs-phase-name" style={{ color }} title={desc ?? ''}>{p.phase}</span>
                    <OperationStatusBadge status={p.status} />
                    <span className="obs-detail-id mono">{formatDuration(p.duration_ms)}</span>
                    {desc && <span className="obs-meta obs-italic obs-phase-desc obs-clip">{desc}</span>}
                    <span
                      className="obs-meta obs-push-end obs-phase-time"
                      title={p.started_at ? formatDateTime(p.started_at, { seconds: true }) : undefined}
                    >
                      {p.started_at ? formatTime(p.started_at) : ''}
                    </span>
                    {(p.status === 'error' || p.status === 'cancelled') && p.details && (
                      <span className="obs-phase-details obs-clip" style={{ color: terminalColor }} title={p.details}>
                        {p.details}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Logs below — full width */}
      <div className="card ds-card">
        <div className="obs-detail-logs-head">
          <span className="card-title">Logs ({logs.length})</span>
        </div>
        {logs.length === 0 ? (
          <EmptyState compact inline icon={<FileText size={16} />} title="No logs available" description="This operation has no log entries recorded." />
        ) : (
          <LogContainer size="lg">
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


  const highlightSearch = (line: string) => {
    if (!debouncedSearch) return line;
    const idx = line.toLowerCase().indexOf(debouncedSearch.toLowerCase());
    if (idx === -1) return line;
    return (
      <>
        {line.slice(0, idx)}
        <mark className="obs-log-match">
          {line.slice(idx, idx + debouncedSearch.length)}
        </mark>
        {line.slice(idx + debouncedSearch.length)}
      </>
    );
  };

  return (
    <div>
      <div className="filters">
        <input aria-label="Search node log"
          className="input obs-search"
          placeholder="Search node log..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select aria-label="Log level" className="input" value={showLevel} onChange={(e) => setShowLevel(e.target.value as any)}>
          <option value="all">All levels</option>
          <option value="warn">Warnings + Errors</option>
          <option value="error">Errors only</option>
        </select>
        <select aria-label="Line count" className="input" value={lineCount} onChange={(e) => setLineCount(Number(e.target.value))}>
          <option value={200}>200 lines</option>
          <option value={500}>500 lines</option>
          <option value={1000}>1,000 lines</option>
          <option value={3000}>3,000 lines</option>
          <option value={5000}>5,000 lines</option>
        </select>
        <select aria-label="Refresh interval" className="input" value={refreshInterval} onChange={(e) => setRefreshInterval(Number(e.target.value))}>
          <option value={1000}>1s refresh</option>
          <option value={3000}>3s refresh</option>
          <option value={5000}>5s refresh</option>
          <option value={10000}>10s refresh</option>
          <option value={0}>Paused</option>
        </select>
        <Button onClick={refresh} title="Refresh now">
          <RefreshCw size={12} />
          Refresh
        </Button>
        <button
          type="button"
          className="ds-filter obs-autoscroll"
          aria-pressed={autoScroll}
          onClick={() => setAutoScroll(a => !a)}
          title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
        >
          <ArrowDown size={12} />
          Auto-scroll
        </button>
      </div>

      <div className="obs-log-panel">
        <div className="obs-log-head">
          <span>
            {lines.length} lines{debouncedSearch ? ` matching "${debouncedSearch}"` : ''}
            {loading ? <span className="obs-meta obs-log-refreshing">refreshing...</span> : ''}
          </span>
          <span className="mono obs-meta">daemon.log {data?.totalSize ? `(${formatBytes(data.totalSize)})` : ''}</span>
        </div>
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="obs-log obs-log-full"
        >
          {lines.length === 0 ? (
            loading
              ? <Loading block label="Loading log lines…" />
              : <EmptyState compact inline icon={<Search size={16} />} title="No log lines found" description="Try adjusting the search filters or check back later." />
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

const LOG_LEVEL_CLASS: Record<string, string> = { error: 'obs-log-error', warn: 'obs-log-warn' };

function StyledLogEntry({ ts, level, module, message }: { ts: number; level: string; module: string; message: string }) {
  return (
    <div className={level === 'error' ? 'obs-log-entry obs-log-entry-error' : 'obs-log-entry'}>
      <span className="obs-log-ts obs-log-gap">{formatTime(ts)}</span>
      <span className={`obs-log-level obs-log-gap ${LOG_LEVEL_CLASS[level] ?? 'obs-log-info'}`}>{level.toUpperCase().padEnd(5)}</span>
      <span className="obs-log-module obs-log-gap">[{module}]</span>
      <span className="obs-log-text">{message}</span>
    </div>
  );
}

function LogContainer({ children, size }: { children: React.ReactNode; size: 'sm' | 'lg' }) {
  return <div className={size === 'sm' ? 'obs-log obs-log-sm' : 'obs-log obs-log-lg'}>{children}</div>;
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
  const lineClass = cls === 'error' ? 'obs-log-line obs-log-line-error' : 'obs-log-line';

  if (!parsed) {
    return (
      <div className={`${lineClass} ${LOG_LEVEL_CLASS[cls] ?? 'obs-log-text'}`}>
        <span className="obs-log-num">{lineNum}</span>
        {highlight ? highlight(line) : line}
      </div>
    );
  }

  return (
    <div className={lineClass}>
      <span className="obs-log-num">{lineNum}</span>
      <span className="obs-log-ts">{parsed.ts}</span>{' '}
      <span className={`obs-log-op op-tone-${opTone(parsed.opName)}`}>{parsed.opName}</span>{' '}
      <span className="obs-faint">{parsed.opId.slice(0, 8)}</span>{' '}
      <span className="obs-log-module">[{parsed.module}]</span>{' '}
      <span className="obs-log-text">{highlight ? highlight(parsed.message) : parsed.message}</span>
    </div>
  );
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
    <Button variant="ghost" size="sm" icon onClick={copy} className={copied ? 'obs-copy obs-copy-done' : 'obs-copy'} title="Copy to clipboard" aria-label="Copy to clipboard">
      {copied ? <CheckIcon size={12} /> : <Copy size={12} />}
    </Button>
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
