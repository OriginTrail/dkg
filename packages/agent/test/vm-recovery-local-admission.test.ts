import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  getSyncBackpressureBusyError,
  getSyncBackpressureSnapshot,
  resolveSyncGlobalBackpressure,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import { VmReconcileSchedulingRuntime } from '../src/vm-reconcile-dispatcher.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const preferred = '12D3KooWLocalAdmissionACore';
const fallback = '12D3KooWLocalAdmissionZCore';
const localCgId = '0x0000000000000000000000000000000000000001/local-admission';

function emptyResult(overrides: Record<string, number | boolean> = {}) {
  return {
    fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
    failedPeers: 0, failedPhases: 0, deniedPhases: 0,
    deferredBackpressure: 1, complete: false, ...overrides,
  };
}

async function harness(targetCount = 3) {
  return createVmRecoveryHostHarness({
    name: 'VmLocalAdmission', localCgId, peers: [preferred, fallback], targetCount,
    targetForOrdinal: (ordinal) => ({
      localCgId, onChainCgId: '1', ordinal, reason: 'no-swm' as const,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    }),
    onFetch: (_peer, targets, recovered) => {
      for (const target of targets) recovered.add(target.ordinal);
      return 'found';
    },
  });
}

afterEach(() => { vi.useRealTimers(); });

/**
 * A host whose reconcile pass is production code down to the exact-fetch wire,
 * and whose wire asks the real one-slot, queue-zero sync admission.
 */
async function reconcilingHost(options: { targetCount: number; maxOrdinalsPerPass: number }) {
  const h = await harness(options.targetCount);
  // The one cast exposes only private host seams. Planning, rotation,
  // reconciliation, the dispatcher, and global admission remain production.
  const internals = h.agent as any;
  internals.config = { ...internals.config, syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 };
  const cursor = { watermark: 0, ahead: new Map<number, number>(), scanOrdinal: 0 };
  const target = { kind: 'subscription', onChainId: '1', onChainCgId: 1n, cursor };
  internals.resolveVmReconcileTarget = async () => target;
  internals.isVmReconcileTargetCurrent = () => true;
  internals.startVmRefreshWorker = () => undefined;
  const persist = vi.fn();
  internals.persistVmReconcileWatermark = persist;
  internals.toContextGraphReconcileResult = (_cg: string, _source: string, _target: unknown, result: unknown) =>
    ({ status: 'pending', result });
  internals.emitVmReconcileTelemetry = () => undefined;
  internals.healStrandedScopedKCs = () => undefined;
  internals.createVmReconcileDeps = (_cg: string, _generation: number, _target: unknown,
    _signal: unknown, deps: { persistWatermark: (cg: string, ordinal: number) => void }) => ({
    getKCCount: async () => h.targets.length,
    getHeadBlock: async () => 100,
    reconcileOrdinal: h.internals.reconcileChainOrdinal,
    recoverPendingOrdinals: (cg: string, onChainCgId: bigint, targets: typeof h.targets, headBlock: number | undefined) =>
      h.internals.recoverVmReconcileBatch(cg, onChainCgId, targets, headBlock, () => true),
    persistWatermark: deps.persistWatermark,
    confirmationDepth: 0,
    maxOrdinalsPerPass: options.maxOrdinalsPerPass,
    log: () => undefined,
  });

  const wirePeers: string[] = [];
  internals.syncExactKnowledgeAssetsFromPeerDetailed = async (peer: string, cg: string, uals: string[], wire: { onWorkStarted?: () => void }) => {
    try {
      const result = await internals.runContextGraphSyncWithBackpressure(
        createOperationContext('sync'), cg, 'durable', `durable:${cg}:${peer}`, async () => {
          wirePeers.push(peer);
          for (const ual of uals) {
            h.recovered.add(h.targets.find((candidate) => candidate.ual === ual)!.ordinal);
          }
          return emptyResult({ fetchedDataTriples: uals.length * 4,
            insertedTriples: uals.length * 4, deferredBackpressure: 0, complete: true });
        }, { priorityOverride: 1_000, source: 'vm-recovery', onWorkStarted: wire.onWorkStarted },
      );
      return { admission: 'work-started', disposition: 'found', result };
    } catch (error) {
      if (!getSyncBackpressureBusyError(error)) throw error;
      return { admission: 'local-admission-deferred', disposition: 'incomplete', result: emptyResult() };
    }
  };
  return { h, internals, cursor, persist, wirePeers };
}

describe('VM recovery under node-local admission pressure', () => {
  it('yields a real queue-zero phonebook lease, then retries the same Core without false progress', async () => {
    const { h, internals, cursor, persist, wirePeers } = await reconcilingHost({
      targetCount: 3, maxOrdinalsPerPass: 10,
    });

    let releasePhonebook!: () => void;
    let phonebookStarted!: () => void;
    const started = new Promise<void>((resolve) => { phonebookStarted = resolve; });
    const held = new Promise<void>((resolve) => { releasePhonebook = resolve; });
    const phonebook = withGlobalSyncBackpressure({
      policy: resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 }),
      ctx: createOperationContext('sync'), label: 'durable:agents-phonebook',
      lane: 'durable', source: 'sync-on-connect',
    }, async () => { phonebookStarted(); await held; });
    await started;
    const onFailure = vi.fn();
    const runtime = new VmReconcileSchedulingRuntime(
      (key, source) => internals.executeVmReconcileForCg(key, source), onFailure,
    );
    internals.vmReconcileScheduling = runtime;
    vi.useFakeTimers();
    try {
      await runtime.dispatch(localCgId, 'live');
      await runtime.waitForIdle();
      expect(wirePeers).toEqual([]);
      expect(cursor.watermark).toBe(0);
      expect(cursor.scanOrdinal).toBe(0);
      expect(persist).not.toHaveBeenCalled();
      expect(runtime.snapshot()).toMatchObject({ active: 0, queued: 0 });
      expect(getSyncBackpressureSnapshot()).toMatchObject({ inflight: 1, queued: 0, limit: 1, queueLimit: 0 });
      for (const record of h.internals.vmReconcileRotationState.values()) {
        expect([...record.attemptedPeerIds]).toEqual([]);
        expect([...record.cleanAbsentPeerIds]).toEqual([]);
        expect(record.phase).toBe('collecting');
        expect(record.failures).toBe(0);
      }
      expect(internals.vmReconcileFetchCooldowns.has(localCgId)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_499);
      expect(wirePeers).toEqual([]);
      releasePhonebook();
      await phonebook;
      await vi.advanceTimersByTimeAsync(1);
      await runtime.waitForIdle();
      expect(wirePeers).toEqual([preferred, preferred]);
      expect(cursor.watermark).toBe(3);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(getSyncBackpressureSnapshot().inflight).toBe(0);
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      releasePhonebook();
      await phonebook;
      await runtime.close();
      vi.useRealTimers();
      await h.agent.stop();
    }
  });

  it('sends a graph that just fetched behind a graph already waiting, then lets it continue at once', async () => {
    // Three slices of two: the first yields to the waiting graph, the second
    // finds nobody waiting and continues at once, the third finishes.
    const { h, internals, cursor, wirePeers } = await reconcilingHost({
      targetCount: 6, maxOrdinalsPerPass: 2,
    });
    const passes: string[] = [];
    const watermarks: number[] = [];
    const runtime = new VmReconcileSchedulingRuntime(
      async (key, source) => {
        passes.push(key);
        if (key !== localCgId) return undefined;
        const result = await internals.executeVmReconcileForCg(key, source);
        watermarks.push(cursor.watermark);
        return result;
      },
      vi.fn(),
    );
    internals.vmReconcileScheduling = runtime;
    const yielded = vi.spyOn(runtime, 'yieldLocalAdmissionTurn');
    const continued = vi.spyOn(runtime, 'triggerLive');
    vi.useFakeTimers();
    try {
      // Another graph was refused earlier and is waiting for the node's sync admission.
      runtime.retryLocalAdmission('waiting-graph', { isCurrent: () => true, canAdmit: () => true });
      await runtime.dispatch(localCgId, 'live');
      // The first slice fetched and has more to do. It does not run again
      // ahead of the waiting graph: it takes its next turn behind it.
      expect(wirePeers.length).toBeGreaterThan(0);
      expect(watermarks).toHaveLength(1);
      expect(cursor.watermark).toBeLessThan(6);
      expect(yielded.mock.results.map((result) => result.value)).toEqual([true]);
      expect(continued).not.toHaveBeenCalled();

      // No timer is advanced from here on: every later pass is a nudge or an
      // immediate continuation.
      await runtime.waitForIdle();
      expect(passes).toEqual([localCgId, 'waiting-graph', localCgId, localCgId]);
      // The second slice asked to yield, found nobody waiting, and continued.
      expect(yielded.mock.results.map((result) => result.value)).toEqual([true, false]);
      expect(continued.mock.calls).toEqual([[localCgId]]);
      expect(watermarks.at(-1)).toBe(6);
      expect(getSyncBackpressureSnapshot().inflight).toBe(0);
    } finally {
      await runtime.close();
      vi.useRealTimers();
      await h.agent.stop();
    }
  });

  it('stops the entire slice after one zero-work local rejection', async () => {
    const h = await harness();
    const sync = vi.fn(async () => ({ admission: 'local-admission-deferred' as const, disposition: 'incomplete' as const, result: emptyResult() }));
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = sync;
    try {
      const result = await h.run();
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync.mock.calls[0]).toBeDefined();
      expect(result).toMatchObject({ attemptedOrdinals: [], localAdmissionDeferred: true,
        hasImmediateRecoveryWork: false, continuationOrdinal: 0 });
      expect(result.outcomes.size).toBe(0);
    } finally { await h.agent.stop(); }
  });

  it.each([
    ['partial metadata', { fetchedMetaTriples: 17 }, 'incomplete'],
    ['remote failure', { failedPeers: 1 }, 'incomplete'],
    ['remote timeout', { timedOutPhases: 1 }, 'incomplete'],
    ['clean absence', { deferredBackpressure: 0, complete: true }, 'clean-absent'],
  ] as const)('retains physical attempt evidence after %s', async (_label, counts, disposition) => {
    const h = await harness(1);
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (_peer, _cg, _uals, options) => { options?.onWorkStarted?.(); return { admission: 'work-started', disposition, result: emptyResult(counts) }; };
    try {
      const result = await h.run();
      expect(result.localAdmissionDeferred).not.toBe(true);
      expect(result.attemptedOrdinals).toEqual([0]);
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect([...record.attemptedPeerIds]).toEqual([preferred]);
      expect([...record.cleanAbsentPeerIds]).toEqual(disposition === 'clean-absent' ? [preferred] : []);
    } finally { await h.agent.stop(); }
  });

  it('uses typed admission deferral even when diagnostic counters are populated', async () => {
    const h = await harness(1);
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async () => ({
      admission: 'local-admission-deferred', disposition: 'incomplete',
      result: emptyResult({ fetchedDataTriples: 9, fetchedMetaTriples: 8, insertedTriples: 7,
        failedPeers: 6, failedPhases: 5, deniedPhases: 4, timedOutPhases: 3,
        completedPhases: 2, checkpointAdvances: 1, metaOnlyResponses: 9,
        verifiedPrivateOnlyResponses: 8, dataRejectedMissingMeta: 7, rejectedKcs: 6 }),
    });
    try {
      const result = await h.run();
      expect(result).toMatchObject({ localAdmissionDeferred: true, attemptedOrdinals: [] });
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect(record.attemptedPeerIds.size).toBe(0);
      expect(record.lastAttemptedPeerId).toBeUndefined();
      expect(record.failures).toBe(0);
    } finally { await h.agent.stop(); }
  });

  it('retains an admitted attempt with zero diagnostic progress', async () => {
    const h = await harness(1);
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (_peer, _cg, _uals, options) => {
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect(record.attemptedPeerIds.size).toBe(0);
      options?.onWorkStarted?.();
      expect([...record.attemptedPeerIds]).toEqual([preferred]);
      return { admission: 'work-started', disposition: 'incomplete', result: emptyResult() };
    };
    try {
      const result = await h.run();
      expect(result.localAdmissionDeferred).not.toBe(true);
      expect(result.attemptedOrdinals).toEqual([0]);
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect([...record.attemptedPeerIds]).toEqual([preferred]);
      expect(record.cleanAbsentPeerIds.size).toBe(0);
    } finally { await h.agent.stop(); }
  });

  it('does not mutate a replacement rotation installed while admission was pending', async () => {
    const h = await harness(1);
    let replacement: unknown;
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async () => {
      const key = h.internals.vmReconcileRotationSlotKey(h.targets[0]!);
      const old = h.internals.vmReconcileRotationState.get(key)!;
      const newer = { ...old, attemptedPeerIds: new Set([fallback]),
        cleanAbsentPeerIds: new Set([fallback]), lastAttemptedPeerId: fallback,
        collectionDeadlineAt: old.collectionDeadlineAt + 100, failures: 7 };
      h.internals.vmReconcileRotationState.set(key, newer);
      replacement = newer;
      return { admission: 'local-admission-deferred', disposition: 'incomplete', result: emptyResult() };
    };
    try {
      const result = await h.run();
      expect(result.localAdmissionDeferred).toBe(true);
      const current = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect(current).toBe(replacement);
      expect([...current.attemptedPeerIds]).toEqual([fallback]);
      expect([...current.cleanAbsentPeerIds]).toEqual([fallback]);
      expect(current.lastAttemptedPeerId).toBe(fallback);
      expect(current.failures).toBe(7);
    } finally { await h.agent.stop(); }
  });

  it('does not install an attempt over another marker when local admission defers', async () => {
    const h = await harness(1);
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async () => {
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      record.lastAttemptedPeerId = fallback;
      record.collectionDeadlineAt += 100;
      record.attemptedPeerIds.add(fallback);
      return { admission: 'local-admission-deferred', disposition: 'incomplete', result: emptyResult() };
    };
    try {
      await h.run();
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect(record.lastAttemptedPeerId).toBe(fallback);
      expect([...record.attemptedPeerIds]).toEqual([fallback]);
    } finally { await h.agent.stop(); }
  });

  it('does not retry or clear replacement cooldown ownership after cancellation', async () => {
    const h = await harness(1);
    const internals = h.agent as any;
    const controller = new AbortController();
    let replacementOwner: symbol | undefined;
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async () => {
      controller.abort();
      replacementOwner = internals.installVmReconcileActiveFetchCooldown(localCgId, 123);
      return { admission: 'local-admission-deferred', disposition: 'incomplete', result: emptyResult() };
    };
    try {
      const result = await h.internals.recoverVmReconcileBatch(localCgId, 1n, h.targets, 100,
        () => true, controller.signal);
      expect(result.localAdmissionDeferred).not.toBe(true);
      expect(result.attemptedOrdinals).toEqual([]);
      expect(internals.readVmReconcileActiveFetchCooldown(localCgId)?.owner).toBe(replacementOwner);
    } finally { await h.agent.stop(); }
  });

  it('preserves cached legacy-only peers after a zero-work admission refusal', async () => {
    const h = await harness(1);
    const internals = h.agent as any;
    internals.rememberVmReconcileExactFilterUnsupported(preferred);
    const exact = vi.fn();
    internals.syncExactKnowledgeAssetsFromPeerDetailed = exact;
    internals.runLegacyDurableSyncDetailed = async () => ({ admission: 'local-admission-deferred', result: emptyResult() });
    try {
      const result = await h.run();
      expect(result.localAdmissionDeferred).toBe(true);
      expect(exact).not.toHaveBeenCalled();
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect([...record.attemptedPeerIds]).toEqual([]);
      expect(internals.vmReconcileExactFilterUnsupported(preferred)).toBe(true);
    } finally { await h.agent.stop(); }
  });

  it('keeps a fresh remote capability response credited when its legacy fallback is locally refused', async () => {
    const h = await harness(1);
    const internals = h.agent as any;
    let admittedDeadline: number | undefined;
    internals.syncExactKnowledgeAssetsFromPeerDetailed = async (_peer: string, _cg: string, _uals: string[], options: { onWorkStarted: () => void }) => {
      options.onWorkStarted();
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect([...record.attemptedPeerIds]).toEqual([preferred]);
      admittedDeadline = record.collectionDeadlineAt;
      return { admission: 'work-started', disposition: 'incomplete', responderCapability: 'legacy-filter-unsupported', result: emptyResult() };
    };
    internals.runLegacyDurableSyncDetailed = async () => {
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect(record.lastAttemptedPeerId).toBe(preferred);
      expect(record.collectionDeadlineAt).toBe(admittedDeadline);
      return { admission: 'local-admission-deferred', result: emptyResult() };
    };
    try {
      const result = await h.run();
      expect(result.localAdmissionDeferred).not.toBe(true);
      expect(result.attemptedOrdinals).toEqual([0]);
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[0]!))!;
      expect([...record.attemptedPeerIds]).toEqual([preferred]);
    } finally { await h.agent.stop(); }
  });
});

describe('bounded local-admission retry scheduling', () => {
  it('coalesces retries, releases the worker, and preserves dispatcher cross-CG fairness', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const runtime = new VmReconcileSchedulingRuntime(async (key) => { calls.push(key); }, vi.fn(),
      { concurrency: 1, maxPending: 2, maxForegroundBurst: 1 });
    try {
      runtime.retryLocalAdmission('busy', { isCurrent: () => true });
      runtime.retryLocalAdmission('busy', { isCurrent: () => true });
      await runtime.dispatch('other', 'periodic');
      await runtime.waitForIdle();
      expect(calls).toEqual(['other']);
      expect(runtime.snapshot()).toMatchObject({ active: 0, queued: 0 });
      await vi.advanceTimersByTimeAsync(2_499);
      expect(calls).toEqual(['other']);
      await vi.advanceTimersByTimeAsync(1);
      await runtime.waitForIdle();
      expect(calls).toEqual(['other', 'busy']);
    } finally { await runtime.close(); }
  });

  it.each(['abort', 'stale', 'close'] as const)('cancels a pending retry on %s', async (mode) => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const runtime = new VmReconcileSchedulingRuntime(run, vi.fn());
    const controller = new AbortController();
    let current = true;
    runtime.retryLocalAdmission('busy', { signal: controller.signal, isCurrent: () => current });
    if (mode === 'abort') controller.abort();
    if (mode === 'stale') current = false;
    if (mode === 'close') await runtime.close();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(run).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('bounds retained retries by the existing pending-key limit', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const runtime = new VmReconcileSchedulingRuntime(run, vi.fn(), { maxPending: 2 });
    try {
      for (const key of ['one', 'two', 'overflow']) runtime.retryLocalAdmission(key, { isCurrent: () => true });
      await vi.advanceTimersByTimeAsync(2_500);
      await runtime.waitForIdle();
      expect(run.mock.calls.map(([key]) => key)).toEqual(['one', 'two']);
    } finally { await runtime.close(); }
  });
});

describe('waiting for node-local sync admission', () => {
  const current = { isCurrent: () => true };

  it('runs no pass for a refused graph until the capacity read allows it', async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    let free = false;
    const canAdmit = vi.fn(() => free);
    const runtime = new VmReconcileSchedulingRuntime(async (key) => { passes.push(key); }, vi.fn());
    try {
      runtime.retryLocalAdmission('waiting', { ...current, canAdmit });
      // Twenty-four retry intervals: the capacity is read each time, the pass never runs.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(canAdmit).toHaveBeenCalledTimes(24);
      expect(passes).toEqual([]);
      free = true;
      await vi.advanceTimersByTimeAsync(2_500);
      await runtime.waitForIdle();
      expect(passes).toEqual(['waiting']);
      // Served: nothing is left to nudge.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(passes).toEqual(['waiting']);
    } finally { await runtime.close(); }
  });

  it('serves waiting graphs in turn, one pass per fetch, while a single slot is busy', async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    const fetches: string[] = [];
    const remaining = new Map([['a', 2], ['b', 2], ['c', 2]]);
    let slotHeldBy: string | undefined;
    const wait = { ...current, canAdmit: () => slotHeldBy === undefined };
    // One pass: its chain reads, then a fetch that needs the node's only slot.
    const runtime: VmReconcileSchedulingRuntime<void> = new VmReconcileSchedulingRuntime(async (key) => {
      passes.push(key);
      if (slotHeldBy !== undefined) {
        runtime.retryLocalAdmission(key, wait);
        return;
      }
      slotHeldBy = key;
      await new Promise<void>((resolve) => { setTimeout(resolve, 10_000); });
      slotHeldBy = undefined;
      fetches.push(key);
      const left = remaining.get(key)! - 1;
      remaining.set(key, left);
      if (left > 0 && !runtime.yieldLocalAdmissionTurn(key, wait)) runtime.triggerLive(key);
    }, vi.fn(), { concurrency: 2 });
    try {
      for (const key of ['a', 'b', 'c']) runtime.triggerLive(key);
      await vi.advanceTimersByTimeAsync(61_000);
      await runtime.waitForIdle();
      expect(fetches).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
      // `b` and `c` are refused once while `a` fetches. After that every pass fetches.
      expect(passes).toEqual(['a', 'b', 'c', 'b', 'c', 'a', 'b', 'c']);
    } finally { await runtime.close(); }
  });

  it('keeps a nudged graph first in line when it is refused again, and nudges nothing for one delay', async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    let admits = false;
    // The capacity read says yes while the admission itself still refuses.
    const wait = { ...current, canAdmit: () => true };
    const runtime: VmReconcileSchedulingRuntime<void> = new VmReconcileSchedulingRuntime(async (key) => {
      passes.push(key);
      if (!admits) runtime.retryLocalAdmission(key, wait);
    }, vi.fn());
    try {
      runtime.triggerLive('first');
      runtime.triggerLive('second');
      await vi.advanceTimersByTimeAsync(0);
      await runtime.waitForIdle();
      // Both are refused and wait. `first` is nudged and refused again, and
      // `second` is not tried in its place.
      expect(passes).toEqual(['first', 'second', 'first']);
      await vi.advanceTimersByTimeAsync(2_499);
      expect(passes).toEqual(['first', 'second', 'first']);
      await vi.advanceTimersByTimeAsync(1);
      await runtime.waitForIdle();
      expect(passes).toEqual(['first', 'second', 'first', 'first']);
      admits = true;
      await vi.advanceTimersByTimeAsync(2_500);
      await runtime.waitForIdle();
      expect(passes).toEqual(['first', 'second', 'first', 'first', 'first', 'second']);
    } finally { await runtime.close(); }
  });

  it('passes over a waiter that cannot be admitted for a later one that can', async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    const runtime = new VmReconcileSchedulingRuntime(async (key) => { passes.push(key); }, vi.fn());
    try {
      runtime.retryLocalAdmission('no-capacity', { ...current, canAdmit: () => false });
      runtime.retryLocalAdmission('own-capacity', { ...current, canAdmit: () => true });
      await vi.advanceTimersByTimeAsync(2_500);
      await runtime.waitForIdle();
      expect(passes).toEqual(['own-capacity']);
    } finally { await runtime.close(); }
  });

  it('stops waiting when a pass of the graph is not refused again', async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    let free = false;
    const runtime = new VmReconcileSchedulingRuntime(async (key) => { passes.push(key); }, vi.fn());
    try {
      runtime.retryLocalAdmission('swept', { ...current, canAdmit: () => free });
      // The periodic sweep still visits a waiting graph; this pass gets through.
      await runtime.dispatch('swept', 'periodic');
      free = true;
      await vi.advanceTimersByTimeAsync(10_000);
      await runtime.waitForIdle();
      expect(passes).toEqual(['swept']);
    } finally { await runtime.close(); }
  });

  it('nudges the next waiter once a nudged pass has had time to reach its admission', async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runtime = new VmReconcileSchedulingRuntime(async (key) => {
      passes.push(key);
      if (key === 'first') await firstHeld;
    }, vi.fn(), { concurrency: 2 });
    try {
      runtime.retryLocalAdmission('first', { ...current, canAdmit: () => true });
      runtime.retryLocalAdmission('second', { ...current, canAdmit: () => true });
      // `first` is nudged at the first capacity read and its pass does not settle.
      await vi.advanceTimersByTimeAsync(2_500);
      expect(passes).toEqual(['first']);
      await vi.advanceTimersByTimeAsync(12_500);
      expect(passes).toEqual(['first']);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(passes).toEqual(['first', 'second']);
    } finally {
      releaseFirst();
      await runtime.close();
    }
  });

  it('treats a capacity read that throws as a plain retry', async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    const runtime = new VmReconcileSchedulingRuntime(async (key) => { passes.push(key); }, vi.fn());
    try {
      runtime.retryLocalAdmission('unreadable', {
        ...current,
        canAdmit: () => { throw new Error('policy unavailable'); },
      });
      await vi.advanceTimersByTimeAsync(2_500);
      await runtime.waitForIdle();
      expect(passes).toEqual(['unreadable']);
    } finally { await runtime.close(); }
  });

  it.each(['abort', 'stale'] as const)('drops a waiter on %s and serves the one behind it', async (mode) => {
    vi.useFakeTimers();
    const passes: string[] = [];
    const controller = new AbortController();
    let stillCurrent = true;
    let free = false;
    const runtime = new VmReconcileSchedulingRuntime(async (key) => { passes.push(key); }, vi.fn());
    try {
      runtime.retryLocalAdmission('gone', {
        signal: controller.signal, isCurrent: () => stillCurrent, canAdmit: () => free,
      });
      runtime.retryLocalAdmission('behind', { ...current, canAdmit: () => free });
      if (mode === 'abort') controller.abort();
      else stillCurrent = false;
      free = true;
      await vi.advanceTimersByTimeAsync(2_500);
      await runtime.waitForIdle();
      expect(passes).toEqual(['behind']);
    } finally { await runtime.close(); }
  });

  it('leaves a waiter held after a failed pass to the periodic sweep', async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    let free = false;
    const wait = { ...current, canAdmit: () => free };
    const runtime: VmReconcileSchedulingRuntime<void> = new VmReconcileSchedulingRuntime(async (key) => {
      passes.push(key);
      if (key === 'failing' && passes.length === 1) {
        runtime.retryLocalAdmission(key, wait);
        throw new Error('pass failed after it was refused');
      }
    }, vi.fn());
    try {
      await expect(runtime.dispatch('failing', 'live')).rejects.toThrow('pass failed');
      runtime.retryLocalAdmission('behind', wait);
      free = true;
      await vi.advanceTimersByTimeAsync(2_500);
      await runtime.waitForIdle();
      // The failed graph's live nudges are held, so only the one behind it runs.
      expect(passes).toEqual(['failing', 'behind']);
      runtime.triggerPeriodic('failing');
      await runtime.waitForIdle();
      expect(passes).toEqual(['failing', 'behind', 'failing']);
    } finally { await runtime.close(); }
  });

  it('drops a nudge the bounded dispatcher has no room for', async () => {
    vi.useFakeTimers();
    const passes: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new VmReconcileSchedulingRuntime(async (key) => {
      passes.push(key);
      if (key === 'active') await held;
    }, vi.fn(), { concurrency: 1, maxPending: 1 });
    try {
      const active = runtime.dispatch('active', 'live');
      const queued = runtime.dispatch('queued', 'live');
      runtime.retryLocalAdmission('waiting', { ...current, canAdmit: () => true });
      await vi.advanceTimersByTimeAsync(2_500);
      release();
      await Promise.all([active, queued]);
      await vi.advanceTimersByTimeAsync(10_000);
      await runtime.waitForIdle();
      // The nudge found the queue full and was not retained; the sweep owns the graph.
      expect(passes).toEqual(['active', 'queued']);
    } finally {
      release();
      await runtime.close();
    }
  });

  it('yields only to graphs that are actually waiting', async () => {
    const runtime = new VmReconcileSchedulingRuntime(async () => undefined, vi.fn(), { maxPending: 2 });
    const controller = new AbortController();
    try {
      expect(runtime.yieldLocalAdmissionTurn('solo', current)).toBe(false);
      runtime.retryLocalAdmission('solo', { ...current, canAdmit: () => false });
      // Its own place in the queue is not another graph waiting.
      expect(runtime.yieldLocalAdmissionTurn('solo', current)).toBe(false);
      runtime.retryLocalAdmission('other', { ...current, canAdmit: () => false });
      expect(runtime.yieldLocalAdmissionTurn('stale', { isCurrent: () => false })).toBe(false);
      controller.abort();
      expect(runtime.yieldLocalAdmissionTurn('aborted', { ...current, signal: controller.signal })).toBe(false);
      // The queue is at its bound, so a third graph is not retained.
      expect(runtime.yieldLocalAdmissionTurn('third', current)).toBe(false);
      expect(runtime.yieldLocalAdmissionTurn('solo', current)).toBe(true);
    } finally { await runtime.close(); }
    expect(runtime.yieldLocalAdmissionTurn('closed', current)).toBe(false);
  });
});
