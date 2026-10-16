import { useEffect, useMemo, useState } from 'react';
import { useFetch } from '../hooks.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';
import { buildMemoryEntities, fetchMemoryEntity, type LayeredTriple, type MemoryData, type MemoryLayerKey } from './useMemoryEntities.js';
import type { MemoryEntityRead } from './memory-graph-query.js';
import { dedupeTriplesBySpo } from '../views/project/entity-detail.js';

const EMPTY_READ: MemoryEntityRead = { triples: [], partial: false, blankGraphs: [] };
const TRUST = { wm: 'working', swm: 'shared', vm: 'verified' } as const;

function mergeDetails(preview: LayeredTriple[], detail: MemoryEntityRead): LayeredTriple[] {
  const ownedGraphs = new Set(detail.blankGraphs);
  // A fresh response owns its blank labels. Replace that graph's preview
  // edges rather than interpreting labels from independent results as IDs.
  return [...preview.filter(triple => !ownedGraphs.has(triple.graph!)
    || (!triple.subject.startsWith('_:') && !triple.object.startsWith('_:'))), ...detail.triples];
}

/** Own one bounded resource response and its blank facts across detail navigation. */
export function useMemoryEntityDetails(
  contextGraphId: string,
  uri: string | null,
  layer: MemoryLayerKey | null,
  includeQueryCatalog: boolean,
  memory: MemoryData,
) {
  const scope = JSON.stringify([contextGraphId, layer, includeQueryCatalog]);
  const requestScope = JSON.stringify([scope, uri]);
  const blank = uri?.startsWith('_:') ?? false;
  const [captured, setCaptured] = useState<{
    scope: string; preview: LayeredTriple[]; read: MemoryEntityRead;
  } | null>(null);
  // Retain only the last IRI response (bounded by the resource read limit).
  // A new context, layer, or preview generation invalidates its blank facts.
  const candidate = captured?.scope === scope && captured.preview === memory.allTriples ? captured.read : EMPTY_READ;
  const owned = blank && !candidate.triples.some(triple => triple.subject === uri || triple.object === uri) ? EMPTY_READ : candidate;
  const preview = useMemo(() => mergeDetails(memory.allTriples, owned), [memory.allTriples, owned]);
  const read = useFetch(() => uri
    ? fetchMemoryEntity(contextGraphId, uri, layer ?? undefined, includeQueryCatalog,
      { triples: preview, partial: memory.partial || owned.partial })
    : Promise.resolve(EMPTY_READ),
  [requestScope, blank ? preview : null, blank ? memory.partial : null],
  0, { scope: requestScope, retention: 'scope' });

  useEffect(() => {
    if (uri && !blank && read.data) setCaptured({ scope, preview: memory.allTriples, read: read.data });
  }, [read.data, scope, uri, blank]);
  useMemoryGraphEvents(contextGraphId, () => { if (uri) read.refresh(); });

  const facts = useMemo(() => {
    const merged = mergeDetails(preview, read.data ?? EMPTY_READ);
    return layer ? merged.filter(triple => triple.layer === TRUST[layer]) : merged;
  }, [preview, read.data, layer]);
  const triples = useMemo(() => dedupeTriplesBySpo(facts), [facts]);
  const entities = useMemo(() => layer || read.data || owned !== EMPTY_READ
    ? buildMemoryEntities(facts) : memory.entities, [facts, layer, read.data, owned, memory.entities]);
  const fallback = uri ? memory.entities.get(uri) : undefined;
  const entity = uri ? entities.get(uri) ?? (fallback && (!layer || fallback.layers.has(TRUST[layer])) ? fallback : null) : null;

  return { entity, entities, triples, loading: read.loading, error: read.error,
    partial: read.data?.partial ?? false, refresh: read.refresh };
}
