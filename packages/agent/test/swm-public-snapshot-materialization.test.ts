/**
 * Public SWM catch-up snapshot MATERIALIZATION — the behavior that turns a
 * verified, cached immutable snapshot into a stored per-KA assertion graph.
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
 *
 * Case 2 is deterministic without sleeps: the test holds the real lock, which
 * IS the pause; catch-up's own lock acquisition is the sync point.
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
  return { quads, bytesReceived: 0, resumedFromOffset: 0, nextOffset: quads.length, checkpointKey: 'k', completed };
}

/** One graph-scoped KA share: payload + the meta the strict parser demands. */
function fixture() {
  const scope = createGraphKnowledgeAssetScope(UAL, 1);
  const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
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
    }, WS_META),
    { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: WS_META },
    { subject: operationSubject, predicate: `${DKG}publicSnapshotRef`, object: `"${digest}"`, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: WS_META },
  ];
  return { payload, digest, meta, assertionGraph };
}

interface HarnessOverrides {
  storedVersion?: () => string | null;
  contentPresent?: () => boolean;
  replaceImpl?: (graphUri: string, quads: Quad[]) => Promise<void>;
  onLockRequested?: () => void;
  lockMap?: Map<string, Promise<void>>;
}

function harness(overrides: HarnessOverrides = {}) {
  const fx = fixture();
  const snapshotStore = new MemorySnapshotStore();
  const events: string[] = [];
  const replaced: Array<{ graphUri: string; quads: Quad[] }> = [];
  const inserted: Quad[][] = [];
  const lockMap = overrides.lockMap ?? new Map<string, Promise<void>>();

  const run = async () => {
    // Snapshot pre-seeded: the CACHE path fires onSnapshotReady without any
    // network fetch — the same shape as a node whose earlier broken runs
    // already cached the blobs (`swm-public-snapshots/`) without writing them.
    await snapshotStore.putSnapshot({ digest: fx.digest, quads: fx.payload });
    return runSharedMemorySync({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphIds: [CG],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase): Promise<SyncPageResult> =>
        phase === 'meta' ? page(fx.meta) : page([]),
      processSharedMemoryBatch: async (wsDataQuads, wsMetaQuads) => ({
        verifiedData: wsDataQuads,
        verifiedMeta: wsMetaQuads,
        totalFetchedDataQuads: wsDataQuads.length,
        totalFetchedMetaQuads: wsMetaQuads.length,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      ensureContextGraph: async () => {},
      storeInsert: async (quads) => { inserted.push(quads); },
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
        readStoredAssertionVersion: async () => {
          events.push('version-read');
          return overrides.storedVersion?.() ?? null;
        },
        replaceGraph: async (graphUri, quads) => {
          events.push('replaced');
          if (overrides.replaceImpl) return overrides.replaceImpl(graphUri, quads);
          replaced.push({ graphUri, quads });
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
  return { fx, run, events, replaced, inserted, lockMap };
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
      storedVersion: () => storedVersion,
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
    // never touched the graph. A skip is not a failure.
    expect(h.events.indexOf('gossip-committed')).toBeGreaterThan(h.events.indexOf('lock-requested'));
    expect(h.events.indexOf('version-read')).toBeGreaterThan(h.events.indexOf('gossip-committed'));
    expect(h.events).not.toContain('replaced');
    expect(summary.failedPhases).toBe(0);
  });

  it('heals the pre-fix broken state: marker present, graph never written', async () => {
    // storedVersion equals the descriptor (the marker exists) but the content
    // check reports absent — a marker-based guard would skip forever; the
    // content-based guard repairs.
    const h = harness({ storedVersion: () => '1', contentPresent: () => false });
    await h.run();
    expect(h.replaced).toHaveLength(1);
    expect(h.replaced[0]!.graphUri).toBe(h.fx.assertionGraph);
  });

  it('leaves an already-materialized asset alone', async () => {
    const h = harness({ storedVersion: () => '1', contentPresent: () => true });
    const summary = await h.run();
    expect(h.events).toContain('content-checked');
    expect(h.events).not.toContain('replaced');
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
});
