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

/**
 * Covers the codex-flagged bypass on PR #374:
 *
 *   The daemon's `/api/context-graph` route calls `registerContextGraphOnChain`
 *   directly (see `packages/cli/src/daemon/routes/context-graph.ts`). Before
 *   this fix the pre-flight only fired in `registerContextGraph`, so an HTTP
 *   client could still mint a permanently-broken CG by hitting the lower
 *   entry point with bad params.
 *
 * The two tests below assert the validation is enforced at the lower layer
 * too, so the bypass is closed at the only chokepoint that all callers must
 * pass through.
 */
describe('DKGAgent.registerContextGraphOnChain — direct-call quorum gate', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    while (agents.length) {
      const a = agents.pop()!;
      await a.stop().catch(() => {});
    }
  });

  it('refuses direct calls with hostingNodes < globalMin (closes the daemon HTTP bypass)', async () => {
    const { agent, chain } = await makeAgent({ globalMin: 3 });
    agents.push(agent);

    await expect(
      agent.registerContextGraphOnChain({
        participantIdentityIds: [1n, 2n],
        requiredSignatures: 2,
      }),
    ).rejects.toThrow(/2 hosting nodes but the global minimum quorum.*is 3/s);

    expect(chain.createOnChainContextGraphCalls).toEqual([]);
  });

  it('refuses direct calls with requiredSignatures < globalMin', async () => {
    const { agent, chain } = await makeAgent({ globalMin: 3 });
    agents.push(agent);

    await expect(
      agent.registerContextGraphOnChain({
        participantIdentityIds: [1n, 2n, 3n, 4n],
        requiredSignatures: 1,
      }),
    ).rejects.toThrow(/requiredSignatures=1 is below the global minimum quorum of 3/);

    expect(chain.createOnChainContextGraphCalls).toEqual([]);
  });

  it('accepts direct calls when both hostingNodes and requiredSignatures meet globalMin', async () => {
    const { agent, chain } = await makeAgent({ globalMin: 3 });
    agents.push(agent);

    const result = await agent.registerContextGraphOnChain({
      participantIdentityIds: [1n, 2n, 3n],
      requiredSignatures: 3,
    });
    expect(result.contextGraphId).toBeDefined();

    expect(chain.createOnChainContextGraphCalls).toHaveLength(1);
  });
});

/**
 * Covers the codex-flagged "swallowed RPC error" footgun on PR #374:
 *
 *   The previous `try { getMinimumRequiredSignatures() } catch { warn-and-continue }`
 *   shape meant that a single transient `eth_call` failure would silently
 *   skip the global-quorum pre-flight, after which the chain's own
 *   `createContextGraph` would happily mint the CG (it doesn't check the
 *   global floor) and every subsequent publish would revert. That's
 *   exactly the bug the pre-flight was supposed to prevent.
 *
 * After the fix, RPC failures throw — fail-closed — so the operator gets
 * an actionable error and no on-chain mint happens. They can retry once
 * RPC is healthy.
 */
describe('DKGAgent — RPC failure when reading minimumRequiredSignatures (fail-closed)', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    while (agents.length) {
      const a = agents.pop()!;
      await a.stop().catch(() => {});
    }
  });

  /**
   * Wraps the mock chain to make `getMinimumRequiredSignatures` reject
   * with a synthetic RPC error.
   */
  function makeRpcFailingChain(): CapturingMockChainAdapter {
    const chain = new CapturingMockChainAdapter();
    chain.getMinimumRequiredSignatures = async () => {
      throw new Error('synthetic RPC failure: eth_call timed out');
    };
    return chain;
  }

  it('throws (fail-closed) instead of silently proceeding when getMinimumRequiredSignatures rejects', async () => {
    const chain = makeRpcFailingChain();
    const agent = await DKGAgent.create({
      name: 'FailClosedBot',
      store: new OxigraphStore(),
      chainAdapter: chain,
      nodeRole: 'core',
    });
    await agent.start();
    agents.push(agent);

    await expect(
      agent.registerContextGraphOnChain({
        participantIdentityIds: [1n, 2n, 3n],
        requiredSignatures: 3,
      }),
    ).rejects.toThrow(
      /failed to read minimumRequiredSignatures floor.*synthetic RPC failure.*Refusing to proceed \(fail-closed\)/s,
    );

    expect(chain.createOnChainContextGraphCalls).toEqual([]);
  });

  it('also fails closed in the high-level registerContextGraph path', async () => {
    const chain = makeRpcFailingChain();
    const agent = await DKGAgent.create({
      name: 'FailClosedBotHL',
      store: new OxigraphStore(),
      chainAdapter: chain,
      nodeRole: 'core',
    });
    await agent.start();
    agents.push(agent);
    const ownerAgent = ethers.getAddress(chain.signerAddress);

    await agent.createContextGraph({
      id: 'fail-closed-hl',
      name: 'Fail Closed HL',
      participantIdentityIds: [1n, 2n, 3n],
      requiredSignatures: 3,
      callerAgentAddress: ownerAgent,
    });

    await expect(
      agent.registerContextGraph('fail-closed-hl', { callerAgentAddress: ownerAgent }),
    ).rejects.toThrow(/failed to read minimumRequiredSignatures floor.*Refusing to proceed \(fail-closed\)/s);

    expect(chain.createOnChainContextGraphCalls).toEqual([]);
  });
});
