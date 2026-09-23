import { describe, expect, it } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { MAX_IDENTITY_PROBE_CONCURRENCY } from '../src/p2p/network-admission-coordinator.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const PEER_B = '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw';
const PEER_C = '12D3KooWPyTpqBBtU1AvzSsd5rWXCQzFcGtG44qDmeYenWcpzsge';

function connectionsTo(peerIds: readonly string[]) {
  return peerIds.map((peerId) => ({ remotePeer: { toString: () => peerId } }));
}

function listAdmitted(agent: unknown): Promise<Array<{ toString(): string }>> {
  return LifecycleSyncMethods.prototype.listAdmittedConnectedPeers.call(
    agent as DKGAgent,
    createOperationContext('sync'),
  );
}

describe('listAdmittedConnectedPeers', () => {
  it('keeps one entry per admitted peer, in connection order, under the catch-up label', async () => {
    const checks: string[] = [];
    const admitted = await listAdmitted({
      node: { libp2p: { getConnections: () => connectionsTo([PEER_B, PEER_A, PEER_B, PEER_C]) } },
      ensurePeerAdmittedForRecovery: async (peerId: string, _ctx: unknown, label: string) => {
        checks.push(`${label}:${peerId}`);
        return peerId !== PEER_A;
      },
    });

    expect(admitted.map(String)).toEqual([PEER_B, PEER_C]);
    expect(checks).toEqual([
      `Connected catchup peer:${PEER_B}`,
      `Connected catchup peer:${PEER_A}`,
      `Connected catchup peer:${PEER_C}`,
    ]);
  });

  it('probes independent peers concurrently, bounded by the coordinator\'s identity-probe limit', async () => {
    const peerIds = Array.from({ length: 10 }, (_, index) => `peer-${index}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const admitted = await listAdmitted({
      node: { libp2p: { getConnections: () => connectionsTo(peerIds) } },
      ensurePeerAdmittedForRecovery: async (peerId: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return peerId !== 'peer-3';
      },
    });

    // One shared bound with the coordinator's preflight ceiling, not a copy.
    expect(MAX_IDENTITY_PROBE_CONCURRENCY).toBe(4);
    expect(maxInFlight).toBe(MAX_IDENTITY_PROBE_CONCURRENCY);
    expect(admitted.map(String)).toEqual(peerIds.filter((peerId) => peerId !== 'peer-3'));
  });

  it('is the candidate set the in-process catch-up selects from', async () => {
    const agent = await DKGAgent.create({
      name: 'ConnectedPeerAdmission',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      rfc64CatalogActivation: { enabled: false },
    });
    const selected: string[][] = [];
    try {
      await agent.start();
      (agent as any).isPrivateContextGraph = async () => false;
      (agent as any).resolvePreferredSyncPeerId = async () => undefined;
      (agent as any).primeCatchupConnections = async () => undefined;
      (agent as any).ensurePeerAdmittedForRecovery = async (peerId: string) => peerId !== PEER_B;
      (agent.node.libp2p as any).getConnections = () => connectionsTo([PEER_A, PEER_B, PEER_C]);
      (agent as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => {
        selected.push(peers.map(String));
        return [];
      };

      await agent.syncContextGraphFromConnectedPeers('connected-peer-admission-cg');
      const admitted = await agent.listAdmittedConnectedPeers(createOperationContext('sync'));

      expect(selected).toEqual([[PEER_A, PEER_C]]);
      expect(admitted.map(String)).toEqual(selected[0]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
