/**
 * SPARQL that enumerates named graphs currently holding at least one quad,
 * by reading the store's named-graph index instead of scanning quads.
 *
 * Single source of truth for this query, shared by the Oxigraph adapters
 * (`OxigraphStore` in-process and `SparqlHttpStore` over the oxigraph-server
 * HTTP endpoint) so the two paths cannot silently diverge.
 *
 * WHY THIS SHAPE:
 *   - `GRAPH ?g {}` matches each REGISTERED named graph exactly once. On
 *     oxigraph (RocksDB-backed server and in-process alike) this reads the
 *     graph index → O(#graphs), flat. Benchmarked on the pinned 0.5.8 RocksDB
 *     binary: ~5–14 ms regardless of store size.
 *   - The legacy `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }` forces an
 *     O(#quads) scan + DISTINCT: 12 ms → 947 ms across 25k → 1M quads (super-
 *     linear). On a large core store it exceeds the request timeout, the
 *     graph-set index never seeds, and the sync responder re-runs the doomed
 *     scan on every request — the 2026-07-10 beacon-OOM livelock (dkg #1597).
 *
 * WHY `FILTER EXISTS` (not bare `GRAPH ?g {}`):
 *   A graph emptied by DELETE (not DROP) stays REGISTERED in oxigraph, so bare
 *   `GRAPH ?g {}` over-lists it (confirmed on RocksDB: bare = 1001 vs
 *   FILTER-EXISTS = 1000 == the legacy query). `FILTER EXISTS` reproduces the
 *   historical non-empty-only contract exactly (see
 *   graph-set-index-store.ts — "only graphs containing at least one quad are
 *   listed").
 *
 * The bounded EXISTS subquery avoids a full-graph probe on Blazegraph while
 * retaining non-empty semantics on Oxigraph. Callers can compose the pattern
 * into a catalog UNION without duplicating backend enumeration policy.
 */
export function nonEmptyNamedGraphEnumerationPattern(variable = 'g'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new TypeError('Invalid graph variable');
  const graph = `?${variable}`;
  return `GRAPH ${graph} {} FILTER EXISTS { SELECT ${graph} WHERE { GRAPH ${graph} { ?s ?p ?o } } LIMIT 1 }`;
}
export const NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY =
  `SELECT ?g WHERE { ${nonEmptyNamedGraphEnumerationPattern()} }`;
