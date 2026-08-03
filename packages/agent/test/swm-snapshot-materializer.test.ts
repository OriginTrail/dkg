/**
 * The REAL store-backed snapshot materializer, against a REAL OxigraphStore —
 * no injected guard answers. This is what proves the production lifecycle
 * wiring, not just `runSharedMemorySync`'s decisions around it:
 *
 *   - `isGraphAssetMaterialized` is CONTENT-based: the pre-fix broken state
 *     (head marker written, assertion graph never written) reads as NOT
 *     materialized; a short graph reads as NOT materialized; and — the
 *     count-only trap — an equal-count graph holding an OLDER version's
 *     content reads as NOT materialized because the digest differs.
 *   - `readStoredHead` returns the NEWEST version (MAX) when append-style
 *     meta inserts left several version rows on one head subject, and flags
 *     that residue for repair.
 *   - `replaceHeadMetadata` collapses the head to a clean subject: old head
 *     rows and every operation the head referenced are deleted, other
 *     subjects (and other KAs' operations) are untouched.
 *   - end-to-end: a node holding version 1 (same quad COUNT as version 2)
 *     catches up to version 2 — the graph is replaced, exactly one head
 *     version remains, and the LIMIT-1 production reader
 *     (`resolveKnowledgeAssetWorkspaceHead`) resolves version 2 instead of an
 *     ambiguous mix. A second round is a pure no-op, which also proves the
 *     digest survives the store round-trip (no churn).
 */
import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphWorkspaceMetaGraphUri,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  generateKnowledgeAssetShareMetadata,
  resolveKnowledgeAssetWorkspaceHead,
  workspacePublicQuadsDigest,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { createSharedMemorySnapshotCommitter } from '../src/sync/requester/swm-snapshot-committer.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const CG = 'ws00-materializer-real-store';
const WS_META = contextGraphWorkspaceMetaGraphUri(CG);
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const UAL = 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/9';
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

/**
 * One complete graph-scoped share (head + operation meta, payload, digest)
 * for `UAL` at `version`. v1 and v2 payloads deliberately have the SAME quad
 * count with different content: only a digest-binding guard can tell them
 * apart.
 */
function share(version: number, operationId: string, marker: string) {
  const scope = createGraphKnowledgeAssetScope(UAL, version);
  const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
  const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
  const headSubject = `${UAL}#dkg-swm-head`;
  const payload: Quad[] = [
    { subject: 'urn:snap:a', predicate: 'http://schema.org/status', object: `"${marker}"`, graph: '' },
    { subject: 'urn:snap:b', predicate: 'http://schema.org/status', object: `"${marker}"`, graph: '' },
  ];
  const digest = workspacePublicQuadsDigest(payload);
  const meta: Quad[] = [
    ...generateKnowledgeAssetShareMetadata({
      shareOperationId: operationId,
      contextGraphId: CG,
      kaUal: UAL,
      assertionVersion: version,
      publicTripleCount: payload.length,
      privateTripleCount: 0,
      publisherPeerId: 'peer-source',
      timestamp: new Date(0),
    }, WS_META),
    { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: WS_META },
    { subject: operationSubject, predicate: `${DKG}publicSnapshotRef`, object: `"${digest}"`, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"${version}"^^<${XSD_INTEGER}>`, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
    { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: WS_META },
  ];
  return { version, operationId, operationSubject, headSubject, assertionGraph, payload, digest, meta };
}

const v1 = share(1, 'op-v1', 'version-one');
const v2 = share(2, 'op-v2', 'version-two');

function descriptorFor(fixture: typeof v1) {
  const descriptors = parseGraphScopedSwmRecoveryDescriptors({
    contextGraphId: CG,
    metaQuads: fixture.meta,
  });
  expect(descriptors).toHaveLength(1);
  return descriptors[0]!;
}

function materializerFor(store: TripleStore) {
  let invalidations = 0;
  const materializer = createSharedMemorySnapshotMaterializer({
    store,
    writeLocks: new Map<string, Promise<void>>(),
    invalidateListContextGraphsCache: () => { invalidations += 1; },
  });
  return { materializer, invalidations: () => invalidations };
}

function inGraph(quads: readonly Quad[], graph: string): Quad[] {
  return quads.map((quad) => ({ ...quad, graph }));
}

async function distinctObjects(store: TripleStore, graph: string, subject: string, predicate: string): Promise<string[]> {
  const result = await store.query(
    `SELECT DISTINCT ?o WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`,
  );
  if (result.type !== 'bindings') throw new Error(`unexpected ${result.type}`);
  return result.bindings.map((row) => String(row['o'])).sort();
}

describe('createSharedMemorySnapshotMaterializer against a real OxigraphStore', () => {
  it('keeps post-commit settlement in the real higher-level committer', async () => {
    const store = new OxigraphStore();
    const { materializer } = materializerFor(store);
    const forwarded: Array<{ contextGraphId: string; kaUal: string }> = [];
    const committer = createSharedMemorySnapshotCommitter({
      materializer,
      settleGraphScopedSnapshot: async (contextGraphId, descriptor) => {
        forwarded.push({ contextGraphId, kaUal: descriptor.kaUal });
      },
    });
    const descriptors = [descriptorFor(v1), descriptorFor(v2)];

    await committer.settleCommittedSnapshots(CG, descriptors);

    expect(committer.materializer).toBe(materializer);
    expect(forwarded).toEqual([
      { contextGraphId: CG, kaUal: UAL },
      { contextGraphId: CG, kaUal: UAL },
    ]);
  });

  it('shares one assertion graph across versions (the premise of the digest guard)', () => {
    expect(v1.assertionGraph).toBe(v2.assertionGraph);
    expect(v1.payload).toHaveLength(v2.payload.length);
    expect(v1.digest).not.toBe(v2.digest);
  });

  describe('isGraphAssetMaterialized', () => {
    it('is false for the pre-fix broken state: marker metadata without content', async () => {
      const store = new OxigraphStore();
      await store.insert([...v1.meta]);
      const { materializer } = materializerFor(store);
      expect(await materializer.isGraphAssetMaterialized(descriptorFor(v1))).toBe(false);
    });

    it('is false for a short (partially written) graph', async () => {
      const store = new OxigraphStore();
      await store.insert(inGraph(v1.payload.slice(0, 1), v1.assertionGraph));
      const { materializer } = materializerFor(store);
      expect(await materializer.isGraphAssetMaterialized(descriptorFor(v1))).toBe(false);
    });

    it('is true for the exact descriptor content (digest survives the store round-trip)', async () => {
      const store = new OxigraphStore();
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      const { materializer } = materializerFor(store);
      expect(await materializer.isGraphAssetMaterialized(descriptorFor(v1))).toBe(true);
    });

    it('is false when an EQUAL-COUNT graph holds a different version\'s content', async () => {
      // The count-only trap: v1 and v2 have the same quad count and share the
      // assertion graph URI. A count-based guard would report v2 as already
      // materialized and strand the verified newer snapshot forever.
      const store = new OxigraphStore();
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      const { materializer } = materializerFor(store);
      expect(await materializer.isGraphAssetMaterialized(descriptorFor(v2))).toBe(false);
    });
  });

  describe('readStoredHead', () => {
    it('is null/clean when no head exists', async () => {
      const store = new OxigraphStore();
      const { materializer } = materializerFor(store);
      expect(await materializer.readStoredHead(descriptorFor(v1))).toEqual({ version: null, needsRepair: false });
    });

    it('reads a single-version head without flagging repair', async () => {
      const store = new OxigraphStore();
      await store.insert([...v1.meta]);
      const { materializer } = materializerFor(store);
      expect(await materializer.readStoredHead(descriptorFor(v1))).toEqual({ version: '1', needsRepair: false });
    });

    it('returns the NEWEST version (MAX) for union-insert residue and flags repair', async () => {
      // Append-style meta inserts stacked v1 and v2 rows on one head subject.
      // An arbitrary binding (or MIN) could report "1" and authorize an
      // overwrite-with-older; MAX must win, and the residue must be flagged.
      const store = new OxigraphStore();
      await store.insert([...v1.meta]);
      await store.insert([...v2.meta]);
      const { materializer } = materializerFor(store);
      expect(await materializer.readStoredHead(descriptorFor(v2))).toEqual({ version: '2', needsRepair: true });
    });
  });

  describe('replaceHeadMetadata', () => {
    it('deletes the head and every referenced operation, sparing unrelated subjects', async () => {
      const store = new OxigraphStore();
      await store.insert([...v1.meta]);
      await store.insert([...v2.meta]);
      const unrelated: Quad = {
        subject: 'urn:dkg:share:other',
        predicate: `${DKG}shareOperationId`,
        object: '"unrelated"',
        graph: WS_META,
      };
      await store.insert([unrelated]);
      const { materializer } = materializerFor(store);

      await materializer.replaceHeadMetadata(CG, descriptorFor(v2));

      expect(await distinctObjects(store, WS_META, v2.headSubject, `${DKG}assertionVersion`)).toEqual([]);
      expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`)).toEqual([]);
      expect(await distinctObjects(store, WS_META, v2.operationSubject, `${DKG}shareOperationId`)).toEqual([]);
      expect(await distinctObjects(store, WS_META, unrelated.subject, `${DKG}shareOperationId`)).toEqual(['"unrelated"']);
    });

    it('never deletes an operation owned by ANOTHER KA, even if the head references it', async () => {
      // A (corrupt) head row pointing at a foreign share operation must not
      // let this KA's cleanup destroy the other KA's metadata — same kaUal
      // guard the recovery lane's replaceMetaForGraphAssets applies.
      const store = new OxigraphStore();
      const otherUal = 'did:dkg:hardhat:31337/0xcccccccccccccccccccccccccccccccccccccccc/3';
      const foreignOp = `urn:dkg:share:${CG}:foreign-op`;
      await store.insert([...v1.meta]);
      await store.insert([
        { subject: v1.headSubject, predicate: `${DKG}shareOperationId`, object: '"foreign-op"', graph: WS_META },
        { subject: foreignOp, predicate: `${DKG}shareOperationId`, object: '"foreign-op"', graph: WS_META },
        { subject: foreignOp, predicate: `${DKG}kaUal`, object: otherUal, graph: WS_META },
      ]);
      const { materializer } = materializerFor(store);

      await materializer.replaceHeadMetadata(CG, descriptorFor(v1));

      expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`)).toEqual([]);
      expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`)).toEqual([]);
      expect(await distinctObjects(store, WS_META, foreignOp, `${DKG}shareOperationId`)).toEqual(['"foreign-op"']);
    });
  });

  it('replaceGraph writes atomically and invalidates the list cache', async () => {
    const store = new OxigraphStore();
    const { materializer, invalidations } = materializerFor(store);
    await materializer.replaceGraph(v1.assertionGraph, inGraph(v1.payload, v1.assertionGraph));
    expect(invalidations()).toBe(1);
    const { materializer: checker } = materializerFor(store);
    expect(await checker.isGraphAssetMaterialized(descriptorFor(v1))).toBe(true);
  });

  describe('end-to-end catch-up with the real materializer', () => {
    function realHarness(store: TripleStore, served: typeof v1) {
      const snapshotStore = new MemorySnapshotStore();
      const { materializer } = materializerFor(store);
      let replaceCalls = 0;
      const run = async () => {
        await snapshotStore.putSnapshot({ digest: served.digest, quads: served.payload });
        return runSharedMemorySync({
          ctx,
          remotePeerId: 'peer-source',
          contextGraphIds: [CG],
          createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
          fetchSyncPages: async (_c, _p, _cg, _inc, phase): Promise<SyncPageResult> => ({
            quads: phase === 'meta' ? [...served.meta] : [],
            bytesReceived: 0,
            resumedFromOffset: 0,
            nextOffset: phase === 'meta' ? served.meta.length : 0,
            checkpointKey: 'k',
            completed: true,
            timedOut: false,
          }),
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
          storeInsert: async (quads) => { await store.insert(quads); },
          snapshotCommitter: {
            materializer: {
              ...materializer,
              replaceGraph: async (graphUri, quads) => {
                replaceCalls += 1;
                return materializer.replaceGraph(graphUri, quads);
              },
            },
            settleCommittedSnapshots: async () => {},
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
      return { run, replaceCalls: () => replaceCalls };
    }

    it('heals the pre-fix broken state through the REAL content guard', async () => {
      // Marker-only store: head + operation rows exist, the assertion graph
      // was never written. The real SPARQL guard must answer "not
      // materialized" so the cached snapshot is finally written.
      const store = new OxigraphStore();
      await store.insert([...v1.meta]);
      const h = realHarness(store, v1);
      const summary = await h.run();
      expect(summary.failedPhases).toBe(0);
      expect(h.replaceCalls()).toBe(1);
      const { materializer } = materializerFor(store);
      expect(await materializer.isGraphAssetMaterialized(descriptorFor(v1))).toBe(true);
    });

    it('replaces an equal-count older version and leaves ONE unambiguous head', async () => {
      // Start as a node that fully holds version 1 — content AND metadata.
      // Version 2 has the SAME quad count. The catch-up must (a) see through
      // the equal count via the digest, (b) replace the graph, and (c) swap
      // the head so the LIMIT-1 production reader resolves version 2 — not an
      // arbitrary row from a v1+v2 union pile-up.
      const store = new OxigraphStore();
      await store.insert([...v1.meta]);
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      const h = realHarness(store, v2);

      const summary = await h.run();
      expect(summary.failedPhases).toBe(0);
      expect(h.replaceCalls()).toBe(1);

      // Graph content is now v2's.
      const { materializer } = materializerFor(store);
      expect(await materializer.isGraphAssetMaterialized(descriptorFor(v2))).toBe(true);
      expect(await materializer.isGraphAssetMaterialized(descriptorFor(v1))).toBe(false);

      // Exactly one head version / operation reference remains.
      expect(await distinctObjects(store, WS_META, v2.headSubject, `${DKG}assertionVersion`))
        .toEqual([`"2"^^<${XSD_INTEGER}>`]);
      expect(await distinctObjects(store, WS_META, v2.headSubject, `${DKG}shareOperationId`))
        .toEqual(['"op-v2"']);
      // The old operation's rows are gone, the new one's are present.
      expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`)).toEqual([]);
      expect(await distinctObjects(store, WS_META, v2.operationSubject, `${DKG}shareOperationId`)).toEqual(['"op-v2"']);

      // The LIMIT-1 production reader resolves version 2 unambiguously.
      const head = await resolveKnowledgeAssetWorkspaceHead({
        store,
        graphManager: new GraphManager(store),
        contextGraphId: CG,
        kaUal: UAL,
      });
      expect(head?.assertionVersion).toBe('2');
      expect(head?.shareOperationId).toBe('op-v2');

      // A second round is a pure no-op: the real digest guard skips (which
      // also proves the digest survives the store round-trip — no churn).
      const again = await h.run();
      expect(again.failedPhases).toBe(0);
      expect(h.replaceCalls()).toBe(1);
    });
  });
});
