export type SparqlRewriteResult<Value, Reason extends string> =
  | { readonly kind: 'ready'; readonly value: Value }
  | { readonly kind: 'unsupported'; readonly reason: Reason };

export function sparqlRewriteReady<Value>(
  value: Value,
): { readonly kind: 'ready'; readonly value: Value } {
  return { kind: 'ready', value };
}

export function sparqlRewriteUnsupported<Reason extends string>(
  reason: Reason,
): { readonly kind: 'unsupported'; readonly reason: Reason } {
  return { kind: 'unsupported', reason };
}
