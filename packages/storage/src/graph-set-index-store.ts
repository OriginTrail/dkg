import { performance } from 'node:perf_hooks';
import type { Quad, QueryOptions, QueryResult, StorePressureSnapshot, TripleStore, UpdateOptions } from './triple-store.js';

export const DEFAULT_GRAPH_SET_REVALIDATE_MS = 30_000;

export type GraphSetMutationSource =
  | 'seed'
  | 'revalidate'
  | 'insert'
  | 'delete'
  | 'deleteByPattern'
  | 'deleteBySubjectPrefix'
  | 'dropGraph'
  | 'query'
  | 'update';

type GraphSetRefreshSource = 'seed' | 'revalidate' | 'deleteByPattern' | 'query' | 'update';
type PendingFullRefreshSource = 'deleteByPattern' | 'query' | 'update';

export type GraphSetMutationEvent =
  | {
      type: 'graph-added';
      graph: string;
      source: GraphSetMutationSource;
    }
  | {
      type: 'graph-removed';
      graph: string;
      source: GraphSetMutationSource;
    }
  | {
      type: 'graph-set-revalidated';
      added: string[];
      removed: string[];
      source: GraphSetRefreshSource;
    };

export interface GraphSetIndexStoreOptions {
  enabled?: boolean;
  /** Revalidate after this interval. Use 0 to revalidate on every read. */
  revalidateMs?: number;
  now?: () => number;
  onMutation?: (event: GraphSetMutationEvent) => void;
}

/**
 * Write-through named-graph index for stores whose `listGraphs()` implementation
 * is a full-store scan. The index follows the repo's existing graph semantics:
 * only graphs containing at least one quad are listed; empty `createGraph()`
 * calls are not visible until data is inserted.
 */
export class GraphSetIndexStore implements TripleStore {
  get queryCancellation() {
    return this.inner.queryCancellation;
  }

  getPressureSnapshot(): StorePressureSnapshot | undefined {
    return this.inner.getPressureSnapshot?.();
  }

  private readonly inner: TripleStore;
  private readonly enabled: boolean;
  private readonly revalidateMs: number;
  private readonly now: () => number;
  private readonly onMutation?: (event: GraphSetMutationEvent) => void;

  private graphs: Set<string> | null = null;
  private validatedAt = 0;
  private mutationGeneration = 0;
  private refreshInFlight: Promise<Set<string>> | null = null;
  /**
   * Pending full rebuild requested by a mutation whose exact graph effects can't
   * be applied incrementally. The stored source preserves the observer contract
   * while deferring expensive full-store scans until the next graph read.
   */
  private pendingFullRefresh: PendingFullRefreshSource | null = null;

  constructor(inner: TripleStore, options: GraphSetIndexStoreOptions = {}) {
    this.inner = inner;
    this.enabled = options.enabled !== false;
    this.revalidateMs = Math.max(0, options.revalidateMs ?? DEFAULT_GRAPH_SET_REVALIDATE_MS);
    this.now = options.now ?? (() => performance.now());
    this.onMutation = options.onMutation;
  }

  async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    if (!this.enabled) {
      await this.inner.insert(quads, options);
      return;
    }
    await this.inner.insert(quads, options);
    const touched = namedGraphsFromQuads(quads);
    if (touched.length === 0) return;
    this.bumpMutation();
    this.addGraphs(touched, 'insert');
  }

  async delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    if (!this.enabled) {
      await this.inner.delete(quads, options);
      return;
    }
    await this.inner.delete(quads, options);
    const touched = namedGraphsFromQuads(quads);
    if (touched.length === 0) return;
    this.bumpMutation();
    await this.maintainIndex(() => this.refreshTouchedGraphs(touched, 'delete', options));
  }

  async deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    if (!this.enabled) {
      return this.inner.deleteByPattern(pattern, options);
    }
    const removed = await this.inner.deleteByPattern(pattern, options);
    if (removed <= 0) return removed;
    const graph = pattern.graph;
    if (graph) {
      this.bumpMutation();
      await this.maintainIndex(() => this.refreshTouchedGraphs([graph], 'deleteByPattern', options));
    } else {
      // No target graph → can't know which graphs emptied; defer to a single
      // lazy rebuild on the next read instead of a full scan now.
      this.scheduleFullRefresh('deleteByPattern');
    }
    return removed;
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    if (!this.enabled) {
      return this.inner.query(sparql, options);
    }
    const result = await this.inner.query(sparql, options);
    if (isSparqlUpdate(sparql)) {
      // A SPARQL UPDATE through query() may create/drop named graphs we can't
      // derive incrementally — query() is the READ-path type and carries no
      // index-maintenance hint (that lives on `update(…, UpdateOptions.touchedGraphs)`).
      // Mark dirty for a single lazy rebuild on the next read instead of re-scanning
      // the whole store now (the eager per-UPDATE scan thrashed large stores).
      this.scheduleFullRefresh('query');
    }
    return result;
  }

  async update(sparql: string, options?: UpdateOptions): Promise<void> {
    if (typeof this.inner.update !== 'function') {
      throw new Error('GraphSetIndexStore: inner store does not support update()');
    }
    if (!this.enabled) {
      await this.inner.update(sparql, options);
      return;
    }
    await this.inner.update(sparql, options);
    // A server-side SPARQL UPDATE (e.g. the RS heal's INSERT…WHERE) can create or
    // drop named graphs the index must learn about. When the caller declares the
    // touched graphs (#1549: RS-heal + agents-meta prune write statically-known
    // URIs), maintain the index INCREMENTALLY — a bounded per-graph `hasGraph`
    // (which correctly handles an ASK-guarded INSERT that matched zero rows) —
    // instead of marking the whole index dirty. That keeps the index warm so
    // graph enumeration stays O(1) rather than forcing a full store scan on the
    // next read. Only opaque updates (no `touchedGraphs`) fall back to the lazy
    // full rebuild.
    if (this.enabled && options?.touchedGraphs && options.touchedGraphs.length > 0) {
      this.bumpMutation();
      await this.maintainIndex(() =>
        this.refreshTouchedGraphs([...options.touchedGraphs!], 'update', options),
      );
      return;
    }
    this.scheduleFullRefresh('update');
  }

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    if (!this.enabled) {
      return this.inner.hasGraph(graphUri, options);
    }
    if (this.pendingFullRefresh) {
      return (await this.ensureGraphSet(options)).has(graphUri);
    }
    const hasGraph = await this.inner.hasGraph(graphUri, options);
    const indexed = this.graphs?.has(graphUri);
    if (this.graphs && indexed !== hasGraph) {
      this.bumpMutation();
      if (hasGraph) this.addGraphs([graphUri], 'revalidate');
      else this.removeGraphs([graphUri], 'revalidate');
    }
    return hasGraph;
  }

  async createGraph(graphUri: string): Promise<void> {
    await this.inner.createGraph(graphUri);
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    if (!this.enabled) {
      await this.inner.dropGraph(graphUri, options);
      return;
    }
    await this.inner.dropGraph(graphUri, options);
    this.bumpMutation();
    this.removeGraphs([graphUri], 'dropGraph');
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    if (!this.enabled) {
      return this.inner.listGraphs(options);
    }
    const graphs = await this.ensureGraphSet(options);
    return [...graphs];
  }

  async listGraphsByPrefix(prefix: string, options?: QueryOptions): Promise<string[]> {
    if (!this.enabled) {
      if (this.inner.listGraphsByPrefix) {
        return this.inner.listGraphsByPrefix(prefix, options);
      }
      return (await this.inner.listGraphs(options)).filter((graph) => graph.startsWith(prefix));
    }
    const graphs = await this.ensureGraphSet(options);
    return [...graphs].filter((graph) => graph.startsWith(prefix));
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    if (!this.enabled) {
      return this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
    }
    const removed = await this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
    if (removed <= 0) return removed;
    this.bumpMutation();
    await this.maintainIndex(() => this.refreshTouchedGraphs([graphUri], 'deleteBySubjectPrefix', options));
    return removed;
  }

  async countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    return this.inner.countQuads(graphUri, options);
  }

  async flush(options?: QueryOptions): Promise<void> {
    await this.inner.flush?.(options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  private async ensureGraphSet(options?: QueryOptions): Promise<Set<string>> {
    throwIfAborted(options?.signal);
    if (
      this.graphs &&
      !this.pendingFullRefresh &&
      this.revalidateMs > 0 &&
      this.now() - this.validatedAt < this.revalidateMs
    ) {
      return this.graphs;
    }
    return raceAgainstAbort(
      this.refreshIndex(this.pendingFullRefresh ?? (this.graphs ? 'revalidate' : 'seed'), options),
      options?.signal,
    );
  }

  private async refreshIndex(source: GraphSetRefreshSource, options?: QueryOptions): Promise<Set<string>> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const task = this.refreshIndexLoop(source, options);
    this.refreshInFlight = task;
    try {
      return await task;
    } finally {
      if (this.refreshInFlight === task) this.refreshInFlight = null;
    }
  }

  private async refreshIndexLoop(source: GraphSetRefreshSource, options?: QueryOptions): Promise<Set<string>> {
    for (;;) {
      const isDirtyRebuild = this.pendingFullRefresh != null;
      const sourceForScan = this.pendingFullRefresh ?? source;
      const generation = this.mutationGeneration;
      // #1549: force the bulk full-store `SELECT DISTINCT ?g` rebuild onto the
      // BACKGROUND lane ONLY when it is a DIRTY rebuild (an opaque server-side UPDATE
      // marked the index dirty). Such a rebuild would otherwise inherit an
      // `ack`-priority reader's `options` and run the full scan on the scarce reserved
      // ACK slot, head-of-line-blocking other ACK work. A SEED (cold start) or
      // REVALIDATE refresh is genuinely part of serving the caller — an `ack` read's
      // seed scan SHOULD use the reserved ACK lane — so it keeps the caller's
      // priority/source. Cancellation (`signal`) is preserved either way. (With L1
      // keeping the index warm at source, dirty rebuilds are rare.)
      const scanOptions: QueryOptions | undefined = isDirtyRebuild
        ? { ...options, priority: 'background', source: 'graph-set-index.rebuild' }
        : options;
      const next = new Set((await this.inner.listGraphs(scanOptions)).filter(Boolean));
      if (generation !== this.mutationGeneration) continue;
      // This scan reflects every mutation up to `generation` (synchronous from
      // here — no await — so a concurrent write can't slip between the check and
      // the clear; if one had, it would have bumped the generation above and we
      // would have retried, preserving the pending refresh source for the next
      // scan attempt).
      this.pendingFullRefresh = null;
      this.replaceGraphSet(next, sourceForScan);
      return this.graphs!;
    }
  }

  private bumpMutation(): void {
    this.mutationGeneration++;
  }

  private scheduleFullRefresh(source: PendingFullRefreshSource): void {
    this.bumpMutation();
    this.pendingFullRefresh ??= source;
  }

  private async maintainIndex(task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch {
      this.clearIndex();
    }
  }

  private clearIndex(): void {
    this.graphs = null;
    this.validatedAt = 0;
  }

  private replaceGraphSet(next: Set<string>, source: GraphSetRefreshSource): void {
    const previous = this.graphs ?? new Set<string>();
    const added = [...next].filter((graph) => !previous.has(graph)).sort();
    const removed = [...previous].filter((graph) => !next.has(graph)).sort();
    this.graphs = next;
    this.validatedAt = this.now();
    if (added.length > 0 || removed.length > 0 || source !== 'seed') {
      this.emit({ type: 'graph-set-revalidated', added, removed, source });
    }
  }

  private addGraphs(graphs: string[], source: GraphSetMutationSource): void {
    if (!this.graphs) return;
    for (const graph of graphs) {
      if (!graph || this.graphs.has(graph)) continue;
      this.graphs.add(graph);
      this.emit({ type: 'graph-added', graph, source });
    }
  }

  private removeGraphs(graphs: string[], source: GraphSetMutationSource): void {
    if (!this.graphs) return;
    for (const graph of graphs) {
      if (!graph || !this.graphs.delete(graph)) continue;
      this.emit({ type: 'graph-removed', graph, source });
    }
  }

  private async refreshTouchedGraphs(
    graphs: string[],
    source: GraphSetMutationSource,
    options?: QueryOptions,
  ): Promise<void> {
    if (!this.graphs) return;
    for (const graph of graphs) {
      if (!graph) continue;
      if (await this.inner.hasGraph(graph, options)) {
        this.addGraphs([graph], source);
      } else {
        this.removeGraphs([graph], source);
      }
    }
  }

  private emit(event: GraphSetMutationEvent): void {
    try {
      this.onMutation?.(event);
    } catch {
      // Observability hooks must not make already-committed store writes fail.
    }
  }
}

function namedGraphsFromQuads(quads: Quad[]): string[] {
  return [...new Set(quads.map((quad) => quad.graph).filter(Boolean))];
}

function isSparqlUpdate(sparql: string): boolean {
  const withoutPrologue = sparql
    .trimStart()
    .replace(/^(?:(?:#[^\r\n]*(?:\r?\n|$))|(?:PREFIX\s+(?:[A-Za-z][\w-]*)?:\s*<[^>]*>|BASE\s*<[^>]*>)\s*)+/i, '')
    .trimStart();
  return /^(?:INSERT|DELETE|WITH|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD)\b/i.test(withoutPrologue);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
