import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

describe('private SWM curator recovery planning', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map(async (agent) => {
      await agent.stop().catch(() => {});
      await agent.store.close().catch(() => {});
    }));
  });

  it('recovers wallet-scoped private CGs from the structural curator even when local meta self-stamps curator rows', async () => {
    const curator = ethers.Wallet.createRandom().address.toLowerCase();
    const member = ethers.Wallet.createRandom().address.toLowerCase();
    const curatorPeer = '12D3KooWStructuralCuratorPeer';
    const contextGraphId = `${curator}/curator-converge-plan`;
    const agent = await createAgent('CuratorRecoveryMemberPlan');

    // This simulates the rfc38 pre-create pattern from the retired devnet
    // script: the member has local curator/creator-looking meta, but the
    // wallet-scoped CG id still names a different structural curator.
    installPlanningStubs(agent, {
      localAgent: member,
      curator,
      curatorPeers: [curatorPeer],
      isPrivate: true,
      isCuratorOf: async () => {
        throw new Error('legacy triple-based curatorship must not gate wallet-scoped CGs');
      },
      resolveCuratorPeerId: async () => {
        throw new Error('legacy curator peer lookup must not gate wallet-scoped CGs');
      },
    });

    const plan = await agent.planSharedMemorySyncContextGraphs(
      curatorPeer,
      [contextGraphId],
      createOperationContext('sync'),
    );

    expect(plan.targets).toEqual([{
      contextGraphId,
      lane: 'ordinary-private',
    }]);
  });

  it('skips private SWM recovery when the local node owns the structural curator agent', async () => {
    const curator = ethers.Wallet.createRandom().address.toLowerCase();
    const memberPeer = '12D3KooWMemberReconnectPeer';
    const contextGraphId = `${curator}/curator-owned-plan`;
    const agent = await createAgent('CuratorRecoveryLocalCuratorPlan');

    installPlanningStubs(agent, {
      localAgent: curator,
      curator,
      curatorPeers: ['12D3KooWStructuralCuratorPeer'],
      isPrivate: true,
    });

    const plan = await agent.planSharedMemorySyncContextGraphs(
      memberPeer,
      [contextGraphId],
      createOperationContext('sync'),
    );

    expect(plan.targets).toEqual([]);
  });

  it('recovers a selected private CG from its exact complete provider without registry discovery', async () => {
    const curator = ethers.Wallet.createRandom().address.toLowerCase();
    const member = ethers.Wallet.createRandom().address.toLowerCase();
    const completeProvider = '12D3KooWPrivateCompleteProvider';
    const contextGraphId = `${curator}/selected-private-cold`;
    const agent = await createAgent('CompletePrivateSwmColdStartPlan');

    installPlanningStubs(agent, {
      localAgent: member,
      curator,
      curatorPeers: [],
      isPrivate: true,
    });
    const internals = agent as any;
    internals.canUseSharedMemoryForContextGraph = async () => false;
    internals.resolveRfc64CompleteSwmProviderPeerIdsV1 = () => [completeProvider];
    internals.refreshMetaFromCurator = async () => {
      throw new Error('pinned private recovery must not wait for registry discovery');
    };

    await expect(agent.planSharedMemorySyncContextGraphs(
      completeProvider,
      [contextGraphId],
      createOperationContext('sync'),
      { requireCompleteProviderMatch: true },
    )).resolves.toEqual({
      targets: [{ contextGraphId, lane: 'ordinary-private' }],
    });
  });

  it('limits automatic public SWM sweeps to an RFC-64 graph-complete provider', async () => {
    const contextGraphId = `${ethers.Wallet.createRandom().address}/selected-public`;
    const completeProvider = '12D3KooWCompleteSwmProvider';
    const agent = await createAgent('CompletePublicSwmProviderPlan');
    const internals = agent as any;
    internals.canUseSharedMemoryForContextGraph = async () => true;
    internals.isPrivateContextGraph = async () => false;
    internals.resolveRfc64CompleteSwmProviderPeerIdsV1 = () => [completeProvider];

    await expect(agent.planSharedMemorySyncContextGraphs(
      '12D3KooWUnrelatedEdge',
      [contextGraphId],
      createOperationContext('sync'),
    )).resolves.toEqual({ targets: [] });

    await expect(agent.planSharedMemorySyncContextGraphs(
      completeProvider,
      [contextGraphId],
      createOperationContext('sync'),
    )).resolves.toEqual({
      targets: [{ contextGraphId, lane: 'selected-public' }],
    });
  });

  it('uses an accepted public policy as cold-start authorization for its exact complete provider', async () => {
    const contextGraphId = `${ethers.Wallet.createRandom().address}/selected-public-cold`;
    const ordinaryContextGraphId = `${ethers.Wallet.createRandom().address}/ordinary-public-cold`;
    const completeProvider = '12D3KooWCompleteSwmProvider';
    const agent = await createAgent('CompletePublicSwmColdStartPlan');
    const internals = agent as any;
    internals.canUseSharedMemoryForContextGraph = async () => false;
    internals.isPrivateContextGraph = async () => false;
    internals.resolveRfc64CompleteSwmProviderPeerIdsV1 = (candidate: string) => (
      candidate === contextGraphId ? [completeProvider] : []
    );

    await expect(agent.planSharedMemorySyncContextGraphs(
      completeProvider,
      [ordinaryContextGraphId, contextGraphId],
      createOperationContext('sync'),
      { requireCompleteProviderMatch: true },
    )).resolves.toEqual({
      targets: [{ contextGraphId, lane: 'selected-public' }],
    });
  });

  it('rejects explicit catch-up from a non-authoritative peer when RFC-64 providers are configured', async () => {
    const contextGraphId = `${ethers.Wallet.createRandom().address}/selected-public-fallback`;
    const agent = await createAgent('ExplicitPublicSwmFallbackPlan');
    const internals = agent as any;
    internals.canUseSharedMemoryForContextGraph = async () => true;
    internals.isPrivateContextGraph = async () => false;
    internals.resolveRfc64CompleteSwmProviderPeerIdsV1 = () => ['12D3KooWCompleteSwmProvider'];

    await expect(agent.planSharedMemorySyncContextGraphs(
      '12D3KooWFallbackPeer',
      [contextGraphId],
      createOperationContext('sync'),
    )).resolves.toEqual({ targets: [] });
  });

  it('retains ordinary public union sync when no RFC-64 complete provider is configured', async () => {
    const contextGraphId = `${ethers.Wallet.createRandom().address}/ordinary-public-fallback`;
    const agent = await createAgent('OrdinaryPublicSwmFallbackPlan');
    const internals = agent as any;
    internals.canUseSharedMemoryForContextGraph = async () => true;
    internals.isPrivateContextGraph = async () => false;
    internals.resolveRfc64CompleteSwmProviderPeerIdsV1 = () => [];

    await expect(agent.planSharedMemorySyncContextGraphs(
      '12D3KooWOrdinaryPeer',
      [contextGraphId],
      createOperationContext('sync'),
    )).resolves.toEqual({
      targets: [{ contextGraphId, lane: 'selected-public' }],
    });
  });

  it('does not treat an empty registry after a failed metadata refresh as authoritative', async () => {
    const curator = ethers.Wallet.createRandom().address.toLowerCase();
    const contextGraphId = `${curator}/refresh-failed-plan`;
    const agent = await createAgent('CuratorRecoveryRefreshFailure');
    const internals = agent as unknown as {
      localAgents: Map<string, unknown>;
      discovery: { findAgents: () => Promise<Array<{ agentAddress?: string; peerId: string }>> };
      refreshMetaFromCurator: (contextGraphId: string) => Promise<boolean>;
      resolveCuratorPeerIdsForCg: (contextGraphId: string) => Promise<{
        peerIds: string[];
        curatorIsLocal: boolean;
        legacyTripleResolved: boolean;
        lookupFailed?: boolean;
      }>;
    };
    internals.localAgents.clear();
    let lookups = 0;
    internals.discovery = {
      findAgents: async () => {
        lookups += 1;
        return [];
      },
    };
    internals.refreshMetaFromCurator = async () => false;

    const result = await internals.resolveCuratorPeerIdsForCg(contextGraphId);

    expect(lookups).toBe(2);
    expect(result).toEqual({
      peerIds: [],
      curatorIsLocal: false,
      legacyTripleResolved: false,
      lookupFailed: true,
    });
  });

  it('stops structural curator discovery when its recovery target becomes stale', async () => {
    const curator = ethers.Wallet.createRandom().address.toLowerCase();
    const contextGraphId = `${curator}/stale-curator-plan`;
    const agent = await createAgent('CuratorRecoveryStaleTarget');
    const internals = agent as any;
    internals.localAgents.clear();
    let releaseLookup!: () => void;
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    let lookups = 0;
    let refreshes = 0;
    internals.discovery = {
      findAgents: async () => {
        lookups += 1;
        markLookupStarted();
        await lookupGate;
        return [];
      },
    };
    internals.refreshMetaFromCurator = async () => {
      refreshes += 1;
      return false;
    };
    let current = true;
    const resolution = internals.resolveCuratorPeerIdsForCg(contextGraphId, {
      isCurrent: () => current,
    });

    await lookupStarted;
    current = false;
    releaseLookup();

    await expect(resolution).rejects.toMatchObject({ name: 'AbortError' });
    expect(lookups).toBe(1);
    expect(refreshes).toBe(0);
  });

  it('walks an oversized structural-curator roster with an exclusive peer cursor', async () => {
    const curator = ethers.Wallet.createRandom().address.toLowerCase();
    const contextGraphId = `${curator}/paged-curator-plan`;
    const agent = await createAgent('CuratorRecoveryPagination');
    const pages = [
      ['peer-001', 'peer-002', 'peer-003'],
      ['peer-002', 'peer-003', 'peer-004'],
    ];
    const calls: Array<{ afterPeerId?: string; limit?: number }> = [];
    const internals = agent as any;
    internals.localAgents.clear();
    internals.discovery = {
      findAgentPeerIdsByAddress: async (
        _address: string,
        options: { afterPeerId?: string; limit?: number },
      ) => {
        calls.push(options);
        return pages[calls.length - 1] ?? [];
      },
      findAgents: async () => [],
    };

    const first = await internals.resolveCuratorPeerIdsForCg(contextGraphId, {
      maxPeerIds: 2,
      pagePeerIds: 1,
    });
    const second = await internals.resolveCuratorPeerIdsForCg(contextGraphId, {
      maxPeerIds: 2,
      pagePeerIds: 1,
      afterPeerId: first.nextPageAfterPeerId,
    });

    expect(first).toMatchObject({
      peerIds: ['peer-001'],
      overflowed: true,
      nextPageAfterPeerId: 'peer-001',
    });
    expect(second).toMatchObject({
      peerIds: ['peer-002'],
      overflowed: true,
      nextPageAfterPeerId: 'peer-002',
    });
    expect(calls).toEqual([
      { limit: 3, signal: undefined },
      { afterPeerId: 'peer-001', limit: 2, signal: undefined },
    ]);
  });

  async function createAgent(name: string): Promise<DKGAgent> {
    const agent = await DKGAgent.create({
      name,
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    agents.push(agent);
    return agent;
  }
});

function installPlanningStubs(
  agent: DKGAgent,
  options: {
    localAgent: string;
    curator: string;
    curatorPeers: string[];
    isPrivate: boolean;
    isCuratorOf?: (contextGraphId: string) => Promise<boolean>;
    resolveCuratorPeerId?: (contextGraphId: string) => Promise<string | null>;
  },
): void {
  const anyAgent = agent as unknown as {
    localAgents: Map<string, unknown>;
    canUseSharedMemoryForContextGraph: (contextGraphId: string) => Promise<boolean>;
    isPrivateContextGraph: (contextGraphId: string) => Promise<boolean>;
    refreshMetaFromCurator: (contextGraphId: string) => Promise<void>;
    isCuratorOf: (contextGraphId: string) => Promise<boolean>;
    resolveCuratorPeerId: (contextGraphId: string) => Promise<string | null>;
    discovery: { findAgents: () => Promise<Array<{ agentAddress?: string; peerId: string }>> };
  };

  anyAgent.localAgents.clear();
  anyAgent.localAgents.set(options.localAgent.toLowerCase(), {});
  anyAgent.canUseSharedMemoryForContextGraph = async () => true;
  anyAgent.isPrivateContextGraph = async () => options.isPrivate;
  anyAgent.refreshMetaFromCurator = async () => {};
  anyAgent.isCuratorOf = options.isCuratorOf ?? (async () => false);
  anyAgent.resolveCuratorPeerId = options.resolveCuratorPeerId ?? (async () => null);
  anyAgent.discovery = {
    findAgents: async () => options.curatorPeers.map((peerId) => ({
      agentAddress: options.curator,
      peerId,
    })),
  };
}
