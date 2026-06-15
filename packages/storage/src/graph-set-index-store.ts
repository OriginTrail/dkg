import { performance } from 'node:perf_hooks';
import type { Quad, QueryOptions, TripleStoreQueryOptions, QueryResult, TripleStore } from './triple-store.js';

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

type GraphSetRefreshSource = 'seed' | 'revalidate' | 'deleteByPattern' | 'query';

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
  private readonly revalidateMs: number;
  private readonly now: () => number;
  private readonly onMutation?: (event: GraphSetMutationEvent) => void;

  private graphs: Set<string> | null = null;
  private validatedAt = 0;
  private mutationGeneration = 0;
  private refreshInFlight: Promise<Set<string>> | null = null;

  constructor(inner: TripleStore, options: GraphSetIndexStoreOptions = {}) {
    this.inner = inner;
    this.revalidateMs = Math.max(0, options.revalidateMs ?? DEFAULT_GRAPH_SET_REVALIDATE_MS);
    this.now = options.now ?? (() => performance.now());
    this.onMutation = options.onMutation;
  }

  async insert(quads: Quad[]): Promise<void> {
    await this.inner.insert(quads);
    const touched = namedGraphsFromQuads(quads);
    if (touched.length === 0) return;
    this.bumpMutation();
    this.addGraphs(touched, 'insert');
  }

  async delete(quads: Quad[]): Promise<void> {
    await this.inner.delete(quads);
    const touched = namedGraphsFromQuads(quads);
    if (touched.length === 0) return;
    this.bumpMutation();
    await this.maintainIndex(() => this.refreshTouchedGraphs(touched, 'delete'));
  }

  async deleteByPattern(pattern: Partial<Quad>): Promise<number> {
    const removed = await this.inner.deleteByPattern(pattern);
    if (removed <= 0) return removed;
    this.bumpMutation();
    const graph = pattern.graph;
    if (graph) {
      await this.maintainIndex(() => this.refreshTouchedGraphs([graph], 'deleteByPattern'));
    } else {
      await this.maintainIndex(() => this.refreshIndex('deleteByPattern'));
    }
    return removed;
  }

  async query(sparql: string, options?: TripleStoreQueryOptions): Promise<QueryResult> {
    const result = await this.inner.query(sparql, options);
    if (isSparqlUpdate(sparql)) {
      this.bumpMutation();
      if (this.graphs || this.refreshInFlight) {
        await this.maintainIndex(() => this.refreshIndex('query'));
      }
    }
    return result;
  }

  async hasGraph(graphUri: string): Promise<boolean> {
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
    await this.inner.dropGraph(graphUri);
    this.bumpMutation();
    this.removeGraphs([graphUri], 'dropGraph');
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    const graphs = await this.ensureGraphSet(options);
    return [...graphs];
  }

  async listGraphsByPrefix(prefix: string): Promise<string[]> {
    const graphs = await this.ensureGraphSet();
    return [...graphs].filter((graph) => graph.startsWith(prefix));
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number> {
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
    if (
      this.graphs &&
      this.revalidateMs > 0 &&
      this.now() - this.validatedAt < this.revalidateMs
    ) {
      // A warm cache short-circuits the shared scan, so honour this caller's
      // own cancellation before handing back the cached set.
      throwIfAborted(options?.signal);
      return this.graphs;
    }
    // The shared index scan is signal-agnostic (see refreshIndex): one caller's
    // abort must never reject siblings joined to the same refresh. Each caller
    // races the shared scan against its own signal instead.
    return raceWithSignal(
      this.refreshIndex(this.graphs ? 'revalidate' : 'seed'),
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
      const generation = this.mutationGeneration;
      // No caller signal: the scan is shared across concurrent callers, so it
      // runs to completion (or fails on its own) independent of any one caller.
      const next = new Set((await this.inner.listGraphs()).filter(Boolean));
      if (generation !== this.mutationGeneration) continue;
      this.replaceGraphSet(next, source);
      return this.graphs!;
    }
  }

  private bumpMutation(): void {
    this.mutationGeneration++;
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

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

/**
 * Settle with `promise`'s result, but reject early if `signal` aborts first.
 *
 * The shared index refresh is deliberately signal-agnostic, so this is the only
 * place a caller's cancellation is observed: it must not abort the underlying
 * `promise` (other callers share it). We always attach a settle handler to
 * `promise` even when the signal wins the race, so a later rejection of the
 * shared scan stays handled here rather than surfacing as an unhandled rejection.
 */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    };
    // Keep a handler on the shared promise regardless of who wins; settling
    // after an abort is a harmless no-op for the Promise executor.
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
    onAbort = () => { cleanup(); reject(abortError(signal.reason)); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isSparqlUpdate(sparql: string): boolean {
  const withoutPrologue = sparql
    .trimStart()
    .replace(/^(?:(?:#[^\r\n]*(?:\r?\n|$))|(?:PREFIX\s+(?:[A-Za-z][\w-]*)?:\s*<[^>]*>|BASE\s*<[^>]*>)\s*)+/i, '')
    .trimStart();
  return /^(?:INSERT|DELETE|WITH|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD)\b/i.test(withoutPrologue);
}
