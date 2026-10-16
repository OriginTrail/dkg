import { decodeAssertionIdentity } from './assertion-identity.js';
import { sparqlIri } from '@origintrail-official/dkg-core/sparql-safe';
import { executeQuery } from './query-api.js';
import type { AssertionInfo } from './api.js';
import { UI_READ_MAX_AGE_MS } from './lib/read-cache.js';
import { decodeRdfStringLiteral } from '../rdf-literal.js';

export interface AssertionsPage {
  items: Array<AssertionInfo & { reservedUal?: string; dataGraphUri?: string }>;
  nextCursor?: string;
}

interface AssertionPageOptions {
  cursor?: string;
  pageSize?: number;
  includeQueryCatalog?: boolean;
  includeCounts?: boolean;
  fresh?: boolean;
}

const DKG = 'http://dkg.io/ontology/';
const value = (term: unknown): string => typeof term === 'string' ? term
  : String((term as { value?: unknown } | undefined)?.value ?? '');

/** Page membership metadata first, then count only the visible KAs' data graphs. */
export async function listAssertionsPage(
  contextGraphId: string,
  layer: 'wm' | 'swm',
  options: AssertionPageOptions = {},
): Promise<AssertionsPage> {
  const size = Math.max(1, Math.min(100, Math.trunc(options.pageSize ?? 50) || 50));
  const base = `did:dkg:context-graph:${contextGraphId}/`;
  const urn = `urn:dkg:assertion:${contextGraphId}:`;
  const meta = sparqlIri(`${base}_meta`);
  const layerName = layer.toUpperCase();
  // Select the canonical lifecycle row when an old physical-graph alias also exists.
  // This avoids duplicates across page boundaries and does not inspect source triples.
  const sparql = `SELECT ?g (MIN(?reserved) AS ?ual) (MIN(?dataGraph) AS ?dg) WHERE {
    GRAPH ${meta} {
      ?g <${DKG}memoryLayer> ${JSON.stringify(layerName)} .
      OPTIONAL { ?g <${DKG}reservedUal> ?reserved }
      OPTIONAL { ?g <${DKG}assertionGraph> ?dataGraph }
      FILTER NOT EXISTS { ?canonical <${DKG}assertionGraph> ?g ; <${DKG}memoryLayer> ${JSON.stringify(layerName)} . FILTER(?canonical != ?g) }
    }
    FILTER(STRSTARTS(STR(?g), ${JSON.stringify(base)}) || STRSTARTS(STR(?g), ${JSON.stringify(urn)}))
    BIND(IF(STRSTARTS(STR(?g), ${JSON.stringify(base)}),
      IRI(CONCAT(${JSON.stringify(urn)}, REPLACE(REPLACE(STRAFTER(STR(?g), ${JSON.stringify(base)}),
        "^assertion/([^/]+)/(.+)$", "$1:$2"), "^([^/]+)/assertion/([^/]+)/(.+)$", "$1:$2:$3"))), ?g) AS ?identity)
    FILTER NOT EXISTS { GRAPH ${meta} { ?identity <${DKG}memoryLayer> ${JSON.stringify(layerName)} } FILTER(?identity != ?g) }
    ${layer === 'swm' ? `FILTER NOT EXISTS { GRAPH ${meta} { ?identity <${DKG}vmCurrentAssertion> ?vm } }` : ''}
    FILTER((!CONTAINS(STR(?g), "/meta/assertion/") && !STRSTARTS(STR(?g), ${JSON.stringify(urn + 'meta:')}))
      ${options.includeQueryCatalog ? `|| (CONTAINS(STR(?g), "/meta/assertion/") && REGEX(STRAFTER(STR(?g), "/meta/assertion/"), "^[^/]+/query-catalog-"))
        || (STRSTARTS(STR(?g), ${JSON.stringify(urn + 'meta:')}) && REGEX(STRAFTER(STR(?g), ${JSON.stringify(urn + 'meta:')}), "^0x[0-9a-fA-F]{40}:query-catalog-"))` : ''})
    ${options.cursor ? `FILTER(STR(?g) > ${JSON.stringify(options.cursor)})` : ''}
  } GROUP BY ?g ORDER BY STR(?g) LIMIT ${size + 1}`;
  const data = await executeQuery(sparql, { contextGraphId, includeContextGraphPartitions: true }, { maxAgeMs: options.fresh ? 0 : UI_READ_MAX_AGE_MS });
  const rows = data.result?.bindings ?? [];
  const visible = rows.slice(0, size);
  const items = visible.flatMap(row => {
    const graphUri = value(row.g);
    const parsed = decodeAssertionIdentity(graphUri, contextGraphId);
    if (!parsed || (parsed.subGraph === 'meta' && !(options.includeQueryCatalog && parsed.name.startsWith('query-catalog-')))) return [];
    return [{ ...parsed, graphUri, reservedUal: decodeRdfStringLiteral(value(row.ual)) || undefined,
      dataGraphUri: value(row.dg) || (graphUri.startsWith(base) ? graphUri : undefined) }];
  });
  if (items.length && layer === 'wm' && options.includeCounts !== false) {
    const byGraph = await fetchAssertionPageCounts(contextGraphId, items, options).catch(() => ({} as Record<string, number>));
    for (const item of items) {
      const count = byGraph[item.graphUri];
      if (count !== undefined && Number.isFinite(count)) Object.assign(item, { tripleCount: count });
    }
  }
  return { items, nextCursor: rows.length > size ? value(visible.at(-1)?.g) : undefined };
}

/** Bulk actions drain the same membership pages, always from fresh metadata. */
export async function listAssertions(
  contextGraphId: string,
  layer: 'wm' | 'swm' = 'wm',
  options: { includeQueryCatalog?: boolean; includeCounts?: boolean } = {},
): Promise<AssertionInfo[]> {
  const items: AssertionInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await listAssertionsPage(contextGraphId, layer, { ...options, cursor, pageSize: 100, fresh: true });
    items.push(...page.items.map(({ name, graphUri, subGraph, tripleCount }) => ({ name, graphUri, subGraph, tripleCount })));
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** Counts are a separate bounded read so assertion rows can render before badges arrive. */
export async function fetchAssertionPageCounts(contextGraphId: string, items: AssertionsPage['items'], options: { fresh?: boolean } = {}): Promise<Record<string, number>> {
  const page = items.slice(0, 100).filter(item => item.dataGraphUri);
  if (!page.length) return {};
  const graphs = [...new Set(page.map(item => sparqlIri(item.dataGraphUri!)))].join(' ');
  const identities = page.map(item => `(${sparqlIri(item.graphUri)} ${sparqlIri(item.dataGraphUri!)})`).join(' ');
  // sparql-scan-allow: R2 -- ?dg is a finite VALUES set of at most 100 exact KA graphs from this authenticated metadata page; the daemon still applies its CG allow-set.
  const counts = await executeQuery(`SELECT ?g (COUNT(*) AS ?cnt) WHERE {
    VALUES ?dg { ${graphs} }
    VALUES (?g ?dg) { ${identities} }
    GRAPH ?dg { ?s ?p ?o }
  } GROUP BY ?g`, { contextGraphId, includeContextGraphPartitions: true }, { maxAgeMs: options.fresh ? 0 : UI_READ_MAX_AGE_MS });
  return Object.fromEntries((counts.result?.bindings ?? []).map(row =>
    [value(row.g), Number(value(row.cnt).replace(/^"(\d+)".*$/, '$1'))]).filter(([, count]) => Number.isFinite(count)));
}
