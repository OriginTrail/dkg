import { describe, it, expect } from 'vitest';
import { createOperationContext, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import {
  filterExactAssetDurablePayload,
  runDurableSync,
} from '../src/sync/requester/durable-sync.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { DurableBatchVerificationMode } from '../src/sync-verify-worker.js';

interface FetchCall {
  contextGraphId: string;
  phase: string;
  graphUri: string;
  snapshotRef: string | undefined;
  sinceBatchId: string | undefined;
  assetUals: string[] | undefined;
}

describe('exact-asset rolling-upgrade filter', () => {
  it('drops already-present KAs from an old responder full-CG response', () => {
    const wanted = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
    const existing = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8';
    const wantedGraph = 'did:dkg:context-graph:cg/_verifiable_memory/0x0000000000000000000000000000000000000001/7';
    const existingGraph = 'did:dkg:context-graph:cg/_verifiable_memory/0x0000000000000000000000000000000000000001/8';
    const meta = [
      { subject: wanted, predicate: 'http://dkg.io/ontology/assertionGraph', object: wantedGraph, graph: 'did:dkg:context-graph:cg/_meta' },
      { subject: wanted, predicate: 'http://dkg.io/ontology/kaUal', object: wanted, graph: 'did:dkg:context-graph:cg/_meta' },
      { subject: existing, predicate: 'http://dkg.io/ontology/assertionGraph', object: existingGraph, graph: 'did:dkg:context-graph:cg/_meta' },
    ] as Quad[];
    const data = [
      { subject: 'urn:wanted', predicate: 'urn:p', object: '"wanted"', graph: wantedGraph },
      { subject: 'urn:existing', predicate: 'urn:p', object: '"existing"', graph: existingGraph },
    ] as Quad[];

    const filtered = filterExactAssetDurablePayload(data, meta, [wanted]);

    expect(filtered.metaQuads.map((quad) => quad.subject)).toEqual([wanted, wanted]);
    expect(filtered.dataQuads.map((quad) => quad.graph)).toEqual([wantedGraph]);
    expect(filtered.descriptorCoverageComplete).toBe(true);
  });

  it('reports incomplete descriptor coverage from the same exact projection', () => {
    const wanted = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
    const missing = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8';
    const graph = 'did:dkg:context-graph:cg/_verifiable_memory/0x0000000000000000000000000000000000000001/7';
    const meta = [
      { subject: wanted, predicate: 'http://dkg.io/ontology/assertionGraph', object: graph, graph: 'did:dkg:context-graph:cg/_meta' },
      { subject: wanted, predicate: 'http://dkg.io/ontology/kaUal', object: wanted, graph: 'did:dkg:context-graph:cg/_meta' },
    ] as Quad[];

    expect(filterExactAssetDurablePayload([], meta, [wanted, missing])).toMatchObject({
      descriptorCoverageComplete: false,
    });
  });

  it('threads exactAssetUalsFor into both fetch phases and filters an old-responder payload before verification', async () => {
    const wanted = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
    const extra = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8';
    const wantedGraph = 'did:dkg:context-graph:mfacts/_verifiable_memory/0x0000000000000000000000000000000000000001/7';
    const extraGraph = 'did:dkg:context-graph:mfacts/_verifiable_memory/0x0000000000000000000000000000000000000001/8';
    const metaGraph = 'did:dkg:context-graph:mfacts/_meta';
    // An OLD responder ignores the filter and returns the whole CG: both KAs.
    const meta = [
      { subject: wanted, predicate: 'http://dkg.io/ontology/assertionGraph', object: wantedGraph, graph: metaGraph },
      { subject: wanted, predicate: 'http://dkg.io/ontology/kaUal', object: wanted, graph: metaGraph },
      { subject: extra, predicate: 'http://dkg.io/ontology/assertionGraph', object: extraGraph, graph: metaGraph },
      { subject: extra, predicate: 'http://dkg.io/ontology/kaUal', object: extra, graph: metaGraph },
    ] as Quad[];
    const data = [
      { subject: 'urn:wanted', predicate: 'urn:p', object: '"wanted"', graph: wantedGraph },
      { subject: 'urn:extra', predicate: 'urn:p', object: '"extra"', graph: extraGraph },
    ] as Quad[];
    const { calls, context, processCalls } = makeContext({
      exactAssetUalsFor: () => [wanted],
      pageQuads: { data, meta },
    });

    await runDurableSync(context);

    // Both phases must carry the exact filter on the wire…
    const metaCall = calls.find((c) => c.phase === 'meta')!;
    const dataCall = calls.find((c) => c.phase === 'data')!;
    expect(metaCall.assetUals).toEqual([wanted]);
    expect(dataCall.assetUals).toEqual([wanted]);
    // …and the worker must only ever see the requested KA's quads, even though
    // the (old) responder returned the extra KA too.
    expect(processCalls).toHaveLength(1);
    expect(processCalls[0]!.metaCount).toBe(2);
    expect(processCalls[0]!.dataCount).toBe(1);
  });

  it('does not thread a filter when exactAssetUalsFor is not wired', async () => {
    const { calls, context } = makeContext();
    await runDurableSync(context);
    expect(calls.every((c) => c.assetUals === undefined)).toBe(true);
  });
});

function makeContext(options: {
  sinceBatchIdFor?: (cg: string) => string | undefined;
  exactAssetUalsFor?: (cg: string) => string[] | undefined;
  pageQuads?: { data: Quad[]; meta: Quad[] };
  contextGraphIds?: string[];
  syncAgentsMeta?: boolean;
  processResult?: {
    verifiedData?: Quad[];
    verifiedMeta?: Quad[];
    totalFetchedDataQuads?: number;
    totalFetchedMetaQuads?: number;
  };
} = {}) {
  const calls: FetchCall[] = [];
  const processCalls: Array<{
    dataCount: number;
    metaCount: number;
    acceptUnverified: boolean;
    mode: DurableBatchVerificationMode;
  }> = [];
  const insertedBatches: Quad[][] = [];
  const deletedCheckpoints: string[] = [];
  const page = (phase: 'data' | 'meta'): SyncPageResult => ({
    quads: options.pageQuads
      ? (options.pageQuads[phase] as never[])
      : phase === 'data' ? ([{ id: 'data' }] as never[]) : ([{ id: 'meta' }] as never[]),
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
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 10_000),
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
        assetUals?: string[],
      ) => {
        calls.push({ contextGraphId, phase, graphUri, snapshotRef, sinceBatchId, assetUals });
        return page(phase);
      },
      sinceBatchIdFor: options.sinceBatchIdFor,
      exactAssetUalsFor: options.exactAssetUalsFor,
      processDurableBatchInWorker: async (
        dataQuads: Quad[],
        metaQuads: Quad[],
        _ctx: unknown,
        acceptUnverified: boolean,
        mode: DurableBatchVerificationMode,
      ) => {
        processCalls.push({ dataCount: dataQuads.length, metaCount: metaQuads.length, acceptUnverified, mode });
        return {
          verifiedData,
          verifiedMeta,
          consumedUnpersistedMetaTriples: 0,
          totalFetchedDataQuads: options.processResult?.totalFetchedDataQuads ?? dataQuads.length,
          totalFetchedMetaQuads: options.processResult?.totalFetchedMetaQuads ?? metaQuads.length,
          rejectedKcs: 0,
          emptyResponses: 0,
          metaOnlyResponses: 0,
          dataRejectedMissingMeta: 0,
        };
      },
      storeInsert: async (quads: Quad[]) => { insertedBatches.push(quads); },
      deleteCheckpoint: (key: string) => { deletedCheckpoints.push(key); },
      setCheckpoint: () => undefined,
      logInfo: () => undefined,
      logWarn: () => undefined,
      logDebug: () => undefined,
    },
  };
}

describe('runDurableSync sinceBatchId threading', () => {
  it('passes sinceBatchIdFor() to the DATA fetch only, not the META fetch', async () => {
    const { calls, context, processCalls } = makeContext({ sinceBatchIdFor: () => '7' });
    const summary = await runDurableSync(context);

    const meta = calls.find((c) => c.phase === 'meta')!;
    const data = calls.find((c) => c.phase === 'data')!;
    expect(meta.sinceBatchId).toBeUndefined();
    expect(data.sinceBatchId).toBe('7');
    expect(data.snapshotRef).toBeUndefined();
    expect(processCalls[0]?.mode).toEqual({ kind: 'sinceBatchId', sinceBatchId: '7' });
    expect(summary.checkpointAdvances).toBe(2);
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
    expect(processCalls).toEqual([{
      dataCount: 1,
      metaCount: 0,
      acceptUnverified: true,
      mode: { kind: 'fullSnapshot' },
    }]);
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
    expect(processCalls).toEqual([{
      dataCount: 1,
      metaCount: 1,
      acceptUnverified: true,
      mode: { kind: 'fullSnapshot' },
    }]);
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
    expect(processCalls).toEqual([{
      dataCount: 1,
      metaCount: 1,
      acceptUnverified: false,
      mode: { kind: 'fullSnapshot' },
    }]);
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
    expect(processCalls).toEqual([{
      dataCount: 1,
      metaCount: 1,
      acceptUnverified: true,
      mode: { kind: 'fullSnapshot' },
    }]);
  });
});
