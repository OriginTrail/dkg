import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
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
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { recoverContextGraphSwm } from '../src/sync/requester/swm-recovery.js';

/**
 * integration. `recoverContextGraphSwm` fetches a CG's
 * full current state from a peer and applies it via REPLACE (not the shared
 * incremental path's blind union), so a stale local store converges to the
 * source's value rather than accumulating a corrupt `{v1,v2}` superset.
 * Transport + verifier are mocked (no libp2p); the apply hits a real store.
 */
const CG = 'ws00-recovery';
const WS = contextGraphWorkspaceGraphUri(CG);
const WS_META = contextGraphWorkspaceMetaGraphUri(CG);
const SUBJ = 'urn:ws00r:shipment';
const STATUS = 'http://schema.org/status';
const ctx: OperationContext = { operationId: 'test', operationName: 'sync' } as never;
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/7';
const UAL_2 = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/8';

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
async function statusValues(store: OxigraphStore): Promise<string[]> {
  const r = await store.query(`SELECT ?o WHERE { GRAPH <${WS}> { <${SUBJ}> <${STATUS}> ?o } }`);
  return r.type === 'bindings' ? r.bindings.map((b) => b['o']) : [];
}

describe('recoverContextGraphSwm (fetch → verify → replace)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });

  function makeDeps(store: OxigraphStore, sourceData: Quad[], sourceMeta: Quad[] = []) {
    return {
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _c: OperationContext, _p: string, _cg: string, _inc: boolean,
        phase: 'data' | 'meta',
      ): Promise<SyncPageResult> => page(phase === 'data' ? sourceData : sourceMeta),
      processSharedMemoryBatch: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        // Production derives the legacy recovery plan from rootEntity metadata,
        // so it is available during the metadata-only classification call. This
        // compact fixture models that plan from the declared source snapshot.
        entityCreators: [...new Set(sourceData.map((q) => q.subject))].map((entity) => ({
          dataGraph: WS, entity, creator: 'peer-source',
        })),
        droppedDataTriples: 0,
      }),
      store,
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    };
  }

  it('replaces a stale local value with the source value (no union corruption)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v1"', graph: WS }]);

    const result = await recoverContextGraphSwm(makeDeps(store, [
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
    ]));

    expect(result.completed).toBe(true);
    expect(result.replacedRoots).toBe(1);
    expect(await statusValues(store)).toEqual(['"v2"']); // ONLY v2 — the bug would leave {v1,v2}
  });

  it('is a clean recovery into an empty store (cold-start parity)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const result = await recoverContextGraphSwm(makeDeps(store, [
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
    ]));
    expect(result.insertedDataQuads).toBe(1);
    expect(await statusValues(store)).toEqual(['"v2"']);
  });

  it('inserts verified meta and reports it', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const meta: Quad[] = [{ subject: 'urn:op:1', predicate: 'http://dkg.io/ontology/shareOperationId', object: '"op1"', graph: WS_META }];
    const result = await recoverContextGraphSwm(makeDeps(store, [
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
    ], meta));
    expect(result.insertedMetaQuads).toBe(1);
    const r = await store.query(`SELECT ?s WHERE { GRAPH <${WS_META}> { ?s ?p ?o } }`);
    expect(r.type === 'bindings' && r.bindings.length).toBe(1);
  });

  it('does NOT apply when a phase never completes — leaves the store untouched for a clean retry', async () => {
    // Row-based pagination can cut a root mid-stream. Applying a REPLACE over an
    // incomplete fetch would clear the root and reinsert only the fetched prefix,
    // truncating the entity until a later retry. So an incomplete fetch must mutate
    // NOTHING: the pre-existing state stays intact and the caller retries from scratch.
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v1"', graph: WS }]);
    const deps = makeDeps(store, [{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS }]);
    // data phase never completes and makes no progress → loop stops, partial.
    const partialDeps = {
      ...deps,
      fetchSyncPages: async (
        _c: OperationContext, _p: string, _cg: string, _inc: boolean, phase: 'data' | 'meta',
      ): Promise<SyncPageResult> =>
        phase === 'data'
          ? { ...page([{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS }], false), nextOffset: 0, resumedFromOffset: 0 }
          : page([]),
    };
    const result = await recoverContextGraphSwm(partialDeps);
    expect(result.completed).toBe(false);
    expect(result.replacedRoots).toBe(0);
    // incomplete fetch → no mutation at all; the prior v1 is untouched (no truncation, no partial replace)
    expect(await statusValues(store)).toEqual(['"v1"']);
  });

  it('recovers a rootless KA snapshot into its exact UAL-derived SWM graph', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const assertionGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const operationId = 'rootless-recovery-op';
    const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
    const headSubject = `${UAL}#dkg-swm-head`;
    const payload: Quad[] = [
      { subject: 'urn:rootless:a', predicate: STATUS, object: '"v2"', graph: '' },
      { subject: 'urn:rootless:disconnected', predicate: 'urn:p', object: '"kept"', graph: '' },
    ];
    const digest = workspacePublicQuadsDigest(payload);
    const sourceMeta: Quad[] = [
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
      { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: WS_META },
    ];
    await store.insert([
      { subject: 'urn:rootless:a', predicate: STATUS, object: '"stale"', graph: assertionGraph },
      { subject: 'urn:rootless:old', predicate: 'urn:p', object: '"must-disappear"', graph: assertionGraph },
    ]);
    const snapshotStore = new MemorySnapshotStore();
    let snapshotFetches = 0;
    let dataFetches = 0;

    const result = await recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _c, _p, _cg, _inc, phase,
      ): Promise<SyncPageResult> => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'snapshot') {
          snapshotFetches += 1;
          return page(payload);
        }
        dataFetches += 1;
        return page([]);
      },
      processSharedMemoryBatch: async (_dataQuads, metaQuads) => ({
        verifiedData: [],
        verifiedMeta: metaQuads,
        entityCreators: [],
        droppedDataTriples: 0,
      }),
      store,
      publicSnapshotStore: snapshotStore,
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    });

    expect(result).toMatchObject({
      completed: true,
      replacedRoots: 0,
      replacedGraphs: 1,
      insertedDataQuads: payload.length,
      insertedMetaQuads: sourceMeta.length,
    });
    expect(snapshotFetches).toBe(1);
    expect(dataFetches).toBe(0);
    const recovered = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`,
    );
    expect(recovered.type).toBe('quads');
    if (recovered.type === 'quads') {
      expect(recovered.quads.map(({ subject, predicate, object }) => ({ subject, predicate, object })))
        .toEqual(payload.map(({ subject, predicate, object }) => ({ subject, predicate, object })));
    }
  });

  it('makes monotonic per-KA progress across a deadline without rescanning aggregate SWM data', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const assets = [
      {
        ual: UAL,
        operationId: 'rootless-recovery-page-1',
        payload: [{ subject: 'urn:rootless:page:1', predicate: STATUS, object: '"one"', graph: '' }],
      },
      {
        ual: UAL_2,
        operationId: 'rootless-recovery-page-2',
        payload: [{ subject: 'urn:rootless:page:2', predicate: STATUS, object: '"two"', graph: '' }],
      },
    ].map((asset) => {
      const scope = createGraphKnowledgeAssetScope(asset.ual, 1);
      const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
      const digest = workspacePublicQuadsDigest(asset.payload);
      const operationSubject = `urn:dkg:share:${CG}:${asset.operationId}`;
      const headSubject = `${asset.ual}#dkg-swm-head`;
      return {
        ...asset,
        assertionGraph,
        digest,
        meta: [
          ...generateKnowledgeAssetShareMetadata({
            shareOperationId: asset.operationId,
            contextGraphId: CG,
            kaUal: asset.ual,
            assertionVersion: 1,
            publicTripleCount: asset.payload.length,
            privateTripleCount: 0,
            publisherPeerId: 'peer-source',
            timestamp: new Date(0),
          }, WS_META),
          { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}kaUal`, object: asset.ual, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${asset.operationId}"`, graph: WS_META },
        ] satisfies Quad[],
      };
    });
    const sourceMeta = assets.flatMap((asset) => asset.meta);
    const snapshotStore = new MemorySnapshotStore();
    const snapshotFetches = new Map<string, number>();
    let round = 1;
    let dataFetches = 0;
    const recover = () => recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _c, _p, _cg, _inc, phase, _graph, _deadline, snapshotRef,
      ): Promise<SyncPageResult> => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'data') {
          dataFetches += 1;
          throw new Error('rootless recovery must not request aggregate data');
        }
        const asset = assets.find((candidate) => candidate.digest === snapshotRef);
        if (!asset) throw new Error(`Unexpected snapshot ref ${snapshotRef}`);
        snapshotFetches.set(asset.digest, (snapshotFetches.get(asset.digest) ?? 0) + 1);
        if (round === 1 && asset === assets[1]) {
          return { ...page([], false), checkpointKey: `snapshot:${asset.digest}` };
        }
        return { ...page(asset.payload), checkpointKey: `snapshot:${asset.digest}` };
      },
      processSharedMemoryBatch: async (_dataQuads, metaQuads) => ({
        verifiedData: [], verifiedMeta: metaQuads, entityCreators: [], droppedDataTriples: 0,
      }),
      store,
      publicSnapshotStore: snapshotStore,
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    });

    const partial = await recover();
    expect(partial.completed).toBe(false);
    expect(partial.replacedGraphs).toBe(0);
    await expect(snapshotStore.getSnapshot(assets[0]!.digest)).resolves.toEqual(assets[0]!.payload);
    await expect(snapshotStore.getSnapshot(assets[1]!.digest)).resolves.toBeNull();

    round = 2;
    const completed = await recover();
    expect(completed).toMatchObject({ completed: true, replacedGraphs: 2, insertedDataQuads: 2 });
    expect(snapshotFetches.get(assets[0]!.digest)).toBe(1);
    expect(snapshotFetches.get(assets[1]!.digest)).toBe(2);
    expect(dataFetches).toBe(0);
    for (const asset of assets) {
      const result = await store.query(
        `SELECT ?s ?p ?o WHERE { GRAPH <${asset.assertionGraph}> { ?s ?p ?o } }`,
      );
      expect(result.type === 'bindings' ? result.bindings : []).toHaveLength(asset.payload.length);
    }
  });

  it('rejects a corrupt rootless snapshot before replacing the existing exact graph', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
    const operationId = 'rootless-corrupt-op';
    const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
    const headSubject = `${UAL}#dkg-swm-head`;
    const committed: Quad[] = [{ subject: 'urn:rootless:a', predicate: STATUS, object: '"good"', graph: '' }];
    const sourceMeta: Quad[] = [
      ...generateKnowledgeAssetShareMetadata({
        shareOperationId: operationId,
        contextGraphId: CG,
        kaUal: UAL,
        assertionVersion: 1,
        publicTripleCount: committed.length,
        privateTripleCount: 0,
        publisherPeerId: 'peer-source',
        timestamp: new Date(0),
      }, WS_META),
      { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${workspacePublicQuadsDigest(committed)}"`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"2"^^<${XSD_INTEGER}>`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: WS_META },
    ];
    await store.insert([{ subject: 'urn:rootless:a', predicate: STATUS, object: '"stale-safe"', graph: assertionGraph }]);

    await expect(recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase): Promise<SyncPageResult> => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'snapshot') {
          return page([{ subject: 'urn:rootless:a', predicate: STATUS, object: '"tampered"', graph: '' }]);
        }
        return page([]);
      },
      processSharedMemoryBatch: async (_dataQuads, metaQuads) => ({
        verifiedData: [], verifiedMeta: metaQuads, entityCreators: [], droppedDataTriples: 0,
      }),
      store,
      publicSnapshotStore: new MemorySnapshotStore(),
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    })).rejects.toThrow('failed digest/count validation');

    const stale = await store.query(
      `SELECT ?o WHERE { GRAPH <${assertionGraph}> { <urn:rootless:a> <${STATUS}> ?o } }`,
    );
    expect(stale.type === 'bindings' ? stale.bindings.map((row) => row['o']) : []).toEqual(['"stale-safe"']);
  });
});
