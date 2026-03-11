import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useFetch, formatTime, shortId } from '../hooks.js';
import { executeQuery, fetchParanets } from '../api.js';
import { RdfGraph, useRdfGraph } from '@dkg/graph-viz/react';
import type { ViewConfig } from '@dkg/graph-viz';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { sql } from '@codemirror/lang-sql';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { buildTripleRowsWithProvenance, deriveGraphTriples } from '../sparql-utils.js';

export function ExplorerPage() {
  return (
    <div style={{ padding: '28px 32px', height: '100%', overflow: 'auto' }}>
      <h1 className="page-title">Memory Explorer</h1>
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
  const paranetKey = useMemo(
    () => JSON.stringify(
      (paranetData?.paranets ?? [])
        .map((p: any) => ({ id: p.id, uri: p.uri, name: p.name }))
        .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id))),
    ),
    [paranetData],
  );
  // Only produce a new reference when paranet metadata actually changes,
  // not on every 30-second poll cycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const paranets = useMemo(() => paranetData?.paranets ?? [], [paranetKey]);

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

  const location = useLocation();
  const [paranetFilter, setParanetFilter] = useState(
    () => new URLSearchParams(location.search).get('paranet') ?? '',
  );

  // Keep paranetFilter in sync when ?paranet= changes while component stays mounted
  useEffect(() => {
    const fromUrl = new URLSearchParams(location.search).get('paranet') ?? '';
    setParanetFilter(fromUrl);
  }, [location.search]);
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
  }, [limit, refreshKey, selectedParanet?.id, selectedParanet?.uri, paranets]);

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
                initialFit
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
                  autoFitDisabled: true,
                }}
                viewConfig={graphViewConfig}
                style={{ width: '100%', height: '100%' }}
                onNodeClick={handleNodeClick}
              />
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
  'All triples + provenance (SPOG, limit 100)': `SELECT ?s ?p ?o ?g WHERE {
  GRAPH ?g { ?s ?p ?o }
} LIMIT 100`,
  'Named graph triples (SPO)': `SELECT ?s ?p ?o WHERE {
  GRAPH ?g { ?s ?p ?o }
} LIMIT 100`,
  'Network subject triples (SPO)': `SELECT ?s ?p ?o WHERE {
  BIND(<did:dkg:network:v9-testnet> AS ?s)
  ?s ?p ?o .
} LIMIT 100`,
  'Type + properties (SPO)': `SELECT ?s ?p ?o WHERE {
  ?s a ?type .
  ?s ?p ?o .
} LIMIT 100`,
};

const QUERY_HELPERS: Array<{ title: string; description: string; query: string }> = [
  {
    title: 'All triples + provenance',
    description: 'Reads triples from named graphs with graph URI included.',
    query: `SELECT ?s ?p ?o ?g WHERE {
  GRAPH ?g { ?s ?p ?o }
} LIMIT 100`,
  },
  {
    title: 'OriginTrail Game Events',
    description: 'Explore gameplay/activity triples from the game paranet.',
    query: `SELECT ?s ?p ?o ?g WHERE {
  GRAPH ?g {
    ?s ?p ?o .
    FILTER(CONTAINS(LCASE(STR(?g)), "origin-trail-game"))
  }
} LIMIT 100`,
  },
  {
    title: 'Agent Registry Snapshot',
    description: 'Raw triples from the agents paranet graph.',
    query: `SELECT ?s ?p ?o WHERE {
  GRAPH <did:dkg:paranet:agents> {
    ?s ?p ?o
  }
} LIMIT 100`,
  },
  {
    title: 'Ontology Paranet Concepts',
    description: 'Browse classes/properties and related ontology triples.',
    query: `SELECT ?s ?p ?o ?g WHERE {
  GRAPH ?g {
    ?s ?p ?o .
    FILTER(
      CONTAINS(LCASE(STR(?g)), "ontology")
      || CONTAINS(LCASE(STR(?s)), "ontology")
      || CONTAINS(LCASE(STR(?o)), "ontology")
    )
  }
} LIMIT 100`,
  },
];

function SparqlTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || TEMPLATES['All triples + provenance (SPOG, limit 100)'];
  const [sparql, setSparql] = useState(initialQuery);
  const [executedQuery, setExecutedQuery] = useState(initialQuery);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [execTime, setExecTime] = useState<number | null>(null);
  const [autoRan, setAutoRan] = useState(false);
  const [resultsTab, setResultsTab] = useState<'triples' | 'jsonld' | 'nquads'>('triples');
  const [provenanceRows, setProvenanceRows] = useState<Array<{
    s: string;
    p: string;
    o: string;
    g: string;
    graphType: string;
    paranet: string;
    source: string;
    ual: string;
    txHash: string;
    timestamp: string;
  }>>([]);
  const [provenanceLoading, setProvenanceLoading] = useState(false);
  const [focusedSubject, setFocusedSubject] = useState<string | null>(null);

  const runQuery = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    const start = performance.now();
    try {
      const res = await executeQuery(query);
      const duration = Math.round(performance.now() - start);
      setExecTime(duration);
      const raw = res.result;
      setResult(raw?.bindings ?? raw);
      setExecutedQuery(query);
    } catch (err: any) {
      setError(err.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const run = useCallback(async () => {
    await runQuery(sparql);
  }, [runQuery, sparql]);

  useEffect(() => {
    if (autoRan) return;
    setAutoRan(true);
    if (searchParams.has('q')) {
      setSearchParams((prev) => { prev.delete('q'); return prev; }, { replace: true });
    }
    runQuery(sparql);
  }, [searchParams, autoRan, runQuery, setSearchParams, sparql]);

  const derivedTriples = useMemo(
    () => deriveGraphTriples(result, executedQuery),
    [result, executedQuery],
  );

  useEffect(() => {
    let cancelled = false;
    const loadProvenance = async () => {
      if (derivedTriples.length === 0) {
        setProvenanceRows([]);
        setProvenanceLoading(false);
        return;
      }
      setProvenanceLoading(true);
      try {
        const uniqueTriples = dedupeTriples(derivedTriples).slice(0, 100);
        const values = uniqueTriples
          .map((t) => `(${toSparqlTerm(t.s)} ${toSparqlTerm(t.p)} ${toSparqlTerm(t.o)})`)
          .join('\n');
        const provenanceQuery = `SELECT ?s ?p ?o ?g WHERE {
  VALUES (?s ?p ?o) {
${values}
  }
  GRAPH ?g { ?s ?p ?o }
}`;
        const res = await executeQuery(provenanceQuery);
        const rows = Array.isArray(res?.result?.bindings) ? res.result.bindings : [];
        const graphUris = Array.from(new Set(rows.map((r: any) => String(r.g ?? '')).filter(Boolean)));
        let graphMeta = new Map<string, { source: string; ual: string; txHash: string; timestamp: string }>();
        if (graphUris.length > 0) {
          const graphValues = graphUris.map((g) => `<${g}>`).join(' ');
          const metaQuery = `SELECT ?g ?workspaceOwner ?creator ?publisherPeerId ?publisherAddress ?publisher ?ual ?txHash ?timestamp WHERE {
  VALUES ?g { ${graphValues} }
  OPTIONAL {
    GRAPH ?g {
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/workspaceOwner> ?workspaceOwner }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/creator> ?creator }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/publisherPeerId> ?publisherPeerId }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/publisherAddress> ?publisherAddress }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/publisher> ?publisher }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/ual> ?ual }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/partOf> ?ual }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/txHash> ?txHash }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/transactionHash> ?txHash }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/timestamp> ?timestamp }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/publishedAt> ?timestamp }
      OPTIONAL { ?metaEntity <http://dkg.io/ontology/createdAt> ?timestamp }
    }
  }
}`;
          try {
            const metaRes = await executeQuery(metaQuery);
            const metaRows = Array.isArray(metaRes?.result?.bindings) ? metaRes.result.bindings : [];
            graphMeta = new Map<string, { source: string; ual: string; txHash: string; timestamp: string }>();
            for (const r of metaRows) {
              const g = String(r.g ?? '');
              if (!g) continue;
              const existing = graphMeta.get(g) ?? { source: '', ual: '', txHash: '', timestamp: '' };
              const candidate =
                normalizeNodeSource(String(r.publisherPeerId ?? '')) ||
                normalizeNodeSource(String(r.creator ?? '')) ||
                normalizeNodeSource(String(r.workspaceOwner ?? '')) ||
                normalizeNodeSource(String(r.publisher ?? '')) ||
                normalizeNodeSource(String(r.publisherAddress ?? ''));
              graphMeta.set(g, {
                source: existing.source || candidate,
                ual: existing.ual || String(r.ual ?? ''),
                txHash: existing.txHash || String(r.txHash ?? ''),
                timestamp: existing.timestamp || String(r.timestamp ?? ''),
              });
            }
          } catch {
            graphMeta = new Map();
          }
        }
        if (cancelled) return;
        setProvenanceRows(rows.map((r: any) => {
          const g = String(r.g ?? '');
          const meta = graphMeta.get(g) ?? { source: '', ual: '', txHash: '', timestamp: '' };
          const paranet = g.startsWith('did:dkg:paranet:') ? g.replace('did:dkg:paranet:', '').split('/')[0] : 'unknown';
          const source = meta.source || 'unknown';
          return {
            s: String(r.s ?? ''),
            p: String(r.p ?? ''),
            o: String(r.o ?? ''),
            g,
            graphType: g.endsWith('/workspace') || g.includes('_workspace') ? 'workspace' : 'data',
            paranet,
            source,
            ual: meta.ual,
            txHash: meta.txHash,
            timestamp: meta.timestamp,
          };
        }));
      } catch {
        if (!cancelled) setProvenanceRows([]);
      } finally {
        if (!cancelled) setProvenanceLoading(false);
      }
    };
    loadProvenance();
    return () => { cancelled = true; };
  }, [derivedTriples]);

  return (
    <div className="sparql-stack-layout">
        <div className="sparql-query-composer">
          <div className="sparql-query-editor-pane">
            <SparqlCodeEditor
              value={sparql}
              onChange={setSparql}
              onRun={run}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 8 }}>
              {execTime != null && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{execTime}ms</span>}
              <button className="btn btn-primary" onClick={run} disabled={loading}>
                {loading ? 'Running...' : 'Run Query'}
              </button>
            </div>
          </div>
          <div className="sparql-helper-grid">
            {QUERY_HELPERS.map((helper) => (
              <button
                key={helper.title}
                type="button"
                className="sparql-helper-card"
                onClick={() => {
                  setSparql(helper.query);
                  runQuery(helper.query);
                }}
                title="Use this query"
              >
                <div className="sparql-helper-title">{helper.title}</div>
                <div className="sparql-helper-desc">{helper.description}</div>
                <pre className="sparql-helper-code mono">{helper.query}</pre>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="card" style={{ borderColor: 'var(--error)', marginTop: 12 }}>
            <div style={{ color: 'var(--error)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>{error}</div>
          </div>
        )}

        <div className="sparql-results-pane">
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <strong style={{ fontSize: 13 }}>Query Results</strong>
              <div className="result-tabs" style={{ marginBottom: 0 }}>
                <button className={`result-tab ${resultsTab === 'triples' ? 'active' : ''}`} onClick={() => setResultsTab('triples')}>Triples</button>
                <button className={`result-tab ${resultsTab === 'jsonld' ? 'active' : ''}`} onClick={() => setResultsTab('jsonld')}>JSON-LD</button>
                <button className={`result-tab ${resultsTab === 'nquads' ? 'active' : ''}`} onClick={() => setResultsTab('nquads')}>N-Quads</button>
              </div>
            </div>
            <div style={{ minHeight: 280, maxHeight: 420, overflow: 'auto' }}>
              {resultsTab === 'triples' && (
                <ResultTriples
                  result={result}
                  triples={derivedTriples}
                  rows={provenanceRows}
                  loading={provenanceLoading}
                  onFocusSubject={setFocusedSubject}
                />
              )}
              {resultsTab === 'jsonld' && <ResultJsonLd triples={derivedTriples} />}
              {resultsTab === 'nquads' && <ResultNQuads triples={derivedTriples} />}
            </div>
          </div>
        </div>
      <div className="sparql-graph-pane">
        <ResultGraph result={result} sparql={executedQuery} focusedSubject={focusedSubject} />
      </div>
    </div>
  );
}

function ResultTriples({
  result,
  triples,
  rows,
  loading,
  onFocusSubject,
}: {
  result: any;
  triples: Array<{ s: string; p: string; o: string }>;
  rows: Array<{
    s: string;
    p: string;
    o: string;
    g: string;
    graphType: string;
    paranet: string;
    source: string;
    ual: string;
    txHash: string;
    timestamp: string;
  }>;
  loading: boolean;
  onFocusSubject: (subject: string) => void;
}) {
  if (!Array.isArray(result) || result.length === 0) return <div className="empty-state">Run a query to see triples</div>;
  if (!triples.length) return <div className="empty-state">No triple-shaped rows in this result set</div>;
  const displayRows = buildTripleRowsWithProvenance(triples, rows);

  return (
    <div style={{ overflow: 'auto' }}>
      {loading && (
        <div className="empty-state" style={{ borderBottom: '1px solid var(--border)' }}>
          Loading provenance metadata…
        </div>
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th>Subject</th>
            <th>Predicate</th>
            <th>Object</th>
            <th>Graph</th>
            <th>Graph Type</th>
            <th>Paranet</th>
            <th>Source</th>
            <th>UAL</th>
            <th>Transaction Hash</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {displayRows.map((t, i) => (
            <tr key={`${t.s}-${t.p}-${t.o}-${i}`}>
              <CellWithCopy value={t.s} clickable onClick={() => onFocusSubject(t.s)} />
              <CellWithCopy value={t.p} />
              <CellWithCopy value={t.o} />
              <CellWithCopy value={t.g} />
              <td style={{ fontSize: 12 }}>{t.graphType || '-'}</td>
              <CellWithCopy value={t.paranet} />
              <CellWithCopy value={t.source} />
              <CellWithCopy value={t.ual} />
              <CellWithCopy value={t.txHash} />
              <CellWithCopy value={t.timestamp} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SparqlCodeEditor({
  value,
  onChange,
  onRun,
}: {
  value: string;
  onChange: (next: string) => void;
  onRun: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  useEffect(() => {
    if (!hostRef.current) return;
    const extensions: Extension[] = [
      EditorView.lineWrapping,
      drawSelection(),
      highlightActiveLine(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      sql(),
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            onRunRef.current();
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];

    const state = EditorState.create({
      doc: value,
      extensions,
    });
    const view = new EditorView({
      state,
      parent: hostRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className="sparql-editor-cm"
      aria-label="SPARQL editor"
    />
  );
}

function isLikelyResource(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('urn:') || value.startsWith('did:') || value.startsWith('_:');
}

function isSerializedRdfTerm(value: string): boolean {
  return (
    /^<[^>]+>$/.test(value) ||
    /^_:[A-Za-z][\w-]*$/.test(value) ||
    /^"((?:[^"\\]|\\.)*)"(?:@[A-Za-z-]+|\^\^(?:<[^>]+>|[A-Za-z][\w+.-]*:[^\s]+))?$/.test(value)
  );
}

function toNQuadTerm(value: string): string {
  if (isSerializedRdfTerm(value)) return value;
  if (value.startsWith('_:')) return value;
  if (isLikelyResource(value)) return `<${value}>`;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

function toSparqlTerm(value: string): string {
  if (isSerializedRdfTerm(value)) return value;
  if (value.startsWith('_:')) return value;
  if (isLikelyResource(value)) return `<${value}>`;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

function dedupeTriples(triples: Array<{ s: string; p: string; o: string }>): Array<{ s: string; p: string; o: string }> {
  const seen = new Set<string>();
  const out: Array<{ s: string; p: string; o: string }> = [];
  for (const t of triples) {
    const key = `${t.s}\u0000${t.p}\u0000${t.o}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function normalizeNodeSource(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  let v = trimmed;
  const literalMatch = v.match(/^"((?:[^"\\]|\\.)*)"(?:@[A-Za-z-]+|\^\^(?:<[^>]+>|[A-Za-z][\w+.-]*:[^\s]+))?$/);
  if (literalMatch) {
    v = literalMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  } else if (v.startsWith('<') && v.endsWith('>')) {
    v = v.slice(1, -1);
  }
  if (!v) return '';
  if (v.startsWith('did:dkg:agent:')) return v.replace('did:dkg:agent:', '');
  if (/^12D3[A-Za-z0-9]+/.test(v)) return v;
  if (/^Qm[A-Za-z0-9]+/.test(v)) return v; // legacy peer id style
  if (/^0x[a-fA-F0-9]{40}$/.test(v)) return v;
  return '';
}

function buildJsonLd(triples: Array<{ s: string; p: string; o: string }>): any[] {
  const bySubject = new Map<string, Record<string, any>>();
  for (const t of triples) {
    if (!bySubject.has(t.s)) bySubject.set(t.s, { '@id': t.s });
    const node = bySubject.get(t.s)!;
    const values = Array.isArray(node[t.p]) ? node[t.p] : [];
    values.push(isLikelyResource(t.o) ? { '@id': t.o } : { '@value': t.o });
    node[t.p] = values;
  }
  return Array.from(bySubject.values());
}

function ResultJsonLd({ triples }: { triples: Array<{ s: string; p: string; o: string }> }) {
  if (!triples.length) return <div className="empty-state">No triple-shaped rows to convert</div>;
  return <div className="json-view">{JSON.stringify(buildJsonLd(triples), null, 2)}</div>;
}

function ResultNQuads({ triples }: { triples: Array<{ s: string; p: string; o: string }> }) {
  if (!triples.length) return <div className="empty-state">No triple-shaped rows to convert</div>;
  const nquads = triples.map((t) => `${toNQuadTerm(t.s)} ${toNQuadTerm(t.p)} ${toNQuadTerm(t.o)} .`).join('\n');
  return <div className="json-view">{nquads}</div>;
}

function CellWithCopy({
  value,
  clickable = false,
  onClick,
}: {
  value: string;
  clickable?: boolean;
  onClick?: () => void;
}) {
  const text = value || '-';
  const copy = useCallback(async () => {
    try {
      if (value) await navigator.clipboard.writeText(value);
    } catch {
      // ignore clipboard errors
    }
  }, [value]);

  return (
    <td className="mono sparql-cell-with-copy" style={{ fontSize: 12 }}>
      {clickable ? (
        <button type="button" className="sparql-cell-link" onClick={onClick} title="Focus node in graph">
          {text}
        </button>
      ) : (
        <span>{text}</span>
      )}
      {value && (
        <button type="button" className="sparql-copy-btn" onClick={copy} title="Copy value">
          Copy
        </button>
      )}
    </td>
  );
}

function GraphFocusBridge({ focusedSubject }: { focusedSubject: string | null }) {
  const { viz } = useRdfGraph();
  useEffect(() => {
    if (!viz || !focusedSubject) return;
    viz.centerOnNode(focusedSubject, { durationMs: 500, zoomLevel: 2.5 });
  }, [viz, focusedSubject]);
  return null;
}

function ResultGraph({ result, sparql, focusedSubject }: { result: any; sparql: string; focusedSubject: string | null }) {
  if (!Array.isArray(result) || result.length === 0) {
    return <div className="graph-container">Run a query to visualize graph data</div>;
  }

  const triples = deriveGraphTriples(result, sparql);
  if (triples.length === 0) {
    return <div className="graph-container">Graph view needs a triple pattern with variables (for example: <code>?s ?p ?o</code> or <code>{'<subject>'} ?p ?o</code>).</div>;
  }
  const uniqueTriples = dedupeTriples(triples);
  const displayTriples = uniqueTriples;
  const graphTriples = triplesWithLiteralsAsNodes(
    displayTriples.map((t) => ({
      subject: t.s,
      predicate: t.p,
      object: t.o,
    })),
  );
  const graphViewConfig: ViewConfig = {
    name: 'SPARQL Result Graph',
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
  };
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
        {displayTriples.length.toLocaleString()} shown of {uniqueTriples.length.toLocaleString()} unique triples from {triples.length.toLocaleString()} rows
      </div>
      <div style={{ width: '100%', flex: 1, minHeight: 0 }}>
        <RdfGraph
          data={graphTriples}
          format="triples"
          initialFit
          options={{
            labelMode: 'humanized',
            renderer: '2d',
            style: {
              defaultNodeColor: DEFAULT_NODE,
              defaultEdgeColor: DEFAULT_EDGE,
              edgeWidth: 0.9,
            },
            hexagon: { baseSize: 3, minSize: 2, maxSize: 5, scaleWithDegree: true },
            focus: { maxNodes: 50000, hops: 999 },
            autoFitDisabled: true,
          }}
          viewConfig={graphViewConfig}
          style={{ width: '100%', height: '100%' }}
        >
          <GraphFocusBridge focusedSubject={focusedSubject} />
        </RdfGraph>
      </div>
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
              navigate(`/explorer?paranet=${encodeURIComponent(p.id)}`);
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
