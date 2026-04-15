import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { authHeaders } from '../api.js';

/* ─── Helpers ─── */
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatInterval(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}min`;
  return `${Math.round(ms / 1_000)}s`;
}

type SyncHealth = 'healthy' | 'warning' | 'stale' | 'offline';

function computeHealth(syncStatus: any, status: any): { health: SyncHealth; reason: string } {
  const peers = status?.connectedPeers ?? 0;
  if (peers === 0) return { health: 'offline', reason: 'No peers connected — gossip and catch-up inactive' };

  const cgs = syncStatus?.contextGraphs ?? [];
  if (cgs.length === 0) return { health: 'warning', reason: `Connected to ${peers} peer${peers > 1 ? 's' : ''} — discovering context graphs` };

  const totalTriples = cgs.reduce((s: number, cg: any) => s + (cg.totalTriples ?? 0), 0);
  const withData = cgs.filter((cg: any) => (cg.totalTriples ?? 0) > 0).length;
  const intervalMs: number = syncStatus?.syncIntervalMs ?? 60_000;
  const intervalLabel = formatInterval(intervalMs);
  const lastActivity = Math.max(
    ...cgs.map((cg: any) => Math.max(cg.lastCheckedAt ?? 0, cg.lastGossipAt ?? 0)),
  );

  if (lastActivity === 0) {
    if (totalTriples > 0) {
      return { health: 'healthy', reason: `Connected (${peers} peers) · ${formatNumber(totalTriples)} triples · waiting for first live activity` };
    }
    return { health: 'warning', reason: `Connected to ${peers} peer${peers > 1 ? 's' : ''} — waiting for first sync` };
  }

  const age = Date.now() - lastActivity;
  if (age > intervalMs * 10) {
    return { health: 'stale', reason: `No gossip or catch-up activity for ${timeAgo(lastActivity)} — node may be stalled` };
  }

  return { health: 'healthy', reason: `Gossip live (${peers} peers) · ${withData} CGs · ${formatNumber(totalTriples)} triples · catch-up every ${intervalLabel}` };
}

const HEALTH_CFG: Record<SyncHealth, { color: string; icon: string; label: string }> = {
  healthy: { color: 'var(--accent-green)', icon: '●', label: 'Sync Healthy' },
  warning: { color: 'var(--accent-amber)', icon: '●', label: 'Sync Warning' },
  stale:   { color: 'var(--accent-red)',   icon: '●', label: 'Sync Stale' },
  offline: { color: 'var(--text-ghost)',    icon: '○', label: 'Offline' },
};

/* ─── Status dot: based on most recent activity (gossip or catch-up) ─── */
function StatusDot({ cg, intervalMs }: { cg: any; intervalMs: number }) {
  const lastActivity = Math.max(cg.lastGossipAt ?? 0, cg.lastCheckedAt ?? 0);
  if (!lastActivity) return <span className="sync-dot gray" title="Awaiting first sync" />;
  const age = Date.now() - lastActivity;
  if (age > intervalMs * 10) return <span className="sync-dot red" title={`No activity for ${timeAgo(lastActivity)}`} />;
  return <span className="sync-dot green" title={`Active — last data ${timeAgo(lastActivity)}`} />;
}

/* ─── Health Banner ─── */
function SyncHealthBanner({ syncStatus, status }: { syncStatus: any; status: any }) {
  const { health, reason } = computeHealth(syncStatus, status);
  const cfg = HEALTH_CFG[health];
  const peers = status?.connectedPeers ?? 0;

  const lastChecked = useMemo(() => {
    const cgs = syncStatus?.contextGraphs ?? [];
    return Math.max(...cgs.map((cg: any) => cg.lastCheckedAt ?? 0), 0);
  }, [syncStatus]);

  return (
    <div className={`sync-health-banner ${health}`}>
      <div className="sync-health-left">
        <span className="sync-health-icon" style={{ color: cfg.color }}>{cfg.icon}</span>
        <div>
          <div className="sync-health-title">{cfg.label}</div>
          <div className="sync-health-reason">{reason}</div>
        </div>
      </div>
      <div className="sync-health-metrics">
        <div className="sync-health-metric">
          <span className="sync-health-metric-value">{peers}</span>
          <span className="sync-health-metric-label">peers</span>
        </div>
        <div className="sync-health-metric">
          <span className="sync-health-metric-value">{lastChecked > 0 ? timeAgo(lastChecked) : '—'}</span>
          <span className="sync-health-metric-label">last catch-up</span>
        </div>
      </div>
    </div>
  );
}

/* ─── Context Graph table ─── */
function CGTable({ contextGraphs, intervalMs }: { contextGraphs: any[]; intervalMs: number }) {
  const sorted = useMemo(() => {
    return [...contextGraphs].sort((a, b) => (b.totalTriples ?? 0) - (a.totalTriples ?? 0));
  }, [contextGraphs]);

  if (sorted.length === 0) return null;

  return (
    <div className="sync-cg-table-wrap">
      <table className="sync-cg-table">
        <thead>
          <tr>
            <th></th>
            <th>Context Graph</th>
            <th>Triples</th>
            <th>Last Gossip</th>
            <th>Gossip Triples</th>
            <th>Last Catch-up</th>
            <th>Catch-up Triples</th>
            <th>Sources</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((cg: any) => {
            const triples = cg.totalTriples ?? 0;
            const catchupDelta = cg.lastDelta ?? 0;
            const gossipTriples = cg.lastGossipTriples ?? 0;
            const sources = cg.peerSources ?? 0;
            return (
              <tr key={cg.id} className={triples === 0 ? 'sync-cg-row-empty' : ''}>
                <td><StatusDot cg={cg} intervalMs={intervalMs} /></td>
                <td>
                  <div className="sync-cg-table-name">{cg.name ?? cg.id}</div>
                  <div className="sync-cg-table-id">{cg.id}</div>
                </td>
                <td className="sync-cg-table-mono">{triples > 0 ? formatNumber(triples) : '0'}</td>
                <td className="sync-cg-table-mono">{cg.lastGossipAt ? timeAgo(cg.lastGossipAt) : '—'}</td>
                <td className={`sync-cg-table-mono ${gossipTriples > 0 ? 'sync-cg-delta-positive' : ''}`}>
                  {gossipTriples > 0 ? `+${formatNumber(gossipTriples)}` : cg.lastGossipAt ? '+0' : '—'}
                </td>
                <td className="sync-cg-table-mono">{cg.lastCheckedAt ? timeAgo(cg.lastCheckedAt) : '—'}</td>
                <td className={`sync-cg-table-mono ${catchupDelta > 0 ? 'sync-cg-delta-positive' : ''}`}>
                  {catchupDelta > 0 ? `+${formatNumber(catchupDelta)}` : cg.lastCheckedAt ? '+0' : '—'}
                </td>
                <td className="sync-cg-table-mono">{sources > 0 ? `${sources} peer${sources > 1 ? 's' : ''}` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Live Sync Log Feed (reads from in-memory buffer via /api/sync/log) ─── */
function SyncLogFeed() {
  const [events, setEvents] = useState<{ ts: number; level: string; message: string }[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const fetchLog = useCallback(async () => {
    try {
      const res = await fetch('/api/sync/log', { headers: { ...authHeaders() } });
      if (!res.ok) return;
      const data = await res.json();
      setEvents(data?.events ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchLog();
    const iv = setInterval(fetchLog, 5_000);
    return () => clearInterval(iv);
  }, [fetchLog]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  const formatTs = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="sync-log-feed">
      <div className="sync-log-header">
        <h3 className="sync-log-title">Sync Activity Log</h3>
        <label className="sync-log-autoscroll">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          auto-scroll
        </label>
      </div>
      <div className="sync-log-container" ref={containerRef}>
        {events.length === 0 ? (
          <div className="sync-log-empty">No sync events yet — waiting for first sync round</div>
        ) : (
          events.map((evt, i) => (
            <div key={i} className={`sync-log-line ${evt.level}`}>
              <span className="sync-log-time">{formatTs(evt.ts)}</span>
              <span className="sync-log-msg">{evt.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ─── Main View ─── */
export function SyncStatusView() {
  const { data: syncStatus } = useFetch(api.fetchSyncStatus, [], 5_000);
  const { data: status } = useFetch(api.fetchStatus, [], 10_000);
  const [expanded, setExpanded] = useState(true);

  const triggered = useRef(false);
  useEffect(() => {
    if (!triggered.current) {
      triggered.current = true;
      fetch('/api/sync/trigger', { method: 'POST', headers: { ...authHeaders() } }).catch(() => {});
    }
  }, []);

  const contextGraphs: any[] = syncStatus?.contextGraphs ?? [];
  const intervalMs: number = syncStatus?.syncIntervalMs ?? 60_000;

  const withDataCount = useMemo(
    () => contextGraphs.filter((cg: any) => (cg.totalTriples ?? 0) > 0).length,
    [contextGraphs],
  );

  const totalTriples = useMemo(
    () => contextGraphs.reduce((s: number, cg: any) => s + (cg.totalTriples ?? 0), 0),
    [contextGraphs],
  );

  return (
    <div className="sync-status-view">
      <div className="v10-explorer-header">
        <h1 className="v10-explorer-title">Sync Status</h1>
        <p className="v10-explorer-subtitle">
          Real-time data via GossipSub · periodic catch-up as safety net
        </p>
      </div>

      <SyncHealthBanner syncStatus={syncStatus} status={status} />

      <div className="v10-explorer-stats compact">
        <div className="stat-card compact">
          <div className="accent" style={{ background: 'var(--accent-blue)' }} />
          <div className="stat-label">Context Graphs Discovered</div>
          <div className="stat-value">{contextGraphs.length}</div>
        </div>
        <div className="stat-card compact">
          <div className="accent" style={{ background: 'var(--accent-green)' }} />
          <div className="stat-label">CGs With Data</div>
          <div className="stat-value">{withDataCount}</div>
          <div className="stat-sub">{contextGraphs.length - withDataCount} empty</div>
        </div>
        <div className="stat-card compact">
          <div className="accent" style={{ background: 'var(--accent-amber)' }} />
          <div className="stat-label">Total Triples Synced</div>
          <div className="stat-value">{formatNumber(totalTriples)}</div>
        </div>
        <div className="stat-card compact">
          <div className="accent" style={{ background: 'var(--purple)' }} />
          <div className="stat-label">Connected Peers</div>
          <div className="stat-value">{status?.connectedPeers ?? 0}</div>
        </div>
      </div>

      <div className="sync-dashboard-toggle" onClick={() => setExpanded(!expanded)}>
        <span>{expanded ? '▾' : '▸'} Context Graphs ({contextGraphs.length})</span>
      </div>

      {expanded && <CGTable contextGraphs={contextGraphs} intervalMs={intervalMs} />}

      <SyncLogFeed />
    </div>
  );
}
