import { prepareImmutableMutation, runImmutableMutation, assertImmutableMutationCapability, type ImmutableStoreMutation, type ImmutableStorePreparation, type PreparedMutation } from './immutable-store-preparation.js';
import type { TripleStoreCommitCapability } from './persistence.js';
import type { GraphSetIndexStoreOptions } from './graph-set-index-store-options.js';
export type { GraphSetIndexStoreOptions } from './graph-set-index-store-options.js';
import { composeGraphEnumerationVisibility } from './graph-enumeration-visibility.js';
import { namedGraphsFromQuads, endsWithHighSurrogate, normalizeGraphUris, queryOptionsFromUpdateOptions } from "./graph-set-index-utils.js";
import type { AtomicAssetReplacement } from './atomic-asset-group.js';
import type { GraphSetMutationSource, TouchedGraphMutationSource, GraphSetRefreshSource, PendingFullRefreshSource, GraphSetMutationEvent, GraphSetDiagnosticEvent } from './graph-set-index-types.js';
export type { GraphSetMutationSource, GraphSetMutationEvent } from './graph-set-index-types.js';
import { performance } from 'node:perf_hooks';
import {
  codePointLowerBound,
  createSortedUniqueStringCatalog,
  isSparqlUpdateOperation,
  type SortedUniqueStringCatalog,
} from '@origintrail-official/dkg-core';
import type {
  Quad,
  QueryOptions,
  QueryResult,
  StorePressureSnapshot,
  StoreWorkPriority,
  TripleStore,
  TripleStoreDecorator,
  UpdateOptions,
} from './triple-store.js';
import { deleteByPatternWithoutCount, runLogicalStoreMutation } from './triple-store.js';
import { RefreshCoordinator, type RefreshFlight } from './graph-set-refresh-coordinator.js';
import {
  UnsupportedTripleStoreCapabilityError,
} from './unsupported-capability-error.js';
import { isAtomicGraphReplaceStagingGraph } from './atomic-graph-replace.js';
import { GraphSetCatalogState } from './graph-set-catalog-state.js';
import type {
  Rfc64AuthorCommitCasInputV1,
  Rfc64AuthorCommitCasResultV1,
} from './rfc64-author-commit-cas.js';
import {
  normalizeRfc64AuthorCommitCasV1,
  sourceFromNormalizedRfc64AuthorCommitCasV1,
} from './rfc64-author-commit-cas.js';
import { isStoreOperationNotStarted } from './store-operation-outcome.js';
import { raceStoreWorkAgainstAbort } from './abortable-store-work-lifecycle.js';
import { StoreWorkDrain } from './store-work-drain.js';
import type { StoreOperation } from './store-operation-outcome.js';

export const DEFAULT_GRAPH_SET_REVALIDATE_MS = 30_000;
export const DEFAULT_GRAPH_SET_REVALIDATE_FAILURE_MAX_BACKOFF_MS = 5 * 60_000;
const MIN_GRAPH_SET_REVALIDATE_FAILURE_BACKOFF_MS = 1_000;
// Max times a bounded hasGraph probe is repeated when a concurrent write bumps
// the mutation generation, before falling back to one O(store) rebuild.
const MAINTAIN_INDEX_MAX_PROBE_RETRIES = 4;


/** Immutable graph catalog maintained in Unicode code-point order. */
export interface SortedGraphSetSource {
  listGraphsSorted(options?: QueryOptions): Promise<SortedGraphCatalog>;
}

export type SortedGraphCatalog = SortedUniqueStringCatalog;

/**
 * Load one immutable, unique, code-point-sorted catalog at the supplied store
 * boundary. Capability discovery deliberately does not traverse decorators:
 * an outer store may own graph-visibility semantics that its inner store does
 * not, so only the supplied object may provide the sorted fast path.
 */
export async function loadSortedGraphCatalog(
  store: TripleStore,
  options?: QueryOptions,
): Promise<SortedGraphCatalog> {
  const sortedSource = typeof (store as Partial<SortedGraphSetSource>).listGraphsSorted
    === 'function'
    ? store as TripleStore & SortedGraphSetSource
    : null;
  return sortedSource
    ? sortedSource.listGraphsSorted(options)
    : createSortedUniqueStringCatalog(await store.listGraphs(options));
}

/** Internal/test-only observation seam; intentionally absent from the package API. */
type GraphSetIndexStoreInternalOptions = GraphSetIndexStoreOptions & {
  onDiagnostic?: (event: GraphSetDiagnosticEvent) => void;
};

/**
 * Write-through named-graph index for stores whose `listGraphs()` implementation
 * is a full-store scan. The index follows the repo's existing graph semantics:
 * only graphs containing at least one quad are listed; empty `createGraph()`
 * calls are not visible until data is inserted.
 */
export class GraphSetIndexStore implements TripleStoreDecorator, ImmutableStorePreparation {
  get queryCancellation() {
    return this.inner.queryCancellation;
  }

  getPressureSnapshot(): StorePressureSnapshot | undefined {
    return this.inner.getPressureSnapshot?.();
  }

  private readonly inner: TripleStore;
  readonly innerStore: TripleStore;
  readonly commitment?: TripleStoreCommitCapability;
  private readonly enabled: boolean;
  private readonly revalidateMs: number;
  private readonly revalidateFailureBackoffMs: number;
  private readonly revalidateFailureMaxBackoffMs: number;
  private readonly now: () => number;
  private readonly onMutation?: (event: GraphSetMutationEvent) => void;
  private readonly onDiagnostic?: (event: GraphSetDiagnosticEvent) => void;

  private readonly catalog = new GraphSetCatalogState();
  private nextRevalidateAt = 0;
  private revalidateFailureCount = 0;
  private mutationGeneration = 0;
  private readonly refreshCoordinator = new RefreshCoordinator<ReadonlySet<string>>();
  private readonly mutations = new StoreWorkDrain('Graph set index is closing');
  /**
   * Pending full rebuild requested by a mutation whose exact graph effects can't
   * be applied incrementally. The stored source preserves the observer contract
   * while deferring expensive full-store scans until the next graph read.
   */
  private pendingFullRefresh: PendingFullRefreshSource | null = null;

  readonly graphEnumerationVisibility;
  constructor(inner: TripleStore, options: GraphSetIndexStoreOptions = {}) {
    this.inner = inner;
    this.innerStore = inner;
    this.commitment = inner.commitment;
    this.graphEnumerationVisibility = composeGraphEnumerationVisibility(inner, graph => !isAtomicGraphReplaceStagingGraph(graph));
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
    this.onDiagnostic = (options as GraphSetIndexStoreInternalOptions).onDiagnostic;
  }

  runLogicalMutation<T>(operation: StoreOperation, options: QueryOptions | undefined,
    work: (options: QueryOptions | undefined) => Promise<T>): Promise<T> {
    return this.mutations.run(() => runLogicalStoreMutation(this.inner, operation, options, work));
  }

  async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    return runImmutableMutation(this, { operation: 'insert', quads }, options);
  }

  async delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    return this.runLogicalMutation('delete', options, async options => {
      if (!this.enabled) {
        await this.inner.delete(quads, options);
        return;
      }
      await this.inner.delete(quads, options);
      const touched = namedGraphsFromQuads(quads);
      if (touched.length === 0) return;
      this.bumpMutation();
      await this.maintainTouchedGraphs(touched, 'delete', options);
    });
  }

  async deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    return this.runLogicalMutation('deleteByPattern', options, async options => {
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
    });
  }

  async deleteByPatternWithoutCount(
    pattern: Partial<Quad>,
    options?: QueryOptions,
  ): Promise<void> {
    return this.runLogicalMutation('deleteByPattern', options, async options => {
      if (!this.enabled) {
        await deleteByPatternWithoutCount(this.inner, pattern, options);
        return;
      }
      await deleteByPatternWithoutCount(this.inner, pattern, options);
      const graph = pattern.graph;
      if (graph) {
        this.bumpMutation();
        await this.maintainTouchedGraphs([graph], 'deleteByPattern', options);
      } else {
        // Without an exact count, conservatively invalidate even when the
        // pattern may have matched no rows. This preserves graph membership
        // correctness without reintroducing count-before/count-after scans.
        this.scheduleFullRefresh('deleteByPattern');
      }
    });
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
    return this.runUpdate(sparql, options, 'update');
  }

  async atomicUpdate(sparql: string, options?: UpdateOptions): Promise<void> {
    return this.runUpdate(sparql, options, 'atomicUpdate');
  }

  private async runUpdate(sparql: string, options: UpdateOptions | undefined, capability: 'update' | 'atomicUpdate'): Promise<void> {
    return this.runLogicalMutation('update', options, async scoped => {
      const scopedUpdateOptions: UpdateOptions = { ...options, ...scoped };
      if (typeof this.inner[capability] !== 'function') {
        throw new UnsupportedTripleStoreCapabilityError(capability, 'GraphSetIndexStore');
      }
      if (!this.enabled) {
        await this.inner[capability]!(sparql, scopedUpdateOptions);
        return;
      }
      await this.inner[capability]!(sparql, scopedUpdateOptions);
      // A server-side SPARQL UPDATE (e.g. the RS heal's INSERT…WHERE) can create or
      // drop named graphs the index must learn about. When the caller declares the
      // touched graphs (#1549: RS-heal + agents-meta prune write statically-known
      // URIs), maintain the index INCREMENTALLY — a bounded per-graph `hasGraph`
      // (which correctly handles an ASK-guarded INSERT that matched zero rows) —
      // instead of marking the whole index dirty. That keeps the index warm so
      // graph enumeration stays O(1) rather than forcing a full store scan on the
      // next read. Only opaque updates (no `touchedGraphs`) fall back to the lazy
      // full rebuild.
      if (scopedUpdateOptions?.touchedGraphs) {
        // Normalize the caller-supplied hint once at the boundary (filter falsy +
        // de-dupe), matching the `namedGraphsFromQuads` pattern — keeps the incremental
        // path predictable and avoids repeated `hasGraph` calls on duplicates.
        const touched = normalizeGraphUris(scopedUpdateOptions.touchedGraphs);
        if (touched.length > 0) {
          // Strip the update-only `touchedGraphs` hint before the maintenance READS
          // (`hasGraph`) — it is meaningless on the read path and must not be smuggled
          // through the `QueryOptions` boundary into read-path wrappers/diagnostics.
          const readOptions = queryOptionsFromUpdateOptions(scopedUpdateOptions);
          this.bumpMutation();
          await this.maintainTouchedGraphs(touched, 'update', readOptions);
          return;
        }
      }
      this.scheduleFullRefresh('update');
    });
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
    const indexed = this.catalog.has(graphUri);
    if (this.catalog.initialized && indexed !== hasGraph) {
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
    return this.runLogicalMutation('dropGraph', options, async options => {
      if (!this.enabled) {
        await this.inner.dropGraph(graphUri, options);
        return;
      }
      await this.inner.dropGraph(graphUri, options);
      this.bumpMutation();
      this.removeGraphs([graphUri], 'dropGraph');
    });
  }

  async replaceGraph(graphUri: string, quads: Quad[], options?: QueryOptions): Promise<void> {
    return runImmutableMutation(this, { operation: 'replaceGraph', graphUri, quads }, options);
  }

  async replaceAssetGroup(assets: readonly AtomicAssetReplacement[], options?: QueryOptions): Promise<void> {
    return runImmutableMutation(this, { operation: 'replaceAssetGroup', assets }, options);
  }

  async replaceGraphAndSubject(graphUri: string, graphQuads: Quad[], metaGraphUri: string,
    metadataSubject: string, metadataQuads: Quad[], options?: QueryOptions): Promise<void> {
    return runImmutableMutation(this, { operation: 'replaceGraphAndSubject', graphUri, graphQuads,
      metaGraphUri, metadataSubject, metadataQuads }, options);
  }

  async replaceSubject(graphUri: string, subject: string, quads: Quad[], options?: QueryOptions): Promise<void> {
    return runImmutableMutation(this, { operation: 'replaceSubject', graphUri, subject, quads }, options);
  }

  async replaceSubjectAndInsert(graphUri: string, subject: string, replacementQuads: Quad[], insertQuads: Quad[],
    options?: QueryOptions): Promise<void> {
    return runImmutableMutation(this, { operation: 'replaceSubjectAndInsert', graphUri, subject, replacementQuads, insertQuads }, options);
  }

  async rfc64AuthorCommitCasV1(input: Rfc64AuthorCommitCasInputV1, options?: QueryOptions): Promise<Rfc64AuthorCommitCasResultV1> {
    return runImmutableMutation(this, { operation: 'rfc64AuthorCommitCasV1', input }, options);
  }

  async prepareImmutableMutation<M extends ImmutableStoreMutation>(mutation: M): Promise<PreparedMutation<M>> {
    const operation = mutation.operation;
    assertImmutableMutationCapability(this.inner, operation);
    let command = mutation, touched: string[];
    switch (mutation.operation) {
      case 'insert': touched = namedGraphsFromQuads(mutation.quads); break;
      case 'replaceAssetGroup': touched = [...new Set(mutation.assets.flatMap(asset => [asset.graphUri, asset.metaGraphUri]))]; break;
      case 'replaceGraphAndSubject': touched = [mutation.graphUri, mutation.metaGraphUri]; break;
      case 'rfc64AuthorCommitCasV1': {
        // Copy/validate all fallible protocol inputs before dispatch and observation.
        const manifest = normalizeRfc64AuthorCommitCasV1(mutation.input);
        command = { ...mutation, input: sourceFromNormalizedRfc64AuthorCommitCasV1(manifest) };
        touched = [...manifest.touchedGraphs]; break;
      }
      default: touched = [mutation.graphUri];
    }
    const prepared = await prepareImmutableMutation(this.inner, command);
    return { operation, commit: async (scoped, appended) => {
      let result;
      try { result = await prepared.commit(scoped, appended); }
      catch (error) {
        const observeFailure = this.enabled || operation === 'replaceAssetGroup' || operation === 'replaceGraphAndSubject';
        if (operation !== 'insert' && observeFailure && !isStoreOperationNotStarted(error, operation)) this.scheduleFullRefresh(operation);
        throw error;
      }
      if (!this.enabled || (operation === 'rfc64AuthorCommitCasV1' && result === 'conflict')) return result;
      if (operation === 'insert') {
        // Changelog adds its markers only after preparation and sequence allocation.
        const graphs = normalizeGraphUris([...touched, ...namedGraphsFromQuads(appended ?? [])]);
        if (graphs.length) { this.bumpMutation(); this.addGraphs(graphs, operation); }
      } else {
        this.bumpMutation(); await this.maintainTouchedGraphs(touched, operation, scoped);
      }
      return result;
    } };
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    if (!this.enabled) {
      return (await this.inner.listGraphs(options)).filter(
        (graph) => !isAtomicGraphReplaceStagingGraph(graph),
      );
    }
    return [...await this.loadCurrentSortedGraphs(options)];
  }

  async listGraphsSorted(options?: QueryOptions): Promise<SortedGraphCatalog> {
    if (!this.enabled) {
      return createSortedUniqueStringCatalog(
        (await this.inner.listGraphs(options)).filter(
          (graph) => Boolean(graph) && !isAtomicGraphReplaceStagingGraph(graph),
        ),
      );
    }
    return this.loadCurrentSortedGraphs(options);
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
    const graphs = await this.loadCurrentSortedGraphs(options);
    // startsWith() is defined over UTF-16 code units, while this catalog is
    // ordered by Unicode code point. A prefix ending in a high surrogate can
    // split an astral code point, so its matches are not guaranteed to be one
    // contiguous code-point-sorted range. Preserve exact JS prefix semantics
    // with the rare O(n) fallback; all scalar-aligned prefixes keep O(log n+k).
    if (endsWithHighSurrogate(prefix)) {
      return graphs.filter((graph) => graph.startsWith(prefix));
    }
    const matches: string[] = [];
    for (let index = codePointLowerBound(graphs, prefix); index < graphs.length; index += 1) {
      const graph = graphs[index]!;
      if (!graph.startsWith(prefix)) break;
      matches.push(graph);
    }
    return matches;
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    return this.runLogicalMutation('deleteBySubjectPrefix', options, async options => {
      if (!this.enabled) {
        return this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
      }
      const removed = await this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
      if (removed <= 0) return removed;
      this.bumpMutation();
      await this.maintainTouchedGraphs([graphUri], 'deleteBySubjectPrefix', options);
      return removed;
    });
  }

  async countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    return this.inner.countQuads(graphUri, options);
  }

  async flush(options?: QueryOptions): Promise<void> {
    await this.inner.flush?.(options);
  }

  close(): Promise<void> {
    return this.mutations.close(() => this.inner.close());
  }

  private async ensureGraphSet(options?: QueryOptions): Promise<ReadonlySet<string>> {
    throwIfAborted(options?.signal);
    if (
      this.catalog.initialized &&
      !this.pendingFullRefresh &&
      this.revalidateMs > 0 &&
      this.now() < this.nextRevalidateAt
    ) {
      return this.catalog.current!;
    }
    return raceStoreWorkAgainstAbort(
      this.refreshIndex(
        this.pendingFullRefresh ?? (this.catalog.initialized ? 'revalidate' : 'seed'),
        options,
      ),
      options?.signal,
    );
  }

  private async refreshIndex(
    source: GraphSetRefreshSource,
    options?: QueryOptions,
  ): Promise<ReadonlySet<string>> {
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
        if (options?.signal?.aborted || !this.catalog.initialized || this.pendingFullRefresh) {
          throw error;
        }
        // A newer promoted refresh already published a usable graph set. Do
        // not let this older failed scan overwrite its healthy schedule with
        // failure backoff.
        if (!this.refreshCoordinator.shouldApplyFailureBackoff(flight)) return this.catalog.current!;
        // Periodic discovery of out-of-contract writers is advisory once the
        // write-through index is warm. Preserve that last known set and back
        // off after a store failure instead of making every graph reader repeat
        // the same expensive scan. Cold seeds and mutation-dirty rebuilds are
        // correctness paths: if either condition applies by the time the scan
        // fails, keep the original strict rejection behavior.
        this.noteRevalidationFailure();
        return this.catalog.current!;
      }
    });
  }

  private async refreshIndexLoop(
    source: GraphSetRefreshSource,
    options: QueryOptions | undefined,
    flight: RefreshFlight<ReadonlySet<string>>,
  ): Promise<ReadonlySet<string>> {
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
        return this.catalog.current ?? next;
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
      return this.catalog.current!;
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
        if (!this.catalog.initialized) return;
        if (generation !== this.mutationGeneration) {
          continue;
        }
        this.reconcileGraphs(graphPresence, source);
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
    this.catalog.clear();
    this.resetRevalidationSchedule();
  }

  private replaceGraphSet(next: Set<string>, source: GraphSetRefreshSource): void {
    const { added, removed } = this.catalog.replace(next);
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
    this.reconcileGraphs(graphs.map((graph) => ({ graph, present: true })), source);
  }

  private removeGraphs(graphs: string[], source: GraphSetMutationSource): void {
    this.reconcileGraphs(graphs.map((graph) => ({ graph, present: false })), source);
  }

  private reconcileGraphs(
    graphPresence: ReadonlyArray<Readonly<{ graph: string; present: boolean }>>,
    source: GraphSetMutationSource,
  ): void {
    if (!this.catalog.initialized) return;
    const eligible = graphPresence.filter(
      ({ graph, present }) => graph && (!present || !isAtomicGraphReplaceStagingGraph(graph)),
    );
    const { added, removed } = this.catalog.reconcile(eligible);
    for (const graph of added) {
      this.emit({ type: 'graph-added', graph, source });
    }
    for (const graph of removed) {
      this.emit({ type: 'graph-removed', graph, source });
    }
  }

  private async loadCurrentSortedGraphs(options?: QueryOptions): Promise<SortedGraphCatalog> {
    for (;;) {
      const members = await this.ensureGraphSet(options);
      // No async boundary exists between the identity check and projection.
      // If another continuation invalidated/replaced the catalog after
      // ensureGraphSet() resolved, retry instead of manufacturing an empty or
      // stale enumeration from unrelated mutable state.
      const sorted = this.catalog.sortedFor(members);
      if (sorted) return sorted;
      throwIfAborted(options?.signal);
    }
  }

  private async maintainTouchedGraphs(
    graphs: string[],
    source: TouchedGraphMutationSource,
    options?: QueryOptions,
  ): Promise<void> {
    if (!this.catalog.initialized) return;
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
