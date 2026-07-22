/**
 * Public SWM catch-up snapshot MATERIALIZATION — the behavior that turns a
 * verified immutable snapshot into a stored per-KA assertion graph.
 *
 * Drives the real `runSharedMemorySync` with crafted graph-scoped meta (the
 * verifier is injected, so `processSharedMemoryBatch` returns it as verified)
 * and asserts the DECISIONS around the destructive `replaceGraph`:
 *
 *   1. a held-out node materializes a cached snapshot into the store
 *   2. the race with live gossip is closed: catch-up blocks on the SAME
 *      per-KA write lock (real `withKeyedLocks` + `swmKaWriteLockKey`, shared
 *      map), and the in-lock version re-check skips when gossip advanced the
 *      KA while catch-up waited — replace is never called
 *   3. the pre-fix broken state (head marker present, graph never written)
 *      is HEALED, because the materialized-check is content-based
 *   4. an already-materialized asset is left alone
 *   5. a failed replace keeps the phase incomplete and WITHHOLDS the meta
 *      insert, so a marker can never certify a graph that was not written
 *   6. after a replace, the stale head metadata is swapped out BEFORE the
 *      fresh verified meta is appended (graph → head swap → meta ordering)
 *   7. a KA under a REGISTERED subgraph is materialized too — dropping the
 *      subgraph admission pass-through must fail these tests
 *   8. a node with NO cached snapshot fetches it over the network
 *      (phase === 'snapshot') and still materializes it
 *
 * Case 2 is deterministic without sleeps: the test holds the real lock, which
 * IS the pause; catch-up's own lock acquisition is the sync point.
 *
 * These are decision tests: the materializer is injected so each guard answer
 * is scripted. The REAL store-backed materializer implementation (SPARQL
 * count/digest guard, MAX head read, head-metadata swap) is covered against a
 * real OxigraphStore in `swm-snapshot-materializer.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  generateKnowledgeAssetShareMetadata,
  workspacePublicQuadsDigest,
  withKeyedLocks,
  swmKaWriteLockKey,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import type { StoredWorkspaceHeadState } from '../src/sync/requester/swm-snapshot-materializer.js';

const CG = 'ws00-snapshot-materialization';
const WS = contextGraphWorkspaceGraphUri(CG);
const WS_META = contextGraphWorkspaceMetaGraphUri(CG);
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const UAL = 'did:dkg:hardhat:31337/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/7';
const ctx: OperationContext = { operationId: 'test', operationName: 'sync' } as never;

class MemorySnapshotStore implements WorkspacePublicSnapshotStore {
  readonly snapshots = new Map<string, Quad[]>();
  async putSnapshot(input: { readonly digest: string; readonly quads: readonly Quad[] }) {
    this.snapshots.set(input.digest, input.quads.map((quad) => ({ ...quad })));
    return { ref: input.digest, byteLength: 0 };
  }
  async getSnapshot(ref: string): Promise<Quad[] | null> {
    return this.snapshots.get(ref)?.map((quad) => ({ ...quad })) ?? null;
  }
}

function page(quads: Quad[], completed = true): SyncPageResult {
  return { quads, bytesReceived: 0, resumedFromOffset: 0, nextOffset: quads.length, checkpointKey: 'k', completed, timedOut: false };
}

/** One graph-scoped KA share: payload + the meta the strict parser demands. */
function fixture(subGraphName?: string) {
  const scope = createGraphKnowledgeAssetScope(UAL, 1);
  const metaGraph = subGraphName
    ? `did:dkg:context-graph:${CG}/${subGraphName}/_shared_memory_meta`
    : WS_META;
  const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope, subGraphName);
  const operationId = 'snapshot-materialization-op';
  const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
  const headSubject = `${UAL}#dkg-swm-head`;
  const payload: Quad[] = [
    { subject: 'urn:snap:a', predicate: 'http://schema.org/status', object: '"held-out"', graph: '' },
    { subject: 'urn:snap:b', predicate: 'http://schema.org/status', object: '"held-out"', graph: '' },
  ];
  const digest = workspacePublicQuadsDigest(payload);
  const meta: Quad[] = [
    ...generateKnowledgeAssetShareMetadata({
      shareOperationId: operationId,
      contextGraphId: CG,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: payload.length,
      privateTripleCount: 0,
      publisherPeerId: 'peer-source',
      timestamp: new Date(0),
      ...(subGraphName ? { subGraphName } : {}),
    }, metaGraph),
    { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: metaGraph },
    { subject: operationSubject, predicate: `${DKG}publicSnapshotRef`, object: `"${digest}"`, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: metaGraph },
  ];
  return { payload, digest, meta, metaGraph, assertionGraph };
}

interface HarnessOverrides {
  storedHead?: () => StoredWorkspaceHeadState;
  contentPresent?: () => boolean;
  replaceImpl?: (graphUri: string, quads: Quad[]) => Promise<void>;
  onLockRequested?: () => void;
  lockMap?: Map<string, Promise<void>>;
  subGraphName?: string;
  /** Skip the snapshot-store preseed to force the network (phase='snapshot') fetch. */
  preseedSnapshot?: boolean;
}

function harness(overrides: HarnessOverrides = {}) {
  const fx = fixture(overrides.subGraphName);
  const snapshotStore = new MemorySnapshotStore();
  const events: string[] = [];
  const replaced: Array<{ graphUri: string; quads: Quad[] }> = [];
  const headSwaps: Array<{ contextGraphId: string; headSubject: string }> = [];
  const inserted: Quad[][] = [];
  const snapshotFetches: string[] = [];
  const lockMap = overrides.lockMap ?? new Map<string, Promise<void>>();

  const run = async () => {
    // Snapshot pre-seeded (default): the CACHE path fires onSnapshotReady
    // without any network fetch — the same shape as a node whose earlier
    // broken runs already cached the blobs (`swm-public-snapshots/`) without
    // writing them. `preseedSnapshot: false` starts cold instead, so the
    // snapshot must travel through the phase === 'snapshot' network fetch.
    if (overrides.preseedSnapshot !== false) {
      await snapshotStore.putSnapshot({ digest: fx.digest, quads: fx.payload });
    }
    return runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphIds: [CG],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase, _g, _dl, snapshotRef): Promise<SyncPageResult> => {
        if (phase === 'meta') return page(fx.meta);
        if (phase === 'snapshot') {
          events.push('snapshot-fetched');
          snapshotFetches.push(String(snapshotRef));
          return page(fx.payload.map((quad) => ({ ...quad })));
        }
        return page([]);
      },
      processSharedMemoryBatch: async (wsDataQuads, wsMetaQuads) => ({
        verifiedData: wsDataQuads,
        verifiedMeta: wsMetaQuads,
        totalFetchedDataQuads: wsDataQuads.length,
        totalFetchedMetaQuads: wsMetaQuads.length,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      ...(overrides.subGraphName
        ? {
            getRegisteredSubGraphNames: async () => [overrides.subGraphName!],
            getExcludedSubGraphNames: async () => [],
          }
        : {}),
      ensureContextGraph: async () => {},
      storeInsert: async (quads) => {
        events.push('meta-inserted');
        inserted.push(quads);
      },
      snapshotMaterializer: {
        withKaWriteLock: (contextGraphId, subGraphName, kaUal, fn) => {
          events.push('lock-requested');
          overrides.onLockRequested?.();
          return withKeyedLocks(lockMap, [swmKaWriteLockKey(contextGraphId, subGraphName, kaUal)], fn);
        },
        isGraphAssetMaterialized: async () => {
          events.push('content-checked');
          return overrides.contentPresent?.() ?? false;
        },
        readStoredHead: async () => {
          events.push('version-read');
          return overrides.storedHead?.() ?? { version: null, needsRepair: false };
        },
        replaceGraph: async (graphUri, quads) => {
          events.push('replaced');
          if (overrides.replaceImpl) return overrides.replaceImpl(graphUri, quads);
          replaced.push({ graphUri, quads });
        },
        replaceHeadMetadata: async (contextGraphId, descriptor) => {
          events.push('head-swapped');
          headSwaps.push({ contextGraphId, headSubject: descriptor.headSubject });
        },
      },
      publicSnapshotStore: snapshotStore,
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });
  };
  return { fx, run, events, replaced, headSwaps, inserted, snapshotFetches, lockMap };
}

describe('public SWM snapshot materialization', () => {
  it('materializes a cached snapshot into the assertion graph for a held-out node', async () => {
    const h = harness();
    const summary = await h.run();
    expect(h.replaced).toHaveLength(1);
    expect(h.replaced[0]!.graphUri).toBe(h.fx.assertionGraph);
    expect(h.replaced[0]!.quads).toHaveLength(h.fx.payload.length);
    expect(h.replaced[0]!.quads.every((q) => q.graph === h.fx.assertionGraph)).toBe(true);
    // Counted as DATA progress, not metadata-only.
    expect(summary.insertedDataTriples).toBeGreaterThanOrEqual(h.fx.payload.length);
    expect(summary.failedPhases).toBe(0);
    // Meta made it to the store: the phase was usable.
    expect(h.inserted.some((batch) => batch.some((q) => q.graph === WS_META))).toBe(true);
  });

  it('swaps the stale head metadata after the replace and BEFORE the meta append', async () => {
    // The meta insert below is append/union-style: without the head swap the
    // old and new version rows stack on one subject and LIMIT-1 readers
    // (`resolveKnowledgeAssetWorkspaceHead`) can return either — the stale
    // head bug. Ordering matters both ways: graph before swap (a crash leaves
    // repairable content, never a head without content), swap before append
    // (the fresh rows land on a clean subject).
    const h = harness({ storedHead: () => ({ version: '1', needsRepair: false }), contentPresent: () => false });
    await h.run();
    expect(h.events.indexOf('replaced')).toBeGreaterThan(-1);
    expect(h.events.indexOf('head-swapped')).toBeGreaterThan(h.events.indexOf('replaced'));
    expect(h.events.indexOf('meta-inserted')).toBeGreaterThan(h.events.indexOf('head-swapped'));
    expect(h.headSwaps).toEqual([{ contextGraphId: CG, headSubject: `${UAL}#dkg-swm-head` }]);
  });

  it('closes the gossip race: in-lock version re-check skips a superseded snapshot', async () => {
    // "Gossip" = an external holder of the REAL lock, same map, same key
    // derivation. Holding it is the deterministic pause; no timing involved.
    const lockMap = new Map<string, Promise<void>>();
    let releaseGossip!: () => void;
    const gossipDone = new Promise<void>((r) => { releaseGossip = r; });
    let storedVersion: string | null = null;
    let sawLockRequest!: () => void;
    const lockRequested = new Promise<void>((r) => { sawLockRequest = r; });

    const h = harness({
      lockMap,
      storedHead: () => ({ version: storedVersion, needsRepair: false }),
      onLockRequested: () => sawLockRequest(),
    });

    // Gossip enters first and holds the per-KA critical section.
    const gossipHold = withKeyedLocks(
      lockMap,
      // Checksummed-case UAL on purpose: the shared key helper lowercases, so
      // a case difference between gossip's UAL and the descriptor's must still
      // serialize on ONE key. An under-merged key would let this test pass
      // vacuously with no contention at all.
      [swmKaWriteLockKey(CG, undefined, UAL.toUpperCase().replace('DID:DKG:HARDHAT', 'did:dkg:hardhat'))],
      async () => { await gossipDone; },
    );

    const syncPromise = h.run();
    await lockRequested;               // catch-up has asked for the lock…
    storedVersion = '2';               // …gossip commits version 2 meanwhile…
    h.events.push('gossip-committed');
    releaseGossip();                   // …and leaves the critical section.
    const summary = await syncPromise;
    await gossipHold;

    // Catch-up proceeded only after gossip, saw the newer stored version, and
    // never touched the graph or the head. A skip is not a failure.
    expect(h.events.indexOf('gossip-committed')).toBeGreaterThan(h.events.indexOf('lock-requested'));
    expect(h.events.indexOf('version-read')).toBeGreaterThan(h.events.indexOf('gossip-committed'));
    expect(h.events).not.toContain('replaced');
    expect(h.events).not.toContain('head-swapped');
    expect(summary.failedPhases).toBe(0);
  });

  it('heals the pre-fix broken state: marker present, graph never written', async () => {
    // storedHead equals the descriptor (the marker exists) but the content
    // check reports absent — a marker-based guard would skip forever; the
    // content-based guard repairs.
    const h = harness({ storedHead: () => ({ version: '1', needsRepair: false }), contentPresent: () => false });
    await h.run();
    expect(h.replaced).toHaveLength(1);
    expect(h.replaced[0]!.graphUri).toBe(h.fx.assertionGraph);
  });

  it('leaves an already-materialized asset alone', async () => {
    const h = harness({ storedHead: () => ({ version: '1', needsRepair: false }), contentPresent: () => true });
    const summary = await h.run();
    expect(h.events).toContain('content-checked');
    expect(h.events).not.toContain('replaced');
    expect(h.events).not.toContain('head-swapped');
    expect(summary.failedPhases).toBe(0);
  });

  it('collapses union-insert residue on the skip path when the head needs repair', async () => {
    // Content already matches the descriptor, but the head subject carries
    // several version/operation rows (e.g. a prior round failed between the
    // replace and the head swap). The skip must still swap the head, or the
    // ambiguity becomes permanent — every later round skips on content.
    const h = harness({ storedHead: () => ({ version: '1', needsRepair: true }), contentPresent: () => true });
    const summary = await h.run();
    expect(h.events).not.toContain('replaced');
    expect(h.events).toContain('head-swapped');
    expect(h.events.indexOf('meta-inserted')).toBeGreaterThan(h.events.indexOf('head-swapped'));
    expect(summary.failedPhases).toBe(0);
  });

  it('withholds the meta insert when a replace fails, and marks the phase failed', async () => {
    const h = harness({ replaceImpl: async () => { throw new Error('store unavailable'); } });
    const summary = await h.run();
    expect(summary.failedPhases).toBe(1);
    // No meta batch reached the store: a head marker must never certify an
    // assertion graph that was not written, or the next pass would classify
    // the asset as materialized and strand it permanently.
    expect(h.inserted.every((batch) => batch.every((q) => q.graph !== WS_META))).toBe(true);
  });

  it('materializes a KA under a REGISTERED subgraph into its subgraph assertion graph', async () => {
    // The parser rejects heads in unregistered metadata graphs; without the
    // registered/excluded pass-through in the parse call, this fixture throws,
    // the catch clears ALL descriptors, and the snapshot is cached but never
    // written — silently, for the whole context graph.
    const h = harness({ subGraphName: 'notes' });
    const summary = await h.run();
    expect(h.fx.metaGraph).toBe(`did:dkg:context-graph:${CG}/notes/_shared_memory_meta`);
    expect(h.replaced).toHaveLength(1);
    expect(h.replaced[0]!.graphUri).toBe(h.fx.assertionGraph);
    expect(h.fx.assertionGraph).toContain('/notes/');
    expect(summary.failedPhases).toBe(0);
    // The subgraph's meta landed too.
    expect(h.inserted.some((batch) => batch.some((q) => q.graph === h.fx.metaGraph))).toBe(true);
  });

  it('fetches an uncached snapshot over the network and materializes it', async () => {
    // Cold node: nothing in the snapshot store, so onSnapshotReady must fire
    // from the phase === 'snapshot' NETWORK branch after digest verification.
    const h = harness({ preseedSnapshot: false });
    const summary = await h.run();
    expect(h.snapshotFetches).toEqual([h.fx.digest]);
    expect(h.events.indexOf('replaced')).toBeGreaterThan(h.events.indexOf('snapshot-fetched'));
    expect(h.replaced).toHaveLength(1);
    expect(h.replaced[0]!.graphUri).toBe(h.fx.assertionGraph);
    expect(summary.failedPhases).toBe(0);
    expect(h.inserted.some((batch) => batch.some((q) => q.graph === WS_META))).toBe(true);
  });

  it('withholds the meta insert when the replace fails AFTER a network fetch', async () => {
    const h = harness({
      preseedSnapshot: false,
      replaceImpl: async () => { throw new Error('store unavailable'); },
    });
    const summary = await h.run();
    expect(h.events).toContain('snapshot-fetched');
    expect(summary.failedPhases).toBe(1);
    expect(h.inserted.every((batch) => batch.every((q) => q.graph !== WS_META))).toBe(true);
  });
});
