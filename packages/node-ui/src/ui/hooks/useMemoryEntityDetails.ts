import { useCallback, useMemo, useState } from 'react';
import { useFetch } from '../hooks.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';
import { buildMemoryEntities, canonicalEntityUri, fetchMemoryEntity, type LayeredTriple, type MemoryData, type MemoryLayerKey } from './useMemoryEntities.js';
import type { MemoryEntityRead } from './memory-graph-query.js';
import { dedupeTriplesBySpo } from '../views/project/entity-detail.js';

const TRUST = { wm: 'working', swm: 'shared', vm: 'verified' } as const;

function mergeDetails(preview: LayeredTriple[], detail: MemoryEntityRead, iri: string, layer: MemoryLayerKey | null): LayeredTriple[] {
  const ownedGraphs = new Set(detail.blankGraphs);
  const target = canonicalEntityUri(iri);
  // A complete response replaces the resource's old facts. Partial reads
  // retain unconfirmed preview facts, after any fresh facts they did return.
  // A fresh response owns its blank labels. Replace that graph's preview
  // edges rather than interpreting labels from independent results as IDs.
  return [...detail.triples, ...preview.filter(triple => {
    if (!detail.partial && (!layer || triple.layer === TRUST[layer])
      && (canonicalEntityUri(triple.subject) === target || canonicalEntityUri(triple.object) === target)) return false;
    return !ownedGraphs.has(triple.graph!) || (!triple.subject.startsWith('_:') && !triple.object.startsWith('_:'));
  })];
}

/** Own one bounded resource response and its blank facts across detail navigation. */
export function useMemoryEntityDetails(
  contextGraphId: string,
  resourceUri: string | null,
  layer: MemoryLayerKey | null,
  includeQueryCatalog: boolean,
  memory: MemoryData,
) {
  const uri = resourceUri === null ? null : canonicalEntityUri(resourceUri);
  const scope = JSON.stringify([contextGraphId, layer, includeQueryCatalog]);
  const blank = uri?.startsWith('_:') ?? false;
  const iri = blank ? null : uri;
  const [request, setRequest] = useState({ scope, preview: memory.allTriples, uri: iri });
  // The request identity follows IRIs and preview generations, not local blank
  // navigation. useFetch alone retains the response, including warm failures.
  if (request.scope !== scope || request.preview !== memory.allTriples
    || (iri !== null && request.uri !== iri) || (uri === null && request.uri !== null)) {
    setRequest({ scope, preview: memory.allTriples, uri: iri });
  }
  const read = useFetch(() => fetchMemoryEntity(contextGraphId, request.uri!, layer ?? undefined, includeQueryCatalog),
    [request], 0, { scope: request, retention: 'scope', enabled: request.uri !== null });
  // An old preview blank label belongs to that preview, never to another
  // query's response. Navigate either dataset without issuing a label query.
  const detail = !blank || read.data?.triples.some(triple => triple.subject === uri || triple.object === uri)
    ? read.data : null;
  const refresh = useCallback(() => { if (!blank || detail) read.refresh(); }, [blank, detail, read.refresh]);
  useMemoryGraphEvents(contextGraphId, () => { if (uri) refresh(); });
  const facts = useMemo(() => {
    const merged = detail ? mergeDetails(memory.allTriples, detail, request.uri!, layer) : memory.allTriples;
    return layer ? merged.filter(triple => triple.layer === TRUST[layer]) : merged;
  }, [memory.allTriples, detail, request.uri, layer]);
  const triples = useMemo(() => dedupeTriplesBySpo(facts), [facts]);
  const entities = useMemo(() => layer || detail
    ? buildMemoryEntities(facts) : memory.entities, [facts, layer, detail, memory.entities]);
  const authoritative = detail && !detail.partial && uri === request.uri;
  const fallback = uri && !authoritative ? memory.entities.get(uri) : undefined;
  const entity = uri ? entities.get(uri) ?? (fallback && (!layer || fallback.layers.has(TRUST[layer])) ? fallback : null) : null;

  return { entity, entities, triples, loading: !blank && read.loading, error: !blank || detail ? read.error : null,
    partial: detail?.partial ?? (blank && memory.partial), refresh };
}
