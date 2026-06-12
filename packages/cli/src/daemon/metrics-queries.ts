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

const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';
const CONTEXT_GRAPH_LAYER_MARKERS = [
  '/_shared_memory/',
  '/_shared_memory_snapshots/',
  '/_verifiable_memory/',
  '/_working_memory/',
  '/assertion/',
  '/context/',
] as const;
const CONTEXT_GRAPH_RESERVED_SUFFIXES = [
  '/_shared_memory_meta',
  '/_shared_memory',
  '/_private',
  '/_rules',
  '/_meta',
] as const;
const WALLET_SCOPED_CONTEXT_GRAPH_RE = /^0x[a-fA-F0-9]{40}\/[^/]+/;

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

function normalizeMetricContextGraphCandidates(knownContextGraphIds?: Iterable<string>): string[] {
  return [...new Set(knownContextGraphIds ?? [])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

export function contextGraphIdFromGraphUriForMetrics(
  graphUri: string,
  knownContextGraphIds?: Iterable<string>,
): string | null {
  return contextGraphIdFromGraphUriForMetricsWithCandidates(
    graphUri,
    normalizeMetricContextGraphCandidates(knownContextGraphIds),
  );
}

function contextGraphIdFromGraphUriForMetricsWithCandidates(
  graphUri: string,
  knownContextGraphIds: readonly string[],
): string | null {
  if (!graphUri.startsWith(CONTEXT_GRAPH_URI_PREFIX)) return null;
  let rest = graphUri.slice(CONTEXT_GRAPH_URI_PREFIX.length);
  if (!rest) return null;

  for (const knownId of knownContextGraphIds) {
    if (rest === knownId || rest.startsWith(`${knownId}/`)) return knownId;
  }

  for (const marker of CONTEXT_GRAPH_LAYER_MARKERS) {
    const markerIndex = rest.indexOf(marker);
    if (markerIndex > 0) {
      rest = rest.slice(0, markerIndex);
      break;
    }
  }

  for (const suffix of CONTEXT_GRAPH_RESERVED_SUFFIXES) {
    if (rest.endsWith(suffix)) {
      rest = rest.slice(0, -suffix.length);
      if (!rest) return null;
      break;
    }
  }

  const walletScoped = rest.match(WALLET_SCOPED_CONTEXT_GRAPH_RE)?.[0];
  if (walletScoped) return walletScoped;

  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

export function countContextGraphsFromGraphUris(
  graphUris: readonly string[],
  knownContextGraphIds?: Iterable<string>,
): number {
  const knownCandidates = normalizeMetricContextGraphCandidates(knownContextGraphIds);
  const contextGraphIds = new Set<string>();
  for (const graphUri of graphUris) {
    const contextGraphId = contextGraphIdFromGraphUriForMetricsWithCandidates(
      graphUri,
      knownCandidates,
    );
    if (contextGraphId) contextGraphIds.add(contextGraphId);
  }
  return contextGraphIds.size;
}
