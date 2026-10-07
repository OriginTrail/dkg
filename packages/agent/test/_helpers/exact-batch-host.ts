import { ethers } from 'ethers';
import { vi } from 'vitest';

import {
  MemoryLayer,
  createGraphKnowledgeAssetScope, exchangeExperimentalExactBatch,
  knowledgeAssetLayerGraphUri, type OperationContext
} from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, quadToNQuad, type Quad } from '@origintrail-official/dkg-storage';
import { ContextGraphMetaProjection } from '../../src/context-graph-meta-projection.js';
import { createProjectionMutationObserver } from '../../src/internal/projection-mutation-observer.js';
import { createListContextGraphsCacheInvalidatingStore } from '../../src/internal/context-graph-cache-invalidating-store.js';
import { ContextGraphBindingState } from '../../src/context-graph-binding-state.js';
import { ContextGraphResolveMethods } from '../../src/dkg-agent-cg-resolve.js';
import { LifecycleSyncMethods } from '../../src/dkg-agent-lifecycle.js';
import { SyncVerifyWorker } from '../../src/sync-verify-worker.js';
import { createDurableSyncAccumulator, finalizeDurableSyncCompletion } from '../../src/sync/durable-progress.js';
import { createChallengePinnedExactAssetSelection, createUalOnlyExactAssetSelection } from '../../src/sync/exact-assets.js';
import { EXACT_BATCH_STREAM_PROTOCOL, EXACT_BATCH_FRAME_KIND as K, type ExactBatchFrame } from '../../src/sync/exact-batch-stream-contract.js';
import type { ExactBatchAgentSession } from '../../src/sync/requester/exact-batch-stream.js';
import type { ExactRecoveryTransportMode } from '../../src/sync/requester/exact-recovery-transport.js';
import {
  type VmRecoveryRegisteredPublicEvidence
} from '../../src/vm-recovery-pass-authority.js';

export const CG = 'exact-batch-host-verdict';
export const ctx = { operationId: 'exact-batch-host-verdict', operationName: 'sync' } as OperationContext;
export const emptyResult = () => finalizeDurableSyncCompletion(createDurableSyncAccumulator());
/**
 * Host-verdict integration fixture: transport and chain authority are mocked.
 * The actual receive window, canonical worker, lifecycle physical-operation
 * fence, chain authenticator, Oxigraph atomic materializer and SWM reconciliation
 * run here. This is not encrypted-network or live-chain certification.
 */
export function createExactBatchHostFixture(cleanups: Array<() => Promise<void>>, assetCount = 2) {
  const rawStore = new OxigraphStore();
  const projection = new ContextGraphMetaProjection(rawStore);
  vi.spyOn(projection, 'invalidateStoreMutation');
  const store = createListContextGraphsCacheInvalidatingStore(rawStore, () => {}, createProjectionMutationObserver(() => projection));
  const worker = new SyncVerifyWorker();
  cleanups.push(async () => { await worker.close(); await store.close(); });
  const items = Array.from({ length: assetCount }, (_, index) => index + 1).map(number => {
    const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/${number}`;
    const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, 1));
    const data: Quad[] = [{ graph, subject: `urn:host:asset:${number}`, predicate: 'urn:host:value', object: `"asset ${number}"` }];
    const root = computeFlatKCRootV10(data, []);
    const kaId = (0xabn << 96n) | BigInt(number);
    const meta = generateGraphKnowledgeAssetMetadata({ ual, contextGraphId: CG, assertionGraph: graph,
      assertionVersion: '1', merkleRoot: root, publisherPeerId: 'fixture-source', accessPolicy: 'public',
      timestamp: new Date(0), publicTripleCount: data.length, privateTripleCount: 0 },
    { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
      batchId: kaId, materializedVersion: { blockNumber: 123, txIndex: 0 },
    } } });
    return { ual, graph, data, meta, root, kaId };
  });
  const byId = new Map(items.map(item => [item.kaId, item]));
  const wallet = ethers.Wallet.createRandom();
  // The fake host follows the established prototype-call pattern: only host
  // dependencies used by this lifecycle seam are supplied, with an owned store.
  const host: any = {
    config: { nodeRole: 'edge' }, peerId: 'fixture-requester', router: {}, store,
    chain: { chainId: 'hardhat:31337', deploymentId: 'fixture-deployment', getIdentityId: vi.fn(async () => 1n),
      signMessage: vi.fn(async (digest: Uint8Array) => {
        const signature = ethers.Signature.from(await wallet.signMessage(digest));
        return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
      }),
      getLatestMerkleRoot: vi.fn(async (id: bigint) => byId.get(id)!.root),
      getMerkleRootCount: vi.fn(async () => 1n), getKAContextGraphId: vi.fn(async () => 14n) },
    getPeerProtocols: vi.fn(async () => [EXACT_BATCH_STREAM_PROTOCOL]),
    getSyncReconcilerConnectionKey: vi.fn(() => 'fixture-connection'),
    // The source is connected, so a stream that broke can be opened again at once.
    ensurePeerConnected: vi.fn(async () => {}),
    node: { libp2p: { getConnections: vi.fn(() => [{ remotePeer: { toString: () => 'fixture-source' } }]) } },
    resolveRegisteredContextGraphAuthority: vi.fn(async () => ({ kind: 'public', onChainId: '14' })),
    findLocalAgentForContextGraph: vi.fn(async () => undefined), localAgents: new Map(),
    computeSyncDigest: ContextGraphResolveMethods.prototype.computeSyncDigest,
    parsePipeDelimitedSyncRequest: ContextGraphResolveMethods.prototype.parsePipeDelimitedSyncRequest,
    getOrCreateSyncVerifyWorker: () => worker,
    processDurableBatchInWorker: (data: Quad[], meta: Quad[], _ctx: unknown, accept: boolean, mode: Parameters<SyncVerifyWorker['processDurableBatch']>[3]) => worker.processDurableBatch(data, meta, accept, mode),
    fetchSyncPages: vi.fn(), insertSyncedQuadsAndInvalidateListCache: vi.fn(),
    subscribedContextGraphs: new Map([[CG, { onChainId: '14' }]]),
    contextGraphBindingState: new ContextGraphBindingState(), graphScopedStoreClosed: false,
    captureExperimentalExactBatchRefusalScope: LifecycleSyncMethods.prototype.captureExperimentalExactBatchRefusalScope,
    graphScopedStorePhysicalRuns: new Set<Promise<unknown>>(),
    requireLocalCgMatchesOnChainSlot: vi.fn(async (cg: string, id: string) => cg === CG && id === '14'),
    syncCheckpoints: { delete: vi.fn(), set: vi.fn(), setManifestBoundOffset: vi.fn() },
    oversizeTombstoneLog: { record: vi.fn() }, invalidateListContextGraphsCache: vi.fn(),
    contextGraphMetaProjection: projection, writeLocks: new Map(),
    retireFinalizedSwmTwinCandidate: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  const selection = createUalOnlyExactAssetSelection(items.map(item => item.ual));
  const atomicStarted = vi.fn();
  const run = (exactAssetSelection = selection as typeof selection | ReturnType<typeof createChallengePinnedExactAssetSelection>, exactRecoveryTransportMode: ExactRecoveryTransportMode = 'stream-preferred',
    handedOver: { registeredPublicEvidence?: VmRecoveryRegisteredPublicEvidence; operationFetchDeadline?: number; signal?: AbortSignal } = {}) => (
    LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraphDetailed.call(host, ctx, 'fixture-source', CG, 1,
      { exactAssetSelection, exactRecoveryTransportMode, fetchTimeoutMs: 120_000, authenticationTimeoutMs: 30_000, onAtomicCommitStarted: atomicStarted, ...handedOver })
  );
  const frames: ExactBatchFrame[] = items.flatMap((item, assetIndex) => [
    { kind: K.META, assetIndex, sequence: 0, payload: new TextEncoder().encode(item.meta.map(quadToNQuad).join('\n') + '\n') },
    { kind: K.DATA, assetIndex, sequence: 0, payload: new TextEncoder().encode(item.data.map(quadToNQuad).join('\n') + '\n') },
    { kind: K.ASSET_END, assetIndex, sequence: 1, payload: new Uint8Array() },
  ]);
  frames.push({ kind: K.BATCH_END, assetIndex: 255, sequence: items.length, payload: new Uint8Array() });
  const controller = new AbortController();
  const session: ExactBatchAgentSession = { signal: controller.signal, assetUals: selection.assetUals, windowSize: 2,
    next: vi.fn(async () => frames.shift()), send: vi.fn(async () => {}) };
  // The session is bound to the selection of its own exchange, as Core binds it.
  vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, options, consume) => (
    consume({ ...session, assetUals: options.assetUals } as never)
  ));
  return { host, store, items, run, session, atomicStarted, selection, frames, controller };
}


export function resourceLimitRefusal(): ExactBatchFrame {
  return { kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode('RESOURCE_LIMIT') };
}

export function busyRefusal(): ExactBatchFrame {
  return { kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode('BUSY') };
}

export async function storedRows(store: OxigraphStore, graph: string) {
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error('Fixture SELECT shape mismatch');
  return result.bindings.length;
}

