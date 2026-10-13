import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { postQueryDeduped, invalidateQueryCache } from '../api.js';
import { UI_READ_MAX_AGE_MS } from '../lib/read-cache.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';
import { MEMORY_LABEL_PREDICATES } from '../lib/memoryLabels.js';
import { decodeRdfStringLiteral } from '../../rdf-literal.js';
import { sparqlIri } from '@origintrail-official/dkg-core/sparql-safe';

export type TrustLevel = 'working' | 'shared' | 'verified';
export type MemoryLayerKey = 'wm' | 'swm' | 'vm';
export type MemoryLayerStatus = 'loading' | 'ok' | 'error';

export interface MemoryEntity {
  uri: string;
  label: string;
  types: string[];
  trustLevel: TrustLevel;
  layers: Set<TrustLevel>;
  /** All sub-graph slugs this entity has triples in (usually one). */
  subGraphs: Set<string>;
  properties: Map<string, string[]>;
  connections: Array<{ predicate: string; targetUri: string; targetLabel: string }>;
  /**
   * Number of *distinct* (subject, predicate, object) triples in
   * this entity's CANONICAL layer (`trustLevel`) that reference
   * the entity as subject or object — matches the row count the
   * entity-detail Triples tab shows on the layer page where the
   * entity lives (which filters by layer via `useLayerTriples`
   * and SPO-dedupes via `dedupeTriplesBySpo`, see `ProjectView.tsx`).
   *
   * Drives the entity-row badge and is the sort key for entity
   * lists. Promoted-entity WM residue does NOT inflate this — a
   * promoted SWM entity with leftover WM-only draft triples shows
   * only the SWM-layer count (matching the SWM tab the user opens).
   *
   * NOT used by the KADetailView header / sidebar / footer — those
   * derive directly from `entityTriples.length` so they always
   * mirror whichever scope the user opened the detail page from
   * (layer-page = layer-filtered + deduped, overview = raw).
   *
   * Optional because non-`buildEntities` callers (synthetic stubs
   * in `useProjectActivity`, test fixtures) construct `MemoryEntity`
   * literals without it. `buildEntities` always populates it;
   * consumers should fall back to `0` for stubs.
   *
   * PER-ENTITY METRIC ONLY. An IRI-object triple `(A, p, B)` bumps
   * BOTH `A.tripleCount` and `B.tripleCount`, so
   * `sum(e.tripleCount)` across a layer is NOT the layer's triple
   * total. Layer totals belong to `mem.allTriples.length`
   * (DashboardView); CG/sub-graph totals to the daemon's
   * `/api/sub-graph/list` `tripleCount` (SubGraphBar).
   */
  tripleCount?: number;
}

export interface Triple {
  subject: string;
  predicate: string;
  object: string;
  /** Sub-graph slug this triple was sourced from, if known (WM triples only). */
  subGraph?: string;
}

export interface LayeredTriple extends Triple {
  layer: TrustLevel;
}

export interface MemoryData {
  entities: Map<string, MemoryEntity>;
  entityList: MemoryEntity[];
  allTriples: LayeredTriple[];
  graphTriples: Triple[];
  trustMap: Map<string, TrustLevel>;
  counts: { wm: number; swm: number; vm: number; total: number };
  loading: boolean;
  error: string | null;
  /** True when counts are lower bounds because a layer failed or clipped at its query limit. */
  partial: boolean;
  /** Per-layer query status so UI can distinguish a VM miss from WM/SWM failures. */
  layerStatus: Record<MemoryLayerKey, MemoryLayerStatus>;
  refresh: () => void;
  hasMore?: boolean;
  loadMore?: () => void;
  pageError?: string | null;
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
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

function isUri(s: string): boolean {
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

function shortLabel(uri: string): string {
  if (!uri) return '—';
  if (uri.startsWith('"')) return decodeRdfStringLiteral(uri);
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  if (cut >= 0) return uri.slice(cut + 1);
  return uri;
}

function shortPredicate(uri: string): string {
  const s = shortLabel(uri);
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

export function uriTail(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const colon = uri.lastIndexOf(':');
  const cut = Math.max(hash, slash, colon);
  const raw = cut >= 0 ? uri.slice(cut + 1) : uri;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function readableTail(uri: string): string {
  const tail = uriTail(uri).trim();
  if (!tail) return '';
  const shortened = /^[0-9a-f-]{16,}$/i.test(tail) ? tail.replace(/-/g, '').slice(0, 12) : tail;
  return shortened.replace(/[_-]+/g, ' ').trim();
}

function isRawExtractionLabel(label: string, uri: string): boolean {
  return label === uri && /^urn:dkg:extraction:[^\s]+$/i.test(uri);
}

function isUnreadableDefaultUriLabel(label: string, uri: string): boolean {
  // Use the same absolute-IRI check the rest of the surface uses — any
  // `scheme:` URI (ipfs://, mailto:, ftp://, …) is treated the same way
  // graph-model and the singleton-shelf treat it. Without this the helper
  // missed schemes outside the original http/https/urn/did allowlist and
  // left them with raw-URI labels in lists / details.
  return label === uri && isUri(uri);
}

function readableFallbackLabel(entity: MemoryEntity): string {
  const tail = readableTail(entity.uri);
  const type = entity.types
    .map(shortLabel)
    .find(t => t && t !== 'Thing' && t !== 'Entity');
  if (/^urn:dkg:extraction:[^\s]+$/i.test(entity.uri)) {
    return tail ? `Extraction ${tail}` : 'Extraction';
  }
  if (type) return tail && tail !== type ? `${type} ${tail}` : type;
  return tail || shortLabel(entity.uri);
}

function deriveEntityLabel(entity: MemoryEntity): string {
  for (const pred of MEMORY_LABEL_PREDICATES) {
    const vals = entity.properties.get(pred);
    const name = vals?.find(v => v.trim().length > 0);
    if (name) return name;
  }

  // Unlabelled Programs often end in the same version token (e.g. :v1).
  // Keep their complete identity visible instead of collapsing them to "Program v1".
  if (entity.types.includes('https://origintrail.io/semantic-runtime/v1#Program')) return entity.uri;

  const defaultUriLabel = shortLabel(entity.uri);
  if (
    entity.label &&
    (entity.label !== defaultUriLabel || !isUnreadableDefaultUriLabel(entity.label, entity.uri)) &&
    !isRawExtractionLabel(entity.label, entity.uri)
  ) {
    return entity.label;
  }

  return readableFallbackLabel(entity);
}

// All three layer queries walk the named-graph space directly with a
// FILTER on the graph URI, rather than going through the daemon's
// built-in `view` helpers. Two wins from this:
//   1. Coverage of per-sub-graph SWM/VM partitions (the built-in views
//      only resolve to top-level graphs).
//   2. `?g` projection — every triple comes back tagged with its
//      source graph so we can assign the sub-graph slug, which drives
//      SubGraphBar filtering and the Graph Overview grid across all
//      three layers.
//
// The V10 named-graph layout we rely on (see `resolveViewGraphs`
// in `@origintrail-official/dkg-query` and named KA lifecycle publish):
//
//   WM  (drafts)    : did:dkg:context-graph:<cg>/<sg>/assertion/<addr>/<name>
//   SWM (proposed)  : did:dkg:context-graph:<cg>/<sg>/_shared_memory
//                     did:dkg:context-graph:<cg>/_shared_memory     (default)
//   VM  (committed) : did:dkg:context-graph:<cg>/<sg>              (per-sg)
//                     did:dkg:context-graph:<cg>                   (root)
//                     did:dkg:context-graph:<cg>/_verifiable_memory/*
//
// Key insight: in V10 the plain `<cg>/<sg>` graph IS the committed
// (chain-attested) view of a sub-graph — that's where
// publishing to VM (`POST /api/knowledge-assets/:name/vm/publish`) deposits
// KAs after on-chain registration.
// We treat it as VM, not WM. Pre-publish writes only exist in
// `assertion/<addr>/<name>` graphs.
//
// Bounded pages replace a silent result cutoff. Counts remain lower bounds
// until the user has loaded every page and all requested layers succeeded.
const WM_LIMIT = 5_000;
const SWM_LIMIT = 5_000;
const VM_LIMIT = 5_000;

function queryCatalogLayerSparql(cgId: string, layer: 'wm' | 'swm'): string {
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

function wmSparql(cgId: string) {
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

function swmSparql(cgId: string) {
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

function vmSparql(cgId: string) {
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
interface LayerResult { triples: Triple[]; ok: boolean; truncated: boolean; rowCount: number; cursor?: MemoryGraphCursor }

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

const LOADING_LAYER_STATUS: Record<MemoryLayerKey, MemoryLayerStatus> = {
  wm: 'loading',
  swm: 'loading',
  vm: 'loading',
};

const ERROR_LAYER_STATUS: Record<MemoryLayerKey, MemoryLayerStatus> = {
  wm: 'error',
  swm: 'error',
  vm: 'error',
};

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

export function buildEntities(layered: LayeredTriple[]): Map<string, MemoryEntity> {
  const entities = new Map<string, MemoryEntity>();
  const connectionKeys = new Map<string, Set<string>>();
  // Per-(entity) property dedup keyed on the RAW triple object — NOT the
  // decoded display value. Two literals that share a lexical form but differ in
  // language/datatype (`"hello"@en` vs `"hello"@fr`, `"1"^^xsd:int` vs
  // `"1"^^xsd:string`) decode to the same string, so deduping on the decoded
  // value would silently drop a distinct RDF value (Codex). We display the
  // decoded value but preserve distinctness on the raw form.
  const propertyKeys = new Map<string, Set<string>>();
  // Per-(entity, layer) SPO-dedup keys for `tripleCount`. Mirrors
  // `useLayerTriples` + `dedupeTriplesBySpo` (`ProjectView.tsx`) so
  // the precomputed count agrees with the layer-page Triples tab.
  // Per-layer because a triple residing in two named graphs of the
  // SAME layer (e.g. `<cg>/_shared_memory` and
  // `<cg>/<sg>/_shared_memory` both at the SWM layer) must dedupe,
  // while a triple residing in DIFFERENT layers (WM residue + SWM
  // current for a promoted entity) is a distinct row on each
  // layer's tab and so contributes to each layer's count.
  const tripleSeen = new Map<string, Map<TrustLevel, Set<string>>>();
  const tripleCountByLayer = new Map<string, Record<TrustLevel, number>>();
  function bumpTriple(entityUri: string, layer: TrustLevel, key: string): boolean {
    let layerMap = tripleSeen.get(entityUri);
    if (!layerMap) {
      layerMap = new Map();
      tripleSeen.set(entityUri, layerMap);
    }
    let seen = layerMap.get(layer);
    if (!seen) {
      seen = new Set<string>();
      layerMap.set(layer, seen);
    }
    if (seen.has(key)) return false;
    seen.add(key);
    let counts = tripleCountByLayer.get(entityUri);
    if (!counts) {
      counts = { working: 0, shared: 0, verified: 0 };
      tripleCountByLayer.set(entityUri, counts);
    }
    counts[layer]++;
    return true;
  }
  function getOrCreate(uri: string): MemoryEntity {
    const entityUri = canonicalEntityUri(uri);
    let e = entities.get(entityUri);
    if (!e) {
      e = {
        uri: entityUri,
        label: shortLabel(entityUri),
        types: [],
        trustLevel: 'working',
        layers: new Set(),
        subGraphs: new Set(),
        properties: new Map(),
        connections: [],
        tripleCount: 0, // finalised to canonical-layer count post-loop
      };
      entities.set(entityUri, e);
    }
    return e;
  }

  // PASS 1 — populate entities, types, connections, properties, layers.
  // Triple counts are intentionally NOT bumped here: they need to be
  // gated by the same residue filter `useLayerTriples` applies (subject
  // and object trustLevel must equal the layer), and trustLevels are
  // only known after this pass. Pass 3 below redoes the walk with
  // residue-filter-aware counting.
  for (const t of layered) {
    const entity = getOrCreate(t.subject);
    entity.layers.add(t.layer);
    if (t.subGraph) entity.subGraphs.add(t.subGraph);

    if (t.predicate === RDF_TYPE) {
      const typeUri = canonicalEntityUri(t.object);
      if (!entity.types.includes(typeUri)) {
        entity.types.push(typeUri);
      }
      // Class targets (e.g. `urn:type:ObjectEvent`) are NOT created via
      // getOrCreate here — that would inject schema URIs like
      // `schema:Thing` into the entity map with `trustLevel = 'working'`
      // (no layers), breaking `useLayerTriples`' residue filter
      // (`helpers.ts:444-448`: `objectEntity.trustLevel !== targetLayer`
      // ⇒ drops the rdf:type row from SWM/VM views). Pass 3 bumps
      // class-entity counts only for classes that already exist by
      // virtue of their own triples — matches Codex's "if the type
      // node has its own triples" condition.
    } else if (isUri(t.object)) {
      const targetUri = canonicalEntityUri(t.object);
      const targetEntity = getOrCreate(targetUri);
      targetEntity.layers.add(t.layer);
      if (t.subGraph) targetEntity.subGraphs.add(t.subGraph);
      const keys = connectionKeys.get(entity.uri) ?? new Set<string>();
      const connectionKey = `${t.predicate}\0${targetUri}`;
      if (!keys.has(connectionKey)) {
        keys.add(connectionKey);
        connectionKeys.set(entity.uri, keys);
        entity.connections.push({
          predicate: t.predicate,
          targetUri,
          targetLabel: shortLabel(targetUri),
        });
      }
    } else {
      // Dedupe on the RAW term, not the decoded display string. This is a
      // deliberate data-integrity choice that has flip-flopped in review:
      //   • `"1"^^xsd:integer` vs `"1"^^xsd:string`, and `"x"@en` vs `"x"@fr`,
      //     are DISTINCT RDF values. Keying dedup on the decoded form collapses
      //     them and silently drops a real value — strictly worse than showing
      //     two look-alike rows (Codex RED). So we preserve every distinct term.
      //   • The cost is that two literals sharing a lexical form render as
      //     visually-similar rows. Surfacing the datatype/lang badge that would
      //     disambiguate them is a UI enhancement tracked separately; doing it
      //     inline would either drop data or re-leak the `^^<…>` suffix (#913).
      // The displayed value is still the decoded lexical form, so #913 holds —
      // the raw `^^<…>`/`@lang` suffix never reaches the screen.
      const pKeys = propertyKeys.get(entity.uri) ?? new Set<string>();
      const rawKey = `${t.predicate}\0${t.object}`;
      if (!pKeys.has(rawKey)) {
        pKeys.add(rawKey);
        propertyKeys.set(entity.uri, pKeys);
        const existing = entity.properties.get(t.predicate) ?? [];
        existing.push(decodeRdfStringLiteral(t.object));
        entity.properties.set(t.predicate, existing);
      }
    }
  }

  // PASS 2 — finalise label + trustLevel so Pass 3's residue filter
  // sees authoritative per-entity layer.
  for (const entity of entities.values()) {
    entity.label = deriveEntityLabel(entity);

    if (entity.layers.has('verified')) entity.trustLevel = 'verified';
    else if (entity.layers.has('shared')) entity.trustLevel = 'shared';
    else entity.trustLevel = 'working';
  }

  // PASS 3 — count triples per (entity, layer) under the same residue
  // filter `useLayerTriples` uses (`helpers.ts:444-448`). A cross-layer
  // edge `wm:A → swm:B` is dropped from the WM tab because the object
  // has been promoted past WM, so it must not bump A's WM count either
  // — otherwise badge over-counts vs tab.
  for (const t of layered) {
    const subjectUri = canonicalEntityUri(t.subject);
    const subjectEntity = entities.get(subjectUri);
    // Mirror `useLayerTriples` line 426-427: if the subject entity
    // exists and its canonical layer differs from this triple's layer,
    // it's residue — drop. Subjects that don't resolve to a tracked
    // entity (literal orphans / class IRIs) pass through.
    if (subjectEntity && subjectEntity.trustLevel !== t.layer) continue;

    const canonicalObject = isUri(t.object) ? canonicalEntityUri(t.object) : t.object;
    const objectIsResource = isUri(t.object);
    if (objectIsResource) {
      const objectEntity = entities.get(canonicalObject);
      // Mirror `useLayerTriples` line 444-448: object-side trust
      // check. Cross-layer resource→resource edges are dropped on
      // the source layer's tab; they must not bump either endpoint's
      // count for that layer.
      if (objectEntity && objectEntity.trustLevel !== t.layer) continue;
    }

    const spoKey = `${subjectUri}\0${t.predicate}\0${canonicalObject}`;
    if (subjectEntity) bumpTriple(subjectEntity.uri, t.layer, spoKey);

    if (t.predicate === RDF_TYPE) {
      // Class-target bump only when the class is a first-class entity
      // (created by its own triples in Pass 1). Self-link guard same
      // as the IRI branch below.
      if (canonicalObject !== subjectUri) {
        const typeEntity = entities.get(canonicalObject);
        if (typeEntity) bumpTriple(typeEntity.uri, t.layer, spoKey);
      }
    } else if (objectIsResource) {
      // Self-link guard: `(A, p, A)` is one row in the Triples tab
      // (`s===uri || o===uri` matches once); subject-side bump above
      // already counted it.
      if (canonicalObject !== subjectUri) {
        const targetEntity = entities.get(canonicalObject);
        if (targetEntity) bumpTriple(targetEntity.uri, t.layer, spoKey);
      }
    }
  }

  // PASS 4 — finalise `tripleCount` to the canonical-layer count.
  // What the entity-row badge on this entity's layer page shows after
  // useLayerTriples + dedupeTriplesBySpo. Cross-layer residue (e.g. a
  // promoted SWM entity's WM-only drafts) does not inflate it.
  for (const entity of entities.values()) {
    const counts = tripleCountByLayer.get(entity.uri);
    entity.tripleCount = counts ? counts[entity.trustLevel] : 0;
  }

  for (const entity of entities.values()) {
    for (const connection of entity.connections) {
      connection.targetLabel = entities.get(connection.targetUri)?.label ?? shortLabel(connection.targetUri);
    }
  }

  return entities;
}

export const buildMemoryEntities = buildEntities;

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

/**
 * Canonical "first-class entity" predicate — an entity belongs in the
 * Entities tab list (and therefore the graph node set) iff it has at
 * least one own type, property, or outgoing connection. The Map built
 * by `buildEntities` also contains synthesised stubs for pure-object
 * URIs (vocab constants, IPFS refs, DID property values); those fail
 * this predicate and are filtered out. Single source of truth — any
 * place that needs to ask "is this a real entity vs an object stub"
 * MUST go through this helper so the rule stays in lockstep across
 * the Entities tab, the graph filter, etc.
 */
export function isFirstClassEntity(e: MemoryEntity): boolean {
  return e.types.length > 0 || e.properties.size > 0 || e.connections.length > 0;
}

export function useMemoryEntities(
  contextGraphId: string,
  opts?: { signalErrors?: boolean; includeQueryCatalog?: boolean },
): MemoryData {
  // Off by default: every existing caller (ProjectView/MemoryStackView/
  // AgentProfilePage) keeps the original "failed query → empty, never a
  // hard error" behavior. Only the dashboard opts in so it alone gets
  // the failed-vs-empty distinction it needs (Codex).
  const signalErrors = opts?.signalErrors ?? false;
  const includeQueryCatalog = opts?.includeQueryCatalog ?? false;
  const [layeredTriples, setLayeredTriples] = useState<LayeredTriple[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [layerStatus, setLayerStatus] = useState<Record<MemoryLayerKey, MemoryLayerStatus>>(
    LOADING_LAYER_STATUS,
  );
  const versionRef = useRef(0);

  const [hasMore, setHasMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const requestRef = useRef<{ key: string; promise: Promise<void>; again: boolean } | null>(null);
  const pagesRef = useRef<Array<{ sparql: string; layer: TrustLevel; result: LayerResult }>>([]);
  const key = JSON.stringify([contextGraphId, includeQueryCatalog, signalErrors]);

  const fetchAll = useCallback((force = false): Promise<void> => {
    if (!contextGraphId) return Promise.resolve();
    if (force) invalidateQueryCache(contextGraphId);
    const running = requestRef.current;
    if (running?.key === key) {
      running.again = true;
      return running.promise;
    }
    const version = ++versionRef.current;
    setLoading(true);
    setError(null);
    setPageError(null);
    setLayerStatus(LOADING_LAYER_STATUS);
    const entry = { key, promise: Promise.resolve(), again: false };
    const definitions: Array<{ sparql: string; layer: TrustLevel }> = [
      { sparql: wmSparql(contextGraphId), layer: 'working' },
      { sparql: swmSparql(contextGraphId), layer: 'shared' },
      { sparql: vmSparql(contextGraphId), layer: 'verified' },
      ...(includeQueryCatalog ? [
        { sparql: queryCatalogLayerSparql(contextGraphId, 'wm'), layer: 'working' as const },
        { sparql: queryCatalogLayerSparql(contextGraphId, 'swm'), layer: 'shared' as const },
      ] : []),
    ];
    entry.promise = (async () => {
      const results = await Promise.all(definitions.map(definition => readMemoryGraphPage(
        definition.sparql, contextGraphId, { includeContextGraphPartitions: true, layerLimit: WM_LIMIT },
      )));
      if (version !== versionRef.current || !activeRef.current) return;
      pagesRef.current = definitions.map((definition, index) => ({ ...definition, result: results[index] }));
      const triples = pagesRef.current.flatMap(page => page.result.triples.map(triple => ({ ...triple, layer: page.layer })));
      setLayeredTriples(triples);
      setLoadedKey(key);
      const status = (layer: TrustLevel): MemoryLayerStatus => pagesRef.current.filter(page => page.layer === layer).every(page => page.result.ok) ? 'ok' : 'error';
      const statuses = { wm: status('working'), swm: status('shared'), vm: status('verified') };
      const failed = Object.values(statuses).filter(value => value === 'error').length;
      const more = results.some(result => result.truncated);
      setLayerStatus(statuses);
      setHasMore(more);
      setPartial(failed > 0 || more);
      setError(signalErrors && failed === 3 ? 'Failed to load memory data' : null);
    })().finally(() => {
      if (version === versionRef.current && activeRef.current) setLoading(false);
      if (requestRef.current !== entry) return;
      requestRef.current = null;
      if (entry.again && activeRef.current) void fetchAll(false);
    });
    requestRef.current = entry;
    return entry.promise;
  }, [contextGraphId, includeQueryCatalog, signalErrors, key]);

  const loadMore = useCallback((): Promise<void> => {
    if (requestRef.current) return requestRef.current.promise;
    const pages = pagesRef.current.filter(page => page.result.truncated);
    if (!pages.length) return Promise.resolve();
    const version = ++versionRef.current;
    const entry = { key, promise: Promise.resolve(), again: false };
    setLoading(true);
    setPageError(null);
    entry.promise = (async () => {
      const results = await Promise.all(pages.map(page => readMemoryGraphPage(page.sparql, contextGraphId, {
        includeContextGraphPartitions: true, layerLimit: WM_LIMIT, cursor: page.result.cursor,
      })));
      if (version !== versionRef.current || !activeRef.current) return;
      const added: LayeredTriple[] = [];
      for (const [index, result] of results.entries()) {
        if (!result.ok) { setPageError('Could not load more graph data. Retry to continue from the last loaded page.'); continue; }
        pages[index].result = result;
        added.push(...result.triples.map(triple => ({ ...triple, layer: pages[index].layer })));
      }
      setLayeredTriples(previous => [...previous, ...added]);
      const more = pagesRef.current.some(page => page.result.truncated);
      setHasMore(more);
      setPartial(more || pagesRef.current.some(page => !page.result.ok));
    })().finally(() => {
      if (version === versionRef.current && activeRef.current) setLoading(false);
      if (requestRef.current !== entry) return;
      requestRef.current = null;
      if (entry.again && activeRef.current) void fetchAll(false);
    });
    requestRef.current = entry;
    return entry.promise;
  }, [contextGraphId, key, fetchAll]);

  useMemoryGraphEvents(contextGraphId, () => { void fetchAll(false); });
  useEffect(() => {
    activeRef.current = true;
    void fetchAll(false);
    return () => {
      activeRef.current = false;
      versionRef.current++;
      requestRef.current = null;
      pagesRef.current = [];
    };
  }, [fetchAll]);

  const visibleTriples = useMemo(() => loadedKey === key ? layeredTriples : [], [loadedKey, key, layeredTriples]);
  const entities = useMemo(() => buildMemoryEntities(visibleTriples), [visibleTriples]);

  const entityList = useMemo(() =>
    [...entities.values()]
      .filter(isFirstClassEntity)
      .sort((a, b) => {
        const trustOrder = { verified: 0, shared: 1, working: 2 };
        const td = trustOrder[a.trustLevel] - trustOrder[b.trustLevel];
        if (td !== 0) return td;
        const ca = a.tripleCount ?? 0;
        const cb = b.tripleCount ?? 0;
        if (cb !== ca) return cb - ca;
        return a.label.localeCompare(b.label);
      }),
    [entities]
  );

  const graphTriples = useMemo(() => {
    const seen = new Set<string>();
    return visibleTriples.filter(t => {
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(({ subject, predicate, object, subGraph }) => ({ subject, predicate, object, subGraph }));
  }, [visibleTriples]);

  const trustMap = useMemo(() => {
    const m = new Map<string, TrustLevel>();
    for (const [uri, e] of entities) m.set(uri, e.trustLevel);
    return m;
  }, [entities]);

  const counts = useMemo(() => {
    let wm = 0, swm = 0, vm = 0;
    for (const entity of entityList) {
      if (entity.trustLevel === 'verified') vm++;
      else if (entity.trustLevel === 'shared') swm++;
      else wm++;
    }
    return { wm, swm, vm, total: entityList.length };
  }, [entityList]);

  const refresh = useCallback(() => { void fetchAll(true); }, [fetchAll]);
  const nextPage = useCallback(() => { void loadMore(); }, [loadMore]);
  return {
    entities,
    entityList,
    allTriples: visibleTriples,
    graphTriples,
    trustMap,
    counts,
    loading: loading || loadedKey !== key,
    error,
    partial,
    layerStatus,
    refresh,
    hasMore: loadedKey === key && hasMore,
    loadMore: nextPage,
    pageError,
  };
}
