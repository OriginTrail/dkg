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
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { operationIdentityKey, parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';

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
/**
 * Thin adapters over the shared builders in `swm-descriptor-fixtures.ts`.
 *
 * The bodies moved so the throw-path row in `sync-requester-progress.test.ts`
 * can build DESCRIPTOR-shaped metadata from the same known-good source instead
 * of hand-rolling a fourth SWM fixture. The positional signatures are kept so
 * every existing call site here is untouched — the 13 pre-existing tests are
 * re-proven behaviourally identical by RUN, not by reading this diff.
 */
const swmFx = swmFixtures(CG);

function share(version: number, operationId: string, marker: string, ual: string = UAL, payloadCount = 2) {
  return swmFx.share({ version, operationId, marker, ual, payloadCount });
}

function manifest(count: number) {
  return swmFx.manifest(count);
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
      expect(await materializer.readStoredHead(descriptorFor(v1))).toEqual({ version: null, needsRepair: false, shareOperationId: null });
    });

    it('reads a single-version head without flagging repair', async () => {
      const store = new OxigraphStore();
      await store.insert([...v1.meta]);
      const { materializer } = materializerFor(store);
      // GH#2273 — the single unambiguous id is exposed so catch-up can compare
      // it against a descriptor's id before deciding whether the head may be
      // rewritten at all.
      expect(await materializer.readStoredHead(descriptorFor(v1))).toEqual({ version: '1', needsRepair: false, shareOperationId: 'op-v1' });
    });

    it('returns the NEWEST version (MAX) for union-insert residue and flags repair', async () => {
      // Append-style meta inserts stacked v1 and v2 rows on one head subject.
      // An arbitrary binding (or MIN) could report "1" and authorize an
      // overwrite-with-older; MAX must win, and the residue must be flagged.
      const store = new OxigraphStore();
      await store.insert([...v1.meta]);
      await store.insert([...v2.meta]);
      const { materializer } = materializerFor(store);
      // GH#2273 — with residue on the head, ANY sampled id would be an
      // arbitrary pick (the exact failure the field exists to prevent), so
      // ambiguity reads as null and the decision routes through repair.
      expect(await materializer.readStoredHead(descriptorFor(v2))).toEqual({ version: '2', needsRepair: true, shareOperationId: null });
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
    function realHarness(store: TripleStore, served: typeof v1, servedMeta: Quad[] = served.meta) {
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
            quads: phase === 'meta' ? [...servedMeta] : [],
            bytesReceived: 0,
            resumedFromOffset: 0,
            nextOffset: phase === 'meta' ? servedMeta.length : 0,
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
          snapshotMaterializer: {
            ...materializer,
            replaceGraph: async (graphUri, quads) => {
              replaceCalls += 1;
              return materializer.replaceGraph(graphUri, quads);
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

    it('recovers equivalent originator and storage-ACK heads and stores one current pointer', async () => {
      // A later StorageACK can persist the exact same assertion under its own
      // deterministic operation id while an older originator head is replayed
      // by durable metadata sync. This is the production residue observed in
      // the 400/400 canary run: two operation pointers, identical content and
      // policy, different timestamps. It is recoverable, not corrupt.
      const storageAck = share(1, 'storage-ack-equivalent', 'version-one');
      const storageAckMeta = storageAck.meta.map((row) =>
        row.subject === storageAck.operationSubject && row.predicate === `${DKG}publishedAt`
          ? { ...row, object: '"1970-01-01T00:00:01.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }
          : row);
      const servedMeta = [
        ...v1.meta,
        ...storageAckMeta.filter((row) => row.subject === storageAck.operationSubject),
        ...storageAckMeta.filter((row) =>
          row.subject === storageAck.headSubject && row.predicate === `${DKG}shareOperationId`),
      ];

      const parsed = parseGraphScopedSwmRecoveryDescriptors({
        contextGraphId: CG,
        metaQuads: servedMeta,
      });
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.shareOperationId).toBe('storage-ack-equivalent');
      expect(parsed[0]?.metadataQuads.filter((row) =>
        row.subject === storageAck.headSubject && row.predicate === `${DKG}shareOperationId`))
        .toEqual([expect.objectContaining({ object: '"storage-ack-equivalent"' })]);

      const store = new OxigraphStore();
      const h = realHarness(store, storageAck, servedMeta);
      const summary = await h.run();
      expect(summary.failedPhases).toBe(0);
      expect(await distinctObjects(store, WS_META, storageAck.headSubject, `${DKG}shareOperationId`))
        .toEqual(['"storage-ack-equivalent"']);
    });

    it('still fails closed when two head operations disagree on content', () => {
      const conflicting = share(1, 'op-conflicting', 'different-content');
      const poisonedMeta = [
        ...v1.meta,
        ...conflicting.meta.filter((row) => row.subject === conflicting.operationSubject),
        ...conflicting.meta.filter((row) =>
          row.subject === conflicting.headSubject && row.predicate === `${DKG}shareOperationId`),
      ];
      expect(() => parseGraphScopedSwmRecoveryDescriptors({
        contextGraphId: CG,
        metaQuads: poisonedMeta,
      })).toThrow(/ambiguous shareOperationId/);
    });
  });
});

/**
 * T9 / T9b (#2050) — a PARTIAL round must leave its own progress readable.
 *
 * The G7 defect: `replaceHeadMetadata` is delete-only, and the only statement
 * that writes head rows — `storeInsert(processed.verifiedMeta)` — sits BELOW the
 * `continue` on the incomplete branch. So a round that materializes some KAs and
 * then abandons the rest writes their assertion graphs and no head rows at all:
 * content present, heads absent, invisible to every head reader. That is the
 * r26 residual.
 *
 * This needs no Chunk 2 yield to reproduce. A snapshot-phase fetch that returns
 * `completed: false` already drives `syncPublicSnapshotsForMeta` to its early
 * return, which makes `snapshotPhaseUsable` false and skips the bulk insert —
 * the same branch a deadline yield will take.
 *
 * Asserted over the FULL final quad set rather than per-KA presence, so an
 * over-broad "insert everything" implementation fails here too: heads must exist
 * for exactly the KAs that were materialized, and for no others.
 */
/**
 * Runs a round over `shares` where the first `materializeCount` snapshots are
 * pre-cached (so they materialize from cache) and the next one is NOT cached
 * and its network fetch returns incomplete — the partial-round branch.
 */
async function runPartial(store: OxigraphStore, shares: ReturnType<typeof manifest>, materializeCount: number) {
  const snapshotStore = new MemorySnapshotStore();
  for (const s of shares.slice(0, materializeCount)) {
    await snapshotStore.putSnapshot({ digest: s.digest, quads: s.payload });
  }
  const { materializer } = materializerFor(store);
  return runSharedMemorySync({
    ctx,
    remotePeerId: 'peer-source',
    contextGraphIds: [CG],
    createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
    fetchSyncPages: async (_c, _p, _cg, _inc, phase): Promise<SyncPageResult> => {
      if (phase === 'meta') {
        const quads = shares.flatMap((s) => s.meta);
        return { quads, bytesReceived: 0, resumedFromOffset: 0, nextOffset: quads.length, checkpointKey: 'k', completed: true, timedOut: false };
      }
      if (phase === 'snapshot') {
        // The uncached snapshot cannot be served: the phase ends incomplete,
        // which is exactly what a mid-list deadline produces.
        return { quads: [], bytesReceived: 0, resumedFromOffset: 0, nextOffset: 0, checkpointKey: 'snap', completed: false, timedOut: true };
      }
      return { quads: [], bytesReceived: 0, resumedFromOffset: 0, nextOffset: 0, checkpointKey: 'k', completed: true, timedOut: false };
    },
    processSharedMemoryBatch: async (wsDataQuads, wsMetaQuads) => ({
      verifiedData: wsDataQuads, verifiedMeta: wsMetaQuads,
      totalFetchedDataQuads: wsDataQuads.length, totalFetchedMetaQuads: wsMetaQuads.length,
      droppedDataTriples: 0, emptyResponses: 0, entityCreators: [],
    }),
    ensureContextGraph: async () => {},
    storeInsert: async (quads) => { await store.insert(quads); },
    snapshotMaterializer: materializer,
    publicSnapshotStore: snapshotStore,
    deleteCheckpoint: () => {},
    setCheckpoint: () => {},
    ensureOwnedMap: () => new Map(),
    logInfo: () => {}, logWarn: () => {}, logDebug: () => {},
  });
}

describe('T9 — a partial round leaves content AND head rows for what it materialized', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });

  /** Which of these KAs currently carry ANY head row in the store. */
  async function headsPresent(store: TripleStore, shares: ReturnType<typeof manifest>): Promise<string[]> {
    const present: string[] = [];
    for (const s of shares) {
      const r = await store.query(`ASK { GRAPH <${WS_META}> { <${s.headSubject}> ?p ?o } }`);
      if (r.type === 'boolean' && r.value) present.push(s.headSubject);
    }
    return present.sort();
  }

  async function graphsPresent(store: TripleStore, shares: ReturnType<typeof manifest>): Promise<string[]> {
    const present: string[] = [];
    for (const s of shares) {
      const r = await store.query(`ASK { GRAPH <${s.assertionGraph}> { ?s ?p ?o } }`);
      if (r.type === 'boolean' && r.value) present.push(s.assertionGraph);
    }
    return present.sort();
  }


  it('writes head rows for exactly the KAs it materialized, and none for the rest', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const shares = manifest(5);

    await runPartial(store, shares, 2);

    // The two cached KAs were written to the store...
    expect(await graphsPresent(store, shares))
      .toEqual([shares[0]!.assertionGraph, shares[1]!.assertionGraph].sort());

    // ...and their heads must be readable, or the content is invisible to every
    // head reader. PRE-FIX THIS IS `[]`: the bulk meta insert is skipped on the
    // incomplete branch and nothing else writes a head row.
    expect(await headsPresent(store, shares))
      .toEqual([shares[0]!.headSubject, shares[1]!.headSubject].sort());
  });

  it('does not certify a KA it never materialized', async () => {
    // The over-broad direction: an implementation that inserts all verified meta
    // on the partial branch would stamp head rows for KAs 3-5, whose assertion
    // graphs were never written — a head certifying an unwritten graph, which is
    // the precise failure the withhold rule exists to prevent.
    const store = new OxigraphStore();
    stores.push(store);
    const shares = manifest(5);

    await runPartial(store, shares, 2);

    const heads = await headsPresent(store, shares);
    for (const s of shares.slice(2)) {
      expect(heads).not.toContain(s.headSubject);
    }
  });
});

/**
 * T9b (#2050) — the r26 RESIDUAL: content already materialized, head row absent
 * or stale. Nothing rewrites it pre-fix, so the KA stays invisible forever.
 *
 * This is the third head-deleting exit, and it is the one neither T9 row can
 * reach: both of those go through the MATERIALIZE path, while this state short-
 * circuits at `isGraphAssetMaterialized() === true` and returns early. A node
 * that ran a partial round before the fix is left in exactly this state — the
 * graph is written, so the content guard says "already materialized", and the
 * head that would advertise it was deleted and never rewritten.
 *
 * Both cases run on the PARTIAL branch deliberately. On a complete round the
 * bulk `storeInsert(processed.verifiedMeta)` writes every head anyway and would
 * mask the exit entirely — the assertion would pass with the repair removed.
 * With the round incomplete, the exit's own insert is the ONLY thing that can
 * write these head rows, which is what makes the mutant `storedHead.needsRepair
 * || !headCertifiesDescriptor(…)` → `storedHead.needsRepair` fail here.
 */
describe('T9b — the already-materialized exit repairs an absent or stale head', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });

  async function headVersions(store: TripleStore, headSubject: string): Promise<string[]> {
    return distinctObjects(store, WS_META, headSubject, `${DKG}assertionVersion`);
  }

  it('writes the head for content that is present with NO head row at all', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const shares = manifest(3);
    const target = shares[0]!;

    // The r26 residual, reproduced exactly: assertion graph written by an
    // earlier partial round, zero head rows. `needsRepair` is FALSE here
    // (`readStoredHead` returns `{version: null, needsRepair: false}` when the
    // subject carries nothing), so a repair gated only on `needsRepair` never
    // fires and the KA stays stranded.
    await store.insert(inGraph(target.payload, target.assertionGraph));
    expect(await headVersions(store, target.headSubject)).toEqual([]);

    await runPartial(store, shares, 2);

    expect(await headVersions(store, target.headSubject))
      .toEqual([`"1"^^<${XSD_INTEGER}>`]);
  });

  it('replaces a head pinned at an OLDER version than the content', async () => {
    // Same exit, stale rather than absent: the head advertises v1 while the
    // graph already holds the descriptor's content. One version row before,
    // exactly one after — and it must be the descriptor's, not the stale one.
    const store = new OxigraphStore();
    stores.push(store);
    // The stored head must be STRICTLY OLDER than the descriptor, or the in-lock
    // version guard short-circuits at `storedVersionOutranksDescriptor` and exit
    // 3 is never reached. An earlier draft pre-seeded a v1 head against a v1
    // descriptor: the guard returned early, the stale rows survived untouched —
    // and the version assertion STILL PASSED, because both heads read "1". It
    // could not tell the two states apart.
    const base = manifest(3);
    const ual = base[0]!.headSubject.replace('#dkg-swm-head', '');
    // Same UAL, payload and digest, VERSION 2. A graph-scoped KA keeps ONE
    // assertion graph across versions, so the pre-seeded content still matches.
    const target = share(2, 'op-ka-1-v2', 'ka-1', ual, 2);
    const shares = [target, ...base.slice(1)];

    await store.insert(inGraph(target.payload, target.assertionGraph));
    await store.insert(base[0]!.meta.filter((q) => q.subject === base[0]!.headSubject));
    expect(await headVersions(store, target.headSubject)).toEqual([`"1"^^<${XSD_INTEGER}>`]);

    await runPartial(store, shares, 2);

    const versions = await headVersions(store, target.headSubject);
    expect(versions).toEqual([`"2"^^<${XSD_INTEGER}>`]);
    // The stale operation subject must not survive alongside the fresh one.
    expect(await distinctObjects(store, WS_META, target.headSubject, `${DKG}shareOperationId`))
      .toEqual([`"${target.operationId}"`]);
  });
});

/**
 * GH#2273 — catch-up must not change the operation identity of a semantically
 * identical head. The failure this block reproduces killed queued VM-publish
 * jobs terminally: a job freezes the head's shareOperationId at admission; a
 * peer (typically a storage-ACKing core) legitimately holds the SAME share
 * under a DIFFERENT deterministic id; stage 1 — the round's bulk verified-meta
 * union-insert stacked the peer's head-id row beside the local one; stage 2 —
 * the next round's needsRepair deleted the head AND the local operation
 * subject, re-inserting only the remote identity, after which the preflight's
 * `liveHead.shareOperationId !== request.shareOperationId` failed the job as
 * terminal `publish_intent_stale` for content that never changed.
 */
describe('operation identity preservation (GH#2273)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });

  // The storage-ACK-shaped twin of `v1`: same marker => byte-identical payload,
  // digest and operation rows (the fixture stamps a constant timestamp and
  // publisherPeerId), differing ONLY in the operation id — the exact residue
  // `resolveEquivalentHeadOperation`'s docstring names as legitimate.
  const remoteEquivalent = share(1, 'storage-ack-2273b', 'version-one');
  // Same version, different content => different digest => NOT equivalent.
  const remoteChanged = share(1, 'storage-ack-2273c', 'version-one-changed');

  function opRowsOf(fixture: typeof v1): Quad[] {
    return fixture.meta.filter((quad) => quad.subject === fixture.operationSubject);
  }

  async function seedMaterializedLocal(store: OxigraphStore): Promise<void> {
    // BOTH halves matter. Meta alone is the pre-fix broken state: without the
    // assertion-graph content the per-KA path takes the MATERIALIZE branch and
    // rewrites the head in round 1, so the two-stage shape under test would
    // never form and the rows below would fail for the wrong reason.
    await store.insert(inGraph(v1.payload, v1.assertionGraph));
    await store.insert([...v1.meta]);
  }

  /** realHarness's shape (see the end-to-end describe) without the counters. */
  function identityHarness(store: TripleStore, served: typeof v1) {
    const snapshotStore = new MemorySnapshotStore();
    const { materializer } = materializerFor(store);
    return async () => {
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
        snapshotMaterializer: materializer,
        publicSnapshotStore: snapshotStore,
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: () => new Map(),
        logInfo: () => {},
        logWarn: () => {},
        logDebug: () => {},
      });
    };
  }

  it('operationIdentityKey survives the Oxigraph round-trip (wire rows vs stored rows)', async () => {
    // The prefer-local decision compares WIRE quads (descriptor metadata)
    // against rows READ BACK from the store. If any allow-list object term
    // re-serializes differently (typed integers, bare-IRI kaUal, datatype
    // rendering), the keys never match, no suppression ever fires, and the
    // whole fix silently degrades to a no-op in production while
    // descriptor-vs-descriptor unit rows stay green. This row pins the
    // round-trip byte-compatibility the comparison rests on.
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([...v1.meta]);
    const readBack = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${WS_META}> { <${v1.operationSubject}> ?p ?o } }`,
    );
    expect(readBack.type).toBe('bindings');
    if (readBack.type !== 'bindings') throw new Error('expected bindings');
    const storedRows: Quad[] = readBack.bindings.map((row) => ({
      subject: v1.operationSubject,
      predicate: String(row['p'] ?? ''),
      object: String(row['o'] ?? ''),
      graph: WS_META,
    }));
    const wireKey = operationIdentityKey(opRowsOf(v1));
    const storedKey = operationIdentityKey(storedRows);
    expect(wireKey).not.toBeNull();
    expect(storedKey).toBe(wireKey);
    // And the relation itself discriminates: the equivalent twin keys equal,
    // the changed share keys different — on the WIRE side, so a false-positive
    // in the normalizer cannot hide behind store canonicalization.
    expect(operationIdentityKey(opRowsOf(remoteEquivalent))).toBe(wireKey);
    expect(operationIdentityKey(opRowsOf(remoteChanged))).not.toBe(wireKey);
  });

  it('selectRepairIdentity prefers the stored equivalent id and refuses a changed share', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);
    // Stage-1 residue, fabricated the way sync produces it: bare union insert.
    await store.insert(remoteEquivalent.meta.filter((quad) =>
      quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
    await store.insert(opRowsOf(remoteEquivalent));
    const { materializer } = materializerFor(store);
    expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent)))
      .toEqual({ winnerShareOperationId: 'op-v1' });
    // Solo-removal for the equivalence conjunct: same shape, but the stored
    // operation genuinely differs from what the descriptor offers => the
    // decision MUST fall back to descriptor-wins (null), or a real content
    // change could be silently masked by identity preservation.
    expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteChanged)))
      .toBeNull();
  });

  it('refuses preservation for policy-envelope, author, and unresolvable-winner differences', async () => {
    // The security-relevant HALF of the allow-list: same content digest, but
    // the DESCRIPTOR carries a different access envelope or author. Treating
    // those as identity-equivalent would preserve a stale local id across a
    // real policy change — the exact protection the queued-publish preflight
    // exists to give. And a winner that is key-equal but UNRESOLVABLE
    // (missing publisherPeerId) must also refuse: preserving it would write a
    // head the resolver permanently fails as corrupt, and the next round
    // would preserve it again — a wedged KA.
    const withRows = (base: typeof v1, extra: Quad[]): Quad[] => [...base.meta, ...extra];

    // (a) descriptor adds an allowList envelope the stored operation lacks.
    {
      const store = new OxigraphStore();
      stores.push(store);
      await seedMaterializedLocal(store);
      const envelopeMeta = withRows(remoteEquivalent, [
        { subject: remoteEquivalent.operationSubject, predicate: `${DKG}accessPolicy`, object: '"allowList"', graph: WS_META },
        { subject: remoteEquivalent.operationSubject, predicate: `${DKG}allowedPeer`, object: '"peer-b"', graph: WS_META },
      ]);
      await store.insert(envelopeMeta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
      await store.insert(envelopeMeta.filter((quad) => quad.subject === remoteEquivalent.operationSubject));
      const descriptors = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: envelopeMeta });
      expect(descriptors).toHaveLength(1);
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptors[0]!)).toBeNull();
    }

    // (b) descriptor carries a different author (prov:wasAttributedTo).
    {
      const store = new OxigraphStore();
      stores.push(store);
      await seedMaterializedLocal(store);
      const authorMeta = withRows(remoteEquivalent, [
        {
          subject: remoteEquivalent.operationSubject,
          predicate: 'http://www.w3.org/ns/prov#wasAttributedTo',
          object: 'did:dkg:agent:0x9999999999999999999999999999999999999999',
          graph: WS_META,
        },
      ]);
      await store.insert(authorMeta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
      await store.insert(authorMeta.filter((quad) => quad.subject === remoteEquivalent.operationSubject));
      const descriptors = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: authorMeta });
      expect(descriptors).toHaveLength(1);
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptors[0]!)).toBeNull();
    }

    // (c) stored winner is key-equal but missing publisherPeerId — the key
    // excludes per-node rows, so ONLY the resolvability check can catch it.
    {
      const store = new OxigraphStore();
      stores.push(store);
      await store.insert(inGraph(v1.payload, v1.assertionGraph));
      await store.insert(v1.meta.filter((quad) =>
        !(quad.subject === v1.operationSubject && quad.predicate === `${DKG}publisherPeerId`)));
      await store.insert(remoteEquivalent.meta.filter((quad) =>
        quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
      await store.insert(opRowsOf(remoteEquivalent));
      const { materializer } = materializerFor(store);
      expect(await materializer.selectRepairIdentity(CG, descriptorFor(remoteEquivalent))).toBeNull();
    }
  });

  it('repairHeadPreservingIdentity heals a two-valued head to the stored identity', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);
    await store.insert(remoteEquivalent.meta.filter((quad) =>
      quad.subject === remoteEquivalent.headSubject && quad.predicate === `${DKG}shareOperationId`));
    await store.insert(opRowsOf(remoteEquivalent));
    const { materializer } = materializerFor(store);
    await materializer.repairHeadPreservingIdentity(CG, descriptorFor(remoteEquivalent), 'op-v1');
    // Head certifies exactly the local identity again, the winner's operation
    // rows were NEVER deleted (they may be the only durable copy a queued job
    // references), and the loser's operation subject is gone.
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    expect(await distinctObjects(store, WS_META, remoteEquivalent.operationSubject, `${DKG}shareOperationId`))
      .toEqual([]);
    // The full production reader agrees end-to-end — the same resolver the
    // queued-publish preflight consults.
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: CG,
      kaUal: UAL,
    });
    expect(head?.shareOperationId).toBe('op-v1');
  });

  it('catch-up preserves the local identity for identical content across both stages', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);

    // Round 1 — pre-fix: the per-KA path skipped (content identical, head
    // healthy) and the bulk insert unioned the peer's head-id row in, leaving
    // TWO ids under a LIMIT-1-style reader.
    await identityHarness(store, remoteEquivalent)();
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    // The remote operation subject IS retained as immutable history — only the
    // head-id row is suppressed. This also proves the bulk insert is not
    // blanket-filtered (see the graph-backed row below for the head side).
    expect(await distinctObjects(store, WS_META, remoteEquivalent.operationSubject, `${DKG}shareOperationId`))
      .toEqual(['"storage-ack-2273b"']);

    // Round 2 — pre-fix: needsRepair fired on the two-valued head, deleted the
    // head AND op-v1's subject, and re-inserted only the remote identity.
    await identityHarness(store, remoteEquivalent)();
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: CG,
      kaUal: UAL,
    });
    expect(head?.shareOperationId).toBe('op-v1');
  });

  it('preserves the local identity when catch-up MATERIALIZES absent content (r26 state)', async () => {
    // Head and local operation exist but the assertion graph is empty — the
    // #2050 r26 residual. Catch-up must fill the graph from the equivalent
    // peer snapshot AND keep certifying the local identity: this exercises
    // the materialize-path repairOrReplaceHead call site through the real
    // sync loop, which the direct repair rows above cannot reach. A
    // regression that reverts that call site to replaceHeadMetadata leaves
    // every other GH#2273 row green and only fails here.
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([...v1.meta]);
    await identityHarness(store, remoteEquivalent)();
    // Content materialized from the peer snapshot...
    const content = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${v1.assertionGraph}> { ?s ?p ?o } }`,
    );
    expect(content.type).toBe('bindings');
    if (content.type !== 'bindings') throw new Error('expected bindings');
    expect(String(content.bindings[0]?.['c'] ?? '')).toContain('2');
    // ...and the identity queued jobs reference survived the head rewrite.
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
    expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
  });

  it('a genuinely changed share still adopts the remote identity (discriminator polarity)', async () => {
    // Same version, different digest: the materialized guard sees foreign
    // content, the graph is replaced from the peer snapshot, and the repair
    // decision must NOT preserve the local id — the share really changed, and
    // the preflight rejecting a queued job against it is the CORRECT outcome
    // (issue #2273's own negative acceptance test).
    const store = new OxigraphStore();
    stores.push(store);
    await seedMaterializedLocal(store);
    await identityHarness(store, remoteChanged)();
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"storage-ack-2273c"']);
    expect(await distinctObjects(store, WS_META, v1.operationSubject, `${DKG}shareOperationId`))
      .toEqual([]);
  });

  it('an older version\'s head rows never union onto the live head', async () => {
    // The version-superseded exit used to return WITHOUT withholding the stale
    // descriptor's head rows from the bulk append, so a peer still serving v1
    // stacked a second assertionVersion (and operation id) onto a v2 head —
    // the overwrite-with-older hazard arriving via the metadata side, and a
    // state the phased resolver now fails closed on.
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert(inGraph(v2.payload, v2.assertionGraph));
    await store.insert([...v2.meta]);
    await identityHarness(store, v1)();
    expect(await distinctObjects(store, WS_META, v2.headSubject, `${DKG}assertionVersion`))
      .toEqual([`"2"^^<${XSD_INTEGER}>`]);
    expect(await distinctObjects(store, WS_META, v2.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v2"']);
  });

  it('a graph-backed KA still gets its head from the bulk insert (suppression is decision-driven)', async () => {
    // Graph-backed descriptors (publicSnapshotGraph, no publicSnapshotRef)
    // never enter the per-KA loop — the round's bulk insert is their ONLY head
    // writer. A blanket head-row filter instead of decision-driven suppression
    // would leave them permanently headless (the #2050 G7 invisibility class).
    const store = new OxigraphStore();
    stores.push(store);
    const graphBacked = {
      ...v1,
      meta: [
        ...v1.meta.filter((quad) => quad.predicate !== `${DKG}publicSnapshotRef`),
        {
          subject: v1.operationSubject,
          predicate: `${DKG}publicSnapshotGraph`,
          object: `did:dkg:context-graph:${CG}/_shared_memory_snapshots/_/${v1.operationId}/ka`,
          graph: WS_META,
        },
      ],
    };
    await identityHarness(store, graphBacked as typeof v1)();
    expect(await distinctObjects(store, WS_META, v1.headSubject, `${DKG}shareOperationId`))
      .toEqual(['"op-v1"']);
  });
});
