import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../src/index.js';
import { createPeerEventFixture, deferred, flushMicrotasks } from './_helpers/peer-event-lifecycle.js';

const PROBE = { protocolsKey: null, connectionKey: null } satisfies Awaited<ReturnType<DKGAgent['getSyncReconcilerProbe']>>;

describe('peer-event lifecycle', () => {
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

  it.each(['enrichment', 'sender-key'] as const)('continues catch-up after a best-effort %s failure', async (stage) => {
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
      else drain.mockRejectedValue(new Error('sender-key unavailable'));
      vi.spyOn(f.agent, 'reannounceRfc64CatalogHeadsToPeerV1').mockResolvedValue({ announced: 0, failed: 0, manifest: [] });
      const replay = vi.spyOn(f.agent, 'requestRfc64CatalogHeadReplaysFromConnectedPeersV1')
        .mockRejectedValue(new Error('replay unavailable'));
      const queue = vi.spyOn(f.agent, 'queueSyncFromPeerOnConnect').mockReturnValue(true);
      const warn = vi.spyOn(f.state.log, 'warn').mockImplementation(() => {});
      f.dispatchOpen();
      await vi.waitFor(() => expect(queue).toHaveBeenCalledWith(f.peerId, expect.any(Function)));
      await flushMicrotasks();
      expect(drain).toHaveBeenCalledWith(f.peerId, expect.anything());
      expect(replay).toHaveBeenCalledWith('connection-catalog');
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(`${stage} unavailable`));
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('replay unavailable'));
    } finally { await f.close(); }
  });

  it('records the offline boundary so a same-instance restart immediately queues catch-up', async () => {
    const f = await createPeerEventFixture();
    try {
      f.state.lastSuccessfulSyncAt.set(f.peerId, Date.now() - 1_000);
      const peers = vi.spyOn(f.agent.node.libp2p, 'getPeers').mockReturnValue([f.peer]);
      await f.agent.stop();
      peers.mockRestore();
      const disconnected = f.state.lastSyncDisconnectedAt.get(f.peerId);
      expect(disconnected).toBeTypeOf('number');
      await f.agent.start();
      vi.spyOn(Date, 'now').mockReturnValue(disconnected! + 60_000);
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
