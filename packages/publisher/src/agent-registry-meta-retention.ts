import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  isAgentRegistryContextGraph,
  isSafeIri,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  Logger,
  createOperationContext,
} from '@origintrail-official/dkg-core';

const log = new Logger('AgentRegistryMetaRetention');

// `dkg:partOf` — the SAME IRI `metadata.ts` emits on legacy / multi-root token
// subjects (`<ual>/<n> dkg:partOf <ual>`). Used here to resolve a matched member
// subject back to its record ROOT (the KC `<ual>`).
const DKG_PART_OF = 'http://dkg.io/ontology/partOf';

/**
 * Reject SPARQL-structure-breaking characters before a graph IRI is embedded in
 * a `GRAPH <...>` clause. Local copy of the guard in `metadata.ts` so this
 * module stays self-contained (metadata.ts is now pure quad generation).
 */
function assertSafeGraphIriForSparql(graphIri: string): void {
  if (/[<>"{}|^`\\\s]/.test(graphIri)) {
    throw new Error(`Unsafe graph IRI for SPARQL query: "${graphIri}"`);
  }
}

/**
 * #1233 follow-up — BOUND the agents-registry `_meta` graph at the load-bearing
 * write sites that #1234 deliberately did NOT skip.
 *
 * The `agents` system context graph never registers on-chain, so its per-publish
 * tentative `_meta` tracking record is never superseded by a confirm and never
 * naturally rotates: every agent heartbeat mints a FRESH `<ual>` and would append
 * a whole new record-set, growing `agents/_meta` without bound (the residual half
 * of #1233). The two highest-volume paths (local publish terminal + gossip
 * receiver) are write-skipped in #1234; the remaining paths are load-bearing —
 * they drive the tentative→confirm/expire lifecycle and prior-root cleanup, so a
 * blanket skip would desync that state machine (`packages/core/src/genesis.ts`
 * §isAgentRegistryContextGraph). They therefore PRUNE instead of skipping.
 *
 * Before the caller inserts a heartbeat's fresh tracking rows, this evicts the
 * PRIOR tracking rows for the SAME agent — matched on the member entity (the
 * stable agent DID that every heartbeat re-states, unlike the per-heartbeat UAL)
 * and resolved to the record ROOT so BOTH the collapsed (`<ual>`) and legacy /
 * multi-root (`<ual>/<n> dkg:partOf <ual>`) shapes are removed wholesale. At most
 * the newest record per agent survives, so the graph stays bounded to O(agents)
 * instead of O(agents × heartbeats). That surviving record IS the live tentative
 * record the lifecycle needs — only already-superseded history is removed, so
 * tentative→confirm/expire is unaffected.
 *
 * No-op for every non-agents CG (full per-KA `_meta` history is preserved).
 *
 * @param opts.metaGraph the `_meta` graph the caller is about to write into.
 * @param opts.rootEntities the root entities of the record about to be inserted
 *   (the agent DID(s) for this heartbeat).
 * @param opts.keepUal the current heartbeat's UAL — never pruned (defensive; it
 *   is normally not yet present because the prune runs before the insert).
 */
export async function pruneSupersededAgentRegistryMeta(opts: {
  store: TripleStore;
  contextGraphId: string;
  metaGraph: string;
  rootEntities: readonly string[];
  keepUal?: string;
}): Promise<void> {
  const { store, contextGraphId, metaGraph, rootEntities, keepUal } = opts;
  if (!isAgentRegistryContextGraph(contextGraphId)) return;
  const safeRoots = [...new Set(rootEntities)].filter(isSafeIri);
  if (safeRoots.length === 0) return;
  assertSafeGraphIriForSparql(metaGraph);

  // COUNT-FREE by construction: ONE server-side SPARQL `DELETE … WHERE`, never a
  // per-record `deleteByPattern`/`deleteBySubjectPrefix` loop. On the production
  // Blazegraph/SparqlHttp backends those helpers bracket every delete with TWO
  // full-graph `countQuads` scans (blazegraph.ts deleteByPattern/
  // deleteBySubjectPrefix) — evicting an agent's backlog on the first heartbeat
  // would fan out into thousands of full-graph scans on the very cores this
  // change exists to relieve. A single UPDATE does the whole eviction inside the
  // store with no client round-trips or counts. Same "bail if the backend can't
  // do server-side UPDATE" contract as the RS heal (dkg-agent-swm-host.ts
  // healStrandedScopedKCs); every production + test backend implements it.
  const storeUpdate = store.update;
  if (typeof storeUpdate !== 'function') {
    // We have already decided pruning IS required here (agents CG + non-empty
    // roots), but the store cannot run a server-side UPDATE. Do NOT silently
    // skip — and do NOT throw (a defensive bound must never break the publish
    // path). WARN loudly so the invariant violation is visible: every
    // production + test backend implements update(), so this means a
    // misconfigured store, and agents/_meta will grow unbounded on it.
    log.warn(
      createOperationContext('system'),
      `agents/_meta bound SKIPPED for context graph "${contextGraphId}": the triple store ` +
        `lacks server-side update(); the agents-registry _meta graph will grow UNBOUNDED on ` +
        `this backend (#1233). Every production/test backend implements update() — this ` +
        `indicates a misconfigured store.`,
    );
    return;
  }

  // Resolve each matched MEMBER subject to its record ROOT before deleting. The
  // member can be the KC `<ual>` itself (collapsed shape) OR a `<ual>/<n>` token
  // subject (legacy / multi-root), which carries `dkg:partOf <ual>`. COALESCE the
  // partOf parent (when present) with the member, so BOTH shapes resolve to the
  // SAME record root `<ual>` and the DELETE removes the WHOLE record — the parent
  // status/merkleRoot/publishedAt rows AND the token subtree — instead of only
  // the token subtree (the legacy-shape leak, PR #1526 #1). Collapsed records
  // have no `partOf` self-edge (metadata.ts) so COALESCE → member = `<ual>`.
  // Read-both on the member predicate (`dkg:rootEntity` ‖ `dkg:entity`). keepUal
  // is compared against the resolved RECORD (defensive: it is normally not yet
  // present — this runs before the insert); an unsafe/absent keepUal drops the
  // FILTER (harmless — the current record isn't in the graph at prune time).
  const values = safeRoots.map((r) => `<${r}>`).join(' ');
  const safeKeepUal = keepUal && isSafeIri(keepUal) ? keepUal : undefined;
  const keepFilter = safeKeepUal ? `FILTER(?record != <${safeKeepUal}>)` : '';
  const sparql = `DELETE { GRAPH <${metaGraph}> { ?s ?p ?o } }
WHERE { GRAPH <${metaGraph}> {
  VALUES ?root { ${values} }
  { ?member <${DKG_ROOT_ENTITY_LEGACY}> ?root } UNION { ?member <${DKG_ENTITY}> ?root }
  OPTIONAL { ?member <${DKG_PART_OF}> ?parent }
  BIND(COALESCE(?parent, ?member) AS ?record)
  ${keepFilter}
  ?s ?p ?o .
  FILTER(?s = ?record || STRSTARTS(STR(?s), CONCAT(STR(?record), "/")))
} }`;
  await storeUpdate.call(store, sparql);
}
