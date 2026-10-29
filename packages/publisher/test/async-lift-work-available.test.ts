import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangelogStore, GraphManager, GraphSetIndexStore, OxigraphStore } from '@origintrail-official/dkg-storage';
import { AsyncLiftRunner } from '../src/async-lift-runner.js';
import { TripleStoreAsyncLiftPublisher } from '../src/async-lift-publisher-impl.js';
import type { AsyncLiftPublisher, LiftJob } from '../src/index.js';
import { CONTROL_STATUS, DEFAULT_JOURNAL_GRAPH_URI } from '../src/async-lift-control-plane.js';
import { KA_VM_EXECUTOR_TX_HASH, KA_VM_VALIDATION, kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../../../scripts/testing/ka-vm-publish.js';
import { corruptHeadError } from './_helpers/async-lift-2270-harness.js';

type Scheduler = Parameters<NonNullable<AsyncLiftPublisher['reconciliationScheduling']>['attachScheduler']>[0];
afterEach(() => vi.useRealTimers());

function fixture(journalWrites = false) {
  const store = new OxigraphStore();
  let id = 0;
  const publisher = new TripleStoreAsyncLiftPublisher(store, { idGenerator: () => `job-${++id}`, journalWrites });
  const work = vi.fn();
  const attach = (onWorkAvailable = work) => publisher.reconciliationScheduling.attachScheduler({
    onReconciliationDemand() {}, onWalletRelease() {}, onWorkAvailable,
  });
  attach();
  return { store, publisher, work, attach };
}

function runnerFixture(processNext = vi.fn(async (_wallet: string): Promise<LiftJob | null> => null)) {
  let scheduler: Scheduler | undefined;
  const publisher = {
    processNext, recover: async () => 0, list: async () => [],
    reconciliationScheduling: {
      attachScheduler: (hooks: Scheduler) => { scheduler = hooks; return () => { scheduler = undefined; }; },
      recover: async () => ({ reconciled: 0, pendingWork: false }),
      reconcile: async () => ({ reconciled: 0, pendingWork: false }),
    },
  } as unknown as AsyncLiftPublisher;
  const runner = new AsyncLiftRunner({ publisher, walletIds: ['one', 'two'],
    pollIntervalMs: 12_000, recoveryIntervalMs: 600_000, errorBackoffMs: 1_000 });
  return { runner, processNext, work: () => scheduler?.onWorkAvailable?.() };
}

describe('accepted work scheduling notifications', () => {
  it('notifies only after the accepted record has been durably written', async () => {
    const { store, publisher, work } = fixture();
    let entered!: () => void;
    const atWrite = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const replace = store.replaceSubjectAndInsert.bind(store);
    store.replaceSubjectAndInsert = async (...args) => {
      if (args[2].some((q) => q.predicate === CONTROL_STATUS && q.object === '"accepted"')) {
        entered();
        await gate;
      }
      return replace(...args);
    };
    const admitting = publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await atWrite;
    expect(work).not.toHaveBeenCalled();
    release();
    const jobId = await admitting;
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    expect(work).toHaveBeenCalledOnce();
  });

  it('does not notify when authoritative accepted persistence fails', async () => {
    const { store, publisher, work } = fixture();
    vi.spyOn(store, 'replaceSubjectAndInsert').mockRejectedValue(new Error('store unavailable'));
    await expect(publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest())).rejects.toThrow('store unavailable');
    expect(work).not.toHaveBeenCalled();
  });

  it('isolates a throwing scheduler from durable admission and resume', async () => {
    const { publisher, attach } = fixture();
    attach(() => { throw new Error('scheduler failed'); });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    await expect(publisher.resume()).resolves.toBeUndefined();
  });

  it('still notifies after an auxiliary journal write fails', async () => {
    const { store, publisher, work } = fixture(true);
    const insert = store.insert.bind(store);
    let journalFailed = false;
    vi.spyOn(store, 'insert').mockImplementation(async (quads, ...rest) => {
      if (quads.some((quad) => quad.graph === DEFAULT_JOURNAL_GRAPH_URI)) {
        journalFailed = true;
        throw new Error('journal unavailable');
      }
      return insert(quads, ...rest);
    });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    expect(work).toHaveBeenCalledOnce();
    expect(journalFailed).toBe(true);
  });

  it('pokes for an accepted duplicate but not an already claimed duplicate', async () => {
    const { publisher, work } = fixture();
    const request = kaVmPublishRequest();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    work.mockClear();
    expect(await publisher.enqueueKnowledgeAssetVmPublish(request)).toBe(jobId);
    expect(work).toHaveBeenCalledOnce();
    await publisher.claimNext('wallet');
    work.mockClear();
    expect(await publisher.enqueueKnowledgeAssetVmPublish(request)).toBe(jobId);
    expect(work).not.toHaveBeenCalled();
  });

  it('pokes after a retry and after resume, without bypassing pause', async () => {
    const { publisher, work } = fixture();
    await publisher.pause();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(await publisher.claimNext('wallet')).toBeNull();
    work.mockClear();
    await publisher.resume();
    expect(work).toHaveBeenCalledOnce();
    const claim = await publisher.claimNext('wallet');
    await publisher.openClaimSession(claim!).recordExecutionFailure('claimed', corruptHeadError());
    work.mockClear();
    expect(await publisher.retry()).toBe(1);
    expect(work).toHaveBeenCalledOnce();
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
  });

  it('wakes for an expired unbroadcast claim reset by recovery', async () => {
    vi.useFakeTimers();
    const { publisher, work } = fixture();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet');
    work.mockClear();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(await publisher.recover()).toBe(1);
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    expect(work).toHaveBeenCalledOnce();
  });

  it.each(['broadcast', 'included'] as const)('does not wake claims for an existing %s admission', async (status) => {
    const { publisher, work } = fixture();
    const request = kaVmPublishRequest();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await publisher.claimNext('wallet');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { walletId: 'wallet', txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' },
    });
    if (status === 'included') await publisher.update(jobId, 'included', {
      inclusion: { txHash: KA_VM_EXECUTOR_TX_HASH, blockNumber: 1 },
    });
    work.mockClear();
    expect(await publisher.enqueueKnowledgeAssetVmPublish(request)).toBe(jobId);
    expect(work).not.toHaveBeenCalled();
  });

  it('transfers the new callback atomically and accepts older listeners', async () => {
    const { publisher, attach } = fixture();
    const old = vi.fn();
    const current = vi.fn();
    const detachOld = attach(old);
    const detachCurrent = attach(current);
    detachOld();
    await publisher.resume();
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
    detachCurrent();
    await publisher.resume();
    expect(current).toHaveBeenCalledOnce();
    publisher.reconciliationScheduling.attachScheduler({ onReconciliationDemand() {}, onWalletRelease() {} });
    await expect(publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest())).resolves.toBeTypeOf('string');
  });

  it('transfers all three callbacks across publishers and protects the new owner from stale detach', async () => {
    const store = new OxigraphStore();
    const admission = new TripleStoreAsyncLiftPublisher(new ChangelogStore(store), {
      chainProofResolver: async () => ({ status: 'pending-mempool' }),
      knowledgeAssetVmPublishHandler: { execute: async (input) => {
        await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
        throw new Error('ambiguous send');
      } },
    });
    const runtime = new TripleStoreAsyncLiftPublisher(new GraphSetIndexStore(store));
    const previous = { onReconciliationDemand: vi.fn(), onWalletRelease: vi.fn(), onWorkAvailable: vi.fn() };
    const current = { onReconciliationDemand: vi.fn(), onWalletRelease: vi.fn(), onWorkAvailable: vi.fn() };
    const detachPrevious = admission.reconciliationScheduling.attachScheduler(previous);
    const detachCurrent = runtime.reconciliationScheduling.attachScheduler(current);
    detachPrevious();
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
    const jobId = await admission.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(current.onWorkAvailable).toHaveBeenCalledOnce();
    const claim = await admission.claimNext('wallet');
    await admission.openClaimSession(claim!).recordExecutionFailure('claimed', corruptHeadError());
    expect(current.onWalletRelease).toHaveBeenCalledExactlyOnceWith('wallet');
    expect(await admission.retry()).toBe(1);
    expect((await admission.processNext('wallet'))?.status).toBe('broadcast');
    expect((await admission.getStatus(jobId))?.status).toBe('broadcast');
    expect(current.onReconciliationDemand).toHaveBeenCalledOnce();
    for (const callback of Object.values(previous)) expect(callback).not.toHaveBeenCalled();
    detachCurrent();
    current.onWorkAvailable.mockClear();
    await admission.resume();
    expect(current.onWorkAvailable).not.toHaveBeenCalled();
  });

  it('isolates different graphs and independent store connections', async () => {
    const { store, publisher, work } = fixture();
    const differentGraph = new TripleStoreAsyncLiftPublisher(store, { graphUri: 'urn:other-publisher-queue' });
    const differentStore = new TripleStoreAsyncLiftPublisher(new OxigraphStore());
    await differentGraph.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await differentStore.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(work).not.toHaveBeenCalled();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(work).toHaveBeenCalledOnce();
  });

  it('treats each attachment as a new owner even when callback objects are reused', async () => {
    const { store, publisher } = fixture();
    const other = new TripleStoreAsyncLiftPublisher(store);
    const callbacks = { onReconciliationDemand: vi.fn(), onWalletRelease: vi.fn(), onWorkAvailable: vi.fn() };
    const staleDetach = publisher.reconciliationScheduling.attachScheduler(callbacks);
    const detach = other.reconciliationScheduling.attachScheduler(callbacks);
    staleDetach();
    await publisher.resume();
    expect(callbacks.onWorkAvailable).toHaveBeenCalledOnce();
    detach();
    await other.resume();
    expect(callbacks.onWorkAvailable).toHaveBeenCalledOnce();
    // A later attachment remains reachable after the previous registry entry was removed.
    other.reconciliationScheduling.attachScheduler(callbacks);
    detach();
    await publisher.resume();
    expect(callbacks.onWorkAvailable).toHaveBeenCalledTimes(2);
  });
});

describe('runner accepted-work wake', () => {
  it('wakes all idle wallets without waiting for the 12-second poll', async () => {
    vi.useFakeTimers();
    const { runner, processNext, work } = runnerFixture();
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(processNext).toHaveBeenCalledTimes(2);
      work();
      await vi.advanceTimersByTimeAsync(0);
      expect(processNext.mock.calls.map(([wallet]) => wallet)).toEqual(['one', 'two', 'one', 'two']);
    } finally { await runner.stop(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces a burst during processNext without entering a busy wallet twice', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = new Map<string, number>();
    const processNext = vi.fn(async (wallet: string): Promise<LiftJob | null> => {
      const count = (calls.get(wallet) ?? 0) + 1;
      calls.set(wallet, count);
      if (count === 1) await gate;
      return null;
    });
    const { runner, work } = runnerFixture(processNext);
    try {
      await runner.start();
      for (let i = 0; i < 20; i++) work();
      await vi.advanceTimersByTimeAsync(0);
      expect(processNext).toHaveBeenCalledTimes(2);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect([...calls.values()]).toEqual([2, 2]);
      await vi.advanceTimersByTimeAsync(100);
      expect(processNext).toHaveBeenCalledTimes(4);
    } finally { release(); await runner.stop(); }
  });

  it('cannot interrupt error backoff or revive stopped loops', async () => {
    vi.useFakeTimers();
    const processNext = vi.fn(async (_wallet: string): Promise<LiftJob | null> => { throw new Error('claim failed'); });
    const { runner, work } = runnerFixture(processNext);
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(0);
      work();
      await vi.advanceTimersByTimeAsync(999);
      expect(processNext).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(processNext).toHaveBeenCalledTimes(4);
    } finally {
      const stopping = runner.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;
    }
    work();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(processNext).toHaveBeenCalledTimes(4);
  });

  it.each(['same-handle', 'decorated-handles'])('claims admission from another publisher using %s after startup found no work', async (handles) => {
    vi.useFakeTimers();
    const store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(handles === 'same-handle'
      ? store : new GraphSetIndexStore(store));
    const admission = new TripleStoreAsyncLiftPublisher(handles === 'same-handle'
      ? store : new ChangelogStore(new GraphSetIndexStore(store)));
    const processNext = vi.spyOn(publisher, 'processNextScheduled').mockImplementation(async (wallet, onClaimed) => {
      const claim = await publisher.claimNext(wallet);
      if (claim) onClaimed();
      return claim;
    });
    const runner = new AsyncLiftRunner({ publisher, walletIds: ['wallet'], pollIntervalMs: 12_000,
      recoveryIntervalMs: 600_000, hasIncludedRecoveryResolver: true });
    try {
      await runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(processNext).toHaveBeenCalledOnce();
      const jobId = await admission.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      await vi.advanceTimersByTimeAsync(0);
      expect((await publisher.getStatus(jobId))?.status).toBe('claimed');
      expect(processNext).toHaveBeenCalledTimes(3);
    } finally { await runner.stop(); }
  });
});
