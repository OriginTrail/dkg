/**
 * GH#3579: a failed identity probe opens a retry backoff, and the coordinator
 * logs that failure once, with the window. Recovery must not log it again, nor
 * ask to connect and admit the peer on every round inside the window.
 */
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext, ed25519Sign } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { NetworkAdmissionCoordinator } from '../src/p2p/network-admission-coordinator.js';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';
import { signNetworkIdentityResponse } from '../src/p2p/network-identity-proof.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { createIncompleteDurableSyncResult } from '../src/sync/durable-progress.js';
import { DurableRecoveryRunner, type DurableRecoveryRunnerDependencies } from '../src/sync/durable-recovery-runner.js';
import { stubDurableSync } from './_helpers/stub-durable-sync.js';

const PEER = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const SELF = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const PEER_SEED = Buffer.from('vHxcSg3ecwP9UfJWdmlnWQeJe83jD2yKtOJlWuLpIrTRh3QiB5sL6iRhAidCZ3bHQLaE0RwBfHBNEmV7ylcjqg==', 'base64').slice(0, 32);
const identity = { networkId: 'network-a', genesisId: 'base-testnet' };
const CG = 'probe-backoff-graph';

/** The production recovery wiring on a host with a real admission coordinator and a fake clock. */
function recoveryHost() {
  let now = 1_000;
  let reachable = false;
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const sendIdentityProbe = vi.fn(async (_peerId: string, data: Uint8Array): Promise<Uint8Array> => {
    if (!reachable) throw new Error('no route to peer');
    const response = await signNetworkIdentityResponse({
      request: JSON.parse(new TextDecoder().decode(data)), identity, responderPeerId: PEER,
      sign: (payload) => ed25519Sign(payload, PEER_SEED),
    });
    return new TextEncoder().encode(JSON.stringify(response));
  });
  const networkAdmissionCoordinator = new NetworkAdmissionCoordinator({
    admission: new NetworkAdmissionService({ networkId: identity.networkId, selfPeerId: SELF, now: () => now }),
    identity, selfPeerId: SELF, sign: async () => new Uint8Array(), sendIdentityProbe,
    getConnections: () => [], deletePeerFromPeerStore: async () => undefined, log,
  });
  const ensureAdmitted = vi.spyOn(networkAdmissionCoordinator, 'ensureAdmitted');
  const ensurePeerConnected = vi.fn(async (_peerId: string) => undefined);
  const slicedPeerIds: string[] = [];
  const host = {
    config: {},
    started: true,
    node: { stopSignal: undefined, libp2p: { getConnections: () => [] } },
    syncCheckpoints: new MemorySyncCheckpointStore(),
    log,
    networkAdmissionCoordinator,
    resolvePreferredSyncPeerId: async () => PEER,
    ensurePeerConnected,
    primeCatchupConnections: async () => undefined,
    ensurePeerAdmittedForRecovery: LifecycleSyncMethods.prototype.ensurePeerAdmittedForRecovery,
    isPrivateContextGraph: async () => false,
    selectCatchupPeers: (peers: Array<{ toString(): string }>) => peers,
    waitForSyncProtocol: async () => true,
    syncFromPeerDetailed: async (peerId: string) => {
      slicedPeerIds.push(peerId);
      return createIncompleteDurableSyncResult();
    },
  };
  stubDurableSync(host as never, host.syncFromPeerDetailed as never);
  return {
    host, log, sendIdentityProbe, ensureAdmitted, ensurePeerConnected, slicedPeerIds,
    advance: (ms: number) => { now += ms; },
    makeReachable: () => { reachable = true; },
    recover: () => LifecycleSyncMethods.prototype.syncDurableRecoveryContextGraph.call(host as never, CG),
    admit: (label: string) => LifecycleSyncMethods.prototype.ensurePeerAdmittedForRecovery
      .call(host as never, PEER, createOperationContext('sync'), label),
  };
}

describe('durable recovery and a peer whose identity probe backs off (GH#3579)', () => {
  it('logs the failed probe once and asks for the peer again only after its window', async () => {
    const h = recoveryHost();

    await expect(h.recover()).resolves.toMatchObject({ outcome: 'no-progress' });
    expect(h.sendIdentityProbe).toHaveBeenCalledOnce();
    expect(h.log.warn).toHaveBeenCalledOnce();
    expect(h.log.warn.mock.calls[0][1]).toBe(
      `Network identity probe for ${PEER.slice(-8)} failed retryably: no route to peer (automatic probes paused for 15000ms)`,
    );

    for (let round = 0; round < 5; round += 1) {
      h.advance(2_000);
      await expect(h.recover()).resolves.toMatchObject({ outcome: 'no-progress' });
    }
    expect(h.log.warn).toHaveBeenCalledOnce();
    expect(h.sendIdentityProbe).toHaveBeenCalledOnce();
    // The first round's connect attempt is the only one: no round inside the window asked.
    expect(h.ensureAdmitted).toHaveBeenCalledOnce();
    expect(h.ensurePeerConnected).not.toHaveBeenCalled();
    expect(h.slicedPeerIds).toEqual([]);

    h.advance(5_000);
    h.makeReachable();
    await h.recover();
    expect(h.sendIdentityProbe).toHaveBeenCalledTimes(2);
    expect(h.ensurePeerConnected).toHaveBeenCalledWith(PEER);
    expect(h.slicedPeerIds).toEqual([PEER]);
    expect(h.log.warn).toHaveBeenCalledOnce();
  });

  it('adds the caller label at debug level only, and skips quietly inside the window', async () => {
    const h = recoveryHost();

    await expect(h.admit('Sync reconciler')).resolves.toBe(false);
    expect(h.log.warn).toHaveBeenCalledOnce();
    expect(h.log.warn.mock.calls[0][1]).toContain('failed retryably: no route to peer');
    expect(h.log.debug).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      `Sync reconciler peer ${PEER.slice(-8)} not admitted: Network identity probe failed for ${PEER}: no route to peer`,
    );

    for (let call = 0; call < 3; call += 1) await expect(h.admit('Sync reconciler')).resolves.toBe(false);
    expect(h.sendIdentityProbe).toHaveBeenCalledOnce();
    expect(h.log.warn).toHaveBeenCalledOnce();
    expect(h.log.debug).toHaveBeenCalledOnce();
  });

  it('still warns for an admission failure that no other owner logs, and rethrows a caller abort', async () => {
    const failure = new Error('admission state unavailable');
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const host = {
      log,
      networkAdmissionCoordinator: {
        isAcceptedPeer: () => false,
        isRejectedPeer: () => false,
        ensureAdmitted: async () => { throw failure; },
      },
    };
    const admit = (signal?: AbortSignal) => LifecycleSyncMethods.prototype.ensurePeerAdmittedForRecovery
      .call(host as never, PEER, createOperationContext('sync'), 'Connected catchup peer', signal);

    await expect(admit()).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      `Connected catchup peer admission probe failed for ${PEER.slice(-8)}: admission state unavailable`,
    );
    await expect(admit(AbortSignal.abort())).rejects.toBe(failure);
    expect(log.debug).not.toHaveBeenCalled();
  });
});

describe('a durable recovery round with peers in admission backoff', () => {
  const LIVE = '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw';
  const OTHER = '12D3KooWPyTpqBBtU1AvzSsd5rWXCQzFcGtG44qDmeYenWcpzsge';

  function round(backedOff: Set<string>, options: { restrictToCandidatePeerIds?: boolean } = {}) {
    const connected: string[] = [];
    const admitted: string[] = [];
    const sliced: string[] = [];
    const dependencies: DurableRecoveryRunnerDependencies = {
      checkpointStore: new MemorySyncCheckpointStore(),
      isRunning: () => true,
      resolvePreferredPeerId: async () => PEER,
      connectRequestedPeer: async (peerId) => { connected.push(peerId); },
      primeConnections: async () => undefined,
      liveConnectionPeerIds: () => [LIVE],
      isAdmissionBackedOff: (peerId) => backedOff.has(peerId),
      admitPeer: async (peerId) => { admitted.push(peerId); return true; },
      isPrivateContextGraph: async () => false,
      orderPeerIds: (peerIds) => [...peerIds],
      isSyncCapable: async () => true,
      executeSlice: async (peerId) => {
        sliced.push(peerId);
        return { result: createIncompleteDurableSyncResult(), decision: { strategy: 'not-started' } };
      },
      logDebug: () => undefined,
      logInfo: () => undefined,
      logWarn: () => undefined,
    };
    // Each slice without progress starts another discovery pass, so compare the peers asked.
    const asked = (peerIds: string[]) => [...new Set(peerIds)].sort();
    return new DurableRecoveryRunner().run({
      contextGraphId: CG,
      options: { candidatePeerIds: [OTHER], ...options },
      dependencies,
    }).then(() => ({ connected: asked(connected), admitted: asked(admitted), sliced: asked(sliced) }));
  }

  it('asks neither to connect nor to admit a backed-off requested or live peer', async () => {
    await expect(round(new Set([PEER, LIVE]))).resolves.toEqual({
      connected: [OTHER], admitted: [OTHER], sliced: [OTHER],
    });
    await expect(round(new Set([OTHER]), { restrictToCandidatePeerIds: true })).resolves.toEqual({
      connected: [], admitted: [], sliced: [],
    });
  });

  it('asks every peer once none is backed off', async () => {
    const all = [PEER, OTHER, LIVE].sort();
    await expect(round(new Set())).resolves.toEqual({
      connected: [PEER, OTHER].sort(), admitted: all, sliced: all,
    });
  });
});
