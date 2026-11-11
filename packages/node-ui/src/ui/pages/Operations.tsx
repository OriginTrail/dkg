import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { useFetch, formatTime, formatDuration, shortId } from '../hooks.js';
import { opTypeText, opTypeBg, opTypeRule, opChartColor } from '../op-type-colors.js';
import { Badge } from '../components/ds/Badge.js';
import {
  fetchOperationsWithPhases, fetchOperation, fetchNodeLog,
  fetchOperationStats, fetchStatus, fetchErrorHotspots, fetchFailedOperations,
  fetchSuccessRates, fetchPerTypeStats, fetchMetricsHistory,
  fetchReplicationSummary, fetchReplicationPerCg, fetchReplicationTimeline,
  fetchReplicationCursors, fetchReplicationEvents,
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
  publish:        'Publish a Knowledge Asset on-chain to a context graph',
  publishFromSWM: 'Publish a Knowledge Asset derived from Shared Working Memory',
  update:         'Update an existing Knowledge Asset on-chain',
  'ka-update':    'Incremental Knowledge Asset update (ka-update path)',
  query:          'Run a SPARQL query against the knowledge graph',
  resolve:        'Resolve a Knowledge Asset from the network',
  workspace:      'Manage shared memory for staging changes',
  connect:        'Establish a connection with a network peer',
  sync:           'Synchronize knowledge data with remote peers',
  share:          'Share a SWM delta with subscribed peers',
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
        <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)' }}>{value}</span>
      )}
    </div>
  );
}

export function ObservabilitySection() {
  const [tab, setTab] = useState<'operations' | 'replication' | 'hardware' | 'logs' | 'errors'>('operations');

  return (
    <div>
      <div className="tab-group" style={{ marginBottom: 16 }}>
        <button className={`ds-tab ${tab === 'operations' ? 'active' : ''}`} onClick={() => setTab('operations')}>All operations</button>
        <button className={`ds-tab ${tab === 'replication' ? 'active' : ''}`} onClick={() => setTab('replication')}>Replication</button>
        <button className={`ds-tab ${tab === 'hardware' ? 'active' : ''}`} onClick={() => setTab('hardware')}>Hardware</button>
        <button className={`ds-tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>Logs</button>
        <button className={`ds-tab ${tab === 'errors' ? 'active' : ''}`} onClick={() => setTab('errors')}>Errors</button>
      </div>
      {tab === 'operations' ? <OperationsTabWithStats /> : tab === 'replication' ? <ReplicationTab /> : tab === 'hardware' ? <HardwareTab /> : tab === 'errors' ? <HealthTab /> : <LogsTab />}
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
      <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <PeriodSelect value={period} onChange={setPeriod} />
        <span style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)' }}>
          Chain-anchored publishes reconciled into Verifiable Memory. Auto-refreshes every 5s.
        </span>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div className="card ds-card" style={{ padding: 16 }}>
          <div className="card-title">Promotions</div>
          <div style={{ fontSize: 'var(--fs-display)', fontWeight: 600 }}>{summary?.promotes ?? '—'}</div>
          <div style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)' }}>landed in VM this period</div>
        </div>
        <div className="card ds-card" style={{ padding: 16 }}>
          <div className="card-title">Success rate</div>
          <div style={{ fontSize: 'var(--fs-display)', fontWeight: 600 }}>{successPct}</div>
          <div style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)' }}>promote / (promote + defer)</div>
        </div>
        <div className="card ds-card" style={{ padding: 16 }}>
          <div className="card-title">Promotion latency</div>
          <div style={{ fontSize: 'var(--fs-display)', fontWeight: 600 }}>{fmtMs(summary?.latencyP50Ms)}</div>
          <div style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)' }}>P50 · P95 {fmtMs(summary?.latencyP95Ms)}</div>
        </div>
        <div className="card ds-card" style={{ padding: 16 }}>
          <div className="card-title">Active fetches</div>
          <div style={{ fontSize: 'var(--fs-display)', fontWeight: 600 }}>{summary?.fetches ?? '—'}</div>
          <div style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)' }}>core-first catch-up pulls</div>
        </div>
      </div>

      {/* Timeline */}
      <div className="card ds-card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>
          Reconciliation timeline{selectedCg ? ` — ${selectedCg}` : ' — all CGs'}
        </div>
        {buckets.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state-title">No reconciliation activity</div>
            <div className="empty-state-desc">No chain-driven VM promotions recorded in this period.</div>
          </div>
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
      <div className="card ds-card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Cursor inspector</div>
        <p style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)', marginBottom: 12 }}>
          Per-CG persisted watermark (contiguous registration ordinal promoted to VM) vs. last observed chain head.
        </p>
        {cursors.length === 0 ? (
          <div className="empty-state empty-state--compact"><div className="empty-state-title">No subscriptions</div></div>
        ) : (
          <div className="ds-table-scroll"><table className="data-table">
            <thead><tr><th>Context graph</th><th>On-chain id</th><th>Role</th><th>Watermark</th><th>Chain head</th><th>Lag</th><th>Last event</th></tr></thead>
            <tbody>
              {cursors.map((c) => {
                const wm = c.last_reconciled_ordinal ?? 0;
                const head = c.last_head ?? null;
                const lag = head != null ? Math.max(0, head - wm) : null;
                return (
                  <tr key={c.context_graph_id}>
                    <td className="mono">{c.context_graph_id}</td>
                    <td className="mono">{c.on_chain_id ?? '—'}</td>
                    <td>{c.core_hosted ? <Badge size="sm" title="Core hosts this public CG; fills its own gaps from chain (Phase D)">Host</Badge> : <Badge size="sm">Member</Badge>}</td>
                    <td>{wm}</td>
                    <td>{head ?? '—'}</td>
                    <td>{lag == null ? '—' : <Badge tone={lag === 0 ? 'success' : 'warning'} size="sm">{lag}</Badge>}</td>
                    <td>{c.last_event_ts ? formatTime(c.last_event_ts) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>

      {/* Per-CG activity */}
      <div className="card ds-card" style={{ padding: 16, marginBottom: 16 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Per-CG activity</div>
        <p style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)', marginBottom: 12 }}>Click a row to scope the timeline + open its event stream.</p>
        {perCg.length === 0 ? (
          <div className="empty-state empty-state--compact"><div className="empty-state-title">No activity in this period</div></div>
        ) : (
          <div className="ds-table-scroll"><table className="data-table">
            <thead><tr><th>Context graph</th><th>Promotes</th><th>Fetches</th><th>Defers</th><th>Cursor moves</th><th>Watermark</th><th>Last event</th></tr></thead>
            <tbody>
              {perCg.map((r) => (
                <tr
                  key={r.context_graph_id}
                  onClick={() => setSelectedCg(selectedCg === r.context_graph_id ? null : r.context_graph_id)}
                  style={{ cursor: 'pointer', background: selectedCg === r.context_graph_id ? 'var(--bg-hover)' : undefined }}
                >
                  <td className="mono">{r.context_graph_id}</td>
                  <td>{r.promotes}</td>
                  <td>{r.fetches}</td>
                  <td>{r.defers}</td>
                  <td>{r.cursor_advances}</td>
                  <td>{r.last_watermark ?? '—'}</td>
                  <td>{r.last_event_ts ? formatTime(r.last_event_ts) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      {/* Event stream drawer */}
      {selectedCg && (
        <div className="card ds-card" style={{ padding: 16 }}>
          <div className="card-title" style={{ marginBottom: 8 }}>Event stream — {selectedCg}</div>
          {events.length === 0 ? (
            <div className="empty-state empty-state--compact"><div className="empty-state-title">No events</div></div>
          ) : (
            <div className="ds-table-scroll"><table className="data-table">
              <thead><tr><th>Time</th><th>Action</th><th>Ordinal</th><th>Cursor</th><th>UAL</th><th>Detail</th></tr></thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td>{formatTime(e.ts)}</td>
                    <td><Badge tone={e.action === 'defer' ? 'warning' : 'neutral'} size="sm" style={e.action === 'promote' ? { background: 'var(--layer-verified-bg)', color: 'var(--layer-verified-text)', boxShadow: 'none' } : undefined}>{humanizeStatus(String(e.action))}</Badge></td>
                    <td>{e.ordinal ?? '—'}</td>
                    <td className="mono">{e.from_watermark != null && e.to_watermark != null ? `${e.from_watermark}->${e.to_watermark}` : '—'}</td>
                    <td className="mono" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.ual ?? ''}>{e.ual ?? '—'}</td>
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
    <div className="page-section">
      <h1 className="page-title" style={{ marginBottom: 4 }}>Observability</h1>
      <p style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)', marginBottom: 20 }}>Track operation performance, phases, and errors</p>
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

      <div className="card ds-card" style={{ padding: 16 }}>
        <div className="card-title" style={{ marginBottom: 4 }}>Error hotspots</div>
        <p style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
          Click a phase to see all failed operations. Click an operation to expand its logs.
        </p>
        {hotspots.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state-icon" style={{ background: 'var(--success-bg)', borderColor: 'var(--success-border)' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <div className="empty-state-title" style={{ color: 'var(--accent-green)' }}>No errors in this period</div>
            <div className="empty-state-desc">All operations completed successfully. Nice work.</div>
          </div>
        ) : (
          <div className="ds-table-scroll"><table className="data-table">
            <thead>
              <tr><th>Operation</th><th>Phase</th><th>Errors</th><th>Last error</th><th>Last occurred</th></tr>
            </thead>
            <tbody>
              {hotspots.map((h: any) => {
                const rowKey = `${h.operation_name}-${h.phase}`;
                return (
                <React.Fragment key={rowKey}>
                  <tr
                    onClick={() => { setExpandedPhase(p => p === rowKey ? null : rowKey); setExpandedOp(null); }}
                    style={{ cursor: 'pointer', background: expandedPhase === rowKey ? 'var(--danger-bg)' : undefined }}
                  >
                    <td style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)', padding: '10px 14px' }}>
                      <span style={{ marginRight: 6, fontSize: 'var(--fs-micro)' }}>{expandedPhase === rowKey ? '▼' : '▸'}</span>
                      {h.operation_name}
                    </td>
                    <td style={{ color: 'var(--text-primary)', fontWeight: 600, padding: '10px 14px' }}>
                      {h.phase}
                    </td>
                    <td style={{ padding: '10px 14px' }}><Badge tone="danger" size="sm">{h.error_count}</Badge></td>
                    <td style={{ fontSize: 'var(--fs-control)', color: 'var(--text-secondary)', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '10px 14px' }} title={h.last_error ?? ''}>{h.last_error ?? '—'}</td>
                    <td style={{ padding: '10px 14px' }}>{h.last_occurred ? formatTime(h.last_occurred) : '—'}</td>
                  </tr>
                  {expandedPhase === rowKey && (
                    <tr><td colSpan={5} style={{ padding: 0, background: 'var(--shade)' }}>
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
    return <div style={{ padding: '12px 16px', fontSize: 'var(--fs-label)', color: 'var(--text-secondary)' }}>No matching failed operations</div>;
  }

  return (
    <div style={{ padding: '8px 0' }}>
      {operations.map((op: any) => (
        <div key={`${op.operation_id}-${op.phase_started_at}`} style={{ borderBottom: '1px solid var(--border-default)' }}>
          <div
            onClick={() => onToggleOp(op.operation_id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', cursor: 'pointer',
              background: expandedOp === op.operation_id ? 'var(--danger-bg)' : undefined,
            }}
          >
            <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)' }}>{expandedOp === op.operation_id ? '▼' : '▸'}</span>
            <span style={{ fontWeight: 600, fontSize: 'var(--fs-control)', color: opTypeText(op.operation_name) }}>{op.operation_name}</span>
            <OperationStatusBadge status={op.status} />
            <span className="mono" style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)' }}>{op.operation_id} <CopyButton text={op.operation_id} /></span>
            <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{formatTime(op.phase_started_at)}</span>
            {op.duration_ms != null && <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)' }}>{formatDuration(op.duration_ms)}</span>}
          </div>

          {expandedOp === op.operation_id && (
            <div style={{ padding: '4px 20px 16px' }}>
              {op.phase_error && (
                <div style={{ padding: '6px 10px', marginBottom: 8, background: 'var(--danger-bg)', borderRadius: 'var(--radius-control)', border: '1px solid var(--danger-border)', fontSize: 'var(--fs-label)', color: 'var(--accent-red)' }}>
                  {op.phase_error}
                </div>
              )}
              {op.error_message && op.error_message !== op.phase_error && (
                <div style={{ padding: '6px 10px', marginBottom: 8, background: 'var(--danger-bg)', borderRadius: 'var(--radius-control)', border: '1px solid var(--danger-bg-strong)', fontSize: 'var(--fs-label)', color: 'var(--accent-red)' }}>
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
                <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-tertiary)', padding: '4px 0' }}>No logs for this operation</div>
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
    return <span style={{ color: dimmed ? 'var(--text-tertiary)' : undefined, textDecoration: dimmed ? 'line-through' : undefined, cursor: 'pointer' }}>{value}</span>;
  }, [hiddenSeries]);

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <PeriodSelect value={period} onChange={setPeriod} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>per</span>
          <select className="input" value={granularity} onChange={e => setGranularity(e.target.value)} style={{ width: 'auto' }}>
            {GRANULARITY_OPTIONS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </div>
      </div>

        <>
          {/* Per-operation-type cards */}
          {rates.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 16 }}>
              {rates.map((r: any) => {
                const color = opTypeText(r.type);
                const rateColor = r.rate >= 0.9 ? 'var(--accent-green)' : r.rate >= 0.7 ? 'var(--accent-amber)' : 'var(--accent-red)';
                return (
                  <div key={r.type} style={{ background: 'var(--tint-subtle)', borderRadius: 'var(--radius-nested)', padding: '12px 14px', border: '1px solid var(--border-default)', borderLeft: `3px solid ${opTypeRule(r.type)}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 'var(--fs-body)', fontWeight: 700, color }}>{r.type}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px', fontSize: 'var(--fs-label)' }}>
                      <div>
                        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-micro)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Operations</div>
                        <div style={{ fontWeight: 700, fontSize: 'var(--fs-title)' }}>{r.total}</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-micro)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Success</div>
                        <div style={{ fontWeight: 700, fontSize: 'var(--fs-title)', color: rateColor }}>{(r.rate * 100).toFixed(0)}%</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-micro)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Avg duration</div>
                        <div style={{ fontWeight: 600, fontSize: 'var(--fs-body)' }}>{formatDuration(r.avgMs)}</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-micro)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>Errors</div>
                        <div style={{ fontWeight: 600, fontSize: 'var(--fs-body)', color: r.error > 0 ? 'var(--accent-red)' : 'var(--text-tertiary)' }}>{r.error}</div>
                      </div>
                    </div>
                    <div style={{ height: 3, background: 'var(--tint-strong)', borderRadius: 'var(--radius-hair)', overflow: 'hidden', marginTop: 10 }}>
                      <div style={{ height: '100%', width: `${r.rate * 100}%`, background: rateColor, borderRadius: 'var(--radius-hair)' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Operation charts */}
          {hasCharts ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div className="card ds-card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 'var(--fs-label)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Operations over time</div>
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

              <div className="card ds-card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 'var(--fs-label)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Avg duration by Operation Type (s)</div>
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

              <div className="card ds-card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 'var(--fs-label)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Success Rate by Operation Type (%)</div>
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

              <div className="card ds-card" style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 'var(--fs-label)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Gas Cost by Operation Type (ETH)</div>
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
            <div className="card ds-card" style={{ marginBottom: 14 }}>
              <div className="empty-state empty-state--compact">
                <div className="empty-state-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                </div>
                <div className="empty-state-title">Not enough data for charts</div>
                <div className="empty-state-desc">Charts will render once enough operations have been processed.</div>
              </div>
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
  const LEVEL_COLOR: Record<Level, string> = { ok: 'var(--data-1)', warn: 'var(--text-warning)', crit: 'var(--text-danger)' };
  const LEVEL_TEXT: Record<Level, string> = { ok: 'var(--text-primary)', warn: 'var(--text-warning)', crit: 'var(--text-danger)' };
  const IDLE = 'var(--text-tertiary)';
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
  const warnIcon = (lv: Level) => lv === 'ok' ? null : <span aria-label={lv === 'crit' ? 'critical' : 'warning'} style={{ marginLeft: 6, fontSize: 'var(--fs-body)' }}>⚠</span>;
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
      <div className="filters" style={{ marginBottom: 16 }}>
        <PeriodSelect value={period} onChange={setPeriod} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
        {statCards.map(stat => (
          <div key={stat.label} className="card ds-card" style={{ padding: '10px 12px', opacity: loading ? 0.5 : 1, transition: 'opacity .3s' }}>
            <div style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{stat.label}</div>
            <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 700, color: hw ? LEVEL_TEXT[stat.lv] : IDLE, lineHeight: 1, marginBottom: 3 }}>{stat.value}{warnIcon(stat.lv)}</div>
            {stat.pct !== null ? (
              <div style={{ height: 3, background: 'var(--bg-elevated)', borderRadius: 'var(--radius-hair)', margin: '5px 0 3px' }}>
                <div style={{ height: 3, width: `${Math.min(stat.pct, 100)}%`, background: LEVEL_COLOR[stat.lv], borderRadius: 'var(--radius-hair)', transition: 'width .4s ease' }} />
              </div>
            ) : <div style={{ height: 3, margin: '5px 0 3px' }} />}
            <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)' }}>{stat.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 12 }}>
        <div className="card ds-card" style={{ padding: '10px 12px', opacity: loading ? 0.5 : 1, transition: 'opacity .3s' }}>
          <div style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Peers</div>
          <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 700, color: hw ? LEVEL_TEXT[peersLv] : IDLE, lineHeight: 1 }}>{hw ? hw.peers : '—'}{warnIcon(peersLv)}</div>
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', marginTop: 3 }}>{hw ? 'connected' : 'waiting…'}</div>
        </div>
        <div className="card ds-card" style={{ padding: '10px 12px', opacity: loading ? 0.5 : 1, transition: 'opacity .3s' }}>
          <div style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>RPC Latency</div>
          <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 700, color: hw ? LEVEL_TEXT[rpcLv] : IDLE, lineHeight: 1 }}>
            {hw ? (hw.rpcMs !== null ? `${hw.rpcMs} ms` : '—') : '—'}{warnIcon(rpcLv)}
          </div>
          <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', marginTop: 3 }}>{hw ? 'last measurement' : 'waiting…'}</div>
        </div>
      </div>

      {hwChartData.length > 1 ? (
        // One unit per chart (no shared or dual axes). Top row: the three
        // percentages on the same 0–100 scale, with their warning thresholds.
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
          {hwCharts.map(c => (
            <div key={c.key} className="card ds-card" style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 'var(--fs-label)', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>{c.title}</div>
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
        <div style={{ fontSize: 'var(--fs-label)', color: 'var(--text-tertiary)', textAlign: 'center', padding: '8px 0' }}>
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

  if (!phases?.length) return <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>event-based</span>;
  if (totalMs <= 0) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  const phaseTotal = phases.reduce((s: number, p: any) => s + (p.duration_ms ?? 0), 0) || totalMs;
  return (
    <div style={{ position: 'relative', minWidth: 120, maxWidth: 260 }}>
      {/* Phase label pills */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 3, flexWrap: 'wrap' }}>
        {phases.map((p: any, i: number) => {
          const color = p.status === 'error'
            ? 'var(--accent-red)'
            : p.status === 'cancelled'
              ? CANCELLED_COLOR
              : PHASE_COLORS[p.phase] ?? PHASE_FALLBACK_COLOR;
          return (
            <span key={`label-${p.phase}-${i}`} style={{
              fontSize: 'var(--fs-micro)', fontWeight: 600, color, letterSpacing: '.02em',
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
              {p.phase}
              <span style={{ fontWeight: 400, color: 'var(--text-tertiary)', fontFamily: "'JetBrains Mono', monospace" }}>
                {formatDuration(p.duration_ms)}
              </span>
            </span>
          );
        })}
      </div>
      {/* Gantt bar */}
      <div style={{ display: 'flex', gap: 2, height: 10, borderRadius: 'var(--radius-hair)', overflow: 'hidden', background: 'transparent' }}>
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
              style={{
                width: `${pct}%`, background: color, minWidth: 3,
                opacity: 1,
                transition: 'opacity .15s, width .2s',
                cursor: 'default',
              }}
            />
          );
        })}
      </div>
      {hover !== null && phases[hover] && (() => {
        const hoveredPhase = phases[hover].phase;
        const topLevel = hoveredPhase.includes(':') ? hoveredPhase.split(':')[0] : hoveredPhase;
        const desc = PHASE_DESCRIPTIONS[hoveredPhase] ?? PHASE_DESCRIPTIONS[topLevel];
        return (
          <div style={{
            position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
            marginBottom: 6, padding: '5px 10px', borderRadius: 'var(--radius-control)',
            background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
            boxShadow: 'var(--shadow-menu)',
            fontSize: 'var(--fs-label)', zIndex: 10, pointerEvents: 'none',
            maxWidth: 260,
          }}>
            <div style={{ whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: 700, color: PHASE_COLORS[hoveredPhase] ?? PHASE_FALLBACK_COLOR }}>
                {hoveredPhase}
              </span>
              <span style={{ color: 'var(--text-secondary)', margin: '0 6px' }}>·</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-primary)' }}>
                {formatDuration(phases[hover].duration_ms)}
              </span>
              <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>
                ({Math.round(((phases[hover].duration_ms ?? 0) / totalMs) * 100)}%)
              </span>
              {phases[hover].status === 'error' && (
                <span style={{ color: 'var(--accent-red)', marginLeft: 6, fontWeight: 600 }}>FAILED</span>
              )}
              {phases[hover].status === 'cancelled' && (
                <span style={{ color: CANCELLED_COLOR, marginLeft: 6, fontWeight: 600 }}>CANCELLED</span>
              )}
            </div>
            {desc && (
              <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-secondary)', marginTop: 3, whiteSpace: 'normal', lineHeight: 1.4 }}>
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
      <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <select className="input" value={nameFilter} onChange={(e) => setNameFilter(e.target.value)} title="Filter by operation type">
          <option value="">All types</option>
          {Object.entries(OP_TYPE_DESCRIPTIONS).map(([type, desc]) => (
            <option key={type} value={type} title={desc}>{type} — {desc}</option>
          ))}
        </select>
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="success">{operationStatusLabel('success')}</option>
          <option value="error">{operationStatusLabel('error')}</option>
          <option value="cancelled">{operationStatusLabel('cancelled')}</option>
          <option value="in_progress">{operationStatusLabel('in_progress')}</option>
        </select>
        <input
          className="input mono"
          placeholder="Filter by Operation ID..."
          value={opIdFilter}
          onChange={e => setOpIdFilter(e.target.value)}
          style={{ flex: '1 1 200px', minWidth: 0 }}
        />
        <span style={{ fontSize: 'var(--fs-label)', color: 'var(--text-tertiary)' }}>{total} total</span>
      </div>

      {/* Phase color legend */}
      <div style={{
        display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10,
        padding: '6px 12px', borderRadius: 'var(--radius-control)',
        background: 'var(--tint-faint)', border: '1px solid var(--border-default)',
        fontSize: 'var(--fs-micro)', color: 'var(--text-secondary)', alignItems: 'center',
      }}>
        <span style={{ fontSize: 'var(--fs-micro)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginRight: 2 }}>Phases</span>
        {PHASE_LEGEND_ENTRIES.map(({ phase, label, color }) => (
          <span
            key={phase}
            title={PHASE_DESCRIPTIONS[phase] ?? ''}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'default' }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
            {label}
          </span>
        ))}
      </div>

      <div className="card ds-card" style={{ padding: 0, overflow: 'hidden' }}>
        {operations.length === 0 ? (
          <div className="empty-state empty-state--rich" style={{ margin: 16 }}>
            <div className="empty-state-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            </div>
            <div className="empty-state-title">No operations recorded</div>
            <div className="empty-state-desc">Operations will appear here as your node processes publish, query, and other DKG requests.</div>
          </div>
        ) : (
          <div className="ds-table-scroll ds-table-pin"><table className="data-table">
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
                  style={{ cursor: 'pointer', background: selectedOp === op.operation_id ? 'var(--tint-strong)' : undefined }}
                >
                  <td title={op.started_at ? new Date(op.started_at).toLocaleString() : undefined}>{formatTime(op.started_at)}</td>
                  <td><Badge size="sm" title={OP_TYPE_DESCRIPTIONS[op.operation_name] ?? ''} style={{ background: opTypeBg(op.operation_name), color: opTypeText(op.operation_name), boxShadow: 'none' }}>{op.operation_name}</Badge></td>
                  <td><OperationStatusBadge status={op.status} /></td>
                  <td><MiniGantt phases={op.phases} totalMs={op.duration_ms} /></td>
                  <td>{formatDuration(op.duration_ms)}</td>
                  <td>{op.gas_cost_eth != null ? op.gas_cost_eth.toFixed(6) : '—'}</td>
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
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 0', fontSize: 'var(--fs-label)', color: 'var(--text-secondary)',
        }}>
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              disabled={page === 0}
              onClick={() => setPage(0)}
              style={{
                padding: '4px 8px', borderRadius: 'var(--radius-xs)', fontSize: 'var(--fs-label)', fontWeight: 600, cursor: page === 0 ? 'default' : 'pointer',
                border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: page === 0 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                opacity: page === 0 ? 0.4 : 1,
              }}
            >
              ««
            </button>
            <button
              disabled={page === 0}
              onClick={() => setPage(p => Math.max(0, p - 1))}
              style={{
                padding: '4px 10px', borderRadius: 'var(--radius-xs)', fontSize: 'var(--fs-label)', fontWeight: 600, cursor: page === 0 ? 'default' : 'pointer',
                border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: page === 0 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                opacity: page === 0 ? 0.4 : 1,
              }}
            >
              ‹ Prev
            </button>
            <span style={{ padding: '4px 10px', fontSize: 'var(--fs-label)', fontWeight: 600 }}>
              Page {page + 1} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              style={{
                padding: '4px 10px', borderRadius: 'var(--radius-xs)', fontSize: 'var(--fs-label)', fontWeight: 600, cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: page >= totalPages - 1 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                opacity: page >= totalPages - 1 ? 0.4 : 1,
              }}
            >
              Next ›
            </button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(totalPages - 1)}
              style={{
                padding: '4px 8px', borderRadius: 'var(--radius-xs)', fontSize: 'var(--fs-label)', fontWeight: 600, cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                border: '1px solid var(--border-default)', background: 'var(--bg-surface)', color: page >= totalPages - 1 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
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
              position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 900,
              animation: 'fadeIn .15s ease-out',
            }}
          />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: '55%', minWidth: 480, maxWidth: 800,
            background: 'var(--bg-root)', borderLeft: '1px solid var(--border-default)', zIndex: 901,
            overflowY: 'auto', padding: '20px 24px',
            boxShadow: 'var(--shadow-drawer)',
            animation: 'slideInRight .2s ease-out',
          }}>
            {detail?.operation ? (
              <OperationDetail op={detail.operation} logs={detail.logs} phases={detail.phases ?? []} explorerUrl={explorerUrl} onBack={() => setSelectedOp(null)} />
            ) : (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>Loading...</div>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>
        <span>{formatAbsTime(opStart)}</span>
        <span>{formatDuration(opDuration)}</span>
        <span>{formatAbsTime(opEnd)}</span>
      </div>

      <div style={{ position: 'relative', background: 'var(--tint-subtle)', borderRadius: 'var(--radius-control)', border: '1px solid var(--border-default)', padding: '6px 0' }}>
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
            <div key={`${p.phase}-${i}`} style={{ display: 'flex', alignItems: 'center', height: 22, padding: '0 8px', position: 'relative' }}>
              <div style={{ width: 140, minWidth: 140, fontSize: 'var(--fs-micro)', fontWeight: 600, color, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={p.phase}>{p.phase}</div>
              <div style={{ flex: 1, position: 'relative', height: 12 }}>
                <div
                  title={`${p.phase}: ${formatDuration(phaseDuration)}${
                    isError
                      ? ` — FAILED: ${p.details ?? ''}`
                      : isCancelled
                        ? ` — CANCELLED: ${p.details ?? ''}`
                        : ''
                  }`}
                  style={{
                    position: 'absolute', left: `${left}%`, width: `${Math.min(width, 100 - left)}%`,
                    height: '100%', borderRadius: 'var(--radius-hair)', opacity: isInProgress ? 0.7 : 1, transition: 'width .3s ease',
                    background: isError ? 'repeating-linear-gradient(45deg, var(--accent-red), var(--accent-red) 3px, var(--danger-stripe) 3px, var(--danger-stripe) 6px)' : color,
                  }}
                />
              </div>
              <div style={{ width: 55, textAlign: 'right', fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, marginLeft: 8 }}>
                {formatDuration(phaseDuration)}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)' }}>
        {phases.some((p: any) => p.status === 'success') && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 'var(--radius-hair)', background: 'var(--accent-green)', display: 'inline-block' }} /> Success
          </span>
        )}
        {phases.some((p: any) => p.status === 'error') && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 'var(--radius-hair)', background: 'var(--accent-red)', display: 'inline-block' }} /> Failed
          </span>
        )}
        {phases.some((p: any) => p.status === 'cancelled') && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 'var(--radius-hair)', background: CANCELLED_COLOR, display: 'inline-block' }} /> Cancelled
          </span>
        )}
        {phases.some((p: any) => p.status === 'in_progress') && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 'var(--radius-hair)', background: 'var(--accent-amber)', display: 'inline-block' }} /> In Progress
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
        <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600, color: 'var(--text-secondary)' }}>Operation detail</span>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 4, display: 'flex' }}
          title="Close"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      {/* Header: Operation metadata as compact inline badges */}
      <div className="card ds-card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 'var(--fs-title)', fontWeight: 700 }}>{op.operation_name}</span>
          <OperationStatusBadge status={op.status} />
          <span style={{ fontSize: 'var(--fs-control)', color: 'var(--text-tertiary)' }}>{formatDuration(op.duration_ms)}</span>
          <span style={{ fontSize: 'var(--fs-label)', color: 'var(--text-tertiary)', fontFamily: "'JetBrains Mono', monospace" }}>{op.operation_id} <CopyButton text={op.operation_id} /></span>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 'var(--fs-control)', color: 'var(--text-secondary)' }}>
          <span><b style={{ color: 'var(--text-secondary)' }}>Started</b> {new Date(op.started_at).toLocaleString()}</span>
          {op.contextGraph_id && <span><b style={{ color: 'var(--text-secondary)' }}>Context graph</b> {op.contextGraph_id}</span>}
          {op.triple_count != null && <span><b style={{ color: 'var(--text-secondary)' }}>Triples</b> {op.triple_count}</span>}
          {op.peer_id && <span><b style={{ color: 'var(--text-secondary)' }}>Peer</b> <span className="mono">{shortId(op.peer_id)}</span></span>}
          {op.gas_cost_eth != null && <span><b style={{ color: 'var(--text-secondary)' }}>Gas</b> {op.gas_cost_eth.toFixed(6)} ETH</span>}
          {op.trac_cost != null && <span><b style={{ color: 'var(--text-secondary)' }}>TRAC</b> {op.trac_cost.toFixed(4)}</span>}
          {op.tx_hash && (
            <span>
              <b style={{ color: 'var(--text-secondary)' }}>TX</b>{' '}
              {explorerUrl ? (
                <a href={`${explorerUrl}/tx/${op.tx_hash}`} target="_blank" rel="noopener noreferrer" className="mono">{shortId(op.tx_hash)}</a>
              ) : <span className="mono">{shortId(op.tx_hash)}</span>}
            </span>
          )}
        </div>
        {op.error_message && (
          <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--danger-bg)', borderRadius: 'var(--radius-control)', border: '1px solid var(--danger-border)', fontSize: 'var(--fs-control)', color: 'var(--accent-red)' }}>
            {op.error_message}
          </div>
        )}
      </div>

      {/* Phase timeline + Phase details */}
      {phases.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>
          <div className="card ds-card" style={{ padding: 16 }}>
            <div className="card-title" style={{ marginBottom: 10 }}>Phase timeline</div>
            <PhaseTimeline phases={phases} op={op} />
          </div>

          <div className="card ds-card" style={{ padding: 16 }}>
            <div className="card-title" style={{ marginBottom: 10 }}>Phase details</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                  <div key={`${p.phase}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--tint-faint)', borderRadius: 'var(--radius-control)', borderLeft: `3px solid ${terminalColor}` }}>
                    <span style={{ fontWeight: 600, fontSize: 'var(--fs-control)', color, minWidth: 65 }} title={desc ?? ''}>{p.phase}</span>
                    <OperationStatusBadge status={p.status} />
                    <span style={{ fontSize: 'var(--fs-label)', color: 'var(--text-tertiary)', fontFamily: "'JetBrains Mono', monospace" }}>{formatDuration(p.duration_ms)}</span>
                    {desc && <span style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', fontStyle: 'italic', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{desc}</span>}
                    <span
                      style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', marginLeft: 'auto', flexShrink: 0 }}
                      title={p.started_at ? new Date(p.started_at).toLocaleString() : undefined}
                    >
                      {p.started_at ? formatTime(p.started_at) : ''}
                    </span>
                    {(p.status === 'error' || p.status === 'cancelled') && p.details && (
                      <span style={{ fontSize: 'var(--fs-micro)', color: terminalColor, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.details}>
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
      <div className="card ds-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-default)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="card-title" style={{ margin: 0 }}>Logs ({logs.length})</span>
        </div>
        {logs.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <div className="empty-state-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </div>
            <div className="empty-state-title">No logs available</div>
            <div className="empty-state-desc">This operation has no log entries recorded.</div>
          </div>
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
        <mark style={{ background: 'var(--accent-amber)', color: 'var(--bg-root)', borderRadius: 'var(--radius-hair)', padding: '0 1px' }}>
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
            borderRadius: 'var(--radius-control)', border: '1px solid var(--border-default)', background: 'var(--bg-surface)',
            color: 'var(--text-secondary)', fontSize: 'var(--fs-label)', fontWeight: 600, cursor: 'pointer',
            transition: 'all .15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-green)'; e.currentTarget.style.color = 'var(--accent-green)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-default)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
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
            borderRadius: 'var(--radius-control)', border: `1px solid ${autoScroll ? 'var(--success-border)' : 'var(--border-default)'}`,
            background: autoScroll ? 'var(--success-bg)' : 'var(--bg-surface)',
            color: autoScroll ? 'var(--accent-green)' : 'var(--text-secondary)',
            fontSize: 'var(--fs-label)', fontWeight: 600, cursor: 'pointer', transition: 'all .15s',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>
          </svg>
          Auto-scroll
        </button>
      </div>

      <div style={{ borderRadius: 'var(--radius-card)', overflow: 'hidden', border: '1px solid var(--border-default)' }}>
        <div style={{
          padding: '8px 16px',
          background: 'var(--tint-faint)',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: 'var(--fs-label)', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>
            {lines.length} lines{debouncedSearch ? ` matching "${debouncedSearch}"` : ''}
            {loading ? <span style={{ marginLeft: 6, color: 'var(--text-tertiary)', fontSize: 'var(--fs-micro)' }}>refreshing...</span> : ''}
          </span>
          <span className="mono" style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)' }}>daemon.log {data?.totalSize ? `(${formatSize(data.totalSize)})` : ''}</span>
        </div>
        <div
          ref={containerRef}
          onScroll={handleScroll}
          style={{
            height: 'calc(100vh - 240px)',
            minHeight: 500,
            overflowY: 'auto',
            padding: '8px 0',
            background: 'var(--log-bg)',
            fontFamily: LOG_FONT,
            fontSize: 'var(--fs-micro)',
            lineHeight: 1.5,
          }}
        >
          {lines.length === 0 ? (
            <div className="empty-state empty-state--compact">
              {loading ? (
                <div className="empty-state-desc">Loading...</div>
              ) : (
                <>
                  <div className="empty-state-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  </div>
                  <div className="empty-state-title">No log lines found</div>
                  <div className="empty-state-desc">Try adjusting the search filters or check back later.</div>
                </>
              )}
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
  timestamp: 'var(--log-timestamp)',
  module: 'var(--log-module)',
  levelError: 'var(--log-error)',
  levelWarn: 'var(--log-warn)',
  levelInfo: 'var(--log-meta)',
  message: 'var(--log-text)',
  bg: 'var(--log-bg)',
};

function StyledLogEntry({ ts, level, module, message }: { ts: number; level: string; module: string; message: string }) {
  const levelColor = level === 'error' ? LOG_COLORS.levelError : level === 'warn' ? LOG_COLORS.levelWarn : LOG_COLORS.levelInfo;
  return (
    <div style={{
      padding: '1px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      background: level === 'error' ? 'var(--log-error-bg)' : undefined,
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
      maxHeight, overflowY: 'auto', background: LOG_COLORS.bg, borderRadius: 'var(--radius-control)', padding: '6px 0',
      fontFamily: LOG_FONT, fontSize: 'var(--fs-micro)', lineHeight: 1.5,
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
  const bg = cls === 'error' ? 'var(--log-error-bg)' : undefined;

  if (!parsed) {
    const color = cls === 'error' ? LOG_COLORS.levelError : cls === 'warn' ? LOG_COLORS.levelWarn : LOG_COLORS.message;
    return (
      <div style={{ padding: '0 16px', color, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: bg }}>
        <span style={{ color: 'var(--text-tertiary)', userSelect: 'none', marginRight: 8, display: 'inline-block', width: 40, textAlign: 'right' }}>{lineNum}</span>
        {highlight ? highlight(line) : line}
      </div>
    );
  }

  const opColor = opTypeText(parsed.opName);
  return (
    <div style={{ padding: '0 16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: bg }}>
      <span style={{ color: 'var(--text-tertiary)', userSelect: 'none', marginRight: 8, display: 'inline-block', width: 40, textAlign: 'right' }}>{lineNum}</span>
      <span style={{ color: LOG_COLORS.timestamp }}>{parsed.ts}</span>{' '}
      <span style={{ color: opColor, fontWeight: 600 }}>{parsed.opName}</span>{' '}
      <span style={{ color: 'var(--text-tertiary)' }}>{parsed.opId.slice(0, 8)}</span>{' '}
      <span style={{ color: LOG_COLORS.module }}>[{parsed.module}]</span>{' '}
      <span style={{ color: LOG_COLORS.message }}>{highlight ? highlight(parsed.message) : parsed.message}</span>
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
    <button
      onClick={copy}
      title="Copy to clipboard"
      style={{
        background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px',
        color: copied ? 'var(--accent-green)' : 'var(--text-tertiary)', fontSize: 'var(--fs-label)',
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
