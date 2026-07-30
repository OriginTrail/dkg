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
  resolveKnowledgeAssetWorkspaceHead,
  sameKnowledgeAssetWorkspaceHead,
  swmKaWriteLockKey,
  withKeyedLocks,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import { FINALIZED_SWM_CLEANUP_ROOT_PREDICATE } from '../../dkg-agent-constants.js';

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
   * Replace the KA's head rows and every share-operation subject its head
   * references from fresh verified metadata. This is the catch-up lane's
   * counterpart of gossip's delete-then-insert
   * (`storeKnowledgeAssetWorkspaceHead`) and the private recovery lane's
   * `replaceMetaForGraphAssets`: without it the append-style meta insert stacks
   * old and new head rows on one subject and the durable current head becomes
   * ambiguous.
   */
  replaceHeadMetadata(
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<void>;
}

/**
 * Replace one graph-scoped SWM lifecycle without losing a local deferred
 * finalization token for the exact same lifecycle.
 *
 * Finalization markers are deliberately local-only and responders filter them
 * from synchronized metadata. A blind head/operation replacement therefore
 * erased the only durable evidence that the retained SWM graph was eligible
 * for idle cleanup. Preserve both marker rows only when the complete local
 * workspace head still equals the verified incoming descriptor; any mismatch
 * means a newer or otherwise different lifecycle and fails closed by dropping
 * the old markers.
 *
 * The verified replacement metadata and any retained cleanup markers are
 * inserted in the same store call after the old lifecycle is removed. Callers
 * MUST hold the canonical per-KA SWM writer lock across this entire operation.
 */
export async function replaceGraphScopedSwmHeadMetadata(params: {
  store: TripleStore;
  contextGraphId: string;
  descriptor: GraphScopedSwmRecoveryDescriptor;
  sourcePrefix: string;
}): Promise<void> {
  const { store, contextGraphId, descriptor, sourcePrefix } = params;
  const preservedMarkers = await readExactFinalizedCleanupMarkers({
    store,
    contextGraphId,
    descriptor,
    sourcePrefix,
  });

  // Collect every share operation the head currently references — via the
  // BOUND head subject, then per-candidate bound-subject ASKs. The kaUal guard
  // prevents a corrupt cross-KA reference from deleting another KA's metadata.
  const shareIds = await store.query(
    `SELECT DISTINCT ?op WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
    + `<${assertSafeIri(descriptor.headSubject)}> <${DKG}shareOperationId> ?op } }`,
    { priority: 'background', source: `${sourcePrefix}.findOperations` },
  );
  const operationSubjects = new Set<string>([descriptor.operationSubject]);
  if (shareIds.type === 'bindings') {
    for (const row of shareIds.bindings) {
      const shareId = literalValue(row?.['op']);
      if (!shareId) continue;
      const candidate = `urn:dkg:share:${contextGraphId}:${shareId}`;
      if (operationSubjects.has(candidate)) continue;
      const ownedByThisKa = await store.query(
        `ASK { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
        + `<${assertSafeIri(candidate)}> <${DKG}kaUal> <${assertSafeIri(descriptor.kaUal)}> } }`,
        { priority: 'background', source: `${sourcePrefix}.checkOperation` },
      );
      if (ownedByThisKa.type === 'boolean' && ownedByThisKa.value) {
        operationSubjects.add(candidate);
      }
    }
  }

  await store.deleteByPattern(
    { graph: descriptor.metaGraph, subject: descriptor.headSubject },
    { priority: 'background', source: `${sourcePrefix}.deleteHead` },
  );
  for (const operationSubject of operationSubjects) {
    await store.deleteByPattern(
      { graph: descriptor.metaGraph, subject: operationSubject },
      { priority: 'background', source: `${sourcePrefix}.deleteOperation` },
    );
  }
  const replacementQuads = [
    ...descriptor.metadataQuads,
    ...preservedMarkers,
  ];
  if (replacementQuads.length > 0) {
    await store.insert(replacementQuads, {
      priority: 'background',
      source: `${sourcePrefix}.insertReplacementMetadata`,
    });
  }
}

async function readExactFinalizedCleanupMarkers(params: {
  store: TripleStore;
  contextGraphId: string;
  descriptor: GraphScopedSwmRecoveryDescriptor;
  sourcePrefix: string;
}): Promise<Quad[]> {
  const { store, contextGraphId, descriptor, sourcePrefix } = params;
  try {
    const currentHead = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId,
      kaUal: descriptor.kaUal,
      subGraphName: descriptor.subGraphName,
      queryOptions: {
        priority: 'background',
        source: `${sourcePrefix}.readFinalizedCleanupHead`,
      },
    });
    if (!currentHead || !sameKnowledgeAssetWorkspaceHead(currentHead, {
      kaUal: descriptor.kaUal,
      assertionVersion: descriptor.assertionVersion,
      assertionGraph: descriptor.assertionGraph,
      publicQuadsDigest: descriptor.publicQuadsDigest,
      publicTripleCount: descriptor.publicQuadsCount,
      privateMerkleRoot: descriptor.privateMerkleRoot,
      privateTripleCount: descriptor.privateTripleCount,
      shareOperationId: descriptor.shareOperationId,
      publisherPeerId: descriptor.publisherPeerId,
      accessPolicy: descriptor.accessPolicy,
      allowedPeers: [...descriptor.allowedPeers],
    })) {
      return [];
    }
  } catch {
    // Corrupt or incomplete local metadata must never carry a destructive
    // cleanup token into a verified replacement.
    return [];
  }

  const markerResult = await store.query(
    `CONSTRUCT { ?subject <${FINALIZED_SWM_CLEANUP_ROOT_PREDICATE}> ?root } WHERE { `
    + `GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
    + `VALUES ?subject { <${assertSafeIri(descriptor.headSubject)}> `
    + `<${assertSafeIri(descriptor.operationSubject)}> } `
    + `?subject <${FINALIZED_SWM_CLEANUP_ROOT_PREDICATE}> ?root } }`,
    {
      priority: 'background',
      source: `${sourcePrefix}.readFinalizedCleanupMarkers`,
    },
  );
  if (markerResult.type !== 'quads') return [];
  const markers = markerResult.quads.map((quad) => ({
    ...quad,
    graph: descriptor.metaGraph,
  }));
  const headMarkers = markers.filter((quad) => quad.subject === descriptor.headSubject);
  const operationMarkers = markers.filter((quad) => quad.subject === descriptor.operationSubject);
  if (
    headMarkers.length !== 1
    || operationMarkers.length !== 1
    || headMarkers[0]!.object !== operationMarkers[0]!.object
  ) {
    return [];
  }
  return [headMarkers[0]!, operationMarkers[0]!];
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
      return workspacePublicQuadsDigest(stored) === descriptor.publicQuadsDigest;
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
      deps.invalidateListContextGraphsCache();
    },

    replaceHeadMetadata: async (contextGraphId, descriptor) => {
      await replaceGraphScopedSwmHeadMetadata({
        store: deps.store,
        contextGraphId,
        descriptor,
        sourcePrefix: 'agent.sharedMemorySync.snapshotMaterializer',
      });
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
