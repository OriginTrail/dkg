import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  memoizeActivePublicContextGraphChainProof,
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
    (id, operationContext) => agent.resolveFinalizedOnChainAccessPolicyState(
      id,
      operationContext,
    ),
    contextGraphId,
    createOperationContext('init'),
  );
}

describe('active-public Context Graph chain proof', () => {
  it('binds one memoized proof to one graph across init and sync consumers', async () => {
    const resolveProof = vi.fn(async () => ({ state: 'public' } as const));
    const boundProof = memoizeActivePublicContextGraphChainProof(
      'graph-a',
      resolveProof,
    );

    await expect(boundProof(createOperationContext('init'))).resolves.toEqual({
      state: 'public',
    });
    await expect(boundProof(createOperationContext('sync'))).resolves.toEqual({
      state: 'public',
    });
    expect(resolveProof).toHaveBeenCalledTimes(1);
    expect(resolveProof).toHaveBeenCalledWith('graph-a', expect.any(Object));
  });

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
      )).resolves.toEqual(expected);
      expect(resolvePolicyState).toHaveBeenCalledWith(
        'test-context-graph',
        operationContext,
      );
    },
  );

  it('classifies a name-hash transport failure as one RPC-failure proof', async () => {
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

    await expect(resolveStrictPublicProof(agent, 'hash-rpc-failure')).resolves.toEqual({
      state: 'unknown',
      reason: 'rpc-failure',
      detail: 'RPC endpoints exhausted',
    });
    expect(getContextGraphNameHash).toHaveBeenCalledWith(42n);
    expect(getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('reuses one finalized authority snapshot instead of point-reading identity and policy', async () => {
    const contextGraphId = 'indexed/public-cg';
    const getContextGraphNameHash = vi.fn(async () => {
      throw new Error('point name-hash read must not run');
    });
    const getContextGraphAccessPolicy = vi.fn(async () => {
      throw new Error('point policy read must not run');
    });
    const isContextGraphActiveOnChain = vi.fn(async () => {
      throw new Error('point liveness read must not run');
    });
    const readBatchedSnapshot = vi.fn(async () => ({
      contextGraphId: '42',
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
      active: true,
      accessPolicy: 0,
    }));
    const agent = createChainProofAgentFixture({
      chain: {
        contextGraphAuthorityIndexRevisionReader: {},
        getContextGraphNameHash,
        getContextGraphAccessPolicy,
        isContextGraphActiveOnChain,
      },
      getContextGraphOnChainId: async () => '42',
    });
    Object.assign(agent, {
      readRfc64BatchedFinalizedAuthoritySnapshotV1: readBatchedSnapshot,
    });

    await expect(resolveStrictPublicProof(agent, contextGraphId)).resolves.toEqual({
      state: 'public',
    });
    expect(readBatchedSnapshot).toHaveBeenCalledWith('42');
    expect(getContextGraphNameHash).not.toHaveBeenCalled();
    expect(isContextGraphActiveOnChain).not.toHaveBeenCalled();
    expect(getContextGraphAccessPolicy).not.toHaveBeenCalled();
    expect((agent as any).onChainAccessPolicyCache.get('42')).toBe(0);
  });

  it('keeps the SWM plaintext policy seam on fresh current-state reads', async () => {
    const contextGraphId = 'indexed/current-private-cg';
    const committedNameHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId));
    const getContextGraphNameHash = vi.fn(async () => committedNameHash);
    const getContextGraphAccessPolicy = vi.fn(async () => 1 as const);
    const isContextGraphActiveOnChain = vi.fn(async () => true);
    const readBatchedSnapshot = vi.fn(async () => ({
      contextGraphId: '42',
      nameHash: committedNameHash,
      active: true,
      accessPolicy: 0,
    }));
    const agent = createChainProofAgentFixture({
      chain: {
        contextGraphAuthorityIndexRevisionReader: {},
        getContextGraphNameHash,
        getContextGraphAccessPolicy,
        isContextGraphActiveOnChain,
      },
      getContextGraphOnChainId: async () => '42',
    });
    Object.assign(agent, {
      readRfc64BatchedFinalizedAuthoritySnapshotV1: readBatchedSnapshot,
    });

    await expect(agent.isContextGraphPublicOnChain(contextGraphId)).resolves.toBe(false);
    expect(readBatchedSnapshot).not.toHaveBeenCalled();
    expect(getContextGraphNameHash).toHaveBeenCalledWith(42n);
    expect(isContextGraphActiveOnChain).toHaveBeenCalledWith(42n);
    expect(getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
  });

  it.each([
    ['wrong slot', {
      contextGraphId: '43',
      nameHash: ethers.keccak256(ethers.toUtf8Bytes('indexed/public-cg')),
      active: true,
      accessPolicy: 0,
    }],
    ['inactive slot', {
      contextGraphId: '42',
      nameHash: ethers.keccak256(ethers.toUtf8Bytes('indexed/public-cg')),
      active: false,
      accessPolicy: 0,
    }],
    ['reused slot', {
      contextGraphId: '42',
      nameHash: ethers.keccak256(ethers.toUtf8Bytes('unrelated/cg')),
      active: true,
      accessPolicy: 0,
    }],
  ] as const)('fails closed on an indexed %s', async (_label, snapshot) => {
    const getContextGraphNameHash = vi.fn(async () => snapshot.nameHash);
    const getContextGraphAccessPolicy = vi.fn(async () => 0 as const);
    const agent = createChainProofAgentFixture({
      chain: {
        contextGraphAuthorityIndexRevisionReader: {},
        getContextGraphNameHash,
        getContextGraphAccessPolicy,
        isContextGraphActiveOnChain: vi.fn(async () => true),
      },
      getContextGraphOnChainId: async () => '42',
    });
    Object.assign(agent, {
      readRfc64BatchedFinalizedAuthoritySnapshotV1: vi.fn(async () => snapshot),
    });

    await expect(resolveStrictPublicProof(agent, 'indexed/public-cg')).resolves.toEqual({
      state: 'unknown',
      reason: 'unprovable',
    });
    expect(getContextGraphNameHash).not.toHaveBeenCalled();
    expect(getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('classifies a finalized authority batch rejection as an RPC failure', async () => {
    const rpcError = Object.assign(new Error('authority batch unavailable'), {
      code: 'RPC_ENDPOINTS_EXHAUSTED',
    });
    const agent = createChainProofAgentFixture({
      chain: { contextGraphAuthorityIndexRevisionReader: {} },
      getContextGraphOnChainId: async () => '42',
    });
    Object.assign(agent, {
      readRfc64BatchedFinalizedAuthoritySnapshotV1: vi.fn(async () => {
        throw rpcError;
      }),
    });

    await expect(resolveStrictPublicProof(agent, 'indexed/public-cg')).resolves.toEqual({
      state: 'unknown',
      reason: 'rpc-failure',
      detail: 'authority batch unavailable',
    });
  });

  it('does not start an authority batch for an unregistered local graph', async () => {
    const readBatchedSnapshot = vi.fn();
    const agent = createChainProofAgentFixture({
      chain: { contextGraphAuthorityIndexRevisionReader: {} },
      getContextGraphOnChainId: async () => null,
      contextGraphExists: async () => true,
    });
    Object.assign(agent, {
      readRfc64BatchedFinalizedAuthoritySnapshotV1: readBatchedSnapshot,
    });

    await expect(resolveStrictPublicProof(agent, 'local/unregistered')).resolves.toEqual({
      state: 'not-public',
      reason: 'unregistered',
    });
    expect(readBatchedSnapshot).not.toHaveBeenCalled();
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
