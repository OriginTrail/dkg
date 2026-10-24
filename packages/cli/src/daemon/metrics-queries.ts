import { DKG_ONTOLOGY, sparqlIri, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import type { StoreCountSnapshot } from '@origintrail-official/dkg-node-ui';

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

// sparql-scan-allow: R1 -- exact low-frequency store reconciliation must count the default graph
// sparql-scan-allow: R2 -- exact low-frequency store reconciliation must count every named graph
const TOTAL_TRIPLES_PATTERN = '{ ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } }';

/**
 * Total triples across the default graph and all named graphs. This standalone
 * query remains the canonical benchmark probe; production metrics use the
 * combined, low-frequency snapshot below.
 */
export const GET_TOTAL_TRIPLES_SPARQL =
  `SELECT (COUNT(*) AS ?c) WHERE { ${TOTAL_TRIPLES_PATTERN} }`;

// RFC ka-metadata-trim (Phase 2 ⊕ / Phase 3 P3.1): the KC/KA counters are
// predicate-based, not rdf:type-based — `generateKCMetadata` no longer
// emits `rdf:type dkg:KnowledgeCollection` / `dkg:KnowledgeAsset` rows.
//   - KC ≙ a subject carrying `dkg:status` (every KC row, old shape or
//     new, has exactly one tentative/confirmed status quad).
//   - KA ≙ read-both: a legacy `<ual>/<n>` token row carrying
//     `dkg:partOf`, OR (collapsed shape, P3.1) a UAL subject carrying
//     `dkg:status` + the entity pair with NO token row pointing at it
//     (the NOT-EXISTS guard prevents double-counting old-shape rows,
//     whose aggregate UAL node also carries `dkg:rootEntity`).
/**
 * One exact store-count snapshot. The subqueries intentionally preserve the
 * established count semantics above; combining them removes four HTTP
 * round-trips and gives the reconciler one all-or-nothing result.
 */
// sparql-scan-allow: R1 -- exact reconciliation runs at background priority at most once per five minutes
// sparql-scan-allow: R2 -- exact reconciliation intentionally counts all admitted named graphs in one query
export const GET_STORE_COUNT_SNAPSHOT_SPARQL = `SELECT ?totalTriples ?totalKCs ?totalKAs ?confirmedKCs ?tentativeKCs WHERE {
  { SELECT (COUNT(*) AS ?totalTriples) WHERE {
      # sparql-scan-allow: R1 -- exact background reconciliation counts the default graph at most once per five minutes
      # sparql-scan-allow: R2 -- exact background reconciliation counts all admitted named graphs at most once per five minutes
      ${TOTAL_TRIPLES_PATTERN}
  } }
  { SELECT (COUNT(DISTINCT ?kc) AS ?totalKCs) WHERE {
      GRAPH ?g { ?kc <http://dkg.io/ontology/status> ?status }
  } }
  { SELECT (COUNT(DISTINCT ?ka) AS ?totalKAs) WHERE { GRAPH ?g {
      { ?ka <http://dkg.io/ontology/partOf> ?kc }
      UNION
      { ?ka <http://dkg.io/ontology/status> ?status .
        ?ka <http://dkg.io/ontology/rootEntity> ?rootEntity .
        FILTER NOT EXISTS { ?token <http://dkg.io/ontology/partOf> ?ka } }
  } } }
  { SELECT (COUNT(DISTINCT ?kc) AS ?confirmedKCs) WHERE {
      GRAPH ?g { ?kc <http://dkg.io/ontology/status> "confirmed" }
  } }
  { SELECT (COUNT(DISTINCT ?kc) AS ?tentativeKCs) WHERE {
      GRAPH ?g { ?kc <http://dkg.io/ontology/status> "tentative" }
  } }
}`;

const STORE_METRICS_HEALTH_SPARQL = 'ASK {}';
export const STORE_COUNT_RECONCILE_INTERVAL_MS = 5 * 60_000;

export interface StoreCountMetricsOptions {
  /** Exact full-store reconciliation cadence. Defaults to five minutes. */
  reconcileIntervalMs?: number;
  /** Monotonic clock injection for deterministic tests. */
  now?: () => number;
}

type MetricsCountQuery = (
  sparql: string,
  options: { source: string; priority: 'background' | 'health' },
) => Promise<MetricsAgentQueryResult>;

/** The normalized result contract returned by `DKGAgent.query()`. */
interface MetricsAgentQueryResult {
  readonly bindings: ReadonlyArray<Readonly<Record<string, string>>>;
}

interface ReconciledStoreCountSnapshot {
  readonly value: StoreCountSnapshot;
  readonly reconciledAt: number;
}

/**
 * The store counts of the daemon's metrics source, read through the agent's
 * query API with no context graph. Unscoped reads leave core-cache-marked
 * graphs out, so after a core-cache snapshot job these count everything else.
 */
export function createStoreCountMetrics(
  query: MetricsCountQuery,
  options: StoreCountMetricsOptions = {},
) {
  const reconcileIntervalMs = finiteInterval(
    options.reconcileIntervalMs,
    STORE_COUNT_RECONCILE_INTERVAL_MS,
    'reconcileIntervalMs',
  );
  const now = options.now ?? (() => performance.now());
  let reconciled: ReconciledStoreCountSnapshot | null = null;

  const reconcile = async (): Promise<StoreCountSnapshot> => {
    try {
      const result = await query(GET_STORE_COUNT_SNAPSHOT_SPARQL, {
        source: 'daemon.metrics.storeCountReconcile',
        priority: 'background',
      });
      const row = result.bindings[0];
      if (!row) throw new Error('Store metrics reconciliation returned no binding');
      const value: StoreCountSnapshot = Object.freeze({
        totalTriples: parseRdfInt(row.totalTriples),
        totalKCs: parseRdfInt(row.totalKCs),
        totalKAs: parseRdfInt(row.totalKAs),
        confirmedKCs: parseRdfInt(row.confirmedKCs),
        tentativeKCs: parseRdfInt(row.tentativeKCs),
      });
      reconciled = { value, reconciledAt: now() };
      return value;
    } catch (error) {
      reconciled = null;
      throw error;
    }
  };

  const assertHealthy = async (): Promise<void> => {
    try {
      const result = await query(STORE_METRICS_HEALTH_SPARQL, {
        source: 'daemon.metrics.storeHealth',
        priority: 'health',
      });
      if (result.bindings[0]?.result !== 'true') {
        throw new Error('Store metrics health probe was denied');
      }
    } catch (error) {
      reconciled = null;
      throw error;
    }
  };

  const read = async (): Promise<StoreCountSnapshot> => {
    const current = reconciled;
    if (current === null) return reconcile();
    // The collector owns the 30-second request cache and in-flight
    // coalescing. Every cache miss validates the retained exact snapshot once.
    await assertHealthy();
    const refreshedAt = now();
    if (
      refreshedAt < current.reconciledAt
      || refreshedAt - current.reconciledAt >= reconcileIntervalMs
    ) {
      // The collector persists this result for up to a day, so the collection
      // that detects expiry must await the exact replacement rather than save
      // the previous snapshot and strand the refreshed value in memory.
      return reconcile();
    }
    return current.value;
  };

  return {
    getStoreCountSnapshot: read,
  };
}

function finiteInterval(value: number | undefined, fallback: number, label: string): number {
  const interval = value ?? fallback;
  if (!Number.isFinite(interval) || interval < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
  return interval;
}

type MetricSubscriptionCandidate = {
  onChainId?: string;
  onChainHash?: string;
  pendingMeta?: boolean;
  synced?: boolean;
  metaSynced?: boolean;
  sharedMemorySynced?: boolean;
  coreHosted?: boolean;
};
type MetricSubscriptionRecord = {
  id: string;
  onChainId?: string;
  onChainHash?: string;
};

const HASH_CONTEXT_GRAPH_ID_RE = /^0x[a-fA-F0-9]{64}$/;
const SYSTEM_CONTEXT_GRAPH_IDS = new Set<string>([
  SYSTEM_CONTEXT_GRAPHS.AGENTS,
  SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
]);
const NON_ROOT_DECLARATION_META_SEGMENTS = [
  '/_verifiable_memory/',
  '/_shared_memory_snapshots/',
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
  return null;
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
      && !NON_ROOT_DECLARATION_META_SEGMENTS.some((segment) => rest.includes(segment))
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
  const groupsByIdentity = new Map<string, Set<string>>();
  const groups: Set<string>[] = [];
  const recordsById = new Map<string, MetricSubscriptionRecord>();
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
      recordsById.set(id, {
        id,
        ...(sub.onChainId ? { onChainId: sub.onChainId } : {}),
        ...(sub.onChainHash ? { onChainHash: sub.onChainHash.toLowerCase() } : {}),
      });
      const identities = metricSubscriptionStableIdentities(id, sub);
      mergeMetricSubscriptionIdIntoGroup(id, identities, groups, groupsByIdentity);
    }
  }
  foldChainOnlyAliasesIntoWireGroups(groups, groupsByIdentity, recordsById);
  const selected: string[] = [];
  const shadows: string[] = [];
  for (const ids of groups) {
    const preferred = [...ids].reduce((current, candidate) =>
      shouldPreferMetricContextGraphId(candidate, current) ? candidate : current,
    );
    selected.push(preferred);
    for (const id of ids) {
      if (id !== preferred) shadows.push(id);
    }
  }
  return { selected, shadows };
}

function mergeMetricSubscriptionIdIntoGroup(
  id: string,
  identities: readonly string[],
  groups: Set<string>[],
  groupsByIdentity: Map<string, Set<string>>,
): Set<string> {
  const matchingGroups = [...new Set(
    identities
      .map((identity) => groupsByIdentity.get(identity))
      .filter((group): group is Set<string> => Boolean(group)),
  )];
  let group = matchingGroups[0];
  if (!group) {
    group = new Set<string>();
    groups.push(group);
  }
  for (const otherGroup of matchingGroups.slice(1)) {
    mergeMetricSubscriptionGroups(group, otherGroup, groups, groupsByIdentity);
  }
  group.add(id);
  for (const identity of identities) groupsByIdentity.set(identity, group);
  return group;
}

function mergeMetricSubscriptionGroups(
  target: Set<string>,
  source: Set<string>,
  groups: Set<string>[],
  groupsByIdentity: Map<string, Set<string>>,
): void {
  if (target === source) return;
  for (const otherId of source) target.add(otherId);
  const sourceIndex = groups.indexOf(source);
  if (sourceIndex >= 0) groups.splice(sourceIndex, 1);
  for (const [identity, group] of groupsByIdentity) {
    if (group === source) groupsByIdentity.set(identity, target);
  }
}

function foldChainOnlyAliasesIntoWireGroups(
  groups: Set<string>[],
  groupsByIdentity: Map<string, Set<string>>,
  recordsById: ReadonlyMap<string, MetricSubscriptionRecord>,
): void {
  const wireGroupsByChainId = new Map<string, Set<Set<string>>>();
  for (const group of groups) {
    for (const id of group) {
      const record = recordsById.get(id);
      if (!record?.onChainId || !record.onChainHash) continue;
      let chainGroups = wireGroupsByChainId.get(record.onChainId);
      if (!chainGroups) {
        chainGroups = new Set<Set<string>>();
        wireGroupsByChainId.set(record.onChainId, chainGroups);
      }
      chainGroups.add(group);
    }
  }

  for (const group of [...groups]) {
    if (![...group].every((id) => !recordsById.get(id)?.onChainHash)) continue;
    const chainIds = [...new Set(
      [...group]
        .map((id) => recordsById.get(id)?.onChainId)
        .filter((chainId): chainId is string => Boolean(chainId)),
    )];
    if (chainIds.length !== 1) continue;
    const wireGroups = wireGroupsByChainId.get(chainIds[0]);
    if (wireGroups?.size !== 1) continue;
    mergeMetricSubscriptionGroups([...wireGroups][0], group, groups, groupsByIdentity);
  }
}

function metricSubscriptionStableIdentities(
  id: string,
  sub: MetricSubscriptionCandidate,
): string[] {
  const identities: string[] = [];
  if (sub.onChainHash) identities.push(`wire:${sub.onChainHash.toLowerCase()}`);
  if (!sub.onChainHash && sub.onChainId) identities.push(`chain:${sub.onChainId}`);
  if (!sub.onChainHash && /^\d+$/.test(id)) identities.push(`chain:${id}`);
  if (identities.length === 0) identities.push(`local:${id}`);
  return identities;
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
