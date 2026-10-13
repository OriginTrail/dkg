import { sparqlIri } from '@origintrail-official/dkg-core/sparql-safe';
import { executeQuery, type AssertionInfo } from './api.js';
import { UI_READ_MAX_AGE_MS } from './lib/read-cache.js';

export interface AssertionsPage {
  items: Array<AssertionInfo & { reservedUal?: string }>;
  nextCursor?: string;
}

const DKG = 'http://dkg.io/ontology/';
const value = (term: unknown): string => typeof term === 'string' ? term
  : String((term as { value?: unknown } | undefined)?.value ?? '');

function identity(g: string, contextGraphId: string): { name: string; subGraph?: string } | undefined {
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  const urn = `urn:dkg:assertion:${contextGraphId}:`;
  if (g.startsWith(prefix)) {
    const segments = g.slice(prefix.length).split('/');
    if (segments.length === 3 && segments[0] === 'assertion') return { name: segments[2] };
    if (segments.length === 4 && segments[1] === 'assertion') return { name: segments[3], subGraph: segments[0] };
  }
  if (g.startsWith(urn)) {
    const rest = g.slice(urn.length);
    const root = /^(0x[0-9a-fA-F]{40}):(.+)$/.exec(rest);
    if (root) return { name: root[2] };
    const scoped = /^([^:]+):(0x[0-9a-fA-F]{40}):(.+)$/.exec(rest);
    if (scoped) return { name: scoped[3], subGraph: scoped[1] };
  }
}

/** Page membership metadata first, then count only the visible KAs' data graphs. */
export async function listAssertionsPage(
  contextGraphId: string,
  layer: 'wm' | 'swm',
  options: { cursor?: string; pageSize?: number; includeQueryCatalog?: boolean; includeCounts?: boolean } = {},
): Promise<AssertionsPage> {
  const size = Math.max(1, Math.min(100, Math.trunc(options.pageSize ?? 50) || 50));
  const base = `did:dkg:context-graph:${contextGraphId}/`;
  const urn = `urn:dkg:assertion:${contextGraphId}:`;
  const meta = sparqlIri(`${base}_meta`);
  const layerName = layer.toUpperCase();
  // Select the canonical lifecycle row when an old physical-graph alias also exists.
  // This avoids duplicates across page boundaries and does not inspect source triples.
  const sparql = `SELECT DISTINCT ?g ?ual WHERE {
    GRAPH ${meta} {
      ?g <${DKG}memoryLayer> ${JSON.stringify(layerName)} .
      OPTIONAL { ?g <${DKG}reservedUal> ?ual }
      FILTER NOT EXISTS { ?canonical <${DKG}assertionGraph> ?g ; <${DKG}memoryLayer> ${JSON.stringify(layerName)} . FILTER(?canonical != ?g) }
    }
    FILTER(STRSTARTS(STR(?g), ${JSON.stringify(base)}) || STRSTARTS(STR(?g), ${JSON.stringify(urn)}))
    BIND(IF(STRSTARTS(STR(?g), ${JSON.stringify(base)}),
      IRI(CONCAT(${JSON.stringify(urn)}, REPLACE(REPLACE(STRAFTER(STR(?g), ${JSON.stringify(base)}),
        "^assertion/([^/]+)/(.+)$", "$1:$2"), "^([^/]+)/assertion/([^/]+)/(.+)$", "$1:$2:$3"))), ?g) AS ?identity)
    FILTER NOT EXISTS { GRAPH ${meta} { ?identity <${DKG}memoryLayer> ${JSON.stringify(layerName)} } FILTER(?identity != ?g) }
    ${layer === 'swm' ? `FILTER NOT EXISTS { GRAPH ${meta} { ?identity <${DKG}vmCurrentAssertion> ?vm } }` : ''}
    ${options.includeQueryCatalog ? '' : `FILTER(!CONTAINS(STR(?g), "/meta/assertion/") && !STRSTARTS(STR(?g), ${JSON.stringify(urn + 'meta:')}))`}
    ${options.cursor ? `FILTER(STR(?g) > ${JSON.stringify(options.cursor)})` : ''}
  } ORDER BY STR(?g) LIMIT ${size + 1}`;
  const data = await executeQuery(sparql, { contextGraphId }, { maxAgeMs: UI_READ_MAX_AGE_MS });
  const rows = data.result?.bindings ?? [];
  const visible = rows.slice(0, size);
  const items = visible.flatMap(row => {
    const graphUri = value(row.g);
    const parsed = identity(graphUri, contextGraphId);
    if (!parsed || (parsed.subGraph === 'meta' && !(options.includeQueryCatalog && parsed.name.startsWith('query-catalog-')))) return [];
    return [{ ...parsed, graphUri, reservedUal: value(row.ual) || undefined }];
  });
  if (items.length && layer === 'wm' && options.includeCounts !== false) {
    const byGraph = await fetchAssertionPageCounts(contextGraphId, items).catch(() => ({} as Record<string, number>));
    for (const item of items) {
      const count = byGraph[item.graphUri];
      if (count !== undefined && Number.isFinite(count)) Object.assign(item, { tripleCount: count });
    }
  }
  return { items, nextCursor: rows.length > size ? value(visible.at(-1)?.g) : undefined };
}

/** Counts are a separate bounded read so assertion rows can render before badges arrive. */
export async function fetchAssertionPageCounts(contextGraphId: string, items: AssertionInfo[]): Promise<Record<string, number>> {
  if (!items.length) return {};
  const meta = sparqlIri(`did:dkg:context-graph:${contextGraphId}/_meta`);
  const graphs = items.slice(0, 100).map(item => sparqlIri(item.graphUri)).join(' ');
  const counts = await executeQuery(`SELECT ?g (COUNT(*) AS ?cnt) WHERE {
    VALUES ?g { ${graphs} }
    GRAPH ${meta} { ?g <${DKG}assertionGraph> ?dg }
    GRAPH ?dg { ?s ?p ?o }
  } GROUP BY ?g`, { contextGraphId, includeContextGraphPartitions: true }, { maxAgeMs: UI_READ_MAX_AGE_MS });
  return Object.fromEntries((counts.result?.bindings ?? []).map(row =>
    [value(row.g), Number(value(row.cnt).replace(/^"(\d+)".*$/, '$1'))]).filter(([, count]) => Number.isFinite(count)));
}
