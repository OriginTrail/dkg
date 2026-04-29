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
import { executeQuery } from '../api.js';

async function runProjectQuery(
  sparql: string,
  contextGraphId: string,
): Promise<Array<Record<string, unknown>>> {
  const r = await executeQuery(sparql, contextGraphId);
  // Bindings can arrive as either bare strings (quadstore internal path)
  // or SPARQL-JSON objects like `{ value, type, datatype?, "xml:lang"? }`.
  // Preserve the raw shape here — `stripLiteral` / `stripIri` normalise
  // each cell via `bindingValue`, which handles both.
  return ((r?.result?.bindings as any[]) ?? []) as Array<Record<string, unknown>>;
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
   * Needed by the verify-on-DKG flow to promote a single entity WM -> SWM
   * (the promote API takes an assertion name, not just a URI).
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

function buildQueryCatalogsQuery(contextGraphId: string): string {
  return `PREFIX prof: <${PROFILE_NS}>
PREFIX schema: <http://schema.org/>
SELECT ?catalog ?subGraph ?name ?description ?rank
WHERE {
  GRAPH ?g {
    ?catalog a prof:QueryCatalog ;
             prof:forSubGraph ?subGraph .
    OPTIONAL { ?catalog prof:displayName ?name }
    OPTIONAL { ?catalog schema:description ?description }
    OPTIONAL { ?catalog prof:rank ?rank }
  }
  ${metaGraphFilter(contextGraphId)}
}`;
}

function buildSavedQueriesQuery(contextGraphId: string): string {
  return `PREFIX prof: <${PROFILE_NS}>
PREFIX schema: <http://schema.org/>
SELECT ?q ?subGraph ?catalog ?name ?description ?sparql ?column ?rank
WHERE {
  GRAPH ?g {
    ?q a prof:SavedQuery ;
       prof:forSubGraph ?subGraph ;
       prof:sparqlQuery ?sparql .
    OPTIONAL { ?q prof:inCatalog ?catalog }
    OPTIONAL { ?q prof:displayName ?name }
    OPTIONAL { ?q schema:description ?description }
    OPTIONAL { ?q prof:resultColumn ?column }
    OPTIONAL { ?q prof:rank ?rank }
  }
  ${metaGraphFilter(contextGraphId)}
}`;
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
  const catalogsByUri = new Map<string, QueryCatalog>();

  for (const row of catalogRows) {
    const catalogIri = stripIri(row.catalog);
    if (!catalogIri) continue;
    const slug = catalogIri.split(':catalog:').pop() ?? catalogIri;
    catalogsByUri.set(catalogIri, {
      slug,
      subGraph: stripLiteral(row.subGraph),
      name: stripLiteral(row.name) || slug,
      description: stripLiteral(row.description) || undefined,
      rank: parseInt10(row.rank) || 99,
      queries: [],
    });
  }

  const queries: SavedQuery[] = queryRows
    .map(row => {
      const qIri = stripIri(row.q);
      const slug = qIri.split(':query:').pop() ?? qIri;
      const subGraph = stripLiteral(row.subGraph);
      const catalogIri = stripIri(row.catalog);
      const catalog = catalogIri ? catalogsByUri.get(catalogIri) : undefined;
      const implicitCatalogSlug = `default:${subGraph}`;
      return {
        slug,
        subGraph,
        catalogSlug: catalog?.slug ?? implicitCatalogSlug,
        catalogName: catalog?.name ?? 'Queries',
        catalogDescription: catalog?.description,
        catalogRank: catalog?.rank ?? 999,
        name: stripLiteral(row.name) || slug,
        description: stripLiteral(row.description) || undefined,
        sparql: stripLiteral(row.sparql),
        resultColumn: stripLiteral(row.column) || '',
        rank: parseInt10(row.rank) || 99,
      };
    })
    .filter(q => q.subGraph && q.sparql)
    .sort((a, b) =>
      a.subGraph.localeCompare(b.subGraph)
      || a.catalogRank - b.catalogRank
      || a.catalogName.localeCompare(b.catalogName)
      || a.rank - b.rank
      || a.name.localeCompare(b.name),
    );

  const catalogsByComposite = new Map<string, QueryCatalog>();
  for (const catalog of catalogsByUri.values()) {
    catalogsByComposite.set(`${catalog.subGraph}|${catalog.slug}`, { ...catalog, queries: [] });
  }

  for (const query of queries) {
    const key = `${query.subGraph}|${query.catalogSlug}`;
    const existing = catalogsByComposite.get(key);
    if (existing) {
      existing.queries.push(query);
      continue;
    }
    catalogsByComposite.set(key, {
      slug: query.catalogSlug,
      subGraph: query.subGraph,
      name: query.catalogName,
      description: query.catalogDescription,
      rank: query.catalogRank,
      queries: [query],
    });
  }

  const queryCatalogs = Array.from(catalogsByComposite.values())
    .filter(catalog => catalog.queries.length > 0)
    .map(catalog => ({
      ...catalog,
      queries: [...catalog.queries].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) =>
      a.subGraph.localeCompare(b.subGraph)
      || a.rank - b.rank
      || a.name.localeCompare(b.name),
    );

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

  useEffect(() => {
    if (!contextGraphId) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(undefined);
      try {
        const [rootRows, sgRows, typeRows, viewRows, chipRows, catalogRows, queryRows] = await Promise.all([
          runProjectQuery(buildProfileRootQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildSubGraphBindingsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildTypeBindingsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildViewConfigsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildFilterChipsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildQueryCatalogsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildSavedQueriesQuery(contextGraphId), contextGraphId).catch(() => []),
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

        const queryCatalogState = buildQueryCatalogState(catalogRows, queryRows);
        setQueryCatalogs(queryCatalogState.queryCatalogs);
        setSavedQueries(queryCatalogState.savedQueries);
        queryCatalogsBySgRef.current = queryCatalogState.catalogsBySubGraph;
        queriesBySgRef.current = queryCatalogState.queriesBySubGraph;
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [contextGraphId]);

  const forSubGraph = useCallback(
    (slug: string) => subIndexRef.current.get(slug) ?? DEFAULT_SUBGRAPH_FALLBACK(slug),
    [],
  );
  const forType = useCallback(
    (typeIri: string) => typeIndexRef.current.get(typeIri) ?? DEFAULT_TYPE_FALLBACK(typeIri),
    [],
  );
  const view = useCallback(
    (slug: string) => viewIndexRef.current.get(slug),
    [],
  );
  const chipsFor = useCallback(
    (slug: string) => chipsBySgRef.current.get(slug) ?? [],
    [],
  );
  const savedQueryCatalogsFor = useCallback(
    (slug: string) => queryCatalogsBySgRef.current.get(slug) ?? [],
    [],
  );
  const savedQueriesFor = useCallback(
    (slug: string) => queriesBySgRef.current.get(slug) ?? [],
    [],
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
