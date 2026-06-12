import { describe, expect, it } from 'vitest';
import { createOperationContext, contextGraphSharedMemoryMetaUri, contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPhase } from '../src/sync/auth/request-build.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';

const CG_ID = 'sync-owned-cg';
const SUB_GRAPH = 'code';
const ROOT_ENTITY = 'urn:swm:shared-root';
const ROOT_GRAPH = contextGraphSharedMemoryUri(CG_ID);
const SUB_GRAPH_SWM = contextGraphSharedMemoryUri(CG_ID, SUB_GRAPH);
const ROOT_META_GRAPH = contextGraphSharedMemoryMetaUri(CG_ID);
const SUB_GRAPH_META = contextGraphSharedMemoryMetaUri(CG_ID, SUB_GRAPH);
const ROOT_CG_META_GRAPH = `did:dkg:context-graph:${CG_ID}/_meta`;
const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'http://schema.org/name';

function page(quads: Quad[], phase: SyncPhase): SyncPageResult {
  return {
    quads,
    bytesReceived: 1,
    resumedFromOffset: 0,
    nextOffset: quads.length,
    checkpointKey: `${phase}-checkpoint`,
    completed: true,
  };
}

function workspaceOperationMeta(graph: string, op: string, root: string, publisherPeerId: string): Quad[] {
  return [
    { graph, subject: op, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation` },
    { graph, subject: op, predicate: `${DKG}publishedAt`, object: '"2030-01-01T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' },
    { graph, subject: op, predicate: `${DKG}rootEntity`, object: root },
    { graph, subject: op, predicate: `${DKG}publisherPeerId`, object: `"${publisherPeerId}"` },
  ];
}

function subGraphRegistrationMeta(name: string): Quad[] {
  const subject = `did:dkg:context-graph:${CG_ID}/${name}`;
  return [
    { graph: ROOT_CG_META_GRAPH, subject, predicate: RDF_TYPE, object: `${DKG}SubGraph` },
    { graph: ROOT_CG_META_GRAPH, subject, predicate: SCHEMA_NAME, object: `"${name}"` },
    { graph: ROOT_CG_META_GRAPH, subject, predicate: `${DKG}createdBy`, object: '"remote-peer"' },
  ];
}

describe('runSharedMemorySync ownership hydration', () => {
  it('hydrates root and sub-graph SWM ownership under separate keys', async () => {
    const ownedMaps = new Map<string, Map<string, string>>();
    const inserted: Quad[] = [];
    const deletedCheckpoints: string[] = [];

    const dataQuads: Quad[] = [
      { graph: ROOT_GRAPH, subject: ROOT_ENTITY, predicate: 'http://schema.org/name', object: '"root"' },
      { graph: SUB_GRAPH_SWM, subject: ROOT_ENTITY, predicate: 'http://schema.org/name', object: '"sub"' },
    ];

    const summary = await runSharedMemorySync({
      ctx: createOperationContext('sync'),
      remotePeerId: '12D3KooWRequesterOwnership',
      contextGraphIds: [CG_ID],
      createContextGraphSyncDeadline: () => Date.now() + 30_000,
      fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => (
        phase === 'data' ? page(dataQuads, phase) : page([], phase)
      ),
      processSharedMemoryBatch: async () => ({
        verifiedData: dataQuads,
        verifiedMeta: [],
        totalFetchedDataQuads: dataQuads.length,
        totalFetchedMetaQuads: 0,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [
          { dataGraph: ROOT_GRAPH, entity: ROOT_ENTITY, creator: 'peer-root' },
          { dataGraph: SUB_GRAPH_SWM, entity: ROOT_ENTITY, creator: 'peer-sub' },
        ],
      }),
      ensureContextGraph: async () => {},
      storeInsert: async (quads) => {
        inserted.push(...quads);
      },
      deleteCheckpoint: (key) => {
        deletedCheckpoints.push(key);
      },
      setCheckpoint: () => {},
      ensureOwnedMap: (key) => {
        let map = ownedMaps.get(key);
        if (!map) {
          map = new Map<string, string>();
          ownedMaps.set(key, map);
        }
        return map;
      },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.failedPeers).toBe(0);
    expect(summary.insertedDataTriples).toBe(2);
    expect(inserted).toHaveLength(2);
    expect(deletedCheckpoints.sort()).toEqual(['data-checkpoint', 'meta-checkpoint']);
    expect(ownedMaps.get(CG_ID)?.get(ROOT_ENTITY)).toBe('peer-root');
    expect(ownedMaps.get(`${CG_ID}\0${SUB_GRAPH}`)?.get(ROOT_ENTITY)).toBe('peer-sub');
  });

  it('accepts sub-graph SWM when the remote registration is replicated in the same meta batch', async () => {
    const worker = new SyncVerifyWorker();
    const ownedMaps = new Map<string, Map<string, string>>();
    const inserted: Quad[] = [];
    const dataQuads: Quad[] = [
      { graph: SUB_GRAPH_SWM, subject: ROOT_ENTITY, predicate: 'http://schema.org/name', object: '"remote-sub"' },
    ];
    const metaQuads: Quad[] = [
      ...subGraphRegistrationMeta(SUB_GRAPH),
      ...workspaceOperationMeta(SUB_GRAPH_META, 'urn:dkg:share:remote-sub', ROOT_ENTITY, 'peer-remote-sub'),
    ];

    try {
      const summary = await runSharedMemorySync({
        ctx: createOperationContext('sync'),
        remotePeerId: '12D3KooWRequesterReplicatedRegistration',
        contextGraphIds: [CG_ID],
        createContextGraphSyncDeadline: () => Date.now() + 30_000,
        fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => (
          phase === 'data' ? page(dataQuads, phase) : page(metaQuads, phase)
        ),
        processSharedMemoryBatch: (wsDataQuads, wsMetaQuads, contextGraphId, registeredSubGraphNames) =>
          worker.processSharedMemoryBatch(wsDataQuads, wsMetaQuads, contextGraphId, registeredSubGraphNames),
        getRegisteredSubGraphNames: async () => [],
        ensureContextGraph: async () => {},
        storeInsert: async (quads) => {
          inserted.push(...quads);
        },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: (key) => {
          let map = ownedMaps.get(key);
          if (!map) {
            map = new Map<string, string>();
            ownedMaps.set(key, map);
          }
          return map;
        },
        logInfo: () => {},
        logWarn: () => {},
        logDebug: () => {},
      });

      expect(summary.failedPeers).toBe(0);
      expect(summary.droppedDataTriples).toBe(0);
      expect(summary.insertedDataTriples).toBe(1);
      expect(inserted.some((quad) => quad.graph === ROOT_CG_META_GRAPH && quad.predicate === SCHEMA_NAME)).toBe(true);
      expect(inserted.some((quad) => quad.graph === SUB_GRAPH_SWM)).toBe(true);
      expect(ownedMaps.get(`${CG_ID}\0${SUB_GRAPH}`)?.get(ROOT_ENTITY)).toBe('peer-remote-sub');
    } finally {
      await worker.close();
    }
  });

  it('accepts descendant SWM data graphs verified by their bucket meta graph', async () => {
    const worker = new SyncVerifyWorker();
    const ownedMaps = new Map<string, Map<string, string>>();
    const inserted: Quad[] = [];

    const rootDescendantGraph = `${ROOT_GRAPH}/0xabc/1`;
    const subDescendantGraph = `${SUB_GRAPH_SWM}/0xdef/2`;
    const rootSubEntity = `${ROOT_ENTITY}/.well-known/genid/root-child`;
    const subEntity = 'urn:swm:sub-descendant-root';
    const dataQuads: Quad[] = [
      { graph: rootDescendantGraph, subject: rootSubEntity, predicate: 'http://schema.org/name', object: '"root-descendant"' },
      { graph: subDescendantGraph, subject: subEntity, predicate: 'http://schema.org/name', object: '"sub-descendant"' },
    ];
    const metaQuads: Quad[] = [
      ...workspaceOperationMeta(ROOT_META_GRAPH, 'urn:dkg:share:root-descendant', ROOT_ENTITY, 'peer-root-descendant'),
      ...workspaceOperationMeta(SUB_GRAPH_META, 'urn:dkg:share:sub-descendant', subEntity, 'peer-sub-descendant'),
    ];

    try {
      const summary = await runSharedMemorySync({
        ctx: createOperationContext('sync'),
        remotePeerId: '12D3KooWRequesterDescendantSwm',
        contextGraphIds: [CG_ID],
        createContextGraphSyncDeadline: () => Date.now() + 30_000,
        fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => (
          phase === 'data' ? page(dataQuads, phase) : page(metaQuads, phase)
        ),
        processSharedMemoryBatch: (wsDataQuads, wsMetaQuads, contextGraphId) =>
          worker.processSharedMemoryBatch(wsDataQuads, wsMetaQuads, contextGraphId, [SUB_GRAPH]),
        getRegisteredSubGraphNames: async () => [SUB_GRAPH],
        ensureContextGraph: async () => {},
        storeInsert: async (quads) => {
          inserted.push(...quads);
        },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: (key) => {
          let map = ownedMaps.get(key);
          if (!map) {
            map = new Map<string, string>();
            ownedMaps.set(key, map);
          }
          return map;
        },
        logInfo: () => {},
        logWarn: () => {},
        logDebug: () => {},
      });

      expect(summary.failedPeers).toBe(0);
      expect(summary.droppedDataTriples).toBe(0);
      expect(summary.insertedDataTriples).toBe(2);
      const insertedDataGraphs = inserted
        .filter((quad) => quad.predicate === 'http://schema.org/name')
        .map((quad) => quad.graph)
        .sort();
      expect(insertedDataGraphs).toEqual([rootDescendantGraph, subDescendantGraph].sort());
      expect(ownedMaps.get(CG_ID)?.get(ROOT_ENTITY)).toBe('peer-root-descendant');
      expect(ownedMaps.get(`${CG_ID}\0${SUB_GRAPH}`)?.get(subEntity)).toBe('peer-sub-descendant');
    } finally {
      await worker.close();
    }
  });

  it('rejects malformed descendant SWM data graphs under an otherwise valid bucket', async () => {
    const worker = new SyncVerifyWorker();
    const inserted: Quad[] = [];
    const malformedDescendantGraph = `${ROOT_GRAPH}/0xabc/1/extra`;
    const metaQuads = workspaceOperationMeta(ROOT_META_GRAPH, 'urn:dkg:share:malformed-descendant', ROOT_ENTITY, 'peer-root');
    const dataQuads: Quad[] = [
      { graph: malformedDescendantGraph, subject: ROOT_ENTITY, predicate: 'http://schema.org/name', object: '"malformed-descendant"' },
    ];

    try {
      const summary = await runSharedMemorySync({
        ctx: createOperationContext('sync'),
        remotePeerId: '12D3KooWRequesterMalformedDescendant',
        contextGraphIds: [CG_ID],
        createContextGraphSyncDeadline: () => Date.now() + 30_000,
        fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => (
          phase === 'data' ? page(dataQuads, phase) : page(metaQuads, phase)
        ),
        processSharedMemoryBatch: (wsDataQuads, wsMetaQuads, contextGraphId) =>
          worker.processSharedMemoryBatch(wsDataQuads, wsMetaQuads, contextGraphId),
        ensureContextGraph: async () => {},
        storeInsert: async (quads) => {
          inserted.push(...quads);
        },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: () => new Map<string, string>(),
        logInfo: () => {},
        logWarn: () => {},
        logDebug: () => {},
      });

      expect(summary.failedPeers).toBe(0);
      expect(summary.droppedDataTriples).toBe(1);
      expect(summary.insertedDataTriples).toBe(0);
      expect(inserted.some((quad) => quad.graph === malformedDescendantGraph)).toBe(false);
    } finally {
      await worker.close();
    }
  });

  it('rejects descendant data graphs derived from non-SWM _meta graphs', async () => {
    const worker = new SyncVerifyWorker();
    const inserted: Quad[] = [];
    const fakeMetaGraph = `did:dkg:context-graph:${CG_ID}/foo_meta`;
    const fakeDataGraph = `did:dkg:context-graph:${CG_ID}/foo/bar`;
    const metaQuads = workspaceOperationMeta(fakeMetaGraph, 'urn:dkg:share:fake-meta', 'urn:swm:fake', 'peer-fake');
    const dataQuads: Quad[] = [
      { graph: fakeDataGraph, subject: 'urn:swm:fake', predicate: 'http://schema.org/name', object: '"fake-descendant"' },
    ];

    try {
      const summary = await runSharedMemorySync({
        ctx: createOperationContext('sync'),
        remotePeerId: '12D3KooWRequesterFakeMeta',
        contextGraphIds: [CG_ID],
        createContextGraphSyncDeadline: () => Date.now() + 30_000,
        fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => (
          phase === 'data' ? page(dataQuads, phase) : page(metaQuads, phase)
        ),
        processSharedMemoryBatch: (wsDataQuads, wsMetaQuads, contextGraphId) =>
          worker.processSharedMemoryBatch(wsDataQuads, wsMetaQuads, contextGraphId),
        ensureContextGraph: async () => {},
        storeInsert: async (quads) => {
          inserted.push(...quads);
        },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: () => new Map<string, string>(),
        logInfo: () => {},
        logWarn: () => {},
        logDebug: () => {},
      });

      expect(summary.failedPeers).toBe(0);
      expect(summary.droppedDataTriples).toBe(1);
      expect(summary.insertedDataTriples).toBe(0);
      expect(inserted.some((quad) => quad.graph === fakeDataGraph)).toBe(false);
    } finally {
      await worker.close();
    }
  });

  it('rejects descendant data graphs derived from nested fake SWM buckets', async () => {
    const worker = new SyncVerifyWorker();
    const inserted: Quad[] = [];
    const fakeMetaGraph = `did:dkg:context-graph:${CG_ID}/nested/fake/_shared_memory_meta`;
    const fakeDataGraph = `did:dkg:context-graph:${CG_ID}/nested/fake/_shared_memory/0xabc/1`;
    const metaQuads = workspaceOperationMeta(fakeMetaGraph, 'urn:dkg:share:nested-fake', 'urn:swm:nested-fake', 'peer-fake');
    const dataQuads: Quad[] = [
      { graph: fakeDataGraph, subject: 'urn:swm:nested-fake', predicate: 'http://schema.org/name', object: '"nested-fake-descendant"' },
    ];

    try {
      const summary = await runSharedMemorySync({
        ctx: createOperationContext('sync'),
        remotePeerId: '12D3KooWRequesterNestedFake',
        contextGraphIds: [CG_ID],
        createContextGraphSyncDeadline: () => Date.now() + 30_000,
        fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => (
          phase === 'data' ? page(dataQuads, phase) : page(metaQuads, phase)
        ),
        processSharedMemoryBatch: (wsDataQuads, wsMetaQuads, contextGraphId) =>
          worker.processSharedMemoryBatch(wsDataQuads, wsMetaQuads, contextGraphId),
        ensureContextGraph: async () => {},
        storeInsert: async (quads) => {
          inserted.push(...quads);
        },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: () => new Map<string, string>(),
        logInfo: () => {},
        logWarn: () => {},
        logDebug: () => {},
      });

      expect(summary.failedPeers).toBe(0);
      expect(summary.droppedDataTriples).toBe(1);
      expect(summary.insertedDataTriples).toBe(0);
      expect(inserted.some((quad) => quad.graph === fakeDataGraph)).toBe(false);
    } finally {
      await worker.close();
    }
  });

  it('rejects unregistered child-CG-shaped SWM descendants', async () => {
    const worker = new SyncVerifyWorker();
    const inserted: Quad[] = [];
    const childMetaGraph = contextGraphSharedMemoryMetaUri(CG_ID, 'child');
    const childDataGraph = `${contextGraphSharedMemoryUri(CG_ID, 'child')}/0xabc/1`;
    const metaQuads = workspaceOperationMeta(childMetaGraph, 'urn:dkg:share:child-cg', 'urn:swm:child-cg', 'peer-child');
    const dataQuads: Quad[] = [
      { graph: childDataGraph, subject: 'urn:swm:child-cg', predicate: 'http://schema.org/name', object: '"child-cg-descendant"' },
    ];

    try {
      const summary = await runSharedMemorySync({
        ctx: createOperationContext('sync'),
        remotePeerId: '12D3KooWRequesterChildCgFake',
        contextGraphIds: [CG_ID],
        createContextGraphSyncDeadline: () => Date.now() + 30_000,
        fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => (
          phase === 'data' ? page(dataQuads, phase) : page(metaQuads, phase)
        ),
        processSharedMemoryBatch: (wsDataQuads, wsMetaQuads, contextGraphId, registeredSubGraphNames) =>
          worker.processSharedMemoryBatch(wsDataQuads, wsMetaQuads, contextGraphId, registeredSubGraphNames),
        getRegisteredSubGraphNames: async () => [],
        ensureContextGraph: async () => {},
        storeInsert: async (quads) => {
          inserted.push(...quads);
        },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: () => new Map<string, string>(),
        logInfo: () => {},
        logWarn: () => {},
        logDebug: () => {},
      });

      expect(summary.failedPeers).toBe(0);
      expect(summary.droppedDataTriples).toBe(1);
      expect(summary.insertedDataTriples).toBe(0);
      expect(inserted.some((quad) => quad.graph === childDataGraph)).toBe(false);
    } finally {
      await worker.close();
    }
  });
});
