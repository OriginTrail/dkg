import { tryPruneLinkedRecordClosures, type TripleStore, type Quad } from '@origintrail-official/dkg-storage';
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
 * Extract the roots a record covers from its own quads — the single source of truth
 * for {@link insertBoundedAgentRegistryMeta}'s lock keys and prune scope (so neither
 * can drift from the inserted record). Every root a record encodes has a bare
 * `<recordUal> dkg:rootEntity <root>` member row, emitted per root by BOTH metadata
 * generators (`generateTentativeMetadata`/`generateConfirmedFullMetadata` →
 * `entityMemberQuads`), so filtering those captures exactly the record's roots.
 *
 * THROWS if the record encodes no such rows. On the agents path an empty root set
 * means the record has no lock/prune domain — taking no locks and pruning nothing
 * would SILENTLY opt out of the retention invariant this helper owns, so we fail
 * loudly (a programmer error / malformed record, caught before any write, like the
 * `recordUal`-subject guard). The accepted predicate is `dkg:rootEntity`
 * (DKG_ROOT_ENTITY_LEGACY) — the canonical bare-member predicate the generators emit.
 */
function deriveCoveredRootsOrThrow(recordUal: string, metadataQuads: Quad[]): string[] {
  const roots = [...new Set(
    metadataQuads
      .filter((q) => q.subject === recordUal && q.predicate === DKG_ROOT_ENTITY_LEGACY)
      .map((q) => q.object),
  )];
  if (roots.length === 0) {
    throw new Error(
      `insertBoundedAgentRegistryMeta: metadataQuads encode no <${recordUal}> ` +
        `<${DKG_ROOT_ENTITY_LEGACY}> <root> member rows — the record has no lock/prune domain`,
    );
  }
  return roots;
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
 * SINGLE SOURCE OF TRUTH (#1534 review): the lock keys and the prune scope are
 * DERIVED from `metadataQuads` (the roots the record actually encodes), NOT taken as
 * a parallel `rootEntities` argument. That makes it impossible for a caller to drift
 * the pruned/locked domain away from the inserted record — e.g. a caller that
 * pre-filters some roots out of the metadata could otherwise pass the wider,
 * unfiltered set and have the prune evict a root the record does not cover, zeroing
 * it (the invariant this bound protects).
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
  recordUal: string;
  metadataQuads: Quad[];
}): Promise<void> {
  const { store, contextGraphId, metaGraph, recordUal, metadataQuads } = opts;

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

  // Derive the roots THIS record covers from its own quads — the single source of
  // truth for the lock keys and the prune scope, so neither can drift from the
  // inserted record. Fails loudly if the record encodes no roots (see
  // {@link deriveCoveredRootsOrThrow}).
  const coveredRoots = deriveCoveredRootsOrThrow(recordUal, metadataQuads);

  // Serialize insert+prune per individual root, scoped to THIS store (see the note on
  // _agentMetaLocksByStore): any two writes sharing a root (identical OR overlapping
  // sets, e.g. {X} vs {X,Y}) serialize so they can't insert-then-prune each other down
  // to zero records; writes for disjoint roots stay concurrent. The locks span
  // insert→prune and are released only after the prune try/catch.
  const lockKeys = coveredRoots.map((root) => `${contextGraphId}:${root}`);
  await withKeyedLocks(agentMetaLocksFor(store), lockKeys, async () => {
    // Insert FIRST so a prune failure can never leave the agent with no record.
    // An insert failure PROPAGATES (caller aborts; nothing durable changed).
    await store.insert(metadataQuads);
    // The record is now durable, so a prune failure MUST NOT abort the caller's
    // downstream lifecycle registration — swallow it with a loud warn and let the
    // next heartbeat re-prune. `recordUal` protects the row we just wrote.
    try {
      await pruneSupersededAgentRegistryMeta({
        store, contextGraphId, metaGraph, rootEntities: coveredRoots, keepUal: recordUal,
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

  // Validate the requested roots with the canonical `sparqlIri` guard,
  // which THROWS on an unsafe IRI. An unsafe root is therefore an explicit
  // boundary, not a silent drop: we collect it and WARN (naming it) rather than
  // degrade the retention invariant without any signal.
  const rootIris: string[] = [];
  const droppedRoots: string[] = [];
  for (const root of new Set(rootEntities)) {
    try {
      sparqlIri(root);
      rootIris.push(root);
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

  // COUNT-FREE by construction: ONE bounded server-side prune, never a
  // per-record `deleteByPattern`/`deleteBySubjectPrefix` loop. On the production
  // Blazegraph/SparqlHttp backends those helpers bracket every delete with TWO
  // full-graph `countQuads` scans (blazegraph.ts deleteByPattern/
  // deleteBySubjectPrefix) — evicting an agent's backlog on the first heartbeat
  // would fan out into thousands of full-graph scans on the very cores this
  // change exists to relieve. A single UPDATE does the whole eviction inside the
  // store with no client round-trips or counts. The structured capability owns
  // escaping, admission, reserved-graph policy, changelog accounting, and
  // graph-set maintenance; callers never assemble executable SPARQL.
  //
  // `keepUal` protects a record (insert-first ordering). If it cannot be safely
  // embedded, pruning would delete the protected record, so SKIP the prune
  // (warn) rather than risk the loss. Absent `keepUal` ⇒ no protection (the
  // legacy prune-only contract).
  let safeKeepUal: string | undefined;
  if (keepUal !== undefined) {
    try {
      sparqlIri(keepUal);
      safeKeepUal = keepUal;
    } catch {
      log.warn(
        createOperationContext('system'),
        `agents/_meta bound: keepUal "${keepUal}" is not a safe IRI; skipping the prune for ` +
          `context graph "${contextGraphId}" to avoid deleting the protected record.`,
      );
      return;
    }
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
  const pruned = await tryPruneLinkedRecordClosures(
    store,
    {
      graphUri: metaGraph,
      matchObjectIris: rootIris,
      linkPredicates: [DKG_ROOT_ENTITY_LEGACY, DKG_ENTITY],
      recordParentPredicate: DKG_PART_OF,
      protectedRecordIri: safeKeepUal,
      descendantSeparator: '/',
    },
    { source: 'agent-registry-meta.prune' },
  );
  if (!pruned) {
    log.warn(
      createOperationContext('system'),
      `agents/_meta bound SKIPPED for context graph "${contextGraphId}": the triple store ` +
        `lacks structuredMutation() and update(); the agents-registry _meta graph will grow UNBOUNDED ` +
        `on this backend (#1233). Managed production stores expose this capability; this ` +
        `indicates a legacy or misconfigured store.`,
    );
  }
}
