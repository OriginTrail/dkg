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
  /**
   * Scope the query to a specific sub-graph within the context graph.
   * When set, the query targets `did:dkg:context-graph:{id}/{subGraphName}`
   * instead of the root data graph. Only works with legacy routing (no `view`).
   * Combining `subGraphName` with `view` throws — deferred to V10.x.
   */
  subGraphName?: string;
  /**
   * @internal Reserved for future use — not yet enforced by DKGQueryEngine.
   * Will filter verified-memory triples below this trust threshold once trust
   * metadata is available in verified-memory graphs.
   */
  _minTrust?: TrustLevel;
}

export interface QueryEngine {
  query(sparql: string, options?: QueryOptions): Promise<QueryResult>;
  resolveKA(ual: string): Promise<{ rootEntity: string; contextGraphId: string; quads: Quad[] }>;
}
