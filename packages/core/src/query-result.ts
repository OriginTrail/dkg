/** Public wire contract returned by POST /api/query. */
export interface PublicQueryQuad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export type PublicQueryResult<
  Binding extends Record<string, unknown> = Record<string, unknown>,
  Quad extends PublicQueryQuad = PublicQueryQuad,
> =
  | { type: 'bindings'; bindings: Binding[] }
  | { type: 'quads'; quads: Quad[]; bindings?: Binding[] }
  | { type: 'boolean'; value: boolean; bindings?: Binding[] };

/**
 * How a view query matches its patterns, as a request option (`semantics`) and in the answer:
 * - `merged`: patterns outside `GRAPH` match the merge of the view's asset graphs, one set of
 *   triples, so a join or `FILTER NOT EXISTS` can span assets and a triple held by two assets
 *   counts once; patterns inside `GRAPH` match inside one asset graph;
 * - `per-asset`: every pattern matches inside one asset graph at a time.
 */
export type ViewQuerySemantics = 'merged' | 'per-asset';
export const VIEW_QUERY_SEMANTICS: readonly ViewQuerySemantics[] = ['merged', 'per-asset'];

/** A merged view query whose scope is not ready to serve it: answered 503 with `Retry-After`. */
export const VIEW_NOT_READY_CODE = 'VIEW_NOT_READY';
/** `semantics: "merged"` asked for where it does not apply: answered 400. */
export const SEMANTICS_UNSUPPORTED_CODE = 'SEMANTICS_UNSUPPORTED';

export interface PublicQueryResponse<
  Binding extends Record<string, unknown> = Record<string, unknown>,
  Quad extends PublicQueryQuad = PublicQueryQuad,
> {
  result: PublicQueryResult<Binding, Quad>;
  /** The matching a query with a context graph was answered with. */
  semantics?: ViewQuerySemantics;
  phases?: Record<string, number>;
}
