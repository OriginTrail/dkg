/**
 * GH#3081 — the queued executor reports each step of its work after the confirmation as it ends,
 * in the order it runs them, so the queue's timing line can say where the executor's tail went.
 *
 * Every row runs the real executor over a host whose leaf dependencies are stand-ins: the
 * publisher answers `confirmed` without a chain, and each store, chain and network call the tail
 * makes is a recorded no-op. A row holds one of those calls and reads what the executor had
 * reported before it and after it.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { GRAPH_KA_CONTENT_SCOPE_VERSION, contextGraphAssertionUri } from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  type KnowledgeAssetVmPublishRequest,
  type LiftJobTailStep,
  type PublishOptions,
  type PublishResult,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from '../src/dkg-agent.js';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import type { PublishedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle.js';

const AUTHOR = `0x${'11'.repeat(20)}` as const;
const KAV10 = `0x${'44'.repeat(20)}` as const;
const KA_NUMBER = 7n;
const PACKED_KA_ID = (BigInt(AUTHOR) << 96n) | KA_NUMBER;
const QUADS: Quad[] = [{
  subject: 'https://example.org/alice',
  predicate: 'https://schema.org/name',
  object: '"Alice"',
  graph: '',
}];
const ROOT = ethers.hexlify(computeFlatKCRootV10(QUADS, [])) as `0x${string}`;
const UAL = `did:dkg:evm:31337/${AUTHOR}/${KA_NUMBER}`;
const OPERATIONS = [
  { kind: 'create', overrides: {} },
  { kind: 'update', overrides: { vmCurrentAssertion: `0x${'cd'.repeat(32)}` } },
] as const;

function request(overrides: Partial<KnowledgeAssetVmPublishRequest> = {}): KnowledgeAssetVmPublishRequest {
  return {
    contextGraphId: 'tail-steps', name: 'asset', shareOperationId: 'queued-share', roots: [],
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL, assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0,
    seal: {
      merkleRoot: ROOT, authorAddress: AUTHOR, schemeVersion: 1, reservedKaId: `${PACKED_KA_ID}`,
      signature: { r: `0x${'34'.repeat(32)}`, vs: `0x${'56'.repeat(32)}` },
    },
    sealChainId: '31337', sealKav10Address: KAV10,
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z', sealMerkleRoot: ROOT,
    intentKey: `sha256:${'ab'.repeat(32)}`,
    ...overrides,
  };
}

function publishResult(status: PublishResult['status'] = 'confirmed'): PublishResult {
  return {
    kaId: PACKED_KA_ID, ual: UAL, merkleRoot: ethers.getBytes(ROOT), kaManifest: [], status,
    ...(status === 'confirmed' ? {
      onChainResult: {
        txHash: `0x${'aa'.repeat(32)}`, blockNumber: 5, blockTimestamp: 1, txIndex: 0,
        batchId: PACKED_KA_ID, startKAId: PACKED_KA_ID, endKAId: PACKED_KA_ID, publisherAddress: AUTHOR,
      } as PublishResult['onChainResult'],
    } : {}),
  };
}

/** A call the row can hold: it reports that it was entered and continues when released. */
function held() {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, pass: async (): Promise<void> => { enter(); await released; } };
}

/**
 * The executor's host. `calls` lists the tail's own calls and the reported steps as they happen,
 * so a row reads one interleaved order.
 */
function harness(options: {
  publish?: () => Promise<PublishResult>;
  clearPublishedGraph?: () => Promise<void>;
  retireLegacySwm?: () => Promise<void>;
  observer?: (step: LiftJobTailStep) => void;
  failStep?: string;
  catalogCompletion?: boolean;
  cleanupCompletion?: boolean;
} = {}) {
  const calls: string[] = [];
  /** The options of every publish or update call the executor made. */
  const passedOn: Array<Record<string, unknown>> = [];
  const call = (name: string) => async (): Promise<void> => {
    calls.push(name);
    if (options.failStep === name) throw new Error(`failed ${name}`);
  };
  const publisher = {
    publish: async (passed: Record<string, unknown>) => {
      calls.push('publish()');
      passedOn.push(passed);
      return options.publish?.() ?? publishResult();
    },
    clearPublishedKnowledgeAssetSwm: async () => {
      calls.push('clearPublishedGraph()');
      await options.clearPublishedGraph?.();
      return Object.hasOwn(options, 'cleanupCompletion') ? options.cleanupCompletion : true;
    },
    clearRemainingSharedMemory: call('clearRemainingSharedMemory()'),
    clearSwmShareComplete: call('clearShareMarker()'),
  };
  const host = Object.setPrototypeOf({
    publisher,
    peerId: 'peer-1',
    defaultAgentAddress: AUTHOR,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    chain: {
      getEvmChainId: async () => 31337n,
      getKnowledgeAssetsLifecycleAddress: async () => KAV10,
    },
    store: {
      query: async () => ({ type: 'bindings', bindings: [] }),
      insert: call('stampProvenance()'),
    },
    gossip: { publish: call('gossip()') },
    getContextGraphOnChainId: async () => {
      calls.push('readGraphId()');
      return '1';
    },
    _resolveInlineEncryption: async () => ({}),
    _buildPrecomputedUpdateAttestationForSeal: async () => ({}),
    update: async (...passed: unknown[]) => {
      calls.push('update()');
      passedOn.push(passed.at(-1) as Record<string, unknown>);
      return options.publish?.() ?? publishResult();
    },
    _stampPointer: call('stampVmPointer()'),
    _stampPointerIfDivergedFromVm: call('stampWmPointer()'),
    _writeQueuedKnowledgeAssetVmPublishReceipt: call('writeReceipt()'),
    _repairConfirmedNamedKaVmLifecycle: async () => {
      calls.push('repairLifecycle()');
      return options.failStep === 'repairLifecycle()';
    },
    retireLegacySwmAfterVerifiedVmTwin: async () => {
      calls.push('retireLegacySwm()');
      await options.retireLegacySwm?.();
    },
    observeRfc64ConfirmedVmV1: async () => {
      await call('catalogObserver()')();
      return Object.hasOwn(options, 'catalogCompletion') ? options.catalogCompletion : true;
    },
  }, PublishMethods.prototype) as unknown as DKGAgent;
  const publishOptions = {
    contextGraphId: 'tail-steps',
    quads: QUADS,
    v10ACKProvider: async () => [],
  } as unknown as PublishOptions;
  const onPostConfirmationStep = options.observer ?? ((step: LiftJobTailStep) => { calls.push(`ended:${step}`); });
  const execute = (queued: KnowledgeAssetVmPublishRequest = request()) => (
    PublishMethods.prototype.publishQueuedKnowledgeAssetVmPublish.call(host, queued, publishOptions, { onPostConfirmationStep })
  );
  return { calls, passedOn, execute, host };
}

describe('the steps a queued executor reports after the confirmation', () => {
  it.each([
    ['initial', 'request'], ['initial', 'default'], ['update', 'request'], ['update', 'default'],
  ] as const)('keeps one %s publication identity with its captured %s author', async (kind, authorSource) => {
    const effectiveAuthor = `0x${'22'.repeat(20)}`;
    const prior = 'cd'.repeat(32);
    const queued = request({
      contextGraphId: 'identity-scope', name: 'scoped-asset', subGraphName: 'documents',
      ...(authorSource === 'request' ? { agentAddress: effectiveAuthor } : {}),
      ...(kind === 'update' ? { vmCurrentAssertion: `0x${prior}` } : {}),
    });
    const { host, execute, calls } = harness({ publish: async () => {
      // Finalization must retain the author selected before asynchronous execution.
      (host as any).defaultAgentAddress = `0x${'33'.repeat(20)}`;
      return publishResult();
    } });
    (host as any).defaultAgentAddress = effectiveAuthor;
    const originalRequest = structuredClone(queued);
    const writtenQuads: Quad[] = [];
    const lifecycleWrites: PublishedNamedKaVmLifecycleInput[] = [];
    // Exercise the real write boundaries: mocking these methods hides a second
    // fallback to the default address after asynchronous publication finishes.
    host._writeQueuedKnowledgeAssetVmPublishReceipt = PublishMethods.prototype._writeQueuedKnowledgeAssetVmPublishReceipt;
    host._repairConfirmedNamedKaVmLifecycle = PublishMethods.prototype._repairConfirmedNamedKaVmLifecycle;
    (host as any).getOrCreateNamedKaVmLifecycleRepair = () => ({ submit: async (input: PublishedNamedKaVmLifecycleInput) => {
      lifecycleWrites.push(input); return 'repaired';
    } });
    const clear = vi.spyOn(host.publisher, 'clearPublishedKnowledgeAssetSwm');
    const marker = vi.spyOn(host.publisher, 'clearSwmShareComplete');
    const lifecycle = vi.spyOn(host as any, '_repairConfirmedNamedKaVmLifecycle');
    const pointer = vi.spyOn(host as any, '_stampPointer');
    vi.spyOn(host.store, 'insert').mockImplementation(async (quads) => { writtenQuads.push(...quads); });
    const catalog = vi.spyOn(host as any, 'observeRfc64ConfirmedVmV1');
    expect((await execute(queued)).localFinalizationComplete).toBe(true);
    expect(clear).toHaveBeenCalledWith(queued.contextGraphId, {
      kind: 'named-lifecycle', identity: { agentAddress: AUTHOR, kaNumber: KA_NUMBER },
    }, 'documents', expect.any(Object), UAL, '1');
    expect(marker).toHaveBeenCalledWith(queued.contextGraphId, queued.name, effectiveAuthor, 'documents');
    const assertionUri = contextGraphAssertionUri(queued.contextGraphId, effectiveAuthor, queued.name, queued.subGraphName);
    expect(writtenQuads.some(quad => quad.subject === assertionUri)).toBe(true);
    expect(lifecycleWrites).toEqual([expect.objectContaining({
      contextGraphId: queued.contextGraphId, agentAddress: effectiveAuthor,
      name: queued.name, subGraphName: queued.subGraphName, publishedUal: UAL,
    })]);
    const laterAuthor = `0x${'33'.repeat(20)}`;
    expect(writtenQuads.some(quad => quad.subject.includes(laterAuthor))).toBe(false);
    expect(lifecycleWrites.some(input => input.agentAddress === laterAuthor)).toBe(false);
    expect(lifecycle).toHaveBeenCalledWith(expect.objectContaining({ contextGraphId: queued.contextGraphId,
      name: queued.name, agentAddress: effectiveAuthor, subGraphName: 'documents', packedKaId: PACKED_KA_ID }),
      expect.objectContaining({ status: 'confirmed', ual: UAL, seal: expect.objectContaining({ assertionVersion: '1' }) }),
      expect.objectContaining({ publicQuads: QUADS, publisherPeerId: 'peer-1' }));
    expect(queued).toEqual(originalRequest);
    expect(catalog).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId: queued.contextGraphId, subGraphName: 'documents', assertionCoordinate: queued.name,
      assertionUri: contextGraphAssertionUri(queued.contextGraphId, effectiveAuthor, queued.name, 'documents'),
    }));
    if (kind === 'update') {
      expect(calls).toContain('update()');
      expect(lifecycleWrites[0]).toMatchObject({ priorMerkleRoot: `0x${prior}` });
      expect(pointer).not.toHaveBeenCalled();
    } else {
      expect(calls).toContain('publish()');
      expect(pointer).not.toHaveBeenCalled();
      expect(writtenQuads.every(quad => quad.subject === assertionUri)).toBe(true);
    }
  });

  it('reports every step it runs as that step ends, the call that retires the legacy marker among them', async () => {
    const retirement = held();
    const { calls, execute } = harness({ retireLegacySwm: retirement.pass });

    const executing = execute();
    await retirement.entered;
    // The executor is inside the call that retires the legacy marker, held here by the row. On a
    // node that call returns within a second (`legacy-swm-retirement-caller-wait.test.ts`); the
    // step is reported when it returns, and nothing after it has run or been reported before.
    expect(calls).toEqual([
      // The on-chain id of the graph is read before the publish; it is not read again for the
      // announcement, so no such step is reported.
      'readGraphId()',
      'publish()', 'ended:publish',
      'repairLifecycle()', 'ended:lifecycleStamp',
      'writeReceipt()', 'ended:receiptWrite',
      'clearPublishedGraph()', 'ended:publishedGraphClear',
      'retireLegacySwm()',
    ]);

    retirement.release();
    await expect(executing).resolves.toMatchObject({ status: 'confirmed', ual: UAL });
    expect(calls.slice(10)).toEqual([
      'ended:legacySwmRetire',
      'gossip()', 'ended:finalizationGossip',
      'clearShareMarker()', 'ended:shareMarkerClear',
      'catalogObserver()', 'ended:catalogObserver',
    ]);
  });

  it('reports the clear of the rest of shared memory when the request asks for it', async () => {
    const { calls, execute } = harness();
    await execute(request({ clearSharedMemoryAfter: true }));
    expect(calls.slice(calls.indexOf('ended:legacySwmRetire'), calls.indexOf('gossip()'))).toEqual([
      'ended:legacySwmRetire', 'clearRemainingSharedMemory()', 'ended:remainingSwmClear',
    ]);
  });

  it('writes the update receipt before cleanup and reads the graph id for the announcement', async () => {
    const { calls, execute } = harness();
    await execute(request({ vmCurrentAssertion: `0x${'cd'.repeat(32)}` }));
    expect(calls).toEqual([
      'update()', 'ended:publish',
      'repairLifecycle()', 'ended:lifecycleStamp',
      'writeReceipt()', 'ended:receiptWrite',
      'clearPublishedGraph()', 'ended:publishedGraphClear',
      'retireLegacySwm()', 'ended:legacySwmRetire',
      'readGraphId()', 'ended:graphIdRead',
      'gossip()', 'ended:finalizationGossip',
      'clearShareMarker()', 'ended:shareMarkerClear',
      'catalogObserver()', 'ended:catalogObserver',
    ]);
  });

  it.each(OPERATIONS)('certifies the complete $kind lifecycle, including its receipt', async ({ overrides }) => {
    const { calls, execute } = harness();
    const result = await execute(request(overrides));
    expect(result.localFinalizationComplete).toBe(true);
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(calls.indexOf('writeReceipt()')).toBeLessThan(calls.indexOf('clearPublishedGraph()'));
  });

  it.each(OPERATIONS.flatMap(operation =>
    ['writeReceipt()', 'repairLifecycle()', 'clearShareMarker()', 'clearRemainingSharedMemory()']
      .map(failStep => ({ ...operation, failStep }))))(
    'leaves $kind recovery responsible when $failStep fails despite an upstream certificate', async ({ overrides, failStep }) => {
      const { calls, execute } = harness({ failStep, publish: async () => ({
        ...publishResult(), localFinalizationComplete: true,
      }) });
      const result = await execute(request({ ...overrides, clearSharedMemoryAfter: true }));
      expect(result.status).toBe('confirmed');
      expect(result.localFinalizationComplete).toBeUndefined();
      expect(calls).toContain('ended:shareMarkerClear');
      expect(calls.slice(-2)).toEqual(['catalogObserver()', 'ended:catalogObserver']);
    },
  );

  it('keeps an update confirmed but uncertified while canonical lifecycle repair is pending', async () => {
    const { calls, execute } = harness({ failStep: 'repairLifecycle()', publish: async () => ({
      ...publishResult(), localFinalizationComplete: true,
    }) });
    const result = await execute(request({ vmCurrentAssertion: `0x${'cd'.repeat(32)}`, assertionVersion: '2' }));
    expect(result).toMatchObject({ status: 'confirmed', lifecycleRepairPending: true });
    expect(result.localFinalizationComplete).toBeUndefined();
    expect(calls).not.toContain('stampProvenance()');
    expect(calls.slice(-2)).toEqual(['catalogObserver()', 'ended:catalogObserver']);
  });

  it.each(OPERATIONS.flatMap(operation => [false, undefined].map(catalogCompletion => ({ ...operation, catalogCompletion }))))(
    'clears an upstream $kind certificate when catalog completion is $catalogCompletion', async ({ overrides, catalogCompletion }) => {
      const { execute } = harness({ catalogCompletion, publish: async () => ({
        ...publishResult(), localFinalizationComplete: true,
      }) });
      expect((await execute(request(overrides))).localFinalizationComplete).toBeUndefined();
    },
  );

  it.each(OPERATIONS.flatMap(operation => [false, undefined].map(cleanupCompletion => ({ ...operation, cleanupCompletion }))))(
    'clears an upstream $kind certificate when cleanup completion is $cleanupCompletion', async ({ overrides, cleanupCompletion }) => {
      const { calls, execute } = harness({ cleanupCompletion, publish: async () => ({
        ...publishResult(), localFinalizationComplete: true,
      }) });
      expect((await execute(request(overrides))).localFinalizationComplete).toBeUndefined();
      expect(calls).toContain('retireLegacySwm()');
    },
  );

  it.each(['clear', 'retire'])('retains recovery after a swallowed %s failure', async (step) => {
    const fail = async () => { throw new Error('store refused cleanup'); };
    const { calls, execute } = harness(step === 'clear' ? { clearPublishedGraph: fail } : { retireLegacySwm: fail });
    expect((await execute()).localFinalizationComplete).toBeUndefined();
    expect(calls.includes('retireLegacySwm()')).toBe(step === 'retire');
    expect(calls).toContain('ended:publishedGraphClear');
    expect(calls.includes('ended:legacySwmRetire')).toBe(step === 'retire');
    expect(calls.slice(-6)).toEqual([
      'gossip()', 'ended:finalizationGossip',
      'clearShareMarker()', 'ended:shareMarkerClear',
      'catalogObserver()', 'ended:catalogObserver',
    ]);
  });

  it('keeps the observer to itself: the publish and the update are called without it', async () => {
    const created = harness();
    await created.execute();
    const updated = harness();
    await updated.execute(request({ vmCurrentAssertion: `0x${'cd'.repeat(32)}` }));

    expect(created.calls).toContain('ended:catalogObserver');
    expect(updated.calls).toContain('ended:catalogObserver');
    for (const passed of [...created.passedOn, ...updated.passedOn]) {
      expect(passed).toBeTypeOf('object');
      expect(passed).not.toHaveProperty('onPostConfirmationStep');
    }
    expect([created.passedOn.length, updated.passedOn.length]).toEqual([1, 1]);
  });

  it('reports the published-graph clear when it fails, and no retirement, which then does not run', async () => {
    const { calls, execute, host } = harness({
      clearPublishedGraph: async () => { throw new Error('the store refused the clear'); },
    });
    await expect(execute()).resolves.toMatchObject({ status: 'confirmed' });
    expect(calls.slice(calls.indexOf('clearPublishedGraph()'), calls.indexOf('gossip()'))).toEqual([
      'clearPublishedGraph()', 'ended:publishedGraphClear',
    ]);
    expect(calls).not.toContain('retireLegacySwm()');
    expect(vi.mocked(host.log.warn).mock.calls.map(([, message]) => message)).toEqual([
      expect.stringContaining('Failed to clear published SWM graph after confirmed queued publish'),
    ]);
  });

  it.each(OPERATIONS)('clears an upstream certificate for a tentative $kind, even with a chain result', async ({ kind, overrides }) => {
    const { calls, execute } = harness({ publish: async () => ({
      ...publishResult(), status: 'tentative', localFinalizationComplete: true,
    }) });
    const result = await execute(request(overrides));
    expect(result.status).toBe('tentative');
    expect(result.localFinalizationComplete).toBeUndefined();
    // The catalog tail is still called, and returns at once for a result that is not confirmed.
    expect(calls).toEqual([
      ...(kind === 'create' ? ['readGraphId()', 'publish()'] : ['update()']),
      'ended:publish', 'ended:lifecycleStamp', 'ended:catalogObserver',
    ]);
  });

  it.each(OPERATIONS.flatMap(operation => (['tentative', 'confirmed'] as const).map(status => ({ ...operation, status }))))(
    'does not certify or access gossip for a $status $kind without a chain result', async ({ overrides, status }) => {
      const { calls, execute, host } = harness({ publish: async () => ({
        ...publishResult(status), onChainResult: undefined, localFinalizationComplete: true,
      }) });
      Object.defineProperty(host, 'gossip', { get: () => { throw new Error('gossip not initialized'); } });
      const result = await execute(request(overrides));
      expect(result.status).toBe(status);
      expect(result.localFinalizationComplete).toBeUndefined();
      expect(calls).not.toContain('gossip()');
      expect(calls).not.toContain('writeReceipt()');
      expect(calls).toContain('ended:catalogObserver');
      if (status === 'confirmed') expect(calls).toContain('clearShareMarker()');
    },
  );

  it('propagates an update gossip graph-lookup failure before share and catalog work', async () => {
    const { calls, execute, host } = harness();
    host.getContextGraphOnChainId = async () => { throw new Error('graph lookup unavailable'); };
    await expect(execute(request({ vmCurrentAssertion: `0x${'cd'.repeat(32)}` })))
      .rejects.toThrow('graph lookup unavailable');
    expect(calls).toContain('ended:lifecycleStamp');
    expect(calls).not.toContain('ended:graphIdRead');
    expect(calls).not.toContain('gossip()');
    expect(calls).not.toContain('clearShareMarker()');
    expect(calls).not.toContain('catalogObserver()');
  });

  it('keeps failed gossip transport best-effort and continues the certified tail', async () => {
    const { calls, execute } = harness({ failStep: 'gossip()' });
    expect((await execute()).localFinalizationComplete).toBe(true);
    expect(calls.slice(calls.indexOf('gossip()'))).toEqual([
      'gossip()', 'ended:finalizationGossip',
      'clearShareMarker()', 'ended:shareMarkerClear',
      'catalogObserver()', 'ended:catalogObserver',
    ]);
  });

  it('runs the same tail to the same result when the observer throws or is absent', async () => {
    const reported = harness();
    const expected = await reported.execute();
    const tail = reported.calls.filter((entry) => !entry.startsWith('ended:'));

    const throwing = harness({ observer: () => { throw new Error('observer failed'); } });
    await expect(throwing.execute()).resolves.toEqual(expected);
    expect(throwing.calls).toEqual(tail);

    const silent = harness();
    const withoutObserver = PublishMethods.prototype.publishQueuedKnowledgeAssetVmPublish.call(
      silent.host, request(), { contextGraphId: 'tail-steps', quads: QUADS, v10ACKProvider: async () => [] } as unknown as PublishOptions,
    );
    await expect(withoutObserver).resolves.toEqual(expected);
    expect(silent.calls).toEqual(tail);
  });
});
