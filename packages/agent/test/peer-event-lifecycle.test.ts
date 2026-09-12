import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerSyncSession } from '../src/sync/peer-sync-session.js';
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { NetworkAdmissionCoordinator } from '../src/p2p/network-admission-coordinator.js';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { asSyncOnConnectTestAgent, allowAllNetworkAdmission } from './_helpers/sync-on-connect-test-fixture.js';
import { createPeerEventFixture, deferred, flushMicrotasks } from './_helpers/peer-event-lifecycle.js';

const PROBE = { protocolsKey: null, connectionKey: null } satisfies Awaited<ReturnType<DKGAgent['getSyncReconcilerProbe']>>;

describe('DKGAgent peer lifecycle integration', () => {
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
      expect(f.state.session.snapshot(f.peerId).lastQueued).toBe(0);
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
      f.state.session.recordBackoff(f.peerId, marker);
      warn.mockClear();
      if (phase === 'probe') {
        if (reject) probeGate.reject(new Error('old reconciler probe failure'));
        else probeGate.resolve(PROBE);
      } else if (reject) admissionGate.reject(new Error('old reconciler admission failure'));
      else admissionGate.resolve(true);
      expect(await settled).toBeUndefined();
      expect(attempt).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(f.state.session.snapshot(f.peerId)).toMatchObject({
        backoff: marker,
        lastSuccessfulSync: undefined,
        lastSyncProgress: undefined,
      });
    } finally { probeGate.resolve(PROBE); admissionGate.resolve(false); await f.close(); }
  });

  it('records the offline boundary so a same-instance restart immediately queues catch-up', async () => {
    const f = await createPeerEventFixture();
    try {
      f.state.session.recordFreshness(f.peerId, {
        successfulAt: Date.now() - 1_000,
        progressAt: Date.now() - 750,
      });
      f.state.session.recordQueued(f.peerId, Date.now() - 500);
      const peers = vi.spyOn(f.agent.node.libp2p, 'getPeers').mockReturnValue([f.peer]);
      await f.agent.stop();
      expect(f.state.session.snapshot(f.peerId)).toMatchObject({
        lastSuccessfulSync: undefined,
        lastSyncProgress: undefined,
        lastQueued: 0,
      });
      peers.mockRestore();
      const disconnected = f.state.disconnectTimestamp(f.peerId);
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
      f.state.session.markSkipped(f.peerId);
      f.dispatchUpdate();
      await flushMicrotasks();
      expect(admission).toHaveBeenCalledOnce();
      if (scenario.gate === 'probe') await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
      const stopping = f.agent.stop();
      admissionGate.resolve(true);
      if (scenario.gate === 'probe' && scenario.reject) probeGate.reject(new Error('probe cancelled'));
      else probeGate.resolve(PROBE);
      await stopping;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
      expect(attempt).not.toHaveBeenCalled();
      if (scenario.gate !== 'probe') expect(probe).not.toHaveBeenCalled();
      expect(admission.mock.calls[0][2]?.signal?.aborted).toBe(true);
    } finally {
      admissionGate.resolve(false);
      probeGate.resolve(PROBE);
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
      f.state.session.markSkipped(f.peerId);
      f.dispatchUpdate();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        expect.anything(), `Sync retry after peer:update failed for ${f.peerId.slice(-8)}: ${failure.message}`,
      ));
      expect(attempt).not.toHaveBeenCalled();
      expect(f.state.session.isSkipped(f.peerId)).toBe(stage === 'admission');
      if (stage === 'admission') expect(probe).not.toHaveBeenCalled();
      else expect(probe).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
});
