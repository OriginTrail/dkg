import React, { useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { useFetch } from '../hooks.js';
import { executeQuery, listAssertions, promoteAssertion, publishSharedMemory, listSwmEntities, type AssertionInfo, type PublishResult, type SwmRootEntity } from '../api.js';
import { FilePreviewModal } from '../components/Modals/FilePreviewModal.js';

const RdfGraph = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.RdfGraph }))
);
const NodePanel = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.NodePanel }))
);

type MemoryLayer = 'wm' | 'swm' | 'vm';
type ViewMode = 'table' | 'graph';

const LAYER_META: Record<MemoryLayer, { label: string; color: string; icon: string; description: string }> = {
  wm: { label: 'Working Memory', color: 'var(--layer-working)', icon: '◇', description: 'Private agent drafts. Fast local storage.' },
  swm: { label: 'Shared Working Memory', color: 'var(--layer-shared)', icon: '◈', description: 'Shared proposals with collaborators. TTL-bounded.' },
  vm: { label: 'Verified Memory', color: 'var(--layer-verified)', icon: '◉', description: 'Endorsed, published, on-chain knowledge.' },
};

const GRAPH_OPTIONS = {
  labelMode: 'humanized' as const,
  renderer: '2d' as const,
  labels: {
    predicates: [
      'http://schema.org/text',
      'http://schema.org/name',
      'http://www.w3.org/2000/01/rdf-schema#label',
      'http://purl.org/dc/terms/title',
    ],
  },
  style: {
    classColors: {
      'http://schema.org/Person': '#f472b6',
      'http://schema.org/Organization': '#fb923c',
      'http://schema.org/Place': '#34d399',
      'http://schema.org/Product': '#c084fc',
      'http://schema.org/Event': '#facc15',
      'http://schema.org/CreativeWork': '#7dd3fc',
      'http://schema.org/Thing': '#94a3b8',
    },
    defaultNodeColor: '#94a3b8',
    defaultEdgeColor: '#5f8598',
    edgeWidth: 0.9,
  },
  hexagon: { baseSize: 4, minSize: 3, maxSize: 6, scaleWithDegree: true },
  focus: { maxNodes: 3000, hops: 999 },
};

const TABLE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="3" y1="15" x2="21" y2="15" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

const GRAPH_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="18" r="3" />
    <line x1="8.5" y1="7.5" x2="15.5" y2="16.5" />
    <line x1="15.5" y1="7.5" x2="8.5" y2="16.5" />
  </svg>
);

interface MemoryLayerViewProps {
  layer: MemoryLayer;
  contextGraphId: string;
}

export function MemoryLayerView({ layer, contextGraphId }: MemoryLayerViewProps) {
  const meta = LAYER_META[layer];
  const [viewMode, setViewMode] = useState<ViewMode>('graph');
  const [draftQuery, setDraftQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');

  const defaultSparql = useMemo(() => {
    if (layer === 'wm') {
      const cgUri = `did:dkg:context-graph:${contextGraphId}`;
      return `SELECT ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${cgUri}")) } } LIMIT 1000`;
    }
    return `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 500`;
  }, [layer, contextGraphId]);

  const sparql = activeQuery || defaultSparql;

  const graphSuffix = layer === 'swm' ? '_shared_memory' as const : undefined;
  const includeShared = layer === 'swm';

  const { data, loading, error, refresh } = useFetch(
    () => executeQuery(sparql, contextGraphId, includeShared, graphSuffix),
    [sparql, contextGraphId, layer],
    0
  );

  const runQuery = useCallback(() => {
    const next = draftQuery.trim();
    if (next === activeQuery) {
      refresh();
      return;
    }
    setActiveQuery(next);
  }, [activeQuery, draftQuery, refresh]);

  const results = data?.result?.bindings ?? data?.results?.bindings ?? [];

  const triples = useMemo(() =>
    results.map((row: any) => ({
      subject: bv(row.s) ?? '',
      predicate: bv(row.p) ?? '',
      object: bv(row.o) ?? '',
    })).filter((t: any) => t.subject && t.predicate && t.object),
    [results]
  );

  const handleNodeClick = useCallback((node: any) => {
    if (node?.id) {
      setActiveQuery(`SELECT ?p ?o WHERE { <${node.id}> ?p ?o } LIMIT 100`);
    }
  }, []);

  return (
    <div className="v10-memory-layer-view">
      <div className="v10-mlv-header">
        <span className="v10-mlv-icon" style={{ color: meta.color }}>{meta.icon}</span>
        <div>
          <h2 className="v10-mlv-title">{meta.label}</h2>
          <p className="v10-mlv-desc">{meta.description}</p>
        </div>
      </div>

      {layer === 'wm' && (
        <AssertionList contextGraphId={contextGraphId} onPromoted={refresh} />
      )}

      {layer === 'swm' && (
        <PublishPanel contextGraphId={contextGraphId} onPublished={refresh} />
      )}

      <div className="v10-mlv-query-bar">
        <input
          type="text"
          className="v10-mlv-query-input"
          placeholder="Custom SPARQL query..."
          value={draftQuery}
          onChange={(e) => setDraftQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runQuery(); }}
        />
        <button className="v10-mlv-run-btn" onClick={runQuery}>
          Run
        </button>
        {activeQuery && (
          <button
            className="v10-mlv-clear-btn"
            onClick={() => setActiveQuery('')}
            title="Reset to full layer overview"
          >
            Reset
          </button>
        )}
        <div className="v10-mlv-view-toggle">
          <button
            className={`v10-mlv-toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
            onClick={() => setViewMode('table')}
            title="Table view"
          >
            {TABLE_ICON}
          </button>
          <button
            className={`v10-mlv-toggle-btn ${viewMode === 'graph' ? 'active' : ''}`}
            onClick={() => setViewMode('graph')}
            title="Graph view"
          >
            {GRAPH_ICON}
          </button>
        </div>
      </div>

      {loading && <p className="v10-mlv-status">Loading...</p>}
      {error && <p className="v10-mlv-status" style={{ color: 'var(--accent-red)' }}>Error: {error}</p>}

      {!loading && results.length === 0 && (
        <div className="v10-mlv-empty">
          <p>No triples found in {meta.label.toLowerCase()}.</p>
          <p style={{ fontSize: 11, marginTop: 4 }}>
            {layer === 'wm' && 'Import files or chat with your agent to generate working memory.'}
            {layer === 'swm' && 'Promote assertions from working memory to share with collaborators.'}
            {layer === 'vm' && 'Publish shared memory to create verified on-chain knowledge.'}
          </p>
        </div>
      )}

      {!loading && results.length > 0 && viewMode === 'table' && (
        <div className="v10-mlv-table-wrap">
          <div className="v10-mlv-result-count">{results.length} triples</div>
          <table className="v10-mlv-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Predicate</th>
                <th>Object</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row: any, i: number) => (
                <tr key={i}>
                  <td className="v10-mlv-cell">{shorten(bv(row.s))}</td>
                  <td className="v10-mlv-cell">{shorten(bv(row.p))}</td>
                  <td className="v10-mlv-cell">{shorten(bv(row.o))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && triples.length > 0 && viewMode === 'graph' && (
        <div className="v10-mlv-graph-container">
          <div className="v10-mlv-graph-info">
            <span>{triples.length} triples</span>
            {activeQuery && <span className="v10-mlv-graph-info-custom">filtered</span>}
          </div>
          <Suspense fallback={<div className="v10-mlv-graph-loading">Loading graph renderer...</div>}>
            <RdfGraph
              data={triples}
              format="triples"
              options={GRAPH_OPTIONS}
              style={{ width: '100%', height: '100%' }}
              onNodeClick={handleNodeClick}
              initialFit
            >
              <NodePanel
                className="v10-mlv-node-panel"
                showUri
                showTypes
                showProperties
                showMetadata={false}
                maxValueLength={150}
              />
            </RdfGraph>
          </Suspense>
        </div>
      )}
    </div>
  );
}

/* ── WM Assertion List (promote to SWM) ── */

function AssertionList({ contextGraphId, onPromoted }: { contextGraphId: string; onPromoted: () => void }) {
  const { data: assertions, loading, refresh } = useFetch(
    () => listAssertions(contextGraphId),
    [contextGraphId],
    0
  );
  const [promoting, setPromoting] = useState<string | null>(null);
  const [promoteResult, setPromoteResult] = useState<{ name: string; count: number } | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);

  const handlePromote = useCallback(async (name: string) => {
    setPromoting(name);
    setPromoteResult(null);
    setPromoteError(null);
    try {
      const res = await promoteAssertion(contextGraphId, name);
      setPromoteResult({ name, count: res.promotedCount });
      refresh();
      onPromoted();
    } catch (err: any) {
      setPromoteError(err.message ?? 'Promote failed');
    } finally {
      setPromoting(null);
    }
  }, [contextGraphId, refresh, onPromoted]);

  const handlePromoteAll = useCallback(async () => {
    if (!assertions?.length) return;
    setPromoting('__all__');
    setPromoteResult(null);
    setPromoteError(null);
    let totalPromoted = 0;
    try {
      for (const a of assertions) {
        const res = await promoteAssertion(contextGraphId, a.name);
        totalPromoted += res.promotedCount;
      }
      setPromoteResult({ name: 'all assertions', count: totalPromoted });
      refresh();
      onPromoted();
    } catch (err: any) {
      setPromoteError(err.message ?? 'Promote failed');
    } finally {
      setPromoting(null);
    }
  }, [assertions, contextGraphId, refresh, onPromoted]);

  if (loading) return <div className="v10-assertion-list-loading">Loading assertions...</div>;
  if (!assertions?.length) return null;

  return (
    <div className="v10-assertion-list">
      <div className="v10-assertion-list-header">
        <span className="v10-assertion-list-title">Assertions in Working Memory ({assertions.length})</span>
        <button
          className="v10-btn-promote-all"
          disabled={promoting !== null}
          onClick={handlePromoteAll}
        >
          {promoting === '__all__' ? 'Promoting...' : 'Promote All → SWM'}
        </button>
      </div>
      <div className="v10-assertion-items">
        {assertions.map((a) => (
          <div key={a.name} className="v10-assertion-item">
            <div className="v10-assertion-item-info">
              <button
                className="v10-assertion-item-name clickable"
                title={a.graphUri}
                onClick={() => setPreviewName(a.name)}
              >
                {a.name}
              </button>
              {a.tripleCount != null && (
                <span className="v10-assertion-item-count">{a.tripleCount} triples</span>
              )}
            </div>
            <button
              className="v10-btn-promote"
              disabled={promoting !== null}
              onClick={() => handlePromote(a.name)}
              title="Copy these triples to Shared Working Memory"
            >
              {promoting === a.name ? 'Promoting...' : '→ SWM'}
            </button>
          </div>
        ))}
      </div>
      {promoteResult && (
        <div className="v10-promote-result success">
          Promoted {promoteResult.count} triples from {promoteResult.name} to Shared Working Memory.
        </div>
      )}
      {promoteError && (
        <div className="v10-promote-result error">
          {promoteError}
        </div>
      )}

      {previewName && (
        <FilePreviewModal
          open
          onClose={() => setPreviewName(null)}
          assertionName={previewName}
          contextGraphId={contextGraphId}
        />
      )}
    </div>
  );
}

/* ── SWM Publish Panel (SWM → VM) ── */

function PublishPanel({ contextGraphId, onPublished }: { contextGraphId: string; onPublished: () => void }) {
  const { data: entities, loading, refresh } = useFetch(
    () => listSwmEntities(contextGraphId),
    [contextGraphId],
    0
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allUris = entities?.map(e => e.uri) ?? [];
  const allSelected = allUris.length > 0 && allUris.every(u => selected.has(u));

  const toggleOne = useCallback((uri: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri); else next.add(uri);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allUris));
    }
  }, [allSelected, allUris]);

  const handlePublishSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setPublishing(true);
    setPublishResult(null);
    setError(null);
    try {
      const roots = [...selected];
      const res = await publishSharedMemory(contextGraphId, roots);
      setPublishResult(res);
      setSelected(new Set());
      refresh();
      onPublished();
    } catch (err: any) {
      setError(err.message ?? 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }, [selected, contextGraphId, refresh, onPublished]);

  const handlePublishAll = useCallback(async () => {
    setPublishing(true);
    setPublishResult(null);
    setError(null);
    try {
      const res = await publishSharedMemory(contextGraphId);
      setPublishResult(res);
      setSelected(new Set());
      refresh();
      onPublished();
    } catch (err: any) {
      setError(err.message ?? 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }, [contextGraphId, refresh, onPublished]);

  const totalTriples = entities?.reduce((sum, e) => sum + e.tripleCount, 0) ?? 0;
  const selectedTriples = entities?.filter(e => selected.has(e.uri)).reduce((sum, e) => sum + e.tripleCount, 0) ?? 0;
  const isEmpty = !loading && (!entities || entities.length === 0);

  if (loading) return <div className="v10-assertion-list-loading">Loading SWM contents...</div>;
  if (isEmpty) {
    return (
      <div className="v10-publish-panel">
        <div className="v10-publish-panel-header">
          <span className="v10-publish-panel-title">Publish to Verified Memory</span>
        </div>
        <div className="v10-publish-panel-empty">
          No data in Shared Working Memory yet. Promote assertions from Working Memory first.
        </div>
      </div>
    );
  }

  return (
    <div className="v10-publish-panel">
      <div className="v10-publish-panel-header">
        <span className="v10-publish-panel-title">
          Entities in Shared Working Memory ({entities!.length} entities · {totalTriples} triples)
        </span>
        <div className="v10-publish-panel-header-actions">
          <button className="v10-publish-panel-refresh" onClick={refresh} title="Refresh">↻</button>
          <button
            className="v10-btn-promote-all"
            disabled={publishing}
            onClick={handlePublishAll}
          >
            {publishing && selected.size === 0 ? 'Publishing...' : 'Publish All → VM'}
          </button>
        </div>
      </div>

      <div className="v10-publish-select-bar">
        <label className="v10-publish-select-all">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          <span>Select all</span>
        </label>
        {selected.size > 0 && (
          <button
            className="v10-btn-publish"
            disabled={publishing}
            onClick={handlePublishSelected}
          >
            {publishing ? 'Publishing...' : `Publish ${selected.size} selected (${selectedTriples} triples) → VM`}
          </button>
        )}
      </div>

      <div className="v10-assertion-items">
        {entities!.map((e) => (
          <div key={e.uri} className={`v10-assertion-item ${selected.has(e.uri) ? 'selected' : ''}`}>
            <label className="v10-publish-entity-check">
              <input
                type="checkbox"
                checked={selected.has(e.uri)}
                onChange={() => toggleOne(e.uri)}
              />
            </label>
            <div className="v10-assertion-item-info">
              <span className="v10-assertion-item-name" title={e.uri}>{e.label}</span>
              <span className="v10-assertion-item-count">{e.tripleCount} triples</span>
            </div>
          </div>
        ))}
      </div>

      {publishResult && (
        <div className="v10-publish-result-card success">
          <div className="v10-publish-result-title">Published to Verified Memory</div>
          <div className="v10-publish-result-details">
            <div><span className="v10-publish-result-label">Knowledge Collection:</span> {publishResult.kcId}</div>
            <div><span className="v10-publish-result-label">Status:</span> {publishResult.status}</div>
            {publishResult.kas?.length > 0 && (
              <div><span className="v10-publish-result-label">Knowledge Assets:</span> {publishResult.kas.length}</div>
            )}
            {publishResult.txHash && (
              <div className="v10-publish-result-tx">
                <span className="v10-publish-result-label">Tx:</span>{' '}
                <span className="mono">{publishResult.txHash.slice(0, 10)}...{publishResult.txHash.slice(-8)}</span>
                {publishResult.blockNumber != null && (
                  <span className="v10-publish-result-block"> (block {publishResult.blockNumber})</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="v10-publish-result-card error">{error}</div>
      )}
    </div>
  );
}

/** Extract string from a SPARQL binding value (plain string or { value } object). */
function bv(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as any)) return String((v as any).value);
  return String(v);
}

function shorten(uri?: string): string {
  if (!uri) return '—';
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}
