import type { Quad } from '@origintrail-official/dkg-storage';
import type { GetView } from '@origintrail-official/dkg-core';

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
  /** Agent address — required when view is 'working-memory' to resolve draft graphs. */
  agentAddress?: string;
  /** Specific verified graph name — used with view='verified-memory' to target a single verified graph. */
  verifiedGraph?: string;
}

export interface QueryEngine {
  query(sparql: string, options?: QueryOptions): Promise<QueryResult>;
  resolveKA(ual: string): Promise<{ rootEntity: string; contextGraphId: string; quads: Quad[] }>;
}
