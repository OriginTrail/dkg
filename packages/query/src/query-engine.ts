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
   * Per-subject trust floor for `verified-memory`. Values above
   * `SelfAttested` require every matched subject to carry an explicit
   * `http://dkg.io/ontology/trustLevel` literal at or above `minTrust`.
   * The root graph and `/_verified_memory/*` graphs remain candidates;
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

export interface QueryEngine {
  query(sparql: string, options?: QueryOptions): Promise<QueryResult>;
  resolveKA(ual: string): Promise<{ rootEntity: string; contextGraphId: string; quads: Quad[] }>;
}
