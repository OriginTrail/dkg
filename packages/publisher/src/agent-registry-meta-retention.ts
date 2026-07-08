import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import {
  isAgentRegistryContextGraph,
  sparqlIri,
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
 * Insert a heartbeat's `_meta` tracking rows and THEN bound the agents-registry
 * `_meta` graph — the correct ordering for the invariant "an agent always has at
 * least one live record".
 *
 * The prune deletes the SAME agent's superseded prior records; running it BEFORE
 * the insert (the original #1233 shape) meant an insert failure after a
 * successful prune could leave the agent with NO record at all. Inserting FIRST
 * and passing `keepUal = the just-inserted UAL` flips the prune's
 * `FILTER(?record != keepUal)` from a defensive no-op into an active GUARANTEE
 * that the new record survives. Failure semantics improve accordingly: an insert
 * failure propagates with the prior record untouched (no loss); a prune failure
 * after a successful insert only degrades boundedness (the next heartbeat
 * re-prunes) — it never loses state.
 *
 * For non-agents CGs the prune is a no-op (see
 * {@link pruneSupersededAgentRegistryMeta}), so this is just the insert.
 */
export async function insertBoundedAgentRegistryMeta(opts: {
  store: TripleStore;
  contextGraphId: string;
  metaGraph: string;
  rootEntities: readonly string[];
  keepUal?: string;
  metadataQuads: Quad[];
}): Promise<void> {
  const { store, contextGraphId, metaGraph, rootEntities, keepUal, metadataQuads } = opts;
  // Insert FIRST so a prune failure can never leave the agent with no record.
  await store.insert(metadataQuads);
  // Then bound: evict this agent's superseded prior records. `keepUal` protects
  // the record we just inserted.
  await pruneSupersededAgentRegistryMeta({ store, contextGraphId, metaGraph, rootEntities, keepUal });
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
 * This evicts the PRIOR tracking rows for the SAME agent — matched on the member
 * entity (the stable agent DID that every heartbeat re-states, unlike the
 * per-heartbeat UAL) and resolved to the record ROOT so BOTH the collapsed
 * (`<ual>`) and legacy / multi-root (`<ual>/<n> dkg:partOf <ual>`) shapes are
 * removed wholesale. At most the newest record per agent survives, so the graph
 * stays bounded to O(agents) instead of O(agents × heartbeats).
 *
 * Prefer {@link insertBoundedAgentRegistryMeta} at call sites — it inserts first
 * so `keepUal` actively protects the live record. Calling this directly (prune
 * only) is for tests and advanced callers.
 *
 * No-op for every non-agents CG (full per-KA `_meta` history is preserved).
 *
 * @param opts.metaGraph the `_meta` graph to bound.
 * @param opts.rootEntities the root entities of the record being retained (the
 *   agent DID(s) for this heartbeat).
 * @param opts.keepUal the record to PROTECT from the prune (its UAL). With
 *   {@link insertBoundedAgentRegistryMeta} this is the just-inserted record, so
 *   the prune can never delete it. If it is not a safe IRI the prune is SKIPPED
 *   (warned) rather than risk deleting the protected record.
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

  // Build the `VALUES ?root { … }` list with the canonical `sparqlIri` guard,
  // which THROWS on an unsafe IRI. An unsafe root is therefore an explicit
  // boundary, not a silent drop: we collect it and WARN (naming it) rather than
  // degrade the retention invariant without any signal.
  const rootIris: string[] = [];
  const droppedRoots: string[] = [];
  for (const root of new Set(rootEntities)) {
    try {
      rootIris.push(sparqlIri(root));
    } catch {
      droppedRoots.push(root);
    }
  }
  if (droppedRoots.length > 0) {
    log.warn(
      createOperationContext('system'),
      `agents/_meta bound: skipped ${droppedRoots.length} unsafe root IRI(s) for context graph ` +
        `"${contextGraphId}" — those agents' superseded history was NOT pruned this pass: ` +
        `[${droppedRoots.join(', ')}]`,
    );
  }
  if (rootIris.length === 0) return;
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
    // Pruning IS required here (agents CG + non-empty roots), but the store
    // cannot run a server-side UPDATE. Do NOT silently skip — and do NOT throw
    // (a defensive bound must never break the publish path). WARN loudly so the
    // invariant violation is visible: every production + test backend implements
    // update(), so this means a misconfigured store and agents/_meta will grow
    // unbounded on it.
    log.warn(
      createOperationContext('system'),
      `agents/_meta bound SKIPPED for context graph "${contextGraphId}": the triple store ` +
        `lacks server-side update(); the agents-registry _meta graph will grow UNBOUNDED on ` +
        `this backend (#1233). Every production/test backend implements update() — this ` +
        `indicates a misconfigured store.`,
    );
    return;
  }

  // `keepUal` protects a record (insert-first ordering). If it cannot be safely
  // embedded, pruning would delete the protected record, so SKIP the prune
  // (warn) rather than risk the loss. Absent `keepUal` ⇒ no protection (the
  // legacy prune-only contract).
  let keepFilter = '';
  if (keepUal !== undefined) {
    let keepIri: string;
    try {
      keepIri = sparqlIri(keepUal);
    } catch {
      log.warn(
        createOperationContext('system'),
        `agents/_meta bound: keepUal "${keepUal}" is not a safe IRI; skipping the prune for ` +
          `context graph "${contextGraphId}" to avoid deleting the protected record.`,
      );
      return;
    }
    keepFilter = `FILTER(?record != ${keepIri})`;
  }

  // Resolve each matched MEMBER subject to its record ROOT before deleting. The
  // member can be the KC `<ual>` itself (collapsed shape) OR a `<ual>/<n>` token
  // subject (legacy / multi-root), which carries `dkg:partOf <ual>`. COALESCE the
  // partOf parent (when present) with the member, so BOTH shapes resolve to the
  // SAME record root `<ual>` and the DELETE removes the WHOLE record — the parent
  // status/merkleRoot/publishedAt rows AND the token subtree — instead of only
  // the token subtree (the legacy-shape leak, PR #1526 #1). Collapsed records
  // have no `partOf` self-edge (metadata.ts) so COALESCE → member = `<ual>`.
  // Read-both on the member predicate (`dkg:rootEntity` ‖ `dkg:entity`).
  const values = rootIris.join(' ');
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
