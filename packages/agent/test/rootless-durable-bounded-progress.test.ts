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
  createGraphScopedDurableManifestPlan,
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

function manifest(meta: readonly Quad[]) {
  const plan = createGraphScopedDurableManifestPlan(meta, CONTEXT_GRAPH_ID);
  if (!plan) throw new Error('test fixture did not produce a graph-scoped manifest');
  return plan;
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
      manifest(meta),
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
      manifest(meta),
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
      manifest(meta),
      0,
      rawData.length + 63,
      false,
      0,
      rawData.map((_, index) => index),
    );

    expect(plan).not.toBeNull();
    expect(plan?.safeNextOffset).toBe(4);
    expect(plan?.safeRawNextOffset).toBe(4);
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
      setCheckpoint: (key, checkpoint) => { checkpoints.push([key, checkpoint.offset]); },
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
      manifest([...meta, poison]),
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
      manifest(meta),
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
    const freshSessions: Array<['data' | 'meta', boolean | undefined]> = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
        forceFreshSession,
      }: DurableSyncFetchRequest) => {
        freshSessions.push([phase, forceFreshSession]);
        return phase === 'meta'
          ? pageResult('meta', {
            quads: meta,
            nextOffset: meta.length,
          })
          : pageResult('data', {
            quads: rawData,
            nextOffset: rawData.length,
            completed: false,
            timedOut: true,
          });
      },
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
      setCheckpoint: (key, checkpoint) => { checkpoints.push([key, checkpoint.offset]); },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.rejectedKcs).toBe(0);
    expect(summary.complete).toBe(false);
    expect(summary.timedOutPhases).toBe(1);
    expect(summary.insertedDataTriples).toBe(8);
    expect(checkpoints).toContainEqual([`${CONTEXT_GRAPH_ID}:data`, 8]);
    expect(checkpoints.some(([key]) => key === `${CONTEXT_GRAPH_ID}:meta`)).toBe(false);
    expect(freshSessions).toEqual([
      ['meta', true],
      ['data', false],
    ]);
    expect(materialized.flatMap((entry) => entry.dataQuads)).toEqual([
      ...fixtures[0]!.payload,
      ...fixtures[1]!.payload,
    ]);
    expect(materialized.flatMap((entry) => entry.dataQuads)
      .some((quad) => quad.graph === fixtures[2]!.graph)).toBe(false);
    expect(inserted.flat().some((quad) => fixtures.some((entry) => entry.graph === quad.graph))).toBe(false);
  });

  it('persists an authenticated asset prefix before a later authentication deadline', async () => {
    const fixtures = orderedAssets();
    const selected = fixtures.slice(0, 2);
    const meta = selected.flatMap((entry) => entry.meta);
    const data = selected.flatMap((entry) => entry.payload);
    const manifest = createGraphScopedDurableManifestPlan(meta, CONTEXT_GRAPH_ID)!;
    const materialized: Array<{ dataQuads: Quad[]; metadataQuads: Quad[] }> = [];
    const checkpoints: Array<{
      key: string;
      offset: number;
      manifestDigest?: string;
      manifestPrefixDigest?: string;
      terminal?: boolean;
      responderSessionOffset?: number;
    }> = [];

    const firstSummary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
        ? pageResult('meta', { quads: meta, nextOffset: meta.length })
        : pageResult('data', {
            quads: data,
            quadRawOffsets: [1, 2, 3, 4, 6, 7, 8, 9],
            rawNextOffset: 10,
            nextOffset: data.length,
          }),
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        if (materialized.length === 1) {
          throw new Error(
            `Graph-scoped durable authentication for ${asset.ual} exceeded its context-graph deadline`,
          );
        }
        materialized.push(asset);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: (key, checkpoint) => {
        checkpoints.push({
          key,
          offset: checkpoint.offset,
          manifestDigest: checkpoint.binding?.manifestDigest,
          manifestPrefixDigest: checkpoint.binding?.manifestPrefixDigest,
          terminal: checkpoint.binding?.terminal,
          responderSessionOffset: checkpoint.responderSessionOffset,
        });
      },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(firstSummary.failedPhases).toBe(1);
    expect(firstSummary.complete).toBe(false);
    expect(firstSummary.checkpointAdvances).toBe(1);
    expect(firstSummary.insertedDataTriples).toBe(materialized[0]!.dataQuads.length);
    expect(firstSummary.insertedMetaTriples).toBe(materialized[0]!.metadataQuads.length);
    expect(firstSummary.insertedTriples).toBe(
      materialized[0]!.dataQuads.length + materialized[0]!.metadataQuads.length,
    );
    expect(checkpoints).toEqual([{
      key: `${CONTEXT_GRAPH_ID}:data`,
      offset: materialized[0]!.dataQuads.length,
      manifestDigest: manifest.manifestDigest,
      manifestPrefixDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      terminal: false,
      responderSessionOffset: 5,
    }]);

    const resumedOffset = checkpoints[0]!.offset;
    const continuationMaterialized: string[] = [];
    const continuationCheckpoints: Array<{ offset: number; terminal?: boolean }> = [];
    const continuationSummary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-a',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({
        phase,
      }: DurableSyncFetchRequest) => phase === 'meta'
        ? pageResult('meta', { quads: meta, nextOffset: meta.length })
        : pageResult('data', {
            quads: selected[1]!.payload,
            resumedFromOffset: resumedOffset,
            nextOffset: data.length,
            manifestDigest: manifest.manifestDigest,
          }),
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset,
      }: DurableSyncGraphScopedStoreRequest) => {
        continuationMaterialized.push(asset.ual);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: (_key, checkpoint) => {
        continuationCheckpoints.push({
          offset: checkpoint.offset,
          terminal: checkpoint.binding?.terminal,
        });
      },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(continuationMaterialized).toEqual([selected[1]!.ual]);
    expect(continuationSummary.complete).toBe(true);
    expect(continuationCheckpoints).toContainEqual({ offset: data.length, terminal: true });
  });

  it('lets one large asset finish after the soft settlement slice has expired', async () => {
    const [fixture] = orderedAssets();
    const meta = fixture!.meta;
    const data = fixture!.payload;
    const materialized: string[] = [];
    const checkpoints: Array<{ offset: number; terminal?: boolean }> = [];
    const pageYieldDecisions: boolean[] = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-large-asset',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      // This scheduling boundary is already in the past. It must prevent only
      // the NEXT asset, never abort the complete asset currently being settled.
      settlementSliceDeadline: 0,
      fetchSyncPages: async ({
        phase,
        shouldStopAfterPage,
      }: DurableSyncFetchRequest) => {
        if (phase === 'meta') {
          return pageResult('meta', { quads: meta, nextOffset: meta.length });
        }
        pageYieldDecisions.push(
          shouldStopAfterPage?.({
            resumedFromOffset: 0,
            nextOffset: data.length - 1,
          }) ?? false,
          shouldStopAfterPage?.({
            resumedFromOffset: 0,
            nextOffset: data.length,
          }) ?? false,
        );
        return pageResult('data', { quads: data, nextOffset: data.length });
      },
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset: verifiedAsset,
      }: DurableSyncGraphScopedStoreRequest) => {
        materialized.push(verifiedAsset.ual);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: (_key, checkpoint) => {
        checkpoints.push({
          offset: checkpoint.offset,
          terminal: checkpoint.binding?.terminal,
        });
      },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(materialized).toEqual([fixture!.ual]);
    expect(pageYieldDecisions).toEqual([false, true]);
    expect(summary.complete).toBe(true);
    expect(summary.failedPhases).toBe(0);
    expect(checkpoints.at(-1)).toEqual({ offset: data.length, terminal: true });
  });

  it('yields before a second asset after checkpointing the first safe boundary', async () => {
    const fixtures = orderedAssets().slice(0, 2);
    const meta = fixtures.flatMap((entry) => entry.meta);
    const data = fixtures.flatMap((entry) => entry.payload);
    const manifest = createGraphScopedDurableManifestPlan(meta, CONTEXT_GRAPH_ID)!;
    const materialized: string[] = [];
    const checkpoints: Array<{
      offset: number;
      manifestDigest?: string;
      terminal?: boolean;
    }> = [];
    const info: string[] = [];
    const pageYieldDecisions: boolean[] = [];

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-soft-slice',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      settlementSliceDeadline: 0,
      fetchSyncPages: async ({
        phase,
        shouldStopAfterPage,
      }: DurableSyncFetchRequest) => {
        if (phase === 'meta') {
          return pageResult('meta', { quads: meta, nextOffset: meta.length });
        }
        pageYieldDecisions.push(shouldStopAfterPage?.({
          resumedFromOffset: 0,
          nextOffset: data.length,
        }) ?? false);
        return pageResult('data', { quads: data, nextOffset: data.length });
      },
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({
        asset: verifiedAsset,
      }: DurableSyncGraphScopedStoreRequest) => {
        materialized.push(verifiedAsset.ual);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: (_key, checkpoint) => {
        checkpoints.push({
          offset: checkpoint.offset,
          manifestDigest: checkpoint.binding?.manifestDigest,
          terminal: checkpoint.binding?.terminal,
        });
      },
      logInfo: (_ctx, message) => { info.push(message); },
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(materialized).toEqual([fixtures[0]!.ual]);
    expect(pageYieldDecisions).toEqual([true]);
    expect(summary).toMatchObject({
      complete: false,
      failedPhases: 0,
      timedOutPhases: 0,
      checkpointAdvances: 1,
    });
    expect(checkpoints).toEqual([{
      offset: fixtures[0]!.payload.length,
      manifestDigest: manifest.manifestDigest,
      terminal: false,
    }]);
    expect(info).toContainEqual(expect.stringContaining('settlement slice expired'));
  });

  it('waits for adjacent zero-public descriptors before checkpointing their shared offset', async () => {
    const positive = orderedAssets();
    const zeroAssetNumber = Number(positive[1]!.ual.split('/').at(-1));
    const fixtures = [positive[0]!, asset(zeroAssetNumber, 0), positive[2]!];
    const meta = fixtures.flatMap((entry) => entry.meta);
    const data = fixtures.flatMap((entry) => entry.payload);
    const materialized: string[] = [];
    const checkpoints: number[] = [];

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
        asset: verifiedAsset,
      }: DurableSyncGraphScopedStoreRequest) => {
        if (verifiedAsset.dataQuads.length === 0) {
          throw new Error('zero-public asset authentication exceeded its deadline');
        }
        materialized.push(verifiedAsset.ual);
        return 'applied';
      },
      deleteCheckpoint: () => {},
      setCheckpoint: (_key, checkpoint) => { checkpoints.push(checkpoint.offset); },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.failedPhases).toBe(1);
    expect(materialized).toEqual([fixtures[0]!.ual]);
    // Offset 4 also names the immediately following zero-public descriptor;
    // persisting it before that descriptor authenticates would skip work.
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
      setCheckpoint: (key, checkpoint) => { checkpoints.push([key, checkpoint.offset]); },
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
    const manifestDigest = createGraphScopedDurableManifestPlan(meta, CONTEXT_GRAPH_ID)!.manifestDigest;
    const inserted: Quad[][] = [];
    const materialized: Array<{ dataQuads: Quad[] }> = [];
    const deleted: string[] = [];
    const checkpoints: Array<{ offset: number; terminal?: boolean }> = [];

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
          manifestDigest,
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
      setCheckpoint: (_key, checkpoint) => {
        checkpoints.push({
          offset: checkpoint.offset,
          terminal: checkpoint.binding?.terminal,
        });
      },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.rejectedKcs).toBe(0);
    expect(summary.complete).toBe(true);
    expect(summary.timedOutPhases).toBe(0);
    expect(summary.insertedDataTriples).toBe(4);
    expect(summary.completedPhases).toBe(2);
    expect(deleted).not.toContain(`${CONTEXT_GRAPH_ID}:data`);
    expect(checkpoints).toContainEqual({ offset: 12, terminal: true });
    expect(materialized.flatMap((entry) => entry.dataQuads)).toEqual(suffix);
    expect(inserted.flat().some((quad) => quad.graph === fixtures[2]!.graph)).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['mismatched', `sha256:${'ff'.repeat(32)}` as const],
  ])('rejects a resumed DATA response with a %s manifest binding', async (_name, responseDigest) => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const suffix = fixtures.slice(1).flatMap((entry) => entry.payload);
    const deleted: string[] = [];
    const materialized: string[] = [];
    let verificationCalls = 0;

    const summary = await runDurableSync({
      ctx,
      remotePeerId: 'peer-unbound-resume',
      contextGraphIds: [CONTEXT_GRAPH_ID],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({ phase }: DurableSyncFetchRequest) => phase === 'meta'
        ? pageResult('meta', { quads: meta, nextOffset: meta.length })
        : pageResult('data', {
          quads: suffix,
          resumedFromOffset: fixtures[0]!.payload.length,
          nextOffset: fixtures.flatMap((entry) => entry.payload).length,
          ...(responseDigest ? { manifestDigest: responseDigest } : {}),
        }),
      processDurableBatchInWorker: (...args) => {
        verificationCalls += 1;
        return processBatch(...args);
      },
      storeInsert: async () => {},
      storeGraphScopedAsset: async ({ asset }) => {
        materialized.push(asset.ual);
        return 'applied';
      },
      deleteCheckpoint: (key) => { deleted.push(key); },
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.complete).toBe(false);
    expect(summary.failedPhases).toBe(1);
    expect(verificationCalls).toBe(0);
    expect(materialized).toEqual([]);
    expect(deleted).toContain(`${CONTEXT_GRAPH_ID}:data`);
  });

  it('resets a checkpoint that resumes inside an exact assertion graph', async () => {
    const fixtures = orderedAssets();
    const meta = fixtures.flatMap((entry) => entry.meta);
    const manifestDigest = createGraphScopedDurableManifestPlan(meta, CONTEXT_GRAPH_ID)!.manifestDigest;
    const misalignedOffset = 1;
    const suffix = [
      ...fixtures[0]!.payload.slice(misalignedOffset),
      ...fixtures[1]!.payload,
    ];
    const deleted: string[] = [];
    const materialized: string[] = [];
    const warnings: string[] = [];
    let verificationCalls = 0;

    const manifestPlan = manifest(meta);
    expect(isGraphScopedDurableManifestBoundary(manifestPlan, 0)).toBe(true);
    expect(isGraphScopedDurableManifestBoundary(manifestPlan, 4)).toBe(true);
    expect(isGraphScopedDurableManifestBoundary(manifestPlan, misalignedOffset)).toBe(false);
    expect(isGraphScopedDurableManifestBoundary(manifestPlan, 13)).toBe(false);

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
          manifestDigest,
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

    expect(createGraphScopedDurableManifestPlan(mixedMeta, CONTEXT_GRAPH_ID)).toBeNull();
  });
});
