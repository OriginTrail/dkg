import { mergeQueryOptions, listGraphsByPrefix } from './read-store-query-utils.js';
import { performance } from 'node:perf_hooks';
import type { Quad, QueryOptions, TripleStore } from './triple-store.js';
import { asReadSnapshotCapability, type ReadSnapshotStore } from './read-snapshot-capability.js';
import { asGraphWriteRevisionSource } from './graph-write-gen.js';
import {
  loadSwmQuadsAcrossChunks,
  SHARED_MEMORY_GRAPHS_PER_QUERY,
  BUDGETED_SHARED_MEMORY_GRAPHS_PER_QUERY,
  type SwmReadPlan,
  type SharedMemoryResultBudget,
} from './swm-query-chunks.js';
export type { SharedMemoryResultBudget } from './swm-query-chunks.js';
export { SharedMemoryResultBudgetError } from './swm-query-chunks.js';
import {
  canonicalKnowledgeAssetGraphIdentitySuffix,
  knowledgeAssetAgentAddressesEqual,
  isSafeIri,
  assertSafeIri,
} from '@origintrail-official/dkg-core';

const SLOW_SWM_READ_STAGE_MS = 5_000;
let lastSwmGraphLimitWarningAt = 0;

/** Identify the slow backend stage while it still occupies a store slot. */
async function traceSlowSwmReadStage<T>(
  stage: string,
  options: QueryOptions | undefined,
  read: () => Promise<T>,
): Promise<T> {
  const source = (options?.source ?? 'unknown').replace(/[^\w:./-]/g, '_').slice(0, 80);
  const startedAt = performance.now();
  let warned = false;
  const timer = setTimeout(() => {
    warned = true;
    console.warn(`[swm-read] slow stage=${stage} source=${source} elapsedMs=${Math.round(performance.now() - startedAt)} state=active`);
  }, SLOW_SWM_READ_STAGE_MS);
  timer.unref();
  try {
    return await read();
  } finally {
    clearTimeout(timer);
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (warned || elapsedMs >= SLOW_SWM_READ_STAGE_MS) {
      console.warn(`[swm-read] slow stage=${stage} source=${source} elapsedMs=${elapsedMs} state=settled`);
    }
  }
}

export type NonEmptyGraphList = [string, ...string[]];
export type SharedMemoryReadSelection = 'all' | { rootEntities: readonly string[] };

/**
 * Per-KA identity window used to PRUNE the SWM under-graph read set to the
 * single author + kaNumber range a call site already knows it wants. The
 * `agentAddress`/`kaNumber` pair is the identifying half of a KA's UAL, so a
 * bound admits exactly the per-KA under-graphs
 * `…/_shared_memory/{addr}/{n}` (and the 5-segment sub-graph shape
 * `…/{sub}/_shared_memory/{addr}/{n}`) with `addr ≡ᵢ agentAddress` and
 * `startNumber ≤ n ≤ endNumber`.
 *
 * Both numbers are the LOW-96 per-author KA number, NOT a packed `kaId`
 * (`packKnowledgeAssetIdFromIdentity` shifts the address into the high bits) —
 * callers must unpack before deriving a bound, or every real graph is excluded.
 *
 * This is a PURE ACCELERATOR: it narrows a graph SET, never the CONSTRUCT body,
 * and non-parsing / bucket graphs are always kept (fail-open). Correctness of a
 * bounded read therefore reduces to "same graph set ⇒ same quads", and any call
 * site that narrows a merkle-gated read MUST either widen to the unbounded
 * read or defer without promoting the candidate on an empty-or-mismatch result.
 */
export interface SwmKaGraphBound {
  agentAddress: string;
  startNumber: bigint;
  endNumber: bigint;
}

/** Exact identity of one named KA lifecycle's shared-memory graph. */
export interface NamedKnowledgeAssetGraphIdentity {
  agentAddress: string;
  kaNumber: bigint;
}

/** Semantic SWM read boundary: either the complete family or one named lifecycle. */
export type SharedMemoryGraphScope =
  | { kind: 'complete-family' }
  | { kind: 'named-lifecycle'; identity: NamedKnowledgeAssetGraphIdentity };

const SWM_CHILD_AGENT_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SWM_CHILD_KA_NUMBER = /^\d+$/;

/**
 * Identify `graph` as a per-KA child of THIS shared-memory `bucketGraph`, or
 * return undefined so the caller keeps it (fail-open).
 *
 * Deliberately bucket-RELATIVE. The only shape a bound is allowed to prune is
 * exactly `${bucketGraph}/{0x…40hex}/{decimal}`, so we strip the bucket prefix and
 * require precisely those two segments. Every other suffix — `_meta`, blob and
 * snapshot graphs, and deeper descendants such as
 * `${bucketGraph}/_verifiable_memory/{addr}/{n}` — simply fails to match and stays
 * in the read set. Using the general `parseContextGraphLayerUri` here instead would
 * accept unrelated layer shapes and force reconstruction checks to rule them back
 * out; the relative parser makes the contract the code's shape rather than a
 * comment's claim. Works unchanged for a sub-graph bucket, since the prefix we
 * strip is whatever bucket the caller is reading.
 */
function parseBoundableSwmChildGraph(
  bucketGraph: string,
  graph: string,
): { agentAddress: string; kaNumber: bigint } | undefined {
  const prefix = `${bucketGraph}/`;
  if (!graph.startsWith(prefix)) return undefined;
  const segments = graph.slice(prefix.length).split('/');
  if (segments.length !== 2) return undefined;
  const [agentAddress, kaNumberRaw] = segments;
  if (!SWM_CHILD_AGENT_ADDRESS.test(agentAddress) || !SWM_CHILD_KA_NUMBER.test(kaNumberRaw)) {
    return undefined;
  }
  return { agentAddress, kaNumber: BigInt(kaNumberRaw) };
}

export interface LoadSelectedSharedMemoryQuadsOptions {
  querySource?: QueryOptions['source'];
  queryOptions?: QueryOptions;
  quadFilter?: (quad: Quad) => boolean;
  /**
   * Optional hard materialization budget for expensive SWM slices. When set,
   * the store is read in bounded SELECT pages and the loader rejects before
   * retaining more than `maxRows` or `maxBytesEstimate`. This is an explicit
   * backpressure boundary: callers must retry/defer, never treat the error as an
   * empty or complete snapshot.
   */
  resultBudget?: SharedMemoryResultBudget;
  rootEntitiesErrorMessage?: (input: {
    inputCount: number;
    hadInput: boolean;
  }) => string;
}

export class SharedMemoryReadConsistencyError extends Error {
  readonly code = 'SWM_READ_CONSISTENCY' as const;
  readonly retryable = true as const;

  constructor() {
    super('Shared-memory graph family changed during materialization; retry later');
    this.name = 'SharedMemoryReadConsistencyError';
  }
}

export type SharedMemoryGraphAdmission =
  | { status: 'admitted' }
  | { status: 'deferred'; graphCount: number; limit: number };

/** A scan policy decision, independent of graph materialization. */
export function admitSharedMemoryGraphCount(
  graphCount: number,
  limit: number | undefined,
): SharedMemoryGraphAdmission {
  return limit !== undefined && graphCount > limit
    ? { status: 'deferred', graphCount, limit }
    : { status: 'admitted' };
}

type SharedMemoryGraphReadResult =
  | { status: 'admitted'; quads: Quad[] }
  | Extract<SharedMemoryGraphAdmission, { status: 'deferred' }>;

function unrestrictedQuads(result: SharedMemoryGraphReadResult): Quad[] {
  if (result.status === 'admitted') return result.quads;
  throw new Error('Unexpected graph admission deferral in an unrestricted shared-memory read');
}

/**
 * Resolve the concrete set of shared-memory graphs to READ under `bucketGraph`,
 * enumerated via the fast named-graph index (`listGraphsByPrefix`) instead of an
 * unbounded `GRAPH ?g` scan. This is the BOUND equivalent of
 * `sharedMemoryReadBothFilter` (core `constants.ts`): the bucket graph itself
 * PLUS every graph under `${bucketGraph}/` EXCEPT the `${bucketGraph}/staging/`
 * subtree — the exact same graph set that filter selects.
 *
 * Callers emit a `VALUES ?g { … }` clause from the result so the query engine
 * reads only these graphs, turning an O(store) whole-database scan (the
 * `GRAPH ?g { … } FILTER(STRSTARTS(?g,…))` idiom) into an O(matched-graphs)
 * read. This is the hot-path relief for storage-ACK / finalization SWM reads.
 *
 * Non-indexed stores fall back to a `listGraphs()` prefix scan (still correct,
 * just not index-accelerated). `assertSafeIri(bucketGraph)` throws on an unsafe
 * bucket to preserve the old `sharedMemoryReadBothFilter` fail-closed behavior
 * (the replaced filter asserted the same); per-KA under-graphs are dropped if
 * unsafe (never produced by the DKG write path). The returned list is always
 * non-empty for a safe bucket because the bucket graph itself is part of the
 * read contract, even when the named-graph index currently has no child graphs.
 *
 * Freshness contract: the index must be at least as fresh as the SPARQL scan it
 * replaces. Same-process writes satisfy this (GraphSetIndexStore is
 * write-through; the sparql-http adapter invalidates its listGraphs cache on
 * every local insert/delete/update/drop). The only staleness window is a graph
 * written by a DIFFERENT process to a SHARED oxigraph-server within the
 * revalidate interval; there an under-read is still FAIL-SAFE on merkle-gated
 * paths (recompute mismatch → reject/retry, never accept-with-wrong-data).
 *
 * This resolver is COMPLETE and therefore safe everywhere, including the
 * merkle-defining publish reads and the StorageACK decline lanes. Generic pruning
 * lives in `resolveKaBoundedSharedMemoryReadGraphs`, which is not part of the
 * package's public surface. The public exact-named-lifecycle API below is a
 * separate semantic boundary, not a range-pruning escape hatch.
 */
export async function resolveSharedMemoryReadGraphs(
  store: ReadSnapshotStore,
  bucketGraph: string,
  options?: QueryOptions,
): Promise<NonEmptyGraphList> {
  return resolveSwmReadGraphs(store, bucketGraph, options, undefined);
}

/**
 * Resolve the SWM read set pruned to one author's per-KA under-graphs.
 *
 * UNSAFE ON ITS OWN, and deliberately NOT re-exported from `src/index.ts`: the
 * result is a STRICT SUBSET of the complete read set, and INV-1 is refuted under
 * root recurrence, so a bounded resolution can omit graphs the on-chain merkle root
 * commits to. Only `loadKaBoundedSharedMemoryQuads` may call this, and only because
 * its own caller owns the widen-or-defer protocol.
 * Never build a `VALUES ?g` from this and hash or decline on the result.
 *
 * Pruning is FAIL-OPEN: an under-graph is dropped ONLY when it is positively a
 * per-KA child of THIS bucket (`parseBoundableSwmChildGraph`) AND its author or
 * kaNumber falls outside the bound. Any other shape — `_meta`, blob, snapshot,
 * deeper descendants, anything future — is KEPT, so a bound can never silently
 * under-read a graph it does not understand. The bucket is always in the set.
 */
export async function resolveKaBoundedSharedMemoryReadGraphs(
  store: ReadSnapshotStore,
  bucketGraph: string,
  bound: SwmKaGraphBound,
  options?: QueryOptions,
): Promise<NonEmptyGraphList> {
  return resolveSwmReadGraphs(store, bucketGraph, options, bound);
}

async function resolveSwmReadGraphs(
  store: ReadSnapshotStore,
  bucketGraph: string,
  options: QueryOptions | undefined,
  bound: SwmKaGraphBound | undefined,
): Promise<NonEmptyGraphList> {
  assertSafeIri(bucketGraph);
  const stagingPrefix = `${bucketGraph}/staging/`;
  const under = await listGraphsByPrefix(store, `${bucketGraph}/`, options);
  const out = new Set<string>([bucketGraph]);
  for (const graph of under) {
    if (graph.startsWith(stagingPrefix)) continue;
    if (!isSafeIri(graph)) continue;
    if (bound) {
      const child = parseBoundableSwmChildGraph(bucketGraph, graph);
      if (
        child &&
        (!knowledgeAssetAgentAddressesEqual(child.agentAddress, bound.agentAddress) ||
          child.kaNumber < bound.startNumber ||
          child.kaNumber > bound.endNumber)
      ) {
        continue;
      }
    }
    out.add(graph);
  }
  // Deterministic chunk boundaries matter for recurring roots: backend graph
  // enumeration order is unspecified, and tests must exercise distinct chunks.
  return [...out].sort() as NonEmptyGraphList;
}

/**
 * Load the selected SWM quad slice from the exact graph set resolved by
 * `resolveSharedMemoryReadGraphs`. This keeps merkle-sensitive SWM selection
 * policy in one place while allowing call sites to inject their small
 * differences, such as query source tags or post-query bookkeeping filters.
 *
 * This function reads the COMPLETE SWM graph set and is safe to use anywhere,
 * including the merkle-DEFINING publish reads and the StorageACK decline lanes.
 * There is deliberately no way to prune the graph set from here — see
 * `loadKaBoundedSharedMemoryQuads` for that, and read its contract first.
 */
export async function loadSelectedSharedMemoryQuads(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  options: LoadSelectedSharedMemoryQuadsOptions = {},
): Promise<Quad[]> {
  return loadSharedMemoryQuadsForScope(
    store,
    bucketGraph,
    selection,
    { kind: 'complete-family' },
    options,
  );
}

/**
 * Load the SWM quad slice pruned to ONE author's per-KA under-graphs (#1549).
 *
 * UNSAFE as a generic merkle accelerator. It is module-exported for direct
 * tests and internal imports, but is not re-exported from the package entrypoint.
 * Exact lifecycle callers use the scoped public loader below. Generic merkle
 * callers must use the widening wrapper below. The
 * pruned graph set is a strict subset of the set `loadSelectedSharedMemoryQuads`
 * reads, and INV-1 — "a root's quads live only under its own KA number" — is
 * REFUTED under root recurrence, so this read can legitimately miss quads the
 * on-chain merkle root commits to. Safe callers use one of the fallback-owning
 * slice operations below; this is a
 * module-internal primitive it builds on, kept exported only so the graph-set
 * behaviour can be unit-tested directly.
 */
export async function loadKaBoundedSharedMemoryQuads(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  kaGraphBound: SwmKaGraphBound,
  options: LoadSelectedSharedMemoryQuadsOptions = {},
): Promise<Quad[]> {
  return unrestrictedQuads(await loadSharedMemoryQuadsInternal(store, bucketGraph, selection, options, {
    kind: 'bounded',
    bound: kaGraphBound,
  }));
}

/**
 * Load shared memory through one explicit semantic scope.
 *
 * Higher layers do not translate scope into concrete graph policy: complete
 * family and exact named-lifecycle dispatch both stay owned by storage.
 */
export async function loadSharedMemoryQuadsForScope(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  scope: SharedMemoryGraphScope,
  options: LoadSelectedSharedMemoryQuadsOptions = {},
): Promise<Quad[]> {
  return unrestrictedQuads(await loadSharedMemoryQuadsInternal(
    store, bucketGraph, selection, options, scope,
  ));
}

interface NamedLifecycleGraphResolution {
  canonicalGraph: string;
  legacyCompatibleReadGraphs: string[];
}

/**
 * Legacy read compatibility only: find every historical checksum-casing alias
 * for the same logical lifecycle. This scan must never influence where new
 * data is written.
 */
async function resolveNamedLifecycleReadPolicy(
  store: ReadSnapshotStore,
  bucketGraph: string,
  identity: NamedKnowledgeAssetGraphIdentity,
  options?: QueryOptions,
): Promise<NamedLifecycleGraphResolution> {
  const canonicalGraph = canonicalSharedMemoryScopeWriteGraph(bucketGraph, {
    kind: 'named-lifecycle',
    identity,
  });
  const legacyCompatibleReadGraphs = (await listGraphsByPrefix(store, `${bucketGraph}/`, options))
    .filter((graph) => {
      const child = parseBoundableSwmChildGraph(bucketGraph, graph);
      return child !== undefined
        && knowledgeAssetAgentAddressesEqual(child.agentAddress, identity.agentAddress)
        && child.kaNumber === identity.kaNumber;
    });
  return { canonicalGraph, legacyCompatibleReadGraphs };
}

/** Resolve the concrete graph set for an explicit semantic SWM scope. */
export async function resolveSharedMemoryScopeGraphs(
  store: ReadSnapshotStore,
  bucketGraph: string,
  scope: SharedMemoryGraphScope,
  options?: QueryOptions,
): Promise<NonEmptyGraphList> {
  if (scope.kind === 'complete-family') {
    return resolveSharedMemoryReadGraphs(store, bucketGraph, options);
  }
  const { canonicalGraph, legacyCompatibleReadGraphs } = await resolveNamedLifecycleReadPolicy(
    store,
    bucketGraph,
    scope.identity,
    options,
  );
  // Read every historical checksum-casing alias for compatibility. An absent
  // lifecycle still resolves to the canonical candidate so callers receive a
  // safe empty result without widening to the bucket or sibling lifecycles.
  return legacyCompatibleReadGraphs.length > 0
    ? legacyCompatibleReadGraphs as NonEmptyGraphList
    : [canonicalGraph];
}

/** Resolve the single canonical graph to WRITE for a semantic scope. */
export function canonicalSharedMemoryScopeWriteGraph(
  bucketGraph: string,
  scope: SharedMemoryGraphScope,
): string {
  assertSafeIri(bucketGraph);
  if (scope.kind === 'complete-family') return bucketGraph;
  const { agentAddress, kaNumber } = scope.identity;
  if (!SWM_CHILD_AGENT_ADDRESS.test(agentAddress) || kaNumber < 0n) {
    throw new Error('Named KA graph identity must contain a 20-byte EVM address and non-negative KA number');
  }
  const graph = `${bucketGraph}/${canonicalKnowledgeAssetGraphIdentitySuffix(agentAddress, kaNumber)}`;
  assertSafeIri(graph);
  return graph;
}

/**
 * @deprecated New canonical-only writers should use the synchronous
 * `canonicalSharedMemoryScopeWriteGraph` after explicitly converging aliases.
 * This compatibility resolver deliberately retains its original store-aware
 * behavior: prefer the canonical graph when it exists, otherwise keep writing
 * to the stable existing alias chosen by the old API.
 */
export async function resolveSharedMemoryScopeWriteGraph(
  store: TripleStore,
  bucketGraph: string,
  scope: SharedMemoryGraphScope,
  options?: QueryOptions,
): Promise<string> {
  if (scope.kind === 'complete-family') {
    return canonicalSharedMemoryScopeWriteGraph(bucketGraph, scope);
  }
  const { canonicalGraph, legacyCompatibleReadGraphs } = await resolveNamedLifecycleReadPolicy(
    store,
    bucketGraph,
    scope.identity,
    options,
  );
  return legacyCompatibleReadGraphs.find((graph) => graph === canonicalGraph)
    ?? legacyCompatibleReadGraphs.slice().sort()[0]
    ?? canonicalGraph;
}

/** Query-source tags for the three read lanes a bounded slice can take. */
export interface SwmSliceSourceTags {
  /** the initial narrowed read, when a bound is supplied */
  bounded: QueryOptions['source'];
  /** an unbounded re-read after an empty or mismatched bounded read */
  widened: QueryOptions['source'];
  /** the initial read when no bound is supplied */
  unbounded: QueryOptions['source'];
  /** indexed root-graph discovery and its candidate read */
  rootIndexed?: QueryOptions['source'];
  /** warmed graph catalog read, admitted only after merkle verification */
  cachedGraphSet?: QueryOptions['source'];
}

export interface LoadSharedMemorySliceWithKaBoundFallbackOptions {
  sources: SwmSliceSourceTags;
  createAccept: () => Promise<(quads: Quad[]) => Quad[] | null>;
  queryOptions?: Omit<QueryOptions, 'source'>;
  resultBudget?: SharedMemoryResultBudget;
}

/** Root-index and cached-catalog candidates require an expected on-chain merkle root. */
export interface LoadMerkleVerifiedSharedMemorySliceOptions {
  sources: SwmSliceSourceTags & Required<Pick<SwmSliceSourceTags, 'rootIndexed' | 'cachedGraphSet'>>;
  expectedMerkleRoot: Uint8Array;
  createMerkleAccept: (expectedMerkleRoot: Uint8Array) => Promise<(quads: Quad[]) => Quad[] | null>;
  queryOptions?: Omit<QueryOptions, 'source'>;
  resultBudget?: SharedMemoryResultBudget;
  /** Gossip finalization may defer a huge unmatched family to payload sync. */
  maxCompleteFamilyGraphs?: number;
}

export type MerkleVerifiedSharedMemorySliceResult =
  | { status: 'verified'; quads: Quad[]; accepted: Quad[] }
  | { status: 'complete-unmatched'; quads: Quad[] }
  /** Incomplete candidate quads are diagnostic only and cannot be consumed. */
  | { status: 'deferred'; candidateQuads: Quad[] };

const MAX_ROOT_INDEXED_DISCOVERY_ROOTS = 128;
const MAX_ROOT_INDEXED_DISCOVERY_GRAPHS = 4_096;
const MAX_CACHED_GRAPH_CANDIDATE_GRAPHS = 512;

/**
 * Find graphs containing an exact root through Blazegraph's subject index.
 * A root's skolem descendants can live in other graphs, so this is only a
 * candidate read: the caller MUST check the expected merkle root and widen on
 * mismatch. Discovery and materialization share one pinned snapshot.
 */
async function loadRootIndexedSharedMemoryCandidate(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  options: LoadSelectedSharedMemoryQuadsOptions,
): Promise<Quad[] | null> {
  if (selection === 'all') return null;
  const snapshot = asReadSnapshotCapability(store);
  if (!snapshot) return null;
  const roots = [...new Set(selection.rootEntities.map((root) => String(root).trim()).filter(isSafeIri))];
  if (roots.length === 0 || roots.length > MAX_ROOT_INDEXED_DISCOVERY_ROOTS) return null;
  const queryOptions = mergeQueryOptions(options.queryOptions, options.querySource);
  const innerGraphPattern = sharedMemorySelectionGraphPattern(selection, options);
  const branches = roots.map((root) => `{ GRAPH ?g { <${root}> ?p ?o } }`).join(' UNION ');
  return snapshot.withReadSnapshot(async (readStore) => {
    const result = await traceSlowSwmReadStage('root-index.discover', queryOptions, () =>
      readStore.query(`SELECT DISTINCT ?g WHERE {
      ${branches}
    } LIMIT ${MAX_ROOT_INDEXED_DISCOVERY_GRAPHS + 1}`, queryOptions));
    if (result.type !== 'bindings' || result.bindings.length > MAX_ROOT_INDEXED_DISCOVERY_GRAPHS) {
      return null;
    }
    const graphs = new Set<string>([bucketGraph]);
    for (const row of result.bindings) {
      const graph = row['g'];
      if (graph && isSafeIri(graph)
        && graph.startsWith(`${bucketGraph}/`)
        && !graph.startsWith(`${bucketGraph}/staging/`)) {
        graphs.add(graph);
      }
    }
    return traceSlowSwmReadStage('root-index.materialize', queryOptions, () => loadSwmQuadsAcrossChunks(
      readStore,
      [...graphs].sort(),
      innerGraphPattern,
      queryOptions,
      options,
    ));
  }, queryOptions?.signal);
}

/**
 * Use the outer store's fast graph catalog as a bounded candidate when exact
 * root discovery misses skolem-only graphs. The catalog is sampled before the
 * backend snapshot, so it can omit a concurrent or out-of-process write. Only
 * a caller checking the expected on-chain merkle root may accept these quads;
 * otherwise the complete snapshot read remains the correctness backstop.
 */
async function loadCachedGraphSetSharedMemoryCandidate(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  options: LoadSelectedSharedMemoryQuadsOptions,
): Promise<Quad[] | null> {
  const snapshot = asReadSnapshotCapability(store);
  if (!snapshot) return null;
  const queryOptions = mergeQueryOptions(options.queryOptions, options.querySource);
  const graphs = await traceSlowSwmReadStage('cached-candidate.catalog', queryOptions, () =>
    resolveSharedMemoryReadGraphs(store, bucketGraph, queryOptions));
  if (graphs.length > MAX_CACHED_GRAPH_CANDIDATE_GRAPHS) return null;
  const innerGraphPattern = sharedMemorySelectionGraphPattern(selection, options);
  return snapshot.withReadSnapshot((readStore) => traceSlowSwmReadStage('cached-candidate.materialize', queryOptions, () => loadSwmQuadsAcrossChunks(
    readStore, graphs, innerGraphPattern, queryOptions, options,
  )), queryOptions?.signal);
}

/**
 * Read a KA-bounded SWM slice, then WIDEN to the complete read on mismatch.
 * This owns the fallback protocol that `loadKaBoundedSharedMemoryQuads` requires,
 * so callers cannot hold a pruned `Quad[]` without the widen.
 *
 * `accept` is the caller's completeness predicate — e.g. a merkle recompute — that
 * returns the accepted quads or `null` on mismatch. It decides both when a bounded
 * read is "good enough" and what the caller ultimately consumes; storage stays
 * agnostic to merkle. It is built lazily via `createAccept` and invoked
 * only when there are quads, so a genuine no-data read triggers no extra
 * caller-side work. The complete-family widen fires at most once.
 *
 * A candidate is only accepted through the caller's completeness predicate.
 * Merkle-verified root discovery has a separate entry point below.
 * `queryOptions` is applied to graph discovery and every bounded or widened read.
 */
export function loadSharedMemorySliceWithKaBoundFallback(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  kaGraphBound: SwmKaGraphBound | undefined,
  options: LoadSharedMemorySliceWithKaBoundFallbackOptions,
): Promise<{ quads: Quad[]; accepted: Quad[] | null }>;
/** @deprecated Use the named options object. Retained for package compatibility. */
export function loadSharedMemorySliceWithKaBoundFallback(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  kaGraphBound: SwmKaGraphBound | undefined,
  sources: SwmSliceSourceTags,
  createAccept: () => Promise<(quads: Quad[]) => Quad[] | null>,
  loadOptions?: Pick<LoadSelectedSharedMemoryQuadsOptions, 'queryOptions' | 'resultBudget'>,
): Promise<{ quads: Quad[]; accepted: Quad[] | null }>;
export async function loadSharedMemorySliceWithKaBoundFallback(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  kaGraphBound: SwmKaGraphBound | undefined,
  optionsOrSources: LoadSharedMemorySliceWithKaBoundFallbackOptions | SwmSliceSourceTags,
  legacyCreateAccept?: () => Promise<(quads: Quad[]) => Quad[] | null>,
  legacyLoadOptions: Pick<LoadSelectedSharedMemoryQuadsOptions, 'queryOptions' | 'resultBudget'> = {},
): Promise<{ quads: Quad[]; accepted: Quad[] | null }> {
  const options = normalizeLoadSharedMemorySliceOptions(
    optionsOrSources,
    legacyCreateAccept,
    legacyLoadOptions,
  );
  const { sources, createAccept, queryOptions = {}, resultBudget } = options;
  const loadOptions = { queryOptions, resultBudget };
  const candidates: SwmSliceCandidate[] = kaGraphBound ? [{
    stage: 'bounded.total',
    read: () => loadKaBoundedSharedMemoryQuads(store, bucketGraph, selection, kaGraphBound, {
      ...loadOptions, querySource: sources.bounded,
    }),
  }] : [];
  const result = await runSharedMemorySliceCandidates(
    store, bucketGraph, selection, candidates,
    kaGraphBound ? sources.widened : sources.unbounded,
    createAccept, loadOptions,
  );
  switch (result.status) {
    case 'verified': return { quads: result.quads, accepted: result.accepted };
    case 'complete-unmatched': return { quads: result.quads, accepted: null };
    case 'deferred': throw new Error('Unbounded shared-memory fallback unexpectedly deferred');
  }
}

/**
 * Try bounded, exact-root and warm-catalog candidates in that order, accepting
 * one only when the caller verifies it against the expected on-chain merkle
 * root. A failed candidate widens to the complete snapshot read unless an
 * explicit graph limit defers it to payload sync without promotion.
 */
export function loadMerkleVerifiedSharedMemorySlice(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  kaGraphBound: SwmKaGraphBound | undefined,
  options: LoadMerkleVerifiedSharedMemorySliceOptions,
): Promise<MerkleVerifiedSharedMemorySliceResult> {
  // Candidate discovery constructs SPARQL before the complete-family loader's
  // graph resolver can validate this bucket. Reject unsafe input up front.
  assertSafeIri(bucketGraph);
  if (options.expectedMerkleRoot.length !== 32) {
    throw new TypeError('Expected a 32-byte on-chain merkle root');
  }
  const { sources, queryOptions = {}, resultBudget } = options;
  const loadOptions = { queryOptions, resultBudget };
  const candidates: SwmSliceCandidate[] = [];
  if (kaGraphBound) candidates.push({
    stage: 'bounded.total',
    read: () => loadKaBoundedSharedMemoryQuads(store, bucketGraph, selection, kaGraphBound, {
      ...loadOptions, querySource: sources.bounded,
    }),
  });
  candidates.push({
    stage: 'root-index.total',
    read: () => loadRootIndexedSharedMemoryCandidate(store, bucketGraph, selection, {
      ...loadOptions, querySource: sources.rootIndexed,
    }),
  }, {
    stage: 'cached-candidate.total',
    read: () => loadCachedGraphSetSharedMemoryCandidate(store, bucketGraph, selection, {
      ...loadOptions, querySource: sources.cachedGraphSet,
    }),
  });
  return runSharedMemorySliceCandidates(
    store, bucketGraph, selection, candidates,
    kaGraphBound ? sources.widened : sources.unbounded,
    () => options.createMerkleAccept(options.expectedMerkleRoot), loadOptions,
    options.maxCompleteFamilyGraphs,
  );
}

interface SwmSliceCandidate {
  stage: string;
  read: () => Promise<Quad[] | null>;
}

async function runSharedMemorySliceCandidates(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  candidates: readonly SwmSliceCandidate[],
  completeSource: QueryOptions['source'],
  createAccept: () => Promise<(quads: Quad[]) => Quad[] | null>,
  loadOptions: Pick<LoadSelectedSharedMemoryQuadsOptions, 'queryOptions' | 'resultBudget'>,
  maxCompleteFamilyGraphs?: number,
): Promise<MerkleVerifiedSharedMemorySliceResult> {
  const queryOptions = loadOptions.queryOptions;
  let lastCandidate: Quad[] = [];
  let accept: ((quads: Quad[]) => Quad[] | null) | undefined;
  const testCandidate = async (candidate: Quad[]): Promise<Quad[] | null> => {
    if (candidate.length === 0) return null;
    accept ??= await traceSlowSwmReadStage('candidate.prepare-verifier', queryOptions, createAccept);
    return traceSlowSwmReadStage('candidate.verify', queryOptions, async () => accept!(candidate));
  };

  for (const candidate of candidates) {
    const result = await traceSlowSwmReadStage(candidate.stage, queryOptions, candidate.read);
    if (result?.length) lastCandidate = result;
    if (result) {
      const accepted = await testCandidate(result);
      if (accepted) return { status: 'verified', quads: result, accepted };
    }
  }
  const complete = await traceSlowSwmReadStage('complete.total', queryOptions, () =>
    loadSharedMemoryQuadsInternal(
      store, bucketGraph, selection,
      { ...loadOptions, querySource: completeSource },
      { kind: 'complete-family' },
      maxCompleteFamilyGraphs,
    ));
  if (complete.status === 'deferred') {
    // An unverified candidate is never promoted. The finalization caller can
    // request the complete payload from peers; bounded legacy recovery may
    // also retry locally when the family is small enough.
    const now = Date.now();
    if (now - lastSwmGraphLimitWarningAt >= 60_000) {
      lastSwmGraphLimitWarningAt = now;
      console.warn(`[swm-read] deferring complete family with ${complete.graphCount} graphs (limit=${complete.limit}) without promoting an unverified candidate`);
    }
    return { status: 'deferred', candidateQuads: lastCandidate };
  }
  const quads = complete.quads;
  if (quads.length === 0) return { status: 'complete-unmatched', quads };
  accept ??= await traceSlowSwmReadStage('complete.prepare-verifier', queryOptions, createAccept);
  const accepted = await traceSlowSwmReadStage('complete.verify', queryOptions, async () => accept!(quads));
  return accepted
    ? { status: 'verified', quads, accepted }
    : { status: 'complete-unmatched', quads };
}

function normalizeLoadSharedMemorySliceOptions(
  optionsOrSources: LoadSharedMemorySliceWithKaBoundFallbackOptions | SwmSliceSourceTags,
  legacyCreateAccept: (() => Promise<(quads: Quad[]) => Quad[] | null>) | undefined,
  legacyLoadOptions: Pick<LoadSelectedSharedMemoryQuadsOptions, 'queryOptions' | 'resultBudget'>,
): LoadSharedMemorySliceWithKaBoundFallbackOptions {
  if ('sources' in optionsOrSources) return optionsOrSources;
  if (!legacyCreateAccept) {
    throw new TypeError('loadSharedMemorySliceWithKaBoundFallback requires createAccept');
  }
  return {
    sources: optionsOrSources,
    createAccept: legacyCreateAccept,
    ...legacyLoadOptions,
  };
}

function sharedMemorySelectionGraphPattern(
  selection: SharedMemoryReadSelection,
  options: LoadSelectedSharedMemoryQuadsOptions,
): string {
  if (selection === 'all') {
    return '?s ?p ?o';
  }
  const roots = [...new Set(
    selection.rootEntities
      .map((r) => String(r).trim())
      .filter((r) => isSafeIri(r)),
  )];
  if (roots.length === 0) {
    const hadInput = selection.rootEntities.length > 0;
    const message = options.rootEntitiesErrorMessage?.({
      inputCount: selection.rootEntities.length,
      hadInput,
    }) ?? (
      hadInput
        ? `No valid rootEntities provided (all ${selection.rootEntities.length} entries failed IRI validation)`
        : 'No rootEntities provided'
    );
    throw new Error(message);
  }
  const values = roots.map((r) => `<${r}>`).join(' ');
  return `VALUES ?root { ${values} }
          ?s ?p ?o .
          FILTER(
            ?s = ?root
            || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/"))
          )`;
}

async function loadSharedMemoryQuadsInternal(
  store: TripleStore,
  bucketGraph: string,
  selection: SharedMemoryReadSelection,
  options: LoadSelectedSharedMemoryQuadsOptions,
  graphScope:
    | { kind: 'bounded'; bound: SwmKaGraphBound }
    | SharedMemoryGraphScope,
  maxGraphsToRead?: number,
): Promise<SharedMemoryGraphReadResult> {
  const innerGraphPattern = sharedMemorySelectionGraphPattern(selection, options);
  const queryOptions = mergeQueryOptions(options.queryOptions, options.querySource);
  const resolveGraphs = (readStore: ReadSnapshotStore, readOptions: QueryOptions | undefined) =>
    graphScope?.kind === 'bounded'
      ? resolveKaBoundedSharedMemoryReadGraphs(readStore, bucketGraph, graphScope.bound, readOptions)
      : resolveSharedMemoryScopeGraphs(readStore, bucketGraph, graphScope, readOptions);
  const read = async (
    readStore: ReadSnapshotStore,
    graphs: NonEmptyGraphList,
    readOptions: QueryOptions | undefined,
    plan?: SwmReadPlan,
  ): Promise<SharedMemoryGraphReadResult> => {
    const admission = admitSharedMemoryGraphCount(graphs.length, maxGraphsToRead);
    if (admission.status === 'deferred') return admission;
    const quads = await loadSwmQuadsAcrossChunks(
      readStore, graphs, innerGraphPattern, readOptions, options, plan,
    );
    return { status: 'admitted', quads };
  };

  const snapshot = asReadSnapshotCapability(store);
  let initialGraphs: NonEmptyGraphList | undefined;
  if (!(graphScope.kind === 'complete-family' && snapshot && maxGraphsToRead === undefined)) {
    // An unrestricted complete-family read discovers its authoritative graph
    // set only inside the snapshot. Limited reads can reject a known oversized
    // family before opening a snapshot or issuing any materialization query.
    initialGraphs = await traceSlowSwmReadStage('selected.resolve-initial', queryOptions, () =>
      resolveGraphs(store, queryOptions));
    const preflight = admitSharedMemoryGraphCount(initialGraphs.length, maxGraphsToRead);
    if (preflight.status === 'deferred') return preflight;
  }
  const graphsPerQuery = options.resultBudget
    ? BUDGETED_SHARED_MEMORY_GRAPHS_PER_QUERY : SHARED_MEMORY_GRAPHS_PER_QUERY;
  if (initialGraphs && graphScope.kind !== 'complete-family' && initialGraphs.length <= graphsPerQuery) {
    return traceSlowSwmReadStage('selected.materialize', queryOptions, () =>
      read(store, initialGraphs, queryOptions));
  }
  if (snapshot) {
    // A complete-family outer catalog can be stale even when it fits in one
    // query. Resolve the authoritative graph set in the same snapshot used for
    // materialization; scoped multi-query reads also use one snapshot.
    return snapshot.withReadSnapshot(async (snapshotStore) => {
      const graphs = await traceSlowSwmReadStage('selected.resolve-snapshot', queryOptions, () =>
        resolveGraphs(snapshotStore, queryOptions));
      return traceSlowSwmReadStage('selected.materialize-snapshot', queryOptions, () =>
        read(snapshotStore, graphs, queryOptions));
    }, queryOptions?.signal);
  }
  if (!initialGraphs) throw new Error('Missing graph inventory for non-snapshot shared-memory read');
  if (initialGraphs.length <= graphsPerQuery) {
    return traceSlowSwmReadStage('selected.materialize', queryOptions, () =>
      read(store, initialGraphs, queryOptions));
  }
  const revision = asGraphWriteRevisionSource(store);
  if (revision?.writeRevisionCoverage !== 'all-writers') {
    // One backend query has its own snapshot on SPARQL stores. Backends with
    // neither a pinned transaction nor an all-writer fence keep the legacy
    // single-query path instead of returning a mixed multi-query view.
    return traceSlowSwmReadStage('selected.materialize-single', queryOptions, () =>
      read(store, initialGraphs, queryOptions, { kind: 'single-query' }));
  }
  let unstableChecks = 0;
  for (let attempt = 0; attempt < 3;) {
    queryOptions?.signal?.throwIfAborted();
    const before = revision.getWriteRevision(bucketGraph);
    if (!before.stable) {
      if (++unstableChecks >= 3) break;
      // Let an in-flight writer finish before sampling again. A synchronous
      // retry can exhaust the fence while the writer is still on this turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      queryOptions?.signal?.throwIfAborted();
      continue;
    }
    attempt++;
    const graphs = await traceSlowSwmReadStage('selected.resolve-retry', queryOptions, () =>
      resolveGraphs(store, queryOptions));
    const quads = await traceSlowSwmReadStage('selected.materialize-retry', queryOptions, () =>
      read(store, graphs, queryOptions));
    if (quads.status === 'deferred') return quads;
    const after = revision.getWriteRevision(bucketGraph);
    if (after.stable && after.generation === before.generation) return quads;
  }
  throw new SharedMemoryReadConsistencyError();
}
