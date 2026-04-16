import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { authHeaders } from '../api.js';

export type TrustLevel = 'working' | 'shared' | 'verified';

export interface MemoryEntity {
  uri: string;
  label: string;
  types: string[];
  trustLevel: TrustLevel;
  layers: Set<TrustLevel>;
  properties: Map<string, string[]>;
  connections: Array<{ predicate: string; targetUri: string; targetLabel: string }>;
}

export interface Triple {
  subject: string;
  predicate: string;
  object: string;
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

function wmSparql(cgId: string) {
  const cgUri = `did:dkg:context-graph:${cgId}`;
  return `SELECT ?s ?p ?o WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}/") &&
      !STRENDS(STR(?g), "/_meta") &&
      !CONTAINS(STR(?g), "/_private") &&
      !CONTAINS(STR(?g), "/_shared_memory") &&
      !CONTAINS(STR(?g), "/_verified_memory") &&
      !CONTAINS(STR(?g), "/_rules")
    )
  } LIMIT 1500`;
}
const SPARQL_SWM = `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 500`;
const SPARQL_VM = `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 500`;

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
      .map((row: any) => ({
        subject: bv(row.s) ?? '',
        predicate: bv(row.p) ?? '',
        object: bv(row.o) ?? '',
      }))
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

    if (t.predicate === RDF_TYPE) {
      if (!entity.types.includes(t.object)) {
        entity.types.push(t.object);
      }
    } else if (isUri(t.object)) {
      const targetEntity = getOrCreate(t.object);
      targetEntity.layers.add(t.layer);
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
        queryLayer(SPARQL_SWM, contextGraphId, { view: 'shared-working-memory' }),
        queryLayer(SPARQL_VM, contextGraphId, { view: 'verified-memory' }),
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
    }).map(({ subject, predicate, object }) => ({ subject, predicate, object }));
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
