import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { createAgentStoreComposition } from '../src/internal/agent-store-composition.js';
import type { StoreRecoveryGenerationReader } from '@origintrail-official/dkg-storage';
import { createDurableHeldStore, createStoredPrefixAcquirer } from '../src/durable-recovery-held-store.js';
import { runAdmittedDurableGraph } from '../src/durable-recovery-graph.js';
import type { DurableRecoveryHost } from '../src/durable-recovery-host.js';
import { exactAssetFetchSessionPolicy } from '../src/sync/requester/exact-durable-fetch.js';
import { createUalOnlyExactAssetSelection } from '../src/sync/exact-assets.js';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { StoreContentFence } from '../src/internal/store-content-fence.js';
import { createObservedStoreMutation } from '../src/internal/observed-store-mutation.js';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { RecoveryMaterializationOwner } from '../src/durable-recovery-materialization.js';
import type { ContextGraphSub } from '../src/dkg-agent-types.js';
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
  overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, OxigraphWorkerStore, asStoreRecoveryGenerationReader, type TripleStore, type Quad } from '@origintrail-official/dkg-storage';
import { SYNC_PAGE_SIZE } from '../src/dkg-agent-constants.js';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { createGraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import { DurableRecoveryRunner, type DurableRecoveryRunnerDependencies } from '../src/sync/durable-recovery-runner.js';
import { classifyDurableProgress } from '../src/sync/durable-progress.js';
import {
  readHeldGraphScopedAssets,
} from '../src/sync/requester/stored-graph-assets.js';
import {
  runDurableSyncDetailed,
  type DurableMetaContinuation,
  type DurableSyncContext,
} from '../src/sync/requester/durable-sync.js';
import { authenticateVerifiedGraphScopedAsset, materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { deleteSyncPageCheckpoint, fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { processDurableBatchForWire } from '../src/sync-verify-worker-impl.js';
import type { DurableBatchVerificationMode } from '../src/sync-verify-worker.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';

const CG = 'stored-prefix-cg';
const PEER = '12D3KooWHeldRestartPeer';
const SECOND_PEER = '12D3KooWHeldRestartPeerTwo';
const ctx = { operationId: 'held-restart', operationName: 'sync' } as OperationContext;
const stores: TripleStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

interface AssetFixture {
  readonly ual: string;
  readonly graph: string;
  readonly payload: Quad[];
  readonly meta: Quad[];
  readonly version: string;
  readonly rootHex: string;
}

function asset(kaNumber: number, version = '1', privateOnly = false): AssetFixture {
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/${kaNumber}`;
  const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, version));
  const privateRoot = privateOnly ? new Uint8Array(32).fill(0x66) : undefined;
  const payload = Array.from({ length: privateOnly ? 0 : 4 + kaNumber }, (_, index): Quad => ({
    subject: `urn:held-restart:${kaNumber}:${index}`,
    predicate: 'urn:held-restart:value',
    object: `"v${version}-${index}"`,
    graph,
  }));
  const merkleRoot = computeFlatKCRootV10(payload, privateRoot ? [privateRoot] : []);
  const meta = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId: CG,
    merkleRoot,
    publisherPeerId: 'publisher-peer',
    accessPolicy: 'public',
    timestamp: new Date(0),
    assertionVersion: version,
    publicTripleCount: payload.length,
    privateTripleCount: privateRoot ? 1 : 0,
    ...(privateRoot ? { privateMerkleRoot: privateRoot } : {}),
    assertionGraph: graph,
  }, { status: 'tentative' });
  return { ual, graph, payload, meta, version, rootHex: Buffer.from(merkleRoot).toString('hex') };
}

/**
 * A peer serving one graph: META, then DATA in manifest order (exact graphs by
 * code point), both narrowed to the requested assets of an exact request.
 */
function servingPeer(initial: AssetFixture[]) {
  let assets = initial;
  let pending: { phase: string; offset: number; limit: number; assetUals?: string[] } | undefined;
  const responses = new Map<string, Quad[]>();
  const served = { dataRequests: 0, dataRows: 0, exactDataRows: 0 };
  return {
    served,
    publish(next: AssetFixture[]) { assets = next; },
    current: () => assets,
    buildSyncRequest: async (
      _cg: string, offset: number, limit: number, _swm: boolean, _peer: string, phase?: string,
      _snapshotRef?: string, _sinceBatchId?: string, _session?: string, _recovery?: boolean, assetUals?: string[],
    ) => {
      pending = { phase: phase ?? 'data', offset, limit, assetUals };
      return new TextEncoder().encode('request');
    },
    send: async () => {
      const { phase, offset, limit, assetUals } = pending!;
      const selected = [...assets]
        .filter((fixture) => assetUals === undefined || assetUals.includes(fixture.ual))
        .sort((left, right) => (left.graph < right.graph ? -1 : left.graph > right.graph ? 1 : 0));
      const page = (phase === 'meta' ? selected.flatMap((fixture) => fixture.meta) : selected.flatMap((fixture) => fixture.payload))
        .slice(offset, offset + limit);
      if (phase === 'data') {
        served.dataRequests += 1;
        served.dataRows += page.length;
        if (assetUals !== undefined) served.exactDataRows += page.length;
      }
      if (page.length === 0) return new Uint8Array();
      const id = `response-${responses.size}`;
      responses.set(id, page);
      return new TextEncoder().encode(id);
    },
    parseAndFilter: async (body: string) => {
      const quads = responses.get(body) ?? [];
      return { quads, totalQuads: quads.length };
    },
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

type ServingPeer = ReturnType<typeof servingPeer>;

/**
 * One node: its triple store survives a restart; checkpoints and the owner's
 * memory need not. Its chain is the generation the first peer serves unless a
 * test moves it.
 */
function node(
  serving: ServingPeer | Record<string, ServingPeer>,
  options: { store?: TripleStore; signal?: () => AbortSignal | undefined; failAssetStore?: () => boolean; noChain?: boolean; exactPaging?: boolean; recoveryGeneration?: StoreRecoveryGenerationReader; subscriptionId?: () => string; bindingGeneration?: () => number; disablePrefixProof?: () => boolean; subscription?: () => ContextGraphSub | undefined; beforeVerify?: () => Promise<void>; afterAssetStore?: () => Promise<void>; beforeMetaStore?: () => Promise<void> } = {},
) {
  const peers: Record<string, ServingPeer> = 'send' in serving ? { [PEER]: serving as ServingPeer } : serving;

  const rawStore = options.store ?? new OxigraphStore();
  stores.push(rawStore);
  const production = createAgentStoreComposition(rawStore, () => {}, { begin: () => () => {} });
  const contentFence = options.recoveryGeneration ? new StoreContentFence(options.recoveryGeneration) : production.heldContent;
  const store = options.recoveryGeneration
    ? createMutationObservedStore(rawStore, createObservedStoreMutation(() => {}, contentFence)) : production.store;
  const writes: string[] = [];
  const info: string[] = [];
  let defaultSubscription: ContextGraphSub = { syncMode: 'always-on', subscribed: true, synced: true, onChainId: '323' };
  const materialization = new RecoveryMaterializationOwner({
    chain: () => { throw new Error('chain reads supplied below'); }, store: () => store,
    isClosed: () => false, subscription: () => {
      if (options.subscription) return options.subscription();
      const onChainId = options.subscriptionId?.() ?? '323';
      if (defaultSubscription.onChainId !== onChainId) defaultSubscription = { ...defaultSubscription, onChainId };
      return defaultSubscription;
    },
    bindingGeneration: () => options.bindingGeneration?.() ?? 0, isBindingGenerationCurrent: (_id, captured) => captured === (options.bindingGeneration?.() ?? 0),
    track: () => {}, verifyBinding: async () => true,
    persistSubscription: async () => { throw new Error('already bound'); },
    bindSubscription: () => { throw new Error('already bound'); }, recordDrops: () => {}, reconcile: async () => {},
  }).forOperation({ ctx, contextGraphId: CG, authority: {
    coalescing: 'owner-only', admitVerifiedPage() {}, isRegisteredPublic: () => true,
    authenticate: () => { throw new Error('materialization supplied below'); },
  } });
  const round = (
    checkpointStore: MemorySyncCheckpointStore,
    remotePeerId: string,
    roundOptions: Pick<DurableSyncContext, 'durableMetaContinuation' | 'durableResumeBoundary' | 'settlementSliceDeadline'>,
  ) => materialization.withHeldAssetFence(async fence => {
    const context: DurableSyncContext = {
    ctx,
    remotePeerId,
    contextGraphIds: [CG],
    signal: options.signal?.(),
    durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 60_000),
    fetchSyncPages: (request) => fetchSyncPages({
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
      protocolSync: '/test/durable-held-restart',
      checkpointStore,
      forceFreshSession: request.forceFreshSession,
      manifestDigest: request.manifestDigest,
      manifestPrefixDigestAtOffset: request.manifestPrefixDigestAtOffset,
      durableResumeBoundary: request.durableResumeBoundary,
      shouldStopAfterPage: request.shouldStopAfterPage,
      returnAcceptedPrefixOnRetryableTransportFailure: request.returnAcceptedPrefixOnRetryableTransportFailure,
      requesterScope: request.requesterScope,
      assetUals: request.exactAssetUals,
      buildSyncRequest: peers[request.remotePeerId]!.buildSyncRequest,
      send: peers[request.remotePeerId]!.send,
      parseAndFilter: peers[request.remotePeerId]!.parseAndFilter,
      logWarn: () => {},
      logInfo: () => {},
      logDebug: () => {},
    }),
    ...roundOptions,
    storedPrefix: options.disablePrefixProof?.() ? undefined : createStoredPrefixAcquirer(createDurableHeldStore(store, contentFence, () => options.noChain ? 'integrity-only' : 'confirmed')?.prove, CG, fence.assertCurrent),
    processDurableBatchInWorker: async (...args) => { await options.beforeVerify?.(); return processBatch(...args); },
    storeInsert: async ({ quads }) => { await options.beforeMetaStore?.(); await store.insert(quads); },
    storeGraphScopedAsset: async ({ asset: verified }) => {
      if (options.failAssetStore?.()) throw new Error('authentication budget expired before next asset');
      writes.push(verified.ual);
      // As chain authentication leaves it: confirmed, written with its rows in one replacement.
      const metadataQuads = options.noChain ? (await authenticateVerifiedGraphScopedAsset({ chainId: 'none' } as ChainAdapter, verified)).asset.metadataQuads : overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(
        verified.metadataQuads,
        { ual: verified.ual, metaGraph: verified.metaGraph, receivedAt: new Date(0) },
        {
          status: 'confirmed',
          materializedVersion: { blockNumber: 1, txIndex: 0 },
          confirmation: { kind: 'finalized-materialization' },
        },
      );
      const result = await materializeVerifiedGraphScopedAsset({ store, asset: { ...verified, metadataQuads } });
      await options.afterAssetStore?.();
      return result;
    },
    deleteCheckpoint: (key) => deleteSyncPageCheckpoint(checkpointStore, key),
    setCheckpoint: (key, checkpoint) => {
      if (checkpoint.binding) {
        checkpointStore.setManifestBoundOffset(key, checkpoint.offset, checkpoint.binding.manifestDigest, Date.now(),
          checkpoint.binding.manifestPrefixDigest, checkpoint.binding.terminal, checkpoint.responderSessionOffset);
      } else checkpointStore.set(key, checkpoint.offset, Date.now(), checkpoint.responderSessionOffset);
    },
    logInfo: (_ctx, message) => { info.push(message); },
    logWarn: (_ctx, message) => { info.push(message); },
    logDebug: () => {},
    };
    if (!options.exactPaging) return runDurableSyncDetailed(context);
    const selection = createUalOnlyExactAssetSelection(peers[remotePeerId]!.current().map(f => f.ual));
    if (selection.kind !== 'ual-only') throw new Error('Expected UAL selection');
    const host: DurableRecoveryHost = {
      owner: {}, policy: () => ({}), admission: { run: request => request.work() },
      transport: { fetchPages: request => context.fetchSyncPages(request), stream: () => ({} as ReturnType<DurableRecoveryHost['transport']['stream']>) },
      verification: { processBatch: context.processDurableBatchInWorker, parseAndFilter: peers[remotePeerId]!.parseAndFilter },
      storeInsert: context.storeInsert, checkpoints: { deleteCheckpoint: context.deleteCheckpoint, setCheckpoint: context.setCheckpoint },
      log: { info: context.logInfo, warn: context.logWarn, debug: context.logDebug },
      reconcile: async () => {}, resolveOrdinaryAuthority: () => { throw new Error('supplied authority'); },
      materialization: () => ({ ...materialization, storeGraphScopedAsset: context.storeGraphScopedAsset! }),
      heldStore: options.disablePrefixProof?.() ? undefined : createDurableHeldStore(store, contentFence),
    };
    return runAdmittedDurableGraph({ host, ctx, remotePeerId, contextGraphId: CG, remainingContextGraphs: 1,
      authority: { coalescing: 'owner-only', admitVerifiedPage() {}, isRegisteredPublic: () => true,
        authenticate: () => { throw new Error('supplied materialization'); } },
      options: { exactAssetFetchPolicy: exactAssetFetchSessionPolicy(selection), exactRecoveryTransportMode: 'legacy',
        settlementSliceTimeoutMs: roundOptions.settlementSliceDeadline === undefined ? undefined : 1 },
    });
  }, options.signal?.());

  /**
   * A process lifetime: a new owner and a new checkpoint store. With
   * `sliceSpent`, each round starts past its slice's soft deadline, as once
   * held-copy checks used the slice: a DATA round stops at its first complete graph.
   */
  const start = (startOptions: { sliceSpent?: boolean | (() => boolean); isRunning?: () => boolean; peerIds?: () => string[]; afterSlice?: () => void } = {}) => {
    const checkpointStore = new MemorySyncCheckpointStore();
    const dependencies: DurableRecoveryRunnerDependencies = {
      checkpointStore,
      isRunning: startOptions.isRunning ?? (() => true),
      resolvePreferredPeerId: async () => undefined,
      connectRequestedPeer: async () => {},
      primeConnections: async () => {},
      liveConnectionPeerIds: startOptions.peerIds ?? (() => Object.keys(peers)),
      admitPeer: async () => true,
      isPrivateContextGraph: async () => false,
      orderPeerIds: (peerIds) => [...peerIds],
      isSyncCapable: async () => true,
      executeSlice: async (peerId, durableMetaContinuation: DurableMetaContinuation, durableResumeBoundary) => {
        const detailed = await round(checkpointStore, peerId, {
          durableMetaContinuation, durableResumeBoundary,
          settlementSliceDeadline: (typeof startOptions.sliceSpent === 'function' ? startOptions.sliceSpent() : startOptions.sliceSpent) ? Date.now() : undefined,
        });
        startOptions.afterSlice?.();
        return detailed.result;
      },
      logDebug: () => {},
      logInfo: (message) => { info.push(message); },
      logWarn: (message) => { info.push(message); },
    };
    const runner = new DurableRecoveryRunner();
    return {
      checkpointStore,
      recover: () => runner.run({ contextGraphId: CG, dependencies }),
    };
  };
  return { rawStore, store, writes, info, start, round };
}

const generation = (version3 = '1') => [1, 2, 3, 4, 5, 6].map((n) => asset(n, n === 3 ? version3 : '1'));
const rowsOf = (fixtures: readonly AssetFixture[]) => fixtures.reduce((rows, fixture) => rows + fixture.payload.length, 0);

describe('cross-peer recovery keeps the actually stored prefix', () => {
  it.each(['clean', 'deleted', 'corrupted', 'metadata', 'missing-context', 'wrong-context', 'during-verification', 'during-store'].flatMap(change => [false, true].map(samePeer => ({ change, samePeer }))))('checks a live checkpoint after $change (same peer: $samePeer)', async ({ change, samePeer }) => {
    const fixtures = generation();
    const a = servingPeer(fixtures), b = servingPeer(fixtures);
    let running = true, first = true, activePeer = PEER, changed = false;
    let prefix: AssetFixture;
    const mutate = async () => {
      if (first || changed) return;
      changed = true;
      await core.store.dropGraph(prefix.graph);
    };
    const core = node({ [PEER]: a, [SECOND_PEER]: b }, {
      beforeVerify: change === 'during-verification' ? mutate : undefined,
      afterAssetStore: change === 'during-store' ? mutate : undefined,
    });
    const lifetime = core.start({ sliceSpent: () => first,
      isRunning: () => running, peerIds: () => [activePeer],
      afterSlice: () => { if (first) running = false; },
    });
    const partial = await lifetime.recover();
    expect(partial.outcome).toBe('no-progress');
    const sourceKey = getSyncCheckpointKey(PEER, CG, false, 'data');
    const checkpoint = lifetime.checkpointStore.get(sourceKey)!;
    expect(checkpoint.offset).toBeGreaterThan(0);
    expect(checkpoint.offset).toBeLessThan(rowsOf(fixtures));
    expect(checkpoint.terminal).not.toBe(true);
    prefix = fixtures.find(fixture => core.writes.includes(fixture.ual))!;
    expect(await core.store.countQuads(prefix.graph)).toBe(prefix.payload.length);
    if (change === 'deleted') await core.store.dropGraph(prefix.graph);
    if (change === 'corrupted') {
      await core.store.delete([prefix.payload[0]!]);
      await core.store.insert([{ ...prefix.payload[0]!, object: '"tampered"' }]);
    }
    if (change === 'metadata') {
      const root = prefix.meta.find(q => q.predicate === 'http://dkg.io/ontology/merkleRoot')!;
      const wrong = { ...root, object: root.object.replace(/[a-f0-9]{64}/i, 'f'.repeat(64)) };
      expect(wrong.object).not.toBe(root.object);
      await core.store.delete([root]); await core.store.insert([wrong]);
      expect(await core.store.countQuads(prefix.graph)).toBe(prefix.payload.length);
      const held = await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
        descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors });
      expect(held.has(prefix.ual)).toBe(false);
    }
    if (change === 'missing-context' || change === 'wrong-context') {
      const binding = prefix.meta.find(q => q.predicate === 'http://dkg.io/ontology/contextGraph')!;
      await core.store.delete([binding]);
      if (change === 'wrong-context') await core.store.insert([{ ...binding, object: 'did:dkg:context-graph:wrong' }]);
      const held = await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
        descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors });
      expect(held.has(prefix.ual)).toBe(false);
    }
    // Keep the original checkpoint and owner alive; only the serving peer changes.
    expect(lifetime.checkpointStore.get(sourceKey)).toEqual(checkpoint);
    first = false; running = true; activePeer = samePeer ? PEER : SECOND_PEER;
    const recovered = await lifetime.recover();
    expect(recovered.outcome).toBe('terminal');
    expect(recovered.result.complete).toBe(true);
    expect(classifyDurableProgress(recovered.result, { complete: recovered.result.complete }).completedReadinessCleanly).toBe(true);
    const held = await readHeldGraphScopedAssets(core.store, {
      contextGraphId: CG, descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(fixture => fixture.meta), CG)!.descriptors,
    });
    expect(held).toEqual(new Set(fixtures.map(fixture => fixture.ual)));
    expect(lifetime.checkpointStore.get(getSyncCheckpointKey(activePeer, CG, false, 'data'))?.terminal).toBe(true);
    // A new peer primes its generation at offset zero, then resumes. The stored
    // prefix must not be materialized again unless its actual content is invalid.
    expect(core.writes.filter(ual => ual === prefix.ual)).toHaveLength(change === 'clean' ? 1 : 2);
    const root = prefix.meta.find(q => q.predicate === 'http://dkg.io/ontology/merkleRoot')!;
    expect(await core.store.query(`ASK { GRAPH <${root.graph}> { <${root.subject}> <${root.predicate}> ${root.object} } }`))
      .toEqual({ type: 'boolean', value: true });
  });
});



describe('resumed-prefix edge cases', () => {
  it('settles mixed public/private manifests without rewriting the proven private prefix', async () => {
    const fixtures = [asset(1), asset(2, '1', true), asset(3), asset(4)];
    const core = node(servingPeer(fixtures));
    let rounds = 0;
    const recovered = await core.start({ sliceSpent: true, isRunning: () => rounds < 12, afterSlice: () => { rounds++; } }).recover();
    expect(recovered.outcome).toBe('terminal');
    expect(core.writes).toEqual(fixtures.map(f => f.ual));
    expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
      descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors }))
      .toEqual(new Set(fixtures.map(f => f.ual)));
  });

  it.each([false, true])('repairs ordinary tokenless resumes (proof unavailable: %s)', async unavailable => {
    const fixtures = generation(); let disableProof = false;
    const core = node(servingPeer(fixtures), { disablePrefixProof: () => disableProof });
    const checkpoints = new MemorySyncCheckpointStore();
    const first = await core.round(checkpoints, PEER, { settlementSliceDeadline: Date.now() });
    expect(first.result.complete).toBe(false);
    const key = getSyncCheckpointKey(PEER, CG, false, 'data');
    const saved = checkpoints.get(key)!;
    expect(saved.offset).toBeGreaterThan(0);
    const prefix = fixtures.find(f => core.writes.includes(f.ual))!;
    await core.store.dropGraph(prefix.graph);
    deleteSyncPageCheckpoint(checkpoints, key);
    checkpoints.setManifestBoundOffset(key, saved.offset, saved.manifestDigest!, saved.updatedAtMs, saved.manifestPrefixDigest);
    disableProof = unavailable;
    let next = await core.round(checkpoints, PEER, {});
    if (!next.result.complete) {
      expect(checkpoints.get(key)?.terminal).not.toBe(true);
      next = await core.round(checkpoints, PEER, {});
    }
    expect(next.result.complete).toBe(true);
    expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
      descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors }))
      .toEqual(new Set(fixtures.map(f => f.ual)));
  });

  it.each(['generation', 'subscription'])('refuses prefix reuse after %s ownership changes', async change => {
    const fixtures = generation(); let first = true, running = true, bindingGeneration = 0;
    let subscription: ContextGraphSub = { syncMode: 'always-on', subscribed: true, synced: true, onChainId: '323' };
    const core = node(servingPeer(fixtures), {
      bindingGeneration: () => bindingGeneration, subscription: () => subscription,
      beforeVerify: async () => {
        if (first) return;
        if (change === 'generation') bindingGeneration++;
        else subscription = { ...subscription };
        running = false;
      },
    });
    const lifetime = core.start({ sliceSpent: () => first, isRunning: () => running,
      afterSlice: () => { if (first) running = false; } });
    await lifetime.recover();
    const before = core.writes.length;
    expect(before).toBeGreaterThan(0);
    first = false; running = true;
    const next = await lifetime.recover();
    expect(next.result.complete).toBe(false);
    expect(next.outcome).not.toBe('terminal');
    expect(core.writes).toHaveLength(before);
    expect(lifetime.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal).not.toBe(true);
    expect(classifyDurableProgress(next.result, { complete: next.result.complete }).completedReadinessCleanly).toBe(false);
  });
});

it('completes bounded recovery after an unrelated indeterminate write', async () => {
  const fixtures = generation();
  const core = node(servingPeer(fixtures));
  vi.spyOn(core.rawStore, 'dropGraph').mockRejectedValueOnce(new Error('lost response'));
  await expect(core.store.dropGraph('urn:unrelated-failed-write')).rejects.toThrow('lost response');
  let rounds = 0;
  const result = await core.start({  sliceSpent: true, isRunning: () => rounds < 20,
    afterSlice: () => { rounds++; } }).recover();
  expect(result.outcome).toBe('terminal');
  expect(rounds).toBeGreaterThan(1);
  expect(core.writes).toEqual(fixtures.map(f => f.ual));
  expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
    descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors }))
    .toEqual(new Set(fixtures.map(f => f.ual)));
});

it('continues the prefix between independently materialized replicas', async () => {
  const fixtures = generation();
  const replica = (receivedAt: Date) => fixtures.map(f => ({ ...f,
    meta: overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(f.meta,
      { ual: f.ual, metaGraph: f.meta[0]!.graph, receivedAt },
      { status: 'confirmed', materializedVersion: { blockNumber: 1, txIndex: 0 },
        confirmation: { kind: 'finalized-materialization' } }),
  }));
  const left = replica(new Date('2026-01-01T00:00:00Z'));
  const right = replica(new Date('2026-02-01T00:00:00Z'));
  expect(left[0]!.meta).not.toEqual(right[0]!.meta);
  const core = node({ [PEER]: servingPeer(left), [SECOND_PEER]: servingPeer(right) });
  let first = true, running = true, activePeer = PEER;
  const lifetime = core.start({  sliceSpent: () => first, isRunning: () => running,
    peerIds: () => [activePeer], afterSlice: () => { if (first) running = false; } });
  await lifetime.recover();
  const prefix = core.writes[0]!;
  expect(lifetime.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.offset).toBeGreaterThan(0);
  first = false; running = true; activePeer = SECOND_PEER;
  expect((await lifetime.recover()).outcome).toBe('terminal');
  expect(core.writes.filter(ual => ual === prefix)).toHaveLength(1);
  expect(core.writes).toEqual(fixtures.map(f => f.ual));
});


it.each(['overlapping', 'unknown'])('recovers bounded DATA after confirmed backend replacement (%s uncertain write)', async scope => {
  const fixtures = generation(); let epoch: number | undefined = 0;
  const core = node(servingPeer(fixtures), { recoveryGeneration: () => epoch === undefined ? undefined : { generation: epoch, ready: true } });
  if (scope === 'overlapping') {
    vi.spyOn(core.rawStore, 'dropGraph').mockRejectedValueOnce(new Error('lost response'));
    await expect(core.store.dropGraph(fixtures[0]!.graph)).rejects.toThrow('lost response');
  } else {
    vi.spyOn(core.rawStore, 'update').mockRejectedValueOnce(new Error('lost response'));
    await expect(core.store.update('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }')).rejects.toThrow('lost response');
  }
  let rounds = 0;
  const lifetime = core.start({ sliceSpent: true, isRunning: () => rounds < 8, afterSlice: () => { rounds++; } });
  const unsafe = await lifetime.recover();
  expect(unsafe.outcome).not.toBe('terminal');
  expect(unsafe.result.complete).toBe(false);
  epoch = undefined; rounds = 0; // A restart request is still not completion.
  expect((await lifetime.recover()).outcome).not.toBe('terminal');
  // The abandoned old operation can still corrupt the stored prefix before termination.
  await core.rawStore.delete(fixtures[0]!.payload);
  epoch = 1; rounds = 0; // Supervisor confirms old process death and replacement readiness.
  const recovered = await lifetime.recover();
  expect(recovered.outcome).toBe('terminal');
  expect(rounds).toBeGreaterThan(1);
  expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
    descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors }))
    .toEqual(new Set(fixtures.map(f => f.ual)));
});

it('finishes bounded no-chain recovery while retaining tentative status', async () => {
  const fixtures = generation();
  const core = node(servingPeer(fixtures), { noChain: true });
  let rounds = 0;
  const result = await core.start({ sliceSpent: true, isRunning: () => rounds < 12, afterSlice: () => { rounds++; } }).recover();
  expect(result.outcome).toBe('terminal');
  expect(rounds).toBeGreaterThan(1);
  expect(core.writes).toEqual(fixtures.map(f => f.ual));
  const request = { contextGraphId: CG, descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors };
  expect(await readHeldGraphScopedAssets(core.store, request)).toEqual(new Set());
  expect(await readHeldGraphScopedAssets(core.store, request, undefined, 'integrity-only')).toEqual(new Set(fixtures.map(f => f.ual)));
  for (const f of fixtures) expect(await core.store.query(`ASK { GRAPH <${f.meta[0]!.graph}> { <${f.ual}> <http://dkg.io/ontology/status> "tentative" } }`)).toEqual({ type: 'boolean', value: true });
});

it.each(['clean', 'deleted', 'corrupted', 'unavailable'])('resumes production exact paging with a %s stored prefix', async change => {
  const fixtures = generation(); let fail = true, attempts = 0;
  const core = node(servingPeer(fixtures), { exactPaging: true, disablePrefixProof: () => change === 'unavailable', failAssetStore: () => fail && ++attempts > 1 });
  const checkpoints = new MemorySyncCheckpointStore();
  const first = await core.round(checkpoints, PEER, {});
  expect(first.result.complete).toBe(false);
  fail = false;
  const prefix = fixtures.find(f => core.writes.includes(f.ual))!;
  expect(prefix).toBeDefined();
  if (change === 'deleted') await core.store.dropGraph(prefix.graph);
  if (change === 'corrupted') {
    await core.store.delete([prefix.payload[0]!]);
    await core.store.insert([{ ...prefix.payload[0]!, object: '"corrupt"' }]);
  }
  let next = await core.round(checkpoints, PEER, {});
  if (!next.result.complete) next = await core.round(checkpoints, PEER, {});
  expect(next.result.complete).toBe(true);
  expect(core.writes.filter(ual => ual === prefix.ual)).toHaveLength(change === 'clean' ? 1 : 2);
  expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
    descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors }))
    .toEqual(new Set(fixtures.map(f => f.ual)));
});

it('reuses a bounded prefix after an uncertain write rejects during supervised recovery', async () => {
  const fixtures = generation(); let epoch = 0, recovering = false;
  const read = () => ({ generation: epoch, ready: !recovering });
  const core = node(servingPeer(fixtures), { recoveryGeneration: read });
  vi.spyOn(core.rawStore, 'dropGraph').mockImplementationOnce(async () => {
    epoch = 1; recovering = true;
    throw new Error('worker replacing');
  });
  await expect(core.store.dropGraph(fixtures[0]!.graph)).rejects.toThrow('worker replacing');
  epoch = 2; recovering = false;
  let rounds = 0;
  const result = await core.start({ sliceSpent: true, isRunning: () => rounds < 12,
    afterSlice: () => { rounds++; } }).recover();
  expect(result.outcome).toBe('terminal');
  expect(rounds).toBeGreaterThan(1);
  expect(core.writes).toEqual(fixtures.map(f => f.ual));
});


it('preserves a verified prefix when a resumed round is cancelled during verification', async () => {
  const fixtures = generation();
  let controller: AbortController | undefined, cancel = false;
  const core = node(servingPeer(fixtures), {
    signal: () => controller?.signal,
    beforeVerify: async () => { if (cancel) controller!.abort(new Error('caller cancelled')); },
  });
  const checkpoints = new MemorySyncCheckpointStore();
  await core.round(checkpoints, PEER, { settlementSliceDeadline: Date.now() });
  const dataKey = getSyncCheckpointKey(PEER, CG, false, 'data');
  const data = checkpoints.get(dataKey);
  expect(data?.offset).toBeGreaterThan(0);
  const writes = core.writes.length;
  controller = new AbortController(); cancel = true;
  const cancelled = await core.round(checkpoints, PEER, {});
  expect(cancelled.result.complete).toBe(false);
  expect(core.writes).toHaveLength(writes);
  expect(checkpoints.get(dataKey)).toMatchObject({ offset: data!.offset, manifestDigest: data!.manifestDigest, manifestPrefixDigest: data!.manifestPrefixDigest });
  expect(checkpoints.get(dataKey)?.terminal).not.toBe(true);
  controller = undefined; cancel = false;
  expect((await core.round(checkpoints, PEER, {})).result.complete).toBe(true);
  expect(core.writes).toEqual(fixtures.map(f => f.ual));
});


it('finishes bounded recovery after one worker replacement with an in-flight write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dkg-prefix-worker-'));
  const raw = new OxigraphWorkerStore(join(directory, 'store.nq'));
  try {
    const fixtures = generation();
    const core = node(servingPeer(fixtures), { store: raw });
    const checkpoints = new MemorySyncCheckpointStore();
    const first = await core.round(checkpoints, PEER, { settlementSliceDeadline: Date.now() });
    expect(first.result.complete).toBe(false);
    expect(checkpoints.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.offset).toBeGreaterThan(0);
    const prefix = fixtures.find(f => core.writes.includes(f.ual))!;
    await raw.flush();
    const read = asStoreRecoveryGenerationReader(raw)!;
    expect(read()).toEqual({ generation: 0, ready: true });
    const worker = (raw as unknown as { worker: Worker }).worker;
    // Hold a posted RPC until physical exit rejects it. Its owner is worker 0,
    // even though the failure reaches the observer after generation advances.
    vi.spyOn(worker, 'postMessage').mockImplementationOnce(message => { expect(message.method).toBe('insert'); });
    const write = core.store.insert([{ ...prefix.payload[0]!, object: '"pending mutation"' }]);
    const rejected = expect(write).rejects.toThrow('worker exited unexpectedly');
    await worker.terminate();
    await rejected;
    await raw.countQuads(); // Wait for the replacement's first healthy reply.
    expect(read()).toEqual({ generation: 1, ready: true });
    let complete = false;
    for (let round = 0; round < 12 && !complete; round++) {
      complete = (await core.round(checkpoints, PEER, { settlementSliceDeadline: Date.now() })).result.complete;
    }
    expect(complete).toBe(true);
    expect(read()?.generation).toBe(1);
    expect(core.writes).toEqual(fixtures.map(f => f.ual));
    expect(core.writes.filter(ual => ual === prefix.ual)).toHaveLength(1);
  } finally { await raw.close(); rmSync(directory, { recursive: true, force: true }); }
});
