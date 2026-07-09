import { performance } from 'node:perf_hooks';
import type { Quad, QueryOptions, QueryResult, TripleStore } from './triple-store.js';

export const DEFAULT_GRAPH_SET_REVALIDATE_MS = 30_000;

export type GraphSetMutationSource =
  | 'seed'
  | 'revalidate'
  | 'insert'
  | 'delete'
  | 'deleteByPattern'
  | 'deleteBySubjectPrefix'
  | 'dropGraph'
  | 'query';

type GraphSetRefreshSource = 'seed' | 'revalidate' | 'deleteByPattern' | 'query' | 'update';

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
  private pendingFullRefresh: GraphSetRefreshSource | null = null;

  constructor(inner: TripleStore, options: GraphSetIndexStoreOptions = {}) {
    this.inner = inner;
    this.enabled = options.enabled !== false;
    this.revalidateMs = Math.max(0, options.revalidateMs ?? DEFAULT_GRAPH_SET_REVALIDATE_MS);
    this.now = options.now ?? (() => performance.now());
    this.onMutation = options.onMutation;
  }

  async insert(quads: Quad[]): Promise<void> {
    if (!this.enabled) {
      await this.inner.insert(quads);
      return;
    }
    await this.inner.insert(quads);
    const touched = namedGraphsFromQuads(quads);
    if (touched.length === 0) return;
    this.bumpMutation();
    this.addGraphs(touched, 'insert');
  }

  async delete(quads: Quad[]): Promise<void> {
    if (!this.enabled) {
      await this.inner.delete(quads);
      return;
    }
    await this.inner.delete(quads);
    const touched = namedGraphsFromQuads(quads);
    if (touched.length === 0) return;
    this.bumpMutation();
    await this.maintainIndex(() => this.refreshTouchedGraphs(touched, 'delete'));
  }

  async deleteByPattern(pattern: Partial<Quad>): Promise<number> {
    if (!this.enabled) {
      return this.inner.deleteByPattern(pattern);
    }
    const removed = await this.inner.deleteByPattern(pattern);
    if (removed <= 0) return removed;
    const graph = pattern.graph;
    if (graph) {
      this.bumpMutation();
      await this.maintainIndex(() => this.refreshTouchedGraphs([graph], 'deleteByPattern'));
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
      // A SPARQL UPDATE may create/drop named graphs we can't derive
      // incrementally. Mark dirty for a single lazy rebuild on the next read
      // instead of re-scanning the whole store now — the eager per-UPDATE scan
      // thrashed large stores under the RS-heal/sync UPDATE stream.
      this.scheduleFullRefresh('query');
    }
    return result;
  }

  async update(sparql: string): Promise<void> {
    if (typeof this.inner.update !== 'function') {
      throw new Error('GraphSetIndexStore: inner store does not support update()');
    }
    if (!this.enabled) {
      await this.inner.update(sparql);
      return;
    }
    await this.inner.update(sparql);
    // A server-side SPARQL UPDATE (e.g. the RS heal's INSERT…WHERE) can create
    // or drop named graphs the index must learn about. Rather than re-scan the
    // whole store on every UPDATE (the thrash), mark dirty: the next read does a
    // single rebuild and the freshly-created/dropped graph is reflected then.
    this.scheduleFullRefresh('update');
  }

  async hasGraph(graphUri: string): Promise<boolean> {
    if (!this.enabled) {
      return this.inner.hasGraph(graphUri);
    }
    const hasGraph = await this.inner.hasGraph(graphUri);
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

  async dropGraph(graphUri: string): Promise<void> {
    if (!this.enabled) {
      await this.inner.dropGraph(graphUri);
      return;
    }
    await this.inner.dropGraph(graphUri);
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

  async deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number> {
    if (!this.enabled) {
      return this.inner.deleteBySubjectPrefix(graphUri, prefix);
    }
    const removed = await this.inner.deleteBySubjectPrefix(graphUri, prefix);
    if (removed <= 0) return removed;
    this.bumpMutation();
    await this.maintainIndex(() => this.refreshTouchedGraphs([graphUri], 'deleteBySubjectPrefix'));
    return removed;
  }

  async countQuads(graphUri?: string): Promise<number> {
    return this.inner.countQuads(graphUri);
  }

  async flush(): Promise<void> {
    await this.inner.flush?.();
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
      this.refreshIndex(this.pendingFullRefresh ?? (this.graphs ? 'revalidate' : 'seed')),
      options?.signal,
    );
  }

  private async refreshIndex(source: GraphSetRefreshSource): Promise<Set<string>> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const task = this.refreshIndexLoop(source);
    this.refreshInFlight = task;
    try {
      return await task;
    } finally {
      if (this.refreshInFlight === task) this.refreshInFlight = null;
    }
  }

  private async refreshIndexLoop(source: GraphSetRefreshSource): Promise<Set<string>> {
    for (;;) {
      const sourceForScan = this.pendingFullRefresh ?? source;
      const generation = this.mutationGeneration;
      const next = new Set((await this.inner.listGraphs()).filter(Boolean));
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

  private scheduleFullRefresh(source: GraphSetRefreshSource): void {
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

  private async refreshTouchedGraphs(graphs: string[], source: GraphSetMutationSource): Promise<void> {
    if (!this.graphs) return;
    for (const graph of graphs) {
      if (!graph) continue;
      if (await this.inner.hasGraph(graph)) {
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
