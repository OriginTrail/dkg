import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { SYNC_PAGE_SIZE } from '../src/dkg-agent-constants.js';
import {
  createGraphScopedDurableManifestPlan,
} from '../src/sync/durable-integrity.js';
import {
  getSyncCheckpointKey,
  MemorySyncCheckpointStore,
  type DurableManifestDigest,
} from '../src/sync/checkpoint/state.js';
import { exactAssetFilterKey } from '../src/sync/exact-assets.js';
import {
  deleteSyncPageCheckpoint,
  fetchSyncPages,
  type SyncPageResult,
} from '../src/sync/requester/page-fetch.js';
import {
  runDurableSync,
  type DurableSyncFetchRequest,
  type DurableSyncGraphScopedStoreRequest,
} from '../src/sync/requester/durable-sync.js';
import { processDurableBatchForWire } from '../src/sync-verify-worker-impl.js';
import type { DurableBatchVerificationMode } from '../src/sync-verify-worker.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';

const ctx = { operationId: 'manifest-continuation', operationName: 'sync' } as OperationContext;
let scenarioSequence = 0;

interface AssetFixture {
  ual: string;
  graph: string;
  payload: Quad[];
  meta: Quad[];
}

function asset(
  contextGraphId: string,
  kaNumber: number,
  options: {
    tripleCount?: number;
    valuePrefix?: string;
    subGraphName?: string;
  } = {},
): AssetFixture {
  const tripleCount = options.tripleCount ?? 4;
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/${kaNumber}`;
  const scope = createGraphKnowledgeAssetScope(ual, '1');
  const graph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.VerifiableMemory,
    scope,
    options.subGraphName,
  );
  const payload = Array.from({ length: tripleCount }, (_, index): Quad => ({
    subject: `urn:continuation:${kaNumber}:${index}`,
    predicate: 'urn:continuation:value',
    object: `"${options.valuePrefix ?? 'value'}-${index}"`,
    graph,
  }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId,
    merkleRoot: computeFlatKCRootV10(payload, []),
    publisherPeerId: 'publisher-peer',
    accessPolicy: 'public',
    timestamp: new Date(0),
    assertionVersion: '1',
    publicTripleCount: payload.length,
    privateTripleCount: 0,
    assertionGraph: graph,
    ...(options.subGraphName ? { subGraphName: options.subGraphName } : {}),
  }, { status: 'tentative' });
  return { ual, graph, payload, meta };
}

function ordered(fixtures: readonly AssetFixture[]): AssetFixture[] {
  return [...fixtures].sort((left, right) => left.graph.localeCompare(right.graph));
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
    consumedUnpersistedMetaTriples: wire.consumedUnpersistedMetaTriples,
    verifiedPrivateOnlyResponses: wire.verifiedPrivateOnlyResponses,
    totalFetchedDataQuads: wire.totalFetchedDataQuads,
    totalFetchedMetaQuads: wire.totalFetchedMetaQuads,
    rejectedKcs: wire.rejectedKcs,
    emptyResponses: wire.emptyResponses,
    metaOnlyResponses: wire.metaOnlyResponses,
    dataRejectedMissingMeta: wire.dataRejectedMissingMeta,
  };
}

interface Round {
  readonly meta: Quad[];
  readonly dataPage: (offset: number) => Quad[] | Error;
}

interface DataRequestEvidence {
  readonly offset: number;
  readonly syncSessionId: string | undefined;
  readonly manifestDigest: DurableManifestDigest | undefined;
}

function createTwoRoundHarness(
  contextGraphId: string,
  remotePeerId: string,
  checkpointStore = new MemorySyncCheckpointStore(),
  exactAssetUals?: string[],
) {
  let currentRound: Round;
  let pendingRequest: {
    phase: 'data' | 'meta';
    offset: number;
    syncSessionId: string | undefined;
    manifestDigest: DurableManifestDigest | undefined;
  } | undefined;
  let responseSequence = 0;
  const parsedResponses = new Map<string, Quad[]>();
  const dataRequests: DataRequestEvidence[] = [];
  const storedAssetUals: string[] = [];

  const fetch = async (request: DurableSyncFetchRequest): Promise<SyncPageResult> => fetchSyncPages({
    ctx: request.ctx,
    remotePeerId: request.remotePeerId,
    contextGraphId: request.contextGraphId,
    includeSharedMemory: false,
    phase: request.phase,
    graphUri: request.graphUri,
    deadline: request.fetchContext.deadline,
    syncPageTimeoutMs: 5_000,
    syncRouterAttempts: 1,
    syncPageRetryAttempts: 1,
    syncPageSize: SYNC_PAGE_SIZE,
    syncDeniedResponse: '#DENIED',
    debugSyncProgress: false,
    protocolSync: '/test/durable-manifest-continuation',
    checkpointStore,
    forceFreshSession: request.forceFreshSession,
    manifestDigest: request.manifestDigest,
    manifestPrefixDigestAtOffset: request.manifestPrefixDigestAtOffset,
    assetUals: request.exactAssetUals,
    buildSyncRequest: async (
      _contextGraphId,
      offset,
      _limit,
      _includeSharedMemory,
      _remotePeerId,
      phase,
      _snapshotRef,
      _sinceBatchId,
      syncSessionId,
    ) => {
      pendingRequest = {
        phase: phase as 'data' | 'meta',
        offset,
        syncSessionId,
        manifestDigest: request.manifestDigest,
      };
      if (phase === 'data') {
        dataRequests.push({ offset, syncSessionId, manifestDigest: request.manifestDigest });
      }
      return new TextEncoder().encode('request');
    },
    send: async () => {
      const pending = pendingRequest!;
      const page = pending.phase === 'meta'
        ? currentRound.meta
        : currentRound.dataPage(pending.offset);
      if (page instanceof Error) throw page;
      const quads = page;
      if (quads.length === 0) return new Uint8Array();
      const responseId = `response-${responseSequence++}`;
      parsedResponses.set(responseId, quads);
      return new TextEncoder().encode(responseId);
    },
    parseAndFilter: async (body) => {
      const quads = parsedResponses.get(body) ?? [];
      return { quads, totalQuads: quads.length };
    },
    logWarn: () => {},
    logInfo: () => {},
    logDebug: () => {},
  });

  const run = async (round: Round) => {
    currentRound = round;
    return runDurableSync({
      ctx,
      remotePeerId,
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: fetch,
      exactAssetUalsFor: exactAssetUals ? () => exactAssetUals : undefined,
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      storeGraphScopedAsset: async (request: DurableSyncGraphScopedStoreRequest) => {
        storedAssetUals.push(request.asset.ual);
        return 'applied';
      },
      deleteCheckpoint: (key) => deleteSyncPageCheckpoint(checkpointStore, key),
      setCheckpoint: (key, offset, manifestDigest, manifestPrefixDigest, terminal) => {
        if (manifestDigest) {
          checkpointStore.setManifestBoundOffset(
            key,
            offset,
            manifestDigest,
            Date.now(),
            manifestPrefixDigest,
            terminal,
          );
        }
        else checkpointStore.set(key, offset);
      },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });
  };

  return { checkpointStore, dataRequests, storedAssetUals, run };
}

function makeScenario(
  name: string,
  makeGenerations: (contextGraphId: string) => { x: AssetFixture[]; y: AssetFixture[] },
) {
  const contextGraphId = `manifest-${name}-${scenarioSequence++}`;
  const remotePeerId = `peer-${name}-${scenarioSequence}`;
  const generations = makeGenerations(contextGraphId);
  return { contextGraphId, remotePeerId, ...generations };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('manifest-bound durable DATA continuation', () => {
  it('resumes the same responder session for an unchanged manifest and completes', async () => {
    const { contextGraphId, remotePeerId, x } = makeScenario('unchanged', (cg) => ({
      x: ordered([asset(cg, 1), asset(cg, 3), asset(cg, 5)]),
      y: [],
    }));
    const harness = createTwoRoundHarness(contextGraphId, remotePeerId);
    const meta = x.flatMap((entry) => entry.meta);
    const firstPrefix = x[0]!.payload;

    const first = await harness.run({ meta, dataPage: () => firstPrefix });
    const checkpointKey = getSyncCheckpointKey(remotePeerId, contextGraphId, false, 'data');
    const established = harness.checkpointStore.get(checkpointKey);
    expect(first.complete).toBe(false);
    expect(established).toMatchObject({
      offset: firstPrefix.length,
      manifestDigest: createGraphScopedDurableManifestPlan(meta, contextGraphId)!.manifestDigest,
      responderSessionId: expect.any(String),
    });

    harness.dataRequests.length = 0;
    const second = await harness.run({
      meta: [...meta].reverse(),
      dataPage: (offset) => offset === firstPrefix.length
        ? x.slice(1).flatMap((entry) => entry.payload)
        : [],
    });

    expect(harness.dataRequests[0]).toMatchObject({
      offset: firstPrefix.length,
      syncSessionId: established?.responderSessionId,
      manifestDigest: established?.manifestDigest,
    });
    expect(second.complete).toBe(true);
    expect(harness.checkpointStore.get(checkpointKey)).toMatchObject({
      offset: x.flatMap((entry) => entry.payload).length,
      manifestDigest: established?.manifestDigest,
      terminal: true,
    });
  });

  it.each([
    ['equal-width replacement', (cg: string) => ({
      x: ordered([asset(cg, 1), asset(cg, 3), asset(cg, 5)]),
      y: ordered([asset(cg, 1), asset(cg, 2), asset(cg, 5)]),
    })],
    ['append', (cg: string) => ({
      x: ordered([asset(cg, 1), asset(cg, 3)]),
      y: ordered([asset(cg, 1), asset(cg, 3), asset(cg, 5)]),
    })],
    ['insertion', (cg: string) => ({
      x: ordered([asset(cg, 1), asset(cg, 5)]),
      y: ordered([asset(cg, 1), asset(cg, 3), asset(cg, 5)]),
    })],
    ['deletion', (cg: string) => ({
      x: ordered([asset(cg, 1), asset(cg, 3), asset(cg, 5)]),
      y: ordered([asset(cg, 1), asset(cg, 5)]),
    })],
  ] as const)('reuses the verified prefix and primes a fresh session on suffix %s', async (name, generationsFor) => {
    const { contextGraphId, remotePeerId, x, y } = makeScenario(name.replaceAll(' ', '-'), generationsFor);
    const harness = createTwoRoundHarness(contextGraphId, remotePeerId);
    const xMeta = x.flatMap((entry) => entry.meta);
    const yMeta = y.flatMap((entry) => entry.meta);
    const firstPrefix = x[0]!.payload;

    await harness.run({ meta: xMeta, dataPage: () => firstPrefix });
    const checkpointKey = getSyncCheckpointKey(remotePeerId, contextGraphId, false, 'data');
    const established = harness.checkpointStore.get(checkpointKey)!;
    expect(established).toMatchObject({
      offset: firstPrefix.length,
      manifestPrefixDigest: expect.stringMatching(/^sha256:/),
      responderSessionId: expect.any(String),
    });

    harness.dataRequests.length = 0;
    const second = await harness.run({
      meta: yMeta,
      dataPage: (offset) => offset === 0
        ? y[0]!.payload
        : offset === firstPrefix.length
          ? y.slice(1).flatMap((entry) => entry.payload)
          : [],
    });

    expect(harness.dataRequests.map(({ offset }) => offset).slice(0, 2))
      .toEqual([0, firstPrefix.length]);
    expect(harness.dataRequests[0]?.syncSessionId)
      .not.toBe(established.responderSessionId);
    expect(harness.dataRequests[1]?.syncSessionId)
      .toBe(harness.dataRequests[0]?.syncSessionId);
    expect(harness.dataRequests[1]?.manifestDigest)
      .toBe(createGraphScopedDurableManifestPlan(yMeta, contextGraphId)?.manifestDigest);
    expect(second.complete).toBe(true);
    expect(harness.checkpointStore.get(checkpointKey)).toMatchObject({
      offset: y.flatMap((entry) => entry.payload).length,
      manifestDigest: createGraphScopedDurableManifestPlan(yMeta, contextGraphId)?.manifestDigest,
      terminal: true,
    });
  });

  it.each([
    ['insertion before the prefix', (cg: string) => ({
      x: ordered([asset(cg, 1), asset(cg, 3)]),
      y: ordered([asset(cg, 0), asset(cg, 1), asset(cg, 3)]),
    })],
    ['deletion inside the prefix', (cg: string) => ({
      x: ordered([asset(cg, 1), asset(cg, 3)]),
      y: ordered([asset(cg, 3), asset(cg, 5)]),
    })],
    ['DATA-plan graph/order change', (cg: string) => ({
      x: ordered([asset(cg, 1, { subGraphName: 'a' }), asset(cg, 3, { subGraphName: 'z' })]),
      y: ordered([asset(cg, 1, { subGraphName: 'z' }), asset(cg, 3, { subGraphName: 'a' })]),
    })],
    ['public count change', (cg: string) => ({
      x: ordered([asset(cg, 1), asset(cg, 3)]),
      y: ordered([asset(cg, 1, { tripleCount: 5 }), asset(cg, 3)]),
    })],
    ['Merkle-root/content change', (cg: string) => ({
      x: ordered([asset(cg, 1), asset(cg, 3)]),
      y: ordered([
        asset(cg, 1, { valuePrefix: 'replacement' }),
        asset(cg, 3),
      ]),
    })],
  ] as const)('resets offset and token when %s changes the verified prefix', async (name, generationsFor) => {
    const { contextGraphId, remotePeerId, x, y } = makeScenario(name.replaceAll(' ', '-'), generationsFor);
    const harness = createTwoRoundHarness(contextGraphId, remotePeerId);
    const xMeta = x.flatMap((entry) => entry.meta);
    const yMeta = y.flatMap((entry) => entry.meta);
    const firstPrefix = x[0]!.payload;

    await harness.run({ meta: xMeta, dataPage: () => firstPrefix });
    const checkpointKey = getSyncCheckpointKey(remotePeerId, contextGraphId, false, 'data');
    const established = harness.checkpointStore.get(checkpointKey);
    expect(established?.offset).toBe(firstPrefix.length);
    expect(createGraphScopedDurableManifestPlan(yMeta, contextGraphId)?.manifestDigest)
      .not.toBe(established?.manifestDigest);

    harness.dataRequests.length = 0;
    const second = await harness.run({ meta: yMeta, dataPage: () => y[0]!.payload });

    expect(harness.dataRequests[0]?.offset).toBe(0);
    expect(harness.dataRequests[0]?.syncSessionId).not.toBe(established?.responderSessionId);
    expect(harness.dataRequests[0]?.manifestDigest)
      .toBe(createGraphScopedDurableManifestPlan(yMeta, contextGraphId)?.manifestDigest);
    expect(second.complete).toBe(false);
  });

  it('fails safe for a legacy checkpoint without a digest', async () => {
    const { contextGraphId, remotePeerId, x } = makeScenario('legacy-or-restart', (cg) => ({
      x: ordered([asset(cg, 1), asset(cg, 3)]),
      y: [],
    }));
    const harness = createTwoRoundHarness(contextGraphId, remotePeerId);
    const meta = x.flatMap((entry) => entry.meta);
    const prefix = x[0]!.payload;

    await harness.run({ meta, dataPage: () => prefix });
    const key = getSyncCheckpointKey(remotePeerId, contextGraphId, false, 'data');
    const established = harness.checkpointStore.get(key)!;
    deleteSyncPageCheckpoint(harness.checkpointStore, key);
    harness.checkpointStore.set(key, established.offset);
    harness.checkpointStore.setResponderSession(
      key,
      established.responderSessionId!,
      Date.now() + 60_000,
    );

    harness.dataRequests.length = 0;
    const second = await harness.run({ meta, dataPage: () => prefix });

    expect(harness.dataRequests[0]?.offset).toBe(0);
    expect(harness.dataRequests[0]?.syncSessionId).not.toBe(established.responderSessionId);
    expect(second.complete).toBe(false);
  });

  it('reuses a proven prefix after the responder forgets its session', async () => {
    const { contextGraphId, remotePeerId, x } = makeScenario('responder-restart', (cg) => ({
      x: ordered([asset(cg, 1), asset(cg, 3)]),
      y: [],
    }));
    const harness = createTwoRoundHarness(contextGraphId, remotePeerId);
    const meta = x.flatMap((entry) => entry.meta);
    const prefix = x[0]!.payload;

    await harness.run({ meta, dataPage: () => prefix });
    const key = getSyncCheckpointKey(remotePeerId, contextGraphId, false, 'data');
    const established = harness.checkpointStore.get(key)!;
    deleteSyncPageCheckpoint(harness.checkpointStore, key);
    harness.checkpointStore.setManifestBoundOffset(
      key,
      established.offset,
      established.manifestDigest!,
      Date.now(),
      established.manifestPrefixDigest,
    );

    harness.dataRequests.length = 0;
    const second = await harness.run({
      meta,
      dataPage: (offset) => offset === 0
        ? prefix
        : offset === prefix.length
          ? x[1]!.payload
          : [],
    });

    expect(harness.dataRequests.map(({ offset }) => offset).slice(0, 2))
      .toEqual([0, prefix.length]);
    expect(harness.dataRequests[0]?.syncSessionId)
      .not.toBe(established.responderSessionId);
    expect(harness.dataRequests[1]?.syncSessionId)
      .toBe(harness.dataRequests[0]?.syncSessionId);
    expect(second.complete).toBe(true);
  });

  it.each([
    ['declared session expiry', 'sync session expired'],
    ['opaque transport reset before any resumed page', 'stream reset'],
  ])('retains a proven prefix after %s', async (_name, failureMessage) => {
    const { contextGraphId, remotePeerId, x } = makeScenario('responder-expired', (cg) => ({
      x: ordered([asset(cg, 1), asset(cg, 3)]),
      y: [],
    }));
    const harness = createTwoRoundHarness(contextGraphId, remotePeerId);
    const meta = x.flatMap((entry) => entry.meta);
    const prefix = x[0]!.payload;

    await harness.run({ meta, dataPage: () => prefix });
    const key = getSyncCheckpointKey(remotePeerId, contextGraphId, false, 'data');
    const established = harness.checkpointStore.get(key)!;
    expect(established).toMatchObject({
      offset: prefix.length,
      responderSessionId: expect.any(String),
      manifestPrefixDigest: expect.stringMatching(/^sha256:/),
    });

    await harness.run({
      meta,
      dataPage: () => new Error(failureMessage),
    });
    expect(harness.checkpointStore.get(key)).toMatchObject({
      offset: prefix.length,
      manifestDigest: established.manifestDigest,
      manifestPrefixDigest: established.manifestPrefixDigest,
    });
    expect(harness.checkpointStore.get(key)?.responderSessionId).toBeUndefined();

    harness.dataRequests.length = 0;
    const recovered = await harness.run({
      meta,
      dataPage: (offset) => offset === 0
        ? prefix
        : offset === prefix.length
          ? x[1]!.payload
          : [],
    });

    expect(harness.dataRequests.map(({ offset }) => offset).slice(0, 2))
      .toEqual([0, prefix.length]);
    expect(harness.dataRequests[0]?.syncSessionId)
      .not.toBe(established.responderSessionId);
    expect(recovered.complete).toBe(true);
  });

  it('scopes the manifest before exact recovery when an old responder over-returns', async () => {
    const contextGraphId = `manifest-exact-over-return-${scenarioSequence++}`;
    const remotePeerId = 'peer-exact-over-return';
    const [unrequested, requested] = ordered([
      asset(contextGraphId, 1),
      asset(contextGraphId, 3),
    ]);
    const fullMeta = [...unrequested!.meta, ...requested!.meta];
    const fullData = [...unrequested!.payload, ...requested!.payload];
    const requestedPlan = createGraphScopedDurableManifestPlan(
      requested!.meta,
      contextGraphId,
    )!;
    const harness = createTwoRoundHarness(
      contextGraphId,
      remotePeerId,
      new MemorySyncCheckpointStore(),
      [requested!.ual],
    );

    const result = await harness.run({
      meta: fullMeta,
      // Simulate a rolling responder that ignores assetUals and returns the
      // complete Context Graph in its legacy order.
      dataPage: (offset) => offset === 0 ? fullData : [],
    });

    expect(harness.dataRequests[0]?.manifestDigest).toBe(requestedPlan.manifestDigest);
    expect(harness.storedAssetUals).toEqual([requested!.ual]);
    expect(result.complete).toBe(true);
  });

  it('restarts exact recovery at zero after its page-only responder session is rejected', async () => {
    const contextGraphId = `manifest-exact-session-loss-${scenarioSequence++}`;
    const remotePeerId = 'peer-exact-session-loss';
    const requested = ordered([
      asset(contextGraphId, 7),
      asset(contextGraphId, 9),
    ]);
    const requestedUals = requested.map(({ ual }) => ual);
    const meta = requested.flatMap(({ meta: assetMeta }) => assetMeta);
    const harness = createTwoRoundHarness(
      contextGraphId,
      remotePeerId,
      new MemorySyncCheckpointStore(),
      requestedUals,
    );

    await harness.run({ meta, dataPage: () => requested[0]!.payload });
    const key = getSyncCheckpointKey(
      remotePeerId,
      contextGraphId,
      false,
      'data',
      undefined,
      undefined,
      undefined,
      exactAssetFilterKey(requestedUals),
    );
    const established = harness.checkpointStore.get(key)!;
    expect(established.offset).toBe(requested[0]!.payload.length);
    await harness.run({
      meta,
      dataPage: () => new Error('sync session expired'),
    });
    expect(harness.checkpointStore.get(key)).toBeUndefined();

    harness.dataRequests.length = 0;
    const result = await harness.run({
      meta,
      dataPage: (offset) => offset === 0
        ? requested.flatMap(({ payload }) => payload)
        : [],
    });

    expect(harness.dataRequests[0]?.offset).toBe(0);
    expect(harness.dataRequests[0]?.syncSessionId)
      .not.toBe(established.responderSessionId);
    expect(result.complete).toBe(true);
  });

  it('does not issue DATA or complete when META transport is incomplete', async () => {
    const contextGraphId = `manifest-incomplete-meta-${scenarioSequence++}`;
    let dataFetches = 0;
    const result = await runDurableSync({
      ctx,
      remotePeerId: 'peer-incomplete-meta',
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({ phase }) => {
        if (phase === 'data') dataFetches += 1;
        return {
          quads: [],
          bytesReceived: 0,
          resumedFromOffset: 0,
          nextOffset: 1,
          checkpointKey: `${contextGraphId}:${phase}`,
          completed: phase === 'data',
          timedOut: phase === 'meta',
        };
      },
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(dataFetches).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.failedPhases).toBe(1);
  });

  it('deletes a resumed META suffix checkpoint before refusing DATA', async () => {
    const contextGraphId = `manifest-resumed-meta-${scenarioSequence++}`;
    const deleteCheckpoint = vi.fn();
    let dataFetches = 0;
    const result = await runDurableSync({
      ctx,
      remotePeerId: 'peer-resumed-meta',
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({ phase }) => {
        if (phase === 'data') dataFetches += 1;
        return {
          quads: [],
          bytesReceived: 0,
          resumedFromOffset: phase === 'meta' ? 10 : 0,
          nextOffset: phase === 'meta' ? 20 : 0,
          checkpointKey: `${contextGraphId}:${phase}`,
          completed: true,
          timedOut: false,
        };
      },
      processDurableBatchInWorker: processBatch,
      storeInsert: async () => {},
      deleteCheckpoint,
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(deleteCheckpoint).toHaveBeenCalledWith(`${contextGraphId}:meta`);
    expect(dataFetches).toBe(0);
    expect(result.complete).toBe(false);
  });

  it('deletes a manifest-bound DATA checkpoint when verification rejects a graph', async () => {
    const contextGraphId = `manifest-rejected-data-${scenarioSequence++}`;
    const remotePeerId = 'peer-rejected-data';
    const fixture = asset(contextGraphId, 1);
    const checkpointKey = getSyncCheckpointKey(
      remotePeerId,
      contextGraphId,
      false,
      'data',
    );
    const deleteCheckpoint = vi.fn();
    const result = await runDurableSync({
      ctx,
      remotePeerId,
      contextGraphIds: [contextGraphId],
      durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
      fetchSyncPages: async ({ phase, manifestDigest }) => ({
        quads: phase === 'meta' ? fixture.meta : fixture.payload,
        bytesReceived: 1,
        resumedFromOffset: 0,
        ...(phase === 'data' && manifestDigest ? { manifestDigest } : {}),
        nextOffset: phase === 'meta' ? fixture.meta.length : fixture.payload.length,
        checkpointKey: phase === 'data' ? checkpointKey : `${contextGraphId}:meta`,
        completed: true,
        timedOut: false,
      }),
      processDurableBatchInWorker: async (...args) => ({
        ...processBatch(...args),
        rejectedKcs: 1,
      }),
      storeInsert: async () => {},
      storeGraphScopedAsset: async () => 'applied',
      deleteCheckpoint,
      setCheckpoint: () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(deleteCheckpoint).toHaveBeenCalledWith(checkpointKey);
    expect(result.complete).toBe(false);
  });
});
