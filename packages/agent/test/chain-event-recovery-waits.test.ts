import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter, type ChainEvent, type EventFilter } from '@origintrail-official/dkg-chain';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { NetworkAdmissionCoordinator } from '../src/p2p/network-admission-coordinator.js';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';
import { waitForPeerProtocol } from '../src/p2p/protocol-readiness.js';

const remote = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const self = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
interface NudgeHost {
  subscribedContextGraphs: Map<string, { subscribed: boolean; onChainId?: string }>;
  resolveCurrentNameHashContextGraphBinding: (id: string, options?: { signal?: AbortSignal }) => Promise<{ onChainId: string; provenance: 'reverse-name-hash'; nameHash: string } | undefined>;
  contextGraphNameCommitment(id: string): string;
  bindSubscriptionReverseNameHashOnChainId(id: string, sub: { subscribed: boolean }, onChainId: string, nameHash: string): void;
  vmReconcilePhysicalRuns: Set<Promise<unknown>>;
}

describe('event-admitted VM recovery at existing waits', () => {
  it.each(['admission', 'protocol'] as const)('cancels a scheduled %s wait without late binding or post-shutdown cursor advancement', async boundary => {
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const cleanup = new AbortController();
    let readSignal: AbortSignal | undefined;
    let probeSignal: AbortSignal | undefined;
    let calls = 0;
    const admission = new NetworkAdmissionService({ networkId: 'network-a', selfPeerId: self });
    const coordinator = new NetworkAdmissionCoordinator({
      admission, identity: { networkId: 'network-a', genesisId: 'test-genesis' }, selfPeerId: self,
      sign: async () => new Uint8Array(),
      sendIdentityProbe: async (_peer, _data, options) => {
        probeSignal = options.signal;
        enter();
        await released; // A late response may settle after the last waiter leaves.
        return new Uint8Array();
      },
      getConnections: () => [], deletePeerFromPeerStore: async () => {},
    });
    class Chain extends MockChainAdapter {
      async getBlockNumber(): Promise<number> { return 20; }
      override async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
        if (!filter.eventTypes.includes('KnowledgeAssetRegisteredToContextGraph')) return;
        yield { type: 'KnowledgeAssetRegisteredToContextGraph', blockNumber: 11, data: { contextGraphId: '7', kaId: '11', txHash: 'fixture' } };
      }
    }
    const saved: number[] = [];
    const agent = await DKGAgent.create({
      name: 'EventRecoveryWait', chainAdapter: new Chain(), listenPort: 0, nodeRole: 'edge',
      syncReconcilerEnabled: true,
      chainEventCursorStore: {
        loadLane: async () => 10,
        saveLane: async (lane, block) => { if (lane === 'vmReconcile') saved.push(block); },
      },
    });
    const host = agent as unknown as NudgeHost;
    host.subscribedContextGraphs.clear();
    const subscription = { subscribed: true };
    host.subscribedContextGraphs.set('candidate', subscription);
    const nameHash = host.contextGraphNameCommitment('candidate');
    host.bindSubscriptionReverseNameHashOnChainId('candidate', subscription, '7', nameHash);
    // The recovery boundary is under test; read authority is already granted.
    const canRead = vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);
    const resolveBinding = host.resolveCurrentNameHashContextGraphBinding.bind(host);
    host.resolveCurrentNameHashContextGraphBinding = async (id, options) => {
      if (id !== 'candidate' || !options?.signal) return resolveBinding(id, options);
      calls++;
      readSignal = options?.signal;
      const signal = readSignal ? AbortSignal.any([readSignal, cleanup.signal]) : cleanup.signal;
      if (boundary === 'admission') {
        await coordinator.ensureAdmitted(remote, createOperationContext('connect'), { signal });
      } else {
        await waitForPeerProtocol({ get: async () => { enter(); return { protocols: [] }; } },
          { toString: () => remote }, '/dkg/test/sync', 3, 60_000, signal);
      }
      return { onChainId: '7', provenance: 'reverse-name-hash', nameHash };
    };
    try {
      await agent.start();
      await entered;
      // The nudge has durably handed off to the VM scheduler. Its poll may
      // checkpoint even though the separately owned recovery is still active.
      await agent.awaitInitialChainPoll();
      expect(saved).toEqual([20]);
      agent.closeChainEventAdmission();
      expect(readSignal?.aborted).toBe(true);
      const stopped = agent.stop();
      await stopped;
      if (boundary === 'admission') expect(probeSignal?.aborted).toBe(true);
      release();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(calls).toBe(1);
      expect(saved).toEqual([20]);
      expect(host.subscribedContextGraphs.get('candidate')?.onChainId).toBeUndefined();
      expect(host.vmReconcilePhysicalRuns.size).toBe(0);
      expect(admission.snapshot()).toMatchObject({ verifiedPeerIds: [], quarantinedPeerIds: [] });
    } finally { cleanup.abort(); release(); await agent.stop(); canRead.mockRestore(); }
  });
});
