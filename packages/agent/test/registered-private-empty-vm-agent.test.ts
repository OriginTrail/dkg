import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/dkg-agent.js';
import { RegisteredPrivateEmptyVmMethods } from '../src/dkg-agent-registered-private-empty-vm.js';

const mocks = vi.hoisted(() => ({
  proof: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('../src/rfc64/registered-private-empty-vm-proof-v1.js', () => ({
  proveRegisteredPrivateEmptyVmV1: mocks.proof,
}));
vi.mock('@origintrail-official/dkg-chain', async (importOriginal) => ({
  ...await importOriginal<typeof import('@origintrail-official/dkg-chain')>(),
  createStrictCurrentFinalizedEvmSnapshotScopeV1: mocks.snapshot,
}));

const CG = 'example-private-graph';
const CALLER = `0x${'11'.repeat(20)}`;

function fixture() {
  let metadataRevision = '0:0';
  const authority = vi.fn(async () => ({
    outcome: 'allowed', source: 'registered-chain', onChainId: 3n,
  }));
  const chainSnapshot = vi.fn(async () => ({
    chainId: '31337', contextGraphId: '3', active: true, accessPolicy: 1,
    governanceContract: `0x${'22'.repeat(20)}`,
  }));
  const subscriptions = new Map([[CG, { subscribed: true }]]);
  const agent = {
    subscribedContextGraphs: subscriptions,
    resolveContextGraphSubscriptionBootstrapAuthority: authority,
    config: { chainConfig: {
      rpcUrl: 'http://127.0.0.1:8545', chainId: 'evm:31337',
      hubAddress: `0x${'33'.repeat(20)}`,
    } },
    chain: {
      getFinalityConfirmations: () => 1,
      getContextGraphAuthoritySnapshot: chainSnapshot,
    },
    contextGraphMetaProjection: {
      readContextGraphAuthorityFactsRevision: () => metadataRevision,
    },
    hasConfirmedMetaState: vi.fn(async () => true),
    isPrivateContextGraph: vi.fn(async () => true),
  } as unknown as DKGAgent;
  return {
    authority, chainSnapshot, subscriptions, agent,
    invalidateMetadata: () => { metadataRevision = '0:1'; },
  };
}

async function prove(agent: DKGAgent) {
  return RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
    .call(agent, CG, CALLER);
}

describe('registered private empty-VM agent guard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.snapshot.mockReturnValue(async () => true);
    mocks.proof.mockResolvedValue(true);
  });

  it('rechecks registered chain authority around the pinned proof', async () => {
    const state = fixture();
    expect(await prove(state.agent)).toBe(true);
    expect(state.authority).toHaveBeenCalledTimes(2);
    expect(state.chainSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.proof).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId: CG, onChainContextGraphId: '3', callerAgentAddress: CALLER,
      chainId: '31337',
    }));
  });

  it('never asks chain proof for an unsubscribed or non-admitted caller', async () => {
    const state = fixture();
    state.subscriptions.get(CG)!.subscribed = false;
    expect(await prove(state.agent)).toBe(false);
    state.subscriptions.get(CG)!.subscribed = true;
    state.authority.mockResolvedValueOnce({
      outcome: 'denied', source: 'registered-chain', onChainId: 3n,
    });
    expect(await prove(state.agent)).toBe(false);
    expect(mocks.proof).not.toHaveBeenCalled();
  });

  it('rejects an unrelated chain authority or a live authority change', async () => {
    const state = fixture();
    state.chainSnapshot.mockResolvedValueOnce({
      chainId: '31337', contextGraphId: '3', active: false, accessPolicy: 1,
      governanceContract: `0x${'22'.repeat(20)}`,
    });
    expect(await prove(state.agent)).toBe(false);
    state.chainSnapshot.mockResolvedValueOnce({
      chainId: '1', contextGraphId: '3', active: true, accessPolicy: 1,
      governanceContract: `0x${'22'.repeat(20)}`,
    });
    expect(await prove(state.agent)).toBe(false);
    state.authority.mockReset()
      .mockResolvedValueOnce({ outcome: 'allowed', source: 'registered-chain', onChainId: 3n })
      .mockResolvedValueOnce({ outcome: 'unavailable', source: 'registered-chain', onChainId: 3n });
    expect(await prove(state.agent)).toBe(false);
  });

  it('fails closed when the finalized read errors', async () => {
    const state = fixture();
    mocks.proof.mockRejectedValue(new Error('read unavailable'));
    expect(await prove(state.agent)).toBe(false);
  });

  it('does not commit readiness if metadata is invalidated during chain proof', async () => {
    const state = fixture();
    const commit = vi.fn();
    mocks.proof.mockImplementationOnce(async () => {
      state.invalidateMetadata();
      return true;
    });
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits synchronously after the final metadata fence', async () => {
    const state = fixture();
    const commit = vi.fn(state.invalidateMetadata);
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not commit a proof that completes after the caller deadline', async () => {
    const state = fixture();
    const deadline = new AbortController();
    const commit = vi.fn();
    mocks.proof.mockImplementationOnce(async () => {
      deadline.abort();
      return true;
    });
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit, deadline.signal)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(state.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ signal: deadline.signal }));
  });
});
