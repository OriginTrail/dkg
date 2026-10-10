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
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
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
} = {}) {
  const calls: string[] = [];
  /** The options of every publish or update call the executor made. */
  const passedOn: Array<Record<string, unknown>> = [];
  const call = (name: string) => async (): Promise<void> => { calls.push(name); };
  const publisher = {
    publish: async (passed: Record<string, unknown>) => {
      calls.push('publish()');
      passedOn.push(passed);
      return options.publish?.() ?? publishResult();
    },
    clearPublishedKnowledgeAssetSwm: async () => {
      calls.push('clearPublishedGraph()');
      await options.clearPublishedGraph?.();
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
      insert: async () => {},
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
      return publishResult();
    },
    _stampPointer: async () => {},
    _stampPointerIfDivergedFromVm: async () => {},
    _writeQueuedKnowledgeAssetVmPublishReceipt: call('writeReceipt()'),
    _stampQueuedKnowledgeAssetVmPublishedLifecycle: call('stampLifecycle()'),
    retireLegacySwmAfterVerifiedVmTwin: async () => {
      calls.push('retireLegacySwm()');
      await options.retireLegacySwm?.();
    },
    observeRfc64ConfirmedVmV1: call('catalogObserver()'),
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
  it('reports every step it runs as that step ends, and waits for the legacy retirement in between', async () => {
    const retirement = held();
    const { calls, execute } = harness({ retireLegacySwm: retirement.pass });

    const executing = execute();
    await retirement.entered;
    // The executor is waiting for the retirement: nothing after it has run or been reported.
    expect(calls).toEqual([
      // The on-chain id of the graph is read before the publish; it is not read again for the
      // announcement, so no such step is reported.
      'readGraphId()',
      'publish()', 'ended:publish',
      'writeReceipt()', 'ended:receiptWrite',
      'clearPublishedGraph()', 'ended:publishedGraphClear',
      'retireLegacySwm()',
    ]);

    retirement.release();
    await expect(executing).resolves.toMatchObject({ status: 'confirmed', ual: UAL });
    expect(calls.slice(8)).toEqual([
      'ended:legacySwmRetire',
      'stampLifecycle()', 'ended:lifecycleStamp',
      'gossip()', 'ended:finalizationGossip',
      'clearShareMarker()', 'ended:shareMarkerClear',
      'catalogObserver()', 'ended:catalogObserver',
    ]);
  });

  it('reports the clear of the rest of shared memory when the request asks for it', async () => {
    const { calls, execute } = harness();
    await execute(request({ clearSharedMemoryAfter: true }));
    expect(calls.slice(calls.indexOf('ended:legacySwmRetire'), calls.indexOf('stampLifecycle()'))).toEqual([
      'ended:legacySwmRetire', 'clearRemainingSharedMemory()', 'ended:remainingSwmClear',
    ]);
  });

  it('reports an update: no receipt write, and the graph id read for the announcement', async () => {
    const { calls, execute } = harness();
    await execute(request({ vmCurrentAssertion: `0x${'cd'.repeat(32)}` }));
    expect(calls).toEqual([
      'update()', 'ended:publish',
      'clearPublishedGraph()', 'ended:publishedGraphClear',
      'retireLegacySwm()', 'ended:legacySwmRetire',
      'stampLifecycle()', 'ended:lifecycleStamp',
      'readGraphId()', 'ended:graphIdRead',
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
    expect(calls.slice(calls.indexOf('clearPublishedGraph()'), calls.indexOf('stampLifecycle()'))).toEqual([
      'clearPublishedGraph()', 'ended:publishedGraphClear',
    ]);
    expect(calls).not.toContain('retireLegacySwm()');
    expect(vi.mocked(host.log.warn).mock.calls.map(([, message]) => message)).toEqual([
      expect.stringContaining('Failed to clear published SWM graph after confirmed queued publish'),
    ]);
  });

  it('reports only the publish call for a result that was not confirmed', async () => {
    const { calls, execute } = harness({ publish: async () => publishResult('tentative') });
    await expect(execute()).resolves.toMatchObject({ status: 'tentative' });
    // The catalog tail is still called, and returns at once for a result that is not confirmed.
    expect(calls).toEqual(['readGraphId()', 'publish()', 'ended:publish', 'ended:catalogObserver']);
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
