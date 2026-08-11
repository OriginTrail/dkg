import { describe, expect, it } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  isGraphScopedDurableManifestBoundary,
  planBoundedGraphScopedDurableBatch,
} from '../src/sync/durable-integrity.js';
import {
  runDurableSync,
  type DurableSyncFetchRequest,
  type DurableSyncGraphScopedStoreRequest,
  type DurableSyncStoreInsertRequest,
} from '../src/sync/requester/durable-sync.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';
import { processDurableBatchForWire } from '../src/sync-verify-worker-impl.js';
import type {
  DurableBatchVerificationMode,
} from '../src/sync-verify-worker.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const CONTEXT_GRAPH_ID = 'rootless-bounded-progress';
const CONTEXT_GRAPH_URI = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`;
const ctx = { operationId: 'bounded-rootless', operationName: 'sync' } as OperationContext;

interface AssetFixture {
  ual: string;
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
  const privateQuads: Quad[] = tripleCount === 0 ? [{
    subject: `urn:bounded:${kaNumber}:private`,
    predicate: 'urn:bounded:value',
    object: '"private"',
    graph: '',
  }] : [];
  const privateMerkleRoot = computePrivateRootV10(privateQuads);
  const meta = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId: CONTEXT_GRAPH_ID,
    merkleRoot: computeFlatKCRootV10(
      payload,
      privateMerkleRoot ? [privateMerkleRoot] : [],
    ),
    publisherPeerId: 'publisher-peer',
    accessPolicy: 'public',
    timestamp: new Date(0),
    assertionVersion: '1',
    publicTripleCount: payload.length,
    privateTripleCount: privateQuads.length,
    ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
    assertionGraph: graph,
  }, { status: 'tentative' });
  return { ual, graph, payload, meta };
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
    expect(plan?.manifestRowCount).toBe(12);
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

  it('drops rows after the first incomplete graph and preserves the safe leading prefix', () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const rawData = [
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload.slice(0, 2),
      ...fixtures[2]!.payload,
    ];

    const plan = planBoundedGraphScopedDurableBatch(
      rawData,
      meta,
      0,
      rawData.length,
      false,
    );

    expect(plan).not.toBeNull();
    expect(plan?.safeNextOffset).toBe(4);
    expect(plan?.manifestRowCount).toBe(12);
    expect(plan?.completedGraphCount).toBe(1);
    expect(plan?.changedDataGraphs).toEqual([fixtures[0]!.graph]);
    expect(plan?.dataQuads).toEqual(fixtures[0]!.payload);
  });

  it('preserves the safe prefix when an older responder cursor advances past missing rows', () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const rawData = [
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload.slice(0, 2),
      ...fixtures[2]!.payload,
    ];

    const plan = planBoundedGraphScopedDurableBatch(
      rawData,
      meta,
      0,
      rawData.length + 63,
      false,
    );

    expect(plan).not.toBeNull();
    expect(plan?.safeNextOffset).toBe(4);
    expect(plan?.completedGraphCount).toBe(1);
    expect(plan?.changedDataGraphs).toEqual([fixtures[0]!.graph]);
    expect(plan?.dataQuads).toEqual(fixtures[0]!.payload);
  });

  it('does not checkpoint a corrupt leading graph while dropping a non-contiguous tail', async () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const corruptLeading = fixtures[0]!.payload.map((quad, index) => index === 0
      ? { ...quad, object: '"tampered"' }
      : quad);
    const rawData = [
      ...corruptLeading,
      ...fixtures[1]!.payload.slice(0, 2),
      ...fixtures[2]!.payload,
    ];
    const materialized: string[] = [];
    const checkpoints: Array<[string, number]> = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-non-contiguous',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
        ? pageResult('meta', { quads: meta, nextOffset: meta.length })
        : pageResult('data', {
          quads: rawData,
          nextOffset: rawData.length,
          completed: false,
          timedOut: true,
        }),
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        materialized.push(asset.ual);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: (key, offset) => { checkpoints.push([key, offset]); },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.rejectedKcs).toBe(1);
    expect(summary.insertedDataTriples).toBe(0);
    expect(materialized).toEqual([]);
    expect(checkpoints).toEqual([]);
  });

  it('ignores a non-IRI dkg:partOf poison row and still projects the valid boundary (#1921)', () => {
    // A peer can attach `_:bad dkg:partOf "<valid-ual>"` to a valid graph-scoped
    // manifest. Without the bounded planner's #1921 verification-input sanitize,
    // readIntegrityMetadata's PART_OF scan would invalidate that valid UAL →
    // planBoundedGraphScopedDurableBatch returns null → timed-out graph-scoped
    // progress is lost (sync pins). The sanitize keeps non-IRI subjects out of
    // verification, so the planner still projects the same safe prefix as the
    // clean case above. Mutation check: remove the iriMetaQuads filter from
    // planBoundedGraphScopedDurableBatch and this returns null.
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const poison: Quad = {
      subject: '_:bad',
      predicate: 'http://dkg.io/ontology/partOf',
      object: `"${fixtures[0]!.ual}"`,
      graph: `${CONTEXT_GRAPH_URI}/_meta`,
    };
    const rawData = [
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload,
      ...fixtures[2]!.payload.slice(0, 2),
    ];

    const plan = planBoundedGraphScopedDurableBatch(
      rawData,
      [...meta, poison],
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
    const materialized: Array<{ dataQuads: Quad[] }> = [];
    const checkpoints: Array<[string, number]> = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
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
      storeInsert: async ({ quads }: DurableSyncStoreInsertRequest) => {
        inserted.push(quads);
      },
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        materialized.push(asset);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: (key, offset) => { checkpoints.push([key, offset]); },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.rejectedKcs).toBe(0);
    expect(summary.complete).toBe(false);
    expect(summary.timedOutPhases).toBe(1);
    expect(summary.insertedDataTriples).toBe(8);
    expect(checkpoints).toContainEqual([`${CONTEXT_GRAPH_ID}:data`, 8]);
    expect(materialized.flatMap((entry) => entry.dataQuads)).toEqual([
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload,
    ]);
    expect(materialized.flatMap((entry) => entry.dataQuads)
      .some((quad) => quad.graph === fixtures[2]!.graph)).toBe(false);
    expect(inserted.flat().some((quad) => fixtures.some((entry) => entry.graph === quad.graph))).toBe(false);
  });

  it('reports assets committed before a later materialization failure without advancing the page checkpoint', async () => {
    const fixtures = orderedAssets();
    const selected = fixtures.slice(0, 2);
    const meta = selected.flatMap((entry) => entry.meta);
    const data = selected.flatMap((entry) => entry.payload);
    const materialized: Array<{ dataQuads: Quad[]; metadataQuads: Quad[] }> = [];
    const checkpoints: Array<[string, number]> = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
        ? pageResult('meta', { quads: meta, nextOffset: meta.length })
        : pageResult('data', { quads: data, nextOffset: data.length }),
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        if (materialized.length === 1) throw new Error('transient chain lookup timeout');
        materialized.push(asset);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: (key, offset) => { checkpoints.push([key, offset]); },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.failedPhases).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summary.insertedDataTriples).toBe(materialized[0]!.dataQuads.length);
    expect(summary.insertedMetaTriples).toBe(materialized[0]!.metadataQuads.length);
    expect(summary.insertedTriples).toBe(
      materialized[0]!.dataQuads.length + materialized[0]!.metadataQuads.length,
    );
    expect(checkpoints).toEqual([]);
  });

  it('keeps a 20-asset exact request incomplete when the responder returns only 6 descriptors', async () => {
    const requested = Array.from({ length: 20 }, (_, index) => asset(index + 1))
      .sort((left, right) => left.graph.localeCompare(right.graph));
    const returned = requested.slice(0, 6);
    const meta = returned.flatMap((entry) => entry.meta);
    const data = returned.flatMap((entry) => entry.payload);
    const materialized: string[] = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-partial-host',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      exactAssetUalsFor: () => requested.map((entry) => entry.ual),
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
        ? pageResult('meta', { quads: meta, nextOffset: meta.length })
        : pageResult('data', { quads: data, nextOffset: data.length }),
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        materialized.push(asset.ual);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(materialized).toEqual(returned.map((entry) => entry.ual));
    expect(summary.insertedDataTriples).toBe(data.length);
    expect(summary.complete).toBe(false);
  });

  it('counts a verified zero-public descriptor toward exact-request coverage', async () => {
    const requested = [asset(1, 4), asset(2, 0)]
      .sort((left, right) => left.graph.localeCompare(right.graph));
    const meta = requested.flatMap((entry) => entry.meta);
    const data = requested.flatMap((entry) => entry.payload);
    const materialized: Array<{ ual: string; dataCount: number }> = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-complete-host',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      exactAssetUalsFor: () => requested.map((entry) => entry.ual),
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
        ? pageResult('meta', { quads: meta, nextOffset: meta.length })
        : pageResult('data', { quads: data, nextOffset: data.length }),
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        materialized.push({ ual: asset.ual, dataCount: asset.dataQuads.length });
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(materialized).toEqual(requested.map((entry) => ({
      ual: entry.ual,
      dataCount: entry.payload.length,
    })));
    expect(summary.complete).toBe(true);
  });

  it('checkpoints a cleanly-closed rootless prefix instead of replaying it from zero', async () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const cleanPrefix = fixtures[0]!.payload;
    const materialized: Array<{ dataQuads: Quad[] }> = [];
    const checkpoints: Array<[string, number]> = [];
    const deleted: string[] = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
        ? pageResult('meta', {
          quads: meta,
          nextOffset: meta.length,
        })
        : pageResult('data', {
          quads: cleanPrefix,
          nextOffset: cleanPrefix.length,
          completed: true,
          timedOut: false,
        }),
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        materialized.push(asset);
        return 'applied';
      },
      deleteCheckpoint: (key) => { deleted.push(key); },
      setCheckpoint: (key, offset) => { checkpoints.push([key, offset]); },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.rejectedKcs).toBe(0);
    expect(summary.complete).toBe(false);
    expect(summary.timedOutPhases).toBe(0);
    expect(summary.insertedDataTriples).toBe(cleanPrefix.length);
    expect(summary.completedPhases).toBe(1);
    expect(checkpoints).toContainEqual([`${CONTEXT_GRAPH_ID}:data`, cleanPrefix.length]);
    expect(deleted).not.toContain(`${CONTEXT_GRAPH_ID}:data`);
    expect(materialized.flatMap((entry) => entry.dataQuads)).toEqual(cleanPrefix);
  });

  it('verifies the remaining suffix and cleanly completes a resumed snapshot', async () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const suffix = fixtures[2]!.payload;
    const inserted: Quad[][] = [];
    const materialized: Array<{ dataQuads: Quad[] }> = [];
    const deleted: string[] = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
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
      storeInsert: async ({ quads }: DurableSyncStoreInsertRequest) => {
        inserted.push(quads);
      },
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        materialized.push(asset);
        return 'applied';
      },
      deleteCheckpoint: (key) => { deleted.push(key); },
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.rejectedKcs).toBe(0);
    expect(summary.complete).toBe(true);
    expect(summary.timedOutPhases).toBe(0);
    expect(summary.insertedDataTriples).toBe(4);
    expect(summary.completedPhases).toBe(2);
    expect(deleted).toContain(`${CONTEXT_GRAPH_ID}:data`);
    expect(materialized.flatMap((entry) => entry.dataQuads)).toEqual(suffix);
    expect(inserted.flat().some((quad) => quad.graph === fixtures[2]!.graph)).toBe(false);
  });

  it('resets a checkpoint that resumes inside an exact assertion graph', async () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const misalignedOffset = 1;
    const suffix = [
      ...fixtures[0]!.payload.slice(misalignedOffset),
      ...fixtures[1]!.payload,
    ];
    const deleted: string[] = [];
    const materialized: string[] = [];
    const warnings: string[] = [];
    let verificationCalls = 0;

    expect(isGraphScopedDurableManifestBoundary(meta, 0)).toBe(true);
    expect(isGraphScopedDurableManifestBoundary(meta, 4)).toBe(true);
    expect(isGraphScopedDurableManifestBoundary(meta, misalignedOffset)).toBe(false);
    expect(isGraphScopedDurableManifestBoundary(meta, 13)).toBe(false);

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-misaligned-resume',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
        ? pageResult('meta', { quads: meta, nextOffset: meta.length })
        : pageResult('data', {
          quads: suffix,
          resumedFromOffset: misalignedOffset,
          nextOffset: misalignedOffset + suffix.length,
          completed: false,
          timedOut: true,
        }),
      processDurableBatchInWorker: (...args) => {
        verificationCalls += 1;
        return processBatch(...args);
      },
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        materialized.push(asset.ual);
        return 'applied';
      },
      deleteCheckpoint: (key) => { deleted.push(key); },
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: (_ctx, message) => { warnings.push(message); },
      logDebug: () => {},
    });

    expect(summary.insertedTriples).toBe(0);
    expect(summary.failedPhases).toBe(1);
    expect(verificationCalls).toBe(0);
    expect(materialized).toEqual([]);
    expect(deleted).toContain(`${CONTEXT_GRAPH_ID}:data`);
    expect(warnings.some((message) => message.includes(
      'resumed offset 1 is inside an assertion graph',
    ))).toBe(true);
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
