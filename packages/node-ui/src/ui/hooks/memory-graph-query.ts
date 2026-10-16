import { postQueryDeduped } from '../api.js';
import { UI_READ_MAX_AGE_MS } from '../lib/read-cache.js';
import { QueryResponseLimitError } from '../query-transport.js';
import { decodeRdfStringLiteral } from '../../rdf-literal.js';
import { sparqlIri } from '@origintrail-official/dkg-core/sparql-safe';
import { definitionsForLayer, memoryQuery, type MemoryQueryDefinition } from './memory-query-definition.js';
import type { Triple, LayeredTriple, MemoryLayerKey } from './useMemoryEntities.js';

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

type TermKey = [string, string, string, string, string, string];
type RowCursor =
  | { kind: 'row'; graph: string; termKey: TermKey }
  | { kind: 'after-graph'; graph: string };
export type MemoryGraphCursor = RowCursor
  | { kind: 'blank-graphs'; graphs: string[]; resume?: RowCursor };
export interface MemoryGraphPage {
  ok: true;
  triples: Triple[];
  nextCursor?: MemoryGraphCursor;
  omittedRelationships: boolean;
}
export type LayerResult = MemoryGraphPage
  | { ok: false; reason: 'unavailable' | 'response-limit' | 'cancelled' };
export const MEMORY_LIMIT_MESSAGE = 'Memory preview limit reached. Some relationships remain unloaded. Use a narrower query to inspect them.';

interface QueryLayerOptions {
  includeContextGraphPartitions?: boolean;
  layerLimit?: number;
  cursor?: MemoryGraphCursor;
  /** Stop dependent reads after the owning hook is replaced or unmounted. */
  signal?: AbortSignal;
}

const CURSOR_VARIABLES = ['?__g', '?__s', '?__p', '?__kind', '?__o', '?__lang', '?__datatype'];
const CURSOR_BINDINGS = `
  BIND(STR(?g) AS ?__g)
  BIND(CONCAT("I:", STR(?s)) AS ?__s)
  BIND(STR(?p) AS ?__p)
  BIND(IF(isIRI(?o), "I", "L") AS ?__kind)
  BIND(STR(?o) AS ?__o)
  BIND(IF(isLiteral(?o), LANG(?o), "") AS ?__lang)
  BIND(IF(isLiteral(?o), STR(DATATYPE(?o)), "") AS ?__datatype)`;

function cursorForRow(row: Record<string, unknown>): RowCursor {
  const values = CURSOR_VARIABLES.map(variable => {
    const term = row[variable.slice(1)];
    const value = bv(term);
    // SPARQL JSON bindings are already lexical; flat daemon strings are RDF literals.
    return typeof term === 'object' ? value : value === undefined ? undefined : decodeRdfStringLiteral(value);
  });
  if (values.some(value => value === undefined)) throw new Error('Memory query omitted its continuation key');
  const [graph, ...termKey] = values as string[];
  return { kind: 'row', graph, termKey: termKey as TermKey };
}

function cursorFilter(cursor?: RowCursor): string {
  if (cursor?.kind !== 'row') return '';
  const values = [cursor.graph, ...cursor.termKey];
  return `FILTER(${CURSOR_VARIABLES.map((variable, index) => {
    const equal = CURSOR_VARIABLES.slice(0, index).map((prior, i) => `${prior} = ${JSON.stringify(values[i])}`);
    return `(${[...equal, `${variable} > ${JSON.stringify(values[index])}`].join(' && ')})`;
  }).join(' || ')})`;
}

export async function readMemoryGraphPage(
  definition: MemoryQueryDefinition,
  contextGraphId: string,
  opts: QueryLayerOptions = {},
): Promise<LayerResult> {
  try {
    const { layerLimit: requestedLimit = WM_LIMIT, cursor, signal, ...requestOpts } = opts;
    const layerLimit = Math.max(1, Math.min(WM_LIMIT, Math.trunc(requestedLimit) || WM_LIMIT));
    const checkCurrent = () => signal?.throwIfAborted();
    const read = async (sparql: string) => {
      checkCurrent();
      const data = await postQueryDeduped({ sparql, contextGraphId, ...requestOpts },
        { maxAgeMs: UI_READ_MAX_AGE_MS, timeoutMs: 60_000 });
      checkCurrent();
      return data.result?.bindings ?? [];
    };
    // Keep exact projected ordering keys, but shrink wide row pages until their
    // serialized response fits the transport budget. Never cache a failed read.
    const boundedRead = async (query: (limit: number) => string, requested: number) => {
      let limit = requested;
      for (;;) {
        try { return { rows: await read(query(limit)), limit }; }
        catch (error) {
          if (!(error instanceof QueryResponseLimitError) || limit === 1) throw error;
          limit = Math.max(1, Math.floor(limit / 2));
        }
      }
    };
    const triples: Triple[] = [];
    const append = (rows: Record<string, unknown>[]) => {
      for (const row of rows) {
        const graph = canonicalEntityUri(bv(row.g) ?? '');
        // Blank labels belong to this graph's single blank-edge response. They
        // are never used as constants in another query or merged with another graph.
        const term = (value: unknown) => {
          const text = rdfBindingValue(value) ?? '';
          return text.startsWith('_:') ? `_:${encodeURIComponent(graph)}:${text.slice(2)}` : text;
        };
        const subject = term(row.s); const predicate = bv(row.p) ?? ''; const object = term(row.o);
        if (subject && predicate && object) triples.push({ subject, predicate, object, graph, subGraph: subGraphOf(graph, contextGraphId) });
      }
    };
    let pending: string[];
    let resume: RowCursor | undefined;
    if (cursor?.kind === 'blank-graphs') {
      pending = [...cursor.graphs]; resume = cursor.resume;
    } else {
      // Existence probes inventory five graphs without sorting their source rows.
      const catalog = await read(memoryQuery(definition, {
        projection: 'DISTINCT ?g', inventory: true, order: 'STR(?g)', limit: 6,
        filters: cursor ? `FILTER(STR(?g) ${cursor.kind === 'after-graph' ? '>' : '>='} ${JSON.stringify(cursor.graph)})` : '',
      }));
      const names = [...new Set(catalog.map(row => canonicalEntityUri(bv(row.g) ?? '')).filter(Boolean))];
      const graphs = names.slice(0, 5);
      if (!graphs.length) return { ok: true, triples, omittedRelationships: false };
      const { rows, limit } = await boundedRead(limit => memoryQuery(definition, {
        projection: `?s ?p ?o ?g ${CURSOR_VARIABLES.join(' ')}`, graphs,
        filters: `FILTER(!isBlank(?s) && !isBlank(?o)) ${cursorFilter(cursor)}`,
        bindings: CURSOR_BINDINGS, order: CURSOR_VARIABLES.join(' '), limit,
      }), layerLimit);
      const bindings = rows.slice(0, limit);
      append(bindings);
      const clipped = bindings.length >= limit;
      const last = clipped ? cursorForRow(bindings.at(-1)!) : undefined;
      // Finish blank edges before advancing past a completed graph. The graph
      // containing a row cursor is still in progress, so defer its blanks too.
      pending = clipped ? graphs.slice(0, graphs.indexOf(last!.graph)) : graphs;
      resume = last ?? (names.length > 5 ? { kind: 'after-graph', graph: graphs.at(-1)! } : undefined);
    }
    let omittedRelationships = false;
    while (pending.length && triples.length < layerLimit) {
      const budget = layerLimit - triples.length;
      const load = (graphs: string[]) => boundedRead(limit => memoryQuery(definition, {
        graphs, filters: 'FILTER(isBlank(?s) || isBlank(?o))', limit,
      }), budget + 1);
      let result = await load(pending);
      const fits = () => result.rows.length <= budget && (result.limit === budget + 1 || result.rows.length < result.limit);
      if (fits()) { append(result.rows); pending = []; break; }
      // Do not spend the tail of a row page on a partial blank response. Give
      // it a fresh page; split graph groups before declaring any graph oversized.
      if (triples.length) break;
      if (pending.length > 1) result = await load([pending[0]]);
      append(result.rows.slice(0, budget));
      omittedRelationships ||= !fits();
      pending.shift();
    }
    const nextCursor = pending.length ? { kind: 'blank-graphs' as const, graphs: pending, resume } : resume;
    if (!triples.length && !pending.length && resume) {
      return readMemoryGraphPage(definition, contextGraphId, { ...opts, cursor: resume });
    }
    return { ok: true, triples, nextCursor, omittedRelationships };
  } catch (error) {
    return { ok: false, reason: opts.signal?.aborted ? 'cancelled' : error instanceof QueryResponseLimitError ? 'response-limit' : 'unavailable' };
  }
}

/** Read a clicked resource directly, even when its facts fall outside the loaded graph pages. */
export async function fetchMemoryEntity(
  contextGraphId: string,
  uri: string,
  layer?: MemoryLayerKey,
  includeQueryCatalog = false,
  preview?: { triples: LayeredTriple[]; partial: boolean },
): Promise<{ triples: LayeredTriple[]; partial: boolean }> {
  const target = canonicalEntityUri(uri);
  const blank = target.startsWith('_:');
  const definitions = definitionsForLayer(contextGraphId, layer, includeQueryCatalog);
  if (blank) {
    // A blank label cannot identify a resource in a fresh SPARQL result. Use
    // the same graph-scoped response that supplied the clicked node instead.
    const layers = new Set(definitions.map(definition => definition.layer));
    return {
      triples: (preview?.triples ?? []).filter(triple => layers.has(triple.layer)
        && (triple.subject === target || triple.object === target)),
      partial: preview?.partial ?? true,
    };
  }
  const results = await Promise.all(definitions.map(async definition => {
    const pattern = `{
      { ${sparqlIri(target)} ?p ?o BIND(${sparqlIri(target)} AS ?s) }
      UNION { ?s ?p ${sparqlIri(target)} BIND(${sparqlIri(target)} AS ?o) FILTER(?s != ${sparqlIri(target)}) }
    }`;
    // Bind IRIs to use the store's subject/object indexes.
    const data = await postQueryDeduped({ sparql: memoryQuery(definition, {
      pattern, limit: 1001,
    }), contextGraphId, includeContextGraphPartitions: true }, { maxAgeMs: UI_READ_MAX_AGE_MS, timeoutMs: 60_000 });
    const rows = data.result?.bindings ?? [];
    return { truncated: rows.length > 1000, triples: rows.slice(0, 1000).map(row => ({
      subject: rdfBindingValue(row.s) ?? '', predicate: bv(row.p) ?? '', object: rdfBindingValue(row.o) ?? '',
      subGraph: subGraphOf(bv(row.g) ?? '', contextGraphId),
    })) };
  }));
  return {
    triples: results.flatMap((result, index) => result.triples.map(triple => ({ ...triple, layer: definitions[index].layer }))),
    partial: results.some(result => result.truncated),
  };
}
