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
import { operationIdentityKey } from '../graph-scoped-swm-recovery.js';
import { isDecodableWorkspaceOperationRows } from '@origintrail-official/dkg-publisher';

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
  /**
   * GH#2273 — the head's single shareOperationId, or null when the head is
   * absent OR carries more than one distinct id. Non-null ONLY in the
   * unambiguous case, because its consumer is the prefer-local decision: a
   * queued VM-publish job froze this id at admission, and catch-up must not
   * replace it with a peer's equivalent id. SAMPLE over a multi-valued head
   * would be an arbitrary pick — exactly the failure this field exists to
   * prevent — so ambiguity reads as null and routes through repair instead.
   */
  shareOperationId: string | null;
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
  /**
   * GH#2273 — decide whether a head repair may PRESERVE a locally stored
   * operation identity instead of adopting the descriptor's. Returns the
   * winning stored id when every stored operation the head references (other
   * than the descriptor's own) is identity-equivalent to the descriptor's
   * operation (`operationIdentityKey` over the allow-list — content
   * commitment, access envelope, ownership); ties break to the
   * lexicographically smallest id for determinism. Returns null — descriptor
   * wins, exactly today's behavior — when there is no foreign stored id, when
   * any stored operation's rows are missing or non-equivalent, or when either
   * side's identity key is unprovable. Callers MUST hold the KA write lock.
   */
  selectRepairIdentity(
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<{
    winnerShareOperationId: string;
    /**
     * The descriptor rows every later write this round must withhold (the
     * losing head-id row). Returned WITH the decision so a caller holds the
     * complete plan in one value — deciding and withholding cannot be
     * separated by a forgotten second lookup.
     */
    withholdRows: readonly Quad[];
  } | null>;
  /**
   * GH#2273 — repair a (possibly multi-valued) head to certify the WINNER
   * identity chosen by `selectRepairIdentity`, deleting every other operation
   * subject the head references (same kaUal ownership guard as
   * `replaceHeadMetadata`) while NEVER deleting the winner's operation rows —
   * they are the only durable copy of the identity a queued VM-publish job
   * may reference. The head subject is rewritten (delete + insert of the
   * descriptor's head rows with the operation-id row swapped to the winner).
   * Crash window: between the head delete and re-insert the head is absent
   * with the winner's operation intact; the next round's absent-head repair
   * then installs the DESCRIPTOR identity — accepted residual, identical in
   * shape to today's window, and it self-converges.
   */
  repairHeadPreservingIdentity(
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
    winnerShareOperationId: string,
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

  /**
   * The ONE discovery of which operation subjects a head references AND this
   * KA owns — the most delicate half of every head cleanup. Both the plain
   * replacement and the identity-preserving repair consume it, so the
   * subject format, the ownership ASK and any future deletion guard cannot
   * drift between the two paths. `excludeShareOperationId` spares a
   * preserved winner; `seed` pre-admits subjects the caller already owns
   * (the descriptor's own operation).
   */
  const collectOwnedHeadOperationSubjects = async (
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
    options: { seed?: readonly string[]; excludeShareOperationId?: string },
  ): Promise<Set<string>> => {
    const shareIds = await deps.store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
      + `<${assertSafeIri(descriptor.headSubject)}> <${DKG}shareOperationId> ?op } }`,
      { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.findOperations' },
    );
    const subjects = new Set<string>(options.seed ?? []);
    if (shareIds.type === 'bindings') {
      for (const row of shareIds.bindings) {
        const shareId = literalValue(row?.['op']);
        if (!shareId || shareId === options.excludeShareOperationId) continue;
        const candidate = `urn:dkg:share:${contextGraphId}:${shareId}`;
        if (subjects.has(candidate)) continue;
        const ownedByThisKa = await deps.store.query(
          `ASK { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
          + `<${assertSafeIri(candidate)}> <${DKG}kaUal> <${assertSafeIri(descriptor.kaUal)}> } }`,
          { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.checkOperation' },
        );
        if (ownedByThisKa.type === 'boolean' && ownedByThisKa.value) {
          subjects.add(candidate);
        }
      }
    }
    return subjects;
  };

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
        + `(COUNT(DISTINCT ?op) AS ?operations) (SAMPLE(?op) AS ?anyOp) WHERE { `
        + `GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
        + `<${assertSafeIri(descriptor.headSubject)}> `
        + `<${DKG}assertionVersion> ?v ; `
        + `<${DKG}shareOperationId> ?op } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.readStoredHead' },
      );
      if (result.type !== 'bindings' || result.bindings.length === 0) {
        return { version: null, needsRepair: false, shareOperationId: null };
      }
      const row = result.bindings[0];
      const version = literalValue(row?.['maxVersion']);
      const versions = parseCount(row?.['versions']);
      const operations = parseCount(row?.['operations']);
      // SAMPLE is deterministic only when there is exactly one distinct id;
      // with more, ANY pick would be arbitrary, so the id reads as null and
      // `needsRepair` routes the decision through repair instead.
      const sampledOperationId = literalValue(row?.['anyOp']);
      return {
        version: version && version.length > 0 ? version : null,
        needsRepair: versions > 1 || operations > 1,
        shareOperationId:
          operations === 1 && sampledOperationId && sampledOperationId.length > 0
            ? sampledOperationId
            : null,
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
      const operationSubjects = await collectOwnedHeadOperationSubjects(contextGraphId, descriptor, {
        seed: [descriptor.operationSubject],
      });
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

    selectRepairIdentity: async (contextGraphId, descriptor) => {
      const shareIds = await deps.store.query(
        `SELECT DISTINCT ?op WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
        + `<${assertSafeIri(descriptor.headSubject)}> <${DKG}shareOperationId> ?op } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.selectRepairIdentity' },
      );
      if (shareIds.type !== 'bindings') return null;
      const foreignIds = [...new Set(
        shareIds.bindings
          .map((row) => literalValue(row?.['op']))
          .filter((id): id is string => Boolean(id && id.length > 0)),
      )].filter((id) => id !== descriptor.shareOperationId).sort();
      if (foreignIds.length === 0) return null;
      const descriptorKey = operationIdentityKey(
        descriptor.metadataQuads.filter((quad) => quad.subject === descriptor.operationSubject),
      );
      if (descriptorKey === null) return null;
      // ONE bounded query loads every candidate operation's rows via the
      // head join (mirrors the resolver's acquisition): candidate identity,
      // ownership and rows are then validated over the in-memory model
      // instead of a per-candidate ASK/read fan-out under the lock.
      const candidateRows = await deps.store.query(
        `SELECT ?op ?p ?o WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
        + `<${assertSafeIri(descriptor.headSubject)}> <${DKG}shareOperationId> ?id . `
        + `?op <${DKG}shareOperationId> ?id ; ?p ?o } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.loadCandidates' },
      );
      if (candidateRows.type !== 'bindings') return null;
      const rowsBySubject = new Map<string, Quad[]>();
      for (const row of candidateRows.bindings) {
        const subject = row['op'] ?? '';
        if (!subject) continue;
        const list = rowsBySubject.get(subject) ?? [];
        list.push({
          subject,
          predicate: row['p'] ?? '',
          object: row['o'] ?? '',
          graph: descriptor.metaGraph,
        });
        rowsBySubject.set(subject, list);
      }
      for (const foreignId of foreignIds) {
        const operationSubject = `urn:dkg:share:${contextGraphId}:${foreignId}`;
        const storedRows = rowsBySubject.get(operationSubject) ?? [];
        if (storedRows.length === 0) return null;
        // A foreign KA's operation, a policy change, a different digest or a
        // different author all surface here as a key mismatch (kaUal and the
        // whole envelope are inside the key), which routes to descriptor-wins
        // — today's behavior, and the correct one for a GENUINE change.
        const storedKey = operationIdentityKey(storedRows);
        if (storedKey === null || storedKey !== descriptorKey) return null;
        // Identity equivalence is NECESSARY but not SUFFICIENT to preserve:
        // the key deliberately excludes per-node rows, so a stored operation
        // can be key-equal yet one the READER CONTRACT rejects. Preserving
        // such a winner would write a head the resolver permanently fails as
        // corrupt (and re-preserve it every round — the wedge shape), or one
        // the sync responder cannot serve to peers. The gate is layered:
        // the head resolver's own decoder (exported by the publisher, so it
        // cannot drift), the published-head wrapper's stamp rule, the
        // responder-join type row, and snapshot-locator coherence.
        if (!isDecodableWorkspaceOperationRows(storedRows, {
          kaUal: descriptor.kaUal,
          assertionVersion: descriptor.assertionVersion,
          shareOperationId: foreignId,
          requirePublishedAt: true,
        })) return null;
        if (!storedRows.some((row) =>
          row.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
          && row.object === `${DKG}WorkspaceOperation`)) return null;
        // Snapshot LOCATOR coherence — outside both the identity key (the
        // graph-form locator embeds the operation id) and the head decoder
        // (which never consumes snapshot pointers). Count is only the cheap
        // pre-gate: a stale same-size graph passes it, so the CONTENT digest
        // must equal the committed public digest — the same count-then-digest
        // ladder `isGraphAssetMaterialized` uses for the assertion graph.
        // Ref-form (or absent) locators are content-addressed — no worse
        // than the descriptor's own — and pass.
        const snapshotGraphs = [...new Set(storedRows
          .filter((row) => row.predicate === `${DKG}publicSnapshotGraph`)
          .map((row) => row.object))];
        if (snapshotGraphs.length > 1) return null;
        if (snapshotGraphs.length === 1) {
          const snapshotRefs = storedRows
            .filter((row) => row.predicate === `${DKG}publicSnapshotRef`);
          if (snapshotRefs.length > 0) return null;
          const snapshotContent = await deps.store.query(
            `SELECT ?s ?p ?o WHERE { GRAPH <${assertSafeIri(snapshotGraphs[0]!)}> { ?s ?p ?o } }`,
            { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.checkWinnerSnapshot' },
          );
          if (snapshotContent.type !== 'bindings') return null;
          if (snapshotContent.bindings.length !== descriptor.publicQuadsCount) return null;
          const digest = workspacePublicQuadsDigest(snapshotContent.bindings.map((row) => ({
            subject: row['s'] ?? '',
            predicate: row['p'] ?? '',
            object: row['o'] ?? '',
            graph: '',
          })));
          if (digest !== descriptor.publicQuadsDigest) return null;
        }
      }
      return {
        winnerShareOperationId: foreignIds[0]!,
        withholdRows: descriptor.metadataQuads.filter((quad) =>
          quad.subject === descriptor.headSubject
          && quad.predicate === `${DKG}shareOperationId`),
      };
    },

    repairHeadPreservingIdentity: async (contextGraphId, descriptor, winnerShareOperationId) => {
      const loserSubjects = await collectOwnedHeadOperationSubjects(contextGraphId, descriptor, {
        seed: descriptor.shareOperationId !== winnerShareOperationId
          ? [descriptor.operationSubject]
          : [],
        excludeShareOperationId: winnerShareOperationId,
      });
      // ORDER MATTERS: rewrite the head FIRST, delete the losers AFTER. A
      // crash between the two then leaves a HEALTHY single-valued head plus
      // stale loser operation subjects — benign residue (they are
      // identity-equivalent by the selection above, and nothing references
      // them). The reverse order would leave a still-multi-valued head naming
      // operations whose rows are already gone: readers fail closed on a
      // state that is only half repaired.
      //
      // Head rows: the descriptor's own four non-id rows are byte-identical to
      // what the winner's head must carry (identity equivalence pins kaUal and
      // assertionVersion; contentScopeVersion is constant; assertionGraph is
      // derived from UAL + version), so only the operation-id row is swapped.
      const headRows = descriptor.metadataQuads
        .filter((quad) => quad.subject === descriptor.headSubject)
        .map((quad) => quad.predicate === `${DKG}shareOperationId`
          ? { ...quad, object: JSON.stringify(winnerShareOperationId) }
          : { ...quad });
      await deps.store.deleteByPattern(
        { graph: descriptor.metaGraph, subject: descriptor.headSubject },
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.deleteHead' },
      );
      await deps.store.insert(headRows, {
        priority: 'background',
        source: 'agent.sharedMemorySync.snapshotMaterializer.writePreservedHead',
      });
      for (const operationSubject of loserSubjects) {
        await deps.store.deleteByPattern(
          { graph: descriptor.metaGraph, subject: operationSubject },
          { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.deleteOperation' },
        );
      }
      deps.invalidateListContextGraphsCache();
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
