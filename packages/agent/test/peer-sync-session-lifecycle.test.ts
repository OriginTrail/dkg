import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { runSyncOnConnect, runSelectedSharedMemoryRetry, type SyncOnConnectContext } from '../src/sync/on-connect/sync-on-connect.js';
import { createPeerEventFixture, deferred, flushMicrotasks } from './_helpers/peer-event-lifecycle.js';

const PROBE = { protocolsKey: null, connectionKey: null } satisfies Awaited<ReturnType<DKGAgent['getSyncReconcilerProbe']>>;

describe('peer sync session lifecycle', () => {
  it.each([
    { phase: 'durable', reject: false }, { phase: 'durable', reject: true },
    { phase: 'discovered', reject: false }, { phase: 'discovered', reject: true },
    { phase: 'ordinary', reject: false }, { phase: 'ordinary', reject: true },
    { phase: 'selected', reject: false }, { phase: 'selected', reject: true },
  ] as const)('fences real $phase transfer continuations (reject=$reject)', async ({ phase, reject }) => {
    const controller = new AbortController();
    const gate = deferred<number>();
    const entered = deferred<void>();
    const syncingPeers = new Set<string>();
    const transfer = async () => { entered.resolve(); return gate.promise; };
    let discovered = false;
    const sync = vi.fn(async (_peer: string, cgs?: string[]) => {
      if (phase === 'durable' || (phase === 'discovered' && cgs?.includes('new'))) return transfer();
      return 1;
    });
    const refresh = vi.fn(async () => {});
    const discover = vi.fn(async () => { discovered = true; return 1; });
    const ordinary = vi.fn(transfer);
    const log = vi.fn();
    const account = vi.fn();
    const context: SyncOnConnectContext = {
      signal: controller.signal, remotePeer: 'peer', syncingPeers,
      getPeerProtocols: async () => [PROTOCOL_SYNC], knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => phase === 'discovered' && discovered ? ['initial', 'new'] : ['initial'],
      getDurableSyncContextGraphs: () => ['initial'], syncFromPeer: sync,
      refreshMetaSyncedFlags: refresh, discoverContextGraphsFromStore: discover,
      ordinarySharedMemoryLane: { resolveWork: () => ({ contextGraphIds: ['ordinary'], syncFromPeer: ordinary }) },
      logInfo: log, onSyncAccounting: account,
    };
    const attempt = phase === 'selected' ? runSelectedSharedMemoryRetry({
      signal: controller.signal, remotePeer: 'peer', syncingPeers,
      getPeerProtocols: context.getPeerProtocols, logInfo: log, onSyncAccounting: account,
      selectedSharedMemoryLane: { admitWork: () => ({
        contextGraphIds: ['selected'],
        syncFromPeer: async () => ({
          kind: 'selected-shared-memory',
          requestedScope: { kind: 'selected-public', targets: [{ contextGraphId: 'selected', lane: 'selected-public' }] },
          scopeComplete: true, selectedScopeComplete: true,
          targetDiagnostics: { selectedPublic: { completed: 1, total: 1 }, ordinaryPrivate: { completed: 0, total: 0 } },
          shared: {
            insertedTriples: await transfer(), fetchedMetaTriples: 0, fetchedDataTriples: 1,
            insertedMetaTriples: 0, insertedDataTriples: 1, bytesReceived: 1,
            resumedPhases: 0, timedOutPhases: 0, completedPhases: 1, checkpointAdvances: 0,
            emptyResponses: 0, droppedDataTriples: 0, failedPeers: 0, failedPhases: 0,
            deniedPhases: 0, backoffWorthyFailures: 0, deferredBackpressure: 0,
          },
        }),
      }) },
    }) : runSyncOnConnect(context);
    const settled = attempt.then(() => undefined, (error: unknown) => error);
    await entered.promise;
    expect(syncingPeers.has('peer')).toBe(true);
    controller.abort();
    for (const callback of [sync, refresh, discover, ordinary, log, account]) callback.mockClear();
    if (reject) gate.reject(new Error('retired transfer failed'));
    else gate.resolve(1);
    expect(await settled).toBeInstanceOf(Error);
    for (const callback of [sync, refresh, discover, ordinary, log, account]) expect(callback).not.toHaveBeenCalled();
    expect(syncingPeers.size).toBe(0);
  });

  it('keeps active-peer ownership separate when old work settles after a new lifetime starts', async () => {
    const f = await createPeerEventFixture();
    const oldGate = deferred<string[]>();
    const newGate = deferred<string[]>();
    try {
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      const protocols = vi.spyOn(f.agent, 'getPeerProtocols')
        .mockReturnValueOnce(oldGate.promise).mockReturnValueOnce(newGate.promise);
      const oldAttempt = f.agent.trySyncFromPeer(f.peerId).catch(() => undefined);
      await f.agent.stop();
      await f.agent.start();
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      const newAttempt = f.agent.trySyncFromPeer(f.peerId);
      expect(protocols).toHaveBeenCalledTimes(2);
      oldGate.resolve([]);
      await oldAttempt;
      await expect(f.agent.trySyncFromPeer(f.peerId)).resolves.toBe('already-syncing');
      expect(protocols).toHaveBeenCalledTimes(2);
      newGate.resolve([]);
      await expect(newAttempt).resolves.toBe('skipped-no-sync');
    } finally { oldGate.resolve([]); newGate.resolve([]); await f.close(); }
  });

  it('cancels queued catch-up synchronously before slow shutdown and permits a new queue after restart', async () => {
    const f = await createPeerEventFixture();
    const gate = deferred<void>();
    try {
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      vi.spyOn(f.agent, 'getSyncReconcilerProbe').mockResolvedValue(PROBE);
      const attempt = vi.spyOn(f.agent, 'trySyncFromPeer').mockResolvedValue('synced');
      vi.spyOn(f.agent, 'drainCoreHostRecordings').mockReturnValueOnce(gate.promise);
      expect(f.agent.queueSyncFromPeerOnConnect(f.peerId, () => {}, 10)).toBe(true);
      const stopping = f.agent.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(attempt).not.toHaveBeenCalled();
      gate.resolve();
      await stopping;
      await f.agent.start();
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      expect(f.agent.queueSyncFromPeerOnConnect(f.peerId, () => {}, 0)).toBe(true);
      await vi.waitFor(() => expect(attempt).toHaveBeenCalledOnce());
    } finally { gate.resolve(); await f.close(); }
  });

  it('retires connection-close bookkeeping synchronously before slow shutdown', async () => {
    const f = await createPeerEventFixture();
    const gate = deferred<void>();
    let now = 1_000;
    try {
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      f.dispatchClose();
      expect(f.state.disconnectTimestamp(f.peerId)).toBe(1_000);

      vi.spyOn(f.agent, 'drainCoreHostRecordings').mockReturnValueOnce(gate.promise);
      now = 2_000;
      const stopping = f.agent.stop();
      expect(f.state.session.isActive()).toBe(false);

      f.dispatchClose();
      expect(f.state.disconnectTimestamp(f.peerId)).toBe(1_000);

      gate.resolve();
      await stopping;
    } finally {
      gate.resolve();
      await f.close();
    }
  });

  it.each([
    { entry: 'scheduler', disposition: 'clear' },
    { entry: 'scheduler', disposition: 'retry' },
    { entry: 'peer-update', disposition: 'clear' },
    { entry: 'peer-update', disposition: 'retry' },
  ] as const)('discards late $entry $disposition accounting across node lifetimes', async ({ entry, disposition }) => {
    const f = await createPeerEventFixture();
    const gate = deferred<void>();
    const entered = deferred<void>();
    try {
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      vi.spyOn(f.agent, 'getSyncReconcilerProbe').mockResolvedValue(PROBE);
      const attempt = vi.spyOn(f.agent, 'trySyncFromPeer').mockImplementationOnce(async (_peer, account) => {
        entered.resolve();
        await gate.promise;
        account?.(disposition === 'clear'
          ? { fresh: true, progress: true, reconcilerDisposition: 'clear' }
          : { fresh: false, progress: true, reconcilerDisposition: 'retry' });
        return 'synced';
      }).mockResolvedValue('synced');
      vi.spyOn(f.agent, 'isPeerConnectedForSyncBackoff').mockReturnValue(true);
      if (entry === 'scheduler') f.agent.queueSyncFromPeerOnConnect(f.peerId, () => {}, 0);
      else { f.state.session.markSkipped(f.peerId); f.dispatchUpdate(); }
      await entered.promise;
      await f.agent.stop();
      await f.agent.start();
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      gate.resolve();
      await flushMicrotasks();
      expect(f.state.session.snapshot(f.peerId)).toMatchObject({
        lastSuccessfulSync: undefined,
        lastSyncProgress: undefined,
        backoff: undefined,
      });
      expect(f.agent.queueSyncFromPeerOnConnect(f.peerId, () => {}, 0)).toBe(true);
      await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(2));
    } finally { gate.resolve(); await f.close(); }
  });

  it('does not mark a peer skipped when an old protocol lookup settles after restart', async () => {
    const f = await createPeerEventFixture();
    const gate = deferred<string[]>();
    try {
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      const protocols = vi.spyOn(f.agent, 'getPeerProtocols').mockReturnValueOnce(gate.promise);
      const oldAttempt = f.agent.trySyncFromPeer(f.peerId).catch(() => undefined);
      expect(protocols).toHaveBeenCalledOnce();
      await f.agent.stop();
      await f.agent.start();
      gate.resolve([]);
      await oldAttempt;
      expect(f.state.session.snapshot(f.peerId)).toMatchObject({
        skippedNoSync: false,
        lastSyncProgress: undefined,
      });
    } finally { gate.resolve([]); await f.close(); }
  });

  it('clears freshness and cooldown state for a peer absent from the stop-time connection list', async () => {
    const f = await createPeerEventFixture();
    try {
      const now = Date.now();
      f.state.session.recordFreshness(f.peerId, {
        successfulAt: now,
        progressAt: now,
      });
      f.state.session.recordQueued(f.peerId, now);
      f.state.session.recordBackoff(
        f.peerId,
        { failures: 1, nextRetryAt: now + 60_000, ...PROBE },
      );
      expect(f.agent.node.libp2p.getPeers()).not.toContainEqual(f.peer);
      await f.agent.stop();
      expect(f.state.session.snapshot(f.peerId)).toMatchObject({
        lastSuccessfulSync: undefined,
        lastSyncProgress: undefined,
        lastQueued: 0,
        backoff: undefined,
      });
      expect(f.state.disconnectTimestamp(f.peerId)).toBeUndefined();
      await f.agent.start();
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      expect(f.agent.queueSyncFromPeerOnConnect(f.peerId, () => {}, 60_000)).toBe(true);
    } finally { await f.close(); }
  });

});
