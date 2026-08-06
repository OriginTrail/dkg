/**
 * The store adapter behind public SWM catch-up snapshot materialization.
 *
 * This module OWNS the persistence policy for turning a verified graph-scoped
 * snapshot into durable store state: what "already materialized" means, how
 * the stored head version is read, how stale head metadata is replaced, and
 * which lock serializes it all against live gossip. `runSharedMemorySync`
 * consumes it as one cohesive dependency (see `SharedMemorySnapshotMaterializer`);
 * `dkg-agent-lifecycle` is reduced to wiring agent-owned resources into
 * `createSharedMemorySnapshotMaterializer`.
 *
 * Every SPARQL read/write here is scoped to an exact per-KA IRI (the head
 * subject, the operation subject, or the KA's own assertion graph), so each
 * query is bounded by one KA's size — never by context-graph or fleet growth.
 */
import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  swmKaWriteLockKey,
  withKeyedLocks,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  invalidateSwmMaterializationWitness,
  readSwmMaterializationWitness,
  writeSwmMaterializationWitness,
} from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';

const DKG = 'http://dkg.io/ontology/';

/** What the local store currently records on one KA's SWM head subject. */
export interface StoredWorkspaceHeadState {
  /**
   * The NEWEST assertionVersion on the head subject (MAX, not an arbitrary
   * binding), or null when no version/operation row pair exists. MAX matters
   * because the append-style meta insert can leave several version rows on one
   * subject; reading an arbitrary one would let an older row veto — or worse,
   * authorize — a replace decision.
   */
  version: string | null;
  /**
   * True when the head subject carries rows from more than one assertion
   * version or share operation — the residue a union-style meta insert leaves
   * behind. Such a head is ambiguous for LIMIT-1 readers
   * (`resolveKnowledgeAssetWorkspaceHead`) and must be collapsed back to
   * exactly one version's rows via `replaceHeadMetadata`.
   */
  needsRepair: boolean;
}

/**
 * Everything `runSharedMemorySync` needs to MATERIALIZE verified public SWM
 * snapshots into the triple store, as ONE cohesive dependency.
 *
 * Why one object: these capabilities are only meaningful together. An earlier
 * revision exposed them as independent optionals, which allowed a silent
 * half-configured mode — a caller supplying the snapshot store but not the
 * guard would compile fine and quietly skip materialization. Absent entirely
 * => materialization is skipped (never half-applied).
 */
export interface SharedMemorySnapshotMaterializer {
  /**
   * Serialize against the live-gossip write path for one KA. MUST take the
   * same key on the same lock map SharedMemoryHandler uses (the agent owns
   * the map; the key comes from the shared `swmKaWriteLockKey`). Without it
   * this interleaving destroys data: catch-up observes the graph absent →
   * gossip commits a richer version → catch-up replaces it with the older
   * snapshot.
   */
  withKaWriteLock<T>(
    contextGraphId: string,
    subGraphName: string | undefined,
    kaUal: string,
    fn: () => Promise<T>,
  ): Promise<T>;
  /**
   * Read the KA's stored head state (newest version + ambiguity flag). Read
   * INSIDE the lock: a lock prevents interleaving but not overwriting-with-
   * older, and gossip may have committed a newer version while catch-up
   * waited.
   */
  readStoredHead(descriptor: GraphScopedSwmRecoveryDescriptor): Promise<StoredWorkspaceHeadState>;
  /**
   * True only when the KA's assertion graph CONTENT equals the descriptor's:
   * same quad count AND same public-quads digest. A marker-only predicate
   * re-reports the pre-fix broken state (head metadata written, graph never
   * written) as materialized; a count-only predicate cannot tell two versions
   * of equal size apart and would skip a verified newer snapshot.
   */
  isGraphAssetMaterialized(descriptor: GraphScopedSwmRecoveryDescriptor): Promise<boolean>;
  /**
   * Atomic whole-graph replace. Replace, not insert: a KA graph is
   * all-or-nothing and digest-verified; union-insert risks partial or
   * duplicated state across retries.
   */
  replaceGraph(graphUri: string, quads: Quad[]): Promise<void>;
  /**
   * Delete the KA's head rows and every share-operation subject its head
   * references (including the descriptor's own, which the caller re-inserts
   * from fresh verified metadata). This is the catch-up lane's counterpart of
   * gossip's delete-then-insert (`storeKnowledgeAssetWorkspaceHead`) and the
   * private recovery lane's `replaceMetaForGraphAssets`: without it the
   * append-style meta insert stacks old and new head rows on one subject and
   * the durable current head becomes ambiguous.
   */
  replaceHeadMetadata(
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<void>;
}

/**
 * Build the production materializer over the agent's own store, lock map and
 * list-cache invalidation hook.
 */
export function createSharedMemorySnapshotMaterializer(deps: {
  store: TripleStore;
  /**
   * The SAME map injected into SharedMemoryHandler — sharing the map (and the
   * key helper) is what closes the check-then-replace race with gossip.
   */
  writeLocks: Map<string, Promise<void>>;
  invalidateListContextGraphsCache: () => void;
}): SharedMemorySnapshotMaterializer {
  // #2079 operator override, default ON. Blank is UNSET, not false:
  // `DKG_SWM_MATERIALIZATION_WITNESS=` is the normal compose/.env shape for
  // "not configured", and reading it as false would silently disable the memo
  // for a fleet that never asked. Read inside the factory rather than at module
  // scope so it takes effect on the next sync round after a restart.
  //
  // There is deliberately NO capability probe here. An earlier revision tested
  // `typeof deps.store.replaceSubject !== 'function'`, on the theory that
  // `sparql-http` with `atomicUpdates:false` could never hold a witness and
  // would otherwise pay the ASK forever. BOTH halves were false:
  //
  //   - every adapter and all three decorators DEFINE `replaceSubject` and
  //     throw `UnsupportedTripleStoreCapabilityError` INSIDE it, so the typeof
  //     is always "function" — the probe could never fire;
  //   - that config gates `replaceGraph` on the same `atomicUpdates` flag, so
  //     no writer can populate a SWM assertion graph at all. The graph stays
  //     empty, the count gate returns first, and the ASK is never reached.
  //     There was no cost to avoid.
  //
  // A latch on the first `false` from the write is the shape that WOULD work,
  // but not as currently wired: that call is `.catch(() => false)`, so a
  // transient endpoint error is indistinguishable from a capability refusal and
  // would disable the memo process-wide on a blip.
  const witnessUsable = (() => {
    const raw = process.env['DKG_SWM_MATERIALIZATION_WITNESS']?.trim();
    if (!raw) return true;
    return raw !== '0' && raw.toLowerCase() !== 'false';
  })();

  return {
    withKaWriteLock: (contextGraphId, subGraphName, kaUal, fn) =>
      withKeyedLocks(deps.writeLocks, [swmKaWriteLockKey(contextGraphId, subGraphName, kaUal)], fn),

    readStoredHead: async (descriptor) => {
      // Aggregates over ONE bound subject in the KA's meta graph: bounded by
      // that subject's row count. COUNT(DISTINCT …) doubles as the duplicate
      // detector — more than one version or operation value on the head is the
      // union-insert residue that must be repaired.
      const result = await deps.store.query(
        `SELECT (MAX(?v) AS ?maxVersion) (COUNT(DISTINCT ?v) AS ?versions) `
        + `(COUNT(DISTINCT ?op) AS ?operations) WHERE { `
        + `GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
        + `<${assertSafeIri(descriptor.headSubject)}> `
        + `<${DKG}assertionVersion> ?v ; `
        + `<${DKG}shareOperationId> ?op } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.readStoredHead' },
      );
      if (result.type !== 'bindings' || result.bindings.length === 0) {
        return { version: null, needsRepair: false };
      }
      const row = result.bindings[0];
      const version = literalValue(row?.['maxVersion']);
      const versions = parseCount(row?.['versions']);
      const operations = parseCount(row?.['operations']);
      return {
        version: version && version.length > 0 ? version : null,
        needsRepair: versions > 1 || operations > 1,
      };
    },

    isGraphAssetMaterialized: async (descriptor) => {
      const expected = descriptor.publicQuadsCount;
      if (!Number.isSafeInteger(expected) || expected <= 0) return false;
      // 1) Count gate: exact-IRI scope, so bounded — and cheap enough to run
      // every round. Strictly equal: a short graph is a partial write and must
      // be replaced, not treated as already materialized.
      const countResult = await deps.store.query(
        `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${assertSafeIri(descriptor.assertionGraph)}> { ?s ?p ?o } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.countGraph' },
      );
      if (countResult.type !== 'bindings' || countResult.bindings.length === 0) return false;
      const present = Number.parseInt(literalValue(countResult.bindings[0]?.['n']) ?? '0', 10);
      if (!Number.isFinite(present) || present !== expected) return false;
      // 1b) Witness fast path (#2079): a bound-subject ASK recording that THIS
      // node already read this graph back and matched this exact digest. It is
      // a memo of the measurement in step 2 — never an independent claim — so
      // it is only reachable in a state where step 2 would also return true.
      //
      // Deliberately AFTER the count gate, not instead of it. Three paths
      // remove an assertion graph outside this lock — the SWM TTL sweep, VM
      // promote/publish/update (a different lock map), and the chain-reset
      // wipe, whose scoped delete spares `urn:dkg:local:*` and so leaves the
      // witness standing over a wiped store. The count catches all three for
      // free. Measured, also skipping the count buys a further 1.5–10.5%,
      // which is not worth trading self-healing for. Do not reorder these.
      if (
        witnessUsable
        && await readSwmMaterializationWitness(
          deps.store,
          descriptor.assertionGraph,
          descriptor.publicQuadsDigest,
          { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.witnessAsk' },
        )
      ) {
        return true;
      }
      // 2) Content binding: a matching count does not prove the stored graph
      // is THIS descriptor's content — all versions of a graph-scoped KA share
      // one graph URI, so an older version of equal size would otherwise pass
      // and the verified newer snapshot would be skipped forever. Reading the
      // graph back only runs when the count already matches, so it is bounded
      // by exactly the snapshot size we would otherwise write; the digest is
      // the same store-roundtrip check `resolveWorkspaceOperation` relies on.
      const contentResult = await deps.store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(descriptor.assertionGraph)}> { ?s ?p ?o } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.readGraph' },
      );
      if (contentResult.type !== 'quads') return false;
      const stored = contentResult.quads.map((quad) => ({ ...quad, graph: '' }));
      const matches = workspacePublicQuadsDigest(stored) === descriptor.publicQuadsDigest;
      if (matches && witnessUsable) {
        // Written HERE — from the branch that just computed the digest over
        // this node's own store content and matched it — and nowhere else.
        // That is what makes the witness sound: it cannot record anything a
        // peer asserted, and there is no crash window in which a witness
        // exists for content that was never verified, because the content was
        // read before this line runs.
        //
        // Best-effort: a failed or unsupported write costs one recomputation
        // next round, so it must never fail the check that just succeeded.
        await writeSwmMaterializationWitness(
          deps.store,
          descriptor.assertionGraph,
          descriptor.publicQuadsDigest,

          { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.witnessWrite' },
        ).catch(() => false);
      }
      return matches;
    },

    replaceGraph: async (graphUri, quads) => {
      // Deliberately NOT routed through the sync lane's guarded union insert:
      // a KA graph is all-or-nothing and digest-verified, so it must land via
      // the atomic replace or not at all.
      if (typeof deps.store.replaceGraph !== 'function') {
        throw new Error('triple store does not support atomic graph replace');
      }
      await deps.store.replaceGraph(graphUri, quads, {
        priority: 'background',
        source: 'agent.sharedMemorySync.materializeSnapshot',
      });
      // #2079: the content just changed, so any witness for it now describes
      // bytes that are gone. Defence in depth, NOT the thing that makes an
      // equal-count replace safe — be precise about this, because the
      // difference decides whether the read may ever stop binding the digest.
      //
      // What actually makes v1 → v2 safe is that the witness READ binds the
      // digest as well as the subject: a standing v1 row cannot match an ASK
      // for v2's digest, so the check falls through to the CONSTRUCT and the
      // write then evicts v1 atomically. That holds with or without this call,
      // and it is the property the tests pin.
      //
      // Where the digest binding does NOT cover, and this call is the only
      // cover: witness(v1) + content(v2) + a descriptor still naming v1. The
      // binding protects the (old witness, new descriptor) direction; it does
      // nothing for (old witness, old descriptor, new content), because there
      // the ASK's digest and the witness's digest agree while the store has
      // moved on. That asymmetry is why this is not merely hygiene.
      //
      // It is nevertheless BEST EFFORT — `.catch` below — so the residual is
      // real rather than zero: a swallowed failure, or a crash between the
      // replace and this line, reaches exactly that state. It is bounded by the
      // count gate whenever the replace also changed the quad count, and by the
      // next successful verify otherwise. Ordering is after the replace because
      // invalidating first would drop a still-valid memo on a replace that then
      // throws; neither order removes the window.
      await invalidateSwmMaterializationWitness(deps.store, graphUri, {
        priority: 'background',
        source: 'agent.sharedMemorySync.materializeSnapshot.witnessInvalidate',
      }).catch(() => {});
      deps.invalidateListContextGraphsCache();
    },

    replaceHeadMetadata: async (contextGraphId, descriptor) => {
      // Collect every share operation the head currently references — via the
      // BOUND head subject, then per-candidate bound-subject ASKs, so no query
      // scans the meta bucket. The kaUal guard mirrors the recovery lane's
      // `replaceMetaForGraphAssets` join: a head row pointing at another KA's
      // operation must not delete that KA's metadata.
      const shareIds = await deps.store.query(
        `SELECT DISTINCT ?op WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
        + `<${assertSafeIri(descriptor.headSubject)}> <${DKG}shareOperationId> ?op } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.findOperations' },
      );
      const operationSubjects = new Set<string>([descriptor.operationSubject]);
      if (shareIds.type === 'bindings') {
        for (const row of shareIds.bindings) {
          const shareId = literalValue(row?.['op']);
          if (!shareId) continue;
          const candidate = `urn:dkg:share:${contextGraphId}:${shareId}`;
          if (operationSubjects.has(candidate)) continue;
          const ownedByThisKa = await deps.store.query(
            `ASK { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
            + `<${assertSafeIri(candidate)}> <${DKG}kaUal> <${assertSafeIri(descriptor.kaUal)}> } }`,
            { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.checkOperation' },
          );
          if (ownedByThisKa.type === 'boolean' && ownedByThisKa.value) {
            operationSubjects.add(candidate);
          }
        }
      }
      await deps.store.deleteByPattern(
        { graph: descriptor.metaGraph, subject: descriptor.headSubject },
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.deleteHead' },
      );
      for (const operationSubject of operationSubjects) {
        await deps.store.deleteByPattern(
          { graph: descriptor.metaGraph, subject: operationSubject },
          { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.deleteOperation' },
        );
      }
    },
  };
}

/** Strip the lexical value out of an N-Triples-style literal binding. */
function literalValue(binding: string | undefined): string | undefined {
  if (binding === undefined) return undefined;
  const literal = /^"([^"]*)"/.exec(binding);
  return literal ? literal[1] : binding;
}

function parseCount(binding: string | undefined): number {
  const parsed = Number.parseInt(literalValue(binding) ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
