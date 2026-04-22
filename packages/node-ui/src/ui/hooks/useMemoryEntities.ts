import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { authHeaders } from '../api.js';

export type TrustLevel = 'working' | 'shared' | 'verified';

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

async function queryLayer(
  sparql: string,
  contextGraphId: string,
  opts?: { view?: string; includeSharedMemory?: boolean; graphSuffix?: string },
): Promise<Triple[]> {
  try {
    const body: any = { sparql, contextGraphId, ...opts };
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const bindings = data?.result?.bindings ?? data?.results?.bindings ?? [];
    return bindings
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
  } catch {
    return [];
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

  const NAME_PREDS = [
    'http://schema.org/name',
    'http://www.w3.org/2000/01/rdf-schema#label',
    'http://purl.org/dc/terms/title',
    'http://xmlns.com/foaf/0.1/name',
  ];

  for (const entity of entities.values()) {
    for (const pred of NAME_PREDS) {
      const vals = entity.properties.get(pred);
      if (vals?.[0]) {
        entity.label = vals[0];
        break;
      }
    }

    if (entity.layers.has('verified')) entity.trustLevel = 'verified';
    else if (entity.layers.has('shared')) entity.trustLevel = 'shared';
    else entity.trustLevel = 'working';
  }

  return entities;
}

export function useMemoryEntities(contextGraphId: string): MemoryData {
  const [layeredTriples, setLayeredTriples] = useState<LayeredTriple[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const fetchAll = useCallback(async () => {
    if (!contextGraphId) return;
    const version = ++versionRef.current;
    setLoading(true);
    setError(null);

    try {
      const [wmTriples, swmTriples, vmTriples] = await Promise.all([
        queryLayer(wmSparql(contextGraphId), contextGraphId),
        queryLayer(swmSparql(contextGraphId), contextGraphId),
        queryLayer(vmSparql(contextGraphId), contextGraphId),
      ]);

      if (version !== versionRef.current) return;

      const all: LayeredTriple[] = [
        ...wmTriples.map(t => ({ ...t, layer: 'working' as const })),
        ...swmTriples.map(t => ({ ...t, layer: 'shared' as const })),
        ...vmTriples.map(t => ({ ...t, layer: 'verified' as const })),
      ];

      setLayeredTriples(all);
    } catch (err: any) {
      if (version === versionRef.current) {
        setError(err.message ?? 'Failed to load memory data');
      }
    } finally {
      if (version === versionRef.current) setLoading(false);
    }
  }, [contextGraphId]);

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
    const wm = new Set(layeredTriples.filter(t => t.layer === 'working').map(t => t.subject)).size;
    const swm = new Set(layeredTriples.filter(t => t.layer === 'shared').map(t => t.subject)).size;
    const vm = new Set(layeredTriples.filter(t => t.layer === 'verified').map(t => t.subject)).size;
    return { wm, swm, vm, total: entities.size };
  }, [layeredTriples, entities]);

  return {
    entities,
    entityList,
    allTriples: layeredTriples,
    graphTriples,
    trustMap,
    counts,
    loading,
    error,
    refresh: fetchAll,
  };
}
