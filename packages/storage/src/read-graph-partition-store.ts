// SPDX-License-Identifier: Apache-2.0
import { isSparqlUpdateOperation, parseReadGraphIri } from '@origintrail-official/dkg-core';
import { REGISTERED_NAMED_GRAPH_ENUMERATION_QUERY } from './adapters/graph-enumeration-query.js';
import { legacyStrippedIriValue } from './adapters/sparql-term-policy.js';
import { composeGraphEnumerationVisibility, isReadGraphPartitionGraph } from './graph-enumeration-visibility.js';
import { sparqlUpdateReach } from './read-graph-partition-reference.js';
import { describeRfc64AuthorCommitCasV1 } from './rfc64-author-commit-mutation.js';
import { readGraphLayerOf, readGraphRuntimeOf } from './read-graph/read-graph-store.js';
import {
  STORE_OPERATION_OUTCOME_TAG,
  type StoreOperation,
  type StoreOperationOutcomeErrorLike,
} from './store-operation-outcome.js';
import {
  deleteByPatternWithoutCount,
  findTripleStoreCapability,
  type Quad,
  type QueryOptions,
  type QueryResult,
  type StorePressureSnapshot,
  type TripleStore,
  type TripleStoreDecorator,
} from './triple-store.js';

export const READ_GRAPH_PARTITION_WRITE_CODE = 'READ_GRAPH_PARTITION_WRITE';

/** A write could reach a read-graph partition; it was refused before it reached the store. */
export class ReadGraphPartitionWriteError extends Error implements StoreOperationOutcomeErrorLike {
  readonly code = READ_GRAPH_PARTITION_WRITE_CODE;
  readonly storeOperationOutcomeTag = STORE_OPERATION_OUTCOME_TAG;
  readonly outcome = 'not_started' as const;

  constructor(readonly storeOperation: StoreOperation, readonly graph: string | undefined) {
    super(`${storeOperation}() ${graph === undefined ? 'may write into' : `names <${graph}> in`} a read-graph `
      + 'partition, which only storage writes');
    this.name = 'ReadGraphPartitionWriteError';
  }
}

/**
 * Whether a caller's graph name targets a read-graph partition: as given, or
 * as an adapter writes a name that fails validation, with its IRI-breaking
 * characters deleted (`legacyStrippedIriValue`, the renderer's own rule).
 * Every check of a caller's graph name against the partition goes through it.
 */
export function isReadGraphPartitionWriteTarget(graph: string): boolean {
  return isReadGraphPartitionGraph(graph) || isReadGraphPartitionGraph(legacyStrippedIriValue(graph));
}

function refuseGraph(graph: string | undefined, operation: StoreOperation): void {
  if (graph !== undefined && isReadGraphPartitionWriteTarget(graph)) throw new ReadGraphPartitionWriteError(operation, graph);
}

/**
 * A pattern delete that names a partition graph is refused. One that names no
 * graph reaches every graph, so it is refused while the store may hold
 * partitions.
 */
function refusePattern(store: TripleStore, graph: string | undefined, operation: StoreOperation): void {
  if (graph) refuseGraph(graph, operation);
  else if (storeMayHoldReadGraphPartitions(store)) throw new ReadGraphPartitionWriteError(operation, undefined);
}

function refuseQuads(quads: readonly Quad[], operation: StoreOperation): void {
  for (const quad of quads) refuseGraph(quad.graph, operation);
}

/**
 * An UPDATE that may write into a partition is refused. One that clears or
 * drops a whole-store target is refused while the store may hold partitions.
 */
function refuseSparql(store: TripleStore, sparql: string, operation: StoreOperation): void {
  const reach = sparqlUpdateReach(sparql);
  if (reach === 'partition' || (reach === 'every-graph' && storeMayHoldReadGraphPartitions(store))) {
    throw new ReadGraphPartitionWriteError(operation, undefined);
  }
}

/**
 * Every context graph's read-graph partition (`{cg}/_~read`) holds node-local
 * derived graphs and their state, and only storage writes there. This
 * decorator sits directly above the adapter. It refuses every write that names
 * a graph in a partition, and answers that such a graph is absent; the
 * adapters already leave the partition out of enumeration. Storage-owned work
 * on the partition uses {@link readGraphPartitionMaintenanceStore}. A SPARQL
 * UPDATE is refused when its text names a partition graph, or when it writes
 * through a graph variable, whose target only the store would know. A pattern
 * delete without a graph, and an UPDATE that clears or drops a whole-store
 * target, are refused while the store may hold partitions.
 */
export class ReadGraphPartitionStore implements TripleStoreDecorator {
  readonly innerStore: TripleStore;
  readonly graphEnumerationVisibility;
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

  constructor(inner: TripleStore) {
    this.innerStore = inner;
    this.graphEnumerationVisibility = composeGraphEnumerationVisibility(inner, graph => !isReadGraphPartitionGraph(graph));
    // Each optional capability exists exactly when the store below has it.
    if (inner.deleteByPatternWithoutCount) this.deleteByPatternWithoutCount = async (pattern, options) => {
      refusePattern(inner, pattern.graph, 'deleteByPattern');
      return deleteByPatternWithoutCount(inner, pattern, options);
    };
    if (inner.replaceGraph) this.replaceGraph = async (graphUri, quads, options) => {
      refuseGraph(graphUri, 'replaceGraph');
      refuseQuads(quads, 'replaceGraph');
      return inner.replaceGraph!(graphUri, quads, options);
    };
    if (inner.replaceAssetGroup) this.replaceAssetGroup = async (assets, options) => {
      for (const asset of assets) {
        refuseGraph(asset.graphUri, 'replaceAssetGroup');
        refuseGraph(asset.metaGraphUri, 'replaceAssetGroup');
        refuseQuads(asset.graphQuads, 'replaceAssetGroup');
        refuseQuads(asset.metadataQuads, 'replaceAssetGroup');
      }
      return inner.replaceAssetGroup!(assets, options);
    };
    if (inner.replaceGraphAndSubject) this.replaceGraphAndSubject = async (graphUri, graphQuads, metaGraphUri, subject, metadataQuads, options) => {
      refuseGraph(graphUri, 'replaceGraphAndSubject');
      refuseGraph(metaGraphUri, 'replaceGraphAndSubject');
      refuseQuads(graphQuads, 'replaceGraphAndSubject');
      refuseQuads(metadataQuads, 'replaceGraphAndSubject');
      return inner.replaceGraphAndSubject!(graphUri, graphQuads, metaGraphUri, subject, metadataQuads, options);
    };
    if (inner.replaceSubject) this.replaceSubject = async (graphUri, subject, quads, options) => {
      refuseGraph(graphUri, 'replaceSubject');
      refuseQuads(quads, 'replaceSubject');
      return inner.replaceSubject!(graphUri, subject, quads, options);
    };
    if (inner.replaceSubjectAndInsert) this.replaceSubjectAndInsert = async (graphUri, subject, replacement, inserts, options) => {
      refuseGraph(graphUri, 'replaceSubjectAndInsert');
      refuseQuads(replacement, 'replaceSubjectAndInsert');
      refuseQuads(inserts, 'replaceSubjectAndInsert');
      return inner.replaceSubjectAndInsert!(graphUri, subject, replacement, inserts, options);
    };
    if (inner.rfc64AuthorCommitCasV1) this.rfc64AuthorCommitCasV1 = async (input, options) => {
      let described: ReturnType<typeof describeRfc64AuthorCommitCasV1> | undefined;
      // An input its canonical plan refuses is refused by the store below as well.
      try { described = describeRfc64AuthorCommitCasV1(input); } catch { described = undefined; }
      for (const removal of described?.removals ?? []) refuseGraph(removal.graph, 'rfc64AuthorCommitCasV1');
      refuseQuads(described?.quads ?? [], 'rfc64AuthorCommitCasV1');
      return inner.rfc64AuthorCommitCasV1!(input, options);
    };
    if (inner.update) this.update = async (sparql, options) => {
      for (const graph of options?.touchedGraphs ?? []) refuseGraph(graph, 'update');
      refuseSparql(inner, sparql, 'update');
      return inner.update!(sparql, options);
    };
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

  async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    refuseQuads(quads, 'insert');
    return this.innerStore.insert(quads, options);
  }

  async delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    refuseQuads(quads, 'delete');
    return this.innerStore.delete(quads, options);
  }

  async deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    refusePattern(this.innerStore, pattern.graph, 'deleteByPattern');
    return this.innerStore.deleteByPattern(pattern, options);
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    if (isSparqlUpdateOperation(sparql)) refuseSparql(this.innerStore, sparql, 'query');
    return this.innerStore.query(sparql, options);
  }

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    if (isReadGraphPartitionWriteTarget(graphUri)) return false;
    return this.innerStore.hasGraph(graphUri, options);
  }

  async createGraph(graphUri: string): Promise<void> {
    refuseGraph(graphUri, 'createGraph');
    return this.innerStore.createGraph(graphUri);
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    refuseGraph(graphUri, 'dropGraph');
    return this.innerStore.dropGraph(graphUri, options);
  }

  listGraphs(options?: QueryOptions): Promise<string[]> {
    return this.innerStore.listGraphs(options);
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    refuseGraph(graphUri, 'deleteBySubjectPrefix');
    return this.innerStore.deleteBySubjectPrefix(graphUri, prefix, options);
  }

  async countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    if (graphUri !== undefined && isReadGraphPartitionWriteTarget(graphUri)) return 0;
    return this.innerStore.countQuads(graphUri, options);
  }

  close(): Promise<void> {
    return this.innerStore.close();
  }
}

/** Put the read-graph partition guard directly above an adapter. */
export function guardReadGraphPartition(store: TripleStore): TripleStore {
  return new ReadGraphPartitionStore(store);
}

/**
 * The store below the partition guard and the read-graph layer, for
 * storage-owned work on read-graph partitions only: the start-up rule, the
 * rollback drop, rebuilds and checks. A store without them is returned as it is.
 */
export function readGraphPartitionMaintenanceStore(store: TripleStore): TripleStore {
  const guard = findTripleStoreCapability(store,
    (candidate): candidate is ReadGraphPartitionStore => candidate instanceof ReadGraphPartitionStore);
  const belowGuard = guard?.innerStore ?? store;
  return readGraphLayerOf(belowGuard)?.innerStore ?? belowGuard;
}

const MAY_HOLD_PARTITIONS = new WeakSet<TripleStore>();

/** The innermost store of a decorator chain: the backend every decorator above shares. */
function backendOf(store: TripleStore): TripleStore {
  return findTripleStoreCapability(store, (candidate): candidate is TripleStore =>
    typeof candidate === 'object' && candidate !== null && !('innerStore' in candidate)) ?? store;
}

/**
 * Record, for this process, that a store may hold read-graph partitions. Its
 * unscoped queries leave hidden graphs out only then, so a store that cannot
 * hold any pays nothing. Whatever creates or finds read graphs records it.
 * The record belongs to the backend: through the read-graph layer's runtime,
 * every store object over the same backend sees it, whether it was recorded
 * through a store object or through the store below its layer (as start-up
 * does), and a store without the layer keeps it on its own adapter object.
 */
export function noteStoreMayHoldReadGraphPartitions(store: TripleStore): void {
  MAY_HOLD_PARTITIONS.add(backendOf(store));
  const runtime = readGraphRuntimeOf(store);
  if (runtime) runtime.mayHoldPartitions = true;
}

export function storeMayHoldReadGraphPartitions(store: TripleStore): boolean {
  return MAY_HOLD_PARTITIONS.has(backendOf(store)) || readGraphRuntimeOf(store)?.mayHoldPartitions === true;
}

/**
 * Drop every graph of every read-graph partition, with their state. The
 * partition is hidden from enumeration, so this reads the store's own list of
 * registered graphs once; a read graph emptied by DELETE, which Oxigraph keeps
 * registered, is dropped too. State graphs and other graphs that are not read
 * graphs go first, so a drop that stops part way never leaves a state row
 * without its data. Returns the number of graphs dropped.
 */
export async function dropReadGraphPartitions(store: TripleStore, options: QueryOptions = {}): Promise<number> {
  const target = readGraphPartitionMaintenanceStore(store);
  const result = await target.query(REGISTERED_NAMED_GRAPH_ENUMERATION_QUERY,
    { ...options, source: options.source ?? 'storage.readGraphPartitionDrop' });
  if (result.type !== 'bindings') throw new Error('Read-graph partition drop expected graph bindings');
  const graphs = [...new Set(result.bindings.map(row => row.g).filter((graph): graph is string =>
    typeof graph === 'string' && isReadGraphPartitionGraph(graph)))];
  const ordered = [...graphs.filter(graph => !parseReadGraphIri(graph)), ...graphs.filter(graph => parseReadGraphIri(graph))];
  for (const graph of ordered) await target.dropGraph(graph, options);
  return ordered.length;
}
