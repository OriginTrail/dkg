import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { postQueryDeduped } from '../api.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';
import { MEMORY_LABEL_PREDICATES } from '../lib/memoryLabels.js';
import { decodeRdfStringLiteral } from '../../rdf-literal.js';

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
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function bv(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as any)) return String((v as any).value);
  return String(v);
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
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1);
  return trimmed;
}

function shortLabel(uri: string): string {
  if (!uri) return '—';
  // Codex round-6 — decode RDF literals (drop the `^^<type>`/`@lang`
  // suffix + unescape the body) instead of a bare outer-quote strip, so
  // `"Hola"@es` renders `Hola`, not `Hola"@es`. Idempotent for a
  // suffix-free `"Hola"` and a no-op for non-literal IRIs.
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
// in `@origintrail-official/dkg-query` and `publishFromSharedMemory`):
//
//   WM  (drafts)    : did:dkg:context-graph:<cg>/<sg>/assertion/<addr>/<name>
//   SWM (proposed)  : did:dkg:context-graph:<cg>/<sg>/_shared_memory
//                     did:dkg:context-graph:<cg>/_shared_memory     (default)
//   VM  (committed) : did:dkg:context-graph:<cg>/<sg>              (per-sg)
//                     did:dkg:context-graph:<cg>                   (root)
//                     did:dkg:context-graph:<cg>/_verified_memory/*
//
// Key insight: in V10 the plain `<cg>/<sg>` graph IS the committed
// (chain-attested) view of a sub-graph — that's where
// `/api/shared-memory/publish` deposits KAs after on-chain registration.
// We treat it as VM, not WM. Pre-publish writes only exist in
// `assertion/<addr>/<name>` graphs.
//
// 50k triples comfortably fits realistic PoC projects in full (our
// seeded `dkg-code-project` WM has ~28k); SWM/VM stay smaller by
// design (hundreds of triples each).
const WM_LIMIT = 50_000;
const SWM_LIMIT = 20_000;
const VM_LIMIT = 20_000;

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
      CONTAINS(STR(?g), "/assertion/") &&
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
      STRENDS(STR(?g), "/_shared_memory") &&
      STR(?g) != "${cgUri}/meta/_shared_memory" &&
      !CONTAINS(STR(?g), "/meta/") &&
      ?p != <http://dkg.io/ontology/workspaceOwner>
    )
  } LIMIT ${SWM_LIMIT}`;
}

function vmSparql(cgId: string) {
  const cgUri = `did:dkg:context-graph:${cgId}`;
  // VM covers three named-graph shapes:
  //   • Root content graph       `<cgUri>`        — finalised VM
  //   • Per-sub-graph data graph `<cgUri>/<sg>`   — post-publish VM view
  //   • Per-sub-graph VM bucket  `<cgUri>/<sg>/_verified_memory(/*)`
  // We exclude:
  //   • `_shared_memory*`        — belongs to SWM
  //   • `assertion/*`            — belongs to WM
  //   • `_meta`, `/meta`, `/meta/*`, `_private`, `_rules`, any `_verified_memory_meta`
  //     — bookkeeping graphs, not user data.
  return `SELECT ?s ?p ?o ?g WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}") &&
      !CONTAINS(STR(?g), "/assertion/") &&
      !CONTAINS(STR(?g), "/_shared_memory") &&
      !CONTAINS(STR(?g), "_verified_memory_meta") &&
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

interface LayerResult { triples: Triple[]; ok: boolean; truncated: boolean }

interface QueryLayerOptions {
  view?: string;
  includeSharedMemory?: boolean;
  graphSuffix?: string;
  includeContextGraphPartitions?: boolean;
  /** Local-only result limit used to detect lower-bound totals; never sent to /api/query. */
  layerLimit?: number;
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

async function queryLayer(
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
    const { layerLimit, ...requestOpts } = opts ?? {};
    const body: any = { sparql, contextGraphId, ...requestOpts };
    const data: any = await postQueryDeduped(body);
    const bindings = data?.result?.bindings ?? data?.results?.bindings ?? [];
    const truncated = typeof layerLimit === 'number' && bindings.length >= layerLimit;
    const triples = bindings
      .map((row: any) => {
        const g = bv(row.g);
        return {
          subject: bv(row.s) ?? '',
          predicate: bv(row.p) ?? '',
          object: bv(row.o) ?? '',
          subGraph: g ? subGraphOf(g, contextGraphId) : undefined,
        };
      })
      .filter((t: Triple) => t.subject && t.predicate && t.object);
    return { triples, ok: true, truncated };
  } catch {
    return { triples: [], ok: false, truncated: false };
  }
}

export function buildEntities(layered: LayeredTriple[]): Map<string, MemoryEntity> {
  const entities = new Map<string, MemoryEntity>();
  const connectionKeys = new Map<string, Set<string>>();
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
      const existing = entity.properties.get(t.predicate) ?? [];
      // Codex round-6 — decode the literal (drop datatype/lang suffix +
      // unescape) rather than a bare outer-quote strip, so property
      // values used as labels (deriveEntityLabel) render `Hola`, not
      // `Hola"@es`. Idempotent for suffix-free / plain values.
      const val = t.object.startsWith('"') ? decodeRdfStringLiteral(t.object) : t.object;
      if (!existing.includes(val)) {
        existing.push(val);
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
  opts?: { signalErrors?: boolean },
): MemoryData {
  // Off by default: every existing caller (ProjectView/MemoryStackView/
  // AgentProfilePage) keeps the original "failed query → empty, never a
  // hard error" behavior. Only the dashboard opts in so it alone gets
  // the failed-vs-empty distinction it needs (Codex).
  const signalErrors = opts?.signalErrors ?? false;
  const [layeredTriples, setLayeredTriples] = useState<LayeredTriple[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [layerStatus, setLayerStatus] = useState<Record<MemoryLayerKey, MemoryLayerStatus>>(
    LOADING_LAYER_STATUS,
  );
  const versionRef = useRef(0);

  const fetchAll = useCallback(async () => {
    if (!contextGraphId) return;
    const version = ++versionRef.current;
    setLoading(true);
    setError(null);
    setPartial(false);
    setLayerStatus(LOADING_LAYER_STATUS);

    try {
      // queryLayer never throws — it returns { triples, ok }. We keep
      // whatever layers succeeded (failed layers contribute []), so a
      // single-layer 500 never blanks the others for any consumer.
      const countScope = { includeContextGraphPartitions: true };
      const [wmR, swmR, vmR] = await Promise.all([
        queryLayer(wmSparql(contextGraphId), contextGraphId, { ...countScope, layerLimit: WM_LIMIT }),
        queryLayer(swmSparql(contextGraphId), contextGraphId, { ...countScope, layerLimit: SWM_LIMIT }),
        queryLayer(vmSparql(contextGraphId), contextGraphId, { ...countScope, layerLimit: VM_LIMIT }),
      ]);

      if (version !== versionRef.current) return;

      const all: LayeredTriple[] = [
        ...wmR.triples.map(t => ({ ...t, layer: 'working' as const })),
        ...swmR.triples.map(t => ({ ...t, layer: 'shared' as const })),
        ...vmR.triples.map(t => ({ ...t, layer: 'verified' as const })),
      ];

      setLayeredTriples(all);
      setLayerStatus({
        wm: wmR.ok ? 'ok' : 'error',
        swm: swmR.ok ? 'ok' : 'error',
        vm: vmR.ok ? 'ok' : 'error',
      });
      const layerResults = [wmR, swmR, vmR];
      const failed = layerResults.filter(r => !r.ok).length;
      const clipped = layerResults.some(r => r.truncated);
      // `partial` is computed UNCONDITIONALLY for every caller — it was
      // previously dead unless a caller opted in, making truncated
      // counts look exact in MemoryStackView/ProjectView (Codex).
      // With same-CG partition scans, a successful layer can also hit
      // its fixed LIMIT; those counts are lower bounds, not exact totals.
      // Whether a *total* failure also escalates to a hard `error`
      // (dashboard assetCount fallback / views' error screen) stays the
      // configurable part via `signalErrors`.
      setPartial((failed > 0 && failed < 3) || clipped);
      setError(signalErrors && failed === 3 ? 'Failed to load memory data' : null);
    } catch (err: any) {
      if (version === versionRef.current) {
        setError(err.message ?? 'Failed to load memory data');
        setLayerStatus(ERROR_LAYER_STATUS);
      }
    } finally {
      if (version === versionRef.current) setLoading(false);
    }
  }, [contextGraphId, signalErrors]);

  useMemoryGraphEvents(contextGraphId, fetchAll);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const entities = useMemo(() => buildMemoryEntities(layeredTriples), [layeredTriples]);

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
    return layeredTriples.filter(t => {
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(({ subject, predicate, object, subGraph }) => ({ subject, predicate, object, subGraph }));
  }, [layeredTriples]);

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

  return {
    entities,
    entityList,
    allTriples: layeredTriples,
    graphTriples,
    trustMap,
    counts,
    loading,
    error,
    partial,
    layerStatus,
    refresh: fetchAll,
  };
}
