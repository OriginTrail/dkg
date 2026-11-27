import { findTripleStoreCapability } from './triple-store.js';

/**
 * Per-graph write-generation tracking (#1609).
 *
 * The chain-reconcile backstop keeps an in-memory negative memo ("this merkle
 * root has no local SWM snapshot") that may suppress a rescan ONLY while no
 * local write has touched the context graph's SWM graphs since the memoized
 * scan — otherwise a KA whose SWM arrives later (gossip receive, publish
 * share, active fetch) would finalize late or never. Adapters bump this
 * counter at exactly the choke points that already invalidate the managed
 * `listGraphs()` cache (every local mutation). A stable, unchanged revision
 * is a proof of "no local write since"; active or indeterminate remote writes
 * make revisions unstable and therefore ineligible for cache reuse.
 *
 * Consumers recover the capability with {@link asGraphWriteRevisionSource} (the
 * `asChangelogReader` pattern — no `instanceof`/decorator-order assumption)
 * and compare {@link GraphWriteRevisionSource.getWriteRevision} snapshots. Every
 * imprecision is fail-open: writes whose graph scope is unknowable at the
 * call site (raw SPARQL UPDATE, pattern deletes without a graph) bump a
 * global floor that invalidates every prefix, and LRU eviction folds the
 * evicted generation into that floor — an over-report costs one extra
 * rescan, never a missed one. Adapters with cross-process writers explicitly
 * declare process-local coverage, disabling authorization-cache reuse; only a
 * source that observes every live-store replacement and writer may declare
 * all-writers coverage.
 */
export interface GraphWriteGenSource {
  /**
   * Monotonic generation for "any local write that may have touched a graph
   * whose URI starts with `graphPrefix`". Two equal snapshots bracket a
   * window with no such write only when both accompanying revisions are
   * stable; the value has no meaning beyond equality.
   */
  getWriteGen(graphPrefix: string): number;
}

/** Revision-aware successor capability used by cache and negative-memo consumers. */
export interface GraphWriteRevisionSource {
  /** Whether this source observes every writer that can mutate the live store. */
  readonly writeRevisionCoverage: GraphWriteRevisionCoverage;
  /** The same observational generation plus whether it is safe to memoize. */
  getWriteRevision(graphPrefix: string): GraphWriteRevision;
}

export type GraphWriteRevisionCoverage = 'process-local' | 'all-writers';

export interface GraphWriteRevision {
  generation: number;
  stable: boolean;
}

/** Explicit write ownership used by every adapter and lifecycle boundary. */
export type GraphWriteScope =
  | Readonly<{ kind: 'all' }>
  | Readonly<{ kind: 'graphs'; graphs: readonly string[] }>;

/** One dispatched-write lifecycle. Its terminal transition is idempotent. */
export interface GraphWriteLifecycle {
  settle(): void;
  indeterminate(): void;
}

/**
 * Cap on individually-tracked graph URIs. Beyond it the least-recently
 * written graphs fold into the global floor (fail-open — see module doc).
 */
const MAX_TRACKED_GRAPHS = 8192;

/** Shared implementation the triple-store adapters embed. */
export class GraphWriteGenTracker implements GraphWriteGenSource, GraphWriteRevisionSource {
  readonly writeRevisionCoverage = 'process-local' as const;
  private counter = 0;
  /** Floor for writes with unknowable graph scope + LRU-evicted graphs. */
  private globalFloor = 0;
  /** graph URI → last write generation; Map insertion order = LRU recency. */
  private readonly byGraph = new Map<string, number>();
  /**
   * Remote writes whose outcome could not be observed. Their scopes remain
   * unstable for this process lifetime: a timeout can return before the server
   * has actually settled, so no later cache observation can prove quiescence.
   */
  private readonly indeterminateGraphs = new Set<string>();
  private indeterminateGlobal = false;
  private readonly activeGraphs = new Map<string, number>();
  private activeGlobal = 0;

  /** Record a synchronous write that has already settled. */
  recordWrite(scope: GraphWriteScope): void {
    if (scope.kind === 'all') this.recordUnscopedWrite();
    else this.recordGraphWrites(scope.graphs);
  }

  /** Begin one dispatched write and return its named terminal boundary. */
  beginWrite(scope: GraphWriteScope): GraphWriteLifecycle {
    if (scope.kind === 'all') return this.beginUnscopedWrite();
    return this.beginGraphWrites(scope.graphs);
  }

  /** Record a write scoped to known graph URIs (`''` = the default graph). */
  private recordGraphWrites(graphs: Iterable<string>): void {
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
  private recordUnscopedWrite(): void {
    this.globalFloor = ++this.counter;
  }

  private beginGraphWrites(graphs: Iterable<string>): GraphWriteLifecycle {
    const affected = [...new Set(graphs)];
    this.recordGraphWrites(affected);
    for (const graph of affected) {
      this.activeGraphs.set(graph, (this.activeGraphs.get(graph) ?? 0) + 1);
    }
    return this.lifecycle(
      () => {
        this.releaseActiveGraphs(affected);
        this.recordGraphWrites(affected);
      },
      () => {
        this.releaseActiveGraphs(affected);
        this.recordIndeterminateGraphWrites(affected);
      },
    );
  }

  private beginUnscopedWrite(): GraphWriteLifecycle {
    this.recordUnscopedWrite();
    this.activeGlobal += 1;
    return this.lifecycle(
      () => {
        this.activeGlobal -= 1;
        this.recordUnscopedWrite();
      },
      () => {
        this.activeGlobal -= 1;
        this.indeterminateGlobal = true;
        this.recordUnscopedWrite();
      },
    );
  }

  /**
   * Record a remotely dispatched write whose final state is unknown. Reads of
   * an affected generation never stabilize, deliberately disabling generation-
   * keyed memoization until restart rather than certifying a stale snapshot.
   */
  private recordIndeterminateGraphWrites(graphs: Iterable<string>): void {
    const affected = [...new Set(graphs)];
    if (affected.length === 0) return;
    this.recordGraphWrites(affected);
    if (this.indeterminateGlobal) return;
    for (const graph of affected) this.indeterminateGraphs.add(graph);
    if (this.indeterminateGraphs.size > MAX_TRACKED_GRAPHS) {
      this.indeterminateGraphs.clear();
      this.indeterminateGlobal = true;
    }
  }

  getWriteGen(graphPrefix: string): number {
    return this.getWriteRevision(graphPrefix).generation;
  }

  getWriteRevision(graphPrefix: string): GraphWriteRevision {
    // Every graph URI starts with the empty prefix, so the tracker counter is
    // the exact answer without scanning the bounded per-graph LRU. Responder
    // graph-list caches use this global generation on every page/session.
    if (graphPrefix === '') {
      return {
        generation: this.counter,
        stable: !this.indeterminateGlobal
          && this.indeterminateGraphs.size === 0
          && this.activeGlobal === 0
          && this.activeGraphs.size === 0,
      };
    }
    let gen = this.globalFloor;
    for (const [graph, graphGen] of this.byGraph) {
      if (graphGen > gen && graph.startsWith(graphPrefix)) gen = graphGen;
    }
    return { generation: gen, stable: !this.isPrefixUnstable(graphPrefix) };
  }

  private isPrefixUnstable(graphPrefix: string): boolean {
    if (this.indeterminateGlobal || this.activeGlobal > 0) return true;
    for (const graph of this.indeterminateGraphs) {
      if (graph.startsWith(graphPrefix)) return true;
    }
    for (const graph of this.activeGraphs.keys()) {
      if (graph.startsWith(graphPrefix)) return true;
    }
    return false;
  }

  private releaseActiveGraphs(graphs: readonly string[]): void {
    for (const graph of graphs) {
      const count = this.activeGraphs.get(graph) ?? 0;
      if (count <= 1) this.activeGraphs.delete(graph);
      else this.activeGraphs.set(graph, count - 1);
    }
  }

  private lifecycle(
    settle: () => void,
    indeterminate: () => void,
  ): GraphWriteLifecycle {
    let finished = false;
    const finish = (action: () => void): void => {
      if (finished) return;
      finished = true;
      action();
    };
    return {
      settle: () => finish(settle),
      indeterminate: () => finish(indeterminate),
    };
  }
}

/**
 * Recover the legacy {@link GraphWriteGenSource} capability without changing
 * its published getWriteGen-only contract.
 */
export function asGraphWriteGenSource(store: unknown): GraphWriteGenSource | null {
  return findTripleStoreCapability(
    store,
    (candidate): candidate is GraphWriteGenSource => (
      typeof candidate === 'object'
      && candidate !== null
      && typeof (candidate as Partial<GraphWriteGenSource>).getWriteGen === 'function'
    ),
  );
}

/**
 * Recover the revision-aware capability from a store (typically a
 * `createTripleStore(...)` result behind the daemon's decorator chain), or
 * `null` when the backing adapter does not track write generations — callers
 * MUST fail open (always scan) on `null`. A legacy getWriteGen-only adapter is
 * deliberately not promoted: it cannot observe an in-flight write and must
 * not masquerade as a native stable revision source. A getWriteRevision-only
 * implementation remains runtime-compatible, but this boundary normalizes
 * its missing coverage metadata to process-local so consumers always receive
 * the explicit discriminator promised by {@link GraphWriteRevisionSource}.
 */
export function asGraphWriteRevisionSource(store: unknown): GraphWriteRevisionSource | null {
  type RevisionReader = {
    readonly writeRevisionCoverage?: GraphWriteRevisionCoverage;
    getWriteRevision(graphPrefix: string): GraphWriteRevision;
  };
  const source = findTripleStoreCapability(
    store,
    (candidate): candidate is RevisionReader => (
      typeof candidate === 'object'
      && candidate !== null
      && typeof (candidate as Partial<RevisionReader>).getWriteRevision === 'function'
    ),
  );
  return source
    ? {
      writeRevisionCoverage: source.writeRevisionCoverage ?? 'process-local',
      getWriteRevision: (graphPrefix) => source.getWriteRevision(graphPrefix),
    }
    : null;
}
