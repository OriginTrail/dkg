import { describe, it, expect, vi } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  knowledgeAssetLayerGraphUri,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import {
  filterExactAssetDurablePayload,
  runDurableSync,
  runDurableSyncDetailed,
  type DurableSyncChallengePinnedAuthenticationRequest,
} from '../src/sync/requester/durable-sync.js';
import {
  createChallengePinnedExactAssetSelection,
  createUalOnlyExactAssetSelection,
  exactAssetUalsForSelection,
  requireExactAssetSelection,
  type ExactAssetSelection,
} from '../src/sync/exact-assets.js';
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
  it('keeps multi-asset challenge pins atomic and rejects duplicate or parallel identities', () => {
    const first = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
    const second = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8';
    const commitment = (assetUal: string, rootByte: string) => ({
      assetUal,
      merkleRootHex: rootByte.repeat(64),
      merkleLeafCount: 1n,
    });

    const selection = createChallengePinnedExactAssetSelection([
      commitment(second, '2'),
      { ...commitment(first, '1'), merkleRootHex: `0x${'1'.repeat(64)}` },
    ]);
    expect(exactAssetUalsForSelection(selection)).toEqual([first, second]);
    expect(selection).toMatchObject({
      kind: 'challenge-pinned',
      commitments: [
        { assetUal: first, merkleRootHex: '1'.repeat(64) },
        { assetUal: second, merkleRootHex: '2'.repeat(64) },
      ],
    });

    expect(() => createChallengePinnedExactAssetSelection([
      commitment(first, '1'),
      commitment(first, '2'),
    ])).toThrow('Duplicate challenge commitment');
    expect(() => requireExactAssetSelection({
      kind: 'challenge-pinned',
      assetUals: [first, second],
      commitments: [commitment(first, '1')],
    })).toThrow('cannot include a parallel UAL list');
  });

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

    const filtered = filterExactAssetDurablePayload(
      data,
      meta,
      createUalOnlyExactAssetSelection([wanted]),
    );

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

    expect(filterExactAssetDurablePayload(
      [],
      meta,
      createUalOnlyExactAssetSelection([wanted, missing]),
    )).toMatchObject({
      descriptorCoverageComplete: false,
    });
  });

  it('declines a live v2 descriptor that does not match the v1 challenge commitment', () => {
    const wanted = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
    const graph = 'did:dkg:context-graph:cg/_verifiable_memory/0x0000000000000000000000000000000000000001/7';
    const metaGraph = 'did:dkg:context-graph:cg/_meta';
    const descriptor = (root: string, privateTripleCount = 0) => [
      { subject: wanted, predicate: 'http://dkg.io/ontology/kaUal', object: wanted, graph: metaGraph },
      { subject: wanted, predicate: 'http://dkg.io/ontology/contentScopeVersion', object: '2', graph: metaGraph },
      { subject: wanted, predicate: 'http://dkg.io/ontology/assertionVersion', object: '2', graph: metaGraph },
      { subject: wanted, predicate: 'http://dkg.io/ontology/contextGraph', object: 'did:dkg:context-graph:cg', graph: metaGraph },
      { subject: wanted, predicate: 'http://dkg.io/ontology/assertionGraph', object: graph, graph: metaGraph },
      { subject: wanted, predicate: 'http://dkg.io/ontology/merkleRoot', object: root, graph: metaGraph },
      { subject: wanted, predicate: 'http://dkg.io/ontology/publicTripleCount', object: '1', graph: metaGraph },
      { subject: wanted, predicate: 'http://dkg.io/ontology/privateTripleCount', object: String(privateTripleCount), graph: metaGraph },
      ...(privateTripleCount > 0 ? [{
        subject: wanted,
        predicate: 'http://dkg.io/ontology/privateMerkleRoot',
        object: '33'.repeat(32),
        graph: metaGraph,
      }] : []),
    ] as Quad[];
    const meta = descriptor('22'.repeat(32));
    const data = [
      { subject: 'urn:v2', predicate: 'urn:p', object: '"current"', graph },
    ] as Quad[];

    const filtered = filterExactAssetDurablePayload(data, meta, createChallengePinnedExactAssetSelection([{
      assetUal: wanted,
      merkleRootHex: '11'.repeat(32),
      merkleLeafCount: 1n,
    }]));

    expect(filtered).toEqual({
      dataQuads: [],
      metaQuads: [],
      descriptorCoverageComplete: false,
    });

    const matching = filterExactAssetDurablePayload(data, descriptor('11'.repeat(32)), createChallengePinnedExactAssetSelection([{
      assetUal: wanted,
      merkleRootHex: '11'.repeat(32),
      merkleLeafCount: 1n,
    }]));
    expect(matching.dataQuads).toEqual(data);
    expect(matching.descriptorCoverageComplete).toBe(true);

    expect(filterExactAssetDurablePayload(
      data,
      descriptor('11'.repeat(32)),
      createChallengePinnedExactAssetSelection([{
        assetUal: wanted,
        merkleRootHex: '11'.repeat(32),
        merkleLeafCount: 2n,
      }]),
    ).descriptorCoverageComplete).toBe(false);
    expect(filterExactAssetDurablePayload(
      data,
      descriptor('11'.repeat(32), 1),
      createChallengePinnedExactAssetSelection([{
        assetUal: wanted,
        merkleRootHex: '11'.repeat(32),
        merkleLeafCount: 1n,
      }]),
    ).descriptorCoverageComplete).toBe(true);
    expect(filterExactAssetDurablePayload(
      data,
      descriptor('11'.repeat(32), 1),
      createChallengePinnedExactAssetSelection([{
        assetUal: wanted,
        merkleRootHex: '11'.repeat(32),
        merkleLeafCount: 2n,
      }]),
    ).descriptorCoverageComplete).toBe(false);
  });

  it('threads the exact selection into both fetch phases and filters an old-responder payload before verification', async () => {
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
      exactAssetSelectionFor: () => createUalOnlyExactAssetSelection([wanted]),
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

  it('threads a challenge pin through runDurableSync before verification', async () => {
    const wanted = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
    const scope = createGraphKnowledgeAssetScope(wanted, '1');
    const graph = knowledgeAssetLayerGraphUri(
      'mfacts',
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const data = [{
      subject: 'urn:wanted',
      predicate: 'urn:p',
      object: '"wanted"',
      graph,
    }] as Quad[];
    const root = new Uint8Array(32).fill(0x11);
    const meta = generateGraphKnowledgeAssetMetadata({
      ual: wanted,
      contextGraphId: 'mfacts',
      merkleRoot: root,
      publisherPeerId: 'peer',
      accessPolicy: 'public',
      timestamp: new Date(0),
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
      assertionGraph: graph,
    }, { status: 'tentative' });
    const selection = (byte: string): ExactAssetSelection =>
      createChallengePinnedExactAssetSelection([{
        assetUal: wanted,
        merkleRootHex: byte.repeat(64),
        merkleLeafCount: 1n,
      }]);

    const mismatch = makeContext({
      exactAssetSelectionFor: () => selection('2'),
      pageQuads: { data, meta },
    });
    await runDurableSync(mismatch.context);
    expect(mismatch.calls.map((call) => call.phase)).toEqual(['meta']);
    expect(mismatch.processCalls).toHaveLength(0);
    expect(mismatch.insertedBatches).toHaveLength(0);

    const matching = makeContext({
      exactAssetSelectionFor: () => selection('1'),
      pageQuads: { data, meta },
    });
    await runDurableSync(matching.context);
    expect(matching.calls.map((call) => call.phase)).toEqual(['meta', 'data']);
    expect(matching.processCalls).toHaveLength(1);
  });

  it('returns every authenticated challenge asset explicitly without materializing live state', async () => {
    const firstUal = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
    const secondUal = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8';
    const fixture = (assetUal: string, rootByte: number, privateRoot?: Uint8Array) => {
      const scope = createGraphKnowledgeAssetScope(assetUal, '1');
      const graph = knowledgeAssetLayerGraphUri(
        'mfacts',
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const root = new Uint8Array(32).fill(rootByte);
      const data: Quad = {
        subject: `urn:asset:${rootByte}`,
        predicate: 'urn:value',
        object: `"${rootByte}"`,
        graph,
      };
      const meta = generateGraphKnowledgeAssetMetadata({
        ual: assetUal,
        contextGraphId: 'mfacts',
        merkleRoot: root,
        publisherPeerId: 'peer',
        accessPolicy: 'public',
        timestamp: new Date(0),
        assertionVersion: '1',
        publicTripleCount: 1,
        privateTripleCount: privateRoot === undefined ? 0 : 1,
        ...(privateRoot === undefined ? {} : { privateMerkleRoot: privateRoot }),
        assertionGraph: graph,
      }, { status: 'tentative' });
      return { assetUal, data, graph, meta, root };
    };
    const privateRoot = new Uint8Array(32).fill(0x33);
    const first = fixture(firstUal, 0x11, privateRoot);
    const second = fixture(secondUal, 0x22);
    const selection = createChallengePinnedExactAssetSelection([
      {
        assetUal: firstUal,
        merkleRootHex: '11'.repeat(32),
        merkleLeafCount: 1n,
      },
      {
        assetUal: secondUal,
        merkleRootHex: '22'.repeat(32),
        merkleLeafCount: 1n,
      },
    ]);
    const authenticateChallengePinnedAsset = vi.fn(async (
      request: DurableSyncChallengePinnedAuthenticationRequest,
    ) => ({
      asset: request.asset,
      privateRoots: request.asset.ual === firstUal ? [privateRoot] : [],
    }));
    const storeGraphScopedAsset = vi.fn(async () => {
      throw new Error('challenge-pinned assets must not reach durable materialization');
    });
    const { context } = makeContext({
      exactAssetSelectionFor: () => selection,
      pageQuads: {
        data: [first.data, second.data],
        meta: [...first.meta, ...second.meta],
      },
      processResult: {
        verifiedData: [first.data, second.data],
        verifiedMeta: [...first.meta, ...second.meta],
        verifiedGraphScopedDataGraphs: [first.graph, second.graph],
      },
      authenticateChallengePinnedAsset,
      storeGraphScopedAsset,
    });

    const detailed = await runDurableSyncDetailed(context);

    expect(detailed.authenticatedExactAssets?.map(({ asset }) => asset.ual)).toEqual([
      firstUal,
      secondUal,
    ]);
    expect(detailed.authenticatedExactAssets?.[0]?.privateRoots).toEqual([privateRoot]);
    expect(authenticateChallengePinnedAsset).toHaveBeenCalledTimes(2);
    expect(storeGraphScopedAsset).not.toHaveBeenCalled();
    expect(detailed.result.insertedTriples).toBe(0);
  });

  it('does not thread a filter when exactAssetSelectionFor is not wired', async () => {
    const { calls, context } = makeContext();
    await runDurableSync(context);
    expect(calls.every((c) => c.assetUals === undefined)).toBe(true);
  });
});

function makeContext(options: {
  sinceBatchIdFor?: (cg: string) => string | undefined;
  exactAssetSelectionFor?: (cg: string) => ExactAssetSelection | undefined;
  pageQuads?: { data: Quad[]; meta: Quad[] };
  contextGraphIds?: string[];
  syncAgentsMeta?: boolean;
  processResult?: {
    verifiedData?: Quad[];
    verifiedMeta?: Quad[];
    verifiedGraphScopedDataGraphs?: string[];
    totalFetchedDataQuads?: number;
    totalFetchedMetaQuads?: number;
  };
  authenticateChallengePinnedAsset?: (
    request: DurableSyncChallengePinnedAuthenticationRequest,
  ) => Promise<{ asset: import('../src/sync/requester/graph-scoped-materialization.js').VerifiedGraphScopedAsset; privateRoots: readonly Uint8Array[] }>;
  storeGraphScopedAsset?: () => Promise<never>;
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
    nextOffset: options.pageQuads
      ? options.pageQuads[phase].length
      : phase === 'data' ? 1 : 2,
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
      fetchSyncPages: async ({
        contextGraphId,
        phase,
        graphUri,
        snapshotRef,
        sinceBatchId,
        exactAssetUals,
      }) => {
        calls.push({
          contextGraphId,
          phase,
          graphUri,
          snapshotRef,
          sinceBatchId,
          assetUals: exactAssetUals,
        });
        return page(phase);
      },
      sinceBatchIdFor: options.sinceBatchIdFor,
      exactAssetSelectionFor: options.exactAssetSelectionFor,
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
          verifiedGraphScopedDataGraphs:
            options.processResult?.verifiedGraphScopedDataGraphs,
          consumedUnpersistedMetaTriples: 0,
          totalFetchedDataQuads: options.processResult?.totalFetchedDataQuads ?? dataQuads.length,
          totalFetchedMetaQuads: options.processResult?.totalFetchedMetaQuads ?? metaQuads.length,
          rejectedKcs: 0,
          emptyResponses: 0,
          metaOnlyResponses: 0,
          verifiedPrivateOnlyResponses: 0,
          dataRejectedMissingMeta: 0,
        };
      },
      storeInsert: async ({ quads }) => { insertedBatches.push(quads); },
      authenticateChallengePinnedAsset: options.authenticateChallengePinnedAsset,
      storeGraphScopedAsset: options.storeGraphScopedAsset,
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
