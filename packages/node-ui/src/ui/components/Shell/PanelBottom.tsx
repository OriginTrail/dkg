import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLayoutStore, maxBottomHeight } from '../../stores/layout.js';
import { api } from '../../api-wrapper.js';
import { formatTime, formatDuration, shortId } from '../../hooks.js';
import { opTone } from '../../op-type-colors.js';
import { pressable } from '../../lib/pressable.js';
import { OperationStatusBadge } from '../OperationStatusBadge.js';

const BOTTOM_TABS = ['Node log', 'Transactions'] as const;
type BottomTab = typeof BOTTOM_TABS[number];

// ── Icons ────────────────────────────────────────────────────────────────────

const CHEVRON_DOWN = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const MAXIMIZE_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);

const RESTORE_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="4 14 10 14 10 20" />
    <polyline points="20 10 14 10 14 4" />
    <line x1="10" y1="14" x2="3" y2="21" />
    <line x1="21" y1="3" x2="14" y2="10" />
  </svg>
);

// ── Shared utils ─────────────────────────────────────────────────────────────

// Strip ANSI escape sequences that leak through from Node.js stderr/stdout.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /(\x1B\[[0-9;]*[mGKHFJA-Z]|\[[0-9;]*m)/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

function classifyLine(line: string): 'error' | 'warn' | 'info' | 'debug' {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes(' err ') || l.includes('[error]')) return 'error';
  if (l.includes('warn') || l.includes('[warn]')) return 'warn';
  if (l.includes('debug') || l.includes('[debug]') || l.includes('trace')) return 'debug';
  return 'info';
}

const LEVEL_CLASS: Record<string, string> = {
  error: 'v10-log-line v10-log-line-error',
  warn:  'v10-log-line v10-log-line-warn',
  info:  'v10-log-line v10-log-line-info',
  debug: 'v10-log-line v10-log-line-debug',
};

function useAutoScroll(dep: unknown) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  return scrollRef;
}

// ── Node log ─────────────────────────────────────────────────────────────────

function NodeLogContent() {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<'all' | 'error' | 'warn' | 'info' | 'debug'>('all');

  const load = useCallback(() => {
    api.fetchNodeLog({ lines: 300, q: filter || undefined })
      .then(({ lines: l }: any) => setLines((l ?? []).map(stripAnsi)))
      .catch(() => {});
  }, [filter]);

  useEffect(() => { load(); const iv = setInterval(load, 3_000); return () => clearInterval(iv); }, [load]);

  const visible = lines.filter(l => level === 'all' || classifyLine(l) === level);
  const lastLine = visible.length > 0 ? visible[visible.length - 1] : '';
  const scrollRef = useAutoScroll(lastLine);

  return (
    <div className="v10-log-container">
      <div className="v10-log-toolbar">
        <input
          id="dkg-node-log-filter"
          name="dkg-node-log-filter"
          type="text"
          placeholder="Filter logs..."
          className="v10-log-filter ds-input ds-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter node log lines"
        />
        <select
          id="dkg-node-log-level"
          name="dkg-node-log-level"
          className="v10-log-level-select ds-input ds-sm"
          value={level}
          onChange={e => setLevel(e.target.value as typeof level)}
          aria-label="Filter node log level"
        >
          <option value="all">All</option>
          <option value="error">Error</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
      </div>
      <div className="v10-log-output" ref={scrollRef}>
        {visible.map((line, i) => (
          <div key={i} className={LEVEL_CLASS[classifyLine(line)]}>{line}</div>
        ))}
        {visible.length === 0 && (
          <div className="v10-log-line v10-log-line-muted">No log output</div>
        )}
      </div>
    </div>
  );
}

// ── Transactions ──────────────────────────────────────────────────────────────
// Real-time view of publish / update / verify activity. On-chain operations
// show their transaction hash; local-first operations (the default on a node
// that hasn't opted into on-chain registration) have no tx and are tagged
// "local" so a publish is always visible here instead of silently vanishing
// because it never reached the `chain` phase (F2).
// Replaces with OTEL-sourced chain events once the telemetry stack is live.

const TX_OP_TYPES = new Set(['publish', 'publishFromSWM', 'update', 'ka-update', 'verify', 'reconstruct']);


function TransactionsContent() {
  const [ops, setOps] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    const from = String(Date.now() - 6 * 60 * 60_000);
    const names = [...TX_OP_TYPES].join(',');
    api.fetchOperationsWithPhases({ limit: '100', from, names })
      .then((data: any) => {
        // The `names` param already scopes the result to tx-capable op types.
        // Don't drop the ones that never reached the `chain` phase — those are
        // local-first publishes/updates the operator still wants to see. (F2)
        setOps(data?.operations ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [load]);

  if (ops.length === 0) {
    return (
      <div className="v10-bottom-empty">
        No publish, update, or verify activity in the last 6 hours.
      </div>
    );
  }

  return (
    <div className="v10-log-output v10-log-output-scroll">
      <div className="ds-table-scroll"><table className="v10-bottom-table">
        <thead>
          <tr className="v10-bottom-head-row">
            <th className="ds-table-head v10-bottom-th">Type</th>
            <th className="ds-table-head v10-bottom-th">ID</th>
            <th className="ds-table-head v10-bottom-th">Status</th>
            <th className="ds-table-head v10-bottom-th">Duration</th>
            <th className="ds-table-head v10-bottom-th">Time</th>
            <th className="ds-table-head v10-bottom-th">Tx hash</th>
          </tr>
        </thead>
        <tbody>
          {ops.map((op: any) => {
            const chainPhase = (op.phases ?? []).find((p: any) => p.phase === 'chain');
            const txHash = op.tx_hash ?? chainPhase?.tx_hash;
            const isExp = expanded === op.operation_id;
            return (
              <React.Fragment key={op.operation_id}>
                <tr
                  aria-expanded={isExp} {...pressable(() => setExpanded(id => id === op.operation_id ? null : op.operation_id))}
                  className={isExp ? 'v10-bottom-op-row v10-bottom-op-row-open' : 'v10-bottom-op-row'}
                >
                  <td className={`v10-bottom-td-op op-tone-${opTone(op.operation_name)}`}>
                    {op.operation_name}
                  </td>
                  <td className="v10-bottom-td-mono">
                    {shortId(op.operation_id)}
                  </td>
                  <td className="v10-bottom-td">
                    <OperationStatusBadge status={op.status} />
                  </td>
                  <td className="v10-bottom-td-muted">
                    {op.duration_ms != null ? formatDuration(op.duration_ms) : '—'}
                  </td>
                  <td className="v10-bottom-td-muted">
                    {op.started_at ? formatTime(op.started_at) : '—'}
                  </td>
                  <td className="v10-bottom-td-id">
                    {txHash
                      ? `${txHash.slice(0, 10)}…`
                      // Only a SUCCESSFULLY-completed op with no chain phase is a
                      // genuine local-first run worth the "local" tag. A no-tx op
                      // that failed or is still in flight before reaching `chain`
                      // must NOT read as a successful local run — show "—" so the
                      // Status column stays the source of truth for those (Codex).
                      : op.status === 'success'
                        ? <span className="v10-bottom-none">local</span>
                        : '—'}
                  </td>
                </tr>
                {isExp && (
                  <tr className="v10-bottom-detail-row">
                    <td colSpan={6} className="v10-bottom-detail-cell">
                      <div className="v10-bottom-detail">
                        <span><b>ID:</b> <span className="v10-bottom-mono">{op.operation_id}</span></span>
                        {txHash && <span><b>Tx:</b> <span className="v10-bottom-mono">{txHash}</span></span>}
                        {op.peer_id && <span><b>Peer:</b> <span className="v10-bottom-mono">{shortId(op.peer_id)}</span></span>}
                        {op.error_message && <span className="v10-bottom-detail-error"><b>Error:</b> {op.error_message}</span>}
                      </div>
                      {(op.phases ?? []).length > 0 && (
                        <div className="v10-bottom-phases">
                          {op.phases.map((p: any) => (
                            <span key={p.phase} className="v10-bottom-phase">
                              {p.phase} {p.duration_ms != null ? formatDuration(p.duration_ms) : ''}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table></div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function PanelBottom() {
  const {
    bottomCollapsed, toggleBottom,
    bottomMaximised, toggleBottomMaximised,
    bottomHeight, setBottomHeight,
  } = useLayoutStore();
  const [activeTab, setActiveTab] = useState<BottomTab>('Node log');

  // Vertical drag-to-resize — same pattern as horizontal handles in App.tsx.
  const handleRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(bottomHeight);
  heightRef.current = bottomHeight;

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    let startY = 0;

    const onMouseMove = (e: MouseEvent) => {
      const delta = startY - e.clientY; // drag up → bigger
      startY = e.clientY;
      setBottomHeight(heightRef.current + delta);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.classList.remove('active');
    };

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      handle.classList.add('active');
    };

    handle.addEventListener('mousedown', onMouseDown);
    return () => handle.removeEventListener('mousedown', onMouseDown);
  }, [setBottomHeight]);

  const panelHeight = bottomCollapsed
    ? undefined
    : bottomMaximised
      ? '80vh'
      : Math.min(bottomHeight, maxBottomHeight());

  return (
    <div
      role="region" aria-label="Node log and transactions" className={`v10-panel-bottom ${bottomCollapsed ? 'collapsed' : ''} ${bottomMaximised ? 'maximised' : ''}`}
      style={!bottomCollapsed ? { height: panelHeight } : undefined}
    >
      {/* Resize handle — only visible when expanded and not maximised */}
      {!bottomCollapsed && !bottomMaximised && (
        <div className="v10-resize-handle-v" ref={handleRef} title="Drag to resize" />
      )}

      <div className="v10-bottom-tabs">
        {BOTTOM_TABS.map((tab) => (
          <button
            key={tab}
            className={`v10-bottom-tab ds-tab ${tab === activeTab ? 'active' : ''}`}
            onClick={() => { setActiveTab(tab); if (bottomCollapsed) toggleBottom(); }}
          >
            {tab}
          </button>
        ))}
        <div className="v10-bottom-spacer" />
        {!bottomCollapsed && (
          <button
            className="v10-bottom-toggle ds-btn ds-ghost ds-sm ds-icon"
            onClick={toggleBottomMaximised}
            title={bottomMaximised ? 'Restore' : 'Maximise'}
          >
            {bottomMaximised ? RESTORE_ICON : MAXIMIZE_ICON}
          </button>
        )}
        <button className="v10-bottom-toggle ds-btn ds-ghost ds-sm ds-icon" onClick={toggleBottom} title={bottomCollapsed ? 'Expand' : 'Collapse'}>
          <span className={bottomCollapsed ? 'v10-bottom-chevron v10-bottom-chevron-up' : 'v10-bottom-chevron'}>
            {CHEVRON_DOWN}
          </span>
        </button>
      </div>

      {!bottomCollapsed && (
        <div className="v10-bottom-content">
          {activeTab === 'Node log' && <NodeLogContent />}
          {activeTab === 'Transactions' && <TransactionsContent />}
        </div>
      )}
    </div>
  );
}
