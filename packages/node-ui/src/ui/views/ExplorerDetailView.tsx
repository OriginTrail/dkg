import React, { useState, useMemo } from 'react';
import { useTabsStore } from '../stores/tabs.js';
import { useMemoryEntities, type MemoryEntity, type TrustLevel } from '../hooks/useMemoryEntities.js';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { authHeaders } from '../api.js';

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

const TRUST_COLORS: Record<TrustLevel, string> = {
  verified: 'var(--accent-green)',
  shared: 'var(--accent-blue)',
  working: 'var(--accent-amber)',
};

const TRUST_LABELS: Record<TrustLevel, string> = {
  verified: 'Verified',
  shared: 'Shared',
  working: 'Working',
};

function shortUri(uri: string): string {
  if (!uri) return '—';
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

/* ─── Entity row with expandable triples ─── */
function EntityRow({ entity }: { entity: MemoryEntity }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr className="v10-explorer-row" onClick={() => setExpanded(!expanded)}>
        <td className="v10-explorer-td">
          <div className="v10-ed-entity-label">{entity.label}</div>
          <div className="v10-ed-entity-uri">{entity.uri}</div>
        </td>
        <td className="v10-explorer-td">
          {entity.types.length > 0
            ? entity.types.map((t) => <span key={t} className="v10-ed-type-chip">{shortUri(t)}</span>)
            : <span className="v10-ed-no-type">—</span>}
        </td>
        <td className="v10-explorer-td">
          <span className="v10-ed-trust-badge" style={{ color: TRUST_COLORS[entity.trustLevel] }}>
            {TRUST_LABELS[entity.trustLevel]}
          </span>
        </td>
        <td className="v10-explorer-td">{entity.properties.size + entity.connections.length}</td>
        <td className="v10-explorer-td" style={{ fontSize: 16, color: 'var(--text-tertiary)' }}>
          {expanded ? '▾' : '▸'}
        </td>
      </tr>
      {expanded && (
        <tr className="v10-ed-expanded-row">
          <td colSpan={5} className="v10-ed-expanded-cell">
            <table className="v10-ed-triples-table">
              <thead>
                <tr>
                  <th className="v10-ed-triples-th">Predicate</th>
                  <th className="v10-ed-triples-th">Value</th>
                </tr>
              </thead>
              <tbody>
                {[...entity.properties.entries()].map(([pred, vals]) =>
                  vals.map((val, i) => (
                    <tr key={`${pred}-${i}`}>
                      <td className="v10-ed-triples-td v10-ed-pred">{shortUri(pred)}</td>
                      <td className="v10-ed-triples-td v10-ed-val">{val}</td>
                    </tr>
                  ))
                )}
                {entity.connections.map((conn, i) => (
                  <tr key={`conn-${i}`}>
                    <td className="v10-ed-triples-td v10-ed-pred">{shortUri(conn.predicate)}</td>
                    <td className="v10-ed-triples-td v10-ed-val v10-ed-link">{conn.targetLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

/* ─── Entity List (KA browser) ─── */
function EntityList({ contextGraphId }: { contextGraphId: string }) {
  const { entityList, counts, loading, error, refresh } = useMemoryEntities(contextGraphId);
  const [search, setSearch] = useState('');
  const [trustFilter, setTrustFilter] = useState<TrustLevel | 'all'>('all');

  const filtered = useMemo(() => {
    let list = entityList;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((e) => e.label.toLowerCase().includes(q) || e.uri.toLowerCase().includes(q));
    }
    if (trustFilter !== 'all') {
      list = list.filter((e) => e.trustLevel === trustFilter);
    }
    return list;
  }, [entityList, search, trustFilter]);

  if (loading) {
    return <div className="v10-ed-loading">Loading entities...</div>;
  }
  if (error) {
    return <div className="v10-explorer-error">{error} <button onClick={refresh} className="v10-ed-retry">Retry</button></div>;
  }

  return (
    <div>
      <div className="v10-ed-entity-controls">
        <input
          type="text"
          className="v10-explorer-search"
          placeholder="Filter entities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="v10-explorer-status-pills">
          {(['all', 'verified', 'shared', 'working'] as const).map((t) => (
            <button
              key={t}
              className={`v10-explorer-pill ${trustFilter === t ? 'active' : ''}`}
              onClick={() => setTrustFilter(t)}
            >
              {t === 'all' ? `All (${entityList.length})` :
               `${TRUST_LABELS[t]} (${entityList.filter((e) => e.trustLevel === t).length})`}
            </button>
          ))}
        </div>
      </div>
      <div className="v10-ed-counts">
        <span>WM: {counts.wm}</span>
        <span>SWM: {counts.swm}</span>
        <span>VM: {counts.vm}</span>
      </div>
      <div className="v10-explorer-table-wrap">
        <table className="v10-explorer-table">
          <thead>
            <tr>
              <th className="v10-explorer-th">Entity</th>
              <th className="v10-explorer-th">Type</th>
              <th className="v10-explorer-th">Trust</th>
              <th className="v10-explorer-th">Properties</th>
              <th className="v10-explorer-th" style={{ width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>No entities found</td></tr>
            ) : (
              filtered.map((e) => <EntityRow key={e.uri} entity={e} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Raw Triple Table ─── */
function TripleTable({ contextGraphId, view }: { contextGraphId: string; view: string }) {
  const [triples, setTriples] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const sparql = `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 500`;
        const body: Record<string, unknown> = { sparql, contextGraphId };
        if (view === 'swm') body.view = 'shared-working-memory';
        else if (view === 'vm') body.view = 'verified-memory';
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setTriples(data?.result?.bindings ?? []);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [contextGraphId, view]);

  if (loading) return <div className="v10-ed-loading">Loading triples...</div>;
  if (error) return <div className="v10-explorer-error">{error}</div>;
  if (!triples?.length) return <div className="v10-ed-loading">No triples in this layer</div>;

  return (
    <div className="v10-explorer-table-wrap" style={{ maxHeight: 500 }}>
      <table className="v10-explorer-table">
        <thead>
          <tr>
            <th className="v10-explorer-th">Subject</th>
            <th className="v10-explorer-th">Predicate</th>
            <th className="v10-explorer-th">Object</th>
          </tr>
        </thead>
        <tbody>
          {triples.map((row: any, i: number) => {
            const s = typeof row.s === 'string' ? row.s : row.s?.value ?? '';
            const p = typeof row.p === 'string' ? row.p : row.p?.value ?? '';
            const o = typeof row.o === 'string' ? row.o : row.o?.value ?? '';
            return (
              <tr key={i} className="v10-explorer-row">
                <td className="v10-explorer-td v10-explorer-result-cell">{shortUri(s)}</td>
                <td className="v10-explorer-td v10-explorer-result-cell">{shortUri(p)}</td>
                <td className="v10-explorer-td v10-explorer-result-cell">{o}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Main Detail View ─── */
export function ExplorerDetailView({ contextGraphId }: { contextGraphId: string }) {
  const { data: syncStatus } = useFetch(api.fetchSyncStatus, [], 5_000);
  const { openTab } = useTabsStore();
  const [activeTab, setActiveTab] = useState<'entities' | 'vm' | 'swm'>('entities');

  const cgInfo = useMemo(() => {
    const cgs = syncStatus?.contextGraphs ?? [];
    return cgs.find((cg: any) => cg.id === contextGraphId) ?? null;
  }, [syncStatus, contextGraphId]);

  const isSynced = cgInfo?.synced && (cgInfo?.totalTriples ?? 0) > 0;

  return (
    <div className="v10-explorer v10-ed">
      <div className="v10-ed-back" onClick={() => openTab({ id: 'explorer', label: 'Explorer', closable: true })}>
        ← Back to Explorer
      </div>

      <div className="v10-ed-header">
        <div className="v10-ed-header-main">
          <h1 className="v10-explorer-title">{cgInfo?.name ?? contextGraphId}</h1>
          <span
            className="v10-ed-status-badge"
            style={{ color: isSynced ? 'var(--accent-green)' : 'var(--accent-amber)' }}
          >
            {isSynced ? '● synced' : '● pending'}
          </span>
        </div>
        <div className="v10-ed-id">{contextGraphId}</div>
      </div>

      <div className="v10-ed-stats">
        <div className="v10-ed-stat">
          <div className="v10-ed-stat-val">{formatNumber(cgInfo?.totalTriples ?? 0)}</div>
          <div className="v10-ed-stat-label">Triples</div>
        </div>
        <div className="v10-ed-stat">
          <div className="v10-ed-stat-val">{cgInfo?.syncCount ?? 0}</div>
          <div className="v10-ed-stat-label">Sync Rounds</div>
        </div>
        <div className="v10-ed-stat">
          <div className="v10-ed-stat-val">{cgInfo?.lastSyncedAt ? timeAgo(cgInfo.lastSyncedAt) : '—'}</div>
          <div className="v10-ed-stat-label">Last Synced</div>
        </div>
        {cgInfo?.onChainId && (
          <div className="v10-ed-stat">
            <div className="v10-ed-stat-val" style={{ fontSize: 12 }}>{cgInfo.onChainId}</div>
            <div className="v10-ed-stat-label">On-Chain ID</div>
          </div>
        )}
      </div>

      <div className="v10-explorer-tabs">
        <button className={`v10-explorer-tab ${activeTab === 'entities' ? 'active' : ''}`} onClick={() => setActiveTab('entities')}>
          Knowledge Assets
        </button>
        <button className={`v10-explorer-tab ${activeTab === 'vm' ? 'active' : ''}`} onClick={() => setActiveTab('vm')}>
          Verified Memory
        </button>
        <button className={`v10-explorer-tab ${activeTab === 'swm' ? 'active' : ''}`} onClick={() => setActiveTab('swm')}>
          Shared Memory
        </button>
      </div>

      {activeTab === 'entities' && <EntityList contextGraphId={contextGraphId} />}
      {activeTab === 'vm' && <TripleTable contextGraphId={contextGraphId} view="vm" />}
      {activeTab === 'swm' && <TripleTable contextGraphId={contextGraphId} view="swm" />}
    </div>
  );
}

