import { describe, it, expect } from 'vitest';
import { createOperationContext, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import type { Quad } from '@origintrail-official/dkg-storage';

const DKG = 'http://dkg.io/ontology/';
const ASSET_UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000aa/7';

interface FetchCall {
  contextGraphId: string;
  phase: string;
  graphUri: string;
  snapshotRef: string | undefined;
  sinceBatchId: string | undefined;
}

function makeContext(options: {
  sinceBatchIdFor?: (cg: string) => string | undefined;
  contextGraphIds?: string[];
  syncAgentsMeta?: boolean;
  processResult?: {
    verifiedData?: Quad[];
    verifiedMeta?: Quad[];
    totalFetchedDataQuads?: number;
    totalFetchedMetaQuads?: number;
    rejectedKcs?: number;
    emptyResponses?: number;
    metaOnlyResponses?: number;
    dataRejectedMissingMeta?: number;
  };
  logLifecycle?: (event: {
    assetUal: string;
    event: string;
    action: string;
    result: string;
    contextGraphId: string;
    remotePeerId: string;
  }) => void;
} = {}) {
  const calls: FetchCall[] = [];
  const processCalls: Array<{ dataCount: number; metaCount: number; acceptUnverified: boolean }> = [];
  const insertedBatches: Quad[][] = [];
  const deletedCheckpoints: string[] = [];
  const page = (phase: 'data' | 'meta'): SyncPageResult => ({
    quads: phase === 'data' ? ([{ id: 'data' }] as never[]) : ([{ id: 'meta' }] as never[]),
    bytesReceived: phase === 'data' ? 20 : 10,
    resumedFromOffset: 0,
    nextOffset: phase === 'data' ? 1 : 2,
    checkpointKey: `cp|${phase}`,
    completed: true,
    timedOut: false,
  });
  const verifiedData = options.processResult?.verifiedData ?? [];
  const verifiedMeta = options.processResult?.verifiedMeta ?? [];
  return {
    calls,
    processCalls,
    insertedBatches,
    deletedCheckpoints,
    context: {
      ctx: createOperationContext('sync'),
      remotePeerId: 'peerR',
      contextGraphIds: options.contextGraphIds ?? ['mfacts'],
      syncAgentsMeta: options.syncAgentsMeta,
      createContextGraphSyncDeadline: () => Date.now() + 10_000,
      fetchSyncPages: async (
        _ctx: unknown,
        _peer: string,
        contextGraphId: string,
        _swm: boolean,
        phase: 'data' | 'meta',
        graphUri: string,
        _deadline: number,
        snapshotRef?: string,
        sinceBatchId?: string,
      ) => {
        calls.push({ contextGraphId, phase, graphUri, snapshotRef, sinceBatchId });
        return page(phase);
      },
      sinceBatchIdFor: options.sinceBatchIdFor,
      processDurableBatchInWorker: async (dataQuads: Quad[], metaQuads: Quad[], _ctx: unknown, acceptUnverified: boolean) => {
        processCalls.push({ dataCount: dataQuads.length, metaCount: metaQuads.length, acceptUnverified });
        return {
          verifiedData,
          verifiedMeta,
          totalFetchedDataQuads: options.processResult?.totalFetchedDataQuads ?? dataQuads.length,
          totalFetchedMetaQuads: options.processResult?.totalFetchedMetaQuads ?? metaQuads.length,
          rejectedKcs: options.processResult?.rejectedKcs ?? 0,
          emptyResponses: options.processResult?.emptyResponses ?? 0,
          metaOnlyResponses: options.processResult?.metaOnlyResponses ?? 0,
          dataRejectedMissingMeta: options.processResult?.dataRejectedMissingMeta ?? 0,
        };
      },
      storeInsert: async (quads: Quad[]) => { insertedBatches.push(quads); },
      deleteCheckpoint: (key: string) => { deletedCheckpoints.push(key); },
      setCheckpoint: () => undefined,
      logLifecycle: options.logLifecycle,
      logInfo: () => undefined,
      logWarn: () => undefined,
      logDebug: () => undefined,
    },
  };
}

describe('runDurableSync sinceBatchId threading', () => {
  it('passes sinceBatchIdFor() to the DATA fetch only, not the META fetch', async () => {
    const { calls, context } = makeContext({ sinceBatchIdFor: () => '7' });
    await runDurableSync(context);

    const meta = calls.find((c) => c.phase === 'meta')!;
    const data = calls.find((c) => c.phase === 'data')!;
    expect(meta.sinceBatchId).toBeUndefined();
    expect(data.sinceBatchId).toBe('7');
    expect(data.snapshotRef).toBeUndefined();
  });

  it('passes undefined when no high-water mark resolver is wired', async () => {
    const { calls, context } = makeContext();
    await runDurableSync(context);
    const data = calls.find((c) => c.phase === 'data')!;
    expect(data.sinceBatchId).toBeUndefined();
  });

  it('passes undefined when the resolver returns undefined for the CG', async () => {
    const { calls, context } = makeContext({ sinceBatchIdFor: () => undefined });
    await runDurableSync(context);
    const data = calls.find((c) => c.phase === 'data')!;
    expect(data.sinceBatchId).toBeUndefined();
  });

  it('emits published KA sync receive and apply lifecycle events by assetUal', async () => {
    const lifecycleEvents: Array<{
      assetUal: string;
      event: string;
      action: string;
      result: string;
      contextGraphId: string;
      remotePeerId: string;
    }> = [];
    const publishedMeta = {
      subject: ASSET_UAL,
      predicate: `${DKG}merkleRoot`,
      object: `"${'ab'.repeat(32)}"`,
      graph: 'did:dkg:context-graph:mfacts/_meta',
    };
    const { context } = makeContext({
      processResult: {
        verifiedData: [{ subject: 'urn:root', predicate: 'http://schema.org/name', object: '"Fact"', graph: 'did:dkg:context-graph:mfacts' }],
        verifiedMeta: [publishedMeta],
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads: 1,
      },
      logLifecycle: (event) => lifecycleEvents.push(event),
    });

    await runDurableSync(context);

    expect(lifecycleEvents).toContainEqual(expect.objectContaining({
      assetUal: ASSET_UAL,
      event: 'sync_receive',
      action: 'receive',
      result: 'verified',
      contextGraphId: 'mfacts',
      remotePeerId: 'peerR',
    }));
    expect(lifecycleEvents).toContainEqual(expect.objectContaining({
      assetUal: ASSET_UAL,
      event: 'sync_apply',
      action: 'apply',
      result: 'inserted',
      contextGraphId: 'mfacts',
      remotePeerId: 'peerR',
    }));
  });

  it('emits published KA sync request and response lifecycle events by assetUal', async () => {
    const lifecycleEvents: Array<{
      assetUal: string;
      event: string;
      action: string;
      result: string;
      contextGraphId: string;
      remotePeerId: string;
    }> = [];
    const publishedMeta = {
      subject: ASSET_UAL,
      predicate: `${DKG}merkleRoot`,
      object: `"${'ab'.repeat(32)}"`,
      graph: 'did:dkg:context-graph:mfacts/_meta',
    };
    const { context } = makeContext({
      processResult: {
        verifiedData: [{ subject: 'urn:root', predicate: 'http://schema.org/name', object: '"Fact"', graph: 'did:dkg:context-graph:mfacts' }],
        verifiedMeta: [publishedMeta],
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads: 1,
      },
      logLifecycle: (event) => lifecycleEvents.push(event),
    });

    await runDurableSync(context);

    expect(lifecycleEvents).toContainEqual(expect.objectContaining({
      assetUal: ASSET_UAL,
      event: 'sync_request',
      action: 'request',
      result: 'sent',
      contextGraphId: 'mfacts',
      remotePeerId: 'peerR',
    }));
    expect(lifecycleEvents).toContainEqual(expect.objectContaining({
      assetUal: ASSET_UAL,
      event: 'sync_response',
      action: 'response',
      result: 'fetched',
      contextGraphId: 'mfacts',
      remotePeerId: 'peerR',
    }));
  });

  it('emits published KA sync skip lifecycle event when data cannot be applied', async () => {
    const lifecycleEvents: Array<{
      assetUal: string;
      event: string;
      action: string;
      result: string;
      contextGraphId: string;
      remotePeerId: string;
      reason?: string;
    }> = [];
    const publishedMeta = {
      subject: ASSET_UAL,
      predicate: `${DKG}merkleRoot`,
      object: `"${'ab'.repeat(32)}"`,
      graph: 'did:dkg:context-graph:mfacts/_meta',
    };
    const { context } = makeContext({
      processResult: {
        verifiedMeta: [publishedMeta],
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads: 1,
        dataRejectedMissingMeta: 1,
      },
      logLifecycle: (event) => lifecycleEvents.push(event),
    });

    await runDurableSync(context);

    expect(lifecycleEvents).toContainEqual(expect.objectContaining({
      assetUal: ASSET_UAL,
      event: 'sync_skip',
      action: 'skip',
      result: 'deferred',
      contextGraphId: 'mfacts',
      remotePeerId: 'peerR',
      reason: 'data-rejected-missing-meta',
    }));
  });
});

describe('runDurableSync agents meta routing', () => {
  it('skips agents meta when syncAgentsMeta=false but still fetches and inserts agents data', async () => {
    const { calls, context, processCalls, insertedBatches, deletedCheckpoints } = makeContext({
      contextGraphIds: [SYSTEM_CONTEXT_GRAPHS.AGENTS],
      syncAgentsMeta: false,
      processResult: {
        verifiedData: [{ id: 'verified-data' } as never],
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads: 0,
      },
    });

    await runDurableSync(context);

    expect(calls.map((c) => c.phase)).toEqual(['data']);
    expect(calls[0]).toMatchObject({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.AGENTS,
      phase: 'data',
    });
    expect(calls[0].graphUri).toBe('did:dkg:context-graph:agents');
    expect(processCalls).toEqual([{ dataCount: 1, metaCount: 0, acceptUnverified: true }]);
    expect(insertedBatches).toEqual([[{ id: 'verified-data' }]]);
    expect(deletedCheckpoints).toContain(`peerR|${SYSTEM_CONTEXT_GRAPHS.AGENTS}|durable|meta`);
  });

  it('fetches agents meta by default', async () => {
    const { calls, context, processCalls } = makeContext({
      contextGraphIds: [SYSTEM_CONTEXT_GRAPHS.AGENTS],
    });

    await runDurableSync(context);

    expect(calls.map((c) => c.phase)).toEqual(['meta', 'data']);
    expect(calls[0]).toMatchObject({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.AGENTS,
      phase: 'meta',
      graphUri: 'did:dkg:context-graph:agents/_meta',
    });
    expect(processCalls).toEqual([{ dataCount: 1, metaCount: 1, acceptUnverified: true }]);
  });

  it('still fetches metadata for normal context graphs when agents meta sync is disabled', async () => {
    const { calls, context, processCalls } = makeContext({
      contextGraphIds: ['normal-cg'],
      syncAgentsMeta: false,
    });

    await runDurableSync(context);

    expect(calls.map((c) => c.phase)).toEqual(['meta', 'data']);
    expect(calls[0]).toMatchObject({
      contextGraphId: 'normal-cg',
      phase: 'meta',
      graphUri: 'did:dkg:context-graph:normal-cg/_meta',
    });
    expect(processCalls).toEqual([{ dataCount: 1, metaCount: 1, acceptUnverified: false }]);
  });

  it('still fetches ontology metadata when agents meta sync is disabled', async () => {
    const { calls, context, processCalls } = makeContext({
      contextGraphIds: [SYSTEM_CONTEXT_GRAPHS.ONTOLOGY],
      syncAgentsMeta: false,
    });

    await runDurableSync(context);

    expect(calls.map((c) => c.phase)).toEqual(['meta', 'data']);
    expect(calls[0]).toMatchObject({
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      phase: 'meta',
      graphUri: 'did:dkg:context-graph:ontology/_meta',
    });
    expect(processCalls).toEqual([{ dataCount: 1, metaCount: 1, acceptUnverified: true }]);
  });
});
