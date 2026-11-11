// SPDX-License-Identifier: Apache-2.0

/**
 * The read-graph layer: the decorator directly above the adapter, under the
 * read-graph partition guard and under every decorator that changes how a term
 * is stored. It therefore sees each write with the terms as stored, and the
 * graph catalog and the change log above it never see a read-graph write.
 * `createTripleStore` puts it on every store it builds.
 *
 * The layer keeps each read graph that has a row in its backend's state mirror
 * equal to the union of its member graphs. For every write it finds the read
 * graphs whose member graphs the write touches, takes their locks, and has the
 * adapter send the read-graph operations in the same request as the change
 * (`./adapter-contract.ts`, `./write-plan.ts`). An insert carries the
 * read-graph quads in the same call instead. A backend whose mirror holds no
 * row gets exactly the requests it gets without the layer.
 *
 * While its backend holds read graphs the layer refuses, before anything is
 * sent, every write it cannot maintain: an `update` that does not declare the
 * graphs it writes, a SPARQL UPDATE sent through `query`, a pattern delete
 * without a graph, and a write whose adapter has not declared that it can send
 * read-graph operations with it.
 *
 * Its state (locks, state mirror, registry snapshots, the writes in flight)
 * lives in the backend's {@link ReadGraphBackendRuntime}, which every store
 * object over the same backend shares. Storage-owned work on read graphs (the
 * start-up rule, rebuilds and checks) runs on the store below the layer, which
 * `readGraphPartitionMaintenanceStore` returns, under the same locks. Work that
 * starts on a read graph first waits for the writes that were in flight before
 * its row existed (`runtime.writes.settled()`): they were sent unmaintained.
 */

import { compareCodePoint, isSparqlUpdateOperation, readGraphIri, SparqlTermValidationError, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { createSparqlTermPolicy, legacyStrippedIriValue, type SparqlTermRenderer, type SparqlTermSite } from '../adapters/sparql-term-policy.js';
import type { AtomicAssetReplacement } from '../atomic-asset-group.js';
import { describeRfc64AuthorCommitCasV1 } from '../rfc64-author-commit-mutation.js';
import type { Rfc64AuthorCommitCasInputV1 } from '../rfc64-author-commit-cas.js';
import {
  STORE_OPERATION_OUTCOME_TAG,
  hasStoreOperationOutcome,
  type StoreOperation,
  type StoreOperationOutcomeErrorLike,
} from '../store-operation-outcome.js';
import {
  deleteByPatternWithoutCount,
  findTripleStoreCapability,
  type Quad,
  type QueryOptions,
  type QueryResult,
  type StorePressureSnapshot,
  type TripleStore,
  type TripleStoreDecorator,
  type UpdateOptions,
} from '../triple-store.js';
import type { TripleStoreConfig } from '../triple-store-composition.js';
import {
  missingReadGraphMethods,
  readGraphCapabilitiesOf,
  type ReadGraphAdapterCapabilities,
  type ReadGraphPlannedMethod,
  type ReadGraphWriteOptions,
  type ReadGraphWritePlan,
} from './adapter-contract.js';
import { readGraphMembership, readGraphsOfMemberGraph, type WorkingMemoryIdentityRule } from './membership.js';
import { readReadGraphRegistry } from './registry.js';
import { readGraphBackendIdentity, readGraphBackendRuntime, type ReadGraphBackendRuntime } from './runtime.js';
import { keepsAnyReadGraph, type ReadGraphModes, type ViewSemanticsSettings } from './settings.js';
import { ReadGraphsUnsupportedError } from './read-graphs-unsupported.js';
import { nextReadGraphState, readGraphStateCompareAndSet } from './state.js';
import type { ReadGraphTarget } from './statements.js';
import {
  joinReadGraphWriteChanges,
  readGraphWriteChange,
  readGraphWriteGraphs,
  type ReadGraphWrite,
  type ReadGraphWriteChange,
} from './write-plan.js';

/** The read-graph part of a store configuration. */
export interface ReadGraphStoreConfig {
  /**
   * The node's working-memory identity rule, for every store object over the
   * same backend. The agent can also set it later on the runtime.
   */
  readonly workingMemoryIdentity?: WorkingMemoryIdentityRule;
  /** Where the node keeps read graphs (`query.readGraphs`); all `off` when absent. */
  readonly modes?: ReadGraphModes;
  /** What a view query without `semantics` gets (`query.viewSemantics`); `per-asset` when absent. */
  readonly viewSemantics?: ViewSemanticsSettings;
}

export const READ_GRAPH_WRITE_REFUSED_CODE = 'READ_GRAPH_WRITE_REFUSED';

/**
 * The term policy of the read-graph operations. A valid term renders exactly
 * as in the adapter's own statement; a term that fails validation refuses the
 * write before anything is sent, whatever the adapter's own policy does.
 */
const READ_GRAPH_TERM_POLICY = createSparqlTermPolicy('reject');

/** A write the read-graph layer cannot maintain, refused before anything was sent. */
export class ReadGraphWriteRefusedError extends Error implements StoreOperationOutcomeErrorLike {
  readonly code = READ_GRAPH_WRITE_REFUSED_CODE;
  readonly storeOperationOutcomeTag = STORE_OPERATION_OUTCOME_TAG;
  readonly outcome = 'not_started' as const;

  constructor(readonly storeOperation: StoreOperation, reason: string) {
    super(`${storeOperation}() is refused while the store holds read graphs: ${reason}`);
    this.name = 'ReadGraphWriteRefusedError';
  }
}

/** A read graph a write touches, and the graphs of the write that are its members. */
interface MaintainedReadGraph {
  readonly target: ReadGraphTarget;
  readonly members: ReadonlySet<string>;
}

/** The read-graph layer over one adapter. See the module documentation. */
export class ReadGraphStore implements TripleStoreDecorator {
  readonly innerStore: TripleStore;
  /** The backend's shared state: locks, state mirror and registry snapshots. */
  readonly runtime: ReadGraphBackendRuntime;
  /** What the adapter below declares about read graphs; `undefined` when it declares nothing. */
  readonly adapterCapabilities: ReadGraphAdapterCapabilities | undefined;
  readonly graphEnumerationVisibility?: (graph: string) => boolean;
  readonly deleteByPatternWithoutCount?: TripleStore['deleteByPatternWithoutCount'];
  readonly replaceGraph?: TripleStore['replaceGraph'];
  readonly replaceAssetGroup?: TripleStore['replaceAssetGroup'];
  readonly replaceGraphAndSubject?: TripleStore['replaceGraphAndSubject'];
  readonly replaceSubject?: TripleStore['replaceSubject'];
  readonly replaceSubjectAndInsert?: TripleStore['replaceSubjectAndInsert'];
  readonly rfc64AuthorCommitCasV1?: TripleStore['rfc64AuthorCommitCasV1'];
  readonly update?: TripleStore['update'];
  readonly readGraphInventory?: TripleStore['readGraphInventory'];
  readonly listGraphsByPrefix?: TripleStore['listGraphsByPrefix'];
  readonly flush?: TripleStore['flush'];

  /**
   * `termSite` names the adapter whose renderer the delta forms use, so they
   * name each term exactly as the adapter's own statement does.
   */
  constructor(inner: TripleStore, runtime: ReadGraphBackendRuntime, private readonly termSite: SparqlTermSite['adapter'] = 'oxigraph') {
    this.innerStore = inner;
    this.runtime = runtime;
    RUNTIME_BELOW_LAYER.set(inner, runtime);
    this.adapterCapabilities = readGraphCapabilitiesOf(inner);
    // The layer hides nothing itself; the adapter's own rule passes through.
    if (inner.graphEnumerationVisibility) this.graphEnumerationVisibility = inner.graphEnumerationVisibility.bind(inner);
    // Each optional capability exists exactly when the store below has it.
    if (inner.deleteByPatternWithoutCount) this.deleteByPatternWithoutCount = (pattern, options) =>
      this.deleteMatching('deleteByPatternWithoutCount', pattern, options, (sent) => deleteByPatternWithoutCount(inner, pattern, sent));
    if (inner.replaceGraph) this.replaceGraph = (graphUri, quads, options) =>
      this.maintain('replaceGraph', replaceOf([graphUri], quads), options, (sent) => inner.replaceGraph!(graphUri, quads, sent));
    if (inner.replaceAssetGroup) this.replaceAssetGroup = (assets, options) =>
      this.maintain('replaceAssetGroup', replaceOf(assetGroupGraphs(assets), []), options, (sent) => inner.replaceAssetGroup!(assets, sent));
    if (inner.replaceGraphAndSubject) this.replaceGraphAndSubject = (graphUri, graphQuads, metaGraphUri, subject, metadataQuads, options) =>
      this.maintain('replaceGraphAndSubject', replaceOf([graphUri, metaGraphUri], [...graphQuads, ...metadataQuads]), options,
        (sent) => inner.replaceGraphAndSubject!(graphUri, graphQuads, metaGraphUri, subject, metadataQuads, sent));
    if (inner.replaceSubject) this.replaceSubject = (graphUri, subject, quads, options) =>
      this.maintain('replaceSubject', { kind: 'replace-subject', graph: graphUri, subject }, options,
        (sent) => inner.replaceSubject!(graphUri, subject, quads, sent));
    if (inner.replaceSubjectAndInsert) this.replaceSubjectAndInsert = (graphUri, subject, replacement, inserts, options) =>
      this.maintain('replaceSubjectAndInsert', { kind: 'replace-subject', graph: graphUri, subject, companions: inserts.map((quad) => quad.subject) },
        options, (sent) => inner.replaceSubjectAndInsert!(graphUri, subject, replacement, inserts, sent));
    if (inner.rfc64AuthorCommitCasV1) this.rfc64AuthorCommitCasV1 = (input, options) =>
      this.maintain('rfc64AuthorCommitCasV1', replaceOf(authorCommitGraphs(input), []), options, (sent) => inner.rfc64AuthorCommitCasV1!(input, sent));
    if (inner.update) this.update = (sparql, options) => this.declaredUpdate(options, (sent) => inner.update!(sparql, sent));
    if (inner.readGraphInventory) this.readGraphInventory = (prefix, options) => inner.readGraphInventory!(prefix, options);
    if (inner.listGraphsByPrefix) this.listGraphsByPrefix = (prefix, options) => inner.listGraphsByPrefix!(prefix, options);
    if (inner.flush) this.flush = (options) => inner.flush!(options);
  }

  get queryCancellation() {
    return this.innerStore.queryCancellation;
  }

  getPressureSnapshot(): StorePressureSnapshot | undefined {
    return this.innerStore.getPressureSnapshot?.();
  }

  insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    return this.runtime.writes.track(this.maintainInsert(quads, options));
  }

  private async maintainInsert(quads: Quad[], options: QueryOptions | undefined): Promise<void> {
    if (this.runtime.mirror.size === 0) return this.innerStore.insert(quads, options);
    const write: ReadGraphWrite = { kind: 'insert', quads };
    refuseRewrittenGraphNames('insert', write);
    return this.withMaintainedReadGraphs(write, options, (maintained) => {
      const added = this.changeOf('insert', write, maintained).insertQuads;
      return this.dispatch('insert', maintained, () => this.innerStore.insert(added.length === 0 ? quads : [...quads, ...added], options));
    });
  }

  delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    return this.maintain('delete', { kind: 'delete', quads }, options, (sent) => this.innerStore.delete(quads, sent));
  }

  deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    return this.deleteMatching('deleteByPattern', pattern, options, (sent) => this.innerStore.deleteByPattern(pattern, sent));
  }

  query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    if (!isSparqlUpdateOperation(sparql)) return this.innerStore.query(sparql, options);
    if (this.runtime.mirror.size > 0) {
      return Promise.reject(new ReadGraphWriteRefusedError('query', 'send it through update() and declare the graphs it writes'));
    }
    return this.runtime.writes.track(this.innerStore.query(sparql, options));
  }

  hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    return this.innerStore.hasGraph(graphUri, options);
  }

  createGraph(graphUri: string): Promise<void> {
    return this.innerStore.createGraph(graphUri);
  }

  dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    return this.maintain('dropGraph', { kind: 'replace', graphs: [graphUri], dropped: true }, options,
      (sent) => this.innerStore.dropGraph(graphUri, sent));
  }

  listGraphs(options?: QueryOptions): Promise<string[]> {
    return this.innerStore.listGraphs(options);
  }

  deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    return this.maintain('deleteBySubjectPrefix', { kind: 'delete-prefix', graph: graphUri, prefix }, options,
      (sent) => this.innerStore.deleteBySubjectPrefix(graphUri, prefix, sent));
  }

  countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    return this.innerStore.countQuads(graphUri, options);
  }

  close(): Promise<void> {
    return this.innerStore.close();
  }

  private deleteMatching<T>(
    method: 'deleteByPattern' | 'deleteByPatternWithoutCount',
    pattern: Partial<Quad>,
    options: QueryOptions | undefined,
    send: (options: QueryOptions | undefined) => Promise<T>,
  ): Promise<T> {
    if (this.runtime.mirror.size === 0) return this.runtime.writes.track(send(options));
    if (!pattern.graph) return Promise.reject(new ReadGraphWriteRefusedError('deleteByPattern', 'a pattern delete must name its graph'));
    const { subject, predicate, object } = pattern;
    return this.maintain(method, { kind: 'delete-matching', graph: pattern.graph, pattern: { subject, predicate, object } }, options, send);
  }

  private declaredUpdate(options: UpdateOptions | undefined, send: (options: UpdateOptions | undefined) => Promise<void>): Promise<void> {
    if (this.runtime.mirror.size === 0) return this.runtime.writes.track(send(options));
    const written = options?.writtenGraphs;
    if (written === undefined) {
      return Promise.reject(new ReadGraphWriteRefusedError('update', 'it does not declare the graphs it writes (writtenGraphs)'));
    }
    return this.maintain('update', { kind: 'replace', graphs: written }, options, send);
  }

  /**
   * Send a planned write with the operations of every read graph it touches.
   * Every write is tracked from here, before it finds its read graphs, until it settles.
   */
  private maintain<T, O extends QueryOptions>(
    method: ReadGraphPlannedMethod,
    write: ReadGraphWrite,
    options: O | undefined,
    send: (options: O | undefined) => Promise<T>,
  ): Promise<T> {
    return this.runtime.writes.track(this.sendMaintained(method, write, options, send));
  }

  private async sendMaintained<T, O extends QueryOptions>(
    method: ReadGraphPlannedMethod,
    write: ReadGraphWrite,
    options: O | undefined,
    send: (options: O | undefined) => Promise<T>,
  ): Promise<T> {
    if (this.runtime.mirror.size === 0) return send(options);
    refuseRewrittenGraphNames(method, write);
    return this.withMaintainedReadGraphs(write, options, (maintained) => {
      const change = this.changeOf(method, write, maintained);
      if (change.before.length + change.after.length === 0) return send(options);
      if (!this.adapterCapabilities?.methods.includes(method)) {
        throw new ReadGraphWriteRefusedError(storeOperationOf(method), 'its adapter cannot send read-graph operations with it');
      }
      const plan: ReadGraphWritePlan = {
        readGraphs: maintained.map(({ target }) => target.readGraph),
        before: change.before,
        after: change.after,
      };
      return this.dispatch(method, maintained, () => send({ ...options, readGraphPlan: plan } as O & ReadGraphWriteOptions));
    });
  }

  /**
   * Run `work` with the read graphs whose member graphs a write touches, under
   * their locks. The read graphs are found again after the locks are taken; a
   * row created while the write waited adds its lock, and the write tries
   * again.
   */
  private async withMaintainedReadGraphs<T>(
    write: ReadGraphWrite,
    options: QueryOptions | undefined,
    work: (maintained: readonly MaintainedReadGraph[]) => Promise<T>,
  ): Promise<T> {
    const graphs = readGraphWriteGraphs(write);
    const locked = new Set<string>();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.loadRegistries(options);
      const outcome = await this.runtime.locks.withLocks(locked, async (): Promise<{ readonly missing: readonly string[] } | { readonly done: T }> => {
        const maintained = this.maintainedReadGraphs(graphs);
        const missing = maintained.map(({ target }) => target.readGraph).filter((readGraph) => !locked.has(readGraph));
        return missing.length > 0 ? { missing } : { done: await work(maintained) };
      });
      if ('done' in outcome) return outcome.done;
      for (const readGraph of outcome.missing) locked.add(readGraph);
    }
    throw new Error('The read graphs of a write kept changing while it waited for their locks');
  }

  /** Read the registry of every context graph with read graphs that has no snapshot yet. */
  private async loadRegistries(options: QueryOptions | undefined): Promise<void> {
    for (const contextGraphId of this.runtime.mirror.contextGraphIds()) {
      if (this.runtime.registries.get(contextGraphId)) continue;
      this.runtime.registries.set(await readReadGraphRegistry(this.innerStore, contextGraphId, options));
    }
  }

  /** The read graphs with a row whose membership holds one of `graphs`, in code-point order. */
  private maintainedReadGraphs(graphs: readonly string[]): MaintainedReadGraph[] {
    const registryOf = (contextGraphId: string) => this.runtime.registries.get(contextGraphId);
    const identity = this.runtime.workingMemoryIdentity;
    const found = new Map<string, { readonly key: ReadGraphKey; readonly members: Set<string> }>();
    for (const graph of graphs) {
      for (const key of readGraphsOfMemberGraph(graph, registryOf, identity)) {
        const readGraph = readGraphIri(key);
        if (!this.runtime.mirror.get(readGraph)) continue;
        const entry = found.get(readGraph) ?? { key, members: new Set<string>() };
        entry.members.add(graph);
        found.set(readGraph, entry);
      }
    }
    return [...found.entries()].sort(([left], [right]) => compareCodePoint(left, right)).map(([readGraph, { key, members }]) => ({
      target: { readGraph, membership: readGraphMembership(key, registryOf(key.scope.contextGraphId)!, identity) },
      members,
    }));
  }

  /**
   * Send a maintained write. A write whose outcome is unknown can still be
   * running; on an engine that may run it beside a later request, its read
   * graphs are marked dirty.
   */
  private async dispatch<T>(method: ReadGraphPlannedMethod | 'insert', maintained: readonly MaintainedReadGraph[], send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (error) {
      if (!this.adapterCapabilities?.serialUpdates && !hasStoreOperationOutcome(error, storeOperationOf(method), 'not_started')) {
        await this.markDirty(maintained.map(({ target }) => target.readGraph));
      }
      throw error;
    }
  }

  /** Mark read graphs dirty: in the mirror first, then in the store. */
  private async markDirty(readGraphs: readonly string[]): Promise<void> {
    for (const readGraph of readGraphs) {
      const row = this.runtime.mirror.get(readGraph);
      if (!row || row.state === 'dirty') continue;
      const dirty = nextReadGraphState(row, { kind: 'mark-dirty' })!;
      this.runtime.mirror.set(dirty);
      // If this request fails as well, the stored row is older than the mirror's;
      // a rebuild then starts from the stored row.
      await this.innerStore.update?.(readGraphStateCompareAndSet(row, dirty), { source: 'storage.readGraphDirtyMark' })
        .catch(() => undefined);
    }
  }

  /** The read-graph operations of a write. A term they cannot name refuses the write before anything is sent. */
  private changeOf(method: ReadGraphPlannedMethod | 'insert', write: ReadGraphWrite, maintained: readonly MaintainedReadGraph[]): ReadGraphWriteChange {
    try {
      return joinReadGraphWriteChanges(maintained.map(({ target, members }) =>
        readGraphWriteChange(write, target, members, this.renderer(method))));
    } catch (error) {
      if (!(error instanceof SparqlTermValidationError)) throw error;
      throw new ReadGraphWriteRefusedError(storeOperationOf(method), 'it has a term its read-graph operations cannot name');
    }
  }

  private renderer(method: ReadGraphPlannedMethod | 'insert'): SparqlTermRenderer {
    // The adapter reports an invalid term for its own statement; the same term here is not reported twice.
    return READ_GRAPH_TERM_POLICY.renderer({ adapter: this.termSite, operation: storeOperationOf(method) }, () => {});
  }
}

export { READ_GRAPHS_UNSUPPORTED_CODE, ReadGraphsUnsupportedError } from './read-graphs-unsupported.js';

/**
 * Put the read-graph layer directly above an adapter. Store objects whose
 * configurations name the same backend share one runtime. Settings that keep
 * read graphs are refused, and the adapter closed, unless the adapter sends
 * read-graph operations with every planned write it implements.
 */
export function wrapReadGraphLayer(adapter: TripleStore, config: TripleStoreConfig): ReadGraphStore {
  const { workingMemoryIdentity, modes, viewSemantics } = config.readGraphs ?? {};
  const missing = keepsAnyReadGraph(modes) ? missingReadGraphMethods(adapter, readGraphCapabilitiesOf(adapter)) : [];
  if (missing.length > 0) {
    void adapter.close().catch(() => undefined);
    throw new ReadGraphsUnsupportedError(config.backend, missing);
  }
  const runtime = readGraphBackendRuntime(readGraphBackendIdentity(config));
  if (workingMemoryIdentity) runtime.workingMemoryIdentity = workingMemoryIdentity;
  if (modes) runtime.modes = modes;
  if (viewSemantics) runtime.viewSemantics = viewSemantics;
  return new ReadGraphStore(adapter, runtime, termSiteOf(config.backend));
}

/** The read-graph layer of a store's decorator chain, or `null` when it has none. */
export function readGraphLayerOf(store: unknown): ReadGraphStore | null {
  return findTripleStoreCapability(store, (candidate): candidate is ReadGraphStore => candidate instanceof ReadGraphStore);
}

/** The runtime of each store a layer wraps, so the store below the layer finds its backend's runtime too. */
const RUNTIME_BELOW_LAYER = new WeakMap<object, ReadGraphBackendRuntime>();

/**
 * The read-graph runtime of a store: the runtime of the layer in its chain,
 * or, for the store a layer wraps (what `readGraphPartitionMaintenanceStore`
 * returns), that layer's. `undefined` for a store no layer is above or in.
 */
export function readGraphRuntimeOf(store: unknown): ReadGraphBackendRuntime | undefined {
  const layer = readGraphLayerOf(store);
  if (layer) return layer.runtime;
  return typeof store === 'object' && store !== null ? RUNTIME_BELOW_LAYER.get(store) : undefined;
}

function termSiteOf(backend: TripleStoreConfig['backend']): SparqlTermSite['adapter'] {
  return backend === 'blazegraph' || backend === 'sparql-http' ? backend : 'oxigraph';
}

/**
 * Refuse a write that names a graph its adapter would write under another
 * name. The adapter's renderer deletes the characters that break an IRI from a
 * name that fails validation (`legacyStrippedIriValue`), angle brackets among
 * them. No read graph would know the graph it writes as a member, so the write
 * would skip maintenance.
 */
function refuseRewrittenGraphNames(method: ReadGraphPlannedMethod | 'insert', write: ReadGraphWrite): void {
  if (readGraphWriteGraphs(write).some((graph) => legacyStrippedIriValue(graph) !== graph)) {
    throw new ReadGraphWriteRefusedError(storeOperationOf(method), 'a graph name must be an IRI its adapter writes as given');
  }
}

function storeOperationOf(method: ReadGraphPlannedMethod | 'insert'): StoreOperation {
  return method === 'deleteByPatternWithoutCount' ? 'deleteByPattern' : method;
}

function replaceOf(graphs: readonly string[], quads: readonly Quad[]): ReadGraphWrite {
  return { kind: 'replace', graphs: [...graphs, ...quads.map((quad) => quad.graph)] };
}

function assetGroupGraphs(assets: readonly AtomicAssetReplacement[]): string[] {
  return assets.flatMap((asset) => [
    asset.graphUri, asset.metaGraphUri,
    ...asset.graphQuads.map((quad) => quad.graph), ...asset.metadataQuads.map((quad) => quad.graph),
  ]);
}

/** The graphs an RFC-64 author commit replaces or removes. An input its canonical plan refuses, the adapter refuses too. */
function authorCommitGraphs(input: Rfc64AuthorCommitCasInputV1): string[] {
  try {
    const described = describeRfc64AuthorCommitCasV1(input);
    return [...described.removals.map((removal) => removal.graph), ...described.quads.map((quad) => quad.graph)];
  } catch {
    return [];
  }
}
