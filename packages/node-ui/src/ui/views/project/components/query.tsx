import React, { useMemo, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useFetch } from '../../../hooks.js';
import { executeQuery, writeProfileQueryCatalog } from '../../../api.js';
import { useProjectProfileContext, type QueryCatalog } from '../../../hooks/useProjectProfile.js';
import { EmptyState } from '../../../components/ContextGraphPrimitives.js';

function contextGraphQueryTemplate(contextGraphId: string): string {
  return `SELECT ?g ?s ?p ?o WHERE {
  GRAPH ?g { ?s ?p ?o }
  ${contextGraphQueryFilter(contextGraphId)}
}
LIMIT 1000`;
}

const CONTEXT_GRAPH_QUERY_SUBGRAPH = '__context_graph';
const USER_QUERY_CATALOG_SLUG = 'ui-saved-queries';
const USER_QUERY_CATALOG_NAME = 'Saved queries';
const USER_QUERY_CATALOG_DESCRIPTION = 'User-created SPARQL saved in this node profile for this Context Graph.';
const PROFILE_NS = 'http://dkg.io/ontology/profile/';
const SCHEMA_NS = 'http://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
type SavedCatalogQuery = QueryCatalog['queries'][number];

function sparqlString(value: string): string {
  return JSON.stringify(value);
}

function contextGraphQueryFilter(contextGraphId: string): string {
  const cgUri = `did:dkg:context-graph:${contextGraphId}`;
  const cgPrefix = `${cgUri}/`;
  return `FILTER(
    (
      STR(?g) = ${sparqlString(cgUri)} ||
      STRSTARTS(STR(?g), ${sparqlString(cgPrefix)})
    ) &&
    !CONTAINS(STR(?g), "/_private")
  )`;
}

function contextGraphBuiltInCatalog(contextGraphId: string): QueryCatalog {
  const catalogSlug = 'whole-context-graph';
  const catalogName = 'Context graph';
  const catalogRank = -100;
  const subGraph = CONTEXT_GRAPH_QUERY_SUBGRAPH;
  const withQueryDefaults = (query: {
    slug: string;
    name: string;
    description: string;
    sparql: string;
    resultColumn?: string;
    rank: number;
  }) => ({
    subGraph,
    catalogSlug,
    catalogName,
    catalogDescription: 'Ready-made SPARQL included with the Node UI for common Context Graph checks.',
    catalogRank,
    resultColumn: '',
    ...query,
  });

  return {
    slug: catalogSlug,
    subGraph,
    name: catalogName,
    description: 'Ready-made SPARQL included with the Node UI for common Context Graph checks.',
    rank: catalogRank,
    queries: [
      withQueryDefaults({
        slug: 'all-triples',
        name: 'All triples',
        description: 'Show triples across available non-private graphs in this context graph.',
        sparql: contextGraphQueryTemplate(contextGraphId),
        resultColumn: 'o',
        rank: 1,
      }),
      withQueryDefaults({
        slug: 'graphs',
        name: 'Graphs',
        description: 'List available non-private named graphs and triple counts.',
        sparql: `SELECT ?g (COUNT(*) AS ?triples) WHERE {
  GRAPH ?g { ?s ?p ?o }
  ${contextGraphQueryFilter(contextGraphId)}
}
GROUP BY ?g
ORDER BY DESC(?triples)
LIMIT 100`,
        resultColumn: 'g',
        rank: 2,
      }),
      withQueryDefaults({
        slug: 'types',
        name: 'Types',
        description: 'Count entities by RDF type across the context graph.',
        sparql: `SELECT ?type (COUNT(DISTINCT ?s) AS ?entities) WHERE {
  GRAPH ?g { ?s a ?type }
  ${contextGraphQueryFilter(contextGraphId)}
}
GROUP BY ?type
ORDER BY DESC(?entities)
LIMIT 100`,
        resultColumn: 'type',
        rank: 3,
      }),
    ],
  };
}

function querySlug(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'saved-query';
}

function profileUri(contextGraphId: string, kind: 'catalog' | 'query', slug: string): string {
  return `urn:dkg:profile:${encodeURIComponent(contextGraphId)}:${kind}:${encodeURIComponent(slug)}`;
}

function literal(value: string): string {
  return JSON.stringify(value);
}

function intLiteral(value: number): string {
  return `"${value}"^^<${XSD_INTEGER}>`;
}

function buildSavedQueryWrite(contextGraphId: string, name: string, description: string, sparql: string): {
  query: SavedCatalogQuery;
  quads: Array<{ subject: string; predicate: string; object: string; graph: string }>;
} {
  const rank = Date.now();
  const slug = `${querySlug(name)}-${rank.toString(36)}`;
  const catalogUri = profileUri(contextGraphId, 'catalog', USER_QUERY_CATALOG_SLUG);
  const queryUri = profileUri(contextGraphId, 'query', slug);
  const query: SavedCatalogQuery = {
    slug,
    subGraph: CONTEXT_GRAPH_QUERY_SUBGRAPH,
    catalogSlug: USER_QUERY_CATALOG_SLUG,
    catalogName: USER_QUERY_CATALOG_NAME,
    catalogDescription: USER_QUERY_CATALOG_DESCRIPTION,
    catalogRank: 50,
    name,
    description: description || undefined,
    sparql,
    resultColumn: '',
    rank,
  };
  const quads = [
    { subject: catalogUri, predicate: RDF_TYPE, object: `${PROFILE_NS}QueryCatalog`, graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}forSubGraph`, object: literal(CONTEXT_GRAPH_QUERY_SUBGRAPH), graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}displayName`, object: literal(USER_QUERY_CATALOG_NAME), graph: '' },
    { subject: catalogUri, predicate: `${SCHEMA_NS}description`, object: literal(USER_QUERY_CATALOG_DESCRIPTION), graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}rank`, object: intLiteral(50), graph: '' },
    { subject: queryUri, predicate: RDF_TYPE, object: `${PROFILE_NS}SavedQuery`, graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}forSubGraph`, object: literal(CONTEXT_GRAPH_QUERY_SUBGRAPH), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}inCatalog`, object: catalogUri, graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}displayName`, object: literal(name), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}sparqlQuery`, object: literal(sparql), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}rank`, object: intLiteral(rank), graph: '' },
  ];
  if (description) {
    quads.push({ subject: queryUri, predicate: `${SCHEMA_NS}description`, object: literal(description), graph: '' });
  }
  return { query, quads };
}

function appendSavedQueryCatalog(catalogs: QueryCatalog[], query: SavedCatalogQuery): QueryCatalog[] {
  const key = `${CONTEXT_GRAPH_QUERY_SUBGRAPH}|${USER_QUERY_CATALOG_SLUG}`;
  const next = catalogs.map(catalog => ({
    ...catalog,
    queries: [...catalog.queries],
  }));
  const existing = next.find(catalog => `${catalog.subGraph}|${catalog.slug}` === key);
  if (existing) {
    existing.queries = [...existing.queries, query].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    return next;
  }
  return [
    ...next,
    {
      slug: USER_QUERY_CATALOG_SLUG,
      subGraph: CONTEXT_GRAPH_QUERY_SUBGRAPH,
      name: USER_QUERY_CATALOG_NAME,
      description: USER_QUERY_CATALOG_DESCRIPTION,
      rank: 50,
      queries: [query],
    },
  ];
}

function mergeQueryCatalogs(catalogs: QueryCatalog[]): QueryCatalog[] {
  const byCatalog = new Map<string, QueryCatalog>();

  for (const catalog of catalogs) {
    const catalogKey = `${catalog.subGraph}|${catalog.slug}`;
    const existing = byCatalog.get(catalogKey);
    if (!existing) {
      byCatalog.set(catalogKey, {
        ...catalog,
        queries: [...catalog.queries],
      });
      continue;
    }

    const byQuery = new Map(existing.queries.map(query => [
      `${query.subGraph}|${query.catalogSlug}|${query.slug}`,
      query,
    ]));
    for (const query of catalog.queries) {
      const queryKey = `${query.subGraph}|${query.catalogSlug}|${query.slug}`;
      if (!byQuery.has(queryKey)) byQuery.set(queryKey, query);
    }
    existing.queries = Array.from(byQuery.values())
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }

  return Array.from(byCatalog.values()).sort((a, b) =>
    a.subGraph.localeCompare(b.subGraph)
    || a.rank - b.rank
    || a.name.localeCompare(b.name),
  );
}

function bindingValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as any)) return String((v as any).value);
  return String(v);
}

function shortenBindingValue(value: string): string {
  if (!value) return '—';
  if (value.length <= 140) return value;
  return `${value.slice(0, 110)}...${value.slice(-24)}`;
}

function isBuiltInQueryCatalog(catalog: QueryCatalog): boolean {
  return catalog.subGraph === CONTEXT_GRAPH_QUERY_SUBGRAPH && catalog.slug === 'whole-context-graph';
}

function queryCatalogueScope(catalog: QueryCatalog): 'context' | 'subgraph' {
  return catalog.subGraph === CONTEXT_GRAPH_QUERY_SUBGRAPH ? 'context' : 'subgraph';
}

function queryCatalogueGroupLabel(catalog: QueryCatalog, scope: 'context' | 'subgraph', subGraphLabel?: string): string {
  if (isBuiltInQueryCatalog(catalog)) return 'Built-in presets';
  if (catalog.subGraph === CONTEXT_GRAPH_QUERY_SUBGRAPH && catalog.slug === USER_QUERY_CATALOG_SLUG) {
    return USER_QUERY_CATALOG_NAME;
  }
  if (scope === 'context') return catalog.name;
  return `${subGraphLabel ?? catalog.subGraph}: ${catalog.name}`;
}

function queryCatalogueGroupDescription(catalog: QueryCatalog): string {
  if (isBuiltInQueryCatalog(catalog)) {
    return 'UI-provided SPARQL for common Context Graph checks.';
  }
  if (catalog.subGraph === CONTEXT_GRAPH_QUERY_SUBGRAPH && catalog.slug === USER_QUERY_CATALOG_SLUG) {
    return USER_QUERY_CATALOG_DESCRIPTION;
  }
  return catalog.description ?? '';
}

function queryCatalogueGroupKind(catalog: QueryCatalog, scope: 'context' | 'subgraph'): string {
  if (isBuiltInQueryCatalog(catalog)) return 'Preset';
  return scope === 'context' ? 'Saved' : 'Subgraph';
}

function queryErrorMessage(error: string | null): ReactNode {
  return (
    <>
      <span>Review the query or node response details, then try again.</span>
      {error && <span className="v10-cg-query-error-detail">{error}</span>}
    </>
  );
}

export function ContextGraphQueryView({ contextGraphId }: { contextGraphId: string }) {
  const profile = useProjectProfileContext();
  const defaultQuery = useMemo(() => contextGraphQueryTemplate(contextGraphId), [contextGraphId]);
  const [draftQuery, setDraftQuery] = useState(defaultQuery);
  const [activeQuery, setActiveQuery] = useState(defaultQuery);
  const [activeCatalogQueryKey, setActiveCatalogQueryKey] = useState<string | null>(null);
  const [localSavedCatalogs, setLocalSavedCatalogs] = useState<QueryCatalog[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const builtInCatalog = useMemo(() => contextGraphBuiltInCatalog(contextGraphId), [contextGraphId]);
  const queryCatalogs = useMemo(
    () => mergeQueryCatalogs([builtInCatalog, ...localSavedCatalogs, ...(profile?.queryCatalogs ?? [])]),
    [builtInCatalog, localSavedCatalogs, profile?.queryCatalogs],
  );
  const renderedQueryCatalogs = useMemo(
    () => (profile?.loading || profile?.error ? mergeQueryCatalogs([builtInCatalog, ...localSavedCatalogs]) : queryCatalogs),
    [builtInCatalog, localSavedCatalogs, profile?.error, profile?.loading, queryCatalogs],
  );

  useEffect(() => {
    setDraftQuery(defaultQuery);
    setActiveQuery(defaultQuery);
    setActiveCatalogQueryKey(null);
    setLocalSavedCatalogs([]);
    setSaveOpen(false);
    setSaveName('');
    setSaveDescription('');
    setSaveError(null);
    setSaveMessage(null);
  }, [defaultQuery]);

  const { data, loading, error, refresh } = useFetch(
    () => executeQuery(activeQuery, contextGraphId),
    [activeQuery, contextGraphId],
    0,
  );

  const rows = useMemo(
    () => (data as any)?.result?.bindings ?? (data as any)?.results?.bindings ?? [],
    [data],
  );

  const hasSavedProfileQueries = useMemo(
    () => queryCatalogs.some(catalog => !isBuiltInQueryCatalog(catalog) && catalog.queries.length > 0),
    [queryCatalogs],
  );

  const columns = useMemo(() => {
    const out: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!out.includes(key)) out.push(key);
      }
    }
    return out;
  }, [rows]);

  const runQuery = useCallback(() => {
    const next = draftQuery.trim();
    if (!next) return;
    setActiveCatalogQueryKey(null);
    setSaveMessage(null);
    setSaveError(null);
    if (next === activeQuery) {
      refresh();
      return;
    }
    setActiveQuery(next);
  }, [activeQuery, draftQuery, refresh]);

  const resetQuery = useCallback(() => {
    setDraftQuery(defaultQuery);
    setActiveCatalogQueryKey(null);
    setSaveMessage(null);
    setSaveError(null);
    if (activeQuery === defaultQuery) refresh();
    else setActiveQuery(defaultQuery);
  }, [activeQuery, defaultQuery, refresh]);

  const runCatalogQuery = useCallback((key: string, sparql: string) => {
    const next = sparql.trim();
    if (!next) return;
    setActiveCatalogQueryKey(key);
    setDraftQuery(next);
    setSaveMessage(null);
    setSaveError(null);
    if (activeQuery === next) {
      refresh();
      return;
    }
    setActiveQuery(next);
  }, [activeQuery, refresh]);

  const openSaveForm = useCallback(() => {
    const firstLine = draftQuery.trim().split('\n').find(line => line.trim());
    setSaveName(firstLine ? firstLine.replace(/\s+/g, ' ').slice(0, 60) : '');
    setSaveDescription('');
    setSaveError(null);
    setSaveMessage(null);
    setSaveOpen(true);
  }, [draftQuery]);

  const saveQuery = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const name = saveName.trim();
    const description = saveDescription.trim();
    const sparql = draftQuery.trim();
    if (!name) {
      setSaveError('Name is required.');
      return;
    }
    if (!sparql) {
      setSaveError('Query is empty.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const { query, quads } = buildSavedQueryWrite(contextGraphId, name, description, sparql);
      await writeProfileQueryCatalog(contextGraphId, quads);
      setLocalSavedCatalogs(prev => appendSavedQueryCatalog(prev, query));
      const key = `${query.subGraph}|${query.catalogSlug}|${query.slug}`;
      setActiveCatalogQueryKey(key);
      setDraftQuery(query.sparql);
      if (activeQuery === query.sparql) refresh();
      else setActiveQuery(query.sparql);
      setSaveName('');
      setSaveDescription('');
      setSaveOpen(false);
      setSaveMessage('Saved to catalogue.');
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to save query.');
    } finally {
      setSaving(false);
    }
  }, [activeQuery, contextGraphId, draftQuery, refresh, saveDescription, saveName]);

  return (
    <div className="v10-memory-layer-view v10-cg-query-view">
      <div className="v10-mlv-header">
        <span className="v10-mlv-icon">⟐</span>
        <div>
          <h2 className="v10-mlv-title">Query Catalogue</h2>
          <p className="v10-mlv-desc">
            Reusable SPARQL for this Context Graph. Use UI presets or save queries for people and local agents to reuse.
          </p>
        </div>
      </div>

      <section className="v10-cg-query-zone v10-cg-query-zone-catalog" aria-labelledby="query-catalogue-saved-title">
        <div className="v10-cg-query-zone-header">
          <div>
            <span className="v10-cg-query-eyebrow">Query Library</span>
            <h3 id="query-catalogue-saved-title">Choose a query</h3>
            <p>Load a preset or saved query into the editor below.</p>
          </div>
        </div>

        {profile?.loading && (
          <EmptyState
            compact
            inline
            tone="query"
            icon="?"
            title="Loading saved queries..."
            description="Built-in presets are available while saved queries load from this node profile."
          />
        )}

        {profile?.error && (
          <EmptyState
            compact
            inline
            tone="danger"
            icon="!"
            title="Saved query catalogue unavailable"
            description={profile.error}
          />
        )}

        {renderedQueryCatalogs.length > 0 && (
          <div className="v10-cg-query-catalog-groups">
            {renderedQueryCatalogs.map((catalog) => {
              const scope = queryCatalogueScope(catalog);
              const binding = scope === 'context' ? undefined : profile?.forSubGraph(catalog.subGraph);
              const color = binding?.color ?? '#38bdf8';
              const label = queryCatalogueGroupLabel(catalog, scope, binding?.displayName);
              const description = queryCatalogueGroupDescription(catalog);
              const kind = queryCatalogueGroupKind(catalog, scope);
              return (
                <div
                  key={`${catalog.subGraph}|${catalog.slug}`}
                  className="v10-cg-query-catalog-group"
                  style={{ '--sg-color': color } as React.CSSProperties}
                >
                  <div className="v10-cg-query-catalog-group-header">
                    <div>
                      <div className="v10-cg-query-catalog-title-row">
                        <span className="v10-cg-query-catalog-kind">{kind}</span>
                        <h4>{label}</h4>
                      </div>
                      {description && <p>{description}</p>}
                    </div>
                  </div>
                  <div className="v10-cg-query-list">
                    {catalog.queries.map((q) => {
                      const key = `${q.subGraph}|${q.catalogSlug}|${q.slug}`;
                      const isActive = activeCatalogQueryKey === key && activeQuery === q.sparql;
                      const chipLabel = q.description ? `${q.name}. ${q.description}` : q.name;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`v10-cg-query-chip${isActive ? ' active' : ''}`}
                          title={chipLabel}
                          aria-label={`Load query: ${chipLabel}`}
                          onClick={() => runCatalogQuery(key, q.sparql)}
                        >
                          <span className="v10-cg-query-chip-title">{q.name}</span>
                          {q.description && <span className="v10-cg-query-chip-desc">{q.description}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!profile?.loading && !profile?.error && queryCatalogs.length > 0 && !hasSavedProfileQueries && (
          <EmptyState
            compact
            inline
            tone="query"
            icon="?"
            title="No saved queries yet."
            description="Use Save after editing SPARQL to keep a reusable query for this Context Graph."
          />
        )}
      </section>

      <section className="v10-cg-query-zone v10-cg-query-zone-editor" aria-labelledby="query-catalogue-editor-title">
        <div className="v10-cg-query-zone-header">
          <div>
            <span className="v10-cg-query-eyebrow">Ad-hoc SPARQL</span>
            <h3 id="query-catalogue-editor-title">Editor and results</h3>
            <p>Run a one-off query against this Context Graph, or save it when it should become reusable.</p>
          </div>
        </div>

      <div className="v10-cg-query-editor">
        <textarea
          className="v10-cg-query-textarea"
          aria-label="SPARQL editor"
          value={draftQuery}
          onChange={(e) => {
            setDraftQuery(e.target.value);
            setActiveCatalogQueryKey(null);
          }}
          spellCheck={false}
        />
        <div className="v10-cg-query-actions">
          <button className="v10-mlv-run-btn" type="button" onClick={runQuery}>Run</button>
          <button className="v10-mlv-save-btn" type="button" onClick={openSaveForm}>Save</button>
          <button className="v10-mlv-clear-btn" type="button" onClick={resetQuery}>Reset</button>
        </div>
      </div>

      {saveOpen && (
        <form className="v10-cg-query-save-panel" onSubmit={saveQuery}>
          <label className="v10-cg-query-save-field">
            <span>Name</span>
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Query name"
              maxLength={80}
            />
          </label>
          <label className="v10-cg-query-save-field">
            <span>Description</span>
            <input
              type="text"
              value={saveDescription}
              onChange={(e) => setSaveDescription(e.target.value)}
              placeholder="Optional"
              maxLength={180}
            />
          </label>
          <div className="v10-cg-query-save-actions">
            <button type="button" className="v10-mlv-clear-btn" onClick={() => setSaveOpen(false)} disabled={saving}>Cancel</button>
            <button type="submit" className="v10-mlv-run-btn" disabled={saving}>{saving ? 'Saving...' : 'Save query'}</button>
          </div>
        </form>
      )}

      {saveMessage && <p className="v10-mlv-status" style={{ color: 'var(--text-success)' }}>{saveMessage}</p>}
      {saveError && <p className="v10-mlv-status" style={{ color: 'var(--text-danger)' }}>{saveError}</p>}

      <div className="v10-cg-query-results">
        {loading && (
          <EmptyState
            compact
            tone="query"
            icon="?"
            title="Loading query results..."
          />
        )}
        {error && (
          <EmptyState
            compact
            tone="danger"
            icon="!"
            title="Query could not run."
            description={queryErrorMessage(error)}
          />
        )}

        {!loading && !error && rows.length === 0 && (
          <EmptyState
            compact
            tone="query"
            icon="?"
            title="No results for this query."
            description="Adjust the query or run a saved query against this Context Graph."
          />
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="v10-mlv-table-wrap">
            <div className="v10-mlv-result-count">{rows.length} result{rows.length === 1 ? '' : 's'}</div>
            <table className="v10-mlv-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row: Record<string, unknown>, index: number) => (
                  <tr key={index}>
                    {columns.map((column) => {
                      const value = bindingValue(row[column]);
                      return (
                        <td key={column} className="v10-mlv-cell" title={value}>
                          {shortenBindingValue(value)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </section>
    </div>
  );
}

