import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/dkg-agent.js';
import {
  RegisteredPrivateEmptyVmMethods,
  type InspectedContextGraphReadinessV1,
} from '../src/dkg-agent-registered-private-empty-vm.js';

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
const NAME_HASH = `0x${'44'.repeat(32)}`;

function fixture() {
  let metadataRevision = '0:0';
  const isPrivate = vi.fn(async () => true);
  const authority = vi.fn(async () => ({
    outcome: 'allowed', source: 'registered-chain', onChainId: 3n,
  }));
  const chainSnapshot = vi.fn(async () => ({
    expectedNameHash: NAME_HASH, expectedOnChainId: 3n,
    snapshot: {
      chainId: '31337', contextGraphId: '3', active: true, accessPolicy: 1,
      governanceContract: `0x${'22'.repeat(20)}`, nameHash: NAME_HASH,
    },
  }));
  const subscriptions = new Map([[CG, { subscribed: true }]]);
  const projection = {
    readContextGraphAuthorityFactsRevision: (_contextGraphId: string) => metadataRevision,
  };
  const agent = {
    subscribedContextGraphs: subscriptions,
    resolveContextGraphSubscriptionBootstrapAuthority: authority,
    inspectAndCommitContextGraphReadinessV1:
      RegisteredPrivateEmptyVmMethods.prototype.inspectAndCommitContextGraphReadinessV1,
    inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1:
      RegisteredPrivateEmptyVmMethods.prototype.inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1,
    readRfc64RegisteredAuthoritySnapshotV1: chainSnapshot,
    contextGraphAuthorityReaderCapability: { status: 'supported', reader: {} },
    config: { chainConfig: {
      rpcUrl: 'http://127.0.0.1:8545', chainId: 'evm:31337',
      hubAddress: `0x${'33'.repeat(20)}`,
    } },
    chain: {
      getFinalityConfirmations: () => 1,
    },
    contextGraphMetaProjection: projection,
    hasConfirmedMetaState: vi.fn(async () => true),
    isPrivateContextGraph: isPrivate,
  } as unknown as DKGAgent;
  return {
    authority, chainSnapshot, subscriptions, projection, agent, isPrivate,
    invalidateMetadata: () => { metadataRevision = '0:1'; },
    readMetadataRevision: () => metadataRevision,
  };
}

async function prove(agent: DKGAgent) {
  const result = await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
    .call(agent, CG, CALLER, () => undefined);
  return result.proven;
}

describe('registered private empty-VM agent guard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.snapshot.mockReturnValue(async () => true);
    mocks.proof.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('downgrades an invalidated inspection before its synchronous callback', async () => {
    const state = fixture();
    state.isPrivate.mockImplementationOnce(async () => {
      state.invalidateMetadata();
      return true;
    });
    const commit = vi.fn((inspection: InspectedContextGraphReadinessV1) => inspection);
    const inspected = await RegisteredPrivateEmptyVmMethods.prototype.inspectAndCommitContextGraphReadinessV1
      .call(state.agent, {
        contextGraphId: CG, inspectMetadata: true,
        callerAgentAddress: CALLER,
      }, commit);
    expect(inspected).toEqual({
      current: false, hasConfirmedMeta: undefined, isPrivate: false,
      authority: { outcome: 'unavailable' },
    });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('downgrades a completion whose subscription is removed during a live authority read', async () => {
    const state = fixture();
    state.authority.mockImplementationOnce(async () => {
      state.subscriptions.get(CG)!.subscribed = false;
      return { outcome: 'allowed', source: 'registered-chain', onChainId: 3n };
    });
    const inspect = vi.fn((facts: InspectedContextGraphReadinessV1) => facts);
    const result = await RegisteredPrivateEmptyVmMethods.prototype.inspectAndCommitContextGraphReadinessV1
      .call(state.agent, {
        contextGraphId: CG, inspectMetadata: true,
        callerAgentAddress: CALLER,
      }, inspect);
    expect(result).toMatchObject({
      current: false, hasConfirmedMeta: undefined, isPrivate: false,
      authority: { outcome: 'unavailable' },
    });
    expect(state.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ freshness: 'live' }));
  });

  it('downgrades a completion when the final metadata revision cannot be read', async () => {
    const state = fixture();
    state.projection.readContextGraphAuthorityFactsRevision = vi.fn()
      .mockReturnValueOnce('0:0')
      .mockImplementationOnce(() => { throw new Error('metadata store unavailable'); });
    const inspect = vi.fn((facts: InspectedContextGraphReadinessV1) => facts);
    const result = await RegisteredPrivateEmptyVmMethods.prototype.inspectAndCommitContextGraphReadinessV1
      .call(state.agent, {
        contextGraphId: CG, inspectMetadata: true,
        callerAgentAddress: CALLER,
      }, inspect);
    expect(result).toMatchObject({
      current: false, hasConfirmedMeta: undefined, isPrivate: false,
      authority: { outcome: 'unavailable' },
    });
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('withholds confirmed or allowed facts when inspection dependencies fail', async () => {
    const cases = [
      {
        fail: (state: ReturnType<typeof fixture>) => {
          vi.mocked(state.agent.hasConfirmedMetaState).mockRejectedValue(new Error('metadata unavailable'));
        },
        expected: { hasConfirmedMeta: undefined, isPrivate: false, authority: { outcome: 'allowed' } },
      },
      {
        fail: (state: ReturnType<typeof fixture>) => {
          state.isPrivate.mockRejectedValue(new Error('policy unavailable'));
        },
        expected: { hasConfirmedMeta: undefined, isPrivate: true, authority: { outcome: 'allowed' } },
      },
      {
        fail: (state: ReturnType<typeof fixture>) => {
          state.authority.mockRejectedValue(new Error('chain unavailable'));
        },
        expected: { hasConfirmedMeta: true, isPrivate: true, authority: { outcome: 'unavailable' } },
      },
    ];
    for (const { fail, expected } of cases) {
      const state = fixture();
      fail(state);
      const result = await RegisteredPrivateEmptyVmMethods.prototype.inspectAndCommitContextGraphReadinessV1
        .call(state.agent, {
          contextGraphId: CG, inspectMetadata: true,
          callerAgentAddress: CALLER,
        }, (facts) => facts);
      expect(result).toMatchObject({ current: true, ...expected });
    }
  });

  it('never commits a zero-VM proof when private-policy inspection fails after it', async () => {
    const state = fixture();
    const commit = vi.fn();
    state.isPrivate.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('policy unavailable'));
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false });
    expect(commit).not.toHaveBeenCalled();
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

  it('returns the synchronous persistence callback value only after proof', async () => {
    const state = fixture();
    const commit = vi.fn(() => 'readiness-written');
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: true, value: 'readiness-written' });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      current: true, hasConfirmedMeta: true, isPrivate: true,
      authority: expect.objectContaining({ outcome: 'allowed', source: 'registered-chain' }),
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
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, () => undefined)).toEqual({ proven: false });
    expect(mocks.proof).not.toHaveBeenCalled();
  });

  it('retries an unconfirmed metadata read without treating it as authorization', async () => {
    const state = fixture();
    vi.mocked(state.agent.hasConfirmedMetaState).mockResolvedValueOnce(false);
    const commit = vi.fn();
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false, retryable: true });
    expect(state.authority).toHaveBeenCalledOnce();
    expect(state.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ freshness: 'live' }));
    expect(mocks.proof).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('treats a final live denial as terminal even after transient metadata', async () => {
    const state = fixture();
    vi.mocked(state.agent.hasConfirmedMetaState).mockResolvedValueOnce(false);
    state.authority.mockResolvedValueOnce({ outcome: 'denied' });
    const commit = vi.fn();
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false });
    expect(state.authority).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('retries unavailable authority but never a definitive denial', async () => {
    const state = fixture();
    const commit = vi.fn();
    state.authority.mockResolvedValueOnce({ outcome: 'unavailable' });
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false, retryable: true });
    state.authority.mockResolvedValueOnce({ outcome: 'denied' });
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false });
    expect(mocks.proof).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not prove a graph whose metadata is public or changes during inspection', async () => {
    const state = fixture();
    state.isPrivate.mockResolvedValueOnce(false);
    expect(await prove(state.agent)).toBe(false);
    state.isPrivate.mockImplementationOnce(async () => {
      state.invalidateMetadata();
      return true;
    });
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, () => undefined))
      .toEqual({ proven: false, retryable: true });
    expect(state.authority).toHaveBeenCalledTimes(2);
    expect(state.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ freshness: 'live' }));
    expect(mocks.proof).not.toHaveBeenCalled();
    expect(await prove(state.agent)).toBe(true);
  });

  it('requires the bound authority capability and valid local chain binding', async () => {
    const state = fixture();
    Reflect.set(state.agent, 'contextGraphAuthorityReaderCapability', { status: 'unsupported' });
    expect(await prove(state.agent)).toBe(false);
    Reflect.set(state.agent, 'contextGraphAuthorityReaderCapability', { status: 'supported', reader: {} });
    state.chainSnapshot.mockResolvedValueOnce(null as never);
    expect(await prove(state.agent)).toBe(false);
    const config = state.agent.config.chainConfig as { chainId: string; hubAddress: string };
    config.chainId = 'not-an-evm-chain';
    expect(await prove(state.agent)).toBe(false);
    config.chainId = `evm:${1n << 256n}`;
    expect(await prove(state.agent)).toBe(false);
    config.chainId = 'evm:31337';
    config.hubAddress = 'not-an-address';
    expect(await prove(state.agent)).toBe(false);
    config.hubAddress = `0x${'00'.repeat(20)}`;
    expect(await prove(state.agent)).toBe(false);
    expect(state.chainSnapshot).toHaveBeenCalledOnce();
    expect(mocks.proof).not.toHaveBeenCalled();
  });

  it('rejects an unrelated chain authority or a live authority change', async () => {
    const state = fixture();
    state.chainSnapshot.mockResolvedValueOnce({
      expectedNameHash: NAME_HASH, expectedOnChainId: 4n,
      snapshot: {
        chainId: '31337', contextGraphId: '3', active: true, accessPolicy: 1,
        governanceContract: `0x${'22'.repeat(20)}`, nameHash: NAME_HASH,
      },
    });
    expect(await prove(state.agent)).toBe(false);
    state.chainSnapshot.mockResolvedValueOnce({
      expectedNameHash: NAME_HASH, expectedOnChainId: 3n,
      snapshot: {
        chainId: '31337', contextGraphId: '3', active: true, accessPolicy: 1,
        governanceContract: `0x${'22'.repeat(20)}`, nameHash: `0x${'55'.repeat(32)}`,
      },
    });
    expect(await prove(state.agent)).toBe(false);
    state.chainSnapshot.mockResolvedValueOnce({
      expectedNameHash: NAME_HASH, expectedOnChainId: 3n,
      snapshot: {
        chainId: '31337', contextGraphId: '3', active: false, accessPolicy: 1,
        governanceContract: `0x${'22'.repeat(20)}`, nameHash: NAME_HASH,
      },
    });
    expect(await prove(state.agent)).toBe(false);
    state.chainSnapshot.mockResolvedValueOnce({
      expectedNameHash: NAME_HASH, expectedOnChainId: 3n,
      snapshot: {
        chainId: '1', contextGraphId: '3', active: true, accessPolicy: 1,
        governanceContract: `0x${'22'.repeat(20)}`, nameHash: NAME_HASH,
      },
    });
    expect(await prove(state.agent)).toBe(false);
    state.authority.mockReset()
      .mockResolvedValueOnce({ outcome: 'allowed', source: 'registered-chain', onChainId: 3n })
      .mockResolvedValueOnce({ outcome: 'unavailable', source: 'registered-chain', onChainId: 3n });
    expect(await prove(state.agent)).toBe(false);
    state.authority.mockReset()
      .mockResolvedValueOnce({ outcome: 'allowed', source: 'registered-chain', onChainId: 3n })
      .mockResolvedValueOnce({
        outcome: 'allowed', source: 'registered-chain', onChainId: 3n,
        registration: 'unregistered',
      });
    expect(await prove(state.agent)).toBe(false);
  });

  it('fails closed when the finalized read errors', async () => {
    const state = fixture();
    mocks.proof.mockRejectedValue(new Error('read unavailable'));
    expect(await prove(state.agent)).toBe(false);
  });

  it('never commits a negative finalized zero-VM proof', async () => {
    const state = fixture();
    const commit = vi.fn();
    mocks.proof.mockResolvedValueOnce(false);
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false });
    expect(mocks.proof).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('delivers a failed proof and final live denial to one fenced completion callback', async () => {
    const state = fixture();
    const commit = vi.fn((inspection: InspectedContextGraphReadinessV1, proof: { proven: boolean }) => ({
      inspection, proof,
    }));
    mocks.proof.mockResolvedValueOnce(false);
    state.authority.mockResolvedValueOnce({
      outcome: 'allowed', source: 'registered-chain', onChainId: 3n,
    }).mockResolvedValueOnce({ outcome: 'denied' });
    const result = await RegisteredPrivateEmptyVmMethods.prototype
      .inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1.call(state.agent, {
        contextGraphId: CG, inspectMetadata: true, attemptPrivateEmptyVm: true,
        callerAgentAddress: CALLER,
      }, commit);
    expect(commit).toHaveBeenCalledOnce();
    expect(state.authority).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      inspection: expect.objectContaining({
        current: true, authority: { outcome: 'denied' },
      }),
      proof: { proven: false },
    });
  });

  it('does not commit readiness if metadata is invalidated during chain proof', async () => {
    const state = fixture();
    const commit = vi.fn();
    mocks.proof.mockImplementationOnce(async () => {
      state.invalidateMetadata();
      return true;
    });
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false, retryable: true });
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not commit when the graph becomes public after the finalized proof', async () => {
    const state = fixture();
    const commit = vi.fn();
    state.isPrivate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false });
    expect(mocks.proof).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not commit when live authority is revoked during final metadata inspection', async () => {
    const state = fixture();
    const commit = vi.fn();
    let revoke!: () => void;
    const revoked = new Promise<void>((resolve) => { revoke = resolve; });
    let finalMetadata = 0;
    vi.mocked(state.agent.hasConfirmedMetaState).mockImplementation(async () => {
      finalMetadata += 1;
      if (finalMetadata === 2) {
        state.authority.mockResolvedValue({ outcome: 'denied' });
        revoke();
        await revoked;
      }
      return true;
    });
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false });
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not persist after a newer on-chain removal hidden by a bounded roster', async () => {
    const state = fixture();
    const commit = vi.fn();
    let removedOnChain = false;
    state.authority.mockImplementation(async (_id, opts?: { freshness?: 'live' | 'bounded' }) => (
      removedOnChain && opts?.freshness === 'live'
        ? { outcome: 'denied', source: 'registered-chain', onChainId: 3n }
        : { outcome: 'allowed', source: 'registered-chain', onChainId: 3n }
    ));
    mocks.proof.mockImplementationOnce(async () => {
      removedOnChain = true;
      return true;
    });
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: false });
    expect(state.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ freshness: 'live' }));
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits synchronously before a microtask can invalidate the final metadata fence', async () => {
    const state = fixture();
    const { projection } = state;
    const originalRead = projection.readContextGraphAuthorityFactsRevision.bind(projection);
    let reads = 0;
    projection.readContextGraphAuthorityFactsRevision = vi.fn((id: string) => {
      const revision = originalRead(id);
      if (++reads === 3) queueMicrotask(state.invalidateMetadata);
      return revision;
    });
    const revisionAtCommit: string[] = [];
    const commit = vi.fn(() => { revisionAtCommit.push(state.readMetadataRevision()); });
    expect(await RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).toEqual({ proven: true, value: undefined });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(revisionAtCommit).toEqual(['0:0']);
    expect(state.readMetadataRevision()).toBe('0:1');
  });

  it('leaves a caller-owned persistence failure visible after a valid proof', async () => {
    const state = fixture();
    const failure = new Error('readiness persistence unavailable');
    const commit = vi.fn(() => { throw failure; });
    await expect(RegisteredPrivateEmptyVmMethods.prototype.proveRegisteredPrivateEmptyVmV1
      .call(state.agent, CG, CALLER, commit)).rejects.toBe(failure);
    expect(mocks.proof).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps the optional diagnostic trace generic when admission fails', async () => {
    const state = fixture();
    state.subscriptions.get(CG)!.subscribed = false;
    vi.stubEnv('DKG_DEBUG_PRIVATE_EMPTY_VM', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await prove(state.agent)).toBe(false);
    expect(log).toHaveBeenCalledWith('[private-empty-vm] not-subscribed');
    expect(mocks.proof).not.toHaveBeenCalled();
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
      .call(state.agent, CG, CALLER, commit, deadline.signal)).toEqual({ proven: false });
    expect(commit).not.toHaveBeenCalled();
    expect(state.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ signal: deadline.signal }));
    expect(state.chainSnapshot).toHaveBeenCalledWith(CG, deadline.signal);
  });
});
