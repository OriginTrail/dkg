import { describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK_V2, PROTOCOL_SYNC,
} from '@origintrail-official/dkg-core';
import { PeerCapabilityRegistry } from '../src/p2p/peer-capability.js';
import { ACKCandidateDiscoveryCoordinator } from '../src/p2p/ack-candidate-discovery.js';

const CORE = ['core-1', 'core-2', 'core-3', 'core-4'];

describe('ACKCandidateDiscoveryCoordinator', () => {
  it('uses the local candidate decision for discovery, ordering, and diagnostics', async () => {
    const unknown = Array.from({ length: 8 }, (_, index) => `unknown-${index}`);
    const resolve = async (available: boolean) => {
      const registry = new PeerCapabilityRegistry();
      const coordinator = new ACKCandidateDiscoveryCoordinator(registry);
      for (const id of CORE.slice(0, 2)) registry.observe(id, { source: 'peer-update', protocols: [PROTOCOL_STORAGE_ACK] });
      const probe = vi.fn(async (peerId: string) =>
        peerId === unknown[0] || peerId === unknown[4] ? 'supported' as const : 'unsupported' as const);
      const plan = await coordinator.resolveRound({
        connectedPeers: [...CORE.slice(0, 2), ...unknown],
        localCandidate: { peerId: 'local-core', available },
        requiredACKs: 3,
        protocol: PROTOCOL_STORAGE_ACK,
        verifiedSameNetworkPeerIds: () => undefined,
        getPeerProtocols: async () => [],
        preflight: async () => {},
        isAcceptedPeer: () => true,
        probeProtocol: probe,
      });
      return { plan, probe };
    };

    const withLocal = await resolve(true);
    expect(withLocal.probe).toHaveBeenCalledTimes(4);
    expect(withLocal.plan.peers).toEqual(['local-core', ...CORE.slice(0, 2), unknown[0]]);
    expect(withLocal.plan.diagnostics[0]).toMatchObject({
      peerId: 'local-core', selected: true, reason: 'selected-local',
    });

    const withoutLocal = await resolve(false);
    expect(withoutLocal.probe).toHaveBeenCalledTimes(8);
    expect(withoutLocal.plan.peers).toEqual([...CORE.slice(0, 2), unknown[0], unknown[4]]);
    expect(withoutLocal.plan.diagnostics[0]).toMatchObject({
      peerId: 'local-core', selected: false, reason: 'local-unavailable',
    });
  });

  it('keeps publish-v2 and update-v2 capability evidence separate', async () => {
    const registry = new PeerCapabilityRegistry();
    registry.observe(CORE[0], { source: 'peer-update', protocols: [PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2] });
    registry.observe(CORE[1], { source: 'peer-update', protocols: [PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_UPDATE_ACK_V2] });
    const coordinator = new ACKCandidateDiscoveryCoordinator(registry);
    const input = {
      connectedPeers: CORE.slice(0, 2),
      requiredACKs: 1,
      verifiedSameNetworkPeerIds: undefined,
    };
    const local = { peerId: 'local-core', available: false };

    expect(coordinator.selectCandidates({ ...input, protocol: PROTOCOL_STORAGE_ACK_V2 }, local).peers).toEqual(CORE.slice(0, 2));
    expect(coordinator.selectCandidates({ ...input, protocol: PROTOCOL_STORAGE_UPDATE_ACK_V2 }, local).peers).toEqual([CORE[1], CORE[0]]);
    expect(registry.snapshotProtocolPeers(PROTOCOL_STORAGE_ACK_V2).has(CORE[1])).toBe(false);
    expect(registry.snapshotProtocolPeers(PROTOCOL_STORAGE_UPDATE_ACK_V2).has(CORE[0])).toBe(false);
  });

  it('limits non-base rounds to 16 peers, 32 negotiations, and four concurrent probes', async () => {
    const unknown = Array.from({ length: 40 }, (_, index) => `unknown-${index}`);
    const coordinator = new ACKCandidateDiscoveryCoordinator(new PeerCapabilityRegistry());
    let active = 0;
    let peak = 0;
    const probe = vi.fn(async (_peerId: string, protocol: string) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return protocol === PROTOCOL_STORAGE_UPDATE_ACK_V2 ? 'supported' as const : 'unsupported' as const;
    });
    const ports = {
      connectedPeers: unknown,
      localCandidate: { peerId: 'local-core', available: false },
      requiredACKs: 1,
      protocol: PROTOCOL_STORAGE_UPDATE_ACK_V2,
      verifiedSameNetworkPeerIds: () => undefined,
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      preflight: async () => {},
      isAcceptedPeer: () => true,
      probeProtocol: probe,
    };
    const probedPeers = () => [...new Set(probe.mock.calls.map(([peerId]) => peerId))];

    await coordinator.resolveRound(ports);
    expect(probe).toHaveBeenCalledTimes(32);
    expect(probedPeers()).toEqual(unknown.slice(0, 16));
    expect(peak).toBeLessThanOrEqual(4);

    probe.mockClear();
    await coordinator.resolveRound(ports);
    expect(probe).toHaveBeenCalledTimes(32);
    expect(probedPeers()).toEqual(unknown.slice(16, 32));

    probe.mockClear();
    await coordinator.resolveRound(ports);
    expect(probe).toHaveBeenCalledTimes(32);
    expect(probedPeers()).toEqual([...unknown.slice(32), ...unknown.slice(0, 8)]);
  });

  it('rotates through preferred peers beyond the first per-round probe budget', async () => {
    const preferred = Array.from({ length: 40 }, (_, index) => `preferred-${index}`);
    const other = Array.from({ length: 8 }, (_, index) => `other-${index}`);
    const registry = new PeerCapabilityRegistry();
    const coordinator = new ACKCandidateDiscoveryCoordinator(registry);
    const probe = vi.fn(async (peerId: string) => peerId === preferred[39]
      ? 'supported' as const : 'unsupported' as const);
    const ports = {
      connectedPeers: [...preferred, ...other],
      preferredACKPeerIds: preferred,
      localCandidate: { peerId: 'local-core', available: false },
      requiredACKs: 1,
      protocol: PROTOCOL_STORAGE_ACK,
      verifiedSameNetworkPeerIds: () => undefined,
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      preflight: async () => {},
      isAcceptedPeer: () => true,
      probeProtocol: probe,
    };

    await coordinator.resolveRound(ports);
    expect(probe).toHaveBeenCalledTimes(32);
    expect(probe.mock.calls.map(([peerId]) => peerId)).not.toContain(preferred[39]);
    expect(probe.mock.calls.slice(0, 32).map(([peerId]) => peerId)).toEqual([
      ...preferred.slice(0, 24), ...other,
    ]);
    const secondRound = await coordinator.resolveRound(ports);
    expect(probe.mock.calls.slice(32).map(([peerId]) => peerId)).toContain(preferred[39]);
    expect(probe.mock.calls.length - 32).toBeLessThanOrEqual(32);
    expect(secondRound.peers).toEqual([preferred[39]]);
  });

});
