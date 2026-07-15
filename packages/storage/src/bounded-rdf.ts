import {
  DEFAULT_MAX_READ_BYTES,
  assertSafeIri,
} from '@origintrail-official/dkg-core';
import type {
  Quad,
  QueryOptions,
  TripleStore,
} from './triple-store.js';

const DEFAULT_EXACT_GRAPH_PAGE_SIZE = 256;
const DEFAULT_EXACT_GRAPH_MAX_QUADS = 100_000;
const DEFAULT_EXACT_GRAPH_MAX_NQUADS_BYTES = DEFAULT_MAX_READ_BYTES - 1024;
const UTF8_ENCODER = new TextEncoder();

export interface ReadExactGraphPagedOptions {
  expectedQuadCount: number;
  pageSize?: number;
  maxQuadCount?: number;
  maxNQuadsBytes?: number;
  outputGraph?: string;
  queryOptions?: QueryOptions;
}

type ReadExactGraphPagedWithDiscoveredCountOptions = Omit<
  ReadExactGraphPagedOptions,
  'expectedQuadCount'
>;

export type ExactGraphReadErrorKind = 'limit' | 'integrity';

export type ExactGraphReadErrorCode =
  | 'QUAD_COUNT_LIMIT_EXCEEDED'
  | 'NQUADS_BYTE_LIMIT_EXCEEDED'
  | 'QUAD_COUNT_MISMATCH'
  | 'INVALID_QUERY_RESULT';

/** A machine-classifiable failure from a bounded exact-graph read. */
export class ExactGraphReadError extends Error {
  readonly kind: ExactGraphReadErrorKind;
  readonly code: ExactGraphReadErrorCode;
  readonly graphIri: string;
  readonly expected?: number;
  readonly actual?: number | bigint;
  readonly limit?: number;

  constructor(params: {
    kind: ExactGraphReadErrorKind;
    code: ExactGraphReadErrorCode;
    graphIri: string;
    message: string;
    expected?: number;
    actual?: number | bigint;
    limit?: number;
  }) {
    super(params.message);
    this.name = 'ExactGraphReadError';
    this.kind = params.kind;
    this.code = params.code;
    this.graphIri = params.graphIri;
    this.expected = params.expected;
    this.actual = params.actual;
    this.limit = params.limit;
  }
}

/** Render one storage {@link Quad} as a canonical N-Quads line. */
export function quadToNQuad(quad: Quad): string {
  const graph = quad.graph ? ` ${termToNQuad(quad.graph)}` : '';
  return `${termToNQuad(quad.subject)} ${iriToNQuad(quad.predicate)} ${termToNQuad(quad.object)}${graph} .`;
}

/** Render storage quads as newline-delimited N-Quads without a trailing newline. */
export function quadsToNQuads(quads: readonly Quad[]): string {
  return quads.map(quadToNQuad).join('\n');
}

/**
 * Read one exact named graph in deterministic pages.
 *
 * The returned graph term is caller-selectable because private access serves
 * graphless N-Quads while sync/query callers retain the source named graph.
 */
export async function readExactGraphPaged(
  store: TripleStore,
  graphIri: string,
  options: ReadExactGraphPagedOptions,
): Promise<Quad[]> {
  return readExactGraphPagedInternal(store, graphIri, options);
}

/** Internal compatibility path for callers that do not yet own a trusted count. */
export async function readExactGraphPagedWithDiscoveredCount(
  store: TripleStore,
  graphIri: string,
  options: ReadExactGraphPagedWithDiscoveredCountOptions = {},
): Promise<Quad[]> {
  return readExactGraphPagedInternal(store, graphIri, options);
}

async function readExactGraphPagedInternal(
  store: TripleStore,
  graphIri: string,
  options: ReadExactGraphPagedOptions | ReadExactGraphPagedWithDiscoveredCountOptions,
): Promise<Quad[]> {
  const graph = assertSafeIri(graphIri);
  const requestedPageSize = positiveSafeInteger(
    options.pageSize ?? DEFAULT_EXACT_GRAPH_PAGE_SIZE,
    'pageSize',
  );
  // The adapter materializes one whole SELECT result before this function can
  // inspect its byte size. Keep that unavoidable transient page hard-bounded.
  const pageSize = Math.min(requestedPageSize, DEFAULT_EXACT_GRAPH_PAGE_SIZE);
  const maxQuadCount = nonNegativeSafeInteger(
    options.maxQuadCount ?? DEFAULT_EXACT_GRAPH_MAX_QUADS,
    'maxQuadCount',
  );
  const maxNQuadsBytes = nonNegativeSafeInteger(
    options.maxNQuadsBytes ?? DEFAULT_EXACT_GRAPH_MAX_NQUADS_BYTES,
    'maxNQuadsBytes',
  );
  const maxPageResponseBytes = Math.min(
    options.queryOptions?.maxResponseBytes ?? DEFAULT_MAX_READ_BYTES,
    DEFAULT_MAX_READ_BYTES,
    Math.max(64 * 1024, maxNQuadsBytes + 64 * 1024),
  );
  const boundedQueryOptions: QueryOptions = {
    ...options.queryOptions,
    maxResponseBytes: maxPageResponseBytes,
  };
  const configuredExpectedQuadCount = 'expectedQuadCount' in options
    ? nonNegativeSafeInteger(options.expectedQuadCount, 'expectedQuadCount')
    : undefined;
  if (
    configuredExpectedQuadCount !== undefined
    && configuredExpectedQuadCount > maxQuadCount
  ) {
    throw new ExactGraphReadError({
      kind: 'limit',
      code: 'QUAD_COUNT_LIMIT_EXCEEDED',
      graphIri: graph,
      message: `Exact graph read exceeds quad limit: expected ${configuredExpectedQuadCount}, limit ${maxQuadCount}`,
      actual: configuredExpectedQuadCount,
      limit: maxQuadCount,
    });
  }

  const preflightQuadCount = await queryExactGraphCount(
    store,
    graph,
    maxQuadCount,
    boundedQueryOptions,
  );
  const expectedQuadCount = configuredExpectedQuadCount ?? preflightQuadCount;
  if (
    configuredExpectedQuadCount !== undefined
    && preflightQuadCount !== configuredExpectedQuadCount
  ) {
    throw quadCountMismatch(graph, configuredExpectedQuadCount, preflightQuadCount);
  }

  const quads: Quad[] = [];
  const seenNQuadLines = new Set<string>();
  let nquadsBytes = 0;
  let offset = 0;
  for (;;) {
    const remainingWithOverflowSentinel = expectedQuadCount - quads.length + 1;
    const pageLimit = Math.min(pageSize, remainingWithOverflowSentinel);
    const result = await store.query(
      `SELECT ?s ?p ?o WHERE {
        GRAPH <${graph}> { ?s ?p ?o }
      }
      ORDER BY ?s ?p ?o
      LIMIT ${pageLimit}
      OFFSET ${offset}`,
      boundedQueryOptions,
    );
    if (result.type !== 'bindings') {
      throw invalidQueryResult(graph, 'Exact graph read expected SELECT bindings');
    }
    if (!Array.isArray(result.bindings)) {
      throw invalidQueryResult(graph, 'Exact graph read bindings are not an array');
    }
    if (result.bindings.length > pageLimit) {
      throw invalidQueryResult(
        graph,
        `Exact graph read page exceeded LIMIT ${pageLimit}: found ${result.bindings.length} bindings`,
      );
    }
    for (const rawRow of result.bindings) {
      if (typeof rawRow !== 'object' || rawRow === null) {
        throw invalidQueryResult(graph, 'Exact graph read received an invalid binding');
      }
      const row = rawRow as Record<string, unknown>;
      const subject = row['s'];
      const predicate = row['p'];
      const object = row['o'];
      if (
        typeof subject !== 'string'
        || typeof predicate !== 'string'
        || typeof object !== 'string'
      ) {
        throw invalidQueryResult(graph, 'Exact graph read received an incomplete binding');
      }
      const quad: Quad = {
        subject,
        predicate,
        object,
        graph: options.outputGraph ?? graph,
      };
      const nquadLine = quadToNQuad(quad);
      if (seenNQuadLines.has(nquadLine)) {
        throw invalidQueryResult(
          graph,
          'Exact graph read received a duplicate triple across ordered pages',
        );
      }
      seenNQuadLines.add(nquadLine);
      nquadsBytes +=
        (quads.length === 0 ? 0 : 1) +
        UTF8_ENCODER.encode(nquadLine).byteLength;
      if (nquadsBytes > maxNQuadsBytes) {
        throw new ExactGraphReadError({
          kind: 'limit',
          code: 'NQUADS_BYTE_LIMIT_EXCEEDED',
          graphIri: graph,
          message: `Exact graph read exceeds N-Quads byte limit: found ${nquadsBytes}, limit ${maxNQuadsBytes}`,
          actual: nquadsBytes,
          limit: maxNQuadsBytes,
        });
      }
      quads.push(quad);
    }
    if (quads.length > expectedQuadCount) {
      throw quadCountMismatch(graph, expectedQuadCount, quads.length);
    }
    if (result.bindings.length < pageLimit) break;
    offset += pageLimit;
  }

  if (quads.length !== expectedQuadCount) {
    throw quadCountMismatch(graph, expectedQuadCount, quads.length);
  }
  const postflightQuadCount = await queryExactGraphCount(
    store,
    graph,
    maxQuadCount,
    boundedQueryOptions,
  );
  if (postflightQuadCount !== expectedQuadCount) {
    throw quadCountMismatch(graph, expectedQuadCount, postflightQuadCount);
  }
  return quads;
}

function termToNQuad(term: string): string {
  if (term.startsWith('"')) return normalizeBareLiteralDatatype(term);
  if (term.startsWith('_:')) return term;
  return iriToNQuad(term);
}

function iriToNQuad(iri: string): string {
  return iri.startsWith('<') && iri.endsWith('>') ? iri : `<${iri}>`;
}

function normalizeBareLiteralDatatype(term: string): string {
  const bareDatatype = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
  return bareDatatype
    ? `${bareDatatype[1]}^^${iriToNQuad(bareDatatype[2])}`
    : term;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function quadCountMismatch(
  graphIri: string,
  expected: number,
  actual: number,
): ExactGraphReadError {
  return new ExactGraphReadError({
    kind: 'integrity',
    code: 'QUAD_COUNT_MISMATCH',
    graphIri,
    message: `Exact graph read count mismatch: expected ${expected}, found ${actual}`,
    expected,
    actual,
  });
}

function invalidQueryResult(graphIri: string, message: string): ExactGraphReadError {
  return new ExactGraphReadError({
    kind: 'integrity',
    code: 'INVALID_QUERY_RESULT',
    graphIri,
    message,
  });
}

async function queryExactGraphCount(
  store: TripleStore,
  graphIri: string,
  maxQuadCount: number,
  queryOptions: QueryOptions | undefined,
): Promise<number> {
  const result = await store.query(
    `SELECT (COUNT(*) AS ?count) WHERE {
      GRAPH <${graphIri}> { ?s ?p ?o }
    }`,
    queryOptions,
  );
  if (
    result.type !== 'bindings'
    || !Array.isArray(result.bindings)
    || result.bindings.length !== 1
  ) {
    throw invalidQueryResult(graphIri, 'Exact graph count expected one SELECT binding');
  }
  const row: unknown = result.bindings[0];
  if (typeof row !== 'object' || row === null) {
    throw invalidQueryResult(graphIri, 'Exact graph count received an invalid binding');
  }
  const raw = (row as Record<string, unknown>)['count'];
  if (typeof raw !== 'string') {
    throw invalidQueryResult(graphIri, 'Exact graph count binding is not a string');
  }
  const match = raw.match(/^(?:([0-9]+)|"([0-9]+)"(?:\^\^<[^>]+>)?)$/);
  const digits = match?.[1] ?? match?.[2];
  if (digits === undefined) {
    throw invalidQueryResult(graphIri, `Exact graph count is not a non-negative integer: ${raw}`);
  }
  const count = BigInt(digits);
  if (count > BigInt(maxQuadCount)) {
    const actual = count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : count;
    throw new ExactGraphReadError({
      kind: 'limit',
      code: 'QUAD_COUNT_LIMIT_EXCEEDED',
      graphIri,
      message: `Exact graph read exceeds quad limit: found ${count}, limit ${maxQuadCount}`,
      actual,
      limit: maxQuadCount,
    });
  }
  return Number(count);
}
