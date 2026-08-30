export type LookupType =
  | 'ENTITY_BY_UAL'
  | 'ENTITIES_BY_TYPE'
  | 'ENTITY_TRIPLES'
  | 'SPARQL_QUERY';

export type QueryStatus =
  | 'OK'
  | 'ERROR'
  | 'BUSY'
  | 'ACCESS_DENIED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'GAS_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_LOOKUP';

export type NonBusyQueryStatus = Exclude<QueryStatus, 'BUSY'>;

export interface QueryRequest {
  operationId: string;
  lookupType: LookupType;
  contextGraphId?: string;
  ual?: string;
  entityUri?: string;
  rdfType?: string;
  sparql?: string;
  limit?: number;
  timeout?: number;
}

interface QueryResponseBase {
  operationId: string;
  truncated: boolean;
  resultCount: number;
}

export interface QueryNonBusyResponse extends QueryResponseBase {
  status: NonBusyQueryStatus;
  ntriples?: string;
  bindings?: string;
  entityUris?: string[];
  gasConsumed?: number;
  error?: string;
  code?: never;
  retryable?: never;
  retryAfterMs?: never;
  reason?: never;
}

export interface QueryBusyResponse extends QueryResponseBase {
  status: 'BUSY';
  error: string;
  code: 'STORE_BUSY';
  retryable: true;
  retryAfterMs: number;
  reason?: 'queue_full' | 'queue_wait_timeout';
  ntriples?: never;
  bindings?: never;
  entityUris?: never;
  gasConsumed?: never;
}

export type QueryResponse = QueryNonBusyResponse | QueryBusyResponse;

type AssertFalse<T extends false> = T;
type IncompleteBusyResponse = QueryResponseBase & { status: 'BUSY' };
type ContradictoryOkResponse = QueryResponseBase & {
  status: 'OK';
  code: 'STORE_BUSY';
  retryable: true;
};
export type QueryResponseTypeAssertions = [
  AssertFalse<IncompleteBusyResponse extends QueryResponse ? true : false>,
  AssertFalse<ContradictoryOkResponse extends QueryResponse ? true : false>,
];

export interface ContextGraphQueryPolicy {
  policy: 'deny' | 'public' | 'allowList';
  allowedPeers?: string[];
  allowedLookupTypes?: LookupType[];
  sparqlEnabled?: boolean;
  sparqlTimeout?: number;
  sparqlMaxResults?: number;
}

export interface QueryAccessConfig {
  defaultPolicy: 'deny' | 'public';
  contextGraphs?: Record<string, ContextGraphQueryPolicy>;
  rateLimitPerMinute?: number;
}
