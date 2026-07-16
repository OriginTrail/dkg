import { describe, expect, it } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  planBoundedGraphScopedDurableBatch,
} from '../src/sync/durable-integrity.js';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import { processDurableBatchForWire } from '../src/sync-verify-worker-impl.js';
import type {
  DurableBatchVerificationMode,
} from '../src/sync-verify-worker.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const CONTEXT_GRAPH_ID = 'rootless-bounded-progress';
const CONTEXT_GRAPH_URI = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`;
const ctx = { operationId: 'bounded-rootless', operationName: 'sync' } as OperationContext;

interface AssetFixture {
  graph: string;
  payload: Quad[];
  meta: Quad[];
}

function asset(kaNumber: number, tripleCount = 4): AssetFixture {
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/${kaNumber}`;
  const scope = createGraphKnowledgeAssetScope(ual, '1');
  const graph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.VerifiableMemory,
    scope,
  );
  const payload = Array.from({ length: tripleCount }, (_, index): Quad => ({
    subject: `urn:bounded:${kaNumber}:${index}`,
    predicate: 'urn:bounded:value',
    object: `"${index}"`,
    graph,
  }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId: CONTEXT_GRAPH_ID,
    merkleRoot: computeFlatKCRootV10(payload, []),
    publisherPeerId: 'publisher-peer',
    accessPolicy: 'public',
    timestamp: new Date(0),
    assertionVersion: '1',
    publicTripleCount: payload.length,
    privateTripleCount: 0,
    assertionGraph: graph,
  }, 'tentative');
  return { graph, payload, meta };
}

function orderedAssets(): AssetFixture[] {
  return [asset(1), asset(2), asset(3)]
    .sort((left, right) => left.graph.localeCompare(right.graph));
}

function pageResult(
  phase: 'data' | 'meta',
  overrides: Partial<SyncPageResult>,
): SyncPageResult {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: `${CONTEXT_GRAPH_ID}:${phase}`,
    completed: true,
    timedOut: false,
    ...overrides,
  };
}

function processBatch(
  dataQuads: Quad[],
  metaQuads: Quad[],
  _ctx: OperationContext,
  acceptUnverified: boolean,
  mode: DurableBatchVerificationMode,
) {
  const wire = processDurableBatchForWire(dataQuads, metaQuads, acceptUnverified, mode);
  return {
    verifiedData: wire.verifiedDataIndexes.map((index) => dataQuads[index]!),
    verifiedMeta: wire.verifiedMetaIndexes.map((index) => metaQuads[index]!),
    verifiedGraphScopedDataGraphs: wire.verifiedGraphScopedDataGraphs,
    droppedSyncControlTriples: wire.droppedSyncControlTriples,
    verifiedPrivateOnlyResponses: wire.verifiedPrivateOnlyResponses,
    totalFetchedDataQuads: wire.totalFetchedDataQuads,
    totalFetchedMetaQuads: wire.totalFetchedMetaQuads,
    rejectedKcs: wire.rejectedKcs,
    emptyResponses: wire.emptyResponses,
    metaOnlyResponses: wire.metaOnlyResponses,
    dataRejectedMissingMeta: wire.dataRejectedMissingMeta,
  };
}

describe('bounded rootless durable progress', () => {
  it('projects a timed-out response to the last complete exact-graph boundary', () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const rawData = [
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload,
      ...fixtures[2]!.payload.slice(0, 2),
    ];

    const plan = planBoundedGraphScopedDurableBatch(
      rawData,
      meta,
      0,
      rawData.length,
      false,
    );

    expect(plan).not.toBeNull();
    expect(plan?.safeNextOffset).toBe(8);
    expect(plan?.completedGraphCount).toBe(2);
    expect(plan?.changedDataGraphs).toEqual([
      fixtures[0]!.graph,
      fixtures[1]!.graph,
    ]);
    expect(plan?.dataQuads).toEqual([
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload,
    ]);
  });

  it('replays one complete graph when timeout lands exactly on a boundary', () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const rawData = [
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload,
    ];

    const plan = planBoundedGraphScopedDurableBatch(
      rawData,
      meta,
      0,
      rawData.length,
      false,
    );

    expect(plan?.safeNextOffset).toBe(4);
    expect(plan?.completedGraphCount).toBe(1);
    expect(plan?.dataQuads).toEqual(fixtures[0]!.payload);
  });

  it('stores the verified prefix and checkpoints only its safe row offset', async () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const rawData = [
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload,
      ...fixtures[2]!.payload.slice(0, 2),
    ];
    const inserted: Quad[][] = [];
    const checkpoints: Array<[string, number]> = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx,
        _peer,
        _contextGraphId,
        _includeSharedMemory,
        phase,
      ) => phase === 'meta'
        ? pageResult('meta', {
          quads: meta,
          nextOffset: meta.length,
        })
        : pageResult('data', {
          quads: rawData,
          nextOffset: rawData.length,
          completed: false,
          timedOut: true,
        }),
      processDurableBatchInWorker: processBatch,
      storeInsert: async (quads) => { inserted.push(quads); },
      deleteCheckpoint: () => {},
      setCheckpoint: (key, offset) => { checkpoints.push([key, offset]); },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.rejectedKcs).toBe(0);
    expect(summary.timedOutPhases).toBe(1);
    expect(summary.insertedDataTriples).toBe(8);
    expect(checkpoints).toContainEqual([`${CONTEXT_GRAPH_ID}:data`, 8]);
    expect(inserted[0]).toEqual([
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload,
    ]);
    expect(inserted.flat().some((quad) => quad.graph === fixtures[2]!.graph)).toBe(false);
  });

  it('verifies the remaining suffix and cleanly completes a resumed snapshot', async () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const suffix = fixtures[2]!.payload;
    const inserted: Quad[][] = [];
    const deleted: string[] = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx,
        _peer,
        _contextGraphId,
        _includeSharedMemory,
        phase,
      ) => phase === 'meta'
        ? pageResult('meta', {
          quads: meta,
          nextOffset: meta.length,
        })
        : pageResult('data', {
          quads: suffix,
          resumedFromOffset: 8,
          nextOffset: 12,
          completed: true,
          timedOut: false,
        }),
      processDurableBatchInWorker: processBatch,
      storeInsert: async (quads) => { inserted.push(quads); },
      deleteCheckpoint: (key) => { deleted.push(key); },
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.rejectedKcs).toBe(0);
    expect(summary.timedOutPhases).toBe(0);
    expect(summary.insertedDataTriples).toBe(4);
    expect(summary.completedPhases).toBe(2);
    expect(deleted).toContain(`${CONTEXT_GRAPH_ID}:data`);
    expect(inserted[0]).toEqual(suffix);
  });

  it('fails closed for mixed legacy and graph-scoped metadata', () => {
    const fixtures = orderedAssets();
    const mixedMeta = [
      ...fixtures.flatMap((entry) => entry.meta),
      {
        subject: 'did:dkg:legacy:1',
        predicate: 'http://dkg.io/ontology/merkleRoot',
        object: '"00"',
        graph: `${CONTEXT_GRAPH_URI}/_meta`,
      } as Quad,
    ];
    const rawData = [
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload,
      ...fixtures[2]!.payload.slice(0, 2),
    ];

    expect(planBoundedGraphScopedDurableBatch(
      rawData,
      mixedMeta,
      0,
      rawData.length,
      false,
    )).toBeNull();
  });
});
