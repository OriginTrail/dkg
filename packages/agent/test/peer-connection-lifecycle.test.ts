import { PeerSyncSession } from '../src/sync/peer-sync-session.js';
import { syncOpenedPeerConnection } from '../src/sync/peer-connection.js';
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { resolveRfc64CatalogExecutionPlanV1 } from '../src/rfc64/catalog-rollout-authority-v1.js';
import { createPeerEventFixture, deferred, flushMicrotasks } from './_helpers/peer-event-lifecycle.js';

function activeSessionWithoutJobs(): PeerSyncSession {
  return new PeerSyncSession({
    createJob: () => { throw new Error('scheduler is outside this fixture'); },
    onInternalError: () => undefined,
  });
}

describe('peer connection lifecycle', () => {
  it.each([new Error('queued sync failure'), 'queued sync failure'])('uses active configured replay authority and fences queued errors: %s', async (failure) => {
    const f = await createPeerEventFixture();
    const executionPlan = resolveRfc64CatalogExecutionPlanV1({
      configuredContextGraphs: [],
      activation: {
        enabled: true,
        selectedContextGraphs: ['configured-active', 'configured-legacy'],
        selectedPublicContextGraphs: ['configured-active', 'configured-legacy'],
        rollout: {
          killSwitch: false,
          contextGraphModes: {
            'configured-active': 'catalog',
            'configured-legacy': 'legacy',
          },
        },
      },
    });
    Object.defineProperty(f.agent.config, 'rfc64CatalogExecutionPlan', {
      configurable: true,
      value: executionPlan,
    });
    const session = activeSessionWithoutJobs();
    try {
      vi.spyOn(f.agent, 'readRfc64CatalogResponsibilitiesV1').mockReturnValue([
        {
          contextGraphId: 'responsibility-active', responsible: true, active: true, mode: 'catalog',
          responsibilityReason: 'private-membership', selectionSource: 'default',
        },
        {
          contextGraphId: 'responsibility-inactive', responsible: true, active: false, mode: 'catalog',
          responsibilityReason: 'private-membership', selectionSource: 'kill-switch',
        },
        {
          contextGraphId: 'responsibility-legacy', responsible: true, active: true, mode: 'legacy',
          responsibilityReason: 'private-membership', selectionSource: 'operator-override',
        },
        {
          contextGraphId: 'configured-active', responsible: true, active: true, mode: 'catalog',
          responsibilityReason: 'private-membership', selectionSource: 'operator-override',
        },
      ]);
      expect(f.agent.listActiveRfc64CatalogReplayContextGraphIdsV1()).toEqual([
        'configured-active',
        'responsibility-active',
      ]);
      const admission = vi.spyOn(f.agent.networkAdmissionCoordinator, 'ensureAdmitted').mockResolvedValue(true);
      vi.spyOn(f.agent, 'enrichPeerStoreFromInboundCircuit').mockResolvedValue();
      vi.spyOn(f.agent, 'drainPendingSenderKeyForPeer').mockResolvedValue(0);
      vi.spyOn(f.agent, 'reannounceRfc64CatalogHeadsToPeerV1').mockResolvedValue({ announced: 0, failed: 0, manifest: [] });
      const replay = vi.spyOn(f.agent, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1').mockResolvedValue({ requested: 1, failed: 0 });
      let reportError!: Parameters<DKGAgent['queueSyncFromPeerOnConnect']>[1];
      vi.spyOn(f.agent, 'queueSyncFromPeerOnConnect').mockImplementation((_peer, onError) => { reportError = onError; return true; });
      const log = { info: vi.fn(), warn: vi.fn() };
      const ports = {
        localPeerId: f.agent.node.libp2p.peerId.toString(),
        listActiveCatalogReplayContextGraphIds: () => (
          f.agent.listActiveRfc64CatalogReplayContextGraphIdsV1()
        ),
        markReplayPending: (contextGraphId: string, remotePeer: string) => f.agent.markRfc64CatalogReplayPeerPendingV1(contextGraphId, remotePeer),
        clearReplayPending: (contextGraphId: string, remotePeer: string) => f.agent.clearRfc64CatalogReplayPeerPendingV1(contextGraphId, remotePeer),
        ensureAdmitted: (remotePeer: string, ctx: ReturnType<typeof createOperationContext>, signal: AbortSignal) => (
          f.agent.networkAdmissionCoordinator.ensureAdmitted(remotePeer, ctx, { signal })
        ),
        enrichPeerStore: (connection: Parameters<DKGAgent['enrichPeerStoreFromInboundCircuit']>[0]) => (
          f.agent.enrichPeerStoreFromInboundCircuit(connection)
        ),
        drainPendingSenderKey: (remotePeer: string, ctx: ReturnType<typeof createOperationContext>) => (
          f.agent.drainPendingSenderKeyForPeer(remotePeer, ctx)
        ),
        reannounceCatalogHeads: (remotePeer: string) => f.agent.reannounceRfc64CatalogHeadsToPeerV1(remotePeer),
        requestCatalogReplay: (contextGraphId: string) => f.agent.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(contextGraphId),
        queueSync: (remotePeer: string, onError: Parameters<DKGAgent['queueSyncFromPeerOnConnect']>[1]) => (
          f.agent.queueSyncFromPeerOnConnect(remotePeer, onError)
        ),
      };
      const context = { ports, session, ctx: createOperationContext('sync'), log };
      await syncOpenedPeerConnection(context, { direction: 'inbound', remotePeer: f.agent.node.libp2p.peerId });
      expect(admission).not.toHaveBeenCalled();
      await syncOpenedPeerConnection(context, { direction: 'inbound', remotePeer: f.peer });
      expect(replay).toHaveBeenCalledTimes(2);
      expect(replay).toHaveBeenCalledWith('configured-active');
      expect(replay).toHaveBeenCalledWith('responsibility-active');
      reportError(f.peerId, failure);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(context.ctx, expect.stringContaining('queued sync failure'));
      log.warn.mockClear();
      session.close();
      reportError(f.peerId, failure);
      expect(log.warn).not.toHaveBeenCalled();
    } finally { session.close(); await f.close(); }
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

});
