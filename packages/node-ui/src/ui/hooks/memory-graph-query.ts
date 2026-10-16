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
export type MemoryGraphCursor =
  | { kind: 'row'; graph: string; termKey: TermKey }
  | { kind: 'after-graph'; graph: string };
export interface LayerResult { triples: Triple[]; ok: boolean; truncated: boolean; rowCount: number; cursor?: MemoryGraphCursor; incomplete?: boolean }
export const MEMORY_LIMIT_MESSAGE = 'Memory preview limit reached. Some relationships remain unloaded. Use a narrower query to inspect them.';

interface QueryLayerOptions {
  includeContextGraphPartitions?: boolean;
  layerLimit?: number;
  cursor?: MemoryGraphCursor;
  /** Stop dependent reads after the owning hook is replaced or unmounted. */
  isCurrent?: () => boolean;
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

function cursorForRow(row: Record<string, unknown>): MemoryGraphCursor {
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

function cursorFilter(cursor?: MemoryGraphCursor): string {
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
    const { layerLimit: requestedLimit = WM_LIMIT, cursor, isCurrent, ...requestOpts } = opts;
    const layerLimit = Math.max(1, Math.min(WM_LIMIT, Math.trunc(requestedLimit) || WM_LIMIT));
    const checkCurrent = () => { if (isCurrent && !isCurrent()) throw new Error('Obsolete memory read'); };
    const read = async (sparql: string) => {
      checkCurrent();
      const data = await postQueryDeduped({ sparql, contextGraphId, ...requestOpts },
        { maxAgeMs: UI_READ_MAX_AGE_MS, timeoutMs: 60_000 });
      checkCurrent();
      return data.result?.bindings ?? [];
    };
    // Only this small graph inventory feeds the data read; existence probes do
    // not sort all source triples just to find the next five graph names.
    const catalog = await read(memoryQuery(definition, {
      projection: 'DISTINCT ?g', inventory: true, order: 'STR(?g)', limit: 6,
      filters: cursor ? `FILTER(STR(?g) ${cursor.kind === 'after-graph' ? '>' : '>='} ${JSON.stringify(cursor.graph)})` : '',
    }));
    const names = [...new Set(catalog.map(row => canonicalEntityUri(bv(row.g) ?? '')).filter(Boolean))];
    const graphNames = names.slice(0, 5);
    if (!graphNames.length) return { triples: [], ok: true, truncated: false, rowCount: 0 };
    const bindings = (await read(memoryQuery(definition, {
      projection: `?s ?p ?o ?g ${CURSOR_VARIABLES.join(' ')}`, graphs: graphNames,
      filters: `FILTER(!isBlank(?s) && !isBlank(?o)) ${cursorFilter(cursor)}`,
      bindings: CURSOR_BINDINGS, order: CURSOR_VARIABLES.join(' '), limit: layerLimit,
    }))).slice(0, layerLimit);
    const clipped = bindings.length >= layerLimit;
    // Blank labels are result-local and cannot be used as portable SPARQL
    // constants. Read each entered graph's blank edges once, within the page
    // budget, and explicitly retain incompleteness if that budget clips them.
    const lastGraphIndex = clipped ? graphNames.indexOf(canonicalEntityUri(bv(bindings.at(-1)!.g) ?? '')) : graphNames.length - 1;
    const blankGraphs = graphNames.slice(0, lastGraphIndex + 1)
      .filter(graph => cursor?.kind !== 'row' || graph !== cursor.graph);
    const blankBudget = layerLimit - bindings.length;
    const blankBindings = blankGraphs.length ? (await read(memoryQuery(definition, {
      graphs: blankGraphs, filters: 'FILTER(isBlank(?s) || isBlank(?o))', limit: blankBudget + 1,
    }))).filter(row => rdfBindingValue(row.s)?.startsWith('_:') || rdfBindingValue(row.o)?.startsWith('_:')) : [];
    const visibleBlanks = blankBindings.slice(0, blankBudget);
    const triples = [...bindings, ...visibleBlanks].map(row => ({
      subject: rdfBindingValue(row.s) ?? '', predicate: bv(row.p) ?? '', object: rdfBindingValue(row.o) ?? '',
      subGraph: subGraphOf(bv(row.g) ?? '', contextGraphId),
    })).filter(triple => triple.subject && triple.predicate && triple.object);
    return {
      triples, ok: true, truncated: clipped || names.length > 5,
      incomplete: blankBindings.length > blankBudget, rowCount: bindings.length + visibleBlanks.length,
      cursor: clipped ? cursorForRow(bindings.at(-1)!) : { kind: 'after-graph', graph: graphNames.at(-1)! },
    };
  } catch (error) {
    return { triples: [], ok: false, truncated: false, rowCount: 0, incomplete: error instanceof QueryResponseLimitError };
  }
}

/** Read a clicked resource directly, even when its facts fall outside the loaded graph pages. */
export async function fetchMemoryEntity(
  contextGraphId: string,
  uri: string,
  layer?: MemoryLayerKey,
  includeQueryCatalog = false,
): Promise<{ triples: LayeredTriple[]; partial: boolean }> {
  const target = canonicalEntityUri(uri);
  const blank = target.startsWith('_:');
  const definitions = definitionsForLayer(contextGraphId, layer, includeQueryCatalog);
  const results = await Promise.all(definitions.map(async definition => {
    const pattern = blank ? undefined : `{
      { ${sparqlIri(target)} ?p ?o BIND(${sparqlIri(target)} AS ?s) }
      UNION { ?s ?p ${sparqlIri(target)} BIND(${sparqlIri(target)} AS ?o) FILTER(?s != ${sparqlIri(target)}) }
    }`;
    // Bind IRIs to use the store's subject/object indexes. For a clicked blank
    // resource, inspect bounded returned terms rather than STR(blank) or an
    // existential _:label pattern that could match unrelated resources.
    const data = await postQueryDeduped({ sparql: memoryQuery(definition, {
      pattern, filters: blank ? 'FILTER(isBlank(?s) || isBlank(?o))' : '', limit: 1001,
    }), contextGraphId, includeContextGraphPartitions: true }, { maxAgeMs: UI_READ_MAX_AGE_MS, timeoutMs: 60_000 });
    const rows = data.result?.bindings ?? [];
    return { truncated: rows.length > 1000, triples: rows.slice(0, 1000).filter(row => !blank || rdfBindingValue(row.s) === target || rdfBindingValue(row.o) === target).map(row => ({
      subject: rdfBindingValue(row.s) ?? '', predicate: bv(row.p) ?? '', object: rdfBindingValue(row.o) ?? '',
      subGraph: subGraphOf(bv(row.g) ?? '', contextGraphId),
    })) };
  }));
  return {
    triples: results.flatMap((result, index) => result.triples.map(triple => ({ ...triple, layer: definitions[index].layer }))),
    partial: results.some(result => result.truncated),
  };
}
