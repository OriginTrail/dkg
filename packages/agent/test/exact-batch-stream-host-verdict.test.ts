import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return { ...actual, exchangeExperimentalExactBatch: vi.fn() };
});

vi.mock('../src/sync/requester/durable-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync/requester/durable-sync.js')>();
  return { ...actual, runDurableSyncDetailed: vi.fn(), runChallengeExactAssetFetch: vi.fn() };
});

import {
  MemoryLayer, ExperimentalExactBatchUnsupportedError, createGraphKnowledgeAssetScope, exchangeExperimentalExactBatch,
  knowledgeAssetLayerGraphUri, type OperationContext,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, quadToNQuad, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { createDurableSyncAccumulator, finalizeDurableSyncCompletion } from '../src/sync/durable-progress.js';
import { createChallengePinnedExactAssetSelection, createUalOnlyExactAssetSelection } from '../src/sync/exact-assets.js';
import { EXACT_BATCH_FRAME_KIND as K, EXACT_BATCH_STREAM_PROTOCOL, type ExactBatchFrame } from '../src/sync/exact-batch-stream-contract.js';
import type { ExactBatchAgentSession } from '../src/sync/requester/exact-batch-stream.js';
import { runChallengeExactAssetFetch, runDurableSyncDetailed } from '../src/sync/requester/durable-sync.js';

const CG = 'exact-batch-host-verdict';
const ctx = { operationId: 'exact-batch-host-verdict', operationName: 'sync' } as OperationContext;
const emptyResult = () => finalizeDurableSyncCompletion(createDurableSyncAccumulator());
const cleanups: Array<() => Promise<void>> = [];

/**
 * Host-verdict integration fixture: transport and chain authority are mocked.
 * The actual receive window, canonical worker, lifecycle physical-operation
 * fence, chain authenticator, Oxigraph atomic materializer and SWM reconciliation
 * run here. This is not encrypted-network or live-chain certification.
 */
function fixture(assetCount = 2) {
  const store = new OxigraphStore();
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
    chain: { chainId: 'hardhat:31337', getIdentityId: vi.fn(async () => 1n),
      signMessage: vi.fn(async (digest: Uint8Array) => {
        const signature = ethers.Signature.from(await wallet.signMessage(digest));
        return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
      }),
      getLatestMerkleRoot: vi.fn(async (id: bigint) => byId.get(id)!.root),
      getMerkleRootCount: vi.fn(async () => 1n), getKAContextGraphId: vi.fn(async () => 14n) },
    getPeerProtocols: vi.fn(async () => [EXACT_BATCH_STREAM_PROTOCOL]),
    getSyncReconcilerConnectionKey: vi.fn(() => 'fixture-connection'),
    resolveRegisteredContextGraphAuthority: vi.fn(async () => ({ kind: 'public', onChainId: '14' })),
    findLocalAgentForContextGraph: vi.fn(async () => undefined), localAgents: new Map(),
    computeSyncDigest: ContextGraphResolveMethods.prototype.computeSyncDigest,
    parsePipeDelimitedSyncRequest: ContextGraphResolveMethods.prototype.parsePipeDelimitedSyncRequest,
    getOrCreateSyncVerifyWorker: () => worker,
    processDurableBatchInWorker: (data: Quad[], meta: Quad[], _ctx: unknown, accept: boolean, mode: Parameters<SyncVerifyWorker['processDurableBatch']>[3]) => worker.processDurableBatch(data, meta, accept, mode),
    fetchSyncPages: vi.fn(), insertSyncedQuadsAndInvalidateListCache: vi.fn(),
    subscribedContextGraphs: new Map([[CG, { onChainId: '14' }]]),
    contextGraphBindingState: new ContextGraphBindingState(), graphScopedStoreClosed: false,
    graphScopedStorePhysicalRuns: new Set<Promise<unknown>>(),
    requireLocalCgMatchesOnChainSlot: vi.fn(async (cg: string, id: string) => cg === CG && id === '14'),
    syncCheckpoints: { delete: vi.fn(), set: vi.fn(), setManifestBoundOffset: vi.fn() },
    oversizeTombstoneLog: { record: vi.fn() }, invalidateListContextGraphsCache: vi.fn(),
    contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() }, writeLocks: new Map(),
    retireFinalizedSwmTwinCandidate: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  const selection = createUalOnlyExactAssetSelection(items.map(item => item.ual));
  const atomicStarted = vi.fn();
  const run = (exactAssetSelection = selection as typeof selection | ReturnType<typeof createChallengePinnedExactAssetSelection>, experimentalExactBatchStreamOnly = false) => (
    LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraphDetailed.call(host, ctx, 'fixture-source', CG, 1,
      { exactAssetSelection, experimentalExactBatchStreamOnly, fetchTimeoutMs: 120_000, authenticationTimeoutMs: 30_000, onAtomicCommitStarted: atomicStarted })
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
  vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _codec, _options, consume) => consume(session as never));
  return { host, store, items, run, session, atomicStarted, selection, frames, controller };
}

/** A responder stops between assets only after the first two real commit ACKs. */
function refuseAfterVerifiedPrefix(f: ReturnType<typeof fixture>, code: string, midAsset = false,
  beforeRefusal?: () => void) {
  const prefix = f.frames.slice(0, 6);
  const tail: ExactBatchFrame[] = [
    ...(midAsset ? [f.frames[6]!] : []),
    { kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode(code) },
  ];
  let resolveAcknowledged!: () => void;
  const acknowledged = new Promise<void>(resolve => { resolveAcknowledged = resolve; });
  vi.mocked(f.session.send).mockImplementation(async frame => {
    if (frame.assetIndex === 1) resolveAcknowledged();
  });
  vi.mocked(f.session.next).mockImplementation(async () => {
    if (prefix.length > 0) return prefix.shift();
    await acknowledged;
    // The responder receives ACK after the requester send has settled.
    await Promise.resolve();
    const incoming = tail.shift();
    if (incoming?.kind === K.REFUSE) beforeRefusal?.();
    return incoming;
  });
}

function refusalLogs(f: ReturnType<typeof fixture>) {
  return f.host.log.info.mock.calls.map(([, message]: [unknown, string]) => message)
    .filter((message: string) => message.startsWith('Exact batch requester refusal '));
}

async function storedRows(store: OxigraphStore, graph: string) {
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error('Fixture SELECT shape mismatch');
  return result.bindings.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
  vi.mocked(runDurableSyncDetailed).mockResolvedValue({ result: emptyResult(), exactFetchDisposition: 'incomplete' });
  vi.mocked(runChallengeExactAssetFetch).mockResolvedValue({ result: emptyResult(), disposition: 'incomplete', authenticatedAssets: [] });
});

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllEnvs();
});

describe('experimental exact batch actual host completion verdict', () => {
  it('returns found and complete with immediate per-KA progress only after normal atomic application', async () => {
    const f = fixture();
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'found', committedExactAssetUals: f.selection.assetUals,
      result: { complete: true, completedPhases: 1, failedPhases: 0, insertedDataTriples: 2 } });
    for (const item of f.items) expect(await storedRows(f.store, item.graph)).toBe(1);
    expect(f.atomicStarted.mock.calls.map(([, ual]) => ual)).toEqual(f.selection.assetUals);
    expect(f.host.chain.getLatestMerkleRoot).toHaveBeenCalledTimes(2);
    expect(f.host.chain.getMerkleRootCount).toHaveBeenCalledTimes(2);
    expect(f.host.chain.getKAContextGraphId).toHaveBeenCalledTimes(2);
    expect(f.host.requireLocalCgMatchesOnChainSlot).toHaveBeenCalledOnce();
    expect(f.host.invalidateListContextGraphsCache).toHaveBeenCalledTimes(2);
    expect(f.host.contextGraphMetaProjection.markDirtyFromQuads).toHaveBeenCalledTimes(2);
    expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
    expect(vi.mocked(f.session.send).mock.calls.map(([frame]) => frame.assetIndex)).toEqual([0, 1]);
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    const [, peer, start, , transport] = vi.mocked(exchangeExperimentalExactBatch).mock.calls[0]!;
    expect(peer).toBe('fixture-source'); expect(start.kind).toBe(K.REQUEST);
    expect(transport.timeoutMs).toBeLessThanOrEqual(120_000);
    const envelope = ContextGraphResolveMethods.prototype.parseSyncRequest.call(f.host, start.payload);
    expect(envelope).toMatchObject({ contextGraphId: CG,
      assetUals: f.selection.assetUals, offset: 0, includeSharedMemory: false, phase: 'data' });
    expect(envelope.requesterSignatureR).toBeUndefined();
    expect(envelope.requesterSignatureVS).toBeUndefined();
  });

  it('completes public recovery on a fresh identity-zero Edge without agent lookup or signing', async () => {
    const f = fixture();
    f.host.chain.getIdentityId.mockResolvedValue(0n);
    f.host.chain.signMessage.mockImplementation(async () => {
      throw new Error('A public START must not require a fresh Edge signature');
    });
    f.host.findLocalAgentForContextGraph.mockImplementation(async () => {
      throw new Error('A public START must not require a registered local agent');
    });
    expect(f.host.localAgents.size).toBe(0);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'found', committedExactAssetUals: f.selection.assetUals,
      result: { complete: true, completedPhases: 1, failedPhases: 0, insertedDataTriples: 2 } });
    expect(f.host.chain.getIdentityId).not.toHaveBeenCalled();
    expect(f.host.chain.signMessage).not.toHaveBeenCalled();
    expect(f.host.findLocalAgentForContextGraph).not.toHaveBeenCalled();
    for (const item of f.items) expect(await storedRows(f.store, item.graph)).toBe(1);
    expect(f.session.send).toHaveBeenCalledTimes(2);
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('retains the actually stored prefix and withholds second ACK after chain identity rejection', async () => {
    const f = fixture();
    f.host.chain.getKAContextGraphId.mockImplementation(async (id: bigint) => id === f.items[1]!.kaId ? 15n : 14n);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [f.items[0]!.ual],
      result: { complete: false, completedPhases: 0, failedPhases: 1, insertedDataTriples: 1 } });
    expect(await storedRows(f.store, f.items[0]!.graph)).toBe(1);
    expect(await storedRows(f.store, f.items[1]!.graph)).toBe(0);
    expect(vi.mocked(f.session.send).mock.calls.map(([frame]) => frame.assetIndex)).toEqual([0]);
    expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    expect(refusalLogs(f)).toEqual([]);
  });

  it.each(['RESOURCE_LIMIT', 'DENIED', 'SOURCE_CHANGED', 'ASSET_MISSING', 'UNSUPPORTED'])(
    'observes validated %s after two verified ACKs and keeps the five-asset batch incomplete', async code => {
      const f = fixture(5);
      refuseAfterVerifiedPrefix(f, code);
      const outcome = await f.run();
      expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
        committedExactAssetUals: f.selection.assetUals.slice(0, 2),
        result: { complete: false, completedPhases: 0, failedPhases: 1, insertedDataTriples: 2 } });
      for (const [index, item] of f.items.entries()) expect(await storedRows(f.store, item.graph)).toBe(index < 2 ? 1 : 0);
      expect(refusalLogs(f)).toEqual([
        `Exact batch requester refusal code=${code} startedAssets=2 committedAssets=2 acknowledgedAssets=2 atAssetBoundary=1 verifiedPrefix=1`,
      ]);
      expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
      expect(f.session.send).toHaveBeenCalledTimes(2);
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    });

  it('observes a mid-asset refusal without labelling it a verified boundary prefix', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT', true);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
      committedExactAssetUals: f.selection.assetUals.slice(0, 2), result: { complete: false, insertedDataTriples: 2 } });
    expect(refusalLogs(f)).toEqual([
      'Exact batch requester refusal code=RESOURCE_LIMIT startedAssets=3 committedAssets=2 acknowledgedAssets=2 atAssetBoundary=0 verifiedPrefix=0',
    ]);
    expect(await storedRows(f.store, f.items[2]!.graph)).toBe(0);
    expect(f.session.send).toHaveBeenCalledTimes(2);
    expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('observes a valid zero-work refusal without inventing a verified prefix', async () => {
    const f = fixture(5);
    f.frames.splice(0, f.frames.length,
      { kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode('RESOURCE_LIMIT') });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [],
      result: { complete: false, insertedTriples: 0 } });
    expect(refusalLogs(f)).toEqual([
      'Exact batch requester refusal code=RESOURCE_LIMIT startedAssets=0 committedAssets=0 acknowledgedAssets=0 atAssetBoundary=1 verifiedPrefix=0',
    ]);
    expect(f.session.send).not.toHaveBeenCalled();
    expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('does not expose a typed refusal for an unknown wire code', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'unvalidated wire text');
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
      committedExactAssetUals: f.selection.assetUals.slice(0, 2), result: { complete: false } });
    expect(refusalLogs(f)).toEqual([]);
    expect(f.session.send).toHaveBeenCalledTimes(2);
    expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('does not expose a typed refusal when cancellation also ends the session', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT', false, () => f.controller.abort(new Error('Fixture cancellation')));
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
      committedExactAssetUals: f.selection.assetUals.slice(0, 2), result: { complete: false } });
    expect(refusalLogs(f)).toEqual([]);
    expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('publishes refusal observations only after transport physical cleanup has settled', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT');
    let enteredClose = false, settled = false, finishClose!: () => void;
    const close = new Promise<void>(resolve => { finishClose = resolve; });
    vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _codec, _options, consume) => {
      try { return await consume(f.session as never); }
      catch (error) { enteredClose = true; await close; throw error; }
    });
    const running = f.run().then(outcome => { settled = true; return outcome; });
    await vi.waitFor(() => expect(enteredClose).toBe(true));
    expect(settled).toBe(false);
    expect(refusalLogs(f)).toEqual([]);
    expect(await storedRows(f.store, f.items[1]!.graph)).toBe(1);
    finishClose();
    expect(await running).toMatchObject({ exactFetchDisposition: 'incomplete', result: { complete: false } });
    expect(refusalLogs(f)).toEqual([
      'Exact batch requester refusal code=RESOURCE_LIMIT startedAssets=2 committedAssets=2 acknowledgedAssets=2 atAssetBoundary=1 verifiedPrefix=1',
    ]);
  });

  it('discards refusal classification when final physical transport close fails', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT');
    vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _codec, _options, consume) => {
      try { return await consume(f.session as never); }
      catch { throw new Error('Fixture final physical close failed'); }
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
      committedExactAssetUals: f.selection.assetUals.slice(0, 2), result: { complete: false, insertedDataTriples: 2 } });
    expect(refusalLogs(f)).toEqual([]);
    expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
    expect(f.session.send).toHaveBeenCalledTimes(2);
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('discards refusal classification when cancellation arrives during transport cleanup', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT');
    vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _codec, _options, consume) => {
      try { return await consume(f.session as never); }
      catch (error) { f.controller.abort(new Error('Fixture final cleanup cancellation')); throw error; }
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
      committedExactAssetUals: f.selection.assetUals.slice(0, 2), result: { complete: false, insertedDataTriples: 2 } });
    expect(refusalLogs(f)).toEqual([]);
    expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
    expect(f.session.send).toHaveBeenCalledTimes(2);
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('preserves incomplete progress when the refusal observer throws', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT');
    f.host.log.info.mockImplementation((_ctx: unknown, message: string) => {
      if (message.startsWith('Exact batch requester refusal ')) throw new Error('Fixture observer failure');
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
      committedExactAssetUals: f.selection.assetUals.slice(0, 2), result: { complete: false, insertedDataTriples: 2 } });
    expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
    expect(f.session.send).toHaveBeenCalledTimes(2);
    expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('reports all applied progress without completion or legacy replay when final transport close fails', async () => {
    const f = fixture();
    vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _codec, _options, consume) => {
      await consume(f.session as never);
      throw Object.assign(new Error('Fixture final close timed out'), { name: 'TimeoutError' });
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: f.selection.assetUals,
      result: { complete: false, completedPhases: 0, failedPhases: 1, insertedDataTriples: 2 } });
    for (const item of f.items) expect(await storedRows(f.store, item.graph)).toBe(1);
    expect(f.session.send).toHaveBeenCalledTimes(2);
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it.each([undefined, '0'])('keeps requester on legacy transport when opt-in is %s', async flag => {
    const f = fixture(); vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', flag);
    await f.run();
    expect(runDurableSyncDetailed).toHaveBeenCalledOnce();
    expect(exchangeExperimentalExactBatch).not.toHaveBeenCalled();
    expect(f.host.resolveRegisteredContextGraphAuthority).not.toHaveBeenCalled();
    expect(f.host.getSyncReconcilerConnectionKey).not.toHaveBeenCalled();
  });

  it('retains legacy private-graph authorization and never builds an experimental START', async () => {
    const f = fixture(); f.host.resolveRegisteredContextGraphAuthority.mockResolvedValue({ kind: 'private', onChainId: '14' });
    await f.run();
    expect(runDurableSyncDetailed).toHaveBeenCalledOnce();
    expect(exchangeExperimentalExactBatch).not.toHaveBeenCalled();
    expect(f.host.chain.signMessage).not.toHaveBeenCalled();
  });

  it('uses legacy transport when the selected peer does not advertise the experimental Core responder', async () => {
    const f = fixture(); f.host.getPeerProtocols.mockResolvedValue(['/dkg/10.0.2/sync']);
    await f.run();
    expect(runDurableSyncDetailed).toHaveBeenCalledOnce();
    expect(exchangeExperimentalExactBatch).not.toHaveBeenCalled();
    expect(f.host.resolveRegisteredContextGraphAuthority).not.toHaveBeenCalled();
  });

  it('leaves stream-only targets pending after unsupported negotiation and suppresses repeated attempts on the same connection', async () => {
    const f = fixture();
    vi.mocked(exchangeExperimentalExactBatch).mockRejectedValue(new ExperimentalExactBatchUnsupportedError(new Error('Fixture unsupported negotiation before START')));
    const first = await f.run(f.selection, true);
    const second = await f.run(f.selection, true);
    for (const outcome of [first, second]) {
      expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', result: { complete: false,
        insertedTriples: 0, completedPhases: 0, failedPhases: 1 } });
    }
    expect(first.committedExactAssetUals).toEqual([]);
    expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
    expect(f.host.getPeerProtocols).toHaveBeenCalledOnce();
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    expect(f.session.send).not.toHaveBeenCalled();
    for (const item of f.items) expect(await storedRows(f.store, item.graph)).toBe(0);
  });

  it('preserves ordinary bounded legacy fallback on unsupported negotiation before START', async () => {
    const f = fixture();
    vi.mocked(exchangeExperimentalExactBatch).mockRejectedValue(new ExperimentalExactBatchUnsupportedError(new Error('Fixture unsupported negotiation before START')));
    await f.run();
    expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
    expect(runDurableSyncDetailed).toHaveBeenCalledOnce();
    expect(f.session.send).not.toHaveBeenCalled();
    expect(vi.mocked(runDurableSyncDetailed).mock.calls[0]![0].exactAssetSelectionFor?.(CG)).toBe(f.selection);
  });

  it.each(['capability', 'private'] as const)('keeps stream-only work pending when %s eligibility disappears', async boundary => {
    const f = fixture();
    if (boundary === 'capability') f.host.getPeerProtocols.mockResolvedValue([]);
    else f.host.resolveRegisteredContextGraphAuthority.mockResolvedValue({ kind: 'private', onChainId: '14' });
    const outcome = await f.run(f.selection, true);
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', result: { complete: false, insertedTriples: 0 } });
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    expect(exchangeExperimentalExactBatch).not.toHaveBeenCalled();
    expect(f.host.chain.signMessage).not.toHaveBeenCalled();
  });

  it('keeps challenge-pinned work proof-only even with opt-in and an experimental peer', async () => {
    const f = fixture();
    const pinned = createChallengePinnedExactAssetSelection(f.items.map(item => ({ assetUal: item.ual,
      merkleRootHex: ethers.hexlify(item.root), merkleLeafCount: BigInt(item.data.length) })));
    await f.run(pinned);
    expect(runChallengeExactAssetFetch).toHaveBeenCalledOnce();
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    expect(exchangeExperimentalExactBatch).not.toHaveBeenCalled();
    expect(f.host.getPeerProtocols).not.toHaveBeenCalled();
    const proof = vi.mocked(runChallengeExactAssetFetch).mock.calls[0]![0];
    expect(proof).not.toHaveProperty('storeGraphScopedAsset');
    expect(proof).not.toHaveProperty('setCheckpoint');
    expect(proof).not.toHaveProperty('deleteCheckpoint');
    expect(proof.challengeSelectionFor(CG)).toBe(pinned);
    for (const item of f.items) expect(await storedRows(f.store, item.graph)).toBe(0);
  });
});
