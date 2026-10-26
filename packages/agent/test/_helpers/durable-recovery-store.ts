import { StoreContentFence } from '../../src/internal/store-content-fence.js';
import { createObservedStoreMutation } from '../../src/internal/observed-store-mutation.js';
import { createMutationObservedStore } from '../../src/internal/context-graph-cache-invalidating-store.js';
import { RecoveryMaterializationOwner } from '../../src/durable-recovery-materialization.js';
import type { ContextGraphSub } from '../../src/dkg-agent-types.js';
import { durableRecoveryRoundOutcome } from '../../src/sync/durable-recovery-round.js';
import { afterEach } from 'vitest';
import { createRpcTimeoutError } from '@origintrail-official/dkg-chain';
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
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { SYNC_PAGE_SIZE } from '../../src/dkg-agent-constants.js';
import { MemorySyncCheckpointStore } from '../../src/sync/checkpoint/state.js';
import { createUalOnlyExactAssetSelection } from '../../src/sync/exact-assets.js';
import { DurableRecoveryRunner, type DurableRecoveryRunnerDependencies } from '../../src/sync/durable-recovery-runner.js';
import {
  currentHeldGraphScopedAssetsReader,
  heldGraphScopedAssetsReader,
} from '../../src/sync/requester/durable-data-holdings.js';
import {
  runDurableSyncDetailed,
  type DurableMetaContinuation,
  type DurableSyncContext,
} from '../../src/sync/requester/durable-sync.js';
import { materializeVerifiedGraphScopedAsset } from '../../src/sync/requester/graph-scoped-materialization.js';
import { deleteSyncPageCheckpoint, fetchSyncPages } from '../../src/sync/requester/page-fetch.js';
import { processDurableBatchForWire } from '../../src/sync-verify-worker-impl.js';
import type { DurableBatchVerificationMode } from '../../src/sync-verify-worker.js';
import { uniformDurableSyncBudget } from '../durable-sync-test-helpers.js';

export const CG = 'held-restart-cg';
export const PEER = '12D3KooWHeldRestartPeer';
export const SECOND_PEER = '12D3KooWHeldRestartPeerTwo';
export const ctx = { operationId: 'held-restart', operationName: 'sync' } as OperationContext;
const stores: OxigraphStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

export interface AssetFixture {
  readonly ual: string;
  readonly graph: string;
  readonly payload: Quad[];
  readonly meta: Quad[];
  readonly version: string;
  readonly rootHex: string;
}

export function asset(kaNumber: number, version = '1', privateOnly = false): AssetFixture {
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
export function servingPeer(initial: AssetFixture[]) {
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
export function node(
  serving: ServingPeer | Record<string, ServingPeer>,
  options: { recoveryGeneration?: () => number | undefined; holdingsUnreadable?: boolean; chain?: () => readonly AssetFixture[]; subscriptionId?: () => string; bindingGeneration?: () => number; disablePrefixProof?: () => boolean; subscription?: () => ContextGraphSub | undefined; beforeChainRead?: () => Promise<void>; beforeVerify?: () => Promise<void>; afterAssetStore?: () => Promise<void>; holdingsShortcut?: boolean; beforeMetaStore?: () => Promise<void> } = {},
) {
  const peers: Record<string, ServingPeer> = 'send' in serving ? { [PEER]: serving as ServingPeer } : serving;
  const chain = options.chain ?? (() => Object.values(peers)[0]!.current());
  const rawStore = new OxigraphStore();
  stores.push(rawStore);
  const contentFence = new StoreContentFence(options.recoveryGeneration);
  const store = createMutationObservedStore(rawStore, createObservedStoreMutation(() => {}, contentFence));
  const writes: string[] = [];
  const info: string[] = [];
  let holdingsUnreadable = options.holdingsUnreadable === true;
  // Chain checks answered per round; later ones time out, as on a throttled endpoint past the round's budget.
  let chainAnswersPerRound = Number.POSITIVE_INFINITY;
  let chainAnswersLeft = chainAnswersPerRound;
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
  const holdings = (binding: () => Readonly<{ onChainId?: string; generation: number }>) => currentHeldGraphScopedAssetsReader({
    binding,
    readHeld: async (request) => {
      if (holdingsUnreadable) throw new Error('store queue wait timeout');
      return heldGraphScopedAssetsReader(store)(request);
    },
    readChainState: async ({ ual }) => {
      await options.beforeChainRead?.();
      if (chainAnswersLeft <= 0) throw createRpcTimeoutError('held chain check exceeded its context-graph deadline');
      chainAnswersLeft -= 1;
      const onChain = chain().find((fixture) => fixture.ual === ual)!;
      return { merkleRootHex: onChain.rootHex, assertionVersion: BigInt(onChain.version), bound: true, onChainContextGraphId: '323' };
    },
    budget: { createGraphScopedAuthenticationDeadline: () => Date.now() + 60_000 },
  });
  const round = (
    checkpointStore: MemorySyncCheckpointStore,
    remotePeerId: string,
    roundOptions: Pick<DurableSyncContext, 'graphRecovery' | 'exactAssetSelectionFor' | 'settlementSliceDeadline'>,
  ) => materialization.withHeldAssetFence(fence => runDurableSyncDetailed({
    ctx,
    remotePeerId,
    contextGraphIds: [CG],
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
    storedPrefix: options.disablePrefixProof?.() ? undefined : { read: heldGraphScopedAssetsReader(store), openScope: contentFence.openScope.bind(contentFence), assertCurrent: fence.assertCurrent },
    graphRecovery: roundOptions.graphRecovery ? { ...roundOptions.graphRecovery, held: options.holdingsShortcut === false ? undefined : {
      reader: holdings(fence.binding)!, assertCurrent: fence.assertCurrent,
      withStoreFence: contentFence.withScope.bind(contentFence),
    } } : undefined,
    processDurableBatchInWorker: async (...args) => { await options.beforeVerify?.(); return processBatch(...args); },
    storeInsert: async ({ quads }) => { await options.beforeMetaStore?.(); await store.insert(quads); },
    storeGraphScopedAsset: async ({ asset: verified }) => {
      writes.push(verified.ual);
      // As chain authentication leaves it: confirmed, written with its rows in one replacement.
      const metadataQuads = overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(
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
  }));

  /**
   * A process lifetime: a new owner and a new checkpoint store. With
   * `sliceSpent`, each round starts past its slice's soft deadline, as once
   * held-copy checks used the slice: a DATA round stops at its first complete graph.
   */
  const start = (startOptions: { exactRequests?: boolean; sliceSpent?: boolean | (() => boolean); isRunning?: () => boolean; peerIds?: () => string[]; afterSlice?: () => void } = {}) => {
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
      executeSlice: async (peerId, durableMetaContinuation: DurableMetaContinuation, durableRecoveryRound, durableResumeBoundary) => {
        chainAnswersLeft = chainAnswersPerRound;
        const detailed = await round(checkpointStore, peerId, {
          graphRecovery: { meta: durableMetaContinuation, holdings: durableRecoveryRound, boundary: durableResumeBoundary },
          settlementSliceDeadline: (typeof startOptions.sliceSpent === 'function' ? startOptions.sliceSpent() : startOptions.sliceSpent) ? Date.now() : undefined,
        });
        startOptions.afterSlice?.();
        return durableRecoveryRoundOutcome(detailed.result, detailed.recoveryRound);
      },
      ...(startOptions.exactRequests === false ? {} : {
        executeExactSlice: async (peerId: string, assetUals: readonly string[]) => {
          const selection = createUalOnlyExactAssetSelection(assetUals);
          const { result } = await round(checkpointStore, peerId, { exactAssetSelectionFor: () => selection });
          return { result, complete: result.complete === true };
        },
      }),
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
  const failHoldingsReads = (fail: boolean) => { holdingsUnreadable = fail; };
  const limitChainAnswersPerRound = (answers: number) => { chainAnswersPerRound = answers; };
  return { rawStore, store, writes, info, start, round, failHoldingsReads, limitChainAnswersPerRound };
}

export const generation = (version3 = '1') => [1, 2, 3, 4, 5, 6].map((n) => asset(n, n === 3 ? version3 : '1'));
export const rowsOf = (fixtures: readonly AssetFixture[]) => fixtures.reduce((rows, fixture) => rows + fixture.payload.length, 0);

