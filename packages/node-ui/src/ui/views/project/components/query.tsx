import React, { useMemo, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  isQueryCatalogParameterRequired,
  type QueryCatalogParameterDefinition,
} from '@origintrail-official/dkg-core/query-catalog-parameters';
import {
  CONTEXT_GRAPH_QUERY_SUBGRAPH,
  USER_QUERY_CATALOG_NAME,
  USER_QUERY_CATALOG_SLUG,
  buildQueryCatalogWrite,
  prepareQueryCatalogExecution,
} from '@origintrail-official/dkg-core/query-catalog';
import { useFetch } from '../../../hooks.js';
import { executeQuery, writeProfileQueryCatalog, type QueryExecutionView } from '../../../api.js';
import { useProjectProfileContext, type QueryCatalog } from '../../../hooks/useProjectProfile.js';
import { EmptyState } from '../../../components/ContextGraphPrimitives.js';

function contextGraphQueryTemplate(contextGraphId: string): string {
  return `SELECT ?g ?s ?p ?o WHERE {
  GRAPH ?g { ?s ?p ?o }
  ${contextGraphQueryFilter(contextGraphId)}
}
LIMIT 1000`;
}

const USER_QUERY_CATALOG_DESCRIPTION = 'User-created SPARQL saved in this node profile for this Context Graph.';
type SavedCatalogQuery = QueryCatalog['queries'][number];
type QueryEditorSession =
  | { kind: 'ad-hoc'; draft: string }
  | {
      kind: 'catalog';
      key: string;
      query: SavedCatalogQuery;
      values: Record<string, string>;
      draft: string;
    };
type ActiveQueryExecution = {
  sparql: string;
  view?: QueryExecutionView;
  subGraphName?: string;
  sourceKey?: string;
};

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
    parameters: [],
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

function buildSavedQueryWrite(
  contextGraphId: string,
  name: string,
  description: string,
  sparql: string,
  parameters: readonly QueryCatalogParameterDefinition[] = [],
  view?: QueryExecutionView,
): {
  query: SavedCatalogQuery;
  quads: Array<{ subject: string; predicate: string; object: string; graph: string }>;
} {
  const rank = Date.now();
  const write = buildQueryCatalogWrite({
    contextGraphId,
    name,
    description: description || undefined,
    sparql,
    subGraph: CONTEXT_GRAPH_QUERY_SUBGRAPH,
    catalogSlug: USER_QUERY_CATALOG_SLUG,
    catalogName: USER_QUERY_CATALOG_NAME,
    catalogDescription: USER_QUERY_CATALOG_DESCRIPTION,
    rank,
    catalogRank: 50,
    parameters,
    view,
  });
  const query: SavedCatalogQuery = {
    slug: write.savedQuery.slug,
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
    parameters: [...parameters],
    view,
  };
  return { query, quads: write.quads };
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
  const [session, setSession] = useState<QueryEditorSession>({ kind: 'ad-hoc', draft: defaultQuery });
  const [activeExecution, setActiveExecution] = useState<ActiveQueryExecution>({ sparql: defaultQuery });
  const [localSavedCatalogs, setLocalSavedCatalogs] = useState<QueryCatalog[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [parameterError, setParameterError] = useState<string | null>(null);
  const builtInCatalog = useMemo(() => contextGraphBuiltInCatalog(contextGraphId), [contextGraphId]);
  const queryCatalogs = useMemo(
    () => mergeQueryCatalogs([builtInCatalog, ...localSavedCatalogs, ...(profile?.queryCatalogs ?? [])]),
    [builtInCatalog, localSavedCatalogs, profile?.queryCatalogs],
  );
  const renderedQueryCatalogs = useMemo(
    () => (profile?.loading || profile?.error ? mergeQueryCatalogs([builtInCatalog, ...localSavedCatalogs]) : queryCatalogs),
    [builtInCatalog, localSavedCatalogs, profile?.error, profile?.loading, queryCatalogs],
  );
  const selectedCatalogQuery = useMemo(() => {
    return session.kind === 'catalog' ? session.query : undefined;
  }, [session]);
  const activeCatalogQueryKey = session.kind === 'catalog' ? session.key : null;
  const draftQuery = session.draft;
  const catalogParameterValues = session.kind === 'catalog' ? session.values : {};

  useEffect(() => {
    setSession({ kind: 'ad-hoc', draft: defaultQuery });
    setActiveExecution({ sparql: defaultQuery });
    setLocalSavedCatalogs([]);
    setSaveOpen(false);
    setSaveName('');
    setSaveDescription('');
    setSaveError(null);
    setSaveMessage(null);
    setParameterError(null);
  }, [defaultQuery]);

  const { data, loading, error, refresh } = useFetch(
    () => executeQuery(activeExecution.sparql, {
      contextGraphId,
      view: activeExecution.view,
      subGraphName: activeExecution.subGraphName,
    }),
    [activeExecution.sparql, activeExecution.subGraphName, activeExecution.view, contextGraphId],
    0,
  );

  const executionMatchesSession = session.kind !== 'catalog'
    || activeExecution.sourceKey === session.key;
  const queryResult = executionMatchesSession
    ? (data as any)?.result ?? (data as any)?.results
    : undefined;
  const resultType = queryResult?.type
    ?? (Array.isArray(queryResult?.quads)
      ? 'quads'
      : typeof queryResult?.value === 'boolean'
        ? 'boolean'
        : 'bindings');
  const rows = useMemo(
    () => resultType === 'quads'
      ? queryResult?.quads ?? []
      : resultType === 'bindings'
        ? queryResult?.bindings ?? []
        : [],
    [queryResult, resultType],
  );
  const booleanResult = resultType === 'boolean' && typeof queryResult?.value === 'boolean'
    ? queryResult.value
    : undefined;

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
    const draft = session.draft.trim();
    if (!draft) return;
    let execution: ActiveQueryExecution;
    if (session.kind === 'catalog' && draft === session.query.sparql.trim()) {
      try {
        execution = {
          ...prepareQueryCatalogExecution(session.query, session.values),
          sourceKey: session.key,
        };
        setParameterError(null);
      } catch (err: any) {
        setParameterError(err?.message ?? String(err));
        return;
      }
    } else {
      execution = { sparql: draft };
      if (session.kind === 'catalog') setSession({ kind: 'ad-hoc', draft });
      setParameterError(null);
    }
    setSaveMessage(null);
    setSaveError(null);
    if (
      execution.sparql === activeExecution.sparql
      && execution.view === activeExecution.view
      && execution.subGraphName === activeExecution.subGraphName
    ) {
      refresh();
      return;
    }
    setActiveExecution(execution);
  }, [activeExecution, refresh, session]);

  const resetQuery = useCallback(() => {
    setSession({ kind: 'ad-hoc', draft: defaultQuery });
    setSaveMessage(null);
    setSaveError(null);
    setParameterError(null);
    if (
      activeExecution.sparql === defaultQuery
      && activeExecution.view === undefined
      && activeExecution.subGraphName === undefined
    ) {
      refresh();
      return;
    }
    setActiveExecution({ sparql: defaultQuery });
  }, [activeExecution, defaultQuery, refresh]);

  const runCatalogQuery = useCallback((key: string, query: SavedCatalogQuery) => {
    const next = query.sparql.trim();
    if (!next) return;
    setSaveMessage(null);
    setSaveError(null);
    setParameterError(null);
    const parameters = query.parameters ?? [];
    const values = Object.fromEntries(parameters
      .filter(parameter => parameter.defaultValue !== undefined)
      .map(parameter => [parameter.name, String(parameter.defaultValue)]));
    setSession({ kind: 'catalog', key, query, values, draft: next });
    if (parameters.length > 0) return;
    const execution: ActiveQueryExecution = {
      ...prepareQueryCatalogExecution(query, values),
      sourceKey: key,
    };
    if (
      activeExecution.sparql === execution.sparql
      && activeExecution.view === execution.view
      && activeExecution.subGraphName === execution.subGraphName
    ) {
      refresh();
      return;
    }
    setActiveExecution(execution);
  }, [activeExecution, refresh]);

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
      const selectedTemplate = selectedCatalogQuery && selectedCatalogQuery.sparql.trim() === sparql
        ? selectedCatalogQuery
        : undefined;
      const { query, quads } = buildSavedQueryWrite(
        contextGraphId,
        name,
        description,
        sparql,
        selectedTemplate?.parameters ?? [],
        selectedTemplate?.view,
      );
      await writeProfileQueryCatalog(contextGraphId, quads);
      setLocalSavedCatalogs(prev => appendSavedQueryCatalog(prev, query));
      const key = `${query.subGraph}|${query.catalogSlug}|${query.slug}`;
      const values = session.kind === 'catalog' ? session.values : {};
      setSession({ kind: 'catalog', key, query, values, draft: query.sparql });
      try {
        const savedExecution = prepareQueryCatalogExecution(query, values);
        setActiveExecution(previous =>
          previous.sparql === savedExecution.sparql
          && previous.view === savedExecution.view
          && previous.subGraphName === savedExecution.subGraphName
            ? { ...previous, sourceKey: key }
            : previous,
        );
      } catch {
        // The write already validated the template. Missing runtime values only
        // mean there is no executed result to associate with this saved entry.
      }
      setSaveName('');
      setSaveDescription('');
      setSaveOpen(false);
      setSaveMessage('Saved to catalogue.');
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to save query.');
    } finally {
      setSaving(false);
    }
  }, [contextGraphId, draftQuery, saveDescription, saveName, selectedCatalogQuery, session]);

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
                      const isActive = activeCatalogQueryKey === key;
                      const chipLabel = q.description ? `${q.name}. ${q.description}` : q.name;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`v10-cg-query-chip${isActive ? ' active' : ''}`}
                          title={chipLabel}
                          aria-label={`Load query: ${chipLabel}`}
                          onClick={() => runCatalogQuery(key, q)}
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
        {selectedCatalogQuery && (selectedCatalogQuery.parameters?.length ?? 0) > 0 && (
          <div className="v10-cg-query-parameters" aria-label="Query parameters">
            {(selectedCatalogQuery.parameters ?? []).map(parameter => (
              <label key={parameter.name} className="v10-cg-query-parameter">
                <span>{parameter.label ?? parameter.name}</span>
                {parameter.type === 'boolean' ? (
                  <select
                    className="v10-form-input"
                    aria-label={parameter.label ?? parameter.name}
                    value={catalogParameterValues[parameter.name] ?? ''}
                    onChange={event => setSession(previous => previous.kind === 'catalog'
                      ? {
                          ...previous,
                          values: { ...previous.values, [parameter.name]: event.target.value },
                        }
                      : previous)}
                  >
                    <option value="">Choose...</option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </select>
                ) : (
                  <input
                    className="v10-form-input"
                    aria-label={parameter.label ?? parameter.name}
                    type={parameter.type === 'integer' || parameter.type === 'number' ? 'number' : 'text'}
                    step={parameter.type === 'integer' ? '1' : parameter.type === 'number' ? 'any' : undefined}
                    required={isQueryCatalogParameterRequired(parameter)}
                    value={catalogParameterValues[parameter.name] ?? ''}
                    placeholder={parameter.description}
                    onChange={event => setSession(previous => previous.kind === 'catalog'
                      ? {
                          ...previous,
                          values: { ...previous.values, [parameter.name]: event.target.value },
                        }
                      : previous)}
                  />
                )}
                {parameter.description && <small>{parameter.description}</small>}
              </label>
            ))}
          </div>
        )}
        {parameterError && <span className="v10-cg-query-error-detail">{parameterError}</span>}
        <textarea
          className="v10-cg-query-textarea"
          aria-label="SPARQL editor"
          value={draftQuery}
          onChange={(e) => {
            setSession({ kind: 'ad-hoc', draft: e.target.value });
            setParameterError(null);
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
        {!executionMatchesSession && (
          <EmptyState
            compact
            tone="query"
            icon="?"
            title="Enter parameters, then run this query."
            description="Previous query results are hidden so they are not presented as results for the newly selected template."
          />
        )}
        {executionMatchesSession && loading && (
          <EmptyState
            compact
            tone="query"
            icon="?"
            title="Loading query results..."
          />
        )}
        {executionMatchesSession && error && (
          <EmptyState
            compact
            tone="danger"
            icon="!"
            title="Query could not run."
            description={queryErrorMessage(error)}
          />
        )}

        {executionMatchesSession && !loading && !error && booleanResult === undefined && rows.length === 0 && (
          <EmptyState
            compact
            tone="query"
            icon="?"
            title="No results for this query."
            description="Adjust the query or run a saved query against this Context Graph."
          />
        )}

        {executionMatchesSession && !loading && !error && booleanResult !== undefined && (
          <div className="v10-mlv-table-wrap" aria-label="ASK result">
            <div className="v10-mlv-result-count">ASK result</div>
            <strong>{String(booleanResult)}</strong>
          </div>
        )}

        {executionMatchesSession && !loading && !error && booleanResult === undefined && rows.length > 0 && (
          <div className="v10-mlv-table-wrap">
            <div className="v10-mlv-result-count">
              {rows.length} {resultType === 'quads' ? `quad${rows.length === 1 ? '' : 's'}` : `result${rows.length === 1 ? '' : 's'}`}
            </div>
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
