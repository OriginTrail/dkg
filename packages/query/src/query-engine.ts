import type { Quad } from '@dkg/storage';

export interface QueryResult {
  bindings: Array<Record<string, string>>;
  quads?: Quad[];
}

export interface QueryOptions {
  paranetId?: string;
  timeout?: number;
}

export interface QueryEngine {
  query(sparql: string, options?: QueryOptions): Promise<QueryResult>;
  resolveKA(ual: string): Promise<{ rootEntity: string; paranetId: string; quads: Quad[] }>;
}
