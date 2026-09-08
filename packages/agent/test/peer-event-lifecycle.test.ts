import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerEventLifetime } from '../src/p2p/peer-event-lifetime.js';
import { PeerSyncSession } from '../src/sync/peer-sync-session.js';
import { syncOpenedPeerConnection } from '../src/sync/peer-connection.js';
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext, PROTOCOL_SYNC, PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { NetworkAdmissionCoordinator } from '../src/p2p/network-admission-coordinator.js';
import { runSyncOnConnect, runSelectedSharedMemoryRetry, type SyncOnConnectContext } from '../src/sync/on-connect/sync-on-connect.js';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { asSyncOnConnectTestAgent, allowAllNetworkAdmission } from './_helpers/sync-on-connect-test-fixture.js';
import { createPeerEventFixture, deferred, flushMicrotasks } from './_helpers/peer-event-lifecycle.js';

const PROBE = { protocolsKey: null, connectionKey: null } satisfies Awaited<ReturnType<DKGAgent['getSyncReconcilerProbe']>>;

describe('peer-event lifecycle', () => {
  it('surfaces live supervised errors and prevents work admitted after retirement', async () => {
    const lifetime = new PeerEventLifetime();
    const failure = new Error('live task failed');
    await expect(lifetime.run(async () => { throw failure; })).rejects.toBe(failure);
    lifetime.close();
    const release = vi.fn();
    const unregister = lifetime.onClose(release);
    expect(release).toHaveBeenCalledOnce();
    unregister();
    const work = vi.fn(async () => {});
    await lifetime.run(work);
    const commit = vi.fn(() => {});
    lifetime.commit(commit);
    expect(commit).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it.each([new Error('queued sync failure'), 'queued sync failure'])('uses active configured replay authority and fences queued errors: %s', async (failure) => {
    const f = await createPeerEventFixture();
    const session = new PeerSyncSession();
    try {
      vi.spyOn(f.agent, 'readRfc64CatalogResponsibilitiesV1').mockReturnValue([]);
      vi.spyOn(f.agent, 'resolveRfc64CatalogReceiverAuthorityV1').mockImplementation((contextGraphId) => {
        const common = { contextGraphId, selected: false, eligible: false, killSwitchActive: false } as const;
        if (contextGraphId === 'legacy') return { ...common, active: true, mode: 'legacy', reconciliationLane: 'legacy', legacySyncAllowed: true, track2Enabled: false, authoringAllowed: false };
        if (contextGraphId === 'inactive') return { ...common, active: false, mode: 'catalog', reconciliationLane: 'disabled', legacySyncAllowed: true, track2Enabled: false, authoringAllowed: false };
        return { ...common, active: true, mode: 'catalog', reconciliationLane: 'catalog-apply', legacySyncAllowed: true, track2Enabled: true, authoringAllowed: true };
      });
      const admission = vi.spyOn(f.agent.networkAdmissionCoordinator, 'ensureAdmitted').mockResolvedValue(true);
      vi.spyOn(f.agent, 'enrichPeerStoreFromInboundCircuit').mockResolvedValue();
      vi.spyOn(f.agent, 'drainPendingSenderKeyForPeer').mockResolvedValue(0);
      vi.spyOn(f.agent, 'reannounceRfc64CatalogHeadsToPeerV1').mockResolvedValue({ announced: 0, failed: 0, manifest: [] });
      const replay = vi.spyOn(f.agent, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1').mockResolvedValue({ requested: 1, failed: 0 });
      let reportError!: Parameters<DKGAgent['queueSyncFromPeerOnConnect']>[1];
      vi.spyOn(f.agent, 'queueSyncFromPeerOnConnect').mockImplementation((_peer, onError) => { reportError = onError; return true; });
      const log = { info: vi.fn(), warn: vi.fn() };
      const context = { agent: f.agent, session, ctx: createOperationContext('sync'), log, authorityContextGraphIds: ['active', 'inactive', 'legacy'] };
      await syncOpenedPeerConnection(context, { direction: 'inbound', remotePeer: f.agent.node.libp2p.peerId });
      expect(admission).not.toHaveBeenCalled();
      await syncOpenedPeerConnection(context, { direction: 'inbound', remotePeer: f.peer });
      expect(replay).toHaveBeenCalledExactlyOnceWith('active');
      reportError(f.peerId, failure);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(context.ctx, expect.stringContaining('queued sync failure'));
      log.warn.mockClear();
      session.close();
      reportError(f.peerId, failure);
      expect(log.warn).not.toHaveBeenCalled();
    } finally { session.close(); await f.close(); }
  });

  it('accepts bootstrap-authorized recovery before listener registration with ordinary sync and retries disabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-early-bootstrap-session-'));
    const agent = await DKGAgent.create({
      name: 'EarlyBootstrapPeerSession',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      dataDir,
      syncOnConnectEnabled: false,
      syncReconcilerEnabled: false,
      rfc64PublicCatalogBootstrap: { retryIntervalMs: 0, acceptedPublicPolicies: [] },
    });
    const internal = asSyncOnConnectTestAgent(agent);
    const plan = {
      kind: 'rfc64-authorized-swm-recovery-v1' as const,
      providerPeerId: '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M',
      targets: [{ contextGraphId: 'selected-cg', lane: 'selected-public' as const }],
    };
    const selected = vi.spyOn(agent, 'trySelectedSwmRetryFromPeer').mockResolvedValue('not-started');
    const ordinary = vi.spyOn(agent, 'trySyncFromPeer').mockResolvedValue('not-started');
    vi.spyOn(agent, 'getSyncReconcilerProbe').mockResolvedValue(PROBE);
    const errors = vi.fn();
    let admitted: boolean | undefined;
    let producerSession: PeerSyncSession | undefined;
    vi.spyOn(agent, 'startRfc64CatalogRuntimeV1').mockImplementation(() => {
      // A fast catalog bootstrap produces an already-authorized plan at this
      // real startup position, before the later connection listeners are installed.
      allowAllNetworkAdmission(internal);
      producerSession = internal.peerSyncSession;
      admitted = agent.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(plan, errors, 0);
    });
    try {
      await agent.start();
      expect(admitted).toBe(true);
      expect(internal.peerSyncSession).toBe(producerSession);
      await vi.waitFor(() => expect(selected).toHaveBeenCalledExactlyOnceWith(
        plan.providerPeerId, expect.any(Function), 'on-connect', plan,
      ));
      expect(ordinary).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await agent.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects direct scheduler admission while stopped and opens a fresh scheduler at restart', async () => {
    const f = await createPeerEventFixture();
    try {
      await f.agent.stop();
      const closed = f.agent.getSyncOnConnectPeerScheduler();
      expect(closed.enqueueOrdinary(f.peerId, () => {}, 0)).toBe(false);
      expect(f.agent.queueSyncFromPeerOnConnect(f.peerId, () => {}, 0)).toBe(false);
      await f.agent.start();
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      expect(f.agent.getSyncOnConnectPeerScheduler()).not.toBe(closed);
      expect(f.agent.queueSyncFromPeerOnConnect(f.peerId, () => {}, 60_000)).toBe(true);
    } finally { await f.close(); }
  });

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

  it.each(['live', 'late success', 'late failure'] as const)('owns already-connected startup admission: %s', async (outcome) => {
    const f = await createPeerEventFixture();
    const gate = deferred<boolean>();
    try {
      await f.agent.stop();
      const startNode = f.agent.node.start.bind(f.agent.node);
      let startupPeerPresent = true;
      vi.spyOn(f.agent.node, 'start').mockImplementation(async (...args) => {
        await startNode(...args);
        if (startupPeerPresent) vi.spyOn(f.agent.node.libp2p, 'getPeers').mockReturnValue([f.peer]);
      });
      const admission = vi.spyOn(NetworkAdmissionCoordinator.prototype, 'ensureAdmitted').mockReturnValue(gate.promise);
      const queue = vi.spyOn(f.agent, 'queueSyncFromPeerOnConnect').mockReturnValue(true);
      const warn = vi.spyOn(f.state.log, 'warn').mockImplementation(() => {});
      await f.agent.start();
      expect(admission).toHaveBeenCalledOnce();
      if (outcome !== 'live') {
        startupPeerPresent = false;
        vi.spyOn(f.agent.node.libp2p, 'getPeers').mockReturnValue([]);
        await f.agent.stop();
        await f.agent.start();
      }
      queue.mockClear(); warn.mockClear();
      if (outcome === 'late failure') gate.reject(new Error('old startup admission failure'));
      else gate.resolve(true);
      await flushMicrotasks();
      if (outcome === 'live') expect(queue).toHaveBeenCalledExactlyOnceWith(f.peerId, expect.any(Function));
      else expect(queue).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(f.state.catchupOnConnectAt.has(f.peerId)).toBe(false);
      expect(admission).toHaveBeenCalledWith(f.peerId, expect.anything(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    } finally { gate.resolve(false); await f.close(); }
  });

  it.each([
    { phase: 'probe', reject: false }, { phase: 'probe', reject: true },
    { phase: 'admission', reject: false }, { phase: 'admission', reject: true },
  ] as const)('retires periodic reconciliation at $phase (reject=$reject)', async ({ phase, reject }) => {
    const f = await createPeerEventFixture();
    const probeGate = deferred<typeof PROBE>();
    const admissionGate = deferred<boolean>();
    try {
      const peers = vi.spyOn(f.agent.node.libp2p, 'getPeers').mockReturnValue([f.peer]);
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(false);
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isRejectedPeer').mockReturnValue(false);
      const probe = vi.spyOn(f.agent, 'getSyncReconcilerProbe')
        .mockImplementation(() => phase === 'probe' ? probeGate.promise : Promise.resolve(PROBE));
      const admission = vi.spyOn(f.agent.networkAdmissionCoordinator, 'ensureAdmitted').mockReturnValue(admissionGate.promise);
      const attempt = vi.spyOn(f.agent, 'attemptSyncFromPeerWithReconcilerAccounting').mockResolvedValue('not-started');
      const warn = vi.spyOn(f.state.log, 'warn').mockImplementation(() => {});
      const pass = f.agent.reconcileSyncFromConnectedPeers();
      // Observe a rejection immediately even when the old implementation leaks it.
      const settled = pass.then(() => undefined, (error: unknown) => error);
      await vi.waitFor(() => expect(phase === 'probe' ? probe : admission).toHaveBeenCalledOnce());
      peers.mockReturnValue([]);
      await f.agent.stop();
      await f.agent.start();
      const marker = { failures: 3, nextRetryAt: Date.now() + 60_000, ...PROBE };
      f.state.syncReconcilerBackoff.set(f.peerId, marker);
      const write = vi.spyOn(f.state.syncReconcilerBackoff, 'set');
      const remove = vi.spyOn(f.state.syncReconcilerBackoff, 'delete');
      warn.mockClear();
      if (phase === 'probe') {
        if (reject) probeGate.reject(new Error('old reconciler probe failure'));
        else probeGate.resolve(PROBE);
      } else if (reject) admissionGate.reject(new Error('old reconciler admission failure'));
      else admissionGate.resolve(true);
      expect(await settled).toBeUndefined();
      expect(attempt).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(f.state.syncReconcilerBackoff.get(f.peerId)).toBe(marker);
      expect(f.state.lastSuccessfulSyncAt.has(f.peerId)).toBe(false);
      expect(f.state.lastSyncProgressAt.has(f.peerId)).toBe(false);
    } finally { probeGate.resolve(PROBE); admissionGate.resolve(false); await f.close(); }
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
      else { f.state.skippedNoSyncPeers.add(f.peerId); f.dispatchUpdate(); }
      await entered.promise;
      await f.agent.stop();
      await f.agent.start();
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      gate.resolve();
      await flushMicrotasks();
      expect(f.state.lastSuccessfulSyncAt.has(f.peerId)).toBe(false);
      expect(f.state.lastSyncProgressAt.has(f.peerId)).toBe(false);
      expect(f.state.syncReconcilerBackoff.has(f.peerId)).toBe(false);
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
      expect(f.state.skippedNoSyncPeers.has(f.peerId)).toBe(false);
      expect(f.state.lastSyncProgressAt.has(f.peerId)).toBe(false);
    } finally { gate.resolve([]); await f.close(); }
  });

  it('clears freshness and cooldown state for a peer absent from the stop-time connection list', async () => {
    const f = await createPeerEventFixture();
    try {
      const now = Date.now();
      f.state.lastSuccessfulSyncAt.set(f.peerId, now);
      f.state.lastSyncProgressAt.set(f.peerId, now);
      f.state.catchupOnConnectAt.set(f.peerId, now);
      f.state.syncReconcilerBackoff.set(f.peerId, { failures: 1, nextRetryAt: now + 60_000, ...PROBE });
      expect(f.agent.node.libp2p.getPeers()).not.toContainEqual(f.peer);
      await f.agent.stop();
      expect(f.state.lastSuccessfulSyncAt.has(f.peerId)).toBe(false);
      expect(f.state.lastSyncProgressAt.has(f.peerId)).toBe(false);
      expect(f.state.catchupOnConnectAt.has(f.peerId)).toBe(false);
      expect(f.state.syncReconcilerBackoff.has(f.peerId)).toBe(false);
      expect(f.state.lastSyncDisconnectedAt.has(f.peerId)).toBe(false);
      await f.agent.start();
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      expect(f.agent.queueSyncFromPeerOnConnect(f.peerId, () => {}, 60_000)).toBe(true);
    } finally { await f.close(); }
  });

  it.each(['denied', 'failed'] as const)('clears pending replay when connection admission is %s', async (outcome) => {
    const f = await createPeerEventFixture();
    try {
      vi.spyOn(f.agent, 'readRfc64CatalogResponsibilitiesV1').mockReturnValue([{
        contextGraphId: 'connection-catalog', responsible: true, active: true, mode: 'catalog',
        responsibilityReason: 'private-membership', selectionSource: 'default',
      }]);
      const admission = vi.spyOn(f.agent.networkAdmissionCoordinator, 'ensureAdmitted');
      if (outcome === 'denied') admission.mockResolvedValue(false);
      else admission.mockRejectedValue(new Error('admission unavailable'));
      const markPending = vi.spyOn(f.agent, 'markRfc64CatalogReplayPeerPendingV1');
      const clearPending = vi.spyOn(f.agent, 'clearRfc64CatalogReplayPeerPendingV1');
      const enrich = vi.spyOn(f.agent, 'enrichPeerStoreFromInboundCircuit');
      const queue = vi.spyOn(f.agent, 'queueSyncFromPeerOnConnect');
      const warn = vi.spyOn(f.state.log, 'warn').mockImplementation(() => {});
      f.dispatchOpen();
      await vi.waitFor(() => expect(clearPending).toHaveBeenCalledWith('connection-catalog', f.peerId));
      expect(markPending).toHaveBeenCalledWith('connection-catalog', f.peerId);
      expect(enrich).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
      if (outcome === 'failed') expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('admission unavailable'));
    } finally { await f.close(); }
  });

  it.each(['enrichment', 'sender-key', 'reannouncement', 'replay incomplete'] as const)('continues catch-up after a best-effort %s failure', async (stage) => {
    const f = await createPeerEventFixture();
    try {
      vi.spyOn(f.agent, 'readRfc64CatalogResponsibilitiesV1').mockReturnValue([{
        contextGraphId: 'connection-catalog', responsible: true, active: true, mode: 'catalog',
        responsibilityReason: 'private-membership', selectionSource: 'default',
      }]);
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'ensureAdmitted').mockResolvedValue(true);
      const enrich = vi.spyOn(f.agent, 'enrichPeerStoreFromInboundCircuit').mockResolvedValue();
      const drain = vi.spyOn(f.agent, 'drainPendingSenderKeyForPeer').mockResolvedValue(2);
      if (stage === 'enrichment') enrich.mockRejectedValue(new Error('enrichment unavailable'));
      else if (stage === 'sender-key') drain.mockRejectedValue(new Error('sender-key unavailable'));
      const reannounce = vi.spyOn(f.agent, 'reannounceRfc64CatalogHeadsToPeerV1').mockResolvedValue({ announced: 0, failed: 0, manifest: [] });
      if (stage === 'reannouncement') reannounce.mockRejectedValue(new Error('reannouncement unavailable'));
      const replay = vi.spyOn(f.agent, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
        .mockRejectedValue(new Error('replay unavailable'));
      if (stage === 'replay incomplete') replay.mockResolvedValue({ requested: 1, failed: 1 });
      const queue = vi.spyOn(f.agent, 'queueSyncFromPeerOnConnect').mockReturnValue(true);
      const warn = vi.spyOn(f.state.log, 'warn').mockImplementation(() => {});
      f.dispatchOpen();
      await vi.waitFor(() => expect(queue).toHaveBeenCalledWith(f.peerId, expect.any(Function)));
      await flushMicrotasks();
      expect(drain).toHaveBeenCalledWith(f.peerId, expect.anything());
      expect(reannounce).toHaveBeenCalledExactlyOnceWith(f.peerId);
      expect(replay).toHaveBeenCalledWith('connection-catalog');
      if (stage === 'replay incomplete') {
        expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('catalog replay incomplete'));
      } else {
        expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(`${stage} unavailable`));
        expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('replay unavailable'));
      }
    } finally { await f.close(); }
  });

  it.each(['reannouncement rejection', 'replay rejection', 'replay incomplete'] as const)(
    'ignores old terminal %s after shutdown and restart', async (stage) => {
      const f = await createPeerEventFixture();
      const announcementGate = deferred<Awaited<ReturnType<DKGAgent['reannounceRfc64CatalogHeadsToPeerV1']>>>();
      const replayGate = deferred<Awaited<ReturnType<DKGAgent['requestRfc64CatalogHeadReplaysFromConnectedPeersV1']>>>();
      try {
        vi.spyOn(f.agent, 'readRfc64CatalogResponsibilitiesV1').mockReturnValue([{
          contextGraphId: 'terminal-catalog', responsible: true, active: true, mode: 'catalog',
          responsibilityReason: 'private-membership', selectionSource: 'default',
        }]);
        vi.spyOn(f.agent.networkAdmissionCoordinator, 'ensureAdmitted').mockResolvedValue(true);
        vi.spyOn(f.agent, 'enrichPeerStoreFromInboundCircuit').mockResolvedValue();
        vi.spyOn(f.agent, 'drainPendingSenderKeyForPeer').mockResolvedValue(0);
        const markPending = vi.spyOn(f.agent, 'markRfc64CatalogReplayPeerPendingV1');
        const clearPending = vi.spyOn(f.agent, 'clearRfc64CatalogReplayPeerPendingV1');
        const reannounce = vi.spyOn(f.agent, 'reannounceRfc64CatalogHeadsToPeerV1')
          .mockReturnValue(announcementGate.promise);
        const replay = vi.spyOn(f.agent, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
          .mockReturnValue(replayGate.promise);
        const queue = vi.spyOn(f.agent, 'queueSyncFromPeerOnConnect').mockReturnValue(true);
        const warn = vi.spyOn(f.state.log, 'warn').mockImplementation(() => {});
        f.dispatchOpen();
        await vi.waitFor(() => expect(queue).toHaveBeenCalledOnce());
        expect(reannounce).toHaveBeenCalledExactlyOnceWith(f.peerId);
        expect(replay).toHaveBeenCalledExactlyOnceWith('terminal-catalog');
        expect(markPending).toHaveBeenCalledExactlyOnceWith('terminal-catalog', f.peerId);
        await f.agent.stop();
        expect(clearPending).toHaveBeenCalledExactlyOnceWith('terminal-catalog', f.peerId);
        await f.agent.start();
        // A new lifetime may already have acquired another pending-peer fence.
        f.agent.markRfc64CatalogReplayPeerPendingV1('terminal-catalog', f.peerId);
        clearPending.mockClear();
        warn.mockClear();
        queue.mockClear();
        if (stage === 'reannouncement rejection') announcementGate.reject(new Error('old announcement'));
        else announcementGate.resolve({ announced: 1, failed: 0, manifest: [] });
        if (stage === 'replay rejection') replayGate.reject(new Error('old replay'));
        else replayGate.resolve({ requested: 1, failed: 1 });
        await flushMicrotasks();
        expect(warn).not.toHaveBeenCalled();
        expect(queue).not.toHaveBeenCalled();
        expect(clearPending).not.toHaveBeenCalled();
        expect(replay).toHaveBeenCalledOnce();
        expect(reannounce).toHaveBeenCalledOnce();
      } finally {
        announcementGate.resolve({ announced: 0, failed: 0, manifest: [] });
        replayGate.resolve({ requested: 0, failed: 0 });
        await f.close();
      }
    },
  );

  it('records the offline boundary so a same-instance restart immediately queues catch-up', async () => {
    const f = await createPeerEventFixture();
    try {
      f.state.lastSuccessfulSyncAt.set(f.peerId, Date.now() - 1_000);
      f.state.lastSyncProgressAt.set(f.peerId, Date.now() - 750);
      f.state.catchupOnConnectAt.set(f.peerId, Date.now() - 500);
      const peers = vi.spyOn(f.agent.node.libp2p, 'getPeers').mockReturnValue([f.peer]);
      await f.agent.stop();
      expect(f.state.lastSuccessfulSyncAt.has(f.peerId)).toBe(false);
      expect(f.state.lastSyncProgressAt.has(f.peerId)).toBe(false);
      expect(f.state.catchupOnConnectAt.has(f.peerId)).toBe(false);
      peers.mockRestore();
      const disconnected = f.state.lastSyncDisconnectedAt.get(f.peerId);
      expect(disconnected).toBeTypeOf('number');
      await f.agent.start();
      // Stay within ordinary connection flap grace: a node lifetime is different.
      expect(Date.now() - disconnected!).toBeLessThan(15_000);
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(true);
      expect(f.agent.queueSyncFromPeerOnConnect(f.peerId, () => {}, 60_000)).toBe(true);
    } finally { await f.close(); }
  });

  it('retires peer-update admission synchronously when shutdown begins', async () => {
    const f = await createPeerEventFixture();
    try {
      const update = vi.spyOn(f.agent, 'handlePeerUpdateForSyncRetry');
      f.dispatchUpdate([PROTOCOL_STORAGE_ACK]);
      expect(update).toHaveBeenCalledOnce();
      expect(f.state.knownCorePeerIds.has(f.peerId)).toBe(true);
      update.mockClear().mockImplementation(() => {});
      const stopping = f.agent.stop();
      f.dispatchUpdate();
      await stopping;
      f.dispatchUpdate();
      expect(update).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each([
    { name: 'admission', gate: 'admission', reject: false },
    { name: 'admission abort', gate: 'admission', reject: true },
    { name: 'timer', gate: 'timer', reject: false },
    { name: 'probe', gate: 'probe', reject: false },
    { name: 'probe abort', gate: 'probe', reject: true },
  ] as const)('does not resume peer-update work after shutdown at $name', async (scenario) => {
    const f = await createPeerEventFixture();
    const admissionGate = deferred<boolean>();
    const probeGate = deferred<typeof PROBE>();
    try {
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isAcceptedPeer').mockReturnValue(false);
      vi.spyOn(f.agent.networkAdmissionCoordinator, 'isRejectedPeer').mockReturnValue(false);
      const admission = vi.spyOn(f.agent.networkAdmissionCoordinator, 'ensureAdmitted')
        .mockImplementation((_peer, _ctx, options) => {
          if (scenario.gate === 'admission' && scenario.reject) {
            options?.signal?.addEventListener('abort', () => admissionGate.reject(new Error('admission cancelled')), { once: true });
          }
          return scenario.gate === 'admission' ? admissionGate.promise : Promise.resolve(true);
        });
      const probe = vi.spyOn(f.agent, 'getSyncReconcilerProbe').mockReturnValue(probeGate.promise);
      const attempt = vi.spyOn(f.agent, 'attemptSyncFromPeerWithReconcilerAccounting').mockResolvedValue('not-started');
      f.state.skippedNoSyncPeers.add(f.peerId);
      const removeSkipped = vi.spyOn(f.state.skippedNoSyncPeers, 'delete');
      f.dispatchUpdate();
      await flushMicrotasks();
      expect(admission).toHaveBeenCalledOnce();
      if (scenario.gate === 'probe') await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
      removeSkipped.mockClear();
      const stopping = f.agent.stop();
      admissionGate.resolve(true);
      if (scenario.gate === 'probe' && scenario.reject) probeGate.reject(new Error('probe cancelled'));
      else probeGate.resolve(PROBE);
      await stopping;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
      expect(removeSkipped).not.toHaveBeenCalled();
      expect(attempt).not.toHaveBeenCalled();
      if (scenario.gate !== 'probe') expect(probe).not.toHaveBeenCalled();
      expect(admission.mock.calls[0][2]?.signal?.aborted).toBe(true);
    } finally {
      admissionGate.resolve(false);
      probeGate.resolve(PROBE);
      await f.close();
    }
  });

  it.each([
    { name: 'event', gate: 'event', reject: false },
    { name: 'admission', gate: 'admission', reject: false },
    { name: 'admission abort', gate: 'admission', reject: true },
    { name: 'enrichment', gate: 'enrichment', reject: false },
    { name: 'sender-key', gate: 'sender-key', reject: false },
  ] as const)('does not resume connection work after shutdown at $name', async (scenario) => {
    const f = await createPeerEventFixture();
    const admissionGate = deferred<void>();
    const enrichmentGate = deferred<void>();
    const senderKeyGate = deferred<void>();
    try {
      vi.spyOn(f.agent, 'readRfc64CatalogResponsibilitiesV1').mockReturnValue([{
        contextGraphId: 'shutdown-catalog', responsible: true, active: true, mode: 'catalog',
        responsibilityReason: 'private-membership', selectionSource: 'default',
      }]);
      const markPending = vi.spyOn(f.agent, 'markRfc64CatalogReplayPeerPendingV1');
      const clearPending = vi.spyOn(f.agent, 'clearRfc64CatalogReplayPeerPendingV1');
      const admission = vi.spyOn(f.agent.networkAdmissionCoordinator, 'ensureAdmitted').mockImplementation(async (_peer, _ctx, options) => {
        if (scenario.reject) {
          options?.signal?.addEventListener('abort', () => admissionGate.reject(new Error('admission cancelled')), { once: true });
        }
        if (scenario.gate === 'admission') await admissionGate.promise;
        return true;
      });
      const enrich = vi.spyOn(f.agent, 'enrichPeerStoreFromInboundCircuit').mockImplementation(async () => {
        if (scenario.gate === 'enrichment') await enrichmentGate.promise;
      });
      const drain = vi.spyOn(f.agent, 'drainPendingSenderKeyForPeer').mockImplementation(async () => {
        if (scenario.gate === 'sender-key') await senderKeyGate.promise;
        return 0;
      });
      const queue = vi.spyOn(f.agent, 'queueSyncFromPeerOnConnect').mockReturnValue(false);
      const reannounce = vi.spyOn(f.agent, 'reannounceRfc64CatalogHeadsToPeerV1').mockResolvedValue({ announced: 0, failed: 0, manifest: [] });
      const replay = vi.spyOn(f.agent, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1').mockResolvedValue({ requested: 0, failed: 0 });
      let stopping: Promise<void>;
      if (scenario.gate === 'event') {
        stopping = f.agent.stop();
        f.dispatchOpen();
      } else {
        f.dispatchOpen();
        await flushMicrotasks();
        expect(admission).toHaveBeenCalledOnce();
        if (scenario.gate === 'enrichment') expect(enrich).toHaveBeenCalledOnce();
        if (scenario.gate === 'sender-key') expect(drain).toHaveBeenCalledOnce();
        stopping = f.agent.stop();
      }
      await stopping;
      if (scenario.gate !== 'event') {
        expect(markPending).toHaveBeenCalledExactlyOnceWith('shutdown-catalog', f.peerId);
        expect(clearPending).toHaveBeenCalledExactlyOnceWith('shutdown-catalog', f.peerId);
      }
      admissionGate.resolve();
      enrichmentGate.resolve();
      senderKeyGate.resolve();
      await flushMicrotasks();
      if (scenario.gate === 'event') expect(admission).not.toHaveBeenCalled();
      if (scenario.gate === 'event' || scenario.gate === 'admission') expect(enrich).not.toHaveBeenCalled();
      if (scenario.gate !== 'sender-key') expect(drain).not.toHaveBeenCalled();
      expect(reannounce).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    } finally {
      admissionGate.resolve();
      enrichmentGate.resolve();
      senderKeyGate.resolve();
      await f.close();
    }
  });

  it.each(['admission', 'probe'] as const)('reports an unexpected peer-update %s failure without attempting sync', async (stage) => {
    const f = await createPeerEventFixture();
    try {
      const failure = new Error(`${stage} fixture failure`);
      const admission = vi.spyOn(f.agent, 'ensurePeerAdmittedForRecovery');
      if (stage === 'admission') admission.mockRejectedValue(failure);
      else admission.mockResolvedValue(true);
      const probe = vi.spyOn(f.agent, 'getSyncReconcilerProbe').mockRejectedValue(failure);
      const attempt = vi.spyOn(f.agent, 'attemptSyncFromPeerWithReconcilerAccounting').mockResolvedValue('not-started');
      const warn = vi.spyOn(f.state.log, 'warn').mockImplementation(() => {});
      f.state.skippedNoSyncPeers.add(f.peerId);
      f.dispatchUpdate();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        expect.anything(), `Sync retry after peer:update failed for ${f.peerId.slice(-8)}: ${failure.message}`,
      ));
      expect(attempt).not.toHaveBeenCalled();
      expect(f.state.skippedNoSyncPeers.has(f.peerId)).toBe(stage === 'admission');
      if (stage === 'admission') expect(probe).not.toHaveBeenCalled();
      else expect(probe).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
});
