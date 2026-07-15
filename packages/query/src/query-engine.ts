import type { Quad } from '@origintrail-official/dkg-storage';
import type { GetView } from '@origintrail-official/dkg-core';
import { TrustLevel } from '@origintrail-official/dkg-core';

export interface QueryResult {
  bindings: Array<Record<string, string>>;
  quads?: Quad[];
}

export interface QueryOptions {
  contextGraphId?: string;
  timeout?: number;
  /** When set to '_shared_memory', query runs over the context graph's shared memory graph only. */
  graphSuffix?: '_shared_memory';
  /** When true and contextGraphId is set, query runs over both data and shared memory graphs (union). */
  includeSharedMemory?: boolean;
  /** @deprecated Use includeSharedMemory */
  includeWorkspace?: boolean;
  /**
   * Opt-in for aggregate/count callers that intentionally need scoped
   * `GRAPH ?g` queries to enumerate all registered public content partitions
   * in the same context graph (root data, registered assertion graphs, SWM,
   * VM, and registered sub-graph content). Legacy scoped routes stay limited
   * to their selected graph set unless this is true.
   */
  includeContextGraphPartitions?: boolean;
  /**
   * Opt-in: allow the scoped query to explicitly reference the context
   * graph's own `_private` partition (`<cg>/_private`, or the sub-graph
   * private graph when `subGraphName` is set). The scope guard excludes
   * `_private` by default — it is treated as more sensitive than the
   * `_meta` graphs that CG-scoped callers may always read. Callers that
   * legitimately need private-partition data (e.g. the EPCIS events query,
   * which surfaces private-anchored events to the hosting node) set this.
   * Does not widen access for any other CG-scoped caller.
   */
  includePrivate?: boolean;
  /** V10 declared state view — determines which graph(s) the query targets. */
  view?: GetView;
  /** Agent address — required when view is 'working-memory' to resolve assertion graphs. */
  agentAddress?: string;
  /**
   * Additional WM namespaces that are ALIASES of the same identity as
   * `agentAddress` (PR #1107 review 🟡). The node default agent's WM data is
   * split across two eras of layout: legacy drafts under the peerId-keyed
   * namespace and rc.17+ drafts under the EVM-wallet namespace. Unscoped
   * `view: 'working-memory'` reads span every listed alias so neither era is
   * stranded. Callers MUST only pass addresses that canonicalise to the same
   * identity as `agentAddress` — this is an alias list, not an
   * access-widening mechanism. Ignored for by-name (assertionName) reads,
   * which stay single-graph on the primary address.
   */
  agentAddressAliases?: string[];
  /** Specific verified graph name — used with view='verifiable-memory' to target a single verified graph. */
  verifiedGraph?: string;
  /** Specific assertion name — used with view='working-memory' to target a single assertion graph. */
  assertionName?: string;
  /**
   * Scope the query to a specific sub-graph within the context graph.
   * When set, the query targets `did:dkg:context-graph:{id}/{subGraphName}`
   * instead of the root data graph. Only works with legacy routing (no `view`).
   * Combining `subGraphName` with `view` throws — deferred to V10.x.
   */
  subGraphName?: string;
  /**
   * Graph URI prefixes to exclude from unscoped queries.
   * Used to prevent private context graph data from leaking into
   * queries that don't specify a contextGraphId.
   */
  excludeGraphPrefixes?: string[];
  /**
   * Per-subject trust floor for `verifiable-memory`. Values above
   * `SelfAttested` require every matched subject to carry an explicit
   * `http://dkg.io/ontology/trustLevel` literal at or above `minTrust`.
   * The root graph and `/_verifiable_memory/*` graphs remain candidates;
   * trust is not inferred from graph scope. Ignored on other views.
   */
  minTrust?: TrustLevel;
  /**
   * @deprecated Use `minTrust`. Legacy alias retained during V10-rc for
   * SDK consumers that adopted the underscore form before we renamed the
   * field. Engines MUST fall back to this value when `minTrust` is
   * undefined (via `options.minTrust ?? options._minTrust`). This alias
   * will be removed in a future V10 minor — migrate to `minTrust`.
   */
  _minTrust?: TrustLevel;
}

export interface ResolvedKnowledgeAssetBase {
  ual: string;
  contextGraphId: string;
  quads: Quad[];
}

/** The original public result contract of {@link QueryEngine.resolveKA}. */
export interface LegacyResolveKAResult {
  rootEntity: string;
  rootEntities: string[];
  contextGraphId: string;
  quads: Quad[];
}

/** Current V10 KA model: one exact graph identified by UAL + assertion version. */
export interface ResolvedGraphKnowledgeAsset extends ResolvedKnowledgeAssetBase {
  contentScopeVersion: 2;
  assertionVersion: string;
  assertionGraph: string;
  rootEntities: [];
  rootEntity?: never;
}

/** Existing V10 root-scoped KAs remain queryable but are never writable. */
export interface ResolvedLegacyKnowledgeAsset
  extends ResolvedKnowledgeAssetBase, LegacyResolveKAResult {
  contentScopeVersion: 1;
  rootEntity: string;
  rootEntities: string[];
  assertionVersion?: never;
  assertionGraph?: never;
}

export type ResolvedKnowledgeAsset =
  | ResolvedGraphKnowledgeAsset
  | ResolvedLegacyKnowledgeAsset;

export interface QueryEngine {
  query(sparql: string, options?: QueryOptions): Promise<QueryResult>;
  /**
   * Backwards-compatible legacy resolver. Its required root fields remain
   * source-compatible with callers published before graph-scoped KAs existed.
   */
  resolveKA(ual: string): Promise<LegacyResolveKAResult>;
  /**
   * Graph-aware resolver for current callers. Optional so third-party
   * QueryEngine implementations are not broken by the additive API.
   */
  resolveKnowledgeAsset?(ual: string): Promise<ResolvedKnowledgeAsset>;
}

/** Query engine surface for callers that understand graph-scoped KAs. */
export interface GraphAwareQueryEngine extends QueryEngine {
  resolveKnowledgeAsset(ual: string): Promise<ResolvedKnowledgeAsset>;
}
