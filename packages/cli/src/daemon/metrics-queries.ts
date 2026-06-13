import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';

// Canonical SPARQL + result parsing for the daemon's metrics reads.
//
// Extracted so cross-package consumers — currently the
// `bench/store-read-latency` benchmark (regression guard for #939) — can
// measure the EXACT production read path (both the query AND how its result is
// parsed) instead of duplicated copies that could silently drift.

const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';
const CONTEXT_GRAPH_UNAMBIGUOUS_LAYER_MARKERS = [
  '/_shared_memory/',
  '/_shared_memory_snapshots/',
  '/_verifiable_memory/',
  '/_working_memory/',
] as const;
const CONTEXT_GRAPH_RESERVED_SUFFIXES = [
  '/_shared_memory_meta',
  '/_shared_memory',
  '/_private',
  '/_rules',
  '/_meta',
] as const;
const WALLET_SCOPED_CONTEXT_GRAPH_RE = /^0x[a-fA-F0-9]{40}\/[^/]+$/;

/**
 * Total triples across the default graph and all named graphs. Run on the 30s
 * metrics-collector cadence via `getTotalTriples` (see the metrics source in
 * `lifecycle.ts`). It is the heaviest read the collector issues and the one the
 * store-read-latency benchmark tracks.
 */
export const GET_TOTAL_TRIPLES_SPARQL =
  'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }';

export const GET_CONTEXT_GRAPH_DECLARATIONS_SPARQL = `
  SELECT DISTINCT ?ctxGraph WHERE {
    GRAPH ?g {
      ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
    }
    FILTER(STRSTARTS(STR(?ctxGraph), "${CONTEXT_GRAPH_URI_PREFIX}"))
  }
`;

type MetricSubscriptionCandidate = {
  onChainId?: string;
  pendingMeta?: boolean;
  synced?: boolean;
  metaSynced?: boolean;
  sharedMemorySynced?: boolean;
  coreHosted?: boolean;
};

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

function unambiguousMetricContextGraphId(candidate: string): string | null {
  if (!candidate) return null;
  if (!candidate.includes('/')) return candidate;
  return WALLET_SCOPED_CONTEXT_GRAPH_RE.test(candidate) ? candidate : null;
}

export function contextGraphIdsFromDeclarationBindings(
  bindings: readonly Record<string, string>[] | undefined,
): string[] {
  const contextGraphIds = new Set<string>();
  for (const row of bindings ?? []) {
    const uri = row.ctxGraph;
    if (uri?.startsWith(CONTEXT_GRAPH_URI_PREFIX)) {
      const id = uri.slice(CONTEXT_GRAPH_URI_PREFIX.length);
      if (id) contextGraphIds.add(id);
    }
  }
  return [...contextGraphIds];
}

export function contextGraphIdsFromMetricSubscriptionCandidates(
  subscriptions: Iterable<readonly [string, MetricSubscriptionCandidate]>,
): string[] {
  const contextGraphIds = new Set<string>();
  for (const [id, sub] of subscriptions) {
    if (!id) continue;
    if (
      sub.onChainId
      || sub.pendingMeta === true
      || sub.synced === true
      || sub.metaSynced === true
      || sub.sharedMemorySynced === true
      || sub.coreHosted === true
    ) {
      contextGraphIds.add(id);
    }
  }
  return [...contextGraphIds];
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

  for (const suffix of CONTEXT_GRAPH_RESERVED_SUFFIXES) {
    if (rest.endsWith(suffix)) {
      return unambiguousMetricContextGraphId(rest.slice(0, -suffix.length));
    }
  }

  for (const marker of CONTEXT_GRAPH_UNAMBIGUOUS_LAYER_MARKERS) {
    const markerIndex = rest.indexOf(marker);
    if (markerIndex > 0) {
      return unambiguousMetricContextGraphId(rest.slice(0, markerIndex));
    }
  }

  return unambiguousMetricContextGraphId(rest);
}

export function countContextGraphsFromGraphUris(
  graphUris: readonly string[],
  knownContextGraphIds?: Iterable<string>,
): number {
  const knownCandidates = normalizeMetricContextGraphCandidates(knownContextGraphIds);
  const contextGraphIds = new Set<string>(knownCandidates);
  for (const graphUri of graphUris) {
    const contextGraphId = contextGraphIdFromGraphUriForMetricsWithCandidates(
      graphUri,
      knownCandidates,
    );
    if (contextGraphId) contextGraphIds.add(contextGraphId);
  }
  return contextGraphIds.size;
}
