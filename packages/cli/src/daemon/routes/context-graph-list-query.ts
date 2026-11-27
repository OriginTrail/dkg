// daemon/routes/context-graph-list-query.ts
//
// The opt-in filters of `GET /api/context-graph/list` (#3919). A request that sends none of them gets
// exactly the answer it always did. Each takes `true` or `false`, and the value that is not the default
// narrows the answer:
//
//   named=true     only the graphs the node knows by name (`nameKnown: true`)
//   system=false   no system graphs (`isSystem: true`)
//   onChain=false  no `onChain` facts on any row
//
// Any other value, an empty one or a repeated parameter is a `400` that names the parameter and never
// repeats the input. Other query parameters are ignored, as this route always did.

import type { ContextGraphListFilter } from '@origintrail-official/dkg-agent';

/** The `code` of the `400` for a filter parameter the route cannot read. */
export const CONTEXT_GRAPH_LIST_FILTER_INVALID = 'CONTEXT_GRAPH_LIST_FILTER_INVALID';

/** Query parameter, in wire spelling, and the filter field it sets. */
const FILTER_PARAMETERS = [
  ['named', 'namedOnly'],
  ['system', 'includeSystem'],
  ['onChain', 'includeOnChain'],
] as const satisfies ReadonlyArray<readonly [string, keyof ContextGraphListFilter]>;

export type ContextGraphListQuery =
  | {
      readonly ok: true;
      /** Undefined when the request names no filter parameter: the unfiltered listing. */
      readonly filter: ContextGraphListFilter | undefined;
    }
  | { readonly ok: false; readonly error: string; readonly code: typeof CONTEXT_GRAPH_LIST_FILTER_INVALID };

/** Read the filter parameters of a list request, or the `400` answer for one it cannot read. */
export function parseContextGraphListQuery(searchParams: URLSearchParams): ContextGraphListQuery {
  const filter: { -readonly [K in keyof ContextGraphListFilter]: ContextGraphListFilter[K] } = {};
  let anySent = false;
  for (const [parameter, field] of FILTER_PARAMETERS) {
    const values = searchParams.getAll(parameter);
    if (values.length === 0) continue;
    if (values.length > 1) {
      return { ok: false, code: CONTEXT_GRAPH_LIST_FILTER_INVALID, error: `"${parameter}" may be given only once` };
    }
    if (values[0] !== 'true' && values[0] !== 'false') {
      return { ok: false, code: CONTEXT_GRAPH_LIST_FILTER_INVALID, error: `"${parameter}" must be "true" or "false"` };
    }
    filter[field] = values[0] === 'true';
    anySent = true;
  }
  return { ok: true, filter: anySent ? filter : undefined };
}
