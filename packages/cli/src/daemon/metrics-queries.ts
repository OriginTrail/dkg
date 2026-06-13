import { DKG_ONTOLOGY, sparqlIri, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';

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
const WALLET_SCOPED_CONTEXT_GRAPH_RE = /^0x[a-fA-F0-9]{40}\/.+$/;

/**
 * Total triples across the default graph and all named graphs. Run on the 30s
 * metrics-collector cadence via `getTotalTriples` (see the metrics source in
 * `lifecycle.ts`). It is the heaviest read the collector issues and the one the
 * store-read-latency benchmark tracks.
 */
export const GET_TOTAL_TRIPLES_SPARQL =
  'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }';

type MetricSubscriptionCandidate = {
  onChainId?: string;
  onChainHash?: string;
  pendingMeta?: boolean;
  synced?: boolean;
  metaSynced?: boolean;
  sharedMemorySynced?: boolean;
  coreHosted?: boolean;
};

const HASH_CONTEXT_GRAPH_ID_RE = /^0x[a-fA-F0-9]{64}$/;
const SYSTEM_CONTEXT_GRAPH_IDS = new Set<string>([
  SYSTEM_CONTEXT_GRAPHS.AGENTS,
  SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
]);
const NON_ROOT_DECLARATION_META_SEGMENTS = [
  '/_verifiable_memory/',
  '/_shared_memory_snapshots/',
  '/assertion/',
  '/context/',
] as const;

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
    .filter((id) => Boolean(id) && !SYSTEM_CONTEXT_GRAPH_IDS.has(id))
    .sort((a, b) => b.length - a.length);
}

function unambiguousMetricContextGraphId(candidate: string): string | null {
  if (!candidate) return null;
  if (SYSTEM_CONTEXT_GRAPH_IDS.has(candidate)) return null;
  if (!candidate.includes('/')) return candidate;
  return WALLET_SCOPED_CONTEXT_GRAPH_RE.test(candidate) ? candidate : null;
}

function declarationGraphUrisFromGraphUris(
  graphUris: readonly string[],
  knownContextGraphIds?: Iterable<string>,
): string[] {
  const declarationGraphs = new Set<string>([
    `${CONTEXT_GRAPH_URI_PREFIX}${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}`,
    `${CONTEXT_GRAPH_URI_PREFIX}${SYSTEM_CONTEXT_GRAPHS.AGENTS}`,
  ]);
  const knownCandidates = new Set(normalizeMetricContextGraphCandidates(knownContextGraphIds));
  for (const graphUri of graphUris) {
    if (!graphUri.startsWith(CONTEXT_GRAPH_URI_PREFIX)) continue;
    if (!graphUri.endsWith('/_meta')) continue;
    const rest = graphUri.slice(CONTEXT_GRAPH_URI_PREFIX.length);
    const id = rest.slice(0, -'/_meta'.length);
    if (
      knownCandidates.has(id)
      || !NON_ROOT_DECLARATION_META_SEGMENTS.some((segment) => rest.includes(segment))
    ) {
      declarationGraphs.add(graphUri);
    }
  }
  return [...declarationGraphs].sort();
}

export function buildContextGraphDeclarationsSparql(
  graphUris: readonly string[],
  knownContextGraphIds?: Iterable<string>,
): string | null {
  const declarationGraphs = declarationGraphUrisFromGraphUris(graphUris, knownContextGraphIds);
  if (declarationGraphs.length === 0) return null;
  const values = declarationGraphs.map((graphUri) => sparqlIri(graphUri)).join(' ');
  const agentsGraph = `${CONTEXT_GRAPH_URI_PREFIX}${SYSTEM_CONTEXT_GRAPHS.AGENTS}`;
  const ontologyGraph = `${CONTEXT_GRAPH_URI_PREFIX}${SYSTEM_CONTEXT_GRAPHS.ONTOLOGY}`;
  return `
    SELECT DISTINCT ?ctxGraph WHERE {
      VALUES ?g { ${values} }
      GRAPH ?g {
        ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
      }
      FILTER(STRSTARTS(STR(?ctxGraph), "${CONTEXT_GRAPH_URI_PREFIX}"))
      FILTER(
        ?g = ${sparqlIri(agentsGraph)}
        || ?g = ${sparqlIri(ontologyGraph)}
        || STR(?g) = CONCAT(STR(?ctxGraph), "/_meta")
      )
    }
  `;
}

export function contextGraphIdsFromDeclarationBindings(
  bindings: readonly Record<string, string>[] | undefined,
): string[] {
  const contextGraphIds = new Set<string>();
  for (const row of bindings ?? []) {
    const uri = row.ctxGraph;
    if (uri?.startsWith(CONTEXT_GRAPH_URI_PREFIX)) {
      const id = uri.slice(CONTEXT_GRAPH_URI_PREFIX.length);
      if (id && !SYSTEM_CONTEXT_GRAPH_IDS.has(id)) contextGraphIds.add(id);
    }
  }
  return [...contextGraphIds];
}

export function contextGraphIdsFromLocalRootMetaGraphs(
  graphUris: readonly string[],
  candidateContextGraphIds: Iterable<string>,
): string[] {
  const graphUriSet = new Set(graphUris);
  const contextGraphIds = new Set<string>();
  for (const id of candidateContextGraphIds) {
    if (!id || SYSTEM_CONTEXT_GRAPH_IDS.has(id)) continue;
    if (graphUriSet.has(`${CONTEXT_GRAPH_URI_PREFIX}${id}/_meta`)) {
      contextGraphIds.add(id);
    }
  }
  return [...contextGraphIds];
}

export function contextGraphIdsFromMetricSubscriptionCandidates(
  subscriptions: Iterable<readonly [string, MetricSubscriptionCandidate]>,
): string[] {
  return selectMetricSubscriptionCandidateIds(subscriptions).selected;
}

export function shadowContextGraphIdsFromMetricSubscriptionCandidates(
  subscriptions: Iterable<readonly [string, MetricSubscriptionCandidate]>,
): string[] {
  return selectMetricSubscriptionCandidateIds(subscriptions).shadows;
}

function selectMetricSubscriptionCandidateIds(
  subscriptions: Iterable<readonly [string, MetricSubscriptionCandidate]>,
): { selected: string[]; shadows: string[] } {
  const contextGraphIdsByIdentity = new Map<string, string>();
  const contextGraphIdsByStableIdentity = new Map<string, Set<string>>();
  for (const [id, sub] of subscriptions) {
    if (!id) continue;
    if (SYSTEM_CONTEXT_GRAPH_IDS.has(id)) continue;
    if (
      sub.onChainId
      || sub.pendingMeta === true
      || sub.synced === true
      || sub.metaSynced === true
      || sub.sharedMemorySynced === true
      || sub.coreHosted === true
    ) {
      const identity = sub.onChainHash
        ? `wire:${sub.onChainHash.toLowerCase()}`
        : sub.onChainId
          ? `chain:${sub.onChainId}`
          : `local:${id}`;
      let idsForIdentity = contextGraphIdsByStableIdentity.get(identity);
      if (!idsForIdentity) {
        idsForIdentity = new Set<string>();
        contextGraphIdsByStableIdentity.set(identity, idsForIdentity);
      }
      idsForIdentity.add(id);
      const existingId = contextGraphIdsByIdentity.get(identity);
      if (!existingId || shouldPreferMetricContextGraphId(id, existingId)) {
        contextGraphIdsByIdentity.set(identity, id);
      }
    }
  }
  const shadows: string[] = [];
  for (const [identity, ids] of contextGraphIdsByStableIdentity) {
    const selected = contextGraphIdsByIdentity.get(identity);
    for (const id of ids) {
      if (id !== selected) shadows.push(id);
    }
  }
  return { selected: [...contextGraphIdsByIdentity.values()], shadows };
}

function shouldPreferMetricContextGraphId(candidateId: string, existingId: string): boolean {
  const candidateIsHash = HASH_CONTEXT_GRAPH_ID_RE.test(candidateId);
  const existingIsHash = HASH_CONTEXT_GRAPH_ID_RE.test(existingId);
  if (candidateIsHash !== existingIsHash) return !candidateIsHash;
  const candidateIsWalletScoped = WALLET_SCOPED_CONTEXT_GRAPH_RE.test(candidateId);
  const existingIsWalletScoped = WALLET_SCOPED_CONTEXT_GRAPH_RE.test(existingId);
  if (candidateIsWalletScoped !== existingIsWalletScoped) return candidateIsWalletScoped;
  return candidateId.length < existingId.length;
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
  excludedContextGraphIds?: Iterable<string>,
): number {
  const excludedContextGraphIdSet = new Set(excludedContextGraphIds ?? []);
  const knownCandidates = normalizeMetricContextGraphCandidates(knownContextGraphIds)
    .filter((contextGraphId) => !excludedContextGraphIdSet.has(contextGraphId));
  const contextGraphIds = new Set<string>(knownCandidates);
  for (const graphUri of graphUris) {
    const contextGraphId = contextGraphIdFromGraphUriForMetricsWithCandidates(
      graphUri,
      knownCandidates,
    );
    if (contextGraphId && !excludedContextGraphIdSet.has(contextGraphId)) {
      contextGraphIds.add(contextGraphId);
    }
  }
  return contextGraphIds.size;
}
