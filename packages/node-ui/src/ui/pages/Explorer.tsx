import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { useFetch, formatTime, shortId } from '../hooks.js';
import { executeQuery, fetchParanets } from '../api.js';
import { RdfGraph, useRdfGraph } from '@dkg/graph-viz/react';
import type { ViewConfig } from '@dkg/graph-viz';

export function ExplorerPage() {
  return (
    <div>
      <h1 className="page-title">Knowledge Explorer</h1>
      <div className="tab-group">
        <NavLink to="/explorer" end className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>Graph</NavLink>
        <NavLink to="/explorer/sparql" className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>SPARQL</NavLink>
        <NavLink to="/explorer/paranets" className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}>Paranets</NavLink>
      </div>
      <Routes>
        <Route path="/" element={<GraphTab />} />
        <Route path="/sparql" element={<SparqlTab />} />
        <Route path="/paranets" element={<ParanetsTab />} />
        {/* Redirects for retired sub-routes */}
        <Route path="/publish" element={<Navigate to="/explorer" replace />} />
        <Route path="/history" element={<Navigate to="/explorer" replace />} />
        <Route path="/saved" element={<Navigate to="/explorer" replace />} />
      </Routes>
    </div>
  );
}

const GRAPH_LIMITS = [1000, 5000, 10000, 25000, 50000] as const;

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

type Triple = { subject: string; predicate: string; object: string };

// Distinct hues for per-paranet coloring
const PARANET_PALETTE = [
  { h: 25, s: 85, l: 55 },   // orange
  { h: 210, s: 80, l: 55 },  // blue
  { h: 150, s: 70, l: 45 },  // green
  { h: 280, s: 70, l: 60 },  // purple
  { h: 45, s: 85, l: 50 },   // gold
  { h: 340, s: 75, l: 55 },  // rose
  { h: 180, s: 70, l: 45 },  // teal
  { h: 90, s: 65, l: 45 },   // lime
];

function hslColor(h: number, s: number, l: number): string {
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function graphVariantColor(paranetIndex: number, graphIndex: number): string {
  const base = PARANET_PALETTE[paranetIndex % PARANET_PALETTE.length];
  const lShift = ((graphIndex % 5) - 2) * 6;
  return hslColor(base.h, base.s, Math.max(30, Math.min(75, base.l + lShift)));
}

function paranetBaseColorHex(index: number): string {
  const base = PARANET_PALETTE[index % PARANET_PALETTE.length];
  return hslColor(base.h, base.s, base.l);
}

const DEFAULT_EDGE = '#5f8598';
const DEFAULT_NODE = '#22d3ee';

function isResourceObject(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('urn:') ||
    value.startsWith('_:') ||
    (value.startsWith('<') && value.endsWith('>'))
  );
}

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

function GraphZoomToFit() {
  const { viz } = useRdfGraph();
  useEffect(() => {
    if (!viz) return;
    const t = setTimeout(() => {
      try {
        viz.zoomToFit(40);
      } catch {
        // ignore
      }
    }, 800);
    return () => clearTimeout(t);
  }, [viz]);
  return null;
}

interface NodeDetails {
  uri: string;
  types: string[];
  outgoing: Array<{ predicate: string; object: string }>;
  incoming: Array<{ subject: string; predicate: string }>;
}

interface PredicateStat {
  predicate: string;
  label: string;
  count: number;
}

interface ParanetLegendEntry {
  name: string;
  color: string;
}

function buildTypeMap(triples: Triple[]): Map<string, string[]> {
  const types = new Map<string, string[]>();
  for (const t of triples) {
    if (t.predicate !== RDF_TYPE) continue;
    const existing = types.get(t.subject) || [];
    existing.push(t.object);
    types.set(t.subject, existing);
  }
  return types;
}

function asNumeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === 'object') {
    const maybeValue = (value as { value?: unknown }).value;
    return asNumeric(maybeValue);
  }
  return null;
}

function extractCountFromQueryResult(result: any): number | null {
  const rows = Array.isArray(result?.bindings) ? result.bindings : (Array.isArray(result) ? result : null);
  if (!rows || rows.length === 0) return null;
  const first = rows[0];
  if (!first || typeof first !== 'object') return null;
  for (const k of ['count', 'total', 'c']) {
    const parsed = asNumeric((first as Record<string, unknown>)[k]);
    if (parsed != null) return parsed;
  }
  for (const v of Object.values(first as Record<string, unknown>)) {
    const parsed = asNumeric(v);
    if (parsed != null) return parsed;
  }
  return null;
}

function escapeSparqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const SAFE_IRI_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:[^\s<>"{}|\\^`]*$/;

function validateIri(uri: string): string | null {
  return SAFE_IRI_RE.test(uri) ? uri : null;
}

function buildPredicateStats(triples: Triple[], maxItems = 12): PredicateStat[] {
  const counts = new Map<string, number>();
  for (const t of triples) counts.set(t.predicate, (counts.get(t.predicate) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([predicate, count]) => ({ predicate, count, label: shortLabel(predicate) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxItems);
}

/**
 * Build per-graph color assignments from a SELECT DISTINCT ?s ?g query.
 * Each paranet gets a base hue; named graphs within a paranet get slight
 * lightness variations so they remain visually grouped.
 */
function buildGraphColorsFromMembership(
  rows: Array<{ s: string; g: string }>,
  paranets: Array<{ id: string; uri: string; name: string }>,
): {
  classColors: Record<string, string>;
  nodeGraphMap: Map<string, string>;
  legend: ParanetLegendEntry[];
} {
  const graphToParanetUri = new Map<string, string>();
  const paranetToGraphs = new Map<string, string[]>();

  for (const row of rows) {
    const g = String(row.g ?? '');
    if (!g || graphToParanetUri.has(g)) continue;
    const match = paranets.find((p) => g === p.uri || g.startsWith(p.uri + '/'));
    if (match) {
      graphToParanetUri.set(g, match.uri);
      if (!paranetToGraphs.has(match.uri)) paranetToGraphs.set(match.uri, []);
      paranetToGraphs.get(match.uri)!.push(g);
    }
  }

  const paranetUris = Array.from(paranetToGraphs.keys());
  const classColors: Record<string, string> = {};
  const legend: ParanetLegendEntry[] = [];

  for (let pi = 0; pi < paranetUris.length; pi++) {
    const pUri = paranetUris[pi];
    const pInfo = paranets.find((p) => p.uri === pUri);
    legend.push({
      name: pInfo?.name ?? shortLabel(pUri),
      color: paranetBaseColorHex(pi),
    });

    const graphs = paranetToGraphs.get(pUri)!;
    for (let gi = 0; gi < graphs.length; gi++) {
      classColors[graphs[gi]] = graphVariantColor(pi, gi);
    }
  }

  const nodeGraphMap = new Map<string, string>();
  for (const row of rows) {
    const g = String(row.g ?? '');
    const s = String(row.s ?? '');
    if (!g || !s) continue;
    if (!nodeGraphMap.has(s)) nodeGraphMap.set(s, g);
  }

  return { classColors, nodeGraphMap, legend };
}

function GraphTab() {
  const { data: paranetData } = useFetch(fetchParanets, [], 30_000);
  const paranets = paranetData?.paranets ?? [];

  const [triples, setTriples] = useState<Triple[] | null>(null);
  const [allTriples, setAllTriples] = useState<Triple[] | null>(null);
  const [typeMap, setTypeMap] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(10000);
  const [refreshKey, setRefreshKey] = useState(0);
  const [graphTotalCount, setGraphTotalCount] = useState<number | null>(null);
  const [emptyReason, setEmptyReason] = useState('');
  const [predicateStats, setPredicateStats] = useState<PredicateStat[]>([]);
  const [selectedPredicates, setSelectedPredicates] = useState<Set<string>>(new Set());
  const [graphClassColors, setGraphClassColors] = useState<Record<string, string>>({});
  const [nodeGraphMap, setNodeGraphMap] = useState<Map<string, string>>(new Map());
  const [paranetLegend, setParanetLegend] = useState<ParanetLegendEntry[]>([]);
  const [realTripleCount, setRealTripleCount] = useState(0);

  const [paranetFilter, setParanetFilter] = useState('');
  const [showLiterals, setShowLiterals] = useState(true);
  const [selectedNode, setSelectedNode] = useState<NodeDetails | null>(null);

  const selectedParanet = useMemo(
    () => paranets.find((p: any) => p.id === paranetFilter) ?? null,
    [paranets, paranetFilter],
  );

  const graphViewConfig = useMemo<ViewConfig>(() => ({
    name: 'Explorer',
    palette: 'dark',
    paletteOverrides: {
      edgeColor: DEFAULT_EDGE,
      particleColor: 'rgba(34, 211, 238, 0.5)',
    },
    animation: {
      fadeIn: true,
      linkParticles: false,
      linkParticleCount: 0,
      linkParticleSpeed: 0.005,
      linkParticleColor: 'rgba(34, 211, 238, 0.5)',
      linkParticleWidth: 0.8,
      drift: false,
      hoverTrace: false,
    },
  }), []);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    setEmptyReason('');
    setTriples(null);
    setSelectedNode(null);
    try {
      let sparql: string;
      if (selectedParanet?.uri) {
        const safeIri = validateIri(selectedParanet.uri);
        if (!safeIri) {
          setError('Invalid paranet URI');
          setLoading(false);
          return;
        }
        const escapedUri = escapeSparqlString(safeIri);
        sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
          GRAPH ?g { ?s ?p ?o }
          FILTER(?g = <${safeIri}> || STRSTARTS(STR(?g), "${escapedUri}/"))
        } LIMIT ${limit}`;
      } else {
        sparql = `CONSTRUCT { ?s ?p ?o } WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } } LIMIT ${limit}`;
      }

      const res = await executeQuery(sparql, selectedParanet?.id);
      const quads = Array.isArray(res?.result?.quads) ? res.result.quads : [];

      try {
        let countSparql: string;
        if (selectedParanet?.uri) {
          const safeIri = validateIri(selectedParanet.uri);
          const escapedUri = safeIri ? escapeSparqlString(safeIri) : '';
          countSparql = safeIri
            ? `SELECT (COUNT(*) AS ?count) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g = <${safeIri}> || STRSTARTS(STR(?g), "${escapedUri}/")) }`
            : `SELECT (COUNT(*) AS ?count) WHERE { SELECT DISTINCT ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } } }`;
        } else {
          countSparql = `SELECT (COUNT(*) AS ?count) WHERE { SELECT DISTINCT ?s ?p ?o WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } } }`;
        }
        const countRes = await executeQuery(countSparql, selectedParanet?.id);
        setGraphTotalCount(extractCountFromQueryResult(countRes?.result));
      } catch {
        setGraphTotalCount(null);
      }

      if (Array.isArray(quads) && quads.length > 0) {
        const rawTriples = quads.map((q: any) => ({
          subject: q.subject,
          predicate: q.predicate,
          object: q.object,
        }));

        // CONSTRUCT strips graph info, so run a SELECT to discover graph membership
        let graphMembershipRows: any[] = [];
        try {
          let membershipSparql: string;
          if (selectedParanet?.uri) {
            const safeIri = validateIri(selectedParanet.uri);
            const escapedUri = safeIri ? escapeSparqlString(safeIri) : '';
            membershipSparql = safeIri
              ? `SELECT DISTINCT ?s ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(?g = <${safeIri}> || STRSTARTS(STR(?g), "${escapedUri}/")) } LIMIT ${limit}`
              : `SELECT DISTINCT ?s ?g WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT ${limit}`;
          } else {
            membershipSparql = `SELECT DISTINCT ?s ?g WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT ${limit}`;
          }
          const membershipRes = await executeQuery(membershipSparql, selectedParanet?.id);
          graphMembershipRows = Array.isArray(membershipRes?.result?.bindings)
            ? membershipRes.result.bindings
            : (Array.isArray(membershipRes?.result) ? membershipRes.result : []);
        } catch {
          // Non-fatal: coloring will fall back to default
        }

        const { classColors, nodeGraphMap: ngMap, legend } = buildGraphColorsFromMembership(graphMembershipRows, paranets);
        setGraphClassColors(classColors);
        setNodeGraphMap(ngMap);
        setParanetLegend(legend);

        setAllTriples(rawTriples);
        setTypeMap(buildTypeMap(rawTriples));
        const stats = buildPredicateStats(rawTriples, 20);
        setPredicateStats(stats);
        setSelectedPredicates(new Set());
        setEmptyReason('');
      } else {
        setAllTriples([]);
        setTypeMap(new Map());
        setPredicateStats([]);
        setSelectedPredicates(new Set());
        setGraphClassColors({});
        setNodeGraphMap(new Map());
        setParanetLegend([]);
        if (selectedParanet) {
          setEmptyReason('No triples found for this paranet. It may not be synced on this node yet.');
        } else {
          setEmptyReason('No triples found in any named graph on this node.');
        }
      }
    } catch (err: any) {
      setError(err.message);
      setAllTriples([]);
      setTypeMap(new Map());
      setPredicateStats([]);
      setSelectedPredicates(new Set());
    } finally {
      setLoading(false);
    }
  }, [limit, refreshKey, selectedParanet, paranets]);

  // Re-filter when predicates or literals toggle changes
  useEffect(() => {
    if (!allTriples) return;
    let filtered = allTriples;
    if (selectedPredicates.size > 0) {
      filtered = filtered.filter((t) => selectedPredicates.has(t.predicate));
    }

    let display: Triple[];
    if (showLiterals) {
      display = triplesWithLiteralsAsNodes(filtered);
    } else {
      display = filtered.filter(t => isResourceObject(t.object));
    }

    // Inject synthetic rdf:type triples so RdfGraph colors nodes by their source graph
    const seen = new Set<string>();
    const synthetics: Triple[] = [];
    for (const t of display) {
      for (const uri of [t.subject, t.object]) {
        if (seen.has(uri)) continue;
        seen.add(uri);
        const graphUri = nodeGraphMap.get(uri);
        if (graphUri && graphClassColors[graphUri]) {
          synthetics.push({ subject: uri, predicate: RDF_TYPE, object: graphUri });
        }
      }
    }

    setRealTripleCount(display.length);
    setTriples([...display, ...synthetics]);
  }, [showLiterals, allTriples, selectedPredicates, nodeGraphMap, graphClassColors]);

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
        <div className="card graph-shell" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Toolbar */}
          <div className="graph-toolbar">
            <div className="graph-toolbar-row">
              <select
                className="input"
                value={paranetFilter}
                onChange={(e) => { setParanetFilter(e.target.value); setRefreshKey(k => k + 1); }}
                style={{ width: 'auto', minWidth: 200 }}
              >
                <option value="">All Paranets</option>
                {paranets.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
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
                  {realTripleCount.toLocaleString()} triples
                  {allTriples && selectedPredicates.size > 0 && realTripleCount < allTriples.length && (
                    <> (filtered from {allTriples.length.toLocaleString()})</>
                  )}
                  {graphTotalCount != null && allTriples && graphTotalCount > allTriples.length && (
                    <> · {graphTotalCount.toLocaleString()} total in store</>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* Paranet color legend */}
          {paranetLegend.length > 0 && (
            <div className="graph-legend">
              {paranetLegend.map((entry) => (
                <span key={entry.name} className="graph-legend-item">
                  <span className="graph-legend-dot" style={{ background: entry.color }} />
                  {entry.name}
                </span>
              ))}
            </div>
          )}

          {predicateStats.length > 0 && (
            <div className="graph-predicate-filters">
              {predicateStats.map((p) => {
                const active = selectedPredicates.has(p.predicate);
                return (
                  <button
                    key={p.predicate}
                    type="button"
                    className={`graph-predicate-chip ${active ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedPredicates((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.predicate)) next.delete(p.predicate);
                        else next.add(p.predicate);
                        return next;
                      });
                    }}
                    title={p.predicate}
                  >
                    {p.label} ({p.count})
                  </button>
                );
              })}
              <button
                type="button"
                className={`graph-predicate-chip ${selectedPredicates.size === 0 ? 'active' : ''}`}
                onClick={() => setSelectedPredicates(new Set())}
              >
                All
              </button>
            </div>
          )}

          {/* Graph */}
          {error && <div style={{ padding: 16, color: 'var(--error)' }}>{error}</div>}
          {loading && !triples && <div className="loading" style={{ minHeight: 400 }}>Loading graph…</div>}
          {triples && triples.length === 0 && !loading && (
            <div className="empty-state" style={{ minHeight: 400 }}>
              {emptyReason || 'No triples match the current filters'}
            </div>
          )}
          {triples && triples.length > 0 && (
            <div className="graph-viewport" style={{ flex: 1, minHeight: 400 }}>
              <RdfGraph
                data={triples}
                format="triples"
                options={{
                  labelMode: 'humanized',
                  renderer: '2d',
                  style: {
                    classColors: graphClassColors,
                    defaultNodeColor: DEFAULT_NODE,
                    defaultEdgeColor: DEFAULT_EDGE,
                    edgeWidth: 0.9,
                  },
                  hexagon: { baseSize: 3, minSize: 2, maxSize: 5, scaleWithDegree: true },
                  focus: { maxNodes: 50000, hops: 999 },
                }}
                viewConfig={graphViewConfig}
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
                    <span className="graph-legend-dot" style={{ background: graphClassColors[t] || DEFAULT_NODE }} />
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

// --- Utility ---

function shortLabel(uri: string): string {
  if (uri.includes('#')) return uri.split('#').pop()!;
  const parts = uri.split('/');
  return parts[parts.length - 1] || uri;
}
