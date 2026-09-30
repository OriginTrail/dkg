/** Bounded backend queries and global SPO materialization for one SWM read. */
import { getMetrics } from '@origintrail-official/dkg-core';
import type { Quad, QueryOptions, TripleStore } from './triple-store.js';

export const SHARED_MEMORY_GRAPHS_PER_QUERY = 128;

export interface SharedMemoryResultBudget {
  pageRows: number;
  maxRows: number;
  maxBytesEstimate: number;
}

export interface SwmMaterializationOptions {
  resultBudget?: SharedMemoryResultBudget;
  quadFilter?: (quad: Quad) => boolean;
}

export type SwmReadPlan =
  | { kind: 'chunked'; graphsPerQuery?: number }
  | { kind: 'single-query' };

export class SharedMemoryResultBudgetError extends Error {
  readonly code = 'SHARED_MEMORY_RESULT_BUDGET' as const;
  readonly retryable = true as const;

  constructor(
    readonly reason: 'rows' | 'bytes',
    readonly rows: number,
    readonly bytesEstimate: number,
    readonly limit: number,
  ) {
    super(`Shared-memory result exceeded ${reason} budget ` +
      `(rows=${rows}, bytesEstimate=${bytesEstimate}, limit=${limit})`);
    this.name = 'SharedMemoryResultBudgetError';
  }
}

function graphValueChunks(graphs: readonly string[], graphsPerQuery: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < graphs.length; i += graphsPerQuery) {
    chunks.push(graphs.slice(i, i + graphsPerQuery).map((g) => `<${g}>`).join(' '));
  }
  return chunks;
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function estimateQuadHeapBytes(quad: Quad): number {
  return 96 + 2 * (
    quad.subject.length + quad.predicate.length + quad.object.length + quad.graph.length
  );
}

function compareSpo(a: Quad, b: Quad): number {
  for (const field of ['subject', 'predicate', 'object'] as const) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  return 0;
}

/** The one identity/merge boundary shared by paged and CONSTRUCT reads. */
export async function loadSwmQuadsAcrossChunks(
  store: Pick<TripleStore, 'query'>,
  graphs: readonly string[],
  innerGraphPattern: string,
  queryOptions: QueryOptions | undefined,
  options: SwmMaterializationOptions,
  plan: SwmReadPlan = { kind: 'chunked' },
): Promise<Quad[]> {
  const chunks = graphValueChunks(graphs, plan.kind === 'single-query'
    ? graphs.length : plan.graphsPerQuery ?? SHARED_MEMORY_GRAPHS_PER_QUERY);
  if (options.resultBudget) {
    return loadPaged(store, chunks, innerGraphPattern, queryOptions, options, plan.kind === 'single-query');
  }
  const distinct = new Map<string, Quad>();
  // At most two backend slots for unbudgeted CONSTRUCT. Budgeted pages must
  // stay serial so the row and byte ceilings are enforced before the next page.
  for (let i = 0; i < chunks.length; i += 2) {
    const results = await Promise.all(chunks.slice(i, i + 2).map((values) =>
      store.query(`CONSTRUCT { ?s ?p ?o } WHERE {
        VALUES ?g { ${values} }
        GRAPH ?g { ${innerGraphPattern} }
      }`, queryOptions)));
    for (const result of results) {
      if (result.type !== 'quads') continue;
      for (const quad of result.quads) {
        if (options.quadFilter && !options.quadFilter(quad)) continue;
        distinct.set(JSON.stringify([quad.subject, quad.predicate, quad.object]), quad);
      }
    }
  }
  return [...distinct.values()];
}

async function loadPaged(
  store: Pick<TripleStore, 'query'>,
  chunks: string[],
  innerGraphPattern: string,
  queryOptions: QueryOptions | undefined,
  options: SwmMaterializationOptions,
  singleQueryBudgeted: boolean,
): Promise<Quad[]> {
  const configured = options.resultBudget!;
  const configuredPageRows = normalizePositiveInteger(configured.pageRows, 1_000);
  const maxRows = normalizePositiveInteger(configured.maxRows, configuredPageRows);
  const pageRows = singleQueryBudgeted
    ? Math.min(Number.MAX_SAFE_INTEGER, maxRows + 1)
    : configuredPageRows;
  const maxBytesEstimate = normalizePositiveInteger(configured.maxBytesEstimate, 64 * 1024 * 1024);
  // One snapshot-consistent SELECT must also cap its raw HTTP body before JSON
  // parsing. Four times the heap estimate allows escaping and JSON framing.
  const readOptions = singleQueryBudgeted ? {
    ...queryOptions,
    maxResponseBytes: Math.min(
      queryOptions?.maxResponseBytes ?? Number.MAX_SAFE_INTEGER,
      Math.min(Number.MAX_SAFE_INTEGER, 4 * maxBytesEstimate + 1024 * 1024),
    ),
  } : queryOptions;
  const quads: Quad[] = [];
  const seen = new Set<string>();
  let rawRows = 0;
  let bytesEstimate = 0;
  const source = queryOptions?.source ?? 'unknown';
  const observe = () => {
    getMetrics().storeQueryResultRows.record(rawRows, { source });
    getMetrics().storeQueryResultBytesEstimate.record(bytesEstimate, { source });
  };

  for (const values of chunks) {
    for (let offset = 0; ; offset += pageRows) {
      const result = await store.query(`SELECT DISTINCT ?s ?p ?o WHERE {
        VALUES ?g { ${values} }
        GRAPH ?g { ${innerGraphPattern} }
      }
      ORDER BY ?s ?p ?o
      OFFSET ${offset}
      LIMIT ${pageRows}`, readOptions);
      if (result.type !== 'bindings' || result.bindings.length === 0) break;

      for (const row of result.bindings) {
        const subject = row['s'];
        const predicate = row['p'];
        const object = row['o'];
        if (!subject || !predicate || !object) continue;
        const key = JSON.stringify([subject, predicate, object]);
        if (seen.has(key)) continue;
        const nextRows = rawRows + 1;
        if (nextRows > maxRows) {
          observe();
          throw new SharedMemoryResultBudgetError('rows', nextRows, bytesEstimate, maxRows);
        }
        const quad: Quad = { subject, predicate, object, graph: '' };
        const retain = !options.quadFilter || options.quadFilter(quad);
        // The Set keeps this identity even for a filtered Quad. Count its
        // serialized string and hash entry before retaining either allocation.
        const nextBytes = bytesEstimate + 64 + 2 * key.length
          + (retain ? estimateQuadHeapBytes(quad) : 0);
        if (nextBytes > maxBytesEstimate) {
          observe();
          throw new SharedMemoryResultBudgetError('bytes', nextRows, nextBytes, maxBytesEstimate);
        }
        seen.add(key);
        rawRows = nextRows;
        bytesEstimate = nextBytes;
        if (retain) quads.push(quad);
      }
      if (singleQueryBudgeted && result.bindings.length === pageRows) {
        observe();
        throw new SharedMemoryResultBudgetError('rows', maxRows + 1, bytesEstimate, maxRows);
      }
      if (singleQueryBudgeted || result.bindings.length < pageRows) break;
    }
  }
  observe();
  return chunks.length === 1 ? quads : quads.sort(compareSpo);
}
