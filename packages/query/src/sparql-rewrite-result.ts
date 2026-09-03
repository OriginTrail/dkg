export type SparqlRewriteResult<Value, Reason extends string, Original = Value> =
  | { readonly kind: 'ready'; readonly value: Value }
  | { readonly kind: 'unsupported'; readonly original: Original; readonly reason: Reason };

export function sparqlRewriteReady<Value>(
  value: Value,
): { readonly kind: 'ready'; readonly value: Value } {
  return { kind: 'ready', value };
}

export function sparqlRewriteUnsupported<Original, Reason extends string>(
  original: Original,
  reason: Reason,
): { readonly kind: 'unsupported'; readonly original: Original; readonly reason: Reason } {
  return { kind: 'unsupported', original, reason };
}
