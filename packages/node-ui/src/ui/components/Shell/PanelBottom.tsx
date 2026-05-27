import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLayoutStore, maxBottomHeight } from '../../stores/layout.js';
import { api } from '../../api-wrapper.js';
import { formatTime, formatDuration, shortId } from '../../hooks.js';

const BOTTOM_TABS = ['Node Log', 'Transactions', 'Gossip'] as const;
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

const LEVEL_COLORS: Record<string, string> = {
  error: 'var(--accent-red, #ef4444)',
  warn:  'var(--accent-yellow, #f59e0b)',
  info:  'var(--text-primary)',
  debug: 'var(--text-tertiary)',
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

// ── Node Log ─────────────────────────────────────────────────────────────────

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
          className="v10-log-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter node log lines"
        />
        <select
          id="dkg-node-log-level"
          name="dkg-node-log-level"
          className="v10-log-level-select"
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
          <div key={i} className="v10-log-line" style={{ color: LEVEL_COLORS[classifyLine(line)] }}>{line}</div>
        ))}
        {visible.length === 0 && (
          <div className="v10-log-line" style={{ color: 'var(--text-tertiary)' }}>No log output</div>
        )}
      </div>
    </div>
  );
}

// ── Transactions ──────────────────────────────────────────────────────────────
// Shows operations that reached the `chain` phase, giving a real-time view of
// on-chain activity. Covers all op types that can submit a tx.
// Replaces with OTEL-sourced chain events once the telemetry stack is live.

const TX_OP_TYPES = new Set(['publish', 'publishFromSWM', 'update', 'ka-update', 'verify', 'reconstruct']);

const TX_TYPE_COLORS: Record<string, string> = {
  publish:        '#22c55e',
  publishFromSWM: '#16a34a',
  update:         '#14b8a6',
  'ka-update':    '#0d9488',
  verify:         '#8b5cf6',
  reconstruct:    '#fb923c',
};

function TransactionsContent() {
  const [ops, setOps] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    const from = String(Date.now() - 6 * 60 * 60_000);
    const names = [...TX_OP_TYPES].join(',');
    api.fetchOperationsWithPhases({ limit: '100', from, names })
      .then((data: any) => {
        const filtered = (data?.operations ?? []).filter((op: any) =>
          op.tx_hash || (op.phases ?? []).some((p: any) => p.phase === 'chain')
        );
        setOps(filtered);
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
      <div style={{ padding: '20px 16px', color: 'var(--text-tertiary)', fontSize: 12 }}>
        No on-chain transactions in the last 6 hours.
      </div>
    );
  }

  return (
    <div className="v10-log-output" style={{ overflowY: 'auto', flex: 1 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', textAlign: 'left' }}>
            <th style={{ padding: '6px 12px', fontWeight: 600 }}>Type</th>
            <th style={{ padding: '6px 12px', fontWeight: 600 }}>ID</th>
            <th style={{ padding: '6px 12px', fontWeight: 600 }}>Status</th>
            <th style={{ padding: '6px 12px', fontWeight: 600 }}>Duration</th>
            <th style={{ padding: '6px 12px', fontWeight: 600 }}>Time</th>
            <th style={{ padding: '6px 12px', fontWeight: 600 }}>Tx Hash</th>
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
                  onClick={() => setExpanded(id => id === op.operation_id ? null : op.operation_id)}
                  style={{ borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', background: isExp ? 'rgba(255,255,255,.03)' : undefined }}
                >
                  <td style={{ padding: '7px 12px', color: TX_TYPE_COLORS[op.operation_name] ?? 'var(--text-secondary)', fontWeight: 600 }}>
                    {op.operation_name}
                  </td>
                  <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                    {shortId(op.operation_id)}
                  </td>
                  <td style={{ padding: '7px 12px' }}>
                    <span style={{
                      padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                      background: op.status === 'success' ? 'rgba(34,197,94,.15)' : op.status === 'error' ? 'rgba(239,68,68,.15)' : 'rgba(245,158,11,.15)',
                      color: op.status === 'success' ? '#22c55e' : op.status === 'error' ? '#ef4444' : '#f59e0b',
                    }}>{op.status}</span>
                  </td>
                  <td style={{ padding: '7px 12px', color: 'var(--text-secondary)' }}>
                    {op.duration_ms != null ? formatDuration(op.duration_ms) : '—'}
                  </td>
                  <td style={{ padding: '7px 12px', color: 'var(--text-secondary)' }}>
                    {op.started_at ? formatTime(op.started_at) : '—'}
                  </td>
                  <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {txHash ? `${txHash.slice(0, 10)}…` : '—'}
                  </td>
                </tr>
                {isExp && (
                  <tr style={{ background: 'rgba(0,0,0,.2)' }}>
                    <td colSpan={6} style={{ padding: '8px 16px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 11, color: 'var(--text-secondary)' }}>
                        <span><b>ID:</b> <span style={{ fontFamily: 'var(--font-mono)' }}>{op.operation_id}</span></span>
                        {txHash && <span><b>Tx:</b> <span style={{ fontFamily: 'var(--font-mono)' }}>{txHash}</span></span>}
                        {op.peer_id && <span><b>Peer:</b> <span style={{ fontFamily: 'var(--font-mono)' }}>{shortId(op.peer_id)}</span></span>}
                        {op.error_message && <span style={{ color: '#ef4444' }}><b>Error:</b> {op.error_message}</span>}
                      </div>
                      {(op.phases ?? []).length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {op.phases.map((p: any) => (
                            <span key={p.phase} style={{
                              padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                              background: 'rgba(255,255,255,.06)', color: 'var(--text-secondary)',
                            }}>
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
      </table>
    </div>
  );
}

// ── Gossip ────────────────────────────────────────────────────────────────────
// Shows only raw libp2p / ProtocolRouter / GossipSub lines — NOT structured
// DKGAgent operation logs (those live in Node Log and Operations).
// Once OTEL is live this tab will be backed by a dedicated trace/metric stream.

// Structured DKGAgent lines start with: "YYYY-MM-DD HH:MM:SS <optype> <uuid>"
const STRUCTURED_LOG_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \w+ [0-9a-f-]{36}/;

function isLibp2pLine(line: string): boolean {
  const s = stripAnsi(line);
  if (STRUCTURED_LOG_RE.test(s)) return false; // skip DKGAgent structured lines
  if (/Connection (opened|closed):/i.test(s)) return true;
  if (/\[ProtocolRouter\]/i.test(s)) return true;
  if (/Circuit reservation/i.test(s)) return true;
  if (/Node is remotely-dialable/i.test(s)) return true;
  if (/gossipsub|pubsub/i.test(s)) return true;
  if (/FinalizationHandler/i.test(s)) return true;
  if (/swm-ack|swm-share|swm-update/i.test(s)) return true;
  return false;
}

function GossipContent() {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    api.fetchNodeLog({ lines: 500 })
      .then(({ lines: l }: any) => setLines((l ?? []).map(stripAnsi).filter(isLibp2pLine)))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 5_000); return () => clearInterval(iv); }, [load]);

  const visible = filter ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase())) : lines;
  const gossipLastLine = visible.length > 0 ? visible[visible.length - 1] : '';
  const scrollRef = useAutoScroll(gossipLastLine);

  return (
    <div className="v10-log-container">
      <div className="v10-log-toolbar">
        <input
          id="dkg-gossip-log-filter"
          name="dkg-gossip-log-filter"
          type="text"
          placeholder="Filter libp2p / gossip events..."
          className="v10-log-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter gossip log lines"
        />
      </div>
      <div className="v10-log-output" ref={scrollRef}>
        {visible.map((line, i) => (
          <div key={i} className="v10-log-line" style={{ color: 'var(--text-secondary)' }}>{line}</div>
        ))}
        {visible.length === 0 && (
          <div className="v10-log-line" style={{ color: 'var(--text-tertiary)' }}>
            No libp2p / gossip events in log tail
          </div>
        )}
      </div>
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
  const [activeTab, setActiveTab] = useState<BottomTab>('Node Log');

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
      className={`v10-panel-bottom ${bottomCollapsed ? 'collapsed' : ''} ${bottomMaximised ? 'maximised' : ''}`}
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
            className={`v10-bottom-tab ${tab === activeTab ? 'active' : ''}`}
            onClick={() => { setActiveTab(tab); if (bottomCollapsed) toggleBottom(); }}
          >
            {tab}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          className="v10-bottom-toggle"
          onClick={toggleBottomMaximised}
          title={bottomMaximised ? 'Restore' : 'Maximise'}
          style={{ display: bottomCollapsed ? 'none' : undefined }}
        >
          {bottomMaximised ? RESTORE_ICON : MAXIMIZE_ICON}
        </button>
        <button className="v10-bottom-toggle" onClick={toggleBottom} title={bottomCollapsed ? 'Expand' : 'Collapse'}>
          <span style={{ transform: bottomCollapsed ? 'rotate(180deg)' : 'none', display: 'flex', transition: 'transform 0.15s' }}>
            {CHEVRON_DOWN}
          </span>
        </button>
      </div>

      {!bottomCollapsed && (
        <div className="v10-bottom-content">
          {activeTab === 'Node Log' && <NodeLogContent />}
          {activeTab === 'Transactions' && <TransactionsContent />}
          {activeTab === 'Gossip' && <GossipContent />}
        </div>
      )}
    </div>
  );
}
