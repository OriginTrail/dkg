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
 * This is standard SPARQL 1.1 — correct on any endpoint, index-optimized on
 * oxigraph (the sparql-http adapter's DKG backend). The Blazegraph adapter
 * deliberately keeps the legacy scan form (mainnet cores; out of scope here).
 */
export const NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY =
  'SELECT ?g WHERE { GRAPH ?g {} FILTER EXISTS { GRAPH ?g { ?s ?p ?o } } }';
