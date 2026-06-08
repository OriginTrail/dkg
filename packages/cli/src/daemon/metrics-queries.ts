// Canonical SPARQL + result parsing for the daemon's metrics reads.
//
// Extracted so cross-package consumers — currently the
// `bench/store-read-latency` benchmark (regression guard for #939) — can
// measure the EXACT production read path (both the query AND how its result is
// parsed) instead of duplicated copies that could silently drift.

/**
 * Total triples across the default graph and all named graphs. Run on the 30s
 * metrics-collector cadence via `getTotalTriples` (see the metrics source in
 * `lifecycle.ts`). It is the heaviest read the collector issues and the one the
 * store-read-latency benchmark tracks.
 */
export const GET_TOTAL_TRIPLES_SPARQL =
  'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }';

/**
 * Parse a SPARQL `COUNT` binding into a number. The value arrives as an RDF
 * integer literal (e.g. `"1000"^^<…#integer>`) or a bare `1000`; missing or
 * unparseable values yield 0. Shared by the metrics collector and the
 * store-read benchmark so result parsing can't drift from the query.
 */
export function parseRdfInt(raw: string | undefined): number {
  if (!raw) return 0;
  const m = raw.match(/^"?(\d+)"?\^?\^/);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Short TTL for the metric COUNT getters (R6-B). Deliberately BELOW the 30 s
 * collector cadence so every periodic snapshot re-reads the store — a managed
 * or external SPARQL backend going down surfaces in the dashboard within this
 * window instead of being masked by stale "healthy" counts (review round 1).
 * Its job is in-flight coalescing + a brief dedup window: a UI `/api/status`
 * request firing alongside the metrics tick shares one full-scan COUNT rather
 * than triggering two. (The far heavier CG-count scan is relieved separately
 * by the `listGraphs()` cache, R6-A.)
 */
export const METRIC_COUNT_TTL_MS = 10_000;

/**
 * Wrap an async getter so a successful result is reused for `ttlMs`. Concurrent
 * calls on a cold/expired entry are coalesced onto one in-flight promise, so a
 * UI status request and the metrics tick can't both trigger the underlying full
 * scan at the same time. A rejection is not cached and clears the in-flight
 * slot, so the next call retries. `now` is injectable for deterministic tests.
 */
export function ttlMemo<T>(
  fn: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let cached: { value: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const value = await fn();
        cached = { value, at: now() };
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}
