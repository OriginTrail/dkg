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
import { EXACT_BATCH_RESOURCE_REFUSAL_TTL_MS, exactBatchStreamUnsupported } from '../src/sync/exact-batch-stream-capability.js';
import type { ExactBatchAgentSession } from '../src/sync/requester/exact-batch-stream.js';
import * as exactBatchRequester from '../src/sync/requester/exact-batch-stream.js';
import type { ExactRecoveryTransportMode } from '../src/sync/requester/exact-recovery-transport.js';
import { runChallengeExactAssetFetch, runDurableSyncDetailed } from '../src/sync/requester/durable-sync.js';
import {
  VM_RECOVERY_REGISTERED_PUBLIC_MAX_AGE_MS,
  VmRecoveryPassAuthority,
  type VmRecoveryRegisteredPublicEvidence,
} from '../src/vm-recovery-pass-authority.js';

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
    chain: { chainId: 'hardhat:31337', deploymentId: 'fixture-deployment', getIdentityId: vi.fn(async () => 1n),
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
    captureExperimentalExactBatchRefusalScope: LifecycleSyncMethods.prototype.captureExperimentalExactBatchRefusalScope,
    graphScopedStorePhysicalRuns: new Set<Promise<unknown>>(),
    requireLocalCgMatchesOnChainSlot: vi.fn(async (cg: string, id: string) => cg === CG && id === '14'),
    syncCheckpoints: { delete: vi.fn(), set: vi.fn(), setManifestBoundOffset: vi.fn() },
    oversizeTombstoneLog: { record: vi.fn() }, invalidateListContextGraphsCache: vi.fn(),
    contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() }, writeLocks: new Map(),
    retireFinalizedSwmTwinCandidate: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  const selection = createUalOnlyExactAssetSelection(items.map(item => item.ual));
  const atomicStarted = vi.fn();
  const run = (exactAssetSelection = selection as typeof selection | ReturnType<typeof createChallengePinnedExactAssetSelection>, exactRecoveryTransportMode: ExactRecoveryTransportMode = 'stream-preferred',
    handedOver: { registeredPublicEvidence?: VmRecoveryRegisteredPublicEvidence } = {}) => (
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
  vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _options, consume) => consume(session as never));
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
  vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
  vi.mocked(runDurableSyncDetailed).mockResolvedValue({ result: emptyResult(), exactFetchDisposition: 'incomplete' });
  vi.mocked(runChallengeExactAssetFetch).mockResolvedValue({ result: emptyResult(), disposition: 'incomplete', authenticatedAssets: [] });
});

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllEnvs();
});

describe('experimental exact batch actual host completion verdict', () => {
  it.each([
    ['legacy mode', 'legacy'],
    ['opt-in absent', 'stream-preferred'],
    ['protocol absent', 'stream-preferred'],
    ['public authority absent', 'stream-preferred'],
  ] as const)('does not read requester identity when ordinary recovery is selected: %s', async (boundary, mode) => {
    const f = fixture();
    if (boundary === 'opt-in absent') vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '0');
    else if (boundary === 'protocol absent') f.host.getPeerProtocols.mockResolvedValue([]);
    else if (boundary === 'public authority absent') f.host.resolveRegisteredContextGraphAuthority.mockResolvedValue({ kind: 'private' });
    const peerIdRead = vi.fn(() => { throw new Error('An unstarted requester has no peer identity'); });
    const signingPortRead = vi.fn(() => { throw new Error('An unused START must not inspect signing identity'); });
    Object.defineProperty(f.host, 'peerId', { get: peerIdRead });
    Object.defineProperty(f.host.chain, 'signMessage', { get: signingPortRead });
    await f.run(f.selection, mode);
    expect(peerIdRead).not.toHaveBeenCalled();
    expect(signingPortRead).not.toHaveBeenCalled();
    expect(f.host.chain.getIdentityId).not.toHaveBeenCalled();
    if (boundary === 'legacy mode' || boundary === 'opt-in absent') {
      expect(f.host.getSyncReconcilerConnectionKey).not.toHaveBeenCalled();
      expect(f.host.getPeerProtocols).not.toHaveBeenCalled();
      expect(f.host.resolveRegisteredContextGraphAuthority).not.toHaveBeenCalled();
    }
    expect(exchangeExperimentalExactBatch).not.toHaveBeenCalled();
    expect(runDurableSyncDetailed).toHaveBeenCalledOnce();
  });

  it('keeps a required stream pending when opt-in is absent without ordinary replay', async () => {
    const f = fixture();
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '0');
    expect(await f.run(f.selection, 'stream-required')).toMatchObject({
      exactFetchDisposition: 'incomplete', result: { complete: false, failedPhases: 1, insertedTriples: 0 },
    });
    expect(f.host.getSyncReconcilerConnectionKey).not.toHaveBeenCalled();
    expect(f.host.getPeerProtocols).not.toHaveBeenCalled();
    expect(f.host.resolveRegisteredContextGraphAuthority).not.toHaveBeenCalled();
    expect(exchangeExperimentalExactBatch).not.toHaveBeenCalled();
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  describe('registered-public pre-flight', () => {
    /** The pass that owns the exchange: it has read a public answer and hands over its handle. */
    async function ownedPass(overrides: { graph?: string } = {}) {
      const control = { now: 0, current: true, owner: new AbortController() };
      const pass = new VmRecoveryPassAuthority(() => control.now);
      await pass.read(async () => ({ kind: 'public', onChainId: 14n }));
      const evidence = pass.evidence({
        contextGraphId: overrides.graph ?? CG, signal: control.owner.signal, isCurrent: () => control.current,
      });
      return { pass, evidence, control };
    }

    it('reads the authority itself when no pass has handed it a fresh answer', async () => {
      const f = fixture();
      const outcome = await f.run(f.selection, 'stream-required');
      expect(outcome).toMatchObject({ exactFetchDisposition: 'found' });
      expect(f.host.resolveRegisteredContextGraphAuthority).toHaveBeenCalledOnce();
    });

    it('reuses the answer its own pass handed it instead of reading it a second time', async () => {
      const f = fixture();
      const { evidence } = await ownedPass();
      expect(evidence.usableFor(CG)).toBe(true);
      const outcome = await f.run(f.selection, 'stream-required', { registeredPublicEvidence: evidence });
      expect(outcome).toMatchObject({ exactFetchDisposition: 'found', committedExactAssetUals: f.selection.assetUals });
      expect(f.host.resolveRegisteredContextGraphAuthority).not.toHaveBeenCalled();
      // Everything after the pre-flight is unchanged: the actual stream ran and every KA was verified.
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      for (const item of f.items) expect(await storedRows(f.store, item.graph)).toBe(1);
      expect(f.host.chain.getLatestMerkleRoot).toHaveBeenCalledTimes(2);
    });

    // Each case starts from a handle that is confirmed usable and then changes exactly one thing,
    // so a pass can only come from the check under test and never from a handle that was never valid.
    it.each([
      'the answer expires',
      'the operation loses ownership',
      'the operation is cancelled',
      'the exchange it was handed to is over',
      'the pass later reads an answer that is no longer public',
    ] as const)('stops relying on it when %s', async (reason) => {
      const f = fixture();
      const { pass, evidence, control } = await ownedPass();
      expect(evidence.usableFor(CG, new AbortController().signal)).toBe(true);
      if (reason === 'the answer expires') control.now = VM_RECOVERY_REGISTERED_PUBLIC_MAX_AGE_MS + 1;
      else if (reason === 'the operation loses ownership') control.current = false;
      else if (reason === 'the operation is cancelled') control.owner.abort();
      else if (reason === 'the exchange it was handed to is over') evidence.revoke();
      else await pass.read(async () => ({ kind: 'unavailable', onChainId: 14n, reason: 'chain-access-policy-unavailable' }) as never);
      expect(evidence.usableFor(CG, new AbortController().signal)).toBe(false);
      await f.run(f.selection, 'stream-required', { registeredPublicEvidence: evidence });
      expect(f.host.resolveRegisteredContextGraphAuthority).toHaveBeenCalledOnce();
    });

    it('does not rely on a handle that belongs to another graph', async () => {
      const f = fixture();
      const { evidence } = await ownedPass({ graph: 'another-graph' });
      expect(evidence.usableFor('another-graph')).toBe(true);
      await f.run(f.selection, 'stream-required', { registeredPublicEvidence: evidence });
      expect(f.host.resolveRegisteredContextGraphAuthority).toHaveBeenCalledOnce();
    });

    it('does not let an independent fetch reuse what a finished pass obtained, and does not stream when authority is unavailable', async () => {
      const f = fixture();
      // A pass read a public answer, handed it to its exchange, and finished: the handle is revoked.
      const { evidence } = await ownedPass();
      evidence.revoke();
      // The graph has since become unavailable; a fetch that was not handed anything must ask for itself.
      f.host.resolveRegisteredContextGraphAuthority.mockResolvedValue({ kind: 'unavailable', onChainId: 14n,
        reason: 'chain-access-policy-unavailable' });
      expect(await f.run(f.selection, 'stream-required')).toMatchObject({
        exactFetchDisposition: 'incomplete', result: { complete: false, failedPhases: 1 },
      });
      expect(f.host.resolveRegisteredContextGraphAuthority).toHaveBeenCalledOnce();
      expect(exchangeExperimentalExactBatch).not.toHaveBeenCalled();
    });

    it('still requires public authority when the reused answer is absent and the live read says private', async () => {
      const f = fixture();
      f.host.resolveRegisteredContextGraphAuthority.mockResolvedValue({ kind: 'private' });
      expect(await f.run(f.selection, 'stream-required')).toMatchObject({
        exactFetchDisposition: 'incomplete', result: { complete: false, failedPhases: 1 },
      });
      expect(exchangeExperimentalExactBatch).not.toHaveBeenCalled();
    });
  });

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
    const [, peer, start, transport] = vi.mocked(exchangeExperimentalExactBatch).mock.calls[0]!;
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
      expect(exactBatchStreamUnsupported(f.host, 'fixture-source', 'fixture-connection', Date.now(),
        f.host.captureExperimentalExactBatchRefusalScope(CG))).toBe(code === 'RESOURCE_LIMIT');
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

  it('keeps a refused stream-only selection pending and permits a later smaller ordinary fetch', async () => {
    const f = fixture(5);
    f.frames.splice(0, f.frames.length,
      { kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode('RESOURCE_LIMIT') });
    expect(await f.run(f.selection, 'stream-required')).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [] });
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    expect(await f.run(f.selection, 'stream-required')).toMatchObject({ exactFetchDisposition: 'incomplete' });
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    const smaller = createUalOnlyExactAssetSelection([f.items[0]!.ual]);
    await f.run(smaller);
    expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
    expect(runDurableSyncDetailed).toHaveBeenCalledOnce();
    expect(vi.mocked(runDurableSyncDetailed).mock.calls[0]![0].exactAssetSelectionFor?.(CG)).toBe(smaller);
    expect(f.atomicStarted).not.toHaveBeenCalled();
  });

  it('preserves the committed prefix and sends only the outstanding smaller selection to ordinary recovery', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT');
    const refused = await f.run(f.selection, 'stream-required');
    expect(refused.committedExactAssetUals).toEqual(f.selection.assetUals.slice(0, 2));
    const remaining = createUalOnlyExactAssetSelection([f.items[2]!.ual]);
    // A refused cycle can resume only after the normal sweep and its jitter.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 75_000);
    try { await f.run(remaining); } finally { clock.mockRestore(); }
    expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
    expect(runDurableSyncDetailed).toHaveBeenCalledOnce();
    expect(vi.mocked(runDurableSyncDetailed).mock.calls[0]![0].exactAssetSelectionFor?.(CG)).toBe(remaining);
    expect(f.atomicStarted.mock.calls.map(([, ual]) => ual)).toEqual(f.selection.assetUals.slice(0, 2));
    for (const [index, item] of f.items.entries()) expect(await storedRows(f.store, item.graph)).toBe(index < 2 ? 1 : 0);
  });

  it.each(['connection', 'deployment', 'binding', 'selected-binding'] as const)(
    'does not carry a resource refusal to a changed %s scope', async boundary => {
      const f = fixture();
      f.host.selectedVmReconcileCursors = new Map([[CG, { bindingGeneration: 1 }]]);
      f.frames.splice(0, f.frames.length,
        { kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode('RESOURCE_LIMIT') });
      await f.run();
      if (boundary === 'connection') f.host.getSyncReconcilerConnectionKey.mockReturnValue('replacement-connection');
      else if (boundary === 'deployment') f.host.chain.deploymentId = 'replacement-deployment';
      else if (boundary === 'binding') f.host.contextGraphBindingState.bump(CG);
      else f.host.selectedVmReconcileCursors.set(CG, { bindingGeneration: 2 });
      await f.run();
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledTimes(2);
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    });

  it('expires a resource downgrade at the inclusive deadline without extending it on ordinary recovery', async () => {
    const f = fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      f.frames.splice(0, f.frames.length,
        { kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode('RESOURCE_LIMIT') });
      await f.run();
      clock.mockReturnValue(100_000 + EXACT_BATCH_RESOURCE_REFUSAL_TTL_MS - 1);
      await f.run();
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(runDurableSyncDetailed).toHaveBeenCalledOnce();
      clock.mockReturnValue(100_000 + EXACT_BATCH_RESOURCE_REFUSAL_TTL_MS);
      await f.run();
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it('does not retain a refusal completed against a replaced graph binding', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT', false, () => f.host.contextGraphBindingState.bump(CG));
    await f.run();
    expect(exactBatchStreamUnsupported(f.host, 'fixture-source', 'fixture-connection', Date.now(),
      f.host.captureExperimentalExactBatchRefusalScope(CG))).toBe(false);
  });

  it('does not expose a typed refusal for an unknown wire code', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'unvalidated wire text');
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
      committedExactAssetUals: f.selection.assetUals.slice(0, 2), result: { complete: false } });
    expect(refusalLogs(f)).toEqual([]);
    expect(exactBatchStreamUnsupported(f.host, 'fixture-source', 'fixture-connection', Date.now(),
      f.host.captureExperimentalExactBatchRefusalScope(CG))).toBe(false);
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
    expect(exactBatchStreamUnsupported(f.host, 'fixture-source', 'fixture-connection', Date.now(),
      f.host.captureExperimentalExactBatchRefusalScope(CG))).toBe(false);
    expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('publishes refusal observations only after transport physical cleanup has settled', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT');
    let enteredClose = false, settled = false, finishClose!: () => void;
    const close = new Promise<void>(resolve => { finishClose = resolve; });
    vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _options, consume) => {
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
    vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _options, consume) => {
      try { return await consume(f.session as never); }
      catch { throw new Error('Fixture final physical close failed'); }
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
      committedExactAssetUals: f.selection.assetUals.slice(0, 2), result: { complete: false, insertedDataTriples: 2 } });
    expect(refusalLogs(f)).toEqual([]);
    expect(exactBatchStreamUnsupported(f.host, 'fixture-source', 'fixture-connection', Date.now(),
      f.host.captureExperimentalExactBatchRefusalScope(CG))).toBe(false);
    expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
    expect(f.session.send).toHaveBeenCalledTimes(2);
    expect(runDurableSyncDetailed).not.toHaveBeenCalled();
  });

  it('discards refusal classification when cancellation arrives during transport cleanup', async () => {
    const f = fixture(5);
    refuseAfterVerifiedPrefix(f, 'RESOURCE_LIMIT');
    vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _options, consume) => {
      try { return await consume(f.session as never); }
      catch (error) { f.controller.abort(new Error('Fixture final cleanup cancellation')); throw error; }
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
      committedExactAssetUals: f.selection.assetUals.slice(0, 2), result: { complete: false, insertedDataTriples: 2 } });
    expect(refusalLogs(f)).toEqual([]);
    expect(exactBatchStreamUnsupported(f.host, 'fixture-source', 'fixture-connection', Date.now(),
      f.host.captureExperimentalExactBatchRefusalScope(CG))).toBe(false);
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
    vi.mocked(exchangeExperimentalExactBatch).mockImplementation(async (_router, _peer, _start, _options, consume) => {
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

  it('takes completed progress from the exchange result without an observational callback', async () => {
    const f = fixture();
    const committedAssetUals = Object.freeze([...f.selection.assetUals]);
    // This exercises the driver/exchange result contract. The surrounding
    // settlement regressions retain the real worker and atomic materializer.
    const exchange = vi.spyOn(exactBatchRequester, 'exchangeExactBatchVerified')
      .mockResolvedValueOnce({ complete: true, committedAssetUals });
    try {
      const outcome = await f.run();
      expect(outcome).toMatchObject({ exactFetchDisposition: 'found', committedExactAssetUals: committedAssetUals,
        result: { complete: true } });
      expect(exchange).toHaveBeenCalledOnce();
      expect(f.atomicStarted).not.toHaveBeenCalled();
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    } finally { exchange.mockRestore(); }
  });

  it('takes incomplete progress from the partial error without an observational callback', async () => {
    const f = fixture();
    const committedAssetUals = Object.freeze(f.selection.assetUals.slice(0, 1));
    const exchange = vi.spyOn(exactBatchRequester, 'exchangeExactBatchVerified')
      .mockRejectedValueOnce(new exactBatchRequester.ExactBatchPartialSyncError(
        committedAssetUals, new Error('Fixture settled transport failure')));
    try {
      const outcome = await f.run();
      expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: committedAssetUals,
        result: { complete: false } });
      expect(exchange).toHaveBeenCalledOnce();
      expect(f.atomicStarted).not.toHaveBeenCalled();
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    } finally { exchange.mockRestore(); }
  });

  it('normalizes the exchange failure once after retaining the real applied prefix', async () => {
    const f = fixture();
    const prefix = f.frames.slice(0, 3);
    const transportFailure = new Error('Fixture transport failure after commit ACK');
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
    vi.mocked(f.session.send).mockImplementation(async () => { acknowledge(); });
    vi.mocked(f.session.next).mockImplementation(async () => {
      if (prefix.length > 0) return prefix.shift();
      await acknowledged;
      throw transportFailure;
    });
    const actualExchange = exactBatchRequester.exchangeExactBatchVerified;
    let partial: unknown;
    const exchange = vi.spyOn(exactBatchRequester, 'exchangeExactBatchVerified')
      .mockImplementation(async (...args) => {
        try { return await actualExchange(...args); }
        catch (error) { partial = error; throw error; }
      });
    try {
      const outcome = await f.run();
      expect(partial).toBeInstanceOf(exactBatchRequester.ExactBatchPartialSyncError);
      expect((partial as Error).cause).toBe(transportFailure);
      expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
        committedExactAssetUals: f.selection.assetUals.slice(0, 1), result: { complete: false, insertedDataTriples: 1 } });
      expect(await storedRows(f.store, f.items[0]!.graph)).toBe(1);
      expect(await storedRows(f.store, f.items[1]!.graph)).toBe(0);
      expect(f.session.send).toHaveBeenCalledOnce();
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    } finally { exchange.mockRestore(); }
  });

  it.each([undefined, '0'])('keeps requester on legacy transport when opt-in is %s', async flag => {
    const f = fixture(); vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', flag);
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
    const first = await f.run(f.selection, 'stream-required');
    const second = await f.run(f.selection, 'stream-required');
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
    const outcome = await f.run(f.selection, 'stream-required');
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
