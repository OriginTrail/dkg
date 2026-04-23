import type { Quad } from '@origintrail-official/dkg-storage';
import type { GetView } from '@origintrail-official/dkg-core';
import { TrustLevel } from '@origintrail-official/dkg-core';

export interface QueryResult {
  bindings: Array<Record<string, string>>;
  quads?: Quad[];
}

export interface QueryOptions {
  contextGraphId?: string;
  /** @deprecated Use contextGraphId */
  paranetId?: string;
  timeout?: number;
  /** When set to '_shared_memory', query runs over the context graph's shared memory graph only. */
  graphSuffix?: '_shared_memory';
  /** When true and contextGraphId is set, query runs over both data and shared memory graphs (union). */
  includeSharedMemory?: boolean;
  /** @deprecated Use includeSharedMemory */
  includeWorkspace?: boolean;
  /** V10 declared state view — determines which graph(s) the query targets. */
  view?: GetView;
  /** Agent address — required when view is 'working-memory' to resolve assertion graphs. */
  agentAddress?: string;
  /** Specific verified graph name — used with view='verified-memory' to target a single verified graph. */
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
   * Graph-level trust scope for a `verified-memory` view. This is **not**
   * a per-triple filter — it selects which *named graphs* are unioned
   * into the query, relying on the invariant that each named graph is
   * populated by a single trust-tier write path:
   *
   *   - root `did:dkg:context-graph:{id}` — chain-confirmed, SelfAttested.
   *   - `did:dkg:context-graph:{id}/_verified_memory/{quorum}` —
   *     populated by the quorum's verified-memory write path; the quorum
   *     identifier itself is the trust provenance.
   *
   * Semantics:
   *   - undefined or `SelfAttested`: union root + `/_verified_memory/*`.
   *   - Any value above `SelfAttested` (`Endorsed`, `PartiallyVerified`,
   *     `ConsensusVerified`): drop the root data graph, keep only
   *     `/_verified_memory/*` sub-graphs. This prevents SelfAttested
   *     chain data from bleeding into a high-trust query.
   *
   * Known gap (tracked as Q-1): surviving `/_verified_memory/*` graphs
   * are not filtered per-triple against a `dkg:trustLevel` predicate.
   * If upstream writers respect the one-trust-tier-per-graph invariant
   * this is safe; if a future writer stamps mixed-trust triples into a
   * single sub-graph the graph-scope filter will not catch it. Do not
   * rely on `minTrust` alone for a compliance-grade trust guarantee
   * until Q-1 lands.
   */
  minTrust?: TrustLevel;
  /**
   * @deprecated Use `minTrust`. Legacy alias kept for backward compat.
   * Will be removed in a future release.
   */
  _minTrust?: TrustLevel;
}

export interface QueryEngine {
  query(sparql: string, options?: QueryOptions): Promise<QueryResult>;
  resolveKA(ual: string): Promise<{ rootEntity: string; contextGraphId: string; quads: Quad[] }>;
}
