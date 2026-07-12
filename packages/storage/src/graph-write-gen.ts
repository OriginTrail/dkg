/**
 * Per-graph write-generation tracking (#1609).
 *
 * The chain-reconcile backstop keeps an in-memory negative memo ("this merkle
 * root has no local SWM snapshot") that may suppress a rescan ONLY while no
 * local write has touched the context graph's SWM graphs since the memoized
 * scan — otherwise a KA whose SWM arrives later (gossip receive, publish
 * share, active fetch) would finalize late or never. Adapters bump this
 * counter at exactly the choke points that already invalidate the managed
 * `listGraphs()` cache (every local mutation), so "generation unchanged"
 * is a proof of "no local write since".
 *
 * Consumers recover the capability with {@link asGraphWriteGenSource} (the
 * `asChangelogReader` pattern — no `instanceof`/decorator-order assumption)
 * and compare {@link GraphWriteGenSource.getWriteGen} snapshots. Every
 * imprecision is fail-open: writes whose graph scope is unknowable at the
 * call site (raw SPARQL UPDATE, pattern deletes without a graph) bump a
 * global floor that invalidates every prefix, and LRU eviction folds the
 * evicted generation into that floor — an over-report costs one extra
 * rescan, never a missed one. Cross-process writers (a second process on a
 * shared oxigraph-server) are invisible here; the memo's TTL bounds that
 * hole, and a restart clears the memo entirely (the counter is in-memory).
 */
export interface GraphWriteGenSource {
  /**
   * Monotonic generation for "any local write that may have touched a graph
   * whose URI starts with `graphPrefix`". Two equal snapshots bracket a
   * window with no such write; the value has no meaning beyond equality.
   */
  getWriteGen(graphPrefix: string): number;
}

/**
 * Cap on individually-tracked graph URIs. Beyond it the least-recently
 * written graphs fold into the global floor (fail-open — see module doc).
 */
const MAX_TRACKED_GRAPHS = 8192;

/** Shared implementation the triple-store adapters embed. */
export class GraphWriteGenTracker implements GraphWriteGenSource {
  private counter = 0;
  /** Floor for writes with unknowable graph scope + LRU-evicted graphs. */
  private globalFloor = 0;
  /** graph URI → last write generation; Map insertion order = LRU recency. */
  private readonly byGraph = new Map<string, number>();

  /** Record a write scoped to known graph URIs (`''` = the default graph). */
  recordGraphWrites(graphs: Iterable<string>): void {
    let gen: number | undefined;
    for (const graph of graphs) {
      gen ??= ++this.counter;
      this.byGraph.delete(graph);
      this.byGraph.set(graph, gen);
    }
    while (this.byGraph.size > MAX_TRACKED_GRAPHS) {
      const oldest = this.byGraph.entries().next().value;
      if (!oldest) break;
      this.byGraph.delete(oldest[0]);
      if (oldest[1] > this.globalFloor) this.globalFloor = oldest[1];
    }
  }

  /** Record a write whose affected graphs are not derivable at the call site. */
  recordUnscopedWrite(): void {
    this.globalFloor = ++this.counter;
  }

  getWriteGen(graphPrefix: string): number {
    let gen = this.globalFloor;
    for (const [graph, graphGen] of this.byGraph) {
      if (graphGen > gen && graph.startsWith(graphPrefix)) gen = graphGen;
    }
    return gen;
  }
}

/**
 * Recover the {@link GraphWriteGenSource} capability from a store (typically a
 * `createTripleStore(...)` result behind the daemon's decorator chain), or
 * `null` when the backing adapter does not track write generations — callers
 * MUST fail open (always scan) on `null`.
 */
export function asGraphWriteGenSource(store: unknown): GraphWriteGenSource | null {
  // Follow `.innerStore` (hand-rolled forwarders like the daemon's
  // listContextGraphs-cache invalidator) and `.inner` (ChangelogStore,
  // GraphSetIndexStore, SharedMemoryLiteralBlobStore) so the capability
  // resolves through any decorator order — mirrors `asChangelogReader`.
  // The depth bound guards a pathological/cyclic chain.
  let s = store as
    | { getWriteGen?: unknown; innerStore?: unknown; inner?: unknown }
    | null
    | undefined;
  for (let depth = 0; s && depth < 8; depth++) {
    if (typeof s.getWriteGen === 'function') return s as GraphWriteGenSource;
    s = (s.innerStore ?? s.inner) as typeof s;
  }
  return null;
}
