import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import {
  isAgentRegistryContextGraph,
  sparqlIri,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  Logger,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { withKeyedLocks } from './keyed-lock.js';

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

// Per-INDIVIDUAL-root serialization (#1533/#1534 review). Two concurrent
// agents/_meta writes whose root sets INTERSECT each insert a fresh record and then
// prune "every record for these roots but mine" — and
// `pruneSupersededAgentRegistryMeta` deletes by ANY matching member root, not by the
// root-set shape. Run UNSERIALIZED they delete each other's just-inserted record and
// a shared root ends with ZERO `_meta` rows. So we serialize at the SAME granularity
// as the prune's blast radius (one lock key per individual root) via the gate-based
// {@link withKeyedLocks} helper: writes sharing a root serialize, writes over
// disjoint roots stay concurrent. Per-root — not the incidental single-root heartbeat
// shape — because the direct-protocol receive handler does not enforce singleton
// agents-CG writes.
//
// The lock domain is scoped PER STORE (not module-global): two independent handlers
// backed by different `TripleStore`s must not falsely serialize on a shared agents
// root, and test/runtime isolation must not depend on hidden global state. A WeakMap
// lets a discarded store's locks be GC'd. In production there is a single main store,
// so this is behaviour-identical — the scoping just removes the hidden coupling.
const _agentMetaLocksByStore = new WeakMap<TripleStore, Map<string, Promise<void>>>();

function agentMetaLocksFor(store: TripleStore): Map<string, Promise<void>> {
  let locks = _agentMetaLocksByStore.get(store);
  if (!locks) {
    locks = new Map<string, Promise<void>>();
    _agentMetaLocksByStore.set(store, locks);
  }
  return locks;
}

/**
 * Insert a heartbeat's `_meta` tracking rows and THEN bound the agents-registry
 * `_meta` graph — the correct ordering for the invariant "an agent always has at
 * least one live record".
 *
 * The prune deletes the SAME agent's superseded prior records; running it BEFORE
 * the insert (the original #1233 shape) meant an insert failure after a
 * successful prune could leave the agent with NO record at all. Inserting FIRST
 * and passing `recordUal` = the just-inserted UAL flips the prune's
 * `FILTER(?record != recordUal)` from a defensive no-op into an active GUARANTEE
 * that the new record survives.
 *
 * Failure semantics are asymmetric BY DESIGN (#1533):
 *   - INSERT failure → PROPAGATES. It happens before the prune and nothing
 *     durable changed, so the caller correctly aborts (e.g. rejects the ACK).
 *   - PRUNE failure AFTER a successful insert → SWALLOWED (loud warn), NOT
 *     propagated. The record is already durably inserted, so the caller MUST
 *     still run its downstream lifecycle registration
 *     (`pendingPublishes`/`expireTentativePublish`). Letting a transient prune
 *     error bubble up would reject the ACK and orphan the tentative publish (its
 *     timeout cleanup never registers). Boundedness is only degraded for one
 *     round; the next heartbeat re-prunes.
 *
 * Concurrency: calls are serialized per individual root (a per-process mutex) so
 * two writes sharing any root — identical OR overlapping sets — can't
 * insert-then-prune each other down to zero records; writes for disjoint roots run
 * concurrently.
 *
 * For non-agents CGs the prune is a no-op (see
 * {@link pruneSupersededAgentRegistryMeta}), so this is just the insert.
 *
 * @param opts.recordUal REQUIRED — the UAL of the record in `metadataQuads`. It
 *   is both the record being inserted and the one protected from the prune, so
 *   it MUST be a subject of `metadataQuads`; this is ENFORCED (throws) on the
 *   agents path, because a drift (insert A, protect B) would let the prune delete
 *   the just-inserted record.
 */
export async function insertBoundedAgentRegistryMeta(opts: {
  store: TripleStore;
  contextGraphId: string;
  metaGraph: string;
  rootEntities: readonly string[];
  recordUal: string;
  metadataQuads: Quad[];
}): Promise<void> {
  const { store, contextGraphId, metaGraph, rootEntities, recordUal, metadataQuads } = opts;

  // Non-agents CGs never prune (see pruneSupersededAgentRegistryMeta), so there
  // is no self-deletion race and no protected-record contract — just insert.
  if (!isAgentRegistryContextGraph(contextGraphId)) {
    await store.insert(metadataQuads);
    return;
  }

  // Programmer-error boundary (#1533): `recordUal` is the record the prune
  // protects, so it MUST be the record we're inserting. A drift (insert A, protect
  // B) would let the prune delete the just-inserted A. Fail loudly rather than
  // silently corrupt. (Agents path only — non-agents don't prune.)
  if (!metadataQuads.some((q) => q.subject === recordUal)) {
    throw new Error(
      `insertBoundedAgentRegistryMeta: recordUal <${recordUal}> is not a subject of metadataQuads`,
    );
  }

  // Serialize insert+prune per individual root, scoped to THIS store (see the note on
  // _agentMetaLocksByStore): any two writes sharing a root (identical OR overlapping
  // sets, e.g. {X} vs {X,Y}) serialize so they can't insert-then-prune each other down
  // to zero records; writes for disjoint roots stay concurrent. The locks span
  // insert→prune and are released only after the prune try/catch.
  const lockKeys = rootEntities.map((root) => `${contextGraphId}:${root}`);
  await withKeyedLocks(agentMetaLocksFor(store), lockKeys, async () => {
    // Insert FIRST so a prune failure can never leave the agent with no record.
    // An insert failure PROPAGATES (caller aborts; nothing durable changed).
    await store.insert(metadataQuads);
    // The record is now durable, so a prune failure MUST NOT abort the caller's
    // downstream lifecycle registration — swallow it with a loud warn and let the
    // next heartbeat re-prune. `recordUal` protects the row we just wrote.
    try {
      await pruneSupersededAgentRegistryMeta({
        store, contextGraphId, metaGraph, rootEntities, keepUal: recordUal,
      });
    } catch (err) {
      log.warn(
        createOperationContext('system'),
        `agents/_meta bound skipped this round for context graph "${contextGraphId}": the prune ` +
          `failed after a successful insert (${err instanceof Error ? err.message : String(err)}). ` +
          `The record is live; boundedness is degraded for one round — the next heartbeat re-prunes.`,
      );
    }
  });
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
