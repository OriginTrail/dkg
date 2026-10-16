import { postQueryDeduped } from '../api.js';
import { UI_READ_MAX_AGE_MS } from '../lib/read-cache.js';
import { QueryResponseLimitError } from '../query-transport.js';
import { bindingLexicalValue as bv, bindingRdfTerm as rdfBindingValue } from '../query-bindings.js';
import { sparqlIri } from '@origintrail-official/dkg-core/sparql-safe';
import { definitionsForLayer, memoryQuery, type MemoryQueryDefinition } from './memory-query-definition.js';
import type { MemoryTriple, LayeredMemoryTriple, MemoryLayerKey } from './useMemoryEntities.js';

export { rdfBindingValue };

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
  triples: MemoryTriple[];
  nextCursor?: MemoryGraphCursor;
  omittedRelationships: boolean;
}
export type MemoryReadFailureReason = 'unavailable' | 'response-limit' | 'cancelled';
export type LayerResult = MemoryGraphPage | { ok: false; reason: MemoryReadFailureReason };
export const MEMORY_LIMIT_MESSAGE = 'Memory preview limit reached. Some relationships remain unloaded. Use a narrower query to inspect them.';

interface QueryLayerOptions {
  includeContextGraphPartitions?: boolean;
  layerLimit?: number;
  cursor?: MemoryGraphCursor;
  /** Stop dependent reads after the owning hook is replaced or unmounted. */
  signal?: AbortSignal;
}

function queryMemory(definition: MemoryQueryDefinition, contextGraphId: string, sparql: string,
  options: { includeContextGraphPartitions?: boolean } = {}, timeoutMs = 60_000) {
  return postQueryDeduped({ sparql, contextGraphId, ...options,
    ...(definition.layer === 'shared' ? { includeSharedMemory: true } : {}),
  }, { maxAgeMs: UI_READ_MAX_AGE_MS, timeoutMs });
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
  const values = CURSOR_VARIABLES.map(variable => bv(row[variable.slice(1)]));
  if (values.some(value => value === undefined)) throw new Error('Memory query omitted its continuation key');
  const [graph, ...termKey] = values as string[];
  return { kind: 'row', graph, termKey: termKey as TermKey };
}

const blankResponseScopes = new WeakMap<object, { id: number; nodes: Map<string, string> }>();
let nextBlankResponseScope = 0;

function projectedGraph(row: Record<string, unknown>): string {
  const graph = bv(row.g);
  if (!graph) throw new Error('Memory query omitted its source graph');
  return canonicalEntityUri(graph);
}

function triplesFromRows(rows: Record<string, unknown>[], contextGraphId: string, response: object = rows): MemoryTriple[] {
  return rows.flatMap(row => {
    const graph = projectedGraph(row);
    const term = (value: unknown) => {
      const text = rdfBindingValue(value) ?? '';
      if (!text.startsWith('_:')) return text;
      let scope = blankResponseScopes.get(response);
      if (!scope) {
        scope = { id: ++nextBlankResponseScope, nodes: new Map() };
        blankResponseScopes.set(response, scope);
      }
      let id = scope.nodes.get(text);
      if (!id) {
        id = `_:response-${scope.id}-node-${scope.nodes.size + 1}`;
        scope.nodes.set(text, id);
      }
      return id;
    };
    const subject = term(row.s); const predicate = bv(row.p) ?? ''; const object = term(row.o);
    return subject && predicate && object ? [{ subject, predicate, object, graph, subGraph: subGraphOf(graph, contextGraphId) }] : [];
  });
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
      const data = await queryMemory(definition, contextGraphId, sparql, requestOpts);
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
    const triples: MemoryTriple[] = [];
    const append = (rows: Record<string, unknown>[], response: object = rows) => {
      triples.push(...triplesFromRows(rows, contextGraphId, response));
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
      const names = [...new Set(catalog.map(projectedGraph))];
      const graphs = names.slice(0, 5);
      if (!graphs.length) return { ok: true, triples, omittedRelationships: false };
      const { rows, limit } = await boundedRead(limit => memoryQuery(definition, {
        projection: `?s ?p ?o ?g ${CURSOR_VARIABLES.join(' ')}`, graphs,
        filters: `FILTER(!isBlank(?s) && !isBlank(?o)) ${cursorFilter(cursor)}`,
        bindings: CURSOR_BINDINGS, order: CURSOR_VARIABLES.join(' '), limit,
      }), layerLimit);
      const bindings = rows.slice(0, limit);
      append(bindings, rows);
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
      append(result.rows.slice(0, budget), result.rows);
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

export interface MemoryEntityRead {
  triples: LayeredMemoryTriple[];
  partial: boolean;
  /** Blank edges in these graphs belong exclusively to this captured response. */
  blankGraphs: string[];
}
const RESOURCE_DETAIL_LIMIT = 1000;
const BLANK_GRAPH_DISCOVERY_ROUNDS = 5;

/** Follow stable graph IRIs, never response-local blank labels, between reads. */
async function connectedBlankGraphs(definition: MemoryQueryDefinition, contextGraphId: string, initial: string[]) {
  let graphs = initial;
  for (let round = 0; round < BLANK_GRAPH_DISCOVERY_ROUNDS; round++) {
    const data = await queryMemory(definition, contextGraphId, memoryQuery(definition, {
      projection: 'DISTINCT ?g', limit: 1,
      pattern: `{
        { ?b ?p ?o } UNION { ?s ?p ?b }
        FILTER(isBlank(?b))
      }`,
      // Exclude visited graphs and stop at the first new one. Enumerating all
      // matches would multiply repeated blank properties in a quadratic join.
      filters: `VALUES ?known { ${graphs.map(sparqlIri).join(' ')} }
        GRAPH ?known { { ?b ?knownP ?knownO } UNION { ?knownS ?knownP ?b } }
        FILTER(?g NOT IN (${graphs.map(sparqlIri).join(', ')}))`,
    }), { includeContextGraphPartitions: true }, 10_000);
    const found = (data.result?.bindings ?? []).map(projectedGraph);
    const next = [...new Set([...graphs, ...found])];
    if (next.length === graphs.length) return { graphs, partial: false };
    graphs = next;
  }
  return { graphs, partial: true };
}

/** Indexed IRI-only read. Blank navigation belongs to the hook owning the captured response. */
export async function fetchMemoryEntity(
  contextGraphId: string,
  iri: string,
  layer?: MemoryLayerKey,
  includeQueryCatalog = false,
): Promise<MemoryEntityRead> {
  const target = canonicalEntityUri(iri);
  const definitions = definitionsForLayer(contextGraphId, layer, includeQueryCatalog);
  const results = await Promise.all(definitions.map(async definition => {
    const pattern = `{
      { ${sparqlIri(target)} ?p ?o BIND(${sparqlIri(target)} AS ?s) }
      UNION { ?s ?p ${sparqlIri(target)} BIND(${sparqlIri(target)} AS ?o) FILTER(?s != ${sparqlIri(target)}) }
    }`;
    // Bind IRIs to use the store's subject/object indexes.
    const data = await queryMemory(definition, contextGraphId, memoryQuery(definition, {
      pattern, limit: RESOURCE_DETAIL_LIMIT + 1,
    }), { includeContextGraphPartitions: true });
    const rows = data.result?.bindings ?? [];
    const direct = triplesFromRows(rows.slice(0, RESOURCE_DETAIL_LIMIT), contextGraphId, rows);
    const isBlankEdge = (triple: MemoryTriple) => triple.subject.startsWith('_:') || triple.object.startsWith('_:');
    const anchors = [...new Set(direct.filter(isBlankEdge).map(triple => triple.graph))];
    if (!anchors.length) return { truncated: rows.length > RESOURCE_DETAIL_LIMIT, triples: direct, blankGraphs: [] };
    const closure = await connectedBlankGraphs(definition, contextGraphId, anchors);
    const blankGraphs = closure.graphs;
    // Never combine labels from the indexed resource response with a second
    // result. Capture related graphs together, prioritizing the clicked
    // resource's edges, and let the detail owner replace that graph's preview.
    const blanks = await queryMemory(definition, contextGraphId, memoryQuery(definition, {
      graphs: blankGraphs, filters: 'FILTER(isBlank(?s) || isBlank(?o))', limit: RESOURCE_DETAIL_LIMIT + 1,
      order: `IF(?s = ${sparqlIri(target)} || ?o = ${sparqlIri(target)}, 0, 1)`,
    }), { includeContextGraphPartitions: true });
    const blankRows = blanks.result?.bindings ?? [];
    return { truncated: closure.partial || rows.length > RESOURCE_DETAIL_LIMIT || blankRows.length > RESOURCE_DETAIL_LIMIT, blankGraphs,
      triples: [...direct.filter(triple => !isBlankEdge(triple)),
        ...triplesFromRows(blankRows.slice(0, RESOURCE_DETAIL_LIMIT), contextGraphId, blankRows)] };
  }));
  return {
    triples: results.flatMap((result, index) => result.triples.map(triple => ({ ...triple, layer: definitions[index].layer }))),
    partial: results.some(result => result.truncated),
    blankGraphs: results.flatMap(result => result.blankGraphs),
  };
}
