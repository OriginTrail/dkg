import { postQueryDeduped } from '../api.js';
import { UI_READ_MAX_AGE_MS } from '../lib/read-cache.js';
import { decodeRdfStringLiteral } from '../../rdf-literal.js';
import { sparqlIri } from '@origintrail-official/dkg-core/sparql-safe';
import type { Triple, LayeredTriple, MemoryLayerKey } from './useMemoryEntities.js';

const PROFILE_QUERY_CATALOG = 'http://dkg.io/ontology/profile/QueryCatalog';

function bv(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as any)) return String((v as any).value);
  return String(v);
}

export function rdfBindingValue(term: unknown): string | undefined {
  if (!term || typeof term !== 'object') return bv(term);
  const binding = term as { type?: string; value?: string; datatype?: string; 'xml:lang'?: string };
  if (binding.type === 'bnode') return `_:${String(binding.value).replace(/^_:/, '')}`;
  if (binding.type === 'literal' || binding.type === 'typed-literal') {
    const text = JSON.stringify(binding.value ?? '');
    if (binding['xml:lang']) return `${text}@${binding['xml:lang']}`;
    if (binding.datatype) return `${text}^^<${binding.datatype}>`;
    return text;
  }
  return bv(term);
}

export function isUri(s: string): boolean {
  const value = canonicalEntityUri(s);
  if (!value || value.startsWith('"') || /\s/.test(value)) return false;
  if (value.startsWith('_:')) return true;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

// Exported so consumers that look entities up directly (e.g.
// useLayerTriples' residue filter) can canonicalise raw triple
// subjects the same way `buildEntities` does — daemon results
// sometimes ship wrapped (`<urn:...>`) URIs and a raw lookup
// would miss the entity record.
export function canonicalEntityUri(uri: string): string {
  const trimmed = uri.trim();
  if (trimmed.startsWith('"')) return trimmed;
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
}

export const WM_LIMIT = 5_000;
const SWM_LIMIT = 5_000;
const VM_LIMIT = 5_000;

export function queryCatalogLayerSparql(cgId: string, layer: 'wm' | 'swm'): string {
  const cgUri = `did:dkg:context-graph:${cgId}`;
  // Replicas receive the catalog snapshot and its SWM-head metadata, but the
  // sync protocol intentionally does not copy every author-local lifecycle
  // predicate (notably dkg:assertionGraph). Classify the catalog by its
  // canonical layer graph instead, and require prof:QueryCatalog in that same
  // graph so opting in cannot expose unrelated profile/meta entities.
  const graphFilter = layer === 'wm'
    ? `(
        STRSTARTS(STR(?g), "${cgUri}/meta/assertion/") ||
        STRSTARTS(STR(?g), "${cgUri}/meta/_working_memory/")
      )`
    : `STRSTARTS(STR(?g), "${cgUri}/meta/_shared_memory/")`;
  return `SELECT ?s ?p ?o ?g WHERE {
    GRAPH ?g {
      ?catalog a <${PROFILE_QUERY_CATALOG}> .
      ?s ?p ?o
    }
    FILTER(${graphFilter})
  } LIMIT ${SWM_LIMIT}`;
}

export function wmSparql(cgId: string) {
  const cgUri = `did:dkg:context-graph:${cgId}`;
  // WM = every per-agent assertion under the project, regardless of
  // sub-graph. We match any graph whose path contains `/assertion/`.
  //
  // PR #818 Codex sweep 3 (ux-lead Finding 1 verdict) — exclude the
  // `meta` namespace. Profile artifacts (prof:Profile,
  // prof:SubGraphBinding, prof:FilterChip, prof:QueryCatalog,
  // prof:SavedQuery) are published as assertions under
  // `<cg>/meta/assertion/<addr>/<name>`, so the pre-fix
  // `CONTAINS(/assertion/)` filter scooped them into `memory.entityList`
  // alongside real user knowledge. Those entities are UI configuration,
  // not user knowledge — they have their own surfaces via
  // `useProjectProfile` (which queries the meta graphs directly via
  // its own SPARQL, not via this hook). Mirrors the meta-exclusion
  // policy that `vmSparql` already enforces (`:262-269`); GH #806's
  // `subGraphOf` `meta` filter handles the chip-row side and this
  // upstream filter handles the entity-list side — same family.
  return `SELECT ?s ?p ?o ?g WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}/") &&
      (CONTAINS(STR(?g), "/assertion/") || CONTAINS(STR(?g), "/_working_memory/")) &&
      STR(?g) != "${cgUri}/meta" &&
      !CONTAINS(STR(?g), "/meta/") &&
      !STRENDS(STR(?g), "/_meta")
    )
  } LIMIT ${WM_LIMIT}`;
}

export function swmSparql(cgId: string) {
  const cgUri = `did:dkg:context-graph:${cgId}`;
  // Any graph whose tail ends in `_shared_memory` (excluding the sibling
  // `_shared_memory_meta` bookkeeping graphs which carry lifecycle
  // provenance rather than user data).
  //
  // PR #818 Codex sweep 3 (ux-lead Finding 1 verdict) — exclude
  // `<cg>/meta/_shared_memory` so SWM-promoted profile artifacts don't
  // surface in the user-facing entityList. Mirrors `vmSparql`'s
  // existing meta-exclusion policy (`:262-269`). Without this,
  // `STRENDS(/_shared_memory)` admits `<cg>/meta/_shared_memory` —
  // a profile-namespace graph — and the entity becomes a "root SWM
  // entity" in every consumer downstream.
  return `SELECT ?s ?p ?o ?g WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}") &&
      (STRENDS(STR(?g), "/_shared_memory") || CONTAINS(STR(?g), "/_shared_memory/")) &&
      STR(?g) != "${cgUri}/meta/_shared_memory" &&
      !CONTAINS(STR(?g), "/meta/") &&
      !CONTAINS(STR(?g), "/_shared_memory/staging/") &&
      ?p != <http://dkg.io/ontology/workspaceOwner>
    )
  } LIMIT ${SWM_LIMIT}`;
}

export function vmSparql(cgId: string) {
  const cgUri = `did:dkg:context-graph:${cgId}`;
  // VM covers three named-graph shapes:
  //   • Root content graph       `<cgUri>`        — finalised VM
  //   • Per-sub-graph data graph `<cgUri>/<sg>`   — post-publish VM view
  //   • Per-sub-graph VM bucket  `<cgUri>/<sg>/_verifiable_memory(/*)`
  // We exclude:
  //   • `_shared_memory*`        — belongs to SWM
  //   • `assertion/*`            — belongs to WM
  //   • `_meta`, `/meta`, `/meta/*`, `_private`, `_rules`, any `_verifiable_memory_meta`
  //     — bookkeeping graphs, not user data.
  return `SELECT ?s ?p ?o ?g WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}") &&
      !CONTAINS(STR(?g), "/assertion/") &&
      !CONTAINS(STR(?g), "/_working_memory") &&
      !CONTAINS(STR(?g), "/_shared_memory") &&
      !CONTAINS(STR(?g), "_verifiable_memory_meta") &&
      !STRENDS(STR(?g), "/_meta") &&
      STR(?g) != "${cgUri}/meta" &&
      !CONTAINS(STR(?g), "/meta/") &&
      !CONTAINS(STR(?g), "/_private") &&
      !CONTAINS(STR(?g), "/_rules")
    )
  } LIMIT ${VM_LIMIT}`;
}

/**
 * Extract the sub-graph slug from a named-graph URI of the shape
 *   did:dkg:context-graph:<cg>/<subGraph>(/...)?
 * Returns undefined for graph URIs outside the expected project scope
 * (e.g. _meta, _shared_memory) so those triples stay un-bucketed.
 */
export function subGraphOf(gUri: string, cgId: string): string | undefined {
  const prefix = `did:dkg:context-graph:${cgId}/`;
  if (!gUri.startsWith(prefix)) return undefined;
  const tail = gUri.slice(prefix.length);
  const slash = tail.indexOf('/');
  const seg = slash >= 0 ? tail.slice(0, slash) : tail;
  // `assertion` is the WM assertion-graph segment
  // (`<cg>/assertion/<addr>/<name>`), not a user-facing sub-graph; leaking
  // it as a slug surfaces a phantom "Assertion" sub-graph chip on entity
  // detail pages. `meta` is the profile / bookkeeping graph
  // (`<cg>/meta/_shared_memory`); it's filtered downstream by
  // `RESERVED_SUB_GRAPH_SLUGS` so it never gets a chip, but pre-filter
  // it here too so entities with ONLY a `meta` membership don't end up
  // with `subGraphs = Set{'meta'}` — that produced the GH #806 SWM
  // layer-mode gap where `All N · Root M` disagreed by the count of
  // such entities. Filter alongside underscore-prefixed bookkeeping
  // segments so `entity.subGraphs` stays semantically pure.
  if (!seg || seg.startsWith('_') || seg === 'assertion' || seg === 'meta') return undefined;
  return seg;
}

type MemoryGraphCursor = [string, string, string, string, string, string, string, boolean?];
export interface LayerResult { triples: Triple[]; ok: boolean; truncated: boolean; rowCount: number; cursor?: MemoryGraphCursor }

interface QueryLayerOptions {
  view?: string;
  includeSharedMemory?: boolean;
  graphSuffix?: string;
  includeContextGraphPartitions?: boolean;
  /** Local-only result limit used to detect lower-bound totals; never sent to /api/query. */
  layerLimit?: number;
  cursor?: MemoryGraphCursor;
  /** Resource lookups already bind a term and do not need graph inventory paging. */
  direct?: boolean;
}

function cursorForRow(row: Record<string, unknown>): MemoryGraphCursor {
  const subject = canonicalEntityUri(rdfBindingValue(row.s) ?? '');
  const object = rdfBindingValue(row.o) ?? '';
  const literal = object.match(/^"([\s\S]*)"(?:@([A-Za-z0-9-]+)|\^\^<([^>]+)>)?$/);
  const language = literal?.[2]?.toLowerCase() ?? '';
  const kind = object.startsWith('_:') ? 'B' : literal || !isUri(object) ? 'L' : 'I';
  return [canonicalEntityUri(bv(row.g) ?? ''), (subject.startsWith('_:') ? 'B:' + subject.slice(2) : 'I:' + subject),
    canonicalEntityUri(bv(row.p) ?? ''), kind,
    kind === 'L' ? decodeRdfStringLiteral(object) : kind === 'B' ? object.slice(2) : canonicalEntityUri(object),
    language, kind === 'L' ? literal?.[3] ?? (language
      ? 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString' : 'http://www.w3.org/2001/XMLSchema#string') : ''];
}

const CURSOR_VARIABLES = ['?__g', '?__s', '?__p', '?__kind', '?__o', '?__lang', '?__datatype'];
function cursorFilter(cursor: MemoryGraphCursor): string {
  return `FILTER(${CURSOR_VARIABLES.map((variable, index) => {
    const equal = CURSOR_VARIABLES.slice(0, index).map((prior, i) => `${prior} = ${JSON.stringify(cursor[i])}`);
    return `(${[...equal, `${variable} > ${JSON.stringify(cursor[index])}`].join(' && ')})`;
  }).join(' || ')})`;
}

export async function readMemoryGraphPage(
  sparql: string,
  contextGraphId: string,
  opts?: QueryLayerOptions,
): Promise<LayerResult> {
  // Never throws and never loses the failed-vs-empty distinction: it
  // returns `{ triples, ok, truncated }`. A failed/unreachable `/api/query` yields
  // `{ triples: [], ok: false }` so triple data still degrades to
  // "empty" for every consumer (unchanged behavior), while `ok=false`
  // lets the hook compute `partial` UNCONDITIONALLY — previously it was
  // dead for non-opt-in callers, making truncated counts look exact
  // (Codex). Whether a total failure escalates to a hard `error` stays
  // the configurable part (see `signalErrors`).
  try {
    // Routed through `postQueryDeduped` so the 3-way WM/SWM/VM fan-out
    // here coalesces with any other concurrently-mounted instance of
    // this hook (e.g. Dashboard card + ProjectView both subscribed to
    // the same CG). One underlying fetch instead of N for each layer.
    const { layerLimit = WM_LIMIT, cursor, direct = false, ...requestOpts } = opts ?? {};
    const ordered = sparql.replace(/\s+LIMIT\s+\d+\s*$/i, '');
    let graphValues = '';
    let graphNames: string[] = [];
    let moreGraphs = false;
    if (!direct) {
      // Discover a small graph page through existence probes, not a sorted
      // walk over all source triples. Only these graphs feed the data read.
      const predicateFilter = ordered.match(/&&\s*(\?p\s*!=\s*<[^>]+>)/)?.[1];
      const inventory = ordered.replace(/SELECT\s+\?s\s+\?p\s+\?o\s+\?g/i, 'SELECT DISTINCT ?g')
        .replace(/&&\s*\?p\s*!=\s*<[^>]+>/g, '')
        .replace(/\?s\s+\?p\s+\?o\b/g, `FILTER EXISTS { ?s ?p ?o ${predicateFilter ? `FILTER(${predicateFilter})` : ''} }`)
        .replace(/}\s*$/, `${cursor ? `FILTER(STR(?g) ${cursor[7] ? '>' : '>='} ${JSON.stringify(cursor[0])})` : ''} }`);
      const catalog = await postQueryDeduped({ sparql: `${inventory} ORDER BY STR(?g) LIMIT 6`, contextGraphId, ...requestOpts }, { maxAgeMs: UI_READ_MAX_AGE_MS });
      const names = [...new Set((catalog.result?.bindings ?? []).map(row => canonicalEntityUri(bv(row.g) ?? '')).filter(Boolean))];
      graphNames = names.slice(0, 5);
      moreGraphs = names.length > 5;
      if (!graphNames.length) return { triples: [], ok: true, truncated: false, rowCount: 0 };
      graphValues = `VALUES ?g { ${graphNames.map(sparqlIri).join(' ')} }`;
    }
    // Compare the complete RDF term identity. STR(?o) alone would skip values
    // sharing lexical text but differing in language, datatype or node kind.
    const seek = ordered.replace(/WHERE\s*{/i, `WHERE { ${graphValues}`).replace(/}\s*$/, `
      BIND(STR(?g) AS ?__g)
      BIND(CONCAT(IF(isBlank(?s), "B:", "I:"), STR(?s)) AS ?__s)
      BIND(STR(?p) AS ?__p)
      BIND(IF(isBlank(?o), "B", IF(isIRI(?o), "I", "L")) AS ?__kind)
      BIND(STR(?o) AS ?__o)
      BIND(IF(isLiteral(?o), LANG(?o), "") AS ?__lang)
      BIND(IF(isLiteral(?o), STR(DATATYPE(?o)), "") AS ?__datatype)
      ${cursor ? cursorFilter(cursor) : ''}
    }`);
    const body = { sparql: `${seek} ORDER BY ${CURSOR_VARIABLES.join(' ')} LIMIT ${layerLimit}`, contextGraphId, ...requestOpts };
    const data = await postQueryDeduped(body, { maxAgeMs: UI_READ_MAX_AGE_MS });
    const bindings = data?.result?.bindings ?? [];
    const clipped = bindings.length >= layerLimit;
    const truncated = clipped || moreGraphs;
    const triples = bindings
      .map((row: any) => {
        const g = bv(row.g);
        return {
          subject: rdfBindingValue(row.s) ?? '',
          predicate: bv(row.p) ?? '',
          object: rdfBindingValue(row.o) ?? '',
          subGraph: g ? subGraphOf(g, contextGraphId) : undefined,
        };
      })
      .filter((t: Triple) => t.subject && t.predicate && t.object);
    return { triples, ok: true, truncated, rowCount: bindings.length,
      cursor: !clipped && graphNames.length ? [graphNames.at(-1)!, '', '', '', '', '', '', true]
        : bindings.length ? cursorForRow(bindings.at(-1)!) : undefined };
  } catch {
    return { triples: [], ok: false, truncated: false, rowCount: 0 };
  }
}

/** Read a clicked resource directly, even when its facts fall outside the loaded graph pages. */
export async function fetchMemoryEntity(
  contextGraphId: string,
  uri: string,
  layer?: MemoryLayerKey,
  includeQueryCatalog = false,
): Promise<{ triples: LayeredTriple[]; partial: boolean }> {
  const target = canonicalEntityUri(uri);
  const match = target.startsWith('_:')
    ? `((isBlank(?s) && STR(?s) = ${JSON.stringify(target.slice(2))}) || (isBlank(?o) && STR(?o) = ${JSON.stringify(target.slice(2))}))`
    : `(?s = ${sparqlIri(target)} || ?o = ${sparqlIri(target)})`;
  const definitions = [
    { key: 'wm', sparql: wmSparql(contextGraphId), layer: 'working' as const },
    { key: 'swm', sparql: swmSparql(contextGraphId), layer: 'shared' as const },
    { key: 'vm', sparql: vmSparql(contextGraphId), layer: 'verified' as const },
    ...(includeQueryCatalog ? [
      { key: 'wm', sparql: queryCatalogLayerSparql(contextGraphId, 'wm'), layer: 'working' as const },
      { key: 'swm', sparql: queryCatalogLayerSparql(contextGraphId, 'swm'), layer: 'shared' as const },
    ] : []),
  ].filter(definition => !layer || definition.key === layer);
  const results = await Promise.all(definitions.map(definition => readMemoryGraphPage(
    definition.sparql.replace(/}\s+LIMIT\s+\d+\s*$/i, `FILTER(${match}) }`),
    contextGraphId, { includeContextGraphPartitions: true, layerLimit: 1_000, direct: true },
  )));
  if (results.some(result => !result.ok)) throw new Error('Could not load all resource details. Retry to refresh this resource.');
  return {
    triples: results.flatMap((result, index) => result.triples.map(triple => ({ ...triple, layer: definitions[index].layer }))),
    partial: results.some(result => result.truncated),
  };
}
