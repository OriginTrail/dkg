import { performance } from 'node:perf_hooks';
import type { Quad, QueryResult, TripleStore } from './triple-store.js';

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

  async query(sparql: string): Promise<QueryResult> {
    const result = await this.inner.query(sparql);
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

  async listGraphs(): Promise<string[]> {
    const graphs = await this.ensureGraphSet();
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

  private async ensureGraphSet(): Promise<Set<string>> {
    if (
      this.graphs &&
      this.revalidateMs > 0 &&
      this.now() - this.validatedAt < this.revalidateMs
    ) {
      return this.graphs;
    }
    return this.refreshIndex(this.graphs ? 'revalidate' : 'seed');
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

function isSparqlUpdate(sparql: string): boolean {
  const withoutPrologue = sparql
    .trimStart()
    .replace(/^(?:(?:#[^\r\n]*(?:\r?\n|$))|(?:PREFIX\s+(?:[A-Za-z][\w-]*)?:\s*<[^>]*>|BASE\s*<[^>]*>)\s*)+/i, '')
    .trimStart();
  return /^(?:INSERT|DELETE|WITH|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD)\b/i.test(withoutPrologue);
}
