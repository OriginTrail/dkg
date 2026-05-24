import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { authHeaders } from '../api.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';
import { MEMORY_LABEL_PREDICATES } from '../lib/memoryLabels.js';

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
  /** True when some (but not all) layer queries failed — counts are
   *  incomplete but not absent. `error` stays null in this case. */
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
  return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('urn:') || s.startsWith('did:');
}

function shortLabel(uri: string): string {
  if (!uri) return '—';
  if (uri.startsWith('"')) return uri.replace(/^"|"$/g, '');
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

function uriTail(uri: string): string {
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
  return label === uri && (uri.startsWith('urn:') || uri.startsWith('did:'));
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
  return `SELECT ?s ?p ?o ?g WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}/") &&
      CONTAINS(STR(?g), "/assertion/")
    )
  } LIMIT ${WM_LIMIT}`;
}

function swmSparql(cgId: string) {
  const cgUri = `did:dkg:context-graph:${cgId}`;
  // Any graph whose tail ends in `_shared_memory` (excluding the sibling
  // `_shared_memory_meta` bookkeeping graphs which carry lifecycle
  // provenance rather than user data).
  return `SELECT ?s ?p ?o ?g WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}") &&
      STRENDS(STR(?g), "/_shared_memory")
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
  //   • `_meta`, `_private`, `_rules`, any `_verified_memory_meta`
  //     — bookkeeping graphs, not user data.
  return `SELECT ?s ?p ?o ?g WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}") &&
      !CONTAINS(STR(?g), "/assertion/") &&
      !CONTAINS(STR(?g), "/_shared_memory") &&
      !CONTAINS(STR(?g), "_verified_memory_meta") &&
      !STRENDS(STR(?g), "/_meta") &&
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
function subGraphOf(gUri: string, cgId: string): string | undefined {
  const prefix = `did:dkg:context-graph:${cgId}/`;
  if (!gUri.startsWith(prefix)) return undefined;
  const tail = gUri.slice(prefix.length);
  const slash = tail.indexOf('/');
  const seg = slash >= 0 ? tail.slice(0, slash) : tail;
  if (!seg || seg.startsWith('_')) return undefined;
  return seg;
}

interface LayerResult { triples: Triple[]; ok: boolean }

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
  opts?: { view?: string; includeSharedMemory?: boolean; graphSuffix?: string },
): Promise<LayerResult> {
  // Never throws and never loses the failed-vs-empty distinction: it
  // returns `{ triples, ok }`. A failed/unreachable `/api/query` yields
  // `{ triples: [], ok: false }` so triple data still degrades to
  // "empty" for every consumer (unchanged behavior), while `ok=false`
  // lets the hook compute `partial` UNCONDITIONALLY — previously it was
  // dead for non-opt-in callers, making truncated counts look exact
  // (Codex). Whether a total failure escalates to a hard `error` stays
  // the configurable part (see `signalErrors`).
  try {
    const body: any = { sparql, contextGraphId, ...opts };
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`/api/query failed (${res.status})`);
    const data = await res.json();
    const bindings = data?.result?.bindings ?? data?.results?.bindings ?? [];
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
    return { triples, ok: true };
  } catch {
    return { triples: [], ok: false };
  }
}

function buildEntities(layered: LayeredTriple[]): Map<string, MemoryEntity> {
  const entities = new Map<string, MemoryEntity>();

  function getOrCreate(uri: string): MemoryEntity {
    let e = entities.get(uri);
    if (!e) {
      e = {
        uri,
        label: shortLabel(uri),
        types: [],
        trustLevel: 'working',
        layers: new Set(),
        subGraphs: new Set(),
        properties: new Map(),
        connections: [],
      };
      entities.set(uri, e);
    }
    return e;
  }

  for (const t of layered) {
    const entity = getOrCreate(t.subject);
    entity.layers.add(t.layer);
    if (t.subGraph) entity.subGraphs.add(t.subGraph);

    if (t.predicate === RDF_TYPE) {
      if (!entity.types.includes(t.object)) {
        entity.types.push(t.object);
      }
    } else if (isUri(t.object)) {
      const targetEntity = getOrCreate(t.object);
      targetEntity.layers.add(t.layer);
      if (t.subGraph) targetEntity.subGraphs.add(t.subGraph);
      entity.connections.push({
        predicate: t.predicate,
        targetUri: t.object,
        targetLabel: shortLabel(t.object),
      });
    } else {
      const existing = entity.properties.get(t.predicate) ?? [];
      const val = t.object.startsWith('"') ? t.object.replace(/^"|"$/g, '') : t.object;
      if (!existing.includes(val)) {
        existing.push(val);
        entity.properties.set(t.predicate, existing);
      }
    }
  }

  for (const entity of entities.values()) {
    entity.label = deriveEntityLabel(entity);

    if (entity.layers.has('verified')) entity.trustLevel = 'verified';
    else if (entity.layers.has('shared')) entity.trustLevel = 'shared';
    else entity.trustLevel = 'working';
  }

  for (const entity of entities.values()) {
    for (const connection of entity.connections) {
      connection.targetLabel = entities.get(connection.targetUri)?.label ?? shortLabel(connection.targetUri);
    }
  }

  return entities;
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
      const [wmR, swmR, vmR] = await Promise.all([
        queryLayer(wmSparql(contextGraphId), contextGraphId),
        queryLayer(swmSparql(contextGraphId), contextGraphId),
        queryLayer(vmSparql(contextGraphId), contextGraphId),
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
      const failed = [wmR, swmR, vmR].filter(r => !r.ok).length;
      // `partial` is computed UNCONDITIONALLY for every caller — it was
      // previously dead unless a caller opted in, making truncated
      // counts look exact in MemoryStackView/ProjectView (Codex).
      // Whether a *total* failure also escalates to a hard `error`
      // (dashboard assetCount fallback / views' error screen) stays the
      // configurable part via `signalErrors`.
      setPartial(failed > 0 && failed < 3);
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

  const entities = useMemo(() => buildEntities(layeredTriples), [layeredTriples]);

  const entityList = useMemo(() =>
    [...entities.values()]
      .filter(e => e.types.length > 0 || e.properties.size > 0 || e.connections.length > 0)
      .sort((a, b) => {
        const trustOrder = { verified: 0, shared: 1, working: 2 };
        const td = trustOrder[a.trustLevel] - trustOrder[b.trustLevel];
        if (td !== 0) return td;
        const ca = a.connections.length + a.properties.size;
        const cb = b.connections.length + b.properties.size;
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
