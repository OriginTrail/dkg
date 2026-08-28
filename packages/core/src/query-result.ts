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

export interface PublicQueryResponse<
  Binding extends Record<string, unknown> = Record<string, unknown>,
  Quad extends PublicQueryQuad = PublicQueryQuad,
> {
  result: PublicQueryResult<Binding, Quad>;
  phases?: Record<string, number>;
}
