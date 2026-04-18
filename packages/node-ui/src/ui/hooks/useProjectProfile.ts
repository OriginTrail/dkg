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
): Promise<Array<Record<string, string>>> {
  const r = await executeQuery(sparql, contextGraphId);
  return ((r?.result?.bindings as any[]) ?? []) as Array<Record<string, string>>;
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
}

export interface EntityTypeBinding {
  typeIri: string;
  label?: string;
  icon?: string;
  color?: string;
  detailHint?: string;
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
  name: string;
  description?: string;
  sparql: string;
  resultColumn: string;
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
  savedQueries: SavedQuery[];
  loading: boolean;
  error?: string;
  forSubGraph: (slug: string) => SubGraphBinding | undefined;
  forType: (typeIri: string) => EntityTypeBinding | undefined;
  view: (slug: string) => ViewConfig | undefined;
  chipsFor: (subGraphSlug: string) => FilterChip[];
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

function stripLiteral(value: string | undefined): string {
  if (!value) return '';
  const m = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]+>)?$/);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  return value;
}

function parseInt10(value: string | undefined): number {
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
SELECT ?slug ?displayName ?description ?icon ?color ?rank ?timelinePredicate
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

function buildSavedQueriesQuery(contextGraphId: string): string {
  return `PREFIX prof: <${PROFILE_NS}>
PREFIX schema: <http://schema.org/>
SELECT ?q ?subGraph ?name ?description ?sparql ?column
WHERE {
  GRAPH ?g {
    ?q a prof:SavedQuery ;
       prof:forSubGraph ?subGraph ;
       prof:sparqlQuery ?sparql .
    OPTIONAL { ?q prof:displayName ?name }
    OPTIONAL { ?q schema:description ?description }
    OPTIONAL { ?q prof:resultColumn ?column }
  }
  ${metaGraphFilter(contextGraphId)}
}`;
}

function buildTypeBindingsQuery(contextGraphId: string): string {
  return `PREFIX prof: <${PROFILE_NS}>
SELECT ?type ?label ?icon ?color ?detailHint
WHERE {
  GRAPH ?g {
    ?b a prof:EntityTypeBinding ;
       prof:forType ?type .
    OPTIONAL { ?b prof:label ?label }
    OPTIONAL { ?b prof:icon ?icon }
    OPTIONAL { ?b prof:color ?color }
    OPTIONAL { ?b prof:detailHint ?detailHint }
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

function stripIri(value: string | undefined): string {
  if (!value) return '';
  const s = value.trim();
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
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const typeIndexRef = useRef<Map<string, EntityTypeBinding>>(new Map());
  const subIndexRef = useRef<Map<string, SubGraphBinding>>(new Map());
  const viewIndexRef = useRef<Map<string, ViewConfig>>(new Map());
  const chipsBySgRef = useRef<Map<string, FilterChip[]>>(new Map());
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
        const [rootRows, sgRows, typeRows, viewRows, chipRows, queryRows] = await Promise.all([
          runProjectQuery(buildProfileRootQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildSubGraphBindingsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildTypeBindingsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildViewConfigsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildFilterChipsQuery(contextGraphId), contextGraphId).catch(() => []),
          runProjectQuery(buildSavedQueriesQuery(contextGraphId), contextGraphId).catch(() => []),
        ]);
        if (cancelled) return;

        if (rootRows[0]) {
          const r = rootRows[0];
          setDisplayName(stripLiteral(r.name) || contextGraphId);
          setDescription(stripLiteral(r.description) || undefined);
          setPrimaryColor(stripLiteral(r.primary) || DEFAULT_PROFILE_SEED.primaryColor);
          setAccentColor(stripLiteral(r.accent) || DEFAULT_PROFILE_SEED.accentColor);
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

        const queries: SavedQuery[] = queryRows
          .map(row => {
            const qIri = stripIri(row.q);
            const slug = qIri.split(':query:').pop() ?? qIri;
            return {
              slug,
              subGraph: stripLiteral(row.subGraph),
              name: stripLiteral(row.name) || slug,
              description: stripLiteral(row.description) || undefined,
              sparql: stripLiteral(row.sparql),
              resultColumn: stripLiteral(row.column) || '',
            };
          })
          .filter(q => q.subGraph && q.sparql);
        setSavedQueries(queries);
        const queriesBySg = new Map<string, SavedQuery[]>();
        for (const q of queries) {
          const list = queriesBySg.get(q.subGraph) ?? [];
          list.push(q);
          queriesBySg.set(q.subGraph, list);
        }
        queriesBySgRef.current = queriesBySg;
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
    savedQueries,
    loading,
    error,
    forSubGraph,
    forType,
    view,
    chipsFor,
    savedQueriesFor,
  };
}

// ── Context for sharing a loaded profile across a tree ──────────────
export const ProjectProfileContext = React.createContext<ProjectProfile | null>(null);

export function useProjectProfileContext(): ProjectProfile | null {
  return useContext(ProjectProfileContext);
}

