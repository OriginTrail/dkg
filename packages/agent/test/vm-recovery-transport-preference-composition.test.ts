import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import { VmRecoveryCoreTransportPreferencePolicy } from '../src/vm-recovery-core-transport-preference.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const peerId = '12D3KooWTransportReplica';
const graphId = '0x0000000000000000000000000000000000000001/transport-composition';
const agents: DKGAgent[] = [];

async function fixture() {
  const h = await createVmRecoveryHostHarness({
    name: 'TransportComposition', localCgId: graphId, peers: [peerId], targetCount: 1,
    targetForOrdinal: ordinal => ({ localCgId: graphId, onChainCgId: '1', ordinal,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`, reason: 'no-swm' as const,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}` }),
    onFetch: () => 'clean-absent',
  });
  agents.push(h.agent);
  h.internals.peerCapabilityRegistry.observe(peerId, { source: 'identify-snapshot', protocols: [PROTOCOL_STORAGE_ACK] });
  return h;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
});

describe('typed transport preference composition', () => {
  it('constructs one policy through the composed host and keeps it on repeated initialization', async () => {
    const initialize = vi.spyOn(DKGAgent.prototype, 'initializeVmReconcilePublicCoreTransportPreferencePolicy');
    const h = await fixture();
    const policy = h.internals.vmReconcilePublicCoreTransportPreferencePolicy;
    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize.mock.contexts).toEqual([h.agent]);
    expect(policy).toBeInstanceOf(VmRecoveryCoreTransportPreferencePolicy);
    expect(policy.remember(graphId, '1', peerId, h.internals.getSyncReconcilerConnectionKey(peerId))).toBe(true);
    h.agent.initializeVmReconcilePublicCoreTransportPreferencePolicy();
    expect(h.internals.vmReconcilePublicCoreTransportPreferencePolicy).toBe(policy);
    expect(policy.preferredPeer(graphId, '1', [peerId])).toBe(peerId);
  });

  it('keeps the holder through peer cleanup, graph reset and lifecycle reopen', async () => {
    const h = await fixture();
    const policy = h.internals.vmReconcilePublicCoreTransportPreferencePolicy;
    const otherGraph = `${graphId}/other`;
    const remember = (graph: string) => policy.remember(graph, '1', peerId, h.internals.getSyncReconcilerConnectionKey(peerId));
    expect(remember(graphId)).toBe(true);
    h.internals.clearNetworkRejectedPeerState(peerId);
    expect(policy.preferredPeer(graphId, '1', [peerId])).toBeUndefined();
    expect(h.internals.vmReconcilePublicCoreTransportPreferencePolicy).toBe(policy);

    h.internals.peerCapabilityRegistry.observe(peerId, { source: 'identify-snapshot', protocols: [PROTOCOL_STORAGE_ACK] });
    expect(remember(graphId)).toBe(true);
    expect(remember(otherGraph)).toBe(true);
    h.internals.clearVmReconcileRotationStateForContextGraph(graphId);
    expect(policy.preferredPeer(graphId, '1', [peerId])).toBeUndefined();
    expect(policy.preferredPeer(otherGraph, '1', [peerId])).toBe(peerId);
    expect(h.internals.vmReconcilePublicCoreTransportPreferencePolicy).toBe(policy);

    h.internals.closeVmReconcileRotationState();
    expect(policy.preferredPeer(otherGraph, '1', [peerId])).toBeUndefined();
    h.internals.openVmReconcileRotationState();
    expect(h.internals.vmReconcilePublicCoreTransportPreferencePolicy).toBe(policy);
    expect(remember(graphId)).toBe(true);
  });
});
