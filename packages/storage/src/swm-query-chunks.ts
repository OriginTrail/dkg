/** Bounded backend queries and global SPO materialization for one SWM read. */
import { getMetrics } from '@origintrail-official/dkg-core';
import type { Quad, QueryOptions, TripleStore } from './triple-store.js';

export const SHARED_MEMORY_GRAPHS_PER_QUERY = 128;
export const BUDGETED_SHARED_MEMORY_GRAPHS_PER_QUERY = 16;

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
    ? graphs.length : plan.graphsPerQuery ?? (options.resultBudget
      ? BUDGETED_SHARED_MEMORY_GRAPHS_PER_QUERY : SHARED_MEMORY_GRAPHS_PER_QUERY));
  if (options.resultBudget) {
    return plan.kind === 'single-query'
      ? loadSingleQueryBudgeted(store, chunks[0]!, innerGraphPattern, queryOptions, options)
      : loadChunkedPaged(store, chunks, innerGraphPattern, queryOptions, options);
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

class BudgetedQuadCollector {
  readonly quads: Quad[] = [];
  private readonly seen = new Set<string>();
  private rawRows = 0;
  private bytesEstimate = 0;

  constructor(
    private readonly maxRows: number,
    private readonly maxBytesEstimate: number,
    private readonly source: string,
    private readonly quadFilter?: (quad: Quad) => boolean,
  ) {}

  ingest(rows: readonly Record<string, string>[]): void {
    for (const row of rows) {
      const subject = row['s'];
      const predicate = row['p'];
      const object = row['o'];
      if (!subject || !predicate || !object) continue;
      const key = JSON.stringify([subject, predicate, object]);
      if (this.seen.has(key)) continue;
      const nextRows = this.rawRows + 1;
      if (nextRows > this.maxRows) {
        this.observe();
        throw new SharedMemoryResultBudgetError('rows', nextRows, this.bytesEstimate, this.maxRows);
      }
      const quad: Quad = { subject, predicate, object, graph: '' };
      const retain = !this.quadFilter || this.quadFilter(quad);
      const nextBytes = this.bytesEstimate + 64 + 2 * key.length
        + (retain ? estimateQuadHeapBytes(quad) : 0);
      if (nextBytes > this.maxBytesEstimate) {
        this.observe();
        throw new SharedMemoryResultBudgetError('bytes', nextRows, nextBytes, this.maxBytesEstimate);
      }
      this.seen.add(key);
      this.rawRows = nextRows;
      this.bytesEstimate = nextBytes;
      if (retain) this.quads.push(quad);
    }
  }

  rowLimitExceeded(): never {
    this.observe();
    throw new SharedMemoryResultBudgetError('rows', this.maxRows + 1, this.bytesEstimate, this.maxRows);
  }

  finish(sort: boolean): Quad[] {
    this.observe();
    return sort ? this.quads.sort(compareSpo) : this.quads;
  }

  private observe(): void {
    getMetrics().storeQueryResultRows.record(this.rawRows, { source: this.source });
    getMetrics().storeQueryResultBytesEstimate.record(this.bytesEstimate, { source: this.source });
  }
}

function budgetCollector(options: SwmMaterializationOptions, queryOptions?: QueryOptions): BudgetedQuadCollector {
  const configured = options.resultBudget!;
  return new BudgetedQuadCollector(
    normalizePositiveInteger(configured.maxRows, normalizePositiveInteger(configured.pageRows, 1_000)),
    normalizePositiveInteger(configured.maxBytesEstimate, 64 * 1024 * 1024),
    queryOptions?.source ?? 'unknown',
    options.quadFilter,
  );
}

async function loadChunkedPaged(
  store: Pick<TripleStore, 'query'>,
  chunks: string[],
  innerGraphPattern: string,
  queryOptions: QueryOptions | undefined,
  options: SwmMaterializationOptions,
): Promise<Quad[]> {
  const configured = options.resultBudget!;
  const pageRows = normalizePositiveInteger(configured.pageRows, 1_000);
  const collector = budgetCollector(options, queryOptions);

  for (const values of chunks) {
    for (let offset = 0; ; offset += pageRows) {
      const result = await store.query(`SELECT DISTINCT ?s ?p ?o WHERE {
        VALUES ?g { ${values} }
        GRAPH ?g { ${innerGraphPattern} }
      }
      ORDER BY ?s ?p ?o
      OFFSET ${offset}
      LIMIT ${pageRows}`, queryOptions);
      if (result.type !== 'bindings' || result.bindings.length === 0) break;
      collector.ingest(result.bindings);
      if (result.bindings.length < pageRows) break;
    }
  }
  return collector.finish(chunks.length > 1);
}

async function loadSingleQueryBudgeted(
  store: Pick<TripleStore, 'query'>,
  values: string,
  innerGraphPattern: string,
  queryOptions: QueryOptions | undefined,
  options: SwmMaterializationOptions,
): Promise<Quad[]> {
  const configured = options.resultBudget!;
  const maxRows = normalizePositiveInteger(
    configured.maxRows, normalizePositiveInteger(configured.pageRows, 1_000));
  const maxBytesEstimate = normalizePositiveInteger(configured.maxBytesEstimate, 64 * 1024 * 1024);
  const limit = Math.min(Number.MAX_SAFE_INTEGER, maxRows + 1);
  // Cap the raw response before JSON parsing as well as the materialized rows.
  const readOptions = {
    ...queryOptions,
    maxResponseBytes: Math.min(
      queryOptions?.maxResponseBytes ?? Number.MAX_SAFE_INTEGER,
      Math.min(Number.MAX_SAFE_INTEGER, 4 * maxBytesEstimate + 1024 * 1024),
    ),
  };
  const result = await store.query(`SELECT DISTINCT ?s ?p ?o WHERE {
    VALUES ?g { ${values} }
    GRAPH ?g { ${innerGraphPattern} }
  }
  ORDER BY ?s ?p ?o
  OFFSET 0
  LIMIT ${limit}`, readOptions);
  const collector = budgetCollector(options, queryOptions);
  if (result.type !== 'bindings') return collector.finish(false);
  collector.ingest(result.bindings);
  if (result.bindings.length === limit) collector.rowLimitExceeded();
  return collector.finish(false);
}
