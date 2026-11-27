import { describe, expect, it } from 'vitest';
import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { PeerCapabilityRegistry } from '../src/p2p/peer-capability.js';
import { ACKCandidateDiscoveryCoordinator } from '../src/p2p/ack-candidate-discovery.js';

const CORES = ['non-member', 'core-a', 'core-b', 'core-c', 'core-d'];

function coordinatorWithCores() {
  const registry = new PeerCapabilityRegistry();
  for (const peerId of CORES) registry.observe(peerId, { source: 'peer-update', protocols: [PROTOCOL_STORAGE_ACK] });
  return new ACKCandidateDiscoveryCoordinator(registry);
}

const round = (coordinator: ACKCandidateDiscoveryCoordinator, requiredACKs: number, local = { peerId: 'self', available: false }) =>
  coordinator.resolveRound({
    connectedPeers: [...CORES, 'relay-1'],
    localCandidate: local,
    requiredACKs,
    protocol: PROTOCOL_STORAGE_ACK,
    verifiedSameNetworkPeerIds: () => undefined,
    getPeerProtocols: async (peerId) => (CORES.includes(peerId) ? [PROTOCOL_STORAGE_ACK] : []),
    preflight: async () => {},
    isAcceptedPeer: () => true,
  });

describe('ACK candidate selection with the cores\' track record', () => {
  it('asks every eligible core while there is no record, as before', async () => {
    const plan = await round(coordinatorWithCores(), 2);
    expect(plan.peers).toEqual(CORES);
  });

  it('leaves out the core whose signer is outside the sharding table and asks fast cores first', async () => {
    const coordinator = coordinatorWithCores();
    coordinator.recordRoundOutcomes([
      { peerId: 'non-member', outcome: { kind: 'ineligible-signer', reason: 'not-in-sharding-table' } },
      { peerId: 'core-a', outcome: { kind: 'valid', latencyMs: 1_290 } },
      { peerId: 'core-b', outcome: { kind: 'valid', latencyMs: 1_100 } },
      { peerId: 'core-d', outcome: { kind: 'declined', code: 'CORE_TEMPORARILY_UNAVAILABLE' } },
    ]);

    const plan = await round(coordinator, 2);

    expect(plan.peers).toEqual(['core-b', 'core-a', 'core-c', 'core-d']);
    expect(plan.diagnostics.find((d) => d.peerId === 'non-member')).toMatchObject({ selected: false, reason: 'ineligible-signer' });
    // The diagnostics list the selected cores in asking order (the "Selected …" log line).
    expect(plan.diagnostics.filter((d) => d.selected).map((d) => d.peerId)).toEqual(plan.peers);
  });

  it('keeps the local candidate first and counts it toward the quorum floor', async () => {
    const coordinator = coordinatorWithCores();
    coordinator.recordRoundOutcomes([
      { peerId: 'non-member', outcome: { kind: 'ineligible-signer', reason: 'not-in-sharding-table' } },
      { peerId: 'core-c', outcome: { kind: 'valid', latencyMs: 300 } },
    ]);

    const plan = await round(coordinator, 3, { peerId: 'self', available: true });

    expect(plan.peers).toEqual(['self', 'core-c', 'core-a', 'core-b', 'core-d']);
    expect(plan.diagnostics[0]).toMatchObject({ peerId: 'self', reason: 'selected-local' });
  });

  it('keeps every candidate when leaving the non-members out would leave fewer than the quorum', async () => {
    const coordinator = coordinatorWithCores();
    coordinator.recordRoundOutcomes(CORES.slice(0, 4).map((peerId) => ({
      peerId, outcome: { kind: 'ineligible-signer' as const, reason: 'not-in-sharding-table' },
    })));

    const plan = await round(coordinator, 2);

    expect(plan.peers).toEqual(['core-d', ...CORES.slice(0, 4)]);
    expect(plan.diagnostics.some((d) => d.reason === 'ineligible-signer')).toBe(false);
  });
  it('uses the same non-default quorum for direct selection and discovered rounds', async () => {
    const coordinator = coordinatorWithCores();
    coordinator.recordRoundOutcomes(CORES.slice(0, 3).map(peerId => ({
      peerId, outcome: { kind: 'ineligible-signer' as const, reason: 'not-in-sharding-table' },
    })));
    const local = { peerId: 'self', available: false };
    const direct = coordinator.selectCandidates({ connectedPeers: [...CORES, 'relay-1'],
      protocol: PROTOCOL_STORAGE_ACK, requiredACKs: 2 }, local);
    expect(direct.peers).toEqual(['core-c', 'core-d']);
    expect(await round(coordinator, 2, local)).toEqual(direct);
  });

});
