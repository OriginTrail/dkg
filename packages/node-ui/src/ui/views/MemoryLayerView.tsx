import React, { useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { useFetch } from '../hooks.js';
import { executeQuery, fetchStatus, listAssertions, promoteAssertion, publishAssertionsToVm, partialPublishWarning, describePromoteResult, describePromoteError, type AssertionInfo, type BatchPublishResult } from '../api.js';
import { FilePreviewModal } from '../components/Modals/FilePreviewModal.js';
import { useMemoryGraphEvents } from '../hooks/useNodeEvents.js';
import { memoryGraphLabels } from '../lib/memoryLabels.js';
import { truncateMiddle } from '../lib/truncate.js';

const RdfGraph = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.RdfGraph }))
);
const NodePanel = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.NodePanel }))
);
// Lazy — the card imports `useRdfGraph` from the viz package; deferring it
// keeps the graph renderer out of the main bundle (matches RdfGraph/NodePanel).
const OnChainProvenanceCard = lazy(() =>
  import('../components/OnChainProvenanceCard.js').then(m => ({ default: m.OnChainProvenanceCard }))
);

type MemoryLayer = 'wm' | 'swm' | 'vm';
type ViewMode = 'table' | 'graph';

const LAYER_META: Record<MemoryLayer, { label: string; color: string; icon: string; description: string }> = {
  wm: { label: 'Working Memory', color: 'var(--layer-working)', icon: '◇', description: 'Private agent drafts. Fast local storage.' },
  swm: { label: 'Shared Working Memory', color: 'var(--layer-shared)', icon: '◈', description: 'Shared proposals with collaborators. TTL-bounded.' },
  vm: { label: 'Verifiable Memory', color: 'var(--layer-verified)', icon: '◉', description: 'Endorsed, published, on-chain knowledge.' },
};

const GRAPH_OPTIONS = {
  labelMode: 'humanized' as const,
  renderer: '2d' as const,
  labels: memoryGraphLabels({ extraPredicates: ['http://schema.org/text'] }),
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
  externalQuery?: string;
  externalQueryKey?: string;
  queryPresetOptions?: Array<{ label: string; query: string }>;
}

export function MemoryLayerView({ layer, contextGraphId, externalQuery, externalQueryKey, queryPresetOptions }: MemoryLayerViewProps) {
  const meta = LAYER_META[layer];
  const [viewMode, setViewMode] = useState<ViewMode>('graph');
  const [selectedPresetLabel, setSelectedPresetLabel] = useState('');
  const [draftQuery, setDraftQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [draftSearch, setDraftSearch] = useState('');
  const [draftField, setDraftField] = useState<'any' | 'subject' | 'predicate' | 'object'>('any');
  const [draftLimit, setDraftLimit] = useState(50);
  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedField, setAppliedField] = useState<'any' | 'subject' | 'predicate' | 'object'>('any');
  const [appliedLimit, setAppliedLimit] = useState(50);
  const [showAdvancedQuery, setShowAdvancedQuery] = useState(layer !== 'vm');

  const prevLayerRef = React.useRef(layer);
  React.useEffect(() => {
    if (prevLayerRef.current !== layer) {
      prevLayerRef.current = layer;
      setSelectedPresetLabel('');
      setShowAdvancedQuery(layer !== 'vm');
      setDraftQuery('');
      setActiveQuery('');
      setDraftSearch('');
      setDraftField('any');
      setDraftLimit(50);
      setAppliedSearch('');
      setAppliedField('any');
      setAppliedLimit(50);
    }
  }, [layer]);

  React.useEffect(() => {
    if (externalQuery === undefined) return;
    setSelectedPresetLabel('');
    setDraftQuery(externalQuery);
    setActiveQuery(externalQuery);
  }, [externalQuery, externalQueryKey]);

  const defaultSparql = useMemo(() => {
    if (layer === 'wm') {
      const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
      // Two constraints shape this query:
      //  1. The GRAPH variable must stay at the TOP LEVEL of the WHERE block.
      //     The scoped local-query path (`constrainGraphVariablesToAllowedSet`,
      //     PR #749) rejects a `GRAPH ?g` nested inside `UNION`/`OPTIONAL`/a
      //     sub-group ("GRAPH variables must appear at the top level of scoped
      //     local queries"). Both GRAPH clauses below are WHERE-block siblings,
      //     so `?g` stays top-level and the guard passes.
      //  2. `?g` must be restricted to WM-marked partitions. The view runs with
      //     `includeContextGraphPartitions: true` (see below), which widens the
      //     allow-list to every same-CG partition — including `/_shared_memory`,
      //     `/_verifiable_memory/*`, and metadata graphs. A bare prefix FILTER
      //     would let SWM/VM triples bleed into the WM tab, so we gate `?g` on
      //     the `<cg>/_meta` `dkg:memoryLayer "WM"` lifecycle marker (the same
      //     authority `listWmAssertions` uses) and read only those graphs.
      //  3. Exclude the reserved `meta` namespace (`<cg>/meta/assertion/…`
      //     profile/query-catalog drafts are WM-marked but are UI config, not
      //     user knowledge), mirroring `listWmAssertions`. Match the bucket by
      //     its path SHAPE (`/meta/assertion/`), not a `/_meta` suffix, so a
      //     valid WM assertion named `_meta` isn't dropped.
      return `SELECT ?s ?p ?o WHERE { GRAPH <${metaGraph}> { ?g <http://dkg.io/ontology/memoryLayer> "WM" } GRAPH ?g { ?s ?p ?o } FILTER(!CONTAINS(STR(?g), "/meta/assertion/")) } LIMIT 1000`;
    }
    if (layer === 'vm') {
      return buildVerifiableMemorySearchQuery({
        query: appliedSearch,
        field: appliedField,
        limit: appliedLimit,
      });
    }
    return `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 500`;
  }, [contextGraphId, layer, appliedField, appliedLimit, appliedSearch]);

  const sparql = activeQuery || defaultSparql;

  const graphSuffix = layer === 'swm' ? '_shared_memory' as const : undefined;
  const includeShared = layer === 'swm';
  const queryView = layer === 'vm' ? 'verifiable-memory' as const : undefined;
  // WM content lives in the CG's assertion partitions, which sit outside the
  // daemon's static `GRAPH ?g` allow-list. Without this opt-in the WM view's
  // `GRAPH ?g { ?s ?p ?o }` enumeration resolves against only
  // { <cg>, <cg>/_meta, <cg>/_shared_memory_meta } and renders empty. SWM/VM
  // use their own `view`-routed scopes and don't need it.
  //
  // Scope the opt-in to the *built-in* WM query only (`sparql === defaultSparql`):
  // that query constrains `?g` to WM-marked graphs via the `_meta` join, so the
  // widened allow-list stays layer-correct. A custom query typed into the WM tab
  // must NOT get the opt-in — otherwise an advanced `GRAPH ?g { … }` could
  // enumerate SWM/VM/meta partitions and silently escape the WM scope. Custom
  // queries fall back to the daemon's default static allow-list.
  const includePartitions = layer === 'wm' && sparql === defaultSparql;

  const { data, loading, error, refresh } = useFetch(
    () => executeQuery(sparql, contextGraphId, includeShared, graphSuffix, queryView, includePartitions),
    [sparql, contextGraphId, includeShared, graphSuffix, queryView, includePartitions],
    0
  );
  useMemoryGraphEvents(contextGraphId, refresh, { layers: [layer] });

  // Block-explorer base URL for the on-chain provenance card's tx/address
  // links. Polled slowly; absent in no-chain / mock mode (links degrade out).
  const { data: statusData } = useFetch(fetchStatus, [], 30_000);
  const explorerUrl = (statusData as any)?.blockExplorerUrl as string | undefined;

  const runQuery = useCallback(() => {
    const next = draftQuery.trim();
    if (next === activeQuery) {
      refresh();
      return;
    }
    setActiveQuery(next);
  }, [activeQuery, draftQuery, refresh]);

  const runVerifiedSearch = useCallback(() => {
    const changed =
      draftSearch !== appliedSearch ||
      draftField !== appliedField ||
      draftLimit !== appliedLimit;
    if (changed) {
      setAppliedSearch(draftSearch);
      setAppliedField(draftField);
      setAppliedLimit(draftLimit);
    }
    if (activeQuery) {
      setActiveQuery('');
      return;
    }
    if (!changed) refresh();
  }, [activeQuery, appliedField, appliedLimit, appliedSearch, draftField, draftLimit, draftSearch, refresh]);

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
      setActiveQuery(`SELECT (<${node.id}> AS ?s) ?p ?o WHERE { <${node.id}> ?p ?o } LIMIT 100`);
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

      {layer === 'vm' && (
        <div className="v10-vm-search-panel">
          <div className="v10-vm-search-header">
            <div>
              <div className="v10-vm-search-title">Search Verifiable Memory</div>
              <div className="v10-vm-search-desc">
                Search published triples by subject, predicate, object, or across all fields.
              </div>
            </div>
            <button
              className="v10-vm-search-toggle"
              type="button"
              onClick={() => setShowAdvancedQuery((prev) => !prev)}
            >
              {showAdvancedQuery ? 'Hide SPARQL' : 'Advanced SPARQL'}
            </button>
          </div>

          <div className="v10-vm-search-controls">
            <input
              type="text"
              className="v10-mlv-query-input"
              placeholder="Search verifiable memory..."
              value={draftSearch}
              onChange={(e) => setDraftSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runVerifiedSearch(); }}
            />
            <select
              className="v10-vm-search-select"
              value={draftField}
              onChange={(e) => setDraftField(e.target.value as 'any' | 'subject' | 'predicate' | 'object')}
            >
              <option value="any">Any field</option>
              <option value="subject">Subject</option>
              <option value="predicate">Predicate</option>
              <option value="object">Object</option>
            </select>
            <select
              className="v10-vm-search-select"
              value={String(draftLimit)}
              onChange={(e) => setDraftLimit(Number.parseInt(e.target.value, 10) || 50)}
            >
              <option value="25">25 rows</option>
              <option value="50">50 rows</option>
              <option value="100">100 rows</option>
              <option value="200">200 rows</option>
            </select>
            <button className="v10-mlv-run-btn" onClick={runVerifiedSearch}>
              Search
            </button>
          </div>
        </div>
      )}

      {(layer !== 'vm' || showAdvancedQuery) && (
        <div className="v10-mlv-query-bar">
          {queryPresetOptions?.length ? (
            <select
              className="v10-vm-search-select"
              value={selectedPresetLabel}
              onChange={(e) => {
                const nextLabel = e.target.value;
                setSelectedPresetLabel(nextLabel);
                const preset = queryPresetOptions.find((option) => option.label === nextLabel);
                const nextQuery = preset?.query ?? '';
                setDraftQuery(nextQuery);
                setActiveQuery(nextQuery);
              }}
            >
              <option value="">Select common query...</option>
              {queryPresetOptions.map((option) => (
                <option key={option.label} value={option.label}>{option.label}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              className="v10-mlv-query-input"
              placeholder="Custom SPARQL query..."
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runQuery(); }}
            />
          )}
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
      )}

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
              <OnChainProvenanceCard
                contextGraphId={contextGraphId}
                layer={layer}
                explorerUrl={explorerUrl}
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
    () => listAssertions(contextGraphId, 'wm'),
    [contextGraphId],
    0
  );
  useMemoryGraphEvents(contextGraphId, refresh, { layers: ['wm'] });
  // PR #710 Fix D — busy state keyed on `graphUri` (unique per row,
  // produced by the daemon). `name` is no longer unique once
  // sub-graph + root partitions share names, so a name-keyed busy
  // would highlight two rows on a single click. `'__all__'`
  // sentinel stays — not collidable with any graphUri.
  const [promoting, setPromoting] = useState<string | null>(null);
  // PR #710 — track `subGraph` on the success state so the result
  // copy can disambiguate which partition was promoted. Two rows
  // labeled `draft` (one root, one sub-graph) would otherwise emit
  // the same message and leave the user guessing.
  // Issue #864 — render the unified `PromoteOutcome` so success, no-op,
  // and ASSERTION_NOT_PERSISTED 409 responses each get their own
  // contextual message, instead of the legacy "Promoted 0 triples"
  // string that hid every failure mode behind a fake success.
  const [promoteResult, setPromoteResult] = useState<{
    message: string;
    kind: 'success' | 'noop';
    subGraph?: string;
  } | null>(null);
  const [promoteError, setPromoteError] = useState<{ message: string; kind: 'not-persisted' | 'other' } | null>(null);
  // PR #710 Fix E — preview state carries the sub-graph slug too so
  // `FilePreviewModal` can pass it through to the daemon's
  // `/extraction-status` route. Pre-fix, clicking a sub-graph
  // assertion's filename queried the root-bucket assertion → 404
  // or wrong file.
  const [preview, setPreview] = useState<{ name: string; subGraph?: string } | null>(null);

  const handlePromote = useCallback(async (assertion: AssertionInfo) => {
    setPromoting(assertion.graphUri);
    setPromoteResult(null);
    setPromoteError(null);
    try {
      // PR #710 Fix A — thread `subGraph` so the daemon's
      // `(cg, name, subGraph)` lookup hits the right partition;
      // mirrors the AssertionsList fix in components.tsx.
      const res = await promoteAssertion(contextGraphId, assertion.name, 'all', assertion.subGraph);
      const outcome = describePromoteResult(assertion.name, res);
      setPromoteResult({
        message: outcome.message + (assertion.subGraph ? ` (in ${assertion.subGraph})` : ''),
        kind: outcome.kind === 'success' ? 'success' : 'noop',
        subGraph: assertion.subGraph,
      });
      refresh();
      onPromoted();
    } catch (err: any) {
      const typed = describePromoteError(assertion.name, err);
      setPromoteError(
        typed
          ? { message: typed.message, kind: 'not-persisted' }
          : { message: err?.message ?? 'Promote failed', kind: 'other' },
      );
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
    let noopCount = 0;
    // Issue #864 (Codex review on #874) — capture the in-flight
    // assertion name so a mid-loop failure surfaces "<name>: …"
    // instead of the generic "selected assertion …". Without this,
    // bulk promote with a 409 ASSERTION_NOT_PERSISTED on one item
    // gave the user no way to tell which draft needs re-importing.
    let currentAssertion: string | null = null;
    try {
      for (const a of assertions) {
        currentAssertion = a.name;
        // PR #710 — see comment on the single-row handler above.
        const res = await promoteAssertion(contextGraphId, a.name, 'all', a.subGraph);
        totalPromoted += res.promotedCount;
        if (res.promotedCount === 0) noopCount += 1;
      }
      const tail = noopCount > 0 ? ` (${noopCount} assertion${noopCount === 1 ? '' : 's'} had nothing to promote)` : '';
      setPromoteResult({
        message: totalPromoted > 0
          ? `Promoted ${totalPromoted} triple${totalPromoted === 1 ? '' : 's'} across ${assertions.length} assertion${assertions.length === 1 ? '' : 's'}.${tail}`
          : `No triples were promoted — every assertion was already in Shared Working Memory or its content has not been committed yet.`,
        kind: totalPromoted > 0 ? 'success' : 'noop',
      });
      refresh();
      onPromoted();
    } catch (err: any) {
      const typed = describePromoteError(currentAssertion ?? 'selected assertion', err);
      setPromoteError(
        typed
          ? { message: typed.message, kind: 'not-persisted' }
          : { message: err?.message ?? 'Promote failed', kind: 'other' },
      );
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
          <div key={a.graphUri} className="v10-assertion-item">
            <div className="v10-assertion-item-info">
              <button
                className="v10-assertion-item-name clickable"
                title={a.graphUri}
                onClick={() => setPreview({ name: a.name, subGraph: a.subGraph })}
              >
                {a.name}
              </button>
              {a.tripleCount != null && (
                <span className="v10-assertion-item-count">{a.tripleCount} triples</span>
              )}
              {a.subGraph && (
                // PR #710 — mirror the AssertionsList chip pattern
                // (components.tsx). Same class, same `›` glyph, same
                // truncation, same tooltip — disambiguates rows that
                // share a name across root/sub-graph partitions.
                <span
                  className="v10-item-count v10-item-subgraph"
                  title={`In sub-graph: ${a.subGraph}`}
                >
                  › {truncateMiddle(a.subGraph, 18)}
                </span>
              )}
            </div>
            <button
              className="v10-btn-promote"
              disabled={promoting !== null}
              onClick={() => handlePromote(a)}
              title="Copy these triples to Shared Working Memory"
            >
              {promoting === a.graphUri ? 'Promoting...' : '→ SWM'}
            </button>
          </div>
        ))}
      </div>
      {promoteResult && (
        <div className={promoteResult.kind === 'success' ? 'v10-promote-result success' : 'v10-promote-result info'}>
          {promoteResult.message}
        </div>
      )}
      {promoteError && (
        <div className="v10-promote-result error">
          {promoteError.message}
        </div>
      )}

      {preview && (
        <FilePreviewModal
          open
          onClose={() => setPreview(null)}
          assertionName={preview.name}
          subGraphName={preview.subGraph}
          contextGraphId={contextGraphId}
        />
      )}
    </div>
  );
}

/* ── SWM Publish Panel (SWM → VM) ── */

// Outcome of a "publish all/selected" run: each selected SWM assertion is
// published as its OWN Knowledge Asset via the canonical per-KA /vm/publish
// BatchPublishResult + the per-KA batch loop now live in api.ts
// (`publishAssertionsToVm`) so the partial/sample/error accounting is shared across
// every batch-publish CTA (Design B — one assertion may carry any number of entities).

// Exported for component testing — rendered inline by MemoryLayerView when the
// SWM layer is active (see the `layer === 'swm'` branch above).
export function PublishPanel({ contextGraphId, onPublished }: { contextGraphId: string; onPublished: () => void }) {
  // Source the publishable units from NAMED SWM assertions (the synchronous
  // `<cg>/_meta` `dkg:memoryLayer "SWM"` markers), NOT raw SWM root entities.
  // /vm/publish is keyed by assertion name, so this is what lets us route each
  // unit through the canonical per-KA publish (and fixes the old multi-root
  // "exactly one root entity" failure of the legacy shared-memory publish).
  const { data: assertions, loading, refresh } = useFetch(
    () => listAssertions(contextGraphId, 'swm'),
    [contextGraphId],
    0
  );
  useMemoryGraphEvents(contextGraphId, refresh, { layers: ['swm'] });
  // Selection is keyed by `graphUri` — a root + sub-graph assertion can share a
  // name, so the daemon-produced graph URI is the unique row identity (PR #710).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<BatchPublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allKeys = assertions?.map(a => a.graphUri) ?? [];
  const allSelected = allKeys.length > 0 && allKeys.every(k => selected.has(k));

  const toggleOne = useCallback((key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allKeys));
    }
  }, [allSelected, allKeys]);

  // Publish a set of named SWM assertions, each as its own KA via the canonical
  // /vm/publish (with the §4.4 catch→seal→retry safety net). We do NOT pre-
  // register the CG on-chain: the daemon's /vm/publish runs the local
  // preconditions FIRST and only auto-registers (preserving the stored publish
  // policy) on the `CG_NOT_REGISTERED` retry path — so a doomed publish never
  // burns registration gas, and registration uses the right policy
  // (knowledge-assets.ts vm/publish, #1116).
  const publishAssertions = useCallback(async (items: AssertionInfo[]) => {
    if (items.length === 0) return;
    setPublishing(true);
    setPublishResult(null);
    setError(null);
    try {
      // Shared batch loop (api.ts publishAssertionsToVm) — uniform partial/sample/error
      // accounting across every batch-publish CTA.
      setPublishResult(await publishAssertionsToVm(contextGraphId, items));
      setSelected(new Set());
      refresh();
      onPublished();
    } catch (err: any) {
      // Unexpected non-per-KA failure — surface as a hard error.
      setError(err?.message ?? 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }, [contextGraphId, refresh, onPublished]);

  const handlePublishSelected = useCallback(() => {
    const items = (assertions ?? []).filter(a => selected.has(a.graphUri));
    return publishAssertions(items);
  }, [assertions, selected, publishAssertions]);

  const handlePublishAll = useCallback(() => {
    return publishAssertions(assertions ?? []);
  }, [assertions, publishAssertions]);

  const totalTriples = assertions?.reduce((sum, a) => sum + (a.tripleCount ?? 0), 0) ?? 0;
  const selectedTriples = assertions?.filter(a => selected.has(a.graphUri)).reduce((sum, a) => sum + (a.tripleCount ?? 0), 0) ?? 0;
  const isEmpty = !loading && (!assertions || assertions.length === 0);

  if (loading) return <div className="v10-assertion-list-loading">Loading SWM contents...</div>;
  if (isEmpty) {
    return (
      <div className="v10-publish-panel">
        <div className="v10-publish-panel-header">
          <span className="v10-publish-panel-title">Publish to Verifiable Memory</span>
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
          Knowledge assets in Shared Working Memory ({assertions!.length} asset{assertions!.length === 1 ? '' : 's'} · {totalTriples} triples)
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
        {assertions!.map((a) => (
          <div key={a.graphUri} className={`v10-assertion-item ${selected.has(a.graphUri) ? 'selected' : ''}`}>
            <label className="v10-publish-entity-check">
              <input
                type="checkbox"
                checked={selected.has(a.graphUri)}
                onChange={() => toggleOne(a.graphUri)}
              />
            </label>
            <div className="v10-assertion-item-info">
              <span className="v10-assertion-item-name" title={a.graphUri}>{a.name}</span>
              {a.subGraph && (
                // Mirror the AssertionList sub-graph chip (same class/glyph/
                // truncation) so rows sharing a name across root/sub-graph
                // partitions stay disambiguated.
                <span className="v10-item-count v10-item-subgraph" title={`In sub-graph: ${a.subGraph}`}>
                  › {truncateMiddle(a.subGraph, 18)}
                </span>
              )}
              {a.tripleCount != null && (
                <span className="v10-assertion-item-count">{a.tripleCount} triples</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {publishResult && (() => {
        const { published, total, sealed, partial, partialError, failures, sample } = publishResult;
        // "Clean" only when every asset published AND none came back as a 207
        // partial (minted on-chain but the CG binding failed).
        const allOk = published === total && published > 0 && partial === 0;
        const sampleConfirmed = sample?.status === 'confirmed' && !!sample.txHash;
        return (
          <div className={`v10-publish-result-card ${allOk ? 'success' : 'error'}`}>
            <div className="v10-publish-result-title">
              {published > 0
                ? `Published ${published} of ${total} knowledge asset${total === 1 ? '' : 's'} to Verifiable Memory`
                : 'NOT published to Verifiable Memory'}
            </div>
            {sealed > 0 && (
              <div className="v10-publish-result-details" style={{ marginBottom: 6 }}>
                {sealed} asset{sealed === 1 ? ' was' : 's were'} sealed in Shared Memory before publishing.
              </div>
            )}
            {partial > 0 && (
              <div className="v10-publish-result-details" style={{ marginBottom: 6 }}>
                ⚠ {partial} asset{partial === 1 ? '' : 's'}: {partialPublishWarning(partialError)}
              </div>
            )}
            {failures.length > 0 && (
              <div className="v10-publish-result-details" style={{ marginBottom: 6 }}>
                {failures.length} asset{failures.length === 1 ? '' : 's'} could not be published — {failures[0].name}: {failures[0].error}
                {failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}
              </div>
            )}
            <div className="v10-publish-result-details">
              {sample?.kaId != null && (
                <div><span className="v10-publish-result-label">Knowledge Asset:</span> {sample.kaId}</div>
              )}
              {sampleConfirmed ? (
                <div className="v10-publish-result-tx">
                  <span className="v10-publish-result-label">Tx hash:</span>{' '}
                  <span className="mono" title={sample!.txHash}>{sample!.txHash}</span>
                  {sample!.blockNumber != null && (
                    <span className="v10-publish-result-block"> (block {sample!.blockNumber})</span>
                  )}
                </div>
              ) : (
                <div className="v10-publish-result-details">
                  Verifiable Memory requires a confirmed <code>KCCreated</code> event. If a publish
                  did not land on-chain, check the node logs (typically a missing publisher wallet,
                  an unfunded signer, or a chain adapter that isn&apos;t V10-ready).
                </div>
              )}
            </div>
          </div>
        );
      })()}

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

function buildVerifiableMemorySearchQuery(opts: {
  query: string;
  field: 'any' | 'subject' | 'predicate' | 'object';
  limit: number;
}): string {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 50;
  const trimmed = opts.query.trim();
  if (!trimmed) {
    return `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT ${limit}`;
  }
  const needle = escapeSparqlString(trimmed.toLowerCase());
  const filters = {
    subject: `CONTAINS(LCASE(STR(?s)), "${needle}")`,
    predicate: `CONTAINS(LCASE(STR(?p)), "${needle}")`,
    object: `CONTAINS(LCASE(STR(?o)), "${needle}")`,
  };
  const filter = opts.field === 'any'
    ? `(${filters.subject} || ${filters.predicate} || ${filters.object})`
    : filters[opts.field];
  return `SELECT ?s ?p ?o WHERE { ?s ?p ?o . FILTER(${filter}) } LIMIT ${limit}`;
}

function escapeSparqlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
