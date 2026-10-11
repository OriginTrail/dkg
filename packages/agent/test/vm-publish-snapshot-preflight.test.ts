import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  LegacyKnowledgeAssetReadOnlyError,
  workspaceKnowledgeAssetOperationSnapshotGraph,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  OxigraphStore,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  storeKnowledgeAssetOperationPublicQuads,
  type KnowledgeAssetVmPublishRequest,
} from '@origintrail-official/dkg-publisher';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import { preflightKnowledgeAssetVmPublishSnapshot } from '../src/vm-publish-snapshot-preflight.js';

const CG = 'preflight';
const NAME = 'snapshot-preflight';
const MEMBER = '0xA32f1cc125401B55911678847426759094055B2d';
const KA_UAL = `did:dkg:hardhat:31337/${MEMBER}/7`;
const RESERVED_KA_ID = (BigInt(MEMBER) << 96n) | 7n;
const PUBLIC_QUAD = {
  subject: 'urn:preflight:subject', predicate: 'urn:preflight:predicate', object: '"value"', graph: '',
};
const MERKLE = computeFlatKCRootV10([PUBLIC_QUAD], []);
const stores: OxigraphStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function fixture() {
  const store = new OxigraphStore();
  stores.push(store);
  const shareOperationId = 'immutable-preflight-share';
  const graphManager = new GraphManager(store);
  await storeKnowledgeAssetOperationPublicQuads({
    store, graphManager, contextGraphId: CG, shareOperationId,
    kaUal: KA_UAL, assertionVersion: 1, quads: [PUBLIC_QUAD],
    privateTripleCount: 0, accessPolicy: 'public', publisherPeerId: 'publisher-peer',
  });
  const sealMerkleRoot = `0x${Buffer.from(MERKLE).toString('hex')}` as const;
  const request: KnowledgeAssetVmPublishRequest = {
    contextGraphId: CG, name: NAME, agentAddress: MEMBER, shareOperationId,
    roots: [], contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: KA_UAL, assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0,
    accessPolicy: 'public',
    seal: {
      merkleRoot: sealMerkleRoot, authorAddress: MEMBER,
      reservedKaId: `${RESERVED_KA_ID}`, schemeVersion: 1,
      signature: { r: `0x${'01'.repeat(32)}`, vs: `0x${'02'.repeat(32)}` },
    },
    sealChainId: '31337', sealKav10Address: '0x1234567890123456789012345678901234567890',
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z', sealMerkleRoot,
    intentKey: `sha256:${'ab'.repeat(32)}`,
  };
  const log = { warn: vi.fn(), debug: vi.fn() };
  return { store, graphManager, request, log };
}

const typedFailures = [
  ['queue full', () => new StoreSchedulerBusyError('queue_full', 'normal', 'query', { storeOperation: 'query' })],
  ['queue wait timeout', () => new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'query', { storeOperation: 'query' })],
  ['managed recovery', () => new StoreOperationTimeoutError({
    backend: 'oxigraph-server', operation: 'query', outcome: 'not_started',
    message: 'Managed Oxigraph is recovering; query was not started',
  })],
  ['dispatched read timeout', () => new StoreOperationTimeoutError({
    backend: 'oxigraph-server', operation: 'query', timeoutMs: 30_000, outcome: 'indeterminate',
  })],
] as const;

describe('GH#2824 immutable VM publish snapshot admission', () => {
  it('wires the constructed public agent to typed rejection and unchanged-snapshot retry', async () => {
    const { store, request } = await fixture();
    // Construct the real composed agent with an explicit store; networking is
    // unnecessary for this read-only operation and is never started.
    const agent = await DKGAgent.create({
      name: 'SnapshotPreflightDelegation', store, chainAdapter: new NoChainAdapter(),
    });
    const before = structuredClone(request);
    const failure = new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'query', {
      storeOperation: 'query',
    });
    vi.spyOn(agent.store, 'query').mockRejectedValueOnce(failure);

    try {
      await expect(agent.preflightKnowledgeAssetVmPublishSnapshot(request)).rejects.toBe(failure);
      await expect(agent.preflightKnowledgeAssetVmPublishSnapshot(request)).resolves.toBeUndefined();
      expect(request).toEqual(before);
    } finally {
      await agent.stop();
      // The fixture owns the supplied store and closes it in afterEach.
    }
  });

  it.each(typedFailures)('preserves %s and retries the identical intent after recovery', async (_label, makeFailure) => {
    const { store, log, request } = await fixture();
    const before = JSON.stringify(request);
    const failure = makeFailure();
    vi.spyOn(store, 'query').mockRejectedValueOnce(failure);

    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).rejects.toBe(failure);
    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).resolves.toBeUndefined();
    expect(JSON.stringify(request)).toBe(before);
  });

  it.each(typedFailures)('preserves a structural %s across package boundaries', async (_label, makeFailure) => {
    const { store, log, request } = await fixture();
    const original = makeFailure();
    const failure = { ...original, message: original.message };
    expect(failure).not.toBeInstanceOf(Error);
    vi.spyOn(store, 'query').mockRejectedValueOnce(failure);

    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).rejects.toBe(failure);
  });

  it('keeps a genuinely absent snapshot stale', async () => {
    const { store, graphManager, log, request } = await fixture();
    await store.dropGraph(graphManager.sharedMemoryMetaUri(CG));

    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).rejects.toMatchObject({
      code: 'PUBLISH_INTENT_STALE', message: expect.stringContaining('Re-share'),
    });
  });

  it('keeps changed immutable snapshot bytes stale', async () => {
    const { store, log, request } = await fixture();
    const graph = workspaceKnowledgeAssetOperationSnapshotGraph(CG, request.shareOperationId);
    await store.dropGraph(graph);
    await store.insert([{ ...PUBLIC_QUAD, object: '"changed after share"', graph }]);

    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).rejects.toMatchObject({
      code: 'PUBLISH_INTENT_STALE', message: expect.stringContaining('Re-share'),
    });
  });

  it('keeps a queued triple-count mismatch stale', async () => {
    const { store, log, request } = await fixture();
    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request: { ...request, publicTripleCount: 2 } }))
      .rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
  });

  it('preserves the existing legacy read-only exception', async () => {
    const { store, log, request } = await fixture();
    const failure = new LegacyKnowledgeAssetReadOnlyError();
    vi.spyOn(store, 'query').mockRejectedValueOnce(failure);
    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).rejects.toBe(failure);
  });

  it.each([
    new Error('Store busy; recovering; query was not started'),
    Object.assign(new Error('unrelated retryable validation failure'), { retryable: true }),
    Object.assign(new Error('untrusted partial busy shape'), { code: 'STORE_SCHEDULER_BUSY', retryable: true }),
  ])('does not infer storage retryability from text or incomplete markers: %s', async (failure) => {
    const { store, log, request } = await fixture();
    vi.spyOn(store, 'query').mockRejectedValueOnce(failure);
    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).rejects.toMatchObject({
      code: 'PUBLISH_INTENT_STALE',
    });
  });

  it.each(['busy', 'timeout'] as const)('records bounded, payload-free %s diagnostics', async (kind) => {
    const { store, log, request } = await fixture();
    const secret = 'credential-private-query-payload';
    const failure = kind === 'busy'
      ? new StoreSchedulerBusyError('queue_wait_timeout', 'normal', secret, { cause: new Error(secret) })
      : new StoreOperationTimeoutError({
        backend: secret, operation: secret, message: secret,
        outcome: 'not_started', cause: new Error(secret),
      });
    Object.defineProperty(store, 'getPressureSnapshot', {
      value: () => ({
        normalInflight: 2, normalQueued: 3, maxConcurrent: 4,
        ackInflight: NaN, ackQueued: -1, backgroundInflight: Infinity,
        backgroundQueued: secret, query: secret,
      }),
    });
    vi.spyOn(store, 'query').mockRejectedValueOnce(failure);

    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).rejects.toBe(failure);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).not.toHaveBeenCalled();
    const diagnostic = JSON.parse(log.warn.mock.calls[0][1]);
    expect(diagnostic).toEqual({
      event: 'vm_publish_snapshot_preflight_rejected', phase: 'snapshot_preflight',
      classification: kind === 'busy' ? 'store_busy' : 'store_timeout',
      code: kind === 'busy' ? 'STORE_SCHEDULER_BUSY' : 'STORE_OPERATION_TIMEOUT',
      outcome: 'not_started', elapsedMs: expect.any(Number),
      ...(kind === 'busy' ? { reason: 'queue_wait_timeout', lane: 'normal' } : {}),
      pressure: { normalInflight: 2, normalQueued: 3, maxConcurrent: 4 },
    });
    expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
    const rendered = JSON.stringify(log.warn.mock.calls);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(request.name);
    expect(rendered).not.toContain(request.shareOperationId);
    expect(rendered).not.toContain(request.kaUal);
  });

  it.each(['pressure', 'logger'] as const)('preserves the original failure when the %s diagnostic hook throws', async (hook) => {
    const { store, log, request } = await fixture();
    const failure = new StoreSchedulerBusyError('queue_full', 'normal', 'query');
    const brokenHook = () => { throw new Error('observability failed'); };
    if (hook === 'pressure') {
      Object.defineProperty(store, 'getPressureSnapshot', { value: brokenHook });
    } else {
      log.warn.mockImplementation(brokenHook);
    }
    vi.spyOn(store, 'query').mockRejectedValueOnce(failure);
    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).rejects.toBe(failure);
  });

  it.each(['stale', 'legacy'] as const)('keeps %s diagnostics below warning level', async (kind) => {
    const { store, log, request } = await fixture();
    const failure = kind === 'legacy' ? new LegacyKnowledgeAssetReadOnlyError() : new Error('private detail');
    vi.spyOn(store, 'query').mockRejectedValueOnce(failure);
    await expect(preflightKnowledgeAssetVmPublishSnapshot({ store, log, request })).rejects.toMatchObject({
      code: kind === 'legacy' ? 'LEGACY_KA_READ_ONLY' : 'PUBLISH_INTENT_STALE',
    });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain('private detail');
  });
});
