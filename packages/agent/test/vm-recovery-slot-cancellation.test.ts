import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { OrdinalRecoveryTarget } from '../src/chain-reconciler.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { waitForPeerProtocol } from '../src/p2p/protocol-readiness.js';
import type { ContextGraphSub, VmReconcileRotationRecord } from '../src/dkg-agent-types.js';
import {
  vmRecoverySlotKey,
  type VmRecoverySlotRegistry,
} from '../src/internal/vm-recovery-slot-registry.js';
import {
  getSyncBackpressureSnapshot,
  resolveSyncGlobalBackpressure,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import {
  createVmRecoveryHostHarness,
  type VmRecoveryHostInternals,
} from './_helpers/vm-recovery-host.js';
import {
  applyVmRecoveryInvalidation, VM_RECOVERY_INVALIDATIONS,
} from './_helpers/vm-recovery-invalidation.js';

interface CancellationHost extends VmRecoveryHostInternals {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  vmReconcileLifecycleController: AbortController;
  bindSubscriptionOnChainId(localCgId: string, subscription: ContextGraphSub, onChainId: string): void;
  prepareVmReconcileRotationTarget(
    target: OrdinalRecoveryTarget,
    peers: readonly string[],
    now: number,
  ): { record?: VmReconcileRotationRecord; suppressed: boolean };
  closeVmReconcileRotationState(): void;
  clearVmReconcileRotationStateForSlot(localCgId: string, onChainCgId: bigint, ordinal: number): void;
}

function targetFor(localCgId: string, ordinal = 0): OrdinalRecoveryTarget {
  return {
    localCgId, onChainCgId: '1', ordinal, kaId: String(ordinal),
    ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    merkleRoot: `root-${ordinal}`, reason: 'no-swm',
  };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const cases = (['discovery', 'legacy-meta', 'legacy-registry', 'dial', 'protocol', 'admission', 'transport'] as const).flatMap(stage =>
  VM_RECOVERY_INVALIDATIONS
    .map(invalidation => ({ stage, invalidation })),
);

describe('exact VM recovery slot cancellation', () => {
  it('keeps the donor running when a replacement record cannot be installed', async () => {
    const localCgId = '0x0000000000000000000000000000000000000001/failed-donation';
    const peer = '12D3KooWFailedDonation';
    const entered = barrier();
    const release = barrier();
    let signal: AbortSignal | undefined;
    const harness = await createVmRecoveryHostHarness({
      name: 'FailedDonation', localCgId, peers: [peer], targetCount: 1,
      targetForOrdinal: ordinal => targetFor(localCgId, ordinal), onFetch: () => 'clean-absent',
    });
    const host = harness.internals as CancellationHost;
    host.waitForSyncProtocol = async (_peer, operationSignal) => {
      signal = operationSignal;
      entered.release();
      await release.promise;
      return true;
    };
    const descriptor = Object.getOwnPropertyDescriptor(DKGAgentBase, 'VM_RECONCILE_CACHE_MAX_ENTRIES')!;
    const recovery = harness.run();
    try {
      await entered.promise;
      Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_CACHE_MAX_ENTRIES', { ...descriptor, value: 2 });
      host.prepareVmReconcileRotationTarget(targetFor(localCgId, 1), [peer], host.vmReconcileRotationNow());
      const original = [...host.vmRecoverySlots.snapshot().entries()];
      const waitingTarget = targetFor('waiting-cg');
      const waitingKey = vmRecoverySlotKey(waitingTarget);
      // Fault injection targets the registry's retention seam; its maps stay private.
      const registry = host.vmRecoverySlots as VmRecoverySlotRegistry & {
        retainRecord(key: string, record: VmReconcileRotationRecord): void;
      };
      const retain = registry.retainRecord.bind(registry);
      const failInstall = vi.spyOn(registry, 'retainRecord').mockImplementation((key, record) => {
        if (key === waitingKey) throw new Error('injected install failure');
        return retain(key, record);
      });
      try {
        expect(() => host.prepareVmReconcileRotationTarget(waitingTarget, [peer], host.vmReconcileRotationNow()))
          .toThrow('injected install failure');
      } finally { failInstall.mockRestore(); }
      expect(host.vmRecoverySlots.snapshot().size).toBe(original.length);
      for (const [key, record] of original) expect(host.vmRecoverySlots.snapshot().get(key)).toBe(record);
      expect(signal?.aborted).toBe(false);
      release.release();
      expect((await recovery).attemptedOrdinals).toEqual([0]);
    } finally {
      release.release();
      await recovery;
      Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_CACHE_MAX_ENTRIES', descriptor);
      await harness.agent.stop().catch(() => undefined);
    }
  });

  it('does not cancel a successful batch when ordinal reconciliation clears completed slots', async () => {
    const localCgId = '0x0000000000000000000000000000000000000001/normal-completion';
    const signals: AbortSignal[] = [];
    const harness = await createVmRecoveryHostHarness({
      name: 'NormalSlotCompletion', localCgId, peers: ['12D3KooWNormalCompletion'], targetCount: 3,
      targetForOrdinal: ordinal => targetFor(localCgId, ordinal),
      onFetch: (_peer, targets, recovered, signal) => {
        if (signal) signals.push(signal);
        for (const target of targets) recovered.add(target.ordinal);
        return 'found';
      },
    });
    const host = harness.internals as CancellationHost;
    const reconcile = host.reconcileChainOrdinal.bind(host);
    host.reconcileChainOrdinal = async (cg, chainCg, ordinal, head, options) => {
      const outcome = await reconcile(cg, chainCg, ordinal, head, options);
      if (outcome.status === 'reconciled') host.clearVmReconcileRotationStateForSlot(cg, chainCg, ordinal);
      return outcome;
    };
    try {
      const result = await harness.run();
      expect(harness.fetched.map(fetch => fetch.uals.length)).toEqual([1, 2]);
      expect([...result.outcomes.values()]).toEqual(Array.from({ length: 3 }, () => ({ status: 'reconciled', blockNumber: 100 })));
      expect(signals.every(signal => !signal.aborted)).toBe(true);
      expect(host.vmRecoverySlots.snapshot().size).toBe(0);
    } finally { await harness.agent.stop().catch(() => undefined); }
  });

  it('removes a canceled global admission waiter without releasing another operation', async () => {
    const localCgId = '0x0000000000000000000000000000000000000001/global-wait';
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 });
    const blockerEntered = barrier();
    const releaseBlocker = barrier();
    const queued = barrier();
    const network = vi.fn();
    const blocker = withGlobalSyncBackpressure({
      policy, ctx: createOperationContext('sync'), label: 'blocker', source: 'catchup-foreground',
    }, async () => { blockerEntered.release(); await releaseBlocker.promise; });
    await blockerEntered.promise;
    const harness = await createVmRecoveryHostHarness({
      name: 'SlotGlobalWait', localCgId, peers: ['12D3KooWSlotGlobalWait'], targetCount: 1,
      targetForOrdinal: ordinal => targetFor(localCgId, ordinal),
      onFetch: async (_peer, _targets, _recovered, signal) => {
        const admitted = withGlobalSyncBackpressure({
          policy, ctx: createOperationContext('sync'), label: 'exact-waiter',
          source: 'vm-recovery', contextGraphId: localCgId, signal,
        }, network);
        queued.release();
        await admitted;
        return 'clean-absent' as const;
      },
    });
    const host = harness.internals as CancellationHost;
    host.subscribedContextGraphs.set(localCgId, { subscribed: true, synced: false, syncMode: 'always-on', onChainId: '1' });
    const recovery = harness.run();
    try {
      await queued.promise;
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 1 });
      harness.agent.unsubscribeFromContextGraph(localCgId, { persist: false });
      await expect(recovery).resolves.toMatchObject({ outcomes: new Map(), attemptedOrdinals: [] });
      expect(network).not.toHaveBeenCalled();
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 1, queued: 0 });
    } finally {
      releaseBlocker.release();
      await Promise.all([blocker, recovery]);
      await harness.agent.stop().catch(() => undefined);
    }
    expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 0, queued: 0 });
  });

  it('cancels an admitted transfer and retires its retained proof record', async () => {
    const localCgId = '0x0000000000000000000000000000000000000001/unowned';
    const entered = barrier();
    const release = barrier();
    let receivedSignal: AbortSignal | undefined;
    const harness = await createVmRecoveryHostHarness({
      name: 'SlotUnownedFallback', localCgId, peers: ['12D3KooWSlotUnowned'], targetCount: 1,
      targetForOrdinal: ordinal => targetFor(localCgId, ordinal),
      onFetch: async (_peer, _targets, _recovered, signal) => {
        receivedSignal = signal;
        signal?.addEventListener('abort', release.release, { once: true });
        entered.release();
        try { await release.promise; } finally { signal?.removeEventListener('abort', release.release); }
        return 'clean-absent' as const;
      },
    });
    const host = harness.internals as CancellationHost;
    host.subscribedContextGraphs.set(localCgId, { subscribed: true, synced: false, syncMode: 'always-on', onChainId: '1' });
    const recovery = harness.run();
    try {
      await entered.promise;
      expect(host.vmRecoverySlots.snapshot().size).toBe(1);
      harness.agent.unsubscribeFromContextGraph(localCgId, { persist: false });
      expect(receivedSignal?.aborted).toBe(true);
      await expect(recovery).resolves.toMatchObject({ outcomes: new Map(), attemptedOrdinals: [] });
      expect(host.vmRecoverySlots.snapshot().size).toBe(0);
    } finally {
      release.release();
      await recovery;
      await harness.agent.stop().catch(() => undefined);
    }
  });

  it('does not accept a late reconcile result after its fingerprint is replaced', async () => {
    const localCgId = '0x0000000000000000000000000000000000000001/post-transport';
    const peer = '12D3KooWSlotPostTransport';
    const entered = barrier();
    const release = barrier();
    let current: (() => boolean) | undefined;
    const harness = await createVmRecoveryHostHarness({
      name: 'SlotPostTransport', localCgId, peers: [peer], targetCount: 1,
      targetForOrdinal: ordinal => targetFor(localCgId, ordinal), onFetch: () => 'clean-absent',
    });
    const host = harness.internals as CancellationHost;
    host.reconcileChainOrdinal = async (_cg, _chainCg, _ordinal, _head, options) => {
      current = options?.isTargetCurrent;
      entered.release();
      await release.promise;
      return { status: 'pending', recovery: harness.targets[0]! };
    };
    const recovery = harness.run();
    try {
      await entered.promise;
      expect(current?.()).toBe(true);
      const replacement = host.prepareVmReconcileRotationTarget(
        { ...harness.targets[0]!, merkleRoot: 'new-root' }, [peer], host.vmReconcileRotationNow(),
      ).record;
      expect(replacement).toBeDefined();
      expect(current?.()).toBe(false);
      release.release();
      await expect(recovery).resolves.toMatchObject({ outcomes: new Map(), attemptedOrdinals: [] });
      expect(host.vmRecoverySlots.snapshot().get(vmRecoverySlotKey(harness.targets[0]!))).toBe(replacement);
      expect(replacement?.phase).toBe('collecting');
      expect(replacement?.attemptedPeerIds.size).toBe(0);
      expect(replacement?.cleanAbsentPeerIds.size).toBe(0);
      expect(host.readVmReconcileActiveFetchCooldown(localCgId)).toBeUndefined();
    } finally {
      release.release();
      await recovery;
      await harness.agent.stop().catch(() => undefined);
    }
  });

  it('keeps companion assets immediately retryable after canceling a shared transfer', async () => {
    const localCgId = '0x0000000000000000000000000000000000000001/batch-companion';
    const peer = '12D3KooWSlotBatchCompanion';
    const entered = barrier();
    const release = barrier();
    let receivedSignal: AbortSignal | undefined;
    const harness = await createVmRecoveryHostHarness({
      name: 'SlotBatchCompanion', localCgId, peers: [peer], targetCount: 3,
      targetForOrdinal: ordinal => targetFor(localCgId, ordinal),
      onFetch: async (_peer, targets, recovered, signal) => {
        if (targets.length === 1) {
          recovered.add(targets[0]!.ordinal);
          return 'found';
        }
        receivedSignal = signal;
        signal?.addEventListener('abort', release.release, { once: true });
        entered.release();
        try { await release.promise; } finally { signal?.removeEventListener('abort', release.release); }
        return 'incomplete';
      },
    });
    const host = harness.internals as CancellationHost;
    const recovery = harness.run();
    try {
      await entered.promise;
      expect(harness.fetched.map(fetch => fetch.uals.length)).toEqual([1, 2]);
      const survivor = harness.targets[2]!;
      const record = host.vmRecoverySlots.snapshot().get(vmRecoverySlotKey(survivor));
      expect(record?.attemptedPeerIds.size).toBe(0);
      host.prepareVmReconcileRotationTarget(
        { ...harness.targets[1]!, merkleRoot: 'replacement-root' }, [peer], host.vmReconcileRotationNow(),
      );
      expect(receivedSignal?.aborted).toBe(true);
      await recovery;
      expect(record?.phase).toBe('collecting');
      expect(record?.attemptedPeerIds.size).toBe(0);
      expect(record?.cleanAbsentPeerIds.size).toBe(0);
      expect(host.readVmReconcileActiveFetchCooldown(localCgId)).toBeUndefined();
      const retry = await host.recoverVmReconcileBatch(localCgId, 1n, [survivor], 100, () => true);
      expect(retry.outcomes.get(survivor.ordinal)).toEqual({ status: 'reconciled', blockNumber: 100 });
      expect(harness.fetched.at(-1)?.uals).toEqual([survivor.ual]);
    } finally {
      release.release();
      await recovery;
      await harness.agent.stop().catch(() => undefined);
    }
  });

  it.each((['protocol', 'admission'] as const).flatMap(stage =>
    [new Error('transport failed'), new DOMException('independent operation aborted', 'AbortError')]
      .map(error => ({ stage, error })),
  ))('preserves a live recovery failure from $stage: $error.name', async ({ stage, error }) => {
    const localCgId = `0x0000000000000000000000000000000000000001/live-error-${stage}`;
    const harness = await createVmRecoveryHostHarness({
      name: `LiveBoundaryError-${stage}`, localCgId, peers: ['12D3KooWLiveBoundaryError'], targetCount: 1,
      targetForOrdinal: ordinal => targetFor(localCgId, ordinal), onFetch: () => 'clean-absent',
    });
    const host = harness.internals as CancellationHost;
    const reject = async () => { throw error; };
    if (stage === 'protocol') host.waitForSyncProtocol = reject;
    else host.ensurePeerAdmittedForRecovery = reject;
    try {
      await expect(harness.run()).rejects.toBe(error);
      expect(host.vmReconcileLifecycleController.signal.aborted).toBe(false);
      expect(harness.fetched).toHaveLength(0);
    } finally { await harness.agent.stop().catch(() => undefined); }
  });

  it.each(cases)('$invalidation cancels a pending $stage boundary and releases its capacity', async ({ stage, invalidation }) => {
    const localCgId = `0x0000000000000000000000000000000000000001/${stage}-${invalidation}`;
    const peer = '12D3KooWSlotCancellationPeer';
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 });
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    let releaseWait!: () => void;
    const paused = new Promise<void>(resolve => { releaseWait = resolve; });
    let boundarySignal: AbortSignal | undefined;
    const wait = async (signal?: AbortSignal) => {
      boundarySignal = signal;
      signal?.addEventListener('abort', releaseWait, { once: true });
      markEntered();
      try {
        if (!signal?.aborted) await paused;
      } finally {
        signal?.removeEventListener('abort', releaseWait);
      }
    };
    const harness = await createVmRecoveryHostHarness({
      name: `SlotCancellation-${stage}-${invalidation}`,
      localCgId, peers: [peer], targetCount: 1,
      targetForOrdinal: ordinal => targetFor(localCgId, ordinal),
      onFetch: async (_peer, _targets, _recovered, signal) => {
        if (stage === 'transport') {
          await withGlobalSyncBackpressure({
            policy, ctx: createOperationContext('sync'), label: 'slot-cancellation',
            contextGraphId: localCgId, source: 'vm-recovery', signal,
          }, () => wait(signal));
        }
        return 'clean-absent' as const;
      },
    });
    const host = harness.internals as CancellationHost;
    const subscription: ContextGraphSub = { subscribed: true, synced: false, syncMode: 'always-on', onChainId: '1' };
    host.subscribedContextGraphs.set(localCgId, subscription);
    if (stage === 'discovery') {
      host.prepareVmReconcileRotationTarget(harness.targets[0]!, [peer], host.vmReconcileRotationNow());
      host.resolveCuratorPeerIdsForCg = async (_cg, options) => {
        await wait(options?.signal);
        return { peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false };
      };
    }
    if (stage === 'legacy-meta' || stage === 'legacy-registry') {
      host.prepareVmReconcileRotationTarget(harness.targets[0]!, [peer], host.vmReconcileRotationNow());
      host.resolveCuratorPeerIdsForCg = async () => ({
        peerIds: [], curatorIsLocal: false, legacyTripleResolved: false,
      });
      const meta = await harness.agent.getCgMeta(localCgId);
      let firstMetaRead = true;
      vi.spyOn(harness.agent, 'getCgMeta').mockImplementation(async (_cg, options) => {
        if (stage === 'legacy-meta') {
          // Unsubscribe/rebind may independently reconcile host metadata.
          // Pause only the recovery's first read, whose signal we are testing.
          if (!firstMetaRead) return meta;
          firstMetaRead = false;
          await wait(options?.signal);
          options?.signal?.throwIfAborted();
          return meta;
        }
        return { ...meta, curator: 'did:dkg:agent:0x0000000000000000000000000000000000000001', creators: [] };
      });
      if (stage === 'legacy-registry') {
        vi.spyOn(harness.agent.discovery, 'findAgents').mockImplementation(async options => {
          await wait(options?.signal);
          options?.signal?.throwIfAborted();
          return [];
        });
      }
    }
    if (stage === 'dial') {
      host.node.libp2p.getConnections = () => [];
      host.ensurePeerConnected = async (_peer, options) => {
        await wait(options?.signal);
        options?.signal?.throwIfAborted();
      };
    }
    if (stage === 'protocol') host.waitForSyncProtocol = async (remotePeer, signal) => {
      boundarySignal = signal;
      // Exercise the production readiness wait, including its throwing abort
      // path while waiting for identify to advertise the required protocol.
      return waitForPeerProtocol({
        get: async () => {
          markEntered();
          return { protocols: [] };
        },
      }, remotePeer, '/dkg/test/exact-sync', 2, 60_000, signal);
    };
    if (stage === 'admission') host.ensurePeerAdmittedForRecovery = async (_peer, _ctx, _operation, signal) => {
      await wait(signal);
      signal?.throwIfAborted();
      return true;
    };
    const reconcile = vi.spyOn(host, 'reconcileChainOrdinal');
    const protocol = vi.spyOn(host, 'waitForSyncProtocol');
    const recovery = host.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
      host.vmReconcileLifecycleController.signal,
    );
    let restoreCapacity = () => {};
    try {
      await entered;
      const target = harness.targets[0]!;
      const slotKey = vmRecoverySlotKey(target);
      const originalRecord = host.vmRecoverySlots.snapshot().get(slotKey);
      expect(originalRecord).toBeDefined();
      if (stage === 'transport') expect(getSyncBackpressureSnapshot(policy).inflight).toBe(1);
      else expect(harness.fetched).toHaveLength(0);
      restoreCapacity = applyVmRecoveryInvalidation({
        invalidation, agent: harness.agent, host, localCgId, target, peerId: peer,
      });
      expect(host.vmRecoverySlots.snapshot().get(slotKey)).not.toBe(originalRecord);
      expect(boundarySignal?.aborted).toBe(true);
      await expect(recovery).resolves.toMatchObject({ outcomes: new Map(), attemptedOrdinals: [] });
      expect(reconcile).not.toHaveBeenCalled();
      if (stage === 'dial' || stage.startsWith('legacy-')) expect(protocol).not.toHaveBeenCalled();
      expect(host.readVmReconcileActiveFetchCooldown(localCgId)).toBeUndefined();
      expect(getSyncBackpressureSnapshot(policy)).toMatchObject({ inflight: 0, queued: 0 });
      if (stage !== 'transport') expect(harness.fetched).toHaveLength(0);
    } finally {
      releaseWait();
      host.vmReconcileLifecycleController.abort();
      await recovery.catch(() => undefined);
      restoreCapacity();
      await harness.agent.stop().catch(() => undefined);
    }
  });
});
