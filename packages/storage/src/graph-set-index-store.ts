import { performance } from 'node:perf_hooks';
import { isSparqlUpdateOperation } from '@origintrail-official/dkg-core';
import type {
  Quad,
  QueryOptions,
  QueryResult,
  StorePressureSnapshot,
  StoreWorkPriority,
  TripleStore,
  UpdateOptions,
} from './triple-store.js';
import { storeWorkPriorityRank } from './store-priority-scheduler.js';
import {
  UnsupportedTripleStoreCapabilityError,
  isReplaceGraphAndSubjectCapabilityRefusal,
  isReplaceGraphCapabilityRefusal,
} from './unsupported-capability-error.js';
import { isAtomicGraphReplaceStagingGraph } from './atomic-graph-replace.js';

export const DEFAULT_GRAPH_SET_REVALIDATE_MS = 30_000;
export const DEFAULT_GRAPH_SET_REVALIDATE_FAILURE_MAX_BACKOFF_MS = 5 * 60_000;
const MIN_GRAPH_SET_REVALIDATE_FAILURE_BACKOFF_MS = 1_000;
// Max times a bounded hasGraph probe is repeated when a concurrent write bumps
// the mutation generation, before falling back to one O(store) rebuild.
const MAINTAIN_INDEX_MAX_PROBE_RETRIES = 4;

export type GraphSetMutationSource =
  | 'seed'
  | 'revalidate'
  | 'insert'
  | 'delete'
  | 'deleteByPattern'
  | 'deleteBySubjectPrefix'
  | 'dropGraph'
  | 'replaceGraph'
  | 'replaceGraphAndSubject'
  | 'query'
  | 'update';

type TouchedGraphMutationSource =
  | 'delete'
  | 'deleteByPattern'
  | 'deleteBySubjectPrefix'
  | 'replaceGraph'
  | 'replaceGraphAndSubject'
  | 'update';
type GraphSetRefreshSource = 'seed' | 'revalidate' | TouchedGraphMutationSource | 'query';
type PendingFullRefreshSource = Exclude<GraphSetRefreshSource, 'seed' | 'revalidate'>;

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

export type GraphSetDiagnosticEvent =
  | {
      type: 'dirty-rebuild';
      source: GraphSetMutationSource;
      graphCount: number;
    }
  | {
      type: 'probe-retry-exhausted';
      source: GraphSetMutationSource;
      probeCount: number;
    };

export interface GraphSetIndexStoreOptions {
  enabled?: boolean;
  /** Revalidate after this interval. Use 0 to revalidate on every read. */
  revalidateMs?: number;
  /**
   * Initial retry delay after a failed warm periodic revalidation.
   * Ignored when revalidateMs is 0.
   */
  revalidateFailureBackoffMs?: number;
  /**
   * Maximum exponential retry delay after failed warm periodic revalidations.
   * Ignored when revalidateMs is 0.
   */
  revalidateFailureMaxBackoffMs?: number;
  now?: () => number;
  onMutation?: (event: GraphSetMutationEvent) => void;
  /** Instance-scoped operational diagnostics; failures are ignored. */
  onDiagnostic?: (event: GraphSetDiagnosticEvent) => void;
}

interface RefreshFlight<T> {
  readonly priority: StoreWorkPriority;
  readonly task: Promise<T>;
  lastScanSequence: number;
}

interface RefreshScan {
  readonly sequence: number;
}

/**
 * Coordinates priority-promoted refresh flights independently of graph-cache
 * mechanics. A caller may reuse a flight at its own or a higher priority; a
 * higher-priority caller starts a separate flight. Monotonic scan tokens then
 * fence both stale publication and stale failure handling.
 */
class RefreshCoordinator<T> {
  private readonly flights = new Map<StoreWorkPriority, RefreshFlight<T>>();
  private nextScanSequence = 0;
  private latestPublishedScanSequence = 0;

  run(
    priority: StoreWorkPriority,
    start: (flight: RefreshFlight<T>) => Promise<T>,
  ): Promise<T> {
    const reusable = this.bestReusableFlight(priority);
    if (reusable) return reusable.task;

    // Register the flight before its work starts so even a re-entrant caller
    // sees a complete single-flight view.
    let resolveTask!: (value: T) => void;
    let rejectTask!: (reason?: unknown) => void;
    const task = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const flight: RefreshFlight<T> = { priority, task, lastScanSequence: 0 };
    this.flights.set(priority, flight);
    void (async () => {
      try {
        resolveTask(await start(flight));
      } catch (error: unknown) {
        rejectTask(error);
      } finally {
        if (this.flights.get(priority) === flight) this.flights.delete(priority);
      }
    })();
    return task;
  }

  beginScan(flight: RefreshFlight<T>): RefreshScan {
    const scan = { sequence: ++this.nextScanSequence };
    flight.lastScanSequence = scan.sequence;
    return scan;
  }

  tryPublish(scan: RefreshScan): boolean {
    if (scan.sequence < this.latestPublishedScanSequence) return false;
    this.latestPublishedScanSequence = scan.sequence;
    return true;
  }

  shouldApplyFailureBackoff(flight: RefreshFlight<T>): boolean {
    return flight.lastScanSequence >= this.latestPublishedScanSequence;
  }

  private bestReusableFlight(priority: StoreWorkPriority): RefreshFlight<T> | undefined {
    const requestedRank = storeWorkPriorityRank(priority);
    let best: RefreshFlight<T> | undefined;
    for (const candidate of this.flights.values()) {
      const candidateRank = storeWorkPriorityRank(candidate.priority);
      if (candidateRank > requestedRank) continue;
      if (!best || candidateRank < storeWorkPriorityRank(best.priority)) best = candidate;
    }
    return best;
  }
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
  private readonly revalidateFailureBackoffMs: number;
  private readonly revalidateFailureMaxBackoffMs: number;
  private readonly now: () => number;
  private readonly onMutation?: (event: GraphSetMutationEvent) => void;
  private readonly onDiagnostic?: (event: GraphSetDiagnosticEvent) => void;

  private graphs: Set<string> | null = null;
  private nextRevalidateAt = 0;
  private revalidateFailureCount = 0;
  private mutationGeneration = 0;
  private readonly refreshCoordinator = new RefreshCoordinator<Set<string>>();
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
    this.revalidateFailureBackoffMs = positiveFiniteMs(
      options.revalidateFailureBackoffMs,
      Math.max(MIN_GRAPH_SET_REVALIDATE_FAILURE_BACKOFF_MS, this.revalidateMs),
    );
    this.revalidateFailureMaxBackoffMs = Math.max(
      this.revalidateFailureBackoffMs,
      positiveFiniteMs(
        options.revalidateFailureMaxBackoffMs,
        DEFAULT_GRAPH_SET_REVALIDATE_FAILURE_MAX_BACKOFF_MS,
      ),
    );
    this.now = options.now ?? (() => performance.now());
    this.onMutation = options.onMutation;
    this.onDiagnostic = options.onDiagnostic;
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
    await this.maintainTouchedGraphs(touched, 'delete', options);
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
      await this.maintainTouchedGraphs([graph], 'deleteByPattern', options);
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
    if (isSparqlUpdateOperation(sparql)) {
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
      throw new UnsupportedTripleStoreCapabilityError('update', 'GraphSetIndexStore');
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
    if (options?.touchedGraphs) {
      // Normalize the caller-supplied hint once at the boundary (filter falsy +
      // de-dupe), matching the `namedGraphsFromQuads` pattern — keeps the incremental
      // path predictable and avoids repeated `hasGraph` calls on duplicates.
      const touched = normalizeGraphUris(options.touchedGraphs);
      if (touched.length > 0) {
        // Strip the update-only `touchedGraphs` hint before the maintenance READS
        // (`hasGraph`) — it is meaningless on the read path and must not be smuggled
        // through the `QueryOptions` boundary into read-path wrappers/diagnostics.
        const readOptions = queryOptionsFromUpdateOptions(options);
        this.bumpMutation();
        await this.maintainTouchedGraphs(touched, 'update', readOptions);
        return;
      }
    }
    this.scheduleFullRefresh('update');
  }

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    if (isAtomicGraphReplaceStagingGraph(graphUri)) return false;
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

  async replaceGraph(
    graphUri: string,
    quads: Quad[],
    options?: QueryOptions,
  ): Promise<void> {
    if (typeof this.inner.replaceGraph !== 'function') {
      throw new UnsupportedTripleStoreCapabilityError('replaceGraph', 'GraphSetIndexStore');
    }
    if (!this.enabled) {
      await this.inner.replaceGraph(graphUri, quads, options);
      return;
    }
    try {
      await this.inner.replaceGraph(graphUri, quads, options);
    } catch (error) {
      // The replaceGraph contract allows a rejected call to have committed the
      // complete new graph (or dropped the old one). Serving the cached graph
      // set would then hide a committed KA graph from enumeration, so mark the
      // index dirty for a lazy rebuild — unless this was a clean preflight
      // capability refusal, where nothing was mutated.
      if (!isReplaceGraphCapabilityRefusal(error)) {
        this.scheduleFullRefresh('replaceGraph');
      }
      throw error;
    }
    this.bumpMutation();
    await this.maintainTouchedGraphs([graphUri], 'replaceGraph', options);
  }

  async replaceGraphAndSubject(
    graphUri: string,
    graphQuads: Quad[],
    metaGraphUri: string,
    metadataSubject: string,
    metadataQuads: Quad[],
    options?: QueryOptions,
  ): Promise<void> {
    if (typeof this.inner.replaceGraphAndSubject !== 'function') {
      throw new UnsupportedTripleStoreCapabilityError(
        'replaceGraphAndSubject',
        'GraphSetIndexStore',
      );
    }
    try {
      await this.inner.replaceGraphAndSubject(
        graphUri,
        graphQuads,
        metaGraphUri,
        metadataSubject,
        metadataQuads,
        options,
      );
    } catch (error) {
      if (!isReplaceGraphAndSubjectCapabilityRefusal(error)) {
        this.scheduleFullRefresh('replaceGraphAndSubject');
      }
      throw error;
    }
    if (!this.enabled) return;
    this.bumpMutation();
    await this.maintainTouchedGraphs(
      [graphUri, metaGraphUri],
      'replaceGraphAndSubject',
      options,
    );
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    if (!this.enabled) {
      return (await this.inner.listGraphs(options)).filter(
        (graph) => !isAtomicGraphReplaceStagingGraph(graph),
      );
    }
    const graphs = await this.ensureGraphSet(options);
    return [...graphs];
  }

  async listGraphsByPrefix(prefix: string, options?: QueryOptions): Promise<string[]> {
    if (!this.enabled) {
      if (this.inner.listGraphsByPrefix) {
        return (await this.inner.listGraphsByPrefix(prefix, options)).filter(
          (graph) => !isAtomicGraphReplaceStagingGraph(graph),
        );
      }
      return (await this.inner.listGraphs(options)).filter(
        (graph) => graph.startsWith(prefix) && !isAtomicGraphReplaceStagingGraph(graph),
      );
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
    await this.maintainTouchedGraphs([graphUri], 'deleteBySubjectPrefix', options);
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
      this.now() < this.nextRevalidateAt
    ) {
      return this.graphs;
    }
    return raceAgainstAbort(
      this.refreshIndex(this.pendingFullRefresh ?? (this.graphs ? 'revalidate' : 'seed'), options),
      options?.signal,
    );
  }

  private async refreshIndex(source: GraphSetRefreshSource, options?: QueryOptions): Promise<Set<string>> {
    const priority = refreshPriority(source, options);
    // The coordinator owns the complete promotion policy: lower-priority cold
    // seeds/revalidations cannot capture later normal or ACK readers, while
    // equal/lower-priority callers reuse the best in-flight scan.
    return this.refreshCoordinator.run(priority, async (flight) => {
      try {
        return await this.refreshIndexLoop(source, options, flight);
      } catch (error: unknown) {
        if (source !== 'revalidate') throw error;
        // Cancellation, cold seeds, and mutation-dirty rebuilds are strict
        // correctness paths even if another refresh published in parallel.
        if (options?.signal?.aborted || !this.graphs || this.pendingFullRefresh) {
          throw error;
        }
        // A newer promoted refresh already published a usable graph set. Do
        // not let this older failed scan overwrite its healthy schedule with
        // failure backoff.
        if (!this.refreshCoordinator.shouldApplyFailureBackoff(flight)) return this.graphs;
        // Periodic discovery of out-of-contract writers is advisory once the
        // write-through index is warm. Preserve that last known set and back
        // off after a store failure instead of making every graph reader repeat
        // the same expensive scan. Cold seeds and mutation-dirty rebuilds are
        // correctness paths: if either condition applies by the time the scan
        // fails, keep the original strict rejection behavior.
        this.noteRevalidationFailure();
        return this.graphs;
      }
    });
  }

  private async refreshIndexLoop(
    source: GraphSetRefreshSource,
    options: QueryOptions | undefined,
    flight: RefreshFlight<Set<string>>,
  ): Promise<Set<string>> {
    for (;;) {
      const dirtyRebuildSource = this.pendingFullRefresh;
      const isDirtyRebuild = dirtyRebuildSource != null;
      const sourceForScan = dirtyRebuildSource ?? source;
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
      const scan = this.refreshCoordinator.beginScan(flight);
      const next = new Set(
        (await this.inner.listGraphs(scanOptions)).filter(
          (graph) => Boolean(graph) && !isAtomicGraphReplaceStagingGraph(graph),
        ),
      );
      if (generation !== this.mutationGeneration) continue;
      // Priority promotion intentionally permits overlapping scans. Fence the
      // shared cache by scan start order so an older, slower background response
      // cannot overwrite a later ACK/normal snapshot that already published.
      if (!this.refreshCoordinator.tryPublish(scan)) {
        return this.graphs ?? next;
      }
      // This scan reflects every mutation up to `generation` (synchronous from
      // here — no await — so a concurrent write can't slip between the check and
      // the clear; if one had, it would have bumped the generation above and we
      // would have retried, preserving the pending refresh source for the next
      // scan attempt).
      this.pendingFullRefresh = null;
      if (isDirtyRebuild) {
        this.emitDiagnostic({
          type: 'dirty-rebuild',
          source: dirtyRebuildSource,
          graphCount: next.size,
        });
      }
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

  private async maintainStableGraphPresence(
    graphs: string[],
    source: TouchedGraphMutationSource,
    options?: QueryOptions,
  ): Promise<void> {
    // hasGraph is the only operation inside this retry boundary. Applying the
    // stable result in this same continuation leaves no await/microtask boundary
    // where a concurrent mutation could invalidate it after the generation check.
    for (let attempt = 0; attempt < MAINTAIN_INDEX_MAX_PROBE_RETRIES; attempt++) {
      const generation = this.mutationGeneration;
      try {
        const graphPresence = await Promise.all(
          graphs.map(async (graph) => ({
            graph,
            present: await this.inner.hasGraph(graph, options),
          })),
        );
        if (!this.graphs) return;
        if (generation !== this.mutationGeneration) {
          continue;
        }
        for (const { graph, present } of graphPresence) {
          if (present) {
            this.addGraphs([graph], source);
          } else {
            this.removeGraphs([graph], source);
          }
        }
        return;
      } catch {
        this.clearIndex();
        return;
      }
    }
    this.emitDiagnostic({
      type: 'probe-retry-exhausted',
      source,
      probeCount: MAINTAIN_INDEX_MAX_PROBE_RETRIES,
    });
    this.scheduleFullRefresh(source);
  }

  private clearIndex(): void {
    this.graphs = null;
    this.resetRevalidationSchedule();
  }

  private replaceGraphSet(next: Set<string>, source: GraphSetRefreshSource): void {
    const previous = this.graphs ?? new Set<string>();
    const added = [...next].filter((graph) => !previous.has(graph)).sort();
    const removed = [...previous].filter((graph) => !next.has(graph)).sort();
    this.graphs = next;
    this.revalidateFailureCount = 0;
    this.nextRevalidateAt = this.now() + this.revalidateMs;
    if (added.length > 0 || removed.length > 0 || source !== 'seed') {
      this.emit({ type: 'graph-set-revalidated', added, removed, source });
    }
  }

  private noteRevalidationFailure(): void {
    // revalidateMs=0 is the strict-freshness opt-out from both cached reads and
    // failure backoff: every read must attempt another scan, even after failure.
    if (this.revalidateMs === 0) {
      this.resetRevalidationSchedule();
      return;
    }
    // Cap the exponent before multiplication as an additional overflow guard;
    // the configured maximum is the externally visible bound.
    const exponent = Math.min(this.revalidateFailureCount, 30);
    const delay = Math.min(
      this.revalidateFailureMaxBackoffMs,
      this.revalidateFailureBackoffMs * (2 ** exponent),
    );
    this.revalidateFailureCount++;
    this.nextRevalidateAt = this.now() + delay;
  }

  private resetRevalidationSchedule(): void {
    this.revalidateFailureCount = 0;
    this.nextRevalidateAt = 0;
  }

  private addGraphs(graphs: string[], source: GraphSetMutationSource): void {
    if (!this.graphs) return;
    for (const graph of graphs) {
      if (!graph || isAtomicGraphReplaceStagingGraph(graph) || this.graphs.has(graph)) continue;
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

  private async maintainTouchedGraphs(
    graphs: string[],
    source: TouchedGraphMutationSource,
    options?: QueryOptions,
  ): Promise<void> {
    if (!this.graphs) return;
    const uniqueGraphs = [...new Set(graphs.filter(Boolean))];
    await this.maintainStableGraphPresence(uniqueGraphs, source, options);
  }

  private emit(event: GraphSetMutationEvent): void {
    try {
      this.onMutation?.(event);
    } catch {
      // Observability hooks must not make already-committed store writes fail.
    }
  }

  private emitDiagnostic(event: GraphSetDiagnosticEvent): void {
    try {
      this.onDiagnostic?.(event);
    } catch {
      // Observability hooks must not make already-committed store writes fail.
    }
  }
}

function namedGraphsFromQuads(quads: Quad[]): string[] {
  return [...new Set(quads.map((quad) => quad.graph).filter(Boolean))];
}

/** Filter falsy entries and de-duplicate a caller-supplied graph-URI hint list. */
function normalizeGraphUris(graphs: readonly string[]): string[] {
  return [...new Set(graphs.filter(Boolean))];
}

/**
 * Drop the update-only `touchedGraphs` hint, yielding the read-path `QueryOptions`
 * (source/priority/signal) to forward to index-maintenance reads (`hasGraph`) — so
 * the update-only field never crosses into a read call via structural assignability.
 */
function queryOptionsFromUpdateOptions(options: UpdateOptions): QueryOptions {
  const { touchedGraphs: _touchedGraphs, ...readOptions } = options;
  return readOptions;
}

function positiveFiniteMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : fallback;
}

function refreshPriority(
  source: GraphSetRefreshSource,
  options: QueryOptions | undefined,
): StoreWorkPriority {
  return source === 'seed' || source === 'revalidate'
    ? options?.priority ?? 'normal'
    : 'background';
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
