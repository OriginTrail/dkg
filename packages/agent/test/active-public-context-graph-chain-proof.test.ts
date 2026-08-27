import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  resolveActivePublicContextGraphChainProof,
  type OnChainAccessPolicyState,
} from '../src/active-public-context-graph-chain-proof.js';

interface ChainProofAgentFixtureInput {
  readonly chain: Record<string, unknown>;
  readonly getContextGraphOnChainId: (contextGraphId: string) => Promise<string | null>;
  readonly contextGraphExists?: (contextGraphId: string) => Promise<boolean>;
}

function createChainProofAgentFixture(input: ChainProofAgentFixtureInput): DKGAgent {
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  Object.assign(agent, {
    chain: input.chain,
    getContextGraphOnChainId: input.getContextGraphOnChainId,
    contextGraphExists: input.contextGraphExists ?? (async () => false),
    subscribedContextGraphs: new Map(),
    wireIdToLocalCgId: new Map(),
    onChainAccessPolicyCache: new Map(),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  });
  return agent;
}

function resolveStrictPublicProof(
  agent: DKGAgent,
  contextGraphId: string,
) {
  return resolveActivePublicContextGraphChainProof(
    (id, operationContext, options) => agent.resolveOnChainAccessPolicyState(
      id,
      operationContext,
      options,
    ),
    contextGraphId,
    createOperationContext('init'),
    'chain-attested-repair',
  );
}

describe('active-public Context Graph chain proof', () => {
  it.each([
    [0, { state: 'public' }],
    [1, { state: 'not-public', reason: 'private' }],
    ['unregistered', { state: 'not-public', reason: 'unregistered' }],
    ['unknown', { state: 'unknown', reason: 'unprovable' }],
  ] as const)(
    'maps policy state %s through one operation-aware resolver',
    async (state, expected) => {
      const operationContext = createOperationContext('init');
      const resolvePolicyState = vi.fn(async () => state as OnChainAccessPolicyState);

      await expect(resolveActivePublicContextGraphChainProof(
        resolvePolicyState,
        'test-context-graph',
        operationContext,
        'chain-attested-repair',
      )).resolves.toEqual(expected);
      expect(resolvePolicyState).toHaveBeenCalledWith(
        'test-context-graph',
        operationContext,
        { slotBindingMode: 'chain-attested-repair' },
      );
    },
  );

  it('propagates name-hash transport failures for RPC classification', async () => {
    const getContextGraphNameHash = vi.fn(async () => {
      throw Object.assign(new Error('RPC endpoints exhausted'), {
        code: 'RPC_ENDPOINTS_EXHAUSTED',
      });
    });
    const getContextGraphAccessPolicy = vi.fn(async () => 0 as const);
    const agent = createChainProofAgentFixture({
      chain: {
        getContextGraphNameHash,
        getContextGraphAccessPolicy,
        isContextGraphActiveOnChain: vi.fn(async () => true),
      },
      getContextGraphOnChainId: async () => '42',
    });

    await expect(resolveStrictPublicProof(agent, 'hash-rpc-failure'))
      .rejects.toThrow('RPC endpoints exhausted');
    expect(getContextGraphNameHash).toHaveBeenCalledWith(42n);
    expect(getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('requires a name-hash proof for a numeric local mapping but permits a raw slot', async () => {
    const getContextGraphNameHash = vi.fn(async () => (
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ));
    const getContextGraphAccessPolicy = vi.fn(async () => 0 as const);
    const getContextGraphOnChainId = vi.fn()
      .mockResolvedValueOnce('42')
      .mockResolvedValueOnce(null);
    const agent = createChainProofAgentFixture({
      chain: {
        getContextGraphNameHash,
        getContextGraphAccessPolicy,
        isContextGraphActiveOnChain: vi.fn(async () => true),
      },
      getContextGraphOnChainId,
      contextGraphExists: async () => false,
    });

    await expect(resolveStrictPublicProof(agent, '42')).resolves.toEqual({
      state: 'unknown',
      reason: 'unprovable',
    });
    expect(getContextGraphAccessPolicy).not.toHaveBeenCalled();

    await expect(resolveStrictPublicProof(agent, '42')).resolves.toEqual({
      state: 'public',
    });
    expect(getContextGraphNameHash).toHaveBeenCalledTimes(1);
    expect(getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
  });

  it('rejects a persisted local mapping after its chain slot is reused', async () => {
    const contextGraphId = 'legacy-public/reused-slot';
    const committedHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId));
    const reusedSlotHash = ethers.keccak256(ethers.toUtf8Bytes('unrelated/reused-slot'));
    const getContextGraphNameHash = vi.fn()
      .mockResolvedValueOnce(committedHash)
      .mockResolvedValueOnce(reusedSlotHash);
    const getContextGraphAccessPolicy = vi.fn(async () => 0 as const);
    const agent = createChainProofAgentFixture({
      chain: {
        getContextGraphNameHash,
        getContextGraphAccessPolicy,
        isContextGraphActiveOnChain: vi.fn(async () => true),
      },
      getContextGraphOnChainId: async () => '42',
      contextGraphExists: async () => true,
    });

    await expect(resolveStrictPublicProof(agent, contextGraphId)).resolves.toEqual({
      state: 'public',
    });
    await expect(resolveStrictPublicProof(agent, contextGraphId)).resolves.toEqual({
      state: 'unknown',
      reason: 'unprovable',
    });
    expect(getContextGraphNameHash).toHaveBeenCalledTimes(2);
    expect(getContextGraphAccessPolicy).toHaveBeenCalledTimes(1);
  });
});
