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
 * graphs the write touches, takes their locks, and has the adapter send the
 * read-graph operations in the same request as the change
 * (`./adapter-contract.ts`). A backend whose mirror holds no row gets exactly
 * the requests it gets without the layer.
 *
 * Its state (locks, state mirror, registry snapshots) lives in the backend's
 * {@link ReadGraphBackendRuntime}, which every store object over the same
 * backend shares. Storage-owned work on read graphs (the start-up rule,
 * rebuilds and checks) runs on the store below the layer, which
 * `readGraphPartitionMaintenanceStore` returns.
 */

import { readGraphCapabilitiesOf, type ReadGraphAdapterCapabilities } from './adapter-contract.js';
import type { WorkingMemoryIdentityRule } from './membership.js';
import { readGraphBackendIdentity, readGraphBackendRuntime, type ReadGraphBackendRuntime } from './runtime.js';
import {
  deleteByPatternWithoutCount,
  findTripleStoreCapability,
  type Quad,
  type QueryOptions,
  type QueryResult,
  type StorePressureSnapshot,
  type TripleStore,
  type TripleStoreDecorator,
} from '../triple-store.js';
import type { TripleStoreConfig } from '../triple-store-composition.js';

/** The read-graph part of a store configuration. */
export interface ReadGraphStoreConfig {
  /**
   * The node's working-memory identity rule, for every store object over the
   * same backend. The agent can also set it later on the runtime.
   */
  readonly workingMemoryIdentity?: WorkingMemoryIdentityRule;
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

  constructor(inner: TripleStore, runtime: ReadGraphBackendRuntime) {
    this.innerStore = inner;
    this.runtime = runtime;
    this.adapterCapabilities = readGraphCapabilitiesOf(inner);
    // The layer hides nothing itself; the adapter's own rule passes through.
    if (inner.graphEnumerationVisibility) this.graphEnumerationVisibility = inner.graphEnumerationVisibility.bind(inner);
    // Each optional capability exists exactly when the store below has it.
    if (inner.deleteByPatternWithoutCount) this.deleteByPatternWithoutCount = (pattern, options) => deleteByPatternWithoutCount(inner, pattern, options);
    if (inner.replaceGraph) this.replaceGraph = (graphUri, quads, options) => inner.replaceGraph!(graphUri, quads, options);
    if (inner.replaceAssetGroup) this.replaceAssetGroup = (assets, options) => inner.replaceAssetGroup!(assets, options);
    if (inner.replaceGraphAndSubject) this.replaceGraphAndSubject = (graphUri, graphQuads, metaGraphUri, subject, metadataQuads, options) =>
      inner.replaceGraphAndSubject!(graphUri, graphQuads, metaGraphUri, subject, metadataQuads, options);
    if (inner.replaceSubject) this.replaceSubject = (graphUri, subject, quads, options) => inner.replaceSubject!(graphUri, subject, quads, options);
    if (inner.replaceSubjectAndInsert) this.replaceSubjectAndInsert = (graphUri, subject, replacement, inserts, options) =>
      inner.replaceSubjectAndInsert!(graphUri, subject, replacement, inserts, options);
    if (inner.rfc64AuthorCommitCasV1) this.rfc64AuthorCommitCasV1 = (input, options) => inner.rfc64AuthorCommitCasV1!(input, options);
    if (inner.update) this.update = (sparql, options) => inner.update!(sparql, options);
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
    return this.innerStore.insert(quads, options);
  }

  delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    return this.innerStore.delete(quads, options);
  }

  deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    return this.innerStore.deleteByPattern(pattern, options);
  }

  query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    return this.innerStore.query(sparql, options);
  }

  hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    return this.innerStore.hasGraph(graphUri, options);
  }

  createGraph(graphUri: string): Promise<void> {
    return this.innerStore.createGraph(graphUri);
  }

  dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    return this.innerStore.dropGraph(graphUri, options);
  }

  listGraphs(options?: QueryOptions): Promise<string[]> {
    return this.innerStore.listGraphs(options);
  }

  deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    return this.innerStore.deleteBySubjectPrefix(graphUri, prefix, options);
  }

  countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    return this.innerStore.countQuads(graphUri, options);
  }

  close(): Promise<void> {
    return this.innerStore.close();
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
  return new ReadGraphStore(adapter, runtime);
}

/** The read-graph layer of a store's decorator chain, or `null` when it has none. */
export function readGraphLayerOf(store: unknown): ReadGraphStore | null {
  return findTripleStoreCapability(store, (candidate): candidate is ReadGraphStore => candidate instanceof ReadGraphStore);
}
