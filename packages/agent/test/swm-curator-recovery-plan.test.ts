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

    expect(plan.publicContextGraphIds).toEqual([]);
    expect(plan.privateRecoverFromCurator).toEqual([contextGraphId]);
    expect(plan.eligibleContextGraphIds).toEqual([contextGraphId]);
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

    expect(plan.publicContextGraphIds).toEqual([]);
    expect(plan.privateRecoverFromCurator).toEqual([]);
    expect(plan.eligibleContextGraphIds).toEqual([]);
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
