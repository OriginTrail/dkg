import React, { useState, useMemo } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { useTabsStore } from '../stores/tabs.js';
import { useExplorerStore, type StatusFilter } from '../stores/explorer.js';


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

/* ─── Stat Card ─── */
function StatCard({ label, value, sub, accentColor }: {
  label: string; value: string | number; sub?: string; accentColor?: string;
}) {
  return (
    <div className="stat-card">
      {accentColor && <div className="accent" style={{ background: accentColor }} />}
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/* ─── Sort header ─── */
function SortHeader({ label, field, current, dir, onSort }: {
  label: string; field: string; current: string; dir: string; onSort: (f: any) => void;
}) {
  const active = current === field;
  return (
    <th className="v10-explorer-th" onClick={() => onSort(field)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      {label} {active ? (dir === 'asc' ? '↑' : '↓') : ''}
    </th>
  );
}


/* ─── Network Overview ─── */
function NetworkOverview({ syncStatus, status, metrics }: { syncStatus: any; status: any; metrics: any }) {
  const peers = status?.connectedPeers ?? 0;
  const cgs = syncStatus?.contextGraphs ?? [];
  const total = cgs.length;
  const withData = cgs.filter((cg: any) => (cg.totalTriples ?? 0) > 0).length;
  const totalTriples = cgs.reduce((s: number, cg: any) => s + (cg.totalTriples ?? 0), 0);
  const totalKAs = metrics?.total_kas ?? metrics?.totalKAs ?? '—';

  return (
    <div className="v10-explorer-stats">
      <StatCard label="Context Graphs" value={total} accentColor="var(--accent-blue)" sub={`${withData} with data`} />
      <StatCard label="Total Triples" value={formatNumber(totalTriples)} accentColor="var(--accent-green)" />
      <StatCard
        label="Knowledge Assets"
        value={typeof totalKAs === 'number' ? formatNumber(totalKAs) : totalKAs}
        accentColor="var(--accent-amber)"
      />
      <StatCard label="Connected Peers" value={peers} accentColor="var(--purple)" />
    </div>
  );
}

/* ─── Context Graph Directory ─── */
function ContextGraphDirectory({ contextGraphs }: { contextGraphs: any[] }) {
  const { openTab } = useTabsStore();
  const { filters, setSearch, setSortBy, setStatusFilter } = useExplorerStore();

  const filtered = useMemo(() => {
    let list = contextGraphs;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      list = list.filter((cg: any) =>
        (cg.name ?? cg.id).toLowerCase().includes(q) || cg.id.toLowerCase().includes(q),
      );
    }
    if (filters.statusFilter === 'synced') {
      list = list.filter((cg: any) => (cg.totalTriples ?? 0) > 0);
    } else if (filters.statusFilter === 'pending') {
      list = list.filter((cg: any) => (cg.totalTriples ?? 0) === 0);
    }
    list = [...list].sort((a: any, b: any) => {
      let cmp = 0;
      if (filters.sortBy === 'name') cmp = (a.name ?? a.id).localeCompare(b.name ?? b.id);
      else if (filters.sortBy === 'triples') cmp = (a.totalTriples ?? 0) - (b.totalTriples ?? 0);
      else if (filters.sortBy === 'lastSynced') cmp = (a.lastSyncedAt ?? 0) - (b.lastSyncedAt ?? 0);
      return filters.sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [contextGraphs, filters]);

  return (
    <div className="v10-explorer-directory">
      <div className="v10-explorer-directory-header">
        <h3>Context Graphs</h3>
        <div className="v10-explorer-controls">
          <div className="v10-explorer-status-pills">
            {(['all', 'synced', 'pending'] as StatusFilter[]).map((s) => (
              <button
                key={s}
                className={`v10-explorer-pill ${filters.statusFilter === s ? 'active' : ''}`}
                onClick={() => setStatusFilter(s)}
              >
                {s === 'all' ? 'All' : s === 'synced' ? 'With data' : 'Empty'}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="v10-explorer-search"
            placeholder="Filter..."
            value={filters.search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="v10-explorer-table-wrap">
        <table className="v10-explorer-table">
          <thead>
            <tr>
              <SortHeader label="Name" field="name" current={filters.sortBy} dir={filters.sortDir} onSort={setSortBy} />
              <SortHeader label="Triples" field="triples" current={filters.sortBy} dir={filters.sortDir} onSort={setSortBy} />
              <SortHeader label="Last Synced" field="lastSynced" current={filters.sortBy} dir={filters.sortDir} onSort={setSortBy} />
              <th className="v10-explorer-th">Syncs</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>
                  {contextGraphs.length === 0 ? 'No context graphs discovered yet' : 'No matches'}
                </td>
              </tr>
            ) : (
              filtered.map((cg: any) => (
                <tr
                  key={cg.id}
                  className="v10-explorer-row"
                  onClick={() => openTab({ id: `explorer-cg:${cg.id}`, label: cg.name ?? cg.id, closable: true })}
                >
                  <td className="v10-explorer-td">
                    <div className="v10-explorer-cg-name">{cg.name ?? cg.id}</div>
                    <div className="v10-explorer-cg-id">{cg.id}</div>
                  </td>
                  <td className="v10-explorer-td">{formatNumber(cg.totalTriples ?? 0)}</td>
                  <td className="v10-explorer-td">{cg.lastSyncedAt ? timeAgo(cg.lastSyncedAt) : '—'}</td>
                  <td className="v10-explorer-td">{cg.syncCount ?? 0}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Search Panel ─── */
function SearchPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'sparql' | 'entity'>('entity');

  const runSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      if (mode === 'sparql') {
        const res = await api.executeQuery(query);
        setResults(res?.result?.bindings ?? []);
      } else {
        const sparql = `SELECT ?p ?o WHERE { <${query.trim()}> ?p ?o } LIMIT 100`;
        const res = await api.executeQuery(sparql);
        setResults(res?.result?.bindings ?? []);
      }
    } catch (err: any) {
      setError(err.message);
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="v10-explorer-search-panel">
      <div className="v10-explorer-search-header">
        <h3>Search</h3>
        <div className="v10-explorer-mode-toggle">
          <button className={`v10-explorer-mode-btn ${mode === 'entity' ? 'active' : ''}`} onClick={() => setMode('entity')}>Entity URI</button>
          <button className={`v10-explorer-mode-btn ${mode === 'sparql' ? 'active' : ''}`} onClick={() => setMode('sparql')}>SPARQL</button>
        </div>
      </div>
      <div className="v10-explorer-search-input-row">
        <textarea
          className="v10-explorer-query-input"
          placeholder={mode === 'sparql' ? 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20' : 'did:dkg:...'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={mode === 'sparql' ? 4 : 1}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runSearch(); }}
        />
        <button className="v10-explorer-run-btn" onClick={runSearch} disabled={loading}>{loading ? '...' : 'Run'}</button>
      </div>
      {error && <div className="v10-explorer-error">{error}</div>}
      {results && (
        <div className="v10-explorer-results">
          <div className="v10-explorer-results-count">{results.length} result{results.length === 1 ? '' : 's'}</div>
          <div className="v10-explorer-results-table-wrap">
            <table className="v10-explorer-table">
              <thead><tr>{results.length > 0 && Object.keys(results[0]).map((k) => <th key={k} className="v10-explorer-th">{k}</th>)}</tr></thead>
              <tbody>
                {results.map((row: any, i: number) => (
                  <tr key={i} className="v10-explorer-row">
                    {Object.values(row).map((v: any, j: number) => (
                      <td key={j} className="v10-explorer-td v10-explorer-result-cell">{v?.value ?? String(v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main Explorer View ─── */
export function ExplorerView() {
  const { data: syncStatus } = useFetch(api.fetchSyncStatus, [], 5_000);
  const { data: status } = useFetch(api.fetchStatus, [], 10_000);
  const { data: metrics } = useFetch(api.fetchMetrics, [], 15_000);
  const [activeSection, setActiveSection] = useState<'directory' | 'search'>('directory');

  const contextGraphs = syncStatus?.contextGraphs ?? [];

  return (
    <div className="v10-explorer">
      <div className="v10-explorer-header">
        <h1 className="v10-explorer-title">Explorer</h1>
        <p className="v10-explorer-subtitle">Browse context graphs and knowledge on the network</p>
      </div>

      <NetworkOverview syncStatus={syncStatus} status={status} metrics={metrics} />

      <div className="v10-explorer-tabs">
        <button className={`v10-explorer-tab ${activeSection === 'directory' ? 'active' : ''}`} onClick={() => setActiveSection('directory')}>Context Graphs</button>
        <button className={`v10-explorer-tab ${activeSection === 'search' ? 'active' : ''}`} onClick={() => setActiveSection('search')}>Search</button>
      </div>

      {activeSection === 'directory' && (
        <ContextGraphDirectory contextGraphs={contextGraphs} />
      )}
      {activeSection === 'search' && <SearchPanel />}
    </div>
  );
}
