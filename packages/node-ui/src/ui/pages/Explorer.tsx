import React, { useState, useCallback, useEffect } from 'react';
import { Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import { useFetch, formatTime, shortId } from '../hooks.js';
import {
  executeQuery, fetchParanets, fetchQueryHistory, fetchSavedQueries,
  createSavedQuery, deleteSavedQuery, publishTriples,
} from '../api.js';
import { RdfGraph, useRdfGraph } from '@dkg/graph-viz/react';

export function ExplorerPage() {
  return (
    <div>
      <h1 className="page-title">Knowledge Explorer</h1>
      <div className="tab-group">
        <NavLink to="/explorer" end className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>Graph</NavLink>
        <NavLink to="/explorer/sparql" className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>SPARQL</NavLink>
        <NavLink to="/explorer/paranets" className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>Paranets</NavLink>
        <NavLink to="/explorer/publish" className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>Publish</NavLink>
        <NavLink to="/explorer/history" className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>History</NavLink>
        <NavLink to="/explorer/saved" className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>Saved</NavLink>
      </div>
      <Routes>
        <Route path="/" element={<GraphTab />} />
        <Route path="/sparql" element={<SparqlTab />} />
        <Route path="/paranets" element={<ParanetsTab />} />
        <Route path="/publish" element={<PublishTab />} />
        <Route path="/history" element={<HistoryTab />} />
        <Route path="/saved" element={<SavedTab />} />
      </Routes>
    </div>
  );
}

const GRAPH_LIMITS = [1000, 5000, 10000, 25000, 50000] as const;

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function isResourceObject(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('urn:') ||
    value.startsWith('_:') ||
    (value.startsWith('<') && value.endsWith('>'))
  );
}

/**
 * Convert quads into triples so that every triple appears in the graph.
 * Literal objects become synthetic nodes (_:lit_0, _:lit_1, ...) with an
 * rdfs:label triple so the value is shown on the node.
 */
function triplesWithLiteralsAsNodes(
  quads: Array<{ subject: string; predicate: string; object: string }>,
): Array<{ subject: string; predicate: string; object: string }> {
  const out: Array<{ subject: string; predicate: string; object: string }> = [];
  let litIndex = 0;
  for (const q of quads) {
    const obj = q.object;
    if (isResourceObject(obj)) {
      out.push({ subject: q.subject, predicate: q.predicate, object: obj });
    } else {
      const litId = `_:lit_${litIndex++}`;
      out.push({ subject: q.subject, predicate: q.predicate, object: litId });
      out.push({ subject: litId, predicate: RDFS_LABEL, object: obj });
    }
  }
  return out;
}

/** Calls zoomToFit after the graph has loaded so one or few nodes are framed correctly. */
function GraphZoomToFit() {
  const { viz } = useRdfGraph();
  useEffect(() => {
    if (!viz) return;
    const t = setTimeout(() => {
      try {
        viz.zoomToFit(40, 400);
      } catch {
        // ignore
      }
    }, 800);
    return () => clearTimeout(t);
  }, [viz]);
  return null;
}

const TYPE_FILTERS = [
  { label: 'All Types', value: '' },
  { label: 'Knowledge Assets', value: 'http://dkg.io/ontology/KnowledgeAsset' },
  { label: 'Knowledge Collections', value: 'http://dkg.io/ontology/KnowledgeCollection' },
  { label: 'Agents', value: 'https://dkg.network/ontology#Agent' },
  { label: 'Software Agents', value: 'http://schema.org/SoftwareAgent' },
  { label: 'Datasets', value: 'http://schema.org/Dataset' },
];

const TYPE_COLORS: Record<string, string> = {
  'http://dkg.io/ontology/KnowledgeAsset': '#10b981',
  'http://dkg.io/ontology/KnowledgeCollection': '#3b82f6',
  'https://dkg.network/ontology#Agent': '#8b5cf6',
  'http://schema.org/SoftwareAgent': '#8b5cf6',
  'http://schema.org/Dataset': '#f59e0b',
  'default': '#6b7280',
};

interface NodeDetails {
  uri: string;
  types: string[];
  outgoing: Array<{ predicate: string; object: string }>;
  incoming: Array<{ subject: string; predicate: string }>;
}

function GraphTab() {
  const { data: paranetData } = useFetch(fetchParanets, [], 30_000);
  const paranets = paranetData?.paranets ?? [];
  
  const [triples, setTriples] = useState<Array<{ subject: string; predicate: string; object: string }> | null>(null);
  const [allTriples, setAllTriples] = useState<Array<{ subject: string; predicate: string; object: string }> | null>(null);
  const [typeMap, setTypeMap] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(10000);
  const [refreshKey, setRefreshKey] = useState(0);
  
  // Filters
  const [typeFilter, setTypeFilter] = useState('');
  const [paranetFilter, setParanetFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showLiterals, setShowLiterals] = useState(true);
  
  // Selected node
  const [selectedNode, setSelectedNode] = useState<NodeDetails | null>(null);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Build SPARQL based on filters
      let sparql: string;
      if (paranetFilter) {
        sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${paranetFilter}> { ?s ?p ?o } } LIMIT ${limit}`;
      } else {
        sparql = `CONSTRUCT { ?s ?p ?o } WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } } LIMIT ${limit}`;
      }
      
      const res = await executeQuery(sparql);
      const raw = res?.result;
      const quads = raw?.quads;
      
      if (quads && Array.isArray(quads) && quads.length > 0) {
        const rawTriples = quads.map((q: { subject: string; predicate: string; object: string }) => ({
          subject: q.subject,
          predicate: q.predicate,
          object: q.object,
        }));
        
        // Build type map
        const types = new Map<string, string[]>();
        for (const t of rawTriples) {
          if (t.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
            const existing = types.get(t.subject) || [];
            existing.push(t.object);
            types.set(t.subject, existing);
          }
        }
        setTypeMap(types);
        setAllTriples(rawTriples);
        
        // Apply filters for display
        let filtered = rawTriples;
        
        // Type filter
        if (typeFilter) {
          const matchingSubjects = new Set<string>();
          for (const [subj, typeList] of types) {
            if (typeList.includes(typeFilter)) matchingSubjects.add(subj);
          }
          filtered = filtered.filter(t => matchingSubjects.has(t.subject) || matchingSubjects.has(t.object));
        }
        
        // Search filter
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          const matchingNodes = new Set<string>();
          for (const t of rawTriples) {
            if (t.subject.toLowerCase().includes(q) || t.object.toLowerCase().includes(q)) {
              matchingNodes.add(t.subject);
              matchingNodes.add(t.object);
            }
          }
          filtered = filtered.filter(t => matchingNodes.has(t.subject) || matchingNodes.has(t.object));
        }
        
        // Process literals
        if (showLiterals) {
          setTriples(triplesWithLiteralsAsNodes(filtered));
        } else {
          setTriples(filtered.filter(t => isResourceObject(t.object)));
        }
      } else {
        setTriples([]);
        setAllTriples([]);
      }
    } catch (err: any) {
      setError(err.message);
      setTriples(null);
    } finally {
      setLoading(false);
    }
  }, [limit, refreshKey, paranetFilter]);

  // Re-filter when filters change (without re-fetching)
  useEffect(() => {
    if (!allTriples) return;
    
    let filtered = allTriples;
    
    if (typeFilter) {
      const matchingSubjects = new Set<string>();
      for (const [subj, typeList] of typeMap) {
        if (typeList.includes(typeFilter)) matchingSubjects.add(subj);
      }
      filtered = filtered.filter(t => matchingSubjects.has(t.subject) || matchingSubjects.has(t.object));
    }
    
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchingNodes = new Set<string>();
      for (const t of allTriples) {
        if (t.subject.toLowerCase().includes(q) || t.object.toLowerCase().includes(q)) {
          matchingNodes.add(t.subject);
          matchingNodes.add(t.object);
        }
      }
      filtered = filtered.filter(t => matchingNodes.has(t.subject) || matchingNodes.has(t.object));
    }
    
    if (showLiterals) {
      setTriples(triplesWithLiteralsAsNodes(filtered));
    } else {
      setTriples(filtered.filter(t => isResourceObject(t.object)));
    }
  }, [typeFilter, searchQuery, showLiterals, allTriples, typeMap]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const handleNodeClick = useCallback((node: any) => {
    if (!allTriples) return;
    const uri = node.id || node.uri || node;
    if (typeof uri !== 'string') return;
    
    const outgoing: Array<{ predicate: string; object: string }> = [];
    const incoming: Array<{ subject: string; predicate: string }> = [];
    
    for (const t of allTriples) {
      if (t.subject === uri) outgoing.push({ predicate: t.predicate, object: t.object });
      if (t.object === uri) incoming.push({ subject: t.subject, predicate: t.predicate });
    }
    
    setSelectedNode({
      uri,
      types: typeMap.get(uri) || [],
      outgoing,
      incoming,
    });
  }, [allTriples, typeMap]);

  return (
    <div className="graph-explorer-layout">
      <div className="graph-explorer-main">
        <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Toolbar */}
          <div className="graph-toolbar">
            <div className="graph-toolbar-row">
              <input
                type="text"
                className="input"
                placeholder="Search nodes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ width: 180 }}
              />
              <select
                className="input"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                style={{ width: 'auto', minWidth: 140 }}
              >
                {TYPE_FILTERS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <select
                className="input"
                value={paranetFilter}
                onChange={(e) => { setParanetFilter(e.target.value); setRefreshKey(k => k + 1); }}
                style={{ width: 'auto', minWidth: 120 }}
              >
                <option value="">All Paranets</option>
                {paranets.map((p: any) => (
                  <option key={p.id} value={p.uri}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="graph-toolbar-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showLiterals}
                  onChange={(e) => setShowLiterals(e.target.checked)}
                />
                Show literals
              </label>
              <select
                className="input"
                style={{ width: 'auto', minWidth: 100 }}
                value={limit}
                onChange={(e) => { setLimit(Number(e.target.value)); setRefreshKey(k => k + 1); }}
              >
                {GRAPH_LIMITS.map((n) => (
                  <option key={n} value={n}>Limit {n}</option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm" onClick={() => setRefreshKey((k) => k + 1)} disabled={loading}>
                {loading ? 'Loading…' : 'Refresh'}
              </button>
              {triples && !loading && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {triples.length} triples
                </span>
              )}
            </div>
          </div>

          {/* Legend */}
          <div className="graph-legend">
            {TYPE_FILTERS.slice(1).map((t) => (
              <span key={t.value} className="graph-legend-item">
                <span className="graph-legend-dot" style={{ background: TYPE_COLORS[t.value] || TYPE_COLORS.default }} />
                {t.label}
              </span>
            ))}
          </div>

          {/* Graph */}
          {error && <div style={{ padding: 16, color: 'var(--error)' }}>{error}</div>}
          {loading && !triples && <div className="loading" style={{ minHeight: 400 }}>Loading graph…</div>}
          {triples && triples.length === 0 && !loading && (
            <div className="empty-state" style={{ minHeight: 400 }}>No triples match the current filters</div>
          )}
          {triples && triples.length > 0 && (
            <div style={{ flex: 1, minHeight: 400, background: 'var(--bg-input)' }}>
              <RdfGraph
                data={triples}
                format="triples"
                options={{
                  labelMode: 'humanized',
                  renderer: '2d',
                  hexagon: { baseSize: 3, minSize: 2, maxSize: 5, scaleWithDegree: true },
                }}
                style={{ width: '100%', height: '100%' }}
                onNodeClick={handleNodeClick}
              >
                <GraphZoomToFit />
              </RdfGraph>
            </div>
          )}
        </div>
      </div>

      {/* Details Panel */}
      {selectedNode && (
        <div className="graph-details-panel">
          <div className="graph-details-header">
            <h3>Node Details</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedNode(null)}>×</button>
          </div>
          <div className="graph-details-body">
            <div className="graph-details-section">
              <div className="graph-details-label">URI</div>
              <div className="graph-details-value mono">{selectedNode.uri}</div>
            </div>
            
            {selectedNode.types.length > 0 && (
              <div className="graph-details-section">
                <div className="graph-details-label">Types</div>
                {selectedNode.types.map((t, i) => (
                  <div key={i} className="graph-details-value">
                    <span className="graph-legend-dot" style={{ background: TYPE_COLORS[t] || TYPE_COLORS.default }} />
                    {shortLabel(t)}
                  </div>
                ))}
              </div>
            )}
            
            {selectedNode.outgoing.length > 0 && (
              <div className="graph-details-section">
                <div className="graph-details-label">Properties ({selectedNode.outgoing.length})</div>
                <div className="graph-details-triples">
                  {selectedNode.outgoing.slice(0, 20).map((t, i) => (
                    <div key={i} className="graph-details-triple">
                      <span className="predicate">{shortLabel(t.predicate)}</span>
                      <span className="object" title={t.object}>{shortLabel(t.object)}</span>
                    </div>
                  ))}
                  {selectedNode.outgoing.length > 20 && (
                    <div className="graph-details-more">+{selectedNode.outgoing.length - 20} more</div>
                  )}
                </div>
              </div>
            )}
            
            {selectedNode.incoming.length > 0 && (
              <div className="graph-details-section">
                <div className="graph-details-label">Referenced by ({selectedNode.incoming.length})</div>
                <div className="graph-details-triples">
                  {selectedNode.incoming.slice(0, 10).map((t, i) => (
                    <div key={i} className="graph-details-triple">
                      <span className="subject" title={t.subject}>{shortLabel(t.subject)}</span>
                      <span className="predicate">{shortLabel(t.predicate)}</span>
                    </div>
                  ))}
                  {selectedNode.incoming.length > 10 && (
                    <div className="graph-details-more">+{selectedNode.incoming.length - 10} more</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const TEMPLATES: Record<string, string> = {
  'All triples (limit 100)': 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100',
  'All agents': `SELECT ?name ?peerId WHERE {
  ?agent <urn:dkg:agentName> ?name ;
         <urn:dkg:peerId> ?peerId .
}`,
  'KCs in a paranet': `SELECT ?kc ?status WHERE {
  GRAPH ?meta {
    ?kc a <urn:dkg:KC> ;
        <urn:dkg:status> ?status .
  }
} LIMIT 50`,
  'Count triples per graph': `SELECT ?g (COUNT(*) AS ?count) WHERE {
  GRAPH ?g { ?s ?p ?o }
} GROUP BY ?g ORDER BY DESC(?count)`,
};

function SparqlTab() {
  const [sparql, setSparql] = useState(TEMPLATES['All triples (limit 100)']);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'json' | 'graph'>('table');
  const [execTime, setExecTime] = useState<number | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    const start = performance.now();
    try {
      const res = await executeQuery(sparql);
      const duration = Math.round(performance.now() - start);
      setExecTime(duration);
      const raw = res.result;
      setResult(raw?.bindings ?? raw);
    } catch (err: any) {
      setError(err.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [sparql]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  }, [run]);

  return (
    <div>
      <div className="toolbar">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="input"
            style={{ width: 'auto', minWidth: 200 }}
            onChange={(e) => { if (e.target.value) setSparql(e.target.value); }}
            defaultValue=""
          >
            <option value="" disabled>Templates...</option>
            {Object.entries(TEMPLATES).map(([name, q]) => (
              <option key={name} value={q}>{name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {execTime != null && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{execTime}ms</span>}
          <button className="btn btn-primary" onClick={run} disabled={loading}>
            {loading ? 'Running...' : 'Run Query'}
          </button>
        </div>
      </div>

      <textarea
        className="sparql-editor"
        value={sparql}
        onChange={(e) => setSparql(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={8}
        placeholder="Enter SPARQL query... (Ctrl+Enter to run)"
        spellCheck={false}
      />

      {error && (
        <div className="card" style={{ borderColor: 'var(--error)', marginTop: 12 }}>
          <div style={{ color: 'var(--error)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>{error}</div>
        </div>
      )}

      {result && (
        <div style={{ marginTop: 16 }}>
          <div className="result-tabs">
            <button className={`result-tab ${viewMode === 'table' ? 'active' : ''}`} onClick={() => setViewMode('table')}>Table</button>
            <button className={`result-tab ${viewMode === 'graph' ? 'active' : ''}`} onClick={() => setViewMode('graph')}>Graph</button>
            <button className={`result-tab ${viewMode === 'json' ? 'active' : ''}`} onClick={() => setViewMode('json')}>JSON</button>
          </div>

          {viewMode === 'table' && <ResultTable result={result} />}
          {viewMode === 'graph' && <ResultGraph result={result} />}
          {viewMode === 'json' && <div className="json-view">{JSON.stringify(result, null, 2)}</div>}
        </div>
      )}
    </div>
  );
}

function ResultTable({ result }: { result: any }) {
  if (!Array.isArray(result) || result.length === 0) {
    return <div className="empty-state">No results</div>;
  }

  const columns = Object.keys(result[0]);

  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
        {result.length} result{result.length !== 1 ? 's' : ''}
      </div>
      <table className="data-table">
        <thead>
          <tr>{columns.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {result.map((row: any, i: number) => (
            <tr key={i}>
              {columns.map(c => (
                <td key={c} className="mono" style={{ fontSize: 12 }}>
                  {typeof row[c] === 'string' && row[c].length > 80
                    ? <span title={row[c]}>{row[c].slice(0, 80)}...</span>
                    : String(row[c] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultGraph({ result }: { result: any }) {
  if (!Array.isArray(result) || result.length === 0) {
    return <div className="graph-container">No data to visualize</div>;
  }

  const hasTripleShape = result[0] && ('s' in result[0]) && ('p' in result[0]) && ('o' in result[0]);
  if (!hasTripleShape) {
    return <div className="graph-container">Graph view requires SELECT ?s ?p ?o queries</div>;
  }

  const nodesMap = new Map<string, { id: string; label: string; type: string }>();
  const edges: Array<{ source: string; target: string; label: string }> = [];

  for (const row of result) {
    const s = String(row.s);
    const p = String(row.p);
    const o = String(row.o);

    if (!nodesMap.has(s)) {
      nodesMap.set(s, { id: s, label: shortLabel(s), type: 'resource' });
    }

    const isLiteral = !o.startsWith('http') && !o.startsWith('urn:');
    if (!isLiteral) {
      if (!nodesMap.has(o)) {
        nodesMap.set(o, { id: o, label: shortLabel(o), type: 'resource' });
      }
      edges.push({ source: s, target: o, label: shortLabel(p) });
    } else {
      const litId = `${s}__${p}__lit`;
      nodesMap.set(litId, { id: litId, label: o.length > 30 ? o.slice(0, 30) + '...' : o, type: 'literal' });
      edges.push({ source: s, target: litId, label: shortLabel(p) });
    }
  }

  const nodes = Array.from(nodesMap.values());
  const nodeRadius = 6;
  const width = 800;
  const height = 400;

  // Simple circular layout (force layout would require a library)
  const positions = nodes.map((_, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const r = Math.min(width, height) * 0.35;
    return {
      x: width / 2 + r * Math.cos(angle),
      y: height / 2 + r * Math.sin(angle),
    };
  });

  const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));

  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        {nodes.length} nodes, {edges.length} edges
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ background: 'var(--bg-input)', borderRadius: 'var(--radius)' }}>
        <defs>
          <marker id="arrowhead" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
            <polygon points="0 0, 6 2, 0 4" fill="#6b7280" />
          </marker>
        </defs>

        {edges.map((e, i) => {
          const si = nodeIndex.get(e.source);
          const ti = nodeIndex.get(e.target);
          if (si == null || ti == null) return null;
          const s = positions[si];
          const t = positions[ti];
          const mx = (s.x + t.x) / 2;
          const my = (s.y + t.y) / 2;
          return (
            <g key={i}>
              <line x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                stroke="#374151" strokeWidth={1} markerEnd="url(#arrowhead)" />
              <text x={mx} y={my - 4} textAnchor="middle" fontSize={8} fill="#6b7280">{e.label}</text>
            </g>
          );
        })}

        {nodes.map((n, i) => {
          const p = positions[i];
          const fill = n.type === 'literal' ? '#f59e0b' : '#3b82f6';
          return (
            <g key={n.id}>
              <circle cx={p.x} cy={p.y} r={nodeRadius} fill={fill} />
              <text x={p.x} y={p.y + nodeRadius + 12} textAnchor="middle" fontSize={9} fill="#e5e7eb">{n.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ParanetsTab() {
  const { data } = useFetch(fetchParanets, [], 30_000);
  const paranets = data?.paranets ?? [];
  const navigate = useNavigate();

  return (
    <div>
      {paranets.length === 0 ? (
        <div className="empty-state">No paranets found</div>
      ) : (
        <div className="paranet-list">
          {paranets.map((p: any) => (
            <div key={p.id} className="paranet-card" onClick={() => {
              navigate('/explorer');
              // Auto-fill a query for this paranet's KCs
            }}>
              <h3>{p.name}</h3>
              <p>{p.description || p.uri}</p>
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                {p.isSystem && <span className="badge badge-info" style={{ marginRight: 4 }}>system</span>}
                <span className="mono">{shortId(p.id, 16)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PublishTab() {
  const { data: paranetData } = useFetch(fetchParanets, [], 30_000);
  const paranets = paranetData?.paranets?.filter((p: any) => !p.isSystem) ?? [];

  const [paranetId, setParanetId] = useState('');
  const [turtleInput, setTurtleInput] = useState(
`@prefix ex: <http://example.org/> .

ex:Alice ex:knows ex:Bob .
ex:Alice ex:name "Alice" .
ex:Bob ex:name "Bob" .`
  );
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const publish = async () => {
    if (!paranetId) { setError('Select a paranet'); return; }
    setLoading(true);
    setError(null);
    try {
      const quads = parseTurtleToQuads(turtleInput);
      if (quads.length === 0) { setError('No valid triples parsed'); setLoading(false); return; }
      const res = await publishTriples(paranetId, quads);
      setResult(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="card">
        <div className="card-title">Publish Triples</div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Paranet</label>
          <select className="input" value={paranetId} onChange={(e) => setParanetId(e.target.value)}>
            <option value="">Select paranet...</option>
            {paranets.map((p: any) => (
              <option key={p.id} value={p.id}>{p.name} ({shortId(p.id)})</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Triples (Turtle format)</label>
          <textarea
            className="sparql-editor"
            value={turtleInput}
            onChange={(e) => setTurtleInput(e.target.value)}
            rows={10}
            placeholder="Enter triples in Turtle format..."
            spellCheck={false}
          />
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={publish} disabled={loading}>
            {loading ? 'Publishing...' : 'Publish'}
          </button>
          {error && <span style={{ color: 'var(--error)', fontSize: 13 }}>{error}</span>}
        </div>

        {result && (
          <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-input)', borderRadius: 'var(--radius)' }}>
            <div style={{ fontSize: 12, color: 'var(--success)', marginBottom: 4 }}>Published successfully</div>
            <div className="json-view" style={{ maxHeight: 200 }}>{JSON.stringify(result, null, 2)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryTab() {
  const { data } = useFetch(() => fetchQueryHistory(50), [], 10_000);
  const history = data?.history ?? [];
  const navigate = useNavigate();

  return (
    <div>
      {history.length === 0 ? (
        <div className="empty-state">No query history yet</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Query</th>
                <th>Duration</th>
                <th>Results</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h: any) => (
                <tr key={h.id} style={{ cursor: 'pointer' }} onClick={() => navigate('/explorer')}>
                  <td>{formatTime(h.ts)}</td>
                  <td className="mono" style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
                    {h.sparql}
                  </td>
                  <td>{h.duration_ms != null ? `${h.duration_ms}ms` : '—'}</td>
                  <td>{h.result_count ?? '—'}</td>
                  <td>{h.error ? <span className="badge badge-error">error</span> : <span className="badge badge-success">ok</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SavedTab() {
  const { data, refresh } = useFetch(fetchSavedQueries, []);
  const queries = data?.queries ?? [];
  const [name, setName] = useState('');
  const [sparql, setSparql] = useState('');

  const save = async () => {
    if (!name || !sparql) return;
    await createSavedQuery({ name, sparql });
    setName('');
    setSparql('');
    refresh();
  };

  const remove = async (id: number) => {
    await deleteSavedQuery(id);
    refresh();
  };

  return (
    <div>
      <div className="card">
        <div className="card-title">Save a Query</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="input" placeholder="Query name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 300 }} />
          <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
        </div>
        <textarea className="sparql-editor" value={sparql} onChange={(e) => setSparql(e.target.value)} rows={4} placeholder="SPARQL..." spellCheck={false} />
      </div>

      {queries.length === 0 ? (
        <div className="empty-state">No saved queries</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Query</th>
                <th>Saved</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queries.map((q: any) => (
                <tr key={q.id}>
                  <td style={{ fontWeight: 600 }}>{q.name}</td>
                  <td className="mono" style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
                    {q.sparql}
                  </td>
                  <td>{formatTime(q.created_at)}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => remove(q.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Utility ---

function shortLabel(uri: string): string {
  if (uri.includes('#')) return uri.split('#').pop()!;
  const parts = uri.split('/');
  return parts[parts.length - 1] || uri;
}

/**
 * Minimalist Turtle → quads parser for the publish form.
 * Handles simple triples with prefixes. Not a full Turtle parser.
 */
function parseTurtleToQuads(input: string): Array<{ subject: string; predicate: string; object: string; graph: string }> {
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
  const prefixes: Record<string, string> = {};

  const lines = input.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  for (const line of lines) {
    const prefixMatch = line.match(/^@prefix\s+(\w*):?\s+<([^>]+)>\s*\.?\s*$/);
    if (prefixMatch) {
      prefixes[prefixMatch[1]] = prefixMatch[2];
      continue;
    }

    // Simple triple: subject predicate object .
    const tripleMatch = line.match(/^(\S+)\s+(\S+)\s+(.+?)\s*\.\s*$/);
    if (!tripleMatch) continue;

    const [, s, p, o] = tripleMatch;
    quads.push({
      subject: expandPrefixed(s, prefixes),
      predicate: expandPrefixed(p, prefixes),
      object: o.startsWith('"') ? o.replace(/^"|"$/g, '') : expandPrefixed(o, prefixes),
      graph: '',
    });
  }

  return quads;
}

function expandPrefixed(term: string, prefixes: Record<string, string>): string {
  if (term.startsWith('<') && term.endsWith('>')) return term.slice(1, -1);
  const colonIdx = term.indexOf(':');
  if (colonIdx > 0) {
    const prefix = term.slice(0, colonIdx);
    if (prefixes[prefix]) return prefixes[prefix] + term.slice(colonIdx + 1);
  }
  return term;
}
