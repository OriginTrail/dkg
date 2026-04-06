export type LookupType =
  | 'ENTITY_BY_UAL'
  | 'ENTITIES_BY_TYPE'
  | 'ENTITY_TRIPLES'
  | 'SPARQL_QUERY';

export type QueryStatus =
  | 'OK'
  | 'ERROR'
  | 'ACCESS_DENIED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'GAS_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_LOOKUP';

export interface QueryRequest {
  operationId: string;
  lookupType: LookupType;
  contextGraphId?: string;
  /** @deprecated Use contextGraphId */
  paranetId?: string;
  ual?: string;
  entityUri?: string;
  rdfType?: string;
  sparql?: string;
  limit?: number;
  timeout?: number;
}

export interface QueryResponse {
  operationId: string;
  status: QueryStatus;
  ntriples?: string;
  bindings?: string;
  entityUris?: string[];
  truncated: boolean;
  resultCount: number;
  gasConsumed?: number;
  error?: string;
}

export interface ContextGraphQueryPolicy {
  policy: 'deny' | 'public' | 'allowList';
  allowedPeers?: string[];
  allowedLookupTypes?: LookupType[];
  sparqlEnabled?: boolean;
  sparqlTimeout?: number;
  sparqlMaxResults?: number;
}

/** @deprecated Use ContextGraphQueryPolicy */
export type ParanetQueryPolicy = ContextGraphQueryPolicy;

export interface QueryAccessConfig {
  defaultPolicy: 'deny' | 'public';
  contextGraphs?: Record<string, ContextGraphQueryPolicy>;
  /** @deprecated Use contextGraphs */
  paranets?: Record<string, ContextGraphQueryPolicy>;
  rateLimitPerMinute?: number;
}
