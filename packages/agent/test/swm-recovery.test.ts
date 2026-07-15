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
import { deletePriorGraphScopedSwmRecoveryMetadata } from '../src/sync/requester/graph-scoped-swm-meta-replace.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';

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
const SECOND_UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/8';

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

function graphBackedFixture(params: {
  ual: string;
  operationId: string;
  payload: Quad[];
  subGraphName?: string;
}) {
  const scope = createGraphKnowledgeAssetScope(params.ual, 1);
  const metaGraph = params.subGraphName
    ? `did:dkg:context-graph:${CG}/${params.subGraphName}/_shared_memory_meta`
    : WS_META;
  const assertionGraph = knowledgeAssetLayerGraphUri(
    CG,
    MemoryLayer.SharedWorkingMemory,
    scope,
    params.subGraphName,
  );
  const operationSubject = `urn:dkg:share:${CG}:${params.operationId}`;
  const headSubject = `${params.ual}#dkg-swm-head`;
  const snapshotGraph =
    `did:dkg:context-graph:${encodeURIComponent(CG)}/_shared_memory_snapshots/` +
    `${encodeURIComponent(params.subGraphName ?? '_')}/${encodeURIComponent(params.operationId)}/ka`;
  const meta: Quad[] = [
    ...generateKnowledgeAssetShareMetadata({
      shareOperationId: params.operationId,
      contextGraphId: CG,
      kaUal: params.ual,
      assertionVersion: 1,
      publicTripleCount: params.payload.length,
      privateTripleCount: 0,
      publisherPeerId: 'peer-source',
      timestamp: new Date(0),
      ...(params.subGraphName ? { subGraphName: params.subGraphName } : {}),
    }, metaGraph),
    { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${workspacePublicQuadsDigest(params.payload)}"`, graph: metaGraph },
    { subject: operationSubject, predicate: `${DKG}publicSnapshotGraph`, object: snapshotGraph, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}kaUal`, object: params.ual, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: metaGraph },
    { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${params.operationId}"`, graph: metaGraph },
  ];
  return { assertionGraph, headSubject, meta, metaGraph, operationSubject, snapshotGraph };
}

async function statusValues(store: OxigraphStore): Promise<string[]> {
  const r = await store.query(`SELECT ?o WHERE { GRAPH <${WS}> { <${SUBJ}> <${STATUS}> ?o } }`);
  return r.type === 'bindings' ? r.bindings.map((b) => b['o']) : [];
}

describe('recoverContextGraphSwm (fetch → verify → replace)', () => {
  const stores: OxigraphStore[] = [];
  const workers: SyncVerifyWorker[] = [];
  afterEach(async () => {
    await Promise.all([
      ...stores.splice(0).map((s) => s.close().catch(() => {})),
      ...workers.splice(0).map((worker) => worker.close().catch(() => {})),
    ]);
  });

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
        entityCreators: [...new Set(dataQuads.map((q) => q.subject))].map((entity) => ({
          dataGraph: WS, entity, creator: 'peer-source',
        })),
        droppedDataTriples: 0,
      }),
      store,
      replaceMetaForGraphAssets: async () => {},
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
    const staleOperationId = 'rootless-stale-op';
    const staleOperationSubject = `urn:dkg:share:${CG}:${staleOperationId}`;
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
      { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${staleOperationId}"`, graph: WS_META },
      { subject: staleOperationSubject, predicate: `${DKG}shareOperationId`, object: `"${staleOperationId}"`, graph: WS_META },
      { subject: staleOperationSubject, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
      { subject: staleOperationSubject, predicate: 'urn:stale:marker', object: '"remove-me"', graph: WS_META },
    ]);
    const snapshotStore = new MemorySnapshotStore();
    let snapshotFetches = 0;

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
      replaceMetaForGraphAssets: (assets) =>
        deletePriorGraphScopedSwmRecoveryMetadata(store, assets),
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
    const recovered = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`,
    );
    expect(recovered.type).toBe('quads');
    if (recovered.type === 'quads') {
      expect(recovered.quads.map(({ subject, predicate, object }) => ({ subject, predicate, object })))
        .toEqual(payload.map(({ subject, predicate, object }) => ({ subject, predicate, object })));
    }
    const staleMeta = await store.query(
      `SELECT ?p WHERE { GRAPH <${WS_META}> { <${staleOperationSubject}> ?p ?o } }`,
    );
    expect(staleMeta.type === 'bindings' ? staleMeta.bindings : []).toEqual([]);
    const activeHead = await store.query(
      `SELECT ?shareId WHERE { GRAPH <${WS_META}> { <${headSubject}> <${DKG}shareOperationId> ?shareId } }`,
    );
    expect(activeHead.type === 'bindings'
      ? activeHead.bindings.map((row) => row['shareId'])
      : []).toEqual([`"${operationId}"`]);
  });

  it('fetches and recovers a graph-backed rootless snapshot without a snapshot store', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const assertionGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const operationId = 'rootless-graph-backed-op';
    const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
    const headSubject = `${UAL}#dkg-swm-head`;
    const snapshotGraph =
      `did:dkg:context-graph:${encodeURIComponent(CG)}/_shared_memory_snapshots/_/` +
      `${encodeURIComponent(operationId)}/ka`;
    const payload: Quad[] = [
      { subject: 'urn:rootless:graph-backed', predicate: STATUS, object: '"recovered"', graph: '' },
    ];
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
      { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${workspacePublicQuadsDigest(payload)}"`, graph: WS_META },
      { subject: operationSubject, predicate: `${DKG}publicSnapshotGraph`, object: snapshotGraph, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionVersion`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: WS_META },
    ];
    let graphSnapshotFetches = 0;

    const result = await recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase, graphUri, _deadline, snapshotRef) => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'snapshot') {
          graphSnapshotFetches += 1;
          expect(graphUri).toBe(snapshotGraph);
          expect(snapshotRef).toBe(snapshotGraph);
          return page(payload);
        }
        return page([]);
      },
      processSharedMemoryBatch: async (_dataQuads, metaQuads) => ({
        verifiedData: [], verifiedMeta: metaQuads, entityCreators: [], droppedDataTriples: 0,
      }),
      store,
      replaceMetaForGraphAssets: async () => {},
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    });

    expect(result).toMatchObject({ completed: true, replacedGraphs: 1, insertedDataQuads: 1 });
    expect(graphSnapshotFetches).toBe(1);
    const recovered = await store.query(
      `SELECT ?o WHERE { GRAPH <${assertionGraph}> { <urn:rootless:graph-backed> <${STATUS}> ?o } }`,
    );
    expect(recovered.type === 'bindings'
      ? recovered.bindings.map((row) => row['o'])
      : []).toEqual(['"recovered"']);

    const dataCarriedStore = new OxigraphStore();
    stores.push(dataCarriedStore);
    let redundantSnapshotFetches = 0;
    const dataCarried = await recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase) => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'data') {
          return page(payload.map((quad) => ({ ...quad, graph: snapshotGraph })));
        }
        redundantSnapshotFetches += 1;
        return page(payload);
      },
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        entityCreators: [],
        droppedDataTriples: 0,
      }),
      store: dataCarriedStore,
      replaceMetaForGraphAssets: async () => {},
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    });
    expect(dataCarried).toMatchObject({ completed: true, replacedGraphs: 1 });
    expect(redundantSnapshotFetches).toBe(0);

    const fallbackStore = new OxigraphStore();
    stores.push(fallbackStore);
    let fallbackSnapshotFetches = 0;
    const fallback = await recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase) => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'data') {
          return page([{
            subject: payload[0].subject,
            predicate: payload[0].predicate,
            object: '"tampered-data-phase-copy"',
            graph: snapshotGraph,
          }]);
        }
        fallbackSnapshotFetches += 1;
        return page(payload);
      },
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        entityCreators: [],
        droppedDataTriples: 0,
      }),
      store: fallbackStore,
      replaceMetaForGraphAssets: async () => {},
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    });
    expect(fallback).toMatchObject({ completed: true, replacedGraphs: 1 });
    expect(fallbackSnapshotFetches).toBe(1);
    const fallbackRecovered = await fallbackStore.query(
      `SELECT ?o WHERE { GRAPH <${assertionGraph}> { <urn:rootless:graph-backed> <${STATUS}> ?o } }`,
    );
    expect(fallbackRecovered.type === 'bindings'
      ? fallbackRecovered.bindings.map((row) => row['o'])
      : []).toEqual(['"recovered"']);
  });

  it('bootstraps graph-scoped subgraphs without admitting remote legacy lanes', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const subGraphName = 'ai-tools';
    const subMetaGraph = `did:dkg:context-graph:${CG}/${subGraphName}/_shared_memory_meta`;
    const subDataGraph = `did:dkg:context-graph:${CG}/${subGraphName}/_shared_memory`;
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const assertionGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      scope,
      subGraphName,
    );
    const operationId = 'rootless-subgraph-op';
    const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
    const headSubject = `${UAL}#dkg-swm-head`;
    const snapshotGraph =
      `did:dkg:context-graph:${encodeURIComponent(CG)}/_shared_memory_snapshots/` +
      `${encodeURIComponent(subGraphName)}/${encodeURIComponent(operationId)}/ka`;
    const payload: Quad[] = [
      { subject: 'urn:rootless:subgraph', predicate: STATUS, object: '"recovered"', graph: '' },
    ];
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
        subGraphName,
      }, subMetaGraph),
      { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${workspacePublicQuadsDigest(payload)}"`, graph: subMetaGraph },
      { subject: operationSubject, predicate: `${DKG}publicSnapshotGraph`, object: snapshotGraph, graph: subMetaGraph },
      { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: subMetaGraph },
      { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: subMetaGraph },
      { subject: headSubject, predicate: `${DKG}assertionVersion`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: subMetaGraph },
      { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: subMetaGraph },
      { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: subMetaGraph },
    ];
    let verifierRegistered: readonly string[] | undefined;
    const verifier = new SyncVerifyWorker();
    workers.push(verifier);

    const result = await recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase) => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'data') {
          return page([{
            subject: 'urn:remote:legacy',
            predicate: STATUS,
            object: '"must-not-be-admitted"',
            graph: subDataGraph,
          }]);
        }
        return page(payload);
      },
      processSharedMemoryBatch: async (dataQuads, metaQuads, cgId, registered, excluded) => {
        verifierRegistered = registered;
        return verifier.processSharedMemoryBatch(
          dataQuads,
          metaQuads,
          cgId,
          registered,
          excluded,
        );
      },
      store,
      replaceMetaForGraphAssets: async () => {},
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
      getRegisteredSubGraphNames: async () => [],
    });

    expect(verifierRegistered).toEqual([]);
    expect(result).toMatchObject({ completed: true, replacedGraphs: 1, droppedDataTriples: 1 });
    const recovered = await store.query(
      `SELECT ?o WHERE { GRAPH <${assertionGraph}> { <urn:rootless:subgraph> <${STATUS}> ?o } }`,
    );
    expect(recovered.type === 'bindings' ? recovered.bindings.map((row) => row['o']) : [])
      .toEqual(['"recovered"']);
    const recoveredHead = await store.query(
      `SELECT ?shareId WHERE { GRAPH <${subMetaGraph}> { <${headSubject}> <${DKG}shareOperationId> ?shareId } }`,
    );
    expect(recoveredHead.type === 'bindings'
      ? recoveredHead.bindings.map((row) => row['shareId'])
      : []).toEqual([`"${operationId}"`]);
    const recoveredOperation = await store.query(
      `SELECT ?digest WHERE { GRAPH <${subMetaGraph}> { <${operationSubject}> <${DKG}publicQuadsDigest> ?digest } }`,
    );
    expect(recoveredOperation.type === 'bindings'
      ? recoveredOperation.bindings.map((row) => row['digest'])
      : []).toEqual([`"${workspacePublicQuadsDigest(payload)}"`]);
  });

  it('does not mutate exact or legacy data when a graph-backed snapshot is incomplete', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const payload: Quad[] = [
      { subject: 'urn:rootless:partial', predicate: STATUS, object: '"fresh"', graph: '' },
    ];
    const fixture = graphBackedFixture({
      ual: UAL,
      operationId: 'rootless-partial-op',
      payload,
    });
    await store.insert([
      { subject: 'urn:rootless:partial', predicate: STATUS, object: '"stale-safe"', graph: fixture.assertionGraph },
      { subject: SUBJ, predicate: STATUS, object: '"legacy-stale-safe"', graph: WS },
    ]);
    const deletedCheckpoints: string[] = [];

    const result = await recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase): Promise<SyncPageResult> => {
        if (phase === 'meta') return page(fixture.meta);
        if (phase === 'data') {
          return page([{ subject: SUBJ, predicate: STATUS, object: '"legacy-new"', graph: WS }]);
        }
        return { ...page(payload, false), resumedFromOffset: 0, nextOffset: 1 };
      },
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        entityCreators: [{ dataGraph: WS, entity: SUBJ, creator: 'peer-source' }],
        droppedDataTriples: 0,
      }),
      store,
      replaceMetaForGraphAssets: async () => {},
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: (key) => { deletedCheckpoints.push(key); },
    });

    expect(result).toMatchObject({ completed: false, replacedRoots: 0, replacedGraphs: 0 });
    expect(deletedCheckpoints).toContain('k');
    const exact = await store.query(
      `SELECT ?o WHERE { GRAPH <${fixture.assertionGraph}> { <urn:rootless:partial> <${STATUS}> ?o } }`,
    );
    expect(exact.type === 'bindings' ? exact.bindings.map((row) => row['o']) : [])
      .toEqual(['"stale-safe"']);
    expect(await statusValues(store)).toEqual(['"legacy-stale-safe"']);
  });

  it('verifies every graph-scoped asset before mutating the first asset or legacy roots', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const firstPayload: Quad[] = [
      { subject: 'urn:rootless:first', predicate: STATUS, object: '"first-fresh"', graph: '' },
    ];
    const secondPayload: Quad[] = [
      { subject: 'urn:rootless:second', predicate: STATUS, object: '"second-fresh"', graph: '' },
    ];
    const first = graphBackedFixture({
      ual: UAL,
      operationId: 'rootless-first-op',
      payload: firstPayload,
    });
    const second = graphBackedFixture({
      ual: SECOND_UAL,
      operationId: 'rootless-second-op',
      payload: secondPayload,
    });
    await store.insert([
      { subject: 'urn:rootless:first', predicate: STATUS, object: '"first-stale-safe"', graph: first.assertionGraph },
      { subject: 'urn:rootless:second', predicate: STATUS, object: '"second-stale-safe"', graph: second.assertionGraph },
      { subject: SUBJ, predicate: STATUS, object: '"legacy-stale-safe"', graph: WS },
    ]);

    await expect(recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase, graphUri): Promise<SyncPageResult> => {
        if (phase === 'meta') return page([...first.meta, ...second.meta]);
        if (phase === 'data') {
          return page([{ subject: SUBJ, predicate: STATUS, object: '"legacy-new"', graph: WS }]);
        }
        if (graphUri === first.snapshotGraph) return page(firstPayload);
        return page([{ ...secondPayload[0]!, object: '"second-corrupt"' }]);
      },
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        entityCreators: [{ dataGraph: WS, entity: SUBJ, creator: 'peer-source' }],
        droppedDataTriples: 0,
      }),
      store,
      replaceMetaForGraphAssets: async () => {},
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    })).rejects.toThrow('failed integrity');

    const firstAfter = await store.query(
      `SELECT ?o WHERE { GRAPH <${first.assertionGraph}> { <urn:rootless:first> <${STATUS}> ?o } }`,
    );
    expect(firstAfter.type === 'bindings' ? firstAfter.bindings.map((row) => row['o']) : [])
      .toEqual(['"first-stale-safe"']);
    const secondAfter = await store.query(
      `SELECT ?o WHERE { GRAPH <${second.assertionGraph}> { <urn:rootless:second> <${STATUS}> ?o } }`,
    );
    expect(secondAfter.type === 'bindings' ? secondAfter.bindings.map((row) => row['o']) : [])
      .toEqual(['"second-stale-safe"']);
    expect(await statusValues(store)).toEqual(['"legacy-stale-safe"']);
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
    await store.insert([
      { subject: 'urn:rootless:a', predicate: STATUS, object: '"stale-safe"', graph: assertionGraph },
      { subject: SUBJ, predicate: STATUS, object: '"legacy-stale-safe"', graph: WS },
    ]);

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
        return page([{ subject: SUBJ, predicate: STATUS, object: '"legacy-new"', graph: WS }]);
      },
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        entityCreators: [{ dataGraph: WS, entity: SUBJ, creator: 'peer-source' }],
        droppedDataTriples: 0,
      }),
      store,
      publicSnapshotStore: new MemorySnapshotStore(),
      replaceMetaForGraphAssets: async () => {},
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    })).rejects.toThrow('failed digest/count validation');

    const stale = await store.query(
      `SELECT ?o WHERE { GRAPH <${assertionGraph}> { <urn:rootless:a> <${STATUS}> ?o } }`,
    );
    expect(stale.type === 'bindings' ? stale.bindings.map((row) => row['o']) : []).toEqual(['"stale-safe"']);
    expect(await statusValues(store)).toEqual(['"legacy-stale-safe"']);
  });
});
