import type { Quad } from '@origintrail-official/dkg-storage';

export interface QueryResult {
  bindings: Array<Record<string, string>>;
  quads?: Quad[];
}

export interface QueryOptions {
  paranetId?: string;
  timeout?: number;
  /** When set to '_workspace', query runs over the paranet's workspace graph only. */
  graphSuffix?: '_workspace';
  /** When true and paranetId is set, query runs over both data and workspace graphs (union). */
  includeWorkspace?: boolean;
}

export interface QueryEngine {
  query(sparql: string, options?: QueryOptions): Promise<QueryResult>;
  resolveKA(ual: string): Promise<{ rootEntity: string; paranetId: string; quads: Quad[] }>;
}
