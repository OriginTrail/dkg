/**
 * Pre-flight quorum check for `DKGAgent.registerContextGraph`.
 *
 * Reproduces the operator footgun observed during the Base Sepolia
 * cgId=10/cgId=11 incident:
 *
 *   1. Operator runs `dkg context-graph register <local-name>` against an
 *      existing CG that has no recorded participantIdentityIds in `_meta`.
 *   2. The agent silently falls back to `[selfIdentityId]` and a default
 *      `requiredSignatures = 1`.
 *   3. `ContextGraphStorage.createContextGraph` accepts that on-chain
 *      (it only enforces `requiredSignatures <= hostingNodes.length`).
 *   4. Every subsequent publish reverts inside `KnowledgeAssetsV10.publishDirect`
 *      with `MinSignaturesRequirementNotMet(globalMin, 1)`, where `globalMin`
 *      comes from `ParametersStorage.minimumRequiredSignatures` (e.g. 3 on
 *      production deployments).
 *
 * Outcome: the on-chain CG is permanently broken, the operator paid gas to
 * mint it, and the only error visible to them is the on-chain revert at
 * publish time — minutes/hours/days after the misconfigured registration.
 *
 * The pre-flight check refuses registration when the proposed configuration
 * cannot satisfy the global quorum floor, with an explicit hint.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  MockChainAdapter,
  type CreateOnChainContextGraphParams,
  type CreateOnChainContextGraphResult,
} from '@origintrail-official/dkg-chain';

class CapturingMockChainAdapter extends MockChainAdapter {
  createOnChainContextGraphCalls: CreateOnChainContextGraphParams[] = [];

  async createOnChainContextGraph(
    params: CreateOnChainContextGraphParams,
  ): Promise<CreateOnChainContextGraphResult> {
    this.createOnChainContextGraphCalls.push({
      ...params,
      participantIdentityIds: [...params.participantIdentityIds],
      participantAgents: params.participantAgents ? [...params.participantAgents] : undefined,
    });
    return super.createOnChainContextGraph(params);
  }
}

async function makeAgent(opts: {
  globalMin: number;
}): Promise<{ agent: DKGAgent; chain: CapturingMockChainAdapter; ownerAgent: string }> {
  const chain = new CapturingMockChainAdapter();
  chain.minimumRequiredSignatures = opts.globalMin;
  const agent = await DKGAgent.create({
    name: 'QuorumPreflightBot',
    store: new OxigraphStore(),
    chainAdapter: chain,
    nodeRole: 'core',
  });
  await agent.start();
  const ownerAgent = ethers.getAddress(chain.signerAddress);
  return { agent, chain, ownerAgent };
}

describe('DKGAgent.registerContextGraph — global quorum pre-flight', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    while (agents.length) {
      const a = agents.pop()!;
      await a.stop().catch(() => {});
    }
  });

  it('refuses registration when the silent [self] fallback would violate the global minimum', async () => {
    const { agent, chain, ownerAgent } = await makeAgent({ globalMin: 3 });
    agents.push(agent);

    await agent.createContextGraph({
      id: 'preflight-self-fallback',
      name: 'Self Fallback',
      callerAgentAddress: ownerAgent,
    });

    await expect(agent.registerContextGraph('preflight-self-fallback', { callerAgentAddress: ownerAgent }))
      .rejects.toThrow(
        /global minimum quorum.*is 3.*MinSignaturesRequirementNotMet\(3, 1\)/s,
      );

    expect(chain.createOnChainContextGraphCalls).toEqual([]);
  });

  it('refuses registration when participantIdentityIds.length < globalMin even with explicit participants', async () => {
    const { agent, chain, ownerAgent } = await makeAgent({ globalMin: 3 });
    agents.push(agent);

    await agent.createContextGraph({
      id: 'preflight-too-few-participants',
      name: 'Too Few Participants',
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 2,
      callerAgentAddress: ownerAgent,
    });

    await expect(agent.registerContextGraph('preflight-too-few-participants', { callerAgentAddress: ownerAgent }))
      .rejects.toThrow(/2 hosting nodes but the global minimum quorum.*is 3/s);

    expect(chain.createOnChainContextGraphCalls).toEqual([]);
  });

  it('refuses registration when requiredSignatures < globalMin even with enough participants', async () => {
    const { agent, chain, ownerAgent } = await makeAgent({ globalMin: 3 });
    agents.push(agent);

    await agent.createContextGraph({
      id: 'preflight-low-quorum',
      name: 'Low Quorum',
      participantIdentityIds: [1n, 2n, 3n, 4n],
      requiredSignatures: 1,
      callerAgentAddress: ownerAgent,
    });

    await expect(agent.registerContextGraph('preflight-low-quorum', { callerAgentAddress: ownerAgent }))
      .rejects.toThrow(/requiredSignatures=1 is below the global minimum quorum of 3/);

    expect(chain.createOnChainContextGraphCalls).toEqual([]);
  });

  it('accepts registration when both participants and requiredSignatures meet the global minimum', async () => {
    const { agent, chain, ownerAgent } = await makeAgent({ globalMin: 3 });
    agents.push(agent);

    await agent.createContextGraph({
      id: 'preflight-ok',
      name: 'OK',
      participantIdentityIds: [1n, 2n, 3n],
      requiredSignatures: 3,
      callerAgentAddress: ownerAgent,
    });

    const result = await agent.registerContextGraph('preflight-ok', { callerAgentAddress: ownerAgent });
    expect(result.onChainId).toMatch(/^\d+$/);

    expect(chain.createOnChainContextGraphCalls).toHaveLength(1);
    expect(chain.createOnChainContextGraphCalls[0]).toMatchObject({
      requiredSignatures: 3,
    });
    expect(chain.createOnChainContextGraphCalls[0]?.participantIdentityIds.length).toBe(3);
  });

  it('preserves legacy single-host behaviour when the global minimum is 1', async () => {
    const { agent, chain, ownerAgent } = await makeAgent({ globalMin: 1 });
    agents.push(agent);

    await agent.createContextGraph({
      id: 'preflight-solo-ok',
      name: 'Solo OK',
      callerAgentAddress: ownerAgent,
    });

    const result = await agent.registerContextGraph('preflight-solo-ok', { callerAgentAddress: ownerAgent });
    expect(result.onChainId).toMatch(/^\d+$/);

    expect(chain.createOnChainContextGraphCalls).toHaveLength(1);
  });
});
