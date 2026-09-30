import { DEFAULT_MAX_READ_BYTES, assertSafeIri } from '@origintrail-official/dkg-core';
import {
  BlazegraphStore,
  SparqlHttpStore,
  ExactGraphReadError,
  StoreResponseTooLargeError,
  findTripleStoreCapability,
  quadToNQuad,
  type Quad,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

/** These ceilings select a fast read; they never expand the accepted KA size. */
export const EXACT_GRAPH_EXPORT_MAX_ROWS = 16_384;
export const EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_HEAP_BYTES = 32 * 1024 * 1024;
const MAX_CANONICAL_BYTES = DEFAULT_MAX_READ_BYTES - 1024;
const MAX_EXACT_GRAPH_ROWS = 100_000;
const ENCODER = new TextEncoder();

function invalid(graphIri: string, message: string): ExactGraphReadError {
  return new ExactGraphReadError({
    kind: 'integrity', code: 'INVALID_QUERY_RESULT', graphIri, message,
  });
}

function mismatch(graphIri: string, expected: number, actual: number): ExactGraphReadError {
  return new ExactGraphReadError({
    kind: 'integrity', code: 'QUAD_COUNT_MISMATCH', graphIri,
    message: `Exact graph read count mismatch: expected ${expected}, found ${actual}`,
    expected, actual,
  });
}

async function readCount(
  store: TripleStore,
  graph: string,
  options: QueryOptions,
): Promise<number> {
  const result = await store.query(
    `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
    { ...options, maxResponseBytes: Math.min(options.maxResponseBytes ?? 64 * 1024, 64 * 1024) },
  );
  if (result.type !== 'bindings' || !Array.isArray(result.bindings) || result.bindings.length !== 1) {
    throw invalid(graph, 'Exact graph count expected one SELECT binding');
  }
  const raw = result.bindings[0]?.count;
  const match = typeof raw === 'string'
    ? /^(?:([0-9]+)|"([0-9]+)"(?:\^\^<[^>]+>)?)$/.exec(raw)
    : undefined;
  const digits = match?.[1] ?? match?.[2];
  if (digits === undefined) throw invalid(graph, 'Exact graph count is not a non-negative integer');
  const count = BigInt(digits);
  if (count > BigInt(MAX_EXACT_GRAPH_ROWS)) {
    throw new ExactGraphReadError({
      kind: 'limit', code: 'QUAD_COUNT_LIMIT_EXCEEDED', graphIri: graph,
      message: `Exact graph read exceeds quad limit: found ${count}, limit ${MAX_EXACT_GRAPH_ROWS}`,
      actual: count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : count,
      limit: MAX_EXACT_GRAPH_ROWS,
    });
  }
  return Number(count);
}

/**
 * Read one small exact graph in a single bounded HTTP result. The caller still
 * recomputes its Merkle root. Counts bracket the read exactly as in the existing
 * paged reader, and the overflow row detects a server ignoring the expected
 * cardinality. No verification result is cached across writes or operations.
 *
 * null means the fast read lacks a capability or exceeds a resource profile;
 * callers must use the existing bounded reader. Unknown/embedded adapters keep
 * that reader because maxResponseBytes is not a guaranteed pre-parse bound.
 */
export async function readBoundedExactGraphExport(
  store: TripleStore,
  graphIri: string,
  expectedRows: number,
  options: QueryOptions,
): Promise<Quad[] | null> {
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 0 || expectedRows > EXACT_GRAPH_EXPORT_MAX_ROWS) {
    return null;
  }
  const boundedHttp = findTripleStoreCapability(store, (candidate): candidate is BlazegraphStore | SparqlHttpStore => (
    candidate instanceof BlazegraphStore || candidate instanceof SparqlHttpStore
  ));
  if (!boundedHttp) return null;
  const graph = assertSafeIri(graphIri);
  const before = await readCount(store, graph, options);
  if (before !== expectedRows) throw mismatch(graph, expectedRows, before);
  let result;
  try {
    result = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } LIMIT ${expectedRows + 1}`,
      { ...options, maxResponseBytes: Math.min(
        options.maxResponseBytes ?? EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES,
        EXACT_GRAPH_EXPORT_MAX_RESPONSE_BYTES,
      ) },
    );
  } catch (error) {
    if (error instanceof StoreResponseTooLargeError) return null;
    throw error;
  }
  if (result.type !== 'bindings' || !Array.isArray(result.bindings)) {
    throw invalid(graph, 'Exact graph read expected SELECT bindings');
  }
  if (result.bindings.length > expectedRows + 1) {
    throw invalid(graph, 'Exact graph read exceeded its overflow LIMIT');
  }
  if (result.bindings.length !== expectedRows) {
    throw mismatch(graph, expectedRows, result.bindings.length);
  }
  const quads: Quad[] = [];
  const seen = new Set<string>();
  let canonicalBytes = 0;
  let heapBytes = 0;
  for (const row of result.bindings) {
    if (!row || typeof row.s !== 'string' || typeof row.p !== 'string' || typeof row.o !== 'string') {
      throw invalid(graph, 'Exact graph read received an incomplete binding');
    }
    // The paged reader owns blank-node document identity and its stricter bound.
    if (row.s.startsWith('_:') || row.o.startsWith('_:')) return null;
    const quad = { subject: row.s, predicate: row.p, object: row.o, graph: '' };
    const line = quadToNQuad(quad);
    if (seen.has(line)) throw invalid(graph, 'Exact graph read received a duplicate triple');
    canonicalBytes += (quads.length === 0 ? 0 : 1) + ENCODER.encode(line).byteLength;
    if (canonicalBytes > MAX_CANONICAL_BYTES) return null;
    // Include binding/quad/set overhead, retained term strings and N-Quads keys.
    heapBytes += 256 + 2 * (row.s.length + row.p.length + row.o.length + line.length);
    if (heapBytes > MAX_HEAP_BYTES) return null;
    seen.add(line);
    quads.push(quad);
  }
  const after = await readCount(store, graph, options);
  if (after !== expectedRows) throw mismatch(graph, expectedRows, after);
  return quads;
}
