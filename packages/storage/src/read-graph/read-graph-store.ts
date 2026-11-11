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
 * A write to a `_meta` graph can register or unregister a sub-graph or a
 * child context graph, which changes membership (`./registry-recognition.ts`).
 * The layer works out the registry a write leaves from the write's own
 * arguments and marks the read graphs whose membership changes dirty, under
 * their locks, before the write is sent; a mark the store does not take
 * refuses the write. An `update` names only the graphs it writes, so for one
 * that writes a `_meta` graph the registry is read again after it, under the
 * same locks, and so it is after a delete whose effect depends on how the
 * store compares literals. If that reading fails, every read graph of the
 * context graph is marked dirty.
 *
 * While its backend holds read graphs the layer refuses, before anything is
 * sent, every write it cannot maintain: an `update` that does not declare the
 * graphs it writes, a SPARQL UPDATE sent through `query`, a pattern delete
 * without a graph, and a write whose adapter has not declared that it can send
 * read-graph operations with it. A delete that names a blank node, on an
 * adapter that cannot send those operations with one (its engine deletes a
 * stored blank node by identity), marks its read graphs dirty under their
 * locks and goes without them.
 *
 * Its state (locks, state mirror, registry snapshots, the writes in flight)
 * lives in the backend's {@link ReadGraphBackendRuntime}, which every store
 * object over the same backend shares. Storage-owned work on read graphs (the
 * start-up rule, rebuilds and checks) runs on the store below the layer, which
 * `readGraphPartitionMaintenanceStore` returns, under the same locks. Work that
 * starts on a read graph first waits for the writes that were in flight before
 * its row existed (`runtime.writes.settled()`): they were sent unmaintained.
 */

import { compareCodePoint, isSparqlUpdateOperation, parseReadGraphIri, readGraphIri, SparqlTermValidationError, type ReadGraphKey } from '@origintrail-official/dkg-core';
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
  readGraphCapabilitiesOf,
  type ReadGraphAdapterCapabilities,
  type ReadGraphPlannedMethod,
  type ReadGraphWriteOptions,
  type ReadGraphWritePlan,
} from './adapter-contract.js';
import { readGraphMembership, readGraphsOfMemberGraph, type ReadGraphRegistrySnapshot, type WorkingMemoryIdentityRule } from './membership.js';
import {
  isExactRegistryWrite,
  readNamesOfNewSubGraphs,
  readReadGraphRegistryFacts,
  registryFactsAfter,
  registryGraphsOfWrite,
  registryOwnersOfGraph,
  registrySnapshotOfFacts,
  sameRegistry,
  type ReadGraphRegistryFact,
  type ReadGraphRegistryWrite,
} from './registry-recognition.js';
import { readGraphBackendIdentity, readGraphBackendRuntime, type ReadGraphBackendRuntime } from './runtime.js';
import { noteUnstoredReadGraphMark } from './mark-journal.js';
import { nextReadGraphState, readGraphStateMarkDirty, type ReadGraphStateRow } from './state.js';
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
}

export const READ_GRAPH_WRITE_REFUSED_CODE = 'READ_GRAPH_WRITE_REFUSED';
export const READ_GRAPH_MAINTENANCE_FAILED_CODE = 'READ_GRAPH_MAINTENANCE_FAILED';

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

/**
 * A write that completed, whose read-graph maintenance after it failed: the
 * registry it may change could not be read again. Its read graphs are marked
 * dirty. The outcome is `indeterminate` for the write itself, so no caller
 * takes it for a write that never started and sends it again; the failure of
 * the maintenance step is the `cause`.
 */
export class ReadGraphMaintenanceError extends Error implements StoreOperationOutcomeErrorLike {
  readonly code = READ_GRAPH_MAINTENANCE_FAILED_CODE;
  readonly storeOperationOutcomeTag = STORE_OPERATION_OUTCOME_TAG;
  readonly outcome = 'indeterminate' as const;

  constructor(readonly storeOperation: StoreOperation, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${storeOperation}() ran, but the read-graph registry it may change could not be read again: ${reason}`, { cause });
    this.name = 'ReadGraphMaintenanceError';
  }
}

/** The fences registry writes have set on each backend's read graphs and not lifted, by read graph. */
const ACTIVE_FENCES = new WeakMap<ReadGraphBackendRuntime, Map<string, ReadGraphStateRow>>();

function activeFences(runtime: ReadGraphBackendRuntime): Map<string, ReadGraphStateRow> {
  let fences = ACTIVE_FENCES.get(runtime);
  if (!fences) {
    fences = new Map();
    ACTIVE_FENCES.set(runtime, fences);
  }
  return fences;
}

/** A ready row taken out of service in the mirror while a registry write runs, and the row it was. */
interface ReadGraphFence {
  readonly row: ReadGraphStateRow;
  readonly fence: ReadGraphStateRow;
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
      this.maintain('replaceGraph', replaceOf([graphUri], quads), options, (sent) => inner.replaceGraph!(graphUri, quads, sent),
        { kind: 'graph', graph: graphUri, quads });
    if (inner.replaceAssetGroup) this.replaceAssetGroup = (assets, options) =>
      this.maintain('replaceAssetGroup', replaceOf(assetGroupGraphs(assets), []), options, (sent) => inner.replaceAssetGroup!(assets, sent), {
        kind: 'all',
        parts: assets.flatMap((asset): ReadGraphRegistryWrite[] => [
          { kind: 'graph', graph: asset.graphUri, quads: asset.graphQuads },
          { kind: 'subject', graph: asset.metaGraphUri, subject: asset.metadataSubject, quads: asset.metadataQuads },
        ]),
      });
    if (inner.replaceGraphAndSubject) this.replaceGraphAndSubject = (graphUri, graphQuads, metaGraphUri, subject, metadataQuads, options) =>
      this.maintain('replaceGraphAndSubject', replaceOf([graphUri, metaGraphUri], [...graphQuads, ...metadataQuads]), options,
        (sent) => inner.replaceGraphAndSubject!(graphUri, graphQuads, metaGraphUri, subject, metadataQuads, sent), {
          kind: 'all',
          // The adapters replace the subject first and the graph last, which wins when both are one graph.
          parts: [{ kind: 'subject', graph: metaGraphUri, subject, quads: metadataQuads }, { kind: 'graph', graph: graphUri, quads: graphQuads }],
        });
    if (inner.replaceSubject) this.replaceSubject = (graphUri, subject, quads, options) =>
      this.maintain('replaceSubject', { kind: 'replace-subject', graph: graphUri, subject }, options,
        (sent) => inner.replaceSubject!(graphUri, subject, quads, sent), { kind: 'subject', graph: graphUri, subject, quads });
    if (inner.replaceSubjectAndInsert) this.replaceSubjectAndInsert = (graphUri, subject, replacement, inserts, options) =>
      this.maintain('replaceSubjectAndInsert', { kind: 'replace-subject', graph: graphUri, subject, companions: inserts.map((quad) => quad.subject) },
        options, (sent) => inner.replaceSubjectAndInsert!(graphUri, subject, replacement, inserts, sent), {
          kind: 'all',
          parts: [{ kind: 'subject', graph: graphUri, subject, quads: replacement }, { kind: 'quads', added: inserts, removed: [] }],
        });
    // A commit can lose its guard and change nothing, so its registry effect is read after it.
    if (inner.rfc64AuthorCommitCasV1) this.rfc64AuthorCommitCasV1 = (input, options) =>
      this.maintain('rfc64AuthorCommitCasV1', replaceOf(authorCommitGraphs(input), []), options, (sent) => inner.rfc64AuthorCommitCasV1!(input, sent),
        { kind: 'opaque', graphs: authorCommitGraphs(input) });
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
    return this.withMaintainedReadGraphs('insert', write, options, (maintained) => {
      const added = this.changeOf('insert', write, maintained).insertQuads;
      return this.dispatch('insert', maintained, () => this.innerStore.insert(added.length === 0 ? quads : [...quads, ...added], options));
    }, { kind: 'quads', added: quads, removed: [] });
  }

  delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    return this.maintain('delete', { kind: 'delete', quads }, options, (sent) => this.innerStore.delete(quads, sent),
      { kind: 'quads', added: [], removed: quads });
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
      (sent) => this.innerStore.dropGraph(graphUri, sent), { kind: 'graph', graph: graphUri, quads: [] });
  }

  listGraphs(options?: QueryOptions): Promise<string[]> {
    return this.innerStore.listGraphs(options);
  }

  deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    return this.maintain('deleteBySubjectPrefix', { kind: 'delete-prefix', graph: graphUri, prefix }, options,
      (sent) => this.innerStore.deleteBySubjectPrefix(graphUri, prefix, sent), { kind: 'prefix', graph: graphUri, prefix });
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
    return this.maintain(method, { kind: 'delete-matching', graph: pattern.graph, pattern: { subject, predicate, object } }, options, send,
      { kind: 'match', graph: pattern.graph, ...(subject ? { subject } : {}), ...(predicate ? { predicate } : {}), ...(object ? { object } : {}) });
  }

  private declaredUpdate(options: UpdateOptions | undefined, send: (options: UpdateOptions | undefined) => Promise<void>): Promise<void> {
    if (this.runtime.mirror.size === 0) return this.runtime.writes.track(send(options));
    const written = options?.writtenGraphs;
    if (written === undefined) {
      return Promise.reject(new ReadGraphWriteRefusedError('update', 'it does not declare the graphs it writes (writtenGraphs)'));
    }
    return this.maintain('update', { kind: 'replace', graphs: written }, options, send, { kind: 'opaque', graphs: written });
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
    registry?: ReadGraphRegistryWrite,
  ): Promise<T> {
    return this.runtime.writes.track(this.sendMaintained(method, write, options, send, registry));
  }

  private async sendMaintained<T, O extends QueryOptions>(
    method: ReadGraphPlannedMethod,
    write: ReadGraphWrite,
    options: O | undefined,
    send: (options: O | undefined) => Promise<T>,
    registry?: ReadGraphRegistryWrite,
  ): Promise<T> {
    if (this.runtime.mirror.size === 0) return send(options);
    refuseRewrittenGraphNames(method, write);
    return this.withMaintainedReadGraphs(storeOperationOf(method), write, options, async (maintained) => {
      if (maintained.length > 0 && this.adapterCapabilities?.plansBlankNodeDeletes === false && namesBlankNode(write)) {
        // The adapter deletes a stored blank node by its identity, which no read-graph operation can name: the
        // read graphs are marked dirty first, and the delete goes without a plan, with its own exact semantics.
        await this.markDirtyStrict(maintained.map(({ target }) => target.readGraph), storeOperationOf(method));
        return send(options);
      }
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
    }, registry);
  }

  /**
   * Run `work` with the read graphs whose member graphs a write touches, under
   * their locks, together with the locks of every read graph of a context
   * graph whose registry the write may change. The read graphs are found again
   * after the locks are taken; a row created while the write waited adds its
   * lock, and the write tries again.
   */
  private async withMaintainedReadGraphs<T>(
    operation: StoreOperation,
    write: ReadGraphWrite,
    options: QueryOptions | undefined,
    work: (maintained: readonly MaintainedReadGraph[]) => Promise<T>,
    registry?: ReadGraphRegistryWrite,
  ): Promise<T> {
    const graphs = readGraphWriteGraphs(write);
    const registryGraphs = registry ? registryGraphsOfWrite(registry) : [];
    const locked = new Set<string>();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.loadRegistries(options);
      const outcome = await this.runtime.locks.withLocks(locked, async (): Promise<{ readonly missing: readonly string[] } | { readonly done: T }> => {
        const maintained = this.maintainedReadGraphs(graphs);
        const owners = this.registryOwnersWithRows(registryGraphs);
        const missing = [...maintained.map(({ target }) => target.readGraph), ...owners.flatMap((owner) => this.readGraphsOf(owner))]
          .filter((readGraph) => !locked.has(readGraph));
        if (missing.length > 0) return { missing };
        const run = () => work(maintained);
        return { done: await (owners.length === 0 ? run() : this.withRecognizedRegistry(operation, owners, registry!, options, run)) };
      });
      if ('done' in outcome) return outcome.done;
      for (const readGraph of outcome.missing) locked.add(readGraph);
    }
    throw new Error('The read graphs of a write kept changing while it waited for their locks');
  }

  /**
   * Read the registry of every context graph with read graphs that has no
   * snapshot yet. It runs without locks, so what it read is installed only if
   * no write set or forgot the entry meanwhile: that write's entry is newer.
   * Facts forgotten under a snapshot are read again under the locks, by the
   * next write that may change the registry.
   */
  private async loadRegistries(options: QueryOptions | undefined): Promise<void> {
    for (const contextGraphId of this.runtime.mirror.contextGraphIds()) {
      if (this.runtime.registries.get(contextGraphId)) continue;
      const version = this.runtime.registries.version(contextGraphId);
      const facts = await readReadGraphRegistryFacts(this.innerStore, contextGraphId, options);
      if (this.runtime.registries.version(contextGraphId) === version) {
        this.runtime.registries.set(registrySnapshotOfFacts(contextGraphId, facts), facts);
      }
    }
  }

  /**
   * Read a context graph's registry facts again, under the locks of its read
   * graphs, mark the read graphs whose membership they change, and keep them.
   * If a mark is not stored, this throws before they are kept: the cached
   * registry stays the one the marks were measured against.
   */
  private async refreshRegistry(contextGraphId: string, options: QueryOptions | undefined): Promise<readonly ReadGraphRegistryFact[]> {
    const facts = await readReadGraphRegistryFacts(this.innerStore, contextGraphId, options);
    const snapshot = registrySnapshotOfFacts(contextGraphId, facts);
    await this.markMembershipChange(contextGraphId, snapshot);
    this.runtime.registries.set(snapshot, facts);
    return facts;
  }

  /** The context graphs with read graphs whose registry facts can sit in one of `graphs`. */
  private registryOwnersWithRows(graphs: readonly string[]): string[] {
    if (graphs.length === 0) return [];
    const withRows = new Set(this.runtime.mirror.contextGraphIds());
    return [...new Set(graphs.flatMap(registryOwnersOfGraph))].filter((owner) => withRows.has(owner)).sort(compareCodePoint);
  }

  /** Take the ready read graphs of a context graph out of service, in the mirror only, and return what to put back. */
  private fence(contextGraphId: string): ReadGraphFence[] {
    return this.readGraphsOf(contextGraphId).flatMap((readGraph) => {
      const row = this.runtime.mirror.get(readGraph);
      if (row?.state !== 'ready') return [];
      const fence = nextReadGraphState(row, { kind: 'mark-dirty' })!;
      this.runtime.mirror.set(fence);
      activeFences(this.runtime).set(readGraph, fence);
      return [{ row, fence }];
    });
  }

  /**
   * Put back each fenced read graph the mirror still holds as fenced: in
   * service again where its membership is the same under the registry from
   * before the write (`before`) and the one now cached, and as it was before
   * the fence otherwise, for a mark from its row. A refresh that moved a
   * membership has marked that read graph already.
   */
  private liftFence(fences: readonly ReadGraphFence[], before: ReadGraphRegistrySnapshot | undefined): void {
    const identity = this.runtime.workingMemoryIdentity;
    for (const { row, fence } of fences) {
      // A mark since the fence was set made the read graph dirty for good.
      if (activeFences(this.runtime).get(row.readGraph) !== fence) continue;
      activeFences(this.runtime).delete(row.readGraph);
      const current = this.runtime.mirror.get(row.readGraph);
      if (!current || current.state !== fence.state || current.generation !== fence.generation) continue;
      const key = parseReadGraphIri(row.readGraph);
      const after = key ? this.runtime.registries.get(key.scope.contextGraphId) : undefined;
      const kept = before !== undefined && after !== undefined && key !== undefined
        && JSON.stringify(readGraphMembership(key, before, identity)) === JSON.stringify(readGraphMembership(key, after, identity));
      if (kept || before === undefined) this.runtime.mirror.set(row);
    }
  }

  /** The read graphs of one context graph that have a row. */
  private readGraphsOf(contextGraphId: string): string[] {
    return this.runtime.mirror.rows().map((row) => row.readGraph)
      .filter((readGraph) => parseReadGraphIri(readGraph)?.scope.contextGraphId === contextGraphId);
  }

  /**
   * Send a write that may change the registry of context graphs with read
   * graphs. Where its arguments show the registry it leaves, the read graphs
   * whose membership changes are marked dirty before it is sent, and the
   * write is refused if the store does not take a mark. Where they do not,
   * the registry is read again after it, whether it succeeded or not, and
   * they are marked then.
   */
  private async withRecognizedRegistry<T>(
    operation: StoreOperation,
    owners: readonly string[],
    registry: ReadGraphRegistryWrite,
    options: QueryOptions | undefined,
    send: () => Promise<T>,
  ): Promise<T> {
    const predicted = new Map<string, ReadGraphRegistryFact[]>();
    // Where only a read after the write tells what it changes, its context graph's ready read graphs are out of
    // service in this process until that read: no query takes a union the store's new registry no longer gives.
    const fenced = new Map<string, readonly ReadGraphFence[]>();
    for (const owner of owners) {
      let cached: readonly ReadGraphRegistryFact[];
      let names: ReadGraphRegistryFact[] | undefined;
      try {
        cached = this.runtime.registries.facts(owner) ?? await this.refreshRegistry(owner, options);
        names = await readNamesOfNewSubGraphs(this.innerStore, owner, cached, registry, options);
      } catch (error) {
        if (error instanceof ReadGraphWriteRefusedError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new ReadGraphWriteRefusedError(operation, `the registry it changes could not be read and settled: ${reason}`);
      }
      const after = registryFactsAfter(owner, [...cached, ...(names ?? [])], registry);
      if (after !== undefined) {
        // Marked from the prediction either way; one that may over-count, or lacks a name, is read again after the write.
        if (names !== undefined && isExactRegistryWrite(owner, registry)) predicted.set(owner, after);
        await this.markMembershipChange(owner, registrySnapshotOfFacts(owner, after), operation);
      }
      if (!predicted.has(owner)) fenced.set(owner, this.fence(owner));
    }
    const settle = async (succeeded: boolean) => {
      let failure: { readonly error: unknown } | undefined;
      for (const owner of owners) {
        const after = predicted.get(owner);
        if (succeeded && after !== undefined) {
          this.runtime.registries.set(registrySnapshotOfFacts(owner, after), after);
          continue;
        }
        // Opaque, or not exactly predicted, or failed and so may or may not have run: read the facts again.
        const before = this.runtime.registries.get(owner);
        try {
          await this.refreshRegistry(owner, options);
          this.liftFence(fenced.get(owner) ?? [], before);
        } catch (error) {
          // What the write did to this registry is unknown: every read graph of the context graph goes dirty,
          // and the facts are read again before the next write that may change it. The other owners settle all the same.
          this.liftFence(fenced.get(owner) ?? [], undefined);
          await this.markDirty(this.readGraphsOf(owner));
          this.runtime.registries.forgetFacts(owner);
          failure ??= { error };
        }
      }
      // The write ran: whatever classified the failure of this step does not describe the write.
      if (succeeded && failure) throw new ReadGraphMaintenanceError(operation, failure.error);
    };
    let result: T;
    try {
      result = await send();
    } catch (error) {
      await settle(false);
      // On an engine that may run it beside later requests, a write whose outcome is unknown can still change the
      // registry after any reading of it: every read graph of its context graphs goes dirty, and the facts are read
      // again before the next write that may change them.
      if (!this.adapterCapabilities?.serialUpdates && !hasStoreOperationOutcome(error, operation, 'not_started')) {
        for (const owner of owners) {
          await this.markDirty(this.readGraphsOf(owner));
          this.runtime.registries.forgetFacts(owner);
        }
      }
      throw error;
    }
    await settle(true);
    return result;
  }

  /**
   * Mark dirty the read graphs of a context graph whose membership the
   * registry `next` changes: in the mirror, then in the store from whatever
   * row it holds, so a mark an earlier attempt could not store is sent again.
   * A mark the store does not take throws. Before the write (`unsent`, its
   * operation) the write is refused; after it, the caller leaves the registry
   * unsettled, so the next write that may change it reads it and marks again.
   * No stored `ready` row then outlives a change it misses.
   */
  private async markMembershipChange(contextGraphId: string, next: ReadGraphRegistrySnapshot, unsent?: StoreOperation): Promise<void> {
    const current = this.runtime.registries.get(contextGraphId);
    if (!current || sameRegistry(current, next)) return;
    const identity = this.runtime.workingMemoryIdentity;
    const changed = this.readGraphsOf(contextGraphId).filter((readGraph) => {
      const key = parseReadGraphIri(readGraph);
      return key !== undefined
        && JSON.stringify(readGraphMembership(key, current, identity)) !== JSON.stringify(readGraphMembership(key, next, identity));
    });
    await this.markDirtyStrict(changed, unsent);
  }

  /**
   * Mark read graphs dirty: in the mirror first, then in the store from
   * whatever row it holds, so a mark an earlier attempt could not store is
   * sent again. A mark the store does not take throws; before a write
   * (`unsent`, its operation) the write is refused instead.
   */
  private async markDirtyStrict(readGraphs: readonly string[], unsent?: StoreOperation): Promise<void> {
    // An explicit mark ends any fence a registry write set on these read graphs: they stay out of service.
    for (const readGraph of readGraphs) activeFences(this.runtime).delete(readGraph);
    const rows = readGraphs.flatMap((readGraph) => this.runtime.mirror.get(readGraph) ?? []);
    for (const row of rows) if (row.state !== 'dirty') this.runtime.mirror.set(nextReadGraphState(row, { kind: 'mark-dirty' })!);
    for (const { readGraph } of rows) {
      try {
        if (!this.innerStore.update) throw new Error('its adapter has no update()');
        await this.innerStore.update(readGraphStateMarkDirty(readGraph), { source: 'storage.readGraphDirtyMark' });
      } catch (error) {
        if (unsent === undefined) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new ReadGraphWriteRefusedError(unsent, `a read graph it changes could not be marked dirty: ${reason}`);
      }
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
      activeFences(this.runtime).delete(readGraph);
      const row = this.runtime.mirror.get(readGraph);
      if (!row) continue;
      if (row.state !== 'dirty') this.runtime.mirror.set(nextReadGraphState(row, { kind: 'mark-dirty' })!);
      // From whatever row is stored, and even when the mirror already says dirty: an earlier mark may not have
      // reached the store. If this request fails as well, a rebuild starts from the stored row, and the journal
      // keeps the mark for a start-up (an earlier failure kept it already).
      await this.innerStore.update?.(readGraphStateMarkDirty(readGraph), { source: 'storage.readGraphDirtyMark' })
        .catch(() => { if (row.state !== 'dirty') noteUnstoredReadGraphMark(this.runtime, readGraph, row.generation); });
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

/**
 * Put the read-graph layer directly above an adapter. Store objects whose
 * configurations name the same backend share one runtime.
 */
export function wrapReadGraphLayer(adapter: TripleStore, config: TripleStoreConfig): ReadGraphStore {
  const runtime = readGraphBackendRuntime(readGraphBackendIdentity(config));
  const identity = config.readGraphs?.workingMemoryIdentity;
  if (identity) runtime.workingMemoryIdentity = identity;
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

/** A delete that names a blank node, in a quad or in its pattern. */
function namesBlankNode(write: ReadGraphWrite): boolean {
  const blank = (term: string | undefined) => term?.startsWith('_:') === true;
  if (write.kind === 'delete') return write.quads.some((quad) => blank(quad.subject) || blank(quad.object));
  if (write.kind === 'delete-matching') return blank(write.pattern.subject) || blank(write.pattern.object);
  return false;
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
