/**
 * Load the project profile from the `meta` sub-graph of a context graph
 * and return a typed, query-friendly ProjectProfile object.
 *
 * Profiles declare:
 *   - SubGraphBinding per sub-graph (icon, color, label, rank)
 *   - EntityTypeBinding per rdf:type (icon, color, label, detailHint)
 *   - ViewConfig presets (name, includeTypes, emphasizePredicates, nodeSize)
 *
 * If the `meta` sub-graph is missing or empty, the hook returns a sensible
 * default profile — this keeps the UI functional for any project.
 */
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  type QueryCatalogParameterDefinition,
} from '@origintrail-official/dkg-core/query-catalog-parameters';
import {
  decodeQueryCatalogBindings,
  decodeQueryCatalogReadResponse,
  groupQueryCatalogItems,
  legacyQueryCatalogExecutionView,
  queryCatalogBindingValue,
  type QueryCatalogItem,
} from '@origintrail-official/dkg-core/query-catalog';
import { executeQuery, readProfileQueryCatalog, type QueryExecutionView } from '../api.js';
import { ROOT_SLUG_SENTINEL } from '../lib/subGraphs.js';

async function runProjectQuery(
  sparql: string,
  contextGraphId: string,
): Promise<Array<Record<string, unknown>>> {
  const r = await executeQuery(sparql, { contextGraphId });
  // Bindings can arrive as either bare strings (quadstore internal path)
  // or SPARQL-JSON objects like `{ value, type, datatype?, "xml:lang"? }`.
  // Preserve the raw shape here — `stripLiteral` / `stripIri` normalise
  // each cell via `bindingValue`, which handles both.
  return ((r?.result?.bindings as any[]) ?? []) as Array<Record<string, unknown>>;
}

async function readProjectQueryCatalog(
  contextGraphId: string,
): Promise<QueryCatalogItem[]> {
  const response = await readProfileQueryCatalog(contextGraphId);
  return decodeQueryCatalogReadResponse(response);
}

export interface SubGraphBinding {
  slug: string;
  displayName: string;
  description?: string;
  icon?: string;
  color?: string;
  rank: number;
  /** Predicate IRI (date-valued) that opts this sub-graph into the Timeline tab. */
  timelinePredicate?: string;
  /**
   * Name of the WM assertion this sub-graph's importer writes into.
   * Needed by the verify-on-DKG flow to share the entity's complete owning
   * Knowledge Asset from WM to SWM (the API is keyed by assertion name).
   */
  sourceAssertion?: string;
}

export interface EntityTypeBinding {
  typeIri: string;
  label?: string;
  icon?: string;
  color?: string;
  detailHint?: string;
  /**
   * Domain-aware copy for the Verify-on-DKG CTA. When all four are unset
   * the UI hides the CTA for this type (correct for derived artifacts
   * like files/commits that shouldn't be manually progressed).
   *
   *   promoteLabel / promoteHint — WM -> SWM (the "share with team" step)
   *   publishLabel / publishHint — SWM -> VM  (the "anchor on-chain" step)
   */
  promoteLabel?: string;
  promoteHint?: string;
  publishLabel?: string;
  publishHint?: string;
}

export interface ViewConfig {
  slug: string;
  name: string;
  description?: string;
  includeTypes: string[];
  emphasizePredicates: string[];
  nodeSize?: 'degree' | 'uniform';
}

/**
 * A profile-declared filter chip row. The UI renders one row per
 * `(subGraph, predicate)` pair with a pill per `values[]` entry; multiple
 * selected values OR within the row, rows AND across predicates.
 */
export interface FilterChip {
  slug: string;
  subGraph: string;
  typeIri: string;
  predicate: string;
  label: string;
  values: string[];
}

/**
 * A ViewConfig carrying a SPARQL query. Rendered as a pill above the
 * entity list; clicking runs the query and narrows the list to the
 * returned IRIs in `resultColumn`.
 */
export interface SavedQuery {
  slug: string;
  subGraph: string;
  catalogSlug: string;
  catalogName: string;
  catalogDescription?: string;
  catalogRank: number;
  name: string;
  description?: string;
  sparql: string;
  resultColumn: string;
  rank: number;
  /** Memory projection required by this query contract. */
  view?: QueryExecutionView;
  /** Runtime values required to render this saved SPARQL template. */
  parameters?: QueryCatalogParameterDefinition[];
}

export interface QueryCatalog {
  slug: string;
  subGraph: string;
  name: string;
  description?: string;
  rank: number;
  queries: SavedQuery[];
}

export interface ProjectProfile {
  contextGraphId: string;
  displayName: string;
  description?: string;
  primaryColor: string;
  accentColor: string;
  subGraphs: SubGraphBinding[];
  typeBindings: EntityTypeBinding[];
  views: ViewConfig[];
  filterChips: FilterChip[];
  queryCatalogs: QueryCatalog[];
  savedQueries: SavedQuery[];
  loading: boolean;
  error?: string;
  forSubGraph: (slug: string) => SubGraphBinding | undefined;
  forType: (typeIri: string) => EntityTypeBinding | undefined;
  view: (slug: string) => ViewConfig | undefined;
  chipsFor: (subGraphSlug: string) => FilterChip[];
  savedQueryCatalogsFor: (subGraphSlug: string) => QueryCatalog[];
  savedQueriesFor: (subGraphSlug: string) => SavedQuery[];
}

const DEFAULT_PROFILE_SEED = {
  displayName: 'Project',
  primaryColor: '#a855f7',
  accentColor: '#22c55e',
};

const DEFAULT_SUBGRAPH_FALLBACK = (slug: string): SubGraphBinding => ({
  slug,
  displayName: slug,
  icon: '•',
  color: '#64748b',
  rank: 99,
});

// S3 — synthesized binding for the client-only Root bucket. The
// daemon never emits a binding for ROOT_SLUG_SENTINEL (it's a
// pure client construct — "entities not in any named sub-graph"),
// so `forSubGraph` would otherwise hand back the default
// `__root__`/`•` fallback to consumers like ProjectHeaderStrip.
// Centralising the Root identity here means every `forSubGraph`
// call site (breadcrumb, chip, detail header, badge) agrees on
// the same icon + label + tone.
const ROOT_SUBGRAPH_BINDING: SubGraphBinding = {
  slug: ROOT_SLUG_SENTINEL,
  displayName: 'Root',
  description: 'Entities not in any subgraph (Context Graph root)',
  icon: '⊘',
  // color is left unset so consumers fall through to their own
  // neutral default (CSS var --text-tertiary on the chip / detail
  // header, --border-strong on the empty-state accent).
  rank: 99,
};

const DEFAULT_TYPE_FALLBACK = (typeIri: string): EntityTypeBinding => ({
  typeIri,
  label: typeIri.split(/[/#]/).pop() || typeIri,
  color: '#64748b',
});

// ── SPARQL helpers ────────────────────────────────────────────
const PROFILE_NS = 'http://dkg.io/ontology/profile/';

// Normalise a SPARQL binding cell. `/api/query` returns SPARQL-JSON
// objects (`{value, type, datatype?, "xml:lang"?}`) for most paths,
// not bare strings — calling `.match()` / `.trim()` on the object form
// throws, so every helper below must normalise first.
function bindingValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const raw = (v as { value?: unknown }).value;
    return raw === null || raw === undefined ? '' : String(raw);
  }
  return String(v);
}

function stripLiteral(value: unknown): string {
  const raw = bindingValue(value);
  if (!raw) return '';
  const m = raw.match(/^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]+>)?$/);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  return raw;
}

function parseInt10(value: unknown): number {
  const s = stripLiteral(value);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

// We union the committed `meta` sub-graph with any assertion that lives
// under it so the profile is readable whether it has been promoted into
// SWM/VM or is still sitting in WM as an assertion. This makes the UI
// responsive to the profile as soon as `import-profile.mjs` finishes,
// without requiring a separate promote step.
function metaGraphFilter(contextGraphId: string): string {
  const prefix = `did:dkg:context-graph:${contextGraphId}/meta`;
  // SPARQL string escape of `?g` prefix: double-quotes + backslash.
  return `FILTER(strstarts(str(?g), "${prefix.replace(/"/g, '\\"')}"))`;
}

function buildProfileRootQuery(contextGraphId: string): string {
  return `PREFIX prof: <${PROFILE_NS}>
PREFIX schema: <http://schema.org/>
SELECT ?profile ?name ?description ?primary ?accent
WHERE {
  GRAPH ?g {
    ?profile a prof:Profile .
    OPTIONAL { ?profile prof:displayName ?name }
    OPTIONAL { ?profile schema:description ?description }
    OPTIONAL { ?profile prof:primaryColor ?primary }
    OPTIONAL { ?profile prof:accentColor ?accent }
  }
  ${metaGraphFilter(contextGraphId)}
} LIMIT 1`;
}

function buildSubGraphBindingsQuery(contextGraphId: string): string {
  return `PREFIX prof: <${PROFILE_NS}>
PREFIX schema: <http://schema.org/>
SELECT ?slug ?displayName ?description ?icon ?color ?rank ?timelinePredicate ?sourceAssertion
WHERE {
  GRAPH ?g {
    ?b a prof:SubGraphBinding ;
       prof:forSubGraph ?slug .
    OPTIONAL { ?b prof:displayName ?displayName }
    OPTIONAL { ?b schema:description ?description }
    OPTIONAL { ?b prof:icon ?icon }
    OPTIONAL { ?b prof:color ?color }
    OPTIONAL { ?b prof:rank ?rank }
    OPTIONAL { ?b prof:timelinePredicate ?timelinePredicate }
    OPTIONAL { ?b prof:sourceAssertion ?sourceAssertion }
  }
  ${metaGraphFilter(contextGraphId)}
}`;
}

function buildFilterChipsQuery(contextGraphId: string): string {
  return `PREFIX prof: <${PROFILE_NS}>
SELECT ?chip ?subGraph ?type ?predicate ?label
       (GROUP_CONCAT(DISTINCT ?v; separator="|") AS ?values)
WHERE {
  GRAPH ?g {
    ?chip a prof:FilterChip ;
          prof:forSubGraph ?subGraph ;
          prof:forType ?type ;
          prof:onPredicate ?predicate ;
          prof:chipValue ?v .
    OPTIONAL { ?chip prof:label ?label }
  }
  ${metaGraphFilter(contextGraphId)}
}
GROUP BY ?chip ?subGraph ?type ?predicate ?label`;
}

interface QueryCatalogRowShape extends Record<string, unknown> {}
interface SavedQueryRowShape extends Record<string, unknown> {}

export function buildQueryCatalogState(
  catalogRows: readonly QueryCatalogRowShape[],
  queryRows: readonly SavedQueryRowShape[],
): {
  queryCatalogs: QueryCatalog[];
  savedQueries: SavedQuery[];
  catalogsBySubGraph: Map<string, QueryCatalog[]>;
  queriesBySubGraph: Map<string, SavedQuery[]>;
} {
  const catalogsByUri = new Map<string, QueryCatalogRowShape>();
  for (const row of catalogRows) {
    const catalogIri = queryCatalogBindingValue(row.catalog);
    if (!catalogIri) continue;
    catalogsByUri.set(catalogIri, row);
  }

  const enrichedRows = queryRows.map((row) => {
    const catalogIri = queryCatalogBindingValue(row.catalog);
    const catalog = catalogsByUri.get(catalogIri);
    return {
      ...row,
      resultColumn: row.resultColumn ?? row.column,
      catalogName: row.catalogName ?? catalog?.name,
      catalogDescription: row.catalogDescription ?? catalog?.description,
      catalogRank: row.catalogRank ?? catalog?.rank,
    };
  });
  const decoded = decodeQueryCatalogBindings(enrichedRows, {
    legacyView: legacyQueryCatalogExecutionView,
  }).map((query) => query.catalogIri ? query : {
    ...query,
    catalogSlug: `default:${query.subGraph}`,
  });
  return buildQueryCatalogStateFromItems(decoded);
}

function buildQueryCatalogStateFromItems(decodedItems: readonly QueryCatalogItem[]): {
  queryCatalogs: QueryCatalog[];
  savedQueries: SavedQuery[];
  catalogsBySubGraph: Map<string, QueryCatalog[]>;
  queriesBySubGraph: Map<string, SavedQuery[]>;
} {
  const decoded = decodedItems.map((query) => query.catalogIri ? query : {
    ...query,
    catalogSlug: `default:${query.subGraph}`,
  });
  const queries: SavedQuery[] = decoded.map((query) => ({
    slug: query.slug,
    subGraph: query.subGraph,
    catalogSlug: query.catalogSlug,
    catalogName: query.catalogName,
    catalogDescription: query.catalogDescription,
    catalogRank: query.catalogRank,
    name: query.name,
    description: query.description,
    sparql: query.sparql,
    resultColumn: query.resultColumn ?? '',
    rank: query.rank,
    view: query.view,
    parameters: query.parameters,
  }));
  const queryByIri = new Map(decoded.map((query, index) => [query.queryIri, queries[index]]));
  const queryCatalogs: QueryCatalog[] = groupQueryCatalogItems(decoded).map((catalog) => ({
    slug: catalog.slug,
    subGraph: catalog.subGraph,
    name: catalog.name,
    description: catalog.description,
    rank: catalog.rank,
    queries: catalog.queries
      .map((query) => queryByIri.get(query.queryIri))
      .filter((query): query is SavedQuery => Boolean(query)),
  }));

  const catalogsBySubGraph = new Map<string, QueryCatalog[]>();
  const queriesBySubGraph = new Map<string, SavedQuery[]>();
  for (const catalog of queryCatalogs) {
    const nextCatalogs = catalogsBySubGraph.get(catalog.subGraph) ?? [];
    nextCatalogs.push(catalog);
    catalogsBySubGraph.set(catalog.subGraph, nextCatalogs);

    const nextQueries = queriesBySubGraph.get(catalog.subGraph) ?? [];
    nextQueries.push(...catalog.queries);
    queriesBySubGraph.set(catalog.subGraph, nextQueries);
  }

  return { queryCatalogs, savedQueries: queries, catalogsBySubGraph, queriesBySubGraph };
}

function buildTypeBindingsQuery(contextGraphId: string): string {
  return `PREFIX prof: <${PROFILE_NS}>
SELECT ?type ?label ?icon ?color ?detailHint
       ?promoteLabel ?promoteHint ?publishLabel ?publishHint
WHERE {
  GRAPH ?g {
    ?b a prof:EntityTypeBinding ;
       prof:forType ?type .
    OPTIONAL { ?b prof:label ?label }
    OPTIONAL { ?b prof:icon ?icon }
    OPTIONAL { ?b prof:color ?color }
    OPTIONAL { ?b prof:detailHint ?detailHint }
    OPTIONAL { ?b prof:promoteLabel ?promoteLabel }
    OPTIONAL { ?b prof:promoteHint  ?promoteHint }
    OPTIONAL { ?b prof:publishLabel ?publishLabel }
    OPTIONAL { ?b prof:publishHint  ?publishHint }
  }
  ${metaGraphFilter(contextGraphId)}
}`;
}

function buildViewConfigsQuery(contextGraphId: string): string {
  return `PREFIX prof: <${PROFILE_NS}>
PREFIX schema: <http://schema.org/>
SELECT ?view ?name ?description ?nodeSize
       (GROUP_CONCAT(DISTINCT ?incType; separator="|") AS ?includeTypes)
       (GROUP_CONCAT(DISTINCT ?empPred; separator="|") AS ?emphasizePredicates)
WHERE {
  GRAPH ?g {
    ?view a prof:ViewConfig .
    OPTIONAL { ?view prof:displayName ?name }
    OPTIONAL { ?view schema:description ?description }
    OPTIONAL { ?view prof:nodeSize ?nodeSize }
    OPTIONAL { ?view prof:includeType ?incType }
    OPTIONAL { ?view prof:emphasizePredicate ?empPred }
  }
  ${metaGraphFilter(contextGraphId)}
}
GROUP BY ?view ?name ?description ?nodeSize`;
}

function stripIri(value: unknown): string {
  const raw = bindingValue(value);
  if (!raw) return '';
  const s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  return s;
}

export function useProjectProfile(contextGraphId: string | undefined): ProjectProfile {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [displayName, setDisplayName] = useState<string>(DEFAULT_PROFILE_SEED.displayName);
  const [description, setDescription] = useState<string | undefined>();
  const [primaryColor, setPrimaryColor] = useState<string>(DEFAULT_PROFILE_SEED.primaryColor);
  const [accentColor, setAccentColor] = useState<string>(DEFAULT_PROFILE_SEED.accentColor);
  const [subGraphs, setSubGraphs] = useState<SubGraphBinding[]>([]);
  const [typeBindings, setTypeBindings] = useState<EntityTypeBinding[]>([]);
  const [views, setViews] = useState<ViewConfig[]>([]);
  const [filterChips, setFilterChips] = useState<FilterChip[]>([]);
  const [queryCatalogs, setQueryCatalogs] = useState<QueryCatalog[]>([]);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const typeIndexRef = useRef<Map<string, EntityTypeBinding>>(new Map());
  const subIndexRef = useRef<Map<string, SubGraphBinding>>(new Map());
  const viewIndexRef = useRef<Map<string, ViewConfig>>(new Map());
  const chipsBySgRef = useRef<Map<string, FilterChip[]>>(new Map());
  const queryCatalogsBySgRef = useRef<Map<string, QueryCatalog[]>>(new Map());
  const queriesBySgRef = useRef<Map<string, SavedQuery[]>>(new Map());
  const loadedContextGraphIdRef = useRef<string | undefined>();

  useEffect(() => {
    // Invalidate the prior snapshot before any asynchronous request starts.
    // Callback consumers also check the context tag below, so project A data
    // cannot be read during or after a failed project B load.
    loadedContextGraphIdRef.current = undefined;
    setDisplayName(contextGraphId ?? DEFAULT_PROFILE_SEED.displayName);
    setDescription(undefined);
    setPrimaryColor(DEFAULT_PROFILE_SEED.primaryColor);
    setAccentColor(DEFAULT_PROFILE_SEED.accentColor);
    setSubGraphs([]);
    setTypeBindings([]);
    setViews([]);
    setFilterChips([]);
    setQueryCatalogs([]);
    setSavedQueries([]);
    typeIndexRef.current = new Map();
    subIndexRef.current = new Map();
    viewIndexRef.current = new Map();
    chipsBySgRef.current = new Map();
    queryCatalogsBySgRef.current = new Map();
    queriesBySgRef.current = new Map();
    setError(undefined);

    if (!contextGraphId) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const [rootRows, sgRows, typeRows, viewRows, chipRows, queryCatalogOutcome] = await Promise.all([
          runProjectQuery(buildProfileRootQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildSubGraphBindingsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildTypeBindingsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildViewConfigsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildFilterChipsQuery(contextGraphId), contextGraphId).catch(() => []),
          // Query catalogs live in the local `.../meta/query-catalog` graph,
          // which is intentionally outside the scoped `/api/query` graph
          // allow-list. Use the dedicated profile endpoint so persisted
          // catalogs are not silently mistaken for an empty result.
          readProjectQueryCatalog(contextGraphId)
            .then(rows => ({ rows, error: undefined }))
            .catch((catalogError: unknown) => ({
              rows: [],
              error: catalogError instanceof Error ? catalogError.message : String(catalogError),
            })),
        ]);
        if (cancelled) return;

        // Reset root metadata to defaults before applying the new project's
        // profile row. Without this, switching to a project that has no
        // profile root (or a partial one) would leak the previous project's
        // display name / description / colors into the header.
        const defaultName = contextGraphId;
        if (rootRows[0]) {
          const r = rootRows[0];
          setDisplayName(stripLiteral(r.name) || defaultName);
          setDescription(stripLiteral(r.description) || undefined);
          setPrimaryColor(stripLiteral(r.primary) || DEFAULT_PROFILE_SEED.primaryColor);
          setAccentColor(stripLiteral(r.accent) || DEFAULT_PROFILE_SEED.accentColor);
        } else {
          setDisplayName(defaultName);
          setDescription(undefined);
          setPrimaryColor(DEFAULT_PROFILE_SEED.primaryColor);
          setAccentColor(DEFAULT_PROFILE_SEED.accentColor);
        }

        const sgs: SubGraphBinding[] = sgRows
          .map(row => ({
            slug: stripLiteral(row.slug),
            displayName: stripLiteral(row.displayName) || stripLiteral(row.slug),
            description: stripLiteral(row.description) || undefined,
            icon: stripLiteral(row.icon) || undefined,
            color: stripLiteral(row.color) || undefined,
            rank: parseInt10(row.rank) || 99,
            timelinePredicate: stripIri(row.timelinePredicate) || undefined,
            sourceAssertion: stripLiteral(row.sourceAssertion) || undefined,
          }))
          .filter(s => s.slug)
          .sort((a, b) => a.rank - b.rank);
        setSubGraphs(sgs);
        subIndexRef.current = new Map(sgs.map(s => [s.slug, s]));

        const tbs: EntityTypeBinding[] = typeRows
          .map(row => ({
            typeIri: stripIri(row.type),
            label: stripLiteral(row.label) || undefined,
            icon: stripLiteral(row.icon) || undefined,
            color: stripLiteral(row.color) || undefined,
            detailHint: stripLiteral(row.detailHint) || undefined,
            promoteLabel: stripLiteral(row.promoteLabel) || undefined,
            promoteHint:  stripLiteral(row.promoteHint)  || undefined,
            publishLabel: stripLiteral(row.publishLabel) || undefined,
            publishHint:  stripLiteral(row.publishHint)  || undefined,
          }))
          .filter(t => t.typeIri);
        setTypeBindings(tbs);
        typeIndexRef.current = new Map(tbs.map(t => [t.typeIri, t]));

        const vs: ViewConfig[] = viewRows.map(row => {
          const slugIri = stripIri(row.view);
          const slug = slugIri.split(':view:').pop() ?? slugIri;
          return {
            slug,
            name: stripLiteral(row.name) || slug,
            description: stripLiteral(row.description) || undefined,
            nodeSize: (stripLiteral(row.nodeSize) as 'degree' | 'uniform') || undefined,
            includeTypes: stripLiteral(row.includeTypes).split('|').map(s => stripIri(s.trim())).filter(Boolean),
            emphasizePredicates: stripLiteral(row.emphasizePredicates).split('|').map(s => stripIri(s.trim())).filter(Boolean),
          };
        });
        setViews(vs);
        viewIndexRef.current = new Map(vs.map(v => [v.slug, v]));

        const chips: FilterChip[] = chipRows
          .map(row => {
            const chipIri = stripIri(row.chip);
            const slug = chipIri.split(':chip:').pop() ?? chipIri;
            const values = stripLiteral(row.values)
              .split('|')
              .map(v => stripLiteral(v.trim()))
              .filter(Boolean);
            return {
              slug,
              subGraph: stripLiteral(row.subGraph),
              typeIri: stripIri(row.type),
              predicate: stripIri(row.predicate),
              label: stripLiteral(row.label) || 'Filter',
              values,
            };
          })
          .filter(c => c.subGraph && c.predicate && c.values.length > 0);
        setFilterChips(chips);
        const chipsBySg = new Map<string, FilterChip[]>();
        for (const c of chips) {
          const list = chipsBySg.get(c.subGraph) ?? [];
          list.push(c);
          chipsBySg.set(c.subGraph, list);
        }
        chipsBySgRef.current = chipsBySg;

        const queryCatalogState = buildQueryCatalogStateFromItems(queryCatalogOutcome.rows);
        setQueryCatalogs(queryCatalogState.queryCatalogs);
        setSavedQueries(queryCatalogState.savedQueries);
        queryCatalogsBySgRef.current = queryCatalogState.catalogsBySubGraph;
        queriesBySgRef.current = queryCatalogState.queriesBySubGraph;
        loadedContextGraphIdRef.current = contextGraphId;
        if (queryCatalogOutcome.error) setError(queryCatalogOutcome.error);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [contextGraphId]);

  const forSubGraph = useCallback(
    (slug: string) => {
      // S3 — Root bucket has a canonical synthesized binding. Short-
      // circuit before the daemon-bindings lookup so every consumer
      // (chip, detail header, breadcrumb, badge) reads the same
      // identity and the project header strip never displays the
      // raw sentinel as a breadcrumb label.
      if (slug === ROOT_SLUG_SENTINEL) return ROOT_SUBGRAPH_BINDING;
      if (loadedContextGraphIdRef.current !== contextGraphId) return DEFAULT_SUBGRAPH_FALLBACK(slug);
      return subIndexRef.current.get(slug) ?? DEFAULT_SUBGRAPH_FALLBACK(slug);
    },
    [contextGraphId],
  );
  const forType = useCallback(
    (typeIri: string) => loadedContextGraphIdRef.current === contextGraphId
      ? typeIndexRef.current.get(typeIri) ?? DEFAULT_TYPE_FALLBACK(typeIri)
      : DEFAULT_TYPE_FALLBACK(typeIri),
    [contextGraphId],
  );
  const view = useCallback(
    (slug: string) => loadedContextGraphIdRef.current === contextGraphId
      ? viewIndexRef.current.get(slug)
      : undefined,
    [contextGraphId],
  );
  const chipsFor = useCallback(
    (slug: string) => loadedContextGraphIdRef.current === contextGraphId
      ? chipsBySgRef.current.get(slug) ?? []
      : [],
    [contextGraphId],
  );
  const savedQueryCatalogsFor = useCallback(
    (slug: string) => loadedContextGraphIdRef.current === contextGraphId
      ? queryCatalogsBySgRef.current.get(slug) ?? []
      : [],
    [contextGraphId],
  );
  const savedQueriesFor = useCallback(
    (slug: string) => loadedContextGraphIdRef.current === contextGraphId
      ? queriesBySgRef.current.get(slug) ?? []
      : [],
    [contextGraphId],
  );

  return {
    contextGraphId: contextGraphId ?? '',
    displayName,
    description,
    primaryColor,
    accentColor,
    subGraphs,
    typeBindings,
    views,
    filterChips,
    queryCatalogs,
    savedQueries,
    loading,
    error,
    forSubGraph,
    forType,
    view,
    chipsFor,
    savedQueryCatalogsFor,
    savedQueriesFor,
  };
}

// ── Context for sharing a loaded profile across a tree ──────────────
export const ProjectProfileContext = React.createContext<ProjectProfile | null>(null);

export function useProjectProfileContext(): ProjectProfile | null {
  return useContext(ProjectProfileContext);
}
