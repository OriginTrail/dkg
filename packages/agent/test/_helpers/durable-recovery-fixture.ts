import { afterEach } from 'vitest';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, type OperationContext } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1 } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type TripleStore, type Quad, type StoreRecoveryGenerationReader } from '@origintrail-official/dkg-storage';
import { createAgentStoreComposition } from '../../src/internal/agent-store-composition.js';
import { StoreContentFence } from '../../src/internal/store-content-fence.js';
import { createObservedStoreMutation } from '../../src/internal/observed-store-mutation.js';
import { createMutationObservedStore } from '../../src/internal/context-graph-cache-invalidating-store.js';
import { RecoveryMaterializationOwner } from '../../src/durable-recovery-materialization.js';
import { createDurableHeldStore } from '../../src/durable-recovery-held-store.js';
import type { ContextGraphSub } from '../../src/dkg-agent-types.js';
import { SYNC_PAGE_SIZE } from '../../src/dkg-agent-constants.js';
import type { MemorySyncCheckpointStore } from '../../src/sync/checkpoint/state.js';
import type { DurableSyncContext } from '../../src/sync/requester/durable-sync.js';
import { authenticateVerifiedGraphScopedAsset, materializeVerifiedGraphScopedAsset } from '../../src/sync/requester/graph-scoped-materialization.js';
import { deleteSyncPageCheckpoint, fetchSyncPages } from '../../src/sync/requester/page-fetch.js';
import { processDurableBatchForWire } from '../../src/sync-verify-worker-impl.js';
import type { DurableBatchVerificationMode } from '../../src/sync-verify-worker.js';
import { uniformDurableSyncBudget } from '../durable-sync-test-helpers.js';

export const CG = 'held-restart-cg';
export const PEER = '12D3KooWHeldRestartPeer';
export const SECOND_PEER = '12D3KooWHeldRestartPeerTwo';
export const ctx = { operationId: 'held-restart', operationName: 'sync' } as OperationContext;
const stores: TripleStore[] = [];

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

export type ServingPeer = ReturnType<typeof servingPeer>;
export type RecoveryPeers = ServingPeer | Record<string, ServingPeer>;

export interface RecoveryFixtureOptions {
  readonly storage?: {
    readonly store?: TripleStore;
    readonly recoveryGeneration?: StoreRecoveryGenerationReader;
    readonly disablePrefixProof?: () => boolean;
  };
  readonly lifecycle?: {
    readonly signal?: () => AbortSignal | undefined;
    readonly subscription?: () => ContextGraphSub | undefined;
    readonly subscriptionId?: () => string;
    readonly bindingGeneration?: () => number;
  };
  readonly mutations?: {
    readonly beforeVerify?: () => Promise<void>;
    readonly beforeMetaStore?: () => Promise<void>;
    readonly failAssetStore?: () => boolean;
    readonly afterAssetStore?: () => Promise<void>;
  };
  readonly noChain?: boolean;
}

/** Shared physical store, peer transport and materialization ports; no recovery executor. */
export function createRecoveryFixture(serving: RecoveryPeers, options: RecoveryFixtureOptions = {}) {
  const peers: Record<string, ServingPeer> = 'send' in serving ? { [PEER]: serving as ServingPeer } : serving;
  const rawStore = options.storage?.store ?? new OxigraphStore();
  stores.push(rawStore);
  const production = createAgentStoreComposition(rawStore, () => {}, { begin: () => () => {} });
  const contentFence = options.storage?.recoveryGeneration ? new StoreContentFence(options.storage?.recoveryGeneration) : production.heldContent;
  const store = options.storage?.recoveryGeneration
    ? createMutationObservedStore(rawStore, createObservedStoreMutation(() => {}, contentFence)) : production.store;
  const writes: string[] = [];
  const info: string[] = [];
  let defaultSubscription: ContextGraphSub = { syncMode: 'always-on', subscribed: true, synced: true, onChainId: '323' };
  const materialization = new RecoveryMaterializationOwner({
    chain: () => { throw new Error('chain reads supplied below'); }, store: () => store,
    isClosed: () => false, subscription: () => {
      if (options.lifecycle?.subscription) return options.lifecycle?.subscription();
      const onChainId = options.lifecycle?.subscriptionId?.() ?? '323';
      if (defaultSubscription.onChainId !== onChainId) defaultSubscription = { ...defaultSubscription, onChainId };
      return defaultSubscription;
    },
    bindingGeneration: () => options.lifecycle?.bindingGeneration?.() ?? 0, isBindingGenerationCurrent: (_id, captured) => captured === (options.lifecycle?.bindingGeneration?.() ?? 0),
    track: () => {}, verifyBinding: async () => true,
    persistSubscription: async () => { throw new Error('already bound'); },
    bindSubscription: () => { throw new Error('already bound'); }, recordDrops: () => {}, reconcile: async () => {},
  }).forOperation({ ctx, contextGraphId: CG, authority: {
    coalescing: 'owner-only', admitVerifiedPage() {}, isRegisteredPublic: () => true,
    authenticate: () => { throw new Error('materialization supplied below'); },
  } });
  const heldStore = () => options.storage?.disablePrefixProof?.() ? undefined
    : createDurableHeldStore(store, contentFence, async () => {}, () => options.noChain ? 'integrity-only' : 'confirmed');
  const confirmedHoldings = createDurableHeldStore(store, contentFence, async () => {})!;
  const pagingPorts = (checkpointStore: MemorySyncCheckpointStore, remotePeerId: string): DurableSyncContext => ({
    ctx,
    remotePeerId,
    contextGraphIds: [CG],
    signal: options.lifecycle?.signal?.(),
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
    processDurableBatchInWorker: async (...args) => { await options.mutations?.beforeVerify?.(); return processBatch(...args); },
    storeInsert: async ({ quads }) => { await options.mutations?.beforeMetaStore?.(); await store.insert(quads); },
    storeGraphScopedAsset: async ({ asset: verified }) => {
      if (options.mutations?.failAssetStore?.()) throw new Error('authentication budget expired before next asset');
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
      await options.mutations?.afterAssetStore?.();
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
  });
  return { peers, rawStore, store, writes, info, materialization, heldStore, confirmedHoldings, pagingPorts };
}

export const generation = (version3 = '1') => [1, 2, 3, 4, 5, 6].map((n) => asset(n, n === 3 ? version3 : '1'));
export const rowsOf = (fixtures: readonly AssetFixture[]) => fixtures.reduce((rows, fixture) => rows + fixture.payload.length, 0);

