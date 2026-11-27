import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireFinalizedChainRead,
  ChainRpcTransportError,
  CurrentFinalizedEvmCallErrorV1,
  RpcRequestGovernorQueueFullError,
} from '@origintrail-official/dkg-chain';
import { StoreOperationTimeoutError, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from '../src/dkg-agent.js';
import { Rfc64AuthorityRpcCircuitOpenErrorV1 } from '../src/rfc64/authority-rpc-circuit-breaker-v1.js';
import {
  isRegisteredPrivateEmptyVmReadinessCandidateV1,
  RegisteredPrivateEmptyVmMethods,
  type InspectedContextGraphReadinessV1,
  type InspectedPrivateEmptyVmReadinessV1,
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
    prepareContextGraphReadinessWithPrivateEmptyVmV1:
      RegisteredPrivateEmptyVmMethods.prototype.prepareContextGraphReadinessWithPrivateEmptyVmV1,
    readRfc64RegisteredAuthoritySnapshotV1: chainSnapshot,
    contextGraphAuthorityReaderCapability: { status: 'supported', reader: {} },
    config: { chainConfig: {
      rpcUrl: 'http://127.0.0.1:8545', chainId: 'evm:31337',
      hubAddress: `0x${'33'.repeat(20)}`,
    } },
    chain: {
      getEvmChainId: vi.fn(async () => 31337n),
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

async function complete(
  agent: DKGAgent,
  commit: (inspection: Extract<InspectedPrivateEmptyVmReadinessV1, { proven: true }>['inspection']) => unknown
    = () => undefined,
  signal?: AbortSignal,
): Promise<InspectedPrivateEmptyVmReadinessV1> {
  const preparation = await agent.prepareContextGraphReadinessWithPrivateEmptyVmV1({
    contextGraphId: CG,
    attemptPrivateEmptyVm: true,
    callerAgentAddress: CALLER,
    signal,
  });
  return preparation.inspectAndCommit({ inspectMetadata: true }, (completion) => {
    if (completion.proven) commit(completion.inspection);
    return completion;
  });
}

async function prove(agent: DKGAgent): Promise<boolean> {
  return (await complete(agent)).proven;
}

describe('registered private empty-VM agent guard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.snapshot.mockReturnValue(async () => true);
    mocks.proof.mockResolvedValue('proven');
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
      kind: 'invalidated',
      authority: { outcome: 'allowed', source: 'registered-chain', onChainId: 3n },
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
      kind: 'invalidated',
      authority: { outcome: 'allowed', source: 'registered-chain', onChainId: 3n },
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
      kind: 'invalidated',
      authority: { outcome: 'allowed', source: 'registered-chain', onChainId: 3n },
    });
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('withholds confirmed or allowed facts when inspection dependencies fail', async () => {
    const cases = [
      {
        fail: (state: ReturnType<typeof fixture>) => {
          vi.mocked(state.agent.hasConfirmedMetaState).mockRejectedValue(new Error('metadata unavailable'));
        },
        expected: { metadata: { kind: 'unavailable' }, authority: { outcome: 'allowed' } },
      },
      {
        fail: (state: ReturnType<typeof fixture>) => {
          state.isPrivate.mockRejectedValue(new Error('policy unavailable'));
        },
        expected: { metadata: { kind: 'unavailable' }, authority: { outcome: 'allowed' } },
      },
      {
        fail: (state: ReturnType<typeof fixture>) => {
          state.authority.mockRejectedValue(new Error('chain unavailable'));
        },
        expected: {
          metadata: { kind: 'confirmed', accessPolicy: 'private' },
          authority: { outcome: 'unavailable' },
        },
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
      expect(result).toMatchObject({ kind: 'current', ...expected });
    }
  });

  it('distinguishes confirmed metadata absence from an unavailable policy', async () => {
    const state = fixture();
    vi.mocked(state.agent.hasConfirmedMetaState).mockResolvedValueOnce(false);
    const inspected = await RegisteredPrivateEmptyVmMethods.prototype.inspectAndCommitContextGraphReadinessV1
      .call(state.agent, {
        contextGraphId: CG, inspectMetadata: true,
        callerAgentAddress: CALLER,
      }, (facts) => facts);
    expect(inspected).toMatchObject({ kind: 'current', metadata: { kind: 'absent' } });
    expect(state.isPrivate).not.toHaveBeenCalled();
  });

  it.each([
    { error: new Error('authority unavailable'), dependency: 'unknown' },
    { error: new ChainRpcTransportError('RPC_ENDPOINTS_EXHAUSTED', 'RPC unavailable'), dependency: 'chain' },
    {
      error: new StoreOperationTimeoutError({
        backend: 'oxigraph-server', operation: 'query', outcome: 'not_started',
        message: 'store unavailable',
      }),
      dependency: 'store',
    },
  ])('preserves canonical authority diagnostics for $dependency failures', async ({ error, dependency }) => {
    const state = fixture();
    state.authority.mockRejectedValueOnce(error);
    const result = await RegisteredPrivateEmptyVmMethods.prototype.inspectAndCommitContextGraphReadinessV1
      .call(state.agent, { contextGraphId: CG, inspectMetadata: true }, (inspection) => inspection);
    expect(result.authority).toEqual({
      outcome: 'unavailable', source: 'legacy-local', reason: 'unexpected-authority-error',
      metadataBootstrap: 'eligible', dependency,
    });
  });

  it('never commits a zero-VM proof when private-policy inspection fails after it', async () => {
    const state = fixture();
    const commit = vi.fn();
    state.isPrivate.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('policy unavailable'));
    expect(await complete(state.agent, commit)).toMatchObject({ proven: false });
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

  it('prepares chain evidence before running the final live inspection', async () => {
    const state = fixture();
    const preparation = await state.agent.prepareContextGraphReadinessWithPrivateEmptyVmV1({
      contextGraphId: CG,
      attemptPrivateEmptyVm: true,
      callerAgentAddress: CALLER,
    });
    expect(mocks.proof).toHaveBeenCalledOnce();
    expect(state.authority).toHaveBeenCalledOnce();

    const completion = await preparation.inspectAndCommit(
      { inspectMetadata: true },
      (value) => value,
    );
    expect(completion).toMatchObject({ proven: true });
    expect(state.authority).toHaveBeenCalledTimes(2);
  });

  it('centralizes registered-private empty-VM candidate selection', () => {
    const base = {
      outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
      metadataBootstrap: 'eligible',
    } as const;
    expect(isRegisteredPrivateEmptyVmReadinessCandidateV1(base, CALLER)).toBe(true);
    expect(isRegisteredPrivateEmptyVmReadinessCandidateV1(
      { ...base, registration: 'unregistered' }, CALLER,
    )).toBe(false);
    expect(isRegisteredPrivateEmptyVmReadinessCandidateV1(base, undefined)).toBe(false);
    expect(isRegisteredPrivateEmptyVmReadinessCandidateV1(
      { ...base, reason: 'chain-public' }, CALLER,
    )).toBe(false);
  });

  it('returns the synchronous persistence callback value only after proof', async () => {
    const state = fixture();
    const commit = vi.fn(() => 'readiness-written');
    const preparation = await state.agent.prepareContextGraphReadinessWithPrivateEmptyVmV1({
      contextGraphId: CG, attemptPrivateEmptyVm: true, callerAgentAddress: CALLER,
    });
    expect(await preparation.inspectAndCommit({ inspectMetadata: true }, (completion) => {
      if (!completion.proven) throw new Error('expected proven readiness');
      return commit(completion.inspection);
    })).toBe('readiness-written');
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'current', metadata: { kind: 'confirmed', accessPolicy: 'private' },
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
    expect(await complete(state.agent)).toMatchObject({ proven: false });
    expect(mocks.proof).not.toHaveBeenCalled();
  });

  it('retries an unconfirmed metadata read without treating it as authorization', async () => {
    const state = fixture();
    vi.mocked(state.agent.hasConfirmedMetaState).mockResolvedValueOnce(false);
    const commit = vi.fn();
    expect(await complete(state.agent, commit)).toMatchObject({ proven: false, retryable: true });
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
    const denial = await complete(state.agent, commit);
    expect(denial).toMatchObject({ proven: false });
    if (!denial.proven) expect(denial.retryable).not.toBe(true);
    expect(state.authority).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('retries unavailable authority but never a definitive denial', async () => {
    const state = fixture();
    const commit = vi.fn();
    state.authority.mockResolvedValueOnce({ outcome: 'unavailable' });
    expect(await complete(state.agent, commit)).toMatchObject({ proven: false, retryable: true });
    state.authority.mockResolvedValueOnce({ outcome: 'denied' });
    const denial = await complete(state.agent, commit);
    expect(denial).toMatchObject({ proven: false });
    if (!denial.proven) expect(denial.retryable).not.toBe(true);
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
    expect(await complete(state.agent)).toMatchObject({ proven: false, retryable: true });
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

  it('reads the configured chain as the adapter does, whatever its namespace', async () => {
    const state = fixture();
    const config = state.agent.config.chainConfig as { chainId: string };
    // The network files name their chains after the network (`base:8453`,
    // `gnosis:100`), not `evm:`; a bare number is the adapter's other form.
    for (const chainId of ['base:31337', 'gnosis:31337', 'neuroweb:31337', '31337']) {
      config.chainId = chainId;
      expect(await prove(state.agent)).toBe(true);
    }
    expect(mocks.proof).toHaveBeenCalledTimes(4);
    expect(mocks.proof).toHaveBeenLastCalledWith(expect.objectContaining({ chainId: '31337' }));
    // The namespace is free; the number still has to be the adapter's chain.
    config.chainId = 'base:8453';
    expect(await prove(state.agent)).toBe(false);
    expect(mocks.proof).toHaveBeenCalledTimes(4);
  });

  it('uses the adapter chain ID when configuration omits it, but rejects a mismatch', async () => {
    const state = fixture();
    const config = state.agent.config.chainConfig as { chainId?: string };
    delete config.chainId;
    expect(await prove(state.agent)).toBe(true);
    expect(mocks.proof).toHaveBeenCalledWith(expect.objectContaining({ chainId: '31337' }));
    config.chainId = 'evm:1';
    expect(await prove(state.agent)).toBe(false);
    expect(mocks.proof).toHaveBeenCalledTimes(1);
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
    state.chainSnapshot.mockResolvedValueOnce({
      expectedNameHash: NAME_HASH, expectedOnChainId: 3n,
      snapshot: {
        chainId: '31337', contextGraphId: '4', active: true, accessPolicy: 1,
        governanceContract: `0x${'22'.repeat(20)}`, nameHash: NAME_HASH,
      },
    });
    expect(await prove(state.agent)).toBe(false);
    state.chainSnapshot.mockResolvedValueOnce({
      expectedNameHash: NAME_HASH, expectedOnChainId: 3n,
      snapshot: {
        chainId: '31337', contextGraphId: '3', active: true, accessPolicy: 0,
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

  it('retries only a genuine finalized-read admission refusal', async () => {
    const state = fixture();
    let release!: () => void;
    const held = acquireFinalizedChainRead(
      { chainId: '31337', owner: 'rfc64' },
      () => new Promise<void>((resolve) => { release = resolve; }),
      () => new Error('unexpected lane refusal'),
    );
    await Promise.resolve();
    try {
      let refusal: unknown;
      try {
        await acquireFinalizedChainRead(
          { chainId: '31337', owner: 'foreground' },
          async () => undefined,
          () => new Error('finalized read busy'),
        );
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      mocks.proof.mockRejectedValueOnce(refusal);
      const commit = vi.fn();
      expect(await complete(state.agent, commit)).toMatchObject({ proven: false, retryable: true });
      expect(commit).not.toHaveBeenCalled();
    } finally {
      release();
      await held;
    }
    expect(await prove(state.agent)).toBe(true);
  });

  it('never commits a negative finalized zero-VM proof', async () => {
    const state = fixture();
    const commit = vi.fn();
    mocks.proof.mockResolvedValueOnce('unproven');
    expect(await complete(state.agent, commit)).toMatchObject({ proven: false });
    expect(mocks.proof).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('delivers a failed proof and final live denial to one fenced completion callback', async () => {
    const state = fixture();
    const commit = vi.fn((completion: InspectedPrivateEmptyVmReadinessV1) => completion);
    mocks.proof.mockResolvedValueOnce('unproven');
    state.authority.mockResolvedValueOnce({
      outcome: 'allowed', source: 'registered-chain', onChainId: 3n,
    }).mockResolvedValueOnce({ outcome: 'denied' });
    const preparation = await state.agent.prepareContextGraphReadinessWithPrivateEmptyVmV1({
      contextGraphId: CG, attemptPrivateEmptyVm: true, callerAgentAddress: CALLER,
    });
    const result = await preparation.inspectAndCommit({ inspectMetadata: true }, commit);
    expect(commit).toHaveBeenCalledOnce();
    expect(state.authority).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      inspection: expect.objectContaining({
        kind: 'current', authority: { outcome: 'denied' },
      }),
      proven: false,
      final: true,
      stage: 'authority-denied',
    });
  });

  it('carries the validated final inspection inside a successful completion', async () => {
    const state = fixture();
    const commit = vi.fn((completion: InspectedPrivateEmptyVmReadinessV1) => completion);
    const preparation = await state.agent.prepareContextGraphReadinessWithPrivateEmptyVmV1({
      contextGraphId: CG, attemptPrivateEmptyVm: true, callerAgentAddress: CALLER,
    });
    const result = await preparation.inspectAndCommit({ inspectMetadata: true }, commit);
    expect(commit).toHaveBeenCalledExactlyOnceWith(result);
    expect(result).toEqual({
      proven: true,
      inspection: {
        kind: 'current', metadata: { kind: 'confirmed', accessPolicy: 'private' },
        authority: { outcome: 'allowed', source: 'registered-chain', onChainId: 3n },
      },
    });
  });

  it('does not commit readiness if metadata is invalidated during chain proof', async () => {
    const state = fixture();
    const commit = vi.fn();
    mocks.proof.mockImplementationOnce(async () => {
      state.invalidateMetadata();
      return 'proven';
    });
    expect(await complete(state.agent, commit)).toMatchObject({ proven: false, retryable: true });
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not commit when the graph becomes public after the finalized proof', async () => {
    const state = fixture();
    const commit = vi.fn();
    state.isPrivate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await complete(state.agent, commit)).toMatchObject({ proven: false });
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
    expect(await complete(state.agent, commit)).toMatchObject({ proven: false });
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
      return 'proven';
    });
    expect(await complete(state.agent, commit)).toMatchObject({ proven: false });
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
    expect(await complete(state.agent, commit)).toMatchObject({ proven: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(revisionAtCommit).toEqual(['0:0']);
    expect(state.readMetadataRevision()).toBe('0:1');
  });

  it('leaves a caller-owned persistence failure visible after a valid proof', async () => {
    const state = fixture();
    const failure = new Error('readiness persistence unavailable');
    const commit = vi.fn(() => { throw failure; });
    await expect(complete(state.agent, commit)).rejects.toBe(failure);
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
      return 'proven';
    });
    expect(await complete(state.agent, commit, deadline.signal)).toMatchObject({ proven: false });
    expect(commit).not.toHaveBeenCalled();
    expect(state.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ signal: deadline.signal }));
    expect(state.chainSnapshot).toHaveBeenCalledWith(CG, deadline.signal);
  });

  describe('when an attempt is worth making again', () => {
    const transient: Array<[string, () => unknown]> = [
      ['a busy store', () => new StoreSchedulerBusyError('queue_full', 'background', 'query')],
      ['a store operation timeout', () => new StoreOperationTimeoutError({ backend: 'store', operation: 'query', timeoutMs: 1_000 })],
      ['a refusal of the request governor', () => new RpcRequestGovernorQueueFullError(10)],
      ['every endpoint exhausted', () => new ChainRpcTransportError('RPC_ENDPOINTS_EXHAUSTED', 'all failed')],
      ['a chain request timeout', () => new ChainRpcTransportError('RPC_TIMEOUT', 'too slow')],
      ['an open authority circuit', () => new Rfc64AuthorityRpcCircuitOpenErrorV1(1_000, 1_000)],
      ['finalized state not available yet', () => new CurrentFinalizedEvmCallErrorV1('finalized-state-unavailable', 'x')],
      ['an endpoint that could not answer', () => new CurrentFinalizedEvmCallErrorV1('rpc-unavailable', 'x')],
      ['a finalized read timeout', () => new CurrentFinalizedEvmCallErrorV1('rpc-timeout', 'x')],
      ['the attempt\'s own timeout', () => new DOMException('The operation timed out', 'TimeoutError')],
      ['a wrapped cause', () => new Error('read failed', { cause: new Error('inner', { cause: new RpcRequestGovernorQueueFullError(10) }) })],
    ];

    it.each(transient)('asks again soon after %s', async (_label, failure) => {
      const state = fixture();
      mocks.proof.mockRejectedValueOnce(failure());
      const commit = vi.fn();
      const end = await complete(state.agent, commit);
      expect(end).toMatchObject({ proven: false, retryable: true });
      expect(commit).not.toHaveBeenCalled();
    });

    it('asks again soon when the store or the authority read fails before the proof', async () => {
      const state = fixture();
      state.isPrivate.mockRejectedValueOnce(new Error('store unavailable'));
      expect(await complete(state.agent)).toMatchObject({
        proven: false, retryable: true, stage: 'private-policy-unavailable',
      });
      state.chainSnapshot.mockRejectedValueOnce(new StoreOperationTimeoutError({ backend: 'store', operation: 'query', timeoutMs: 1_000 }));
      expect(await complete(state.agent)).toMatchObject({ proven: false, retryable: true });
      expect(mocks.proof).not.toHaveBeenCalled();
    });

    it.each([
      ['an error it cannot read', () => new Error('read unavailable')],
      ['a reverted read', () => new CurrentFinalizedEvmCallErrorV1('revert', 'x')],
      ['a malformed answer', () => new CurrentFinalizedEvmCallErrorV1('malformed-return', 'x')],
      ['contention no lane reported', () => new CurrentFinalizedEvmCallErrorV1('concurrency-saturated', 'x')],
      ['a transport failure about a sent transaction', () => new ChainRpcTransportError('RPC_TIMEOUT', 'x', { txHash: `0x${'aa'.repeat(32)}` })],
    ])('does not ask again soon after %s, and may try later', async (_label, failure) => {
      const state = fixture();
      mocks.proof.mockRejectedValueOnce(failure());
      const end = await complete(state.agent);
      expect(end).toMatchObject({ proven: false });
      if (!end.proven) {
        expect(end.retryable).not.toBe(true);
        expect(end.final).not.toBe(true);
        expect(end.stage).toMatch(/^proof-error:/);
      }
    });

    it('treats a caller deadline as no verdict on the graph', async () => {
      const state = fixture();
      const deadline = new AbortController();
      mocks.proof.mockImplementationOnce(async () => {
        deadline.abort();
        throw new RpcRequestGovernorQueueFullError(10);
      });
      const end = await complete(state.agent, () => undefined, deadline.signal);
      expect(end).toMatchObject({ proven: false });
      if (!end.proven) {
        expect(end.retryable).not.toBe(true);
        expect(end.final).not.toBe(true);
      }
    });

    it('never tries again on a graph that holds Knowledge Assets', async () => {
      const state = fixture();
      mocks.proof.mockResolvedValueOnce('not-empty');
      const commit = vi.fn();
      expect(await complete(state.agent, commit)).toMatchObject({
        proven: false, final: true, stage: 'finalized-not-empty',
      });
      expect(commit).not.toHaveBeenCalled();
    });

    it('may try later when another condition does not hold at this anchor', async () => {
      const state = fixture();
      mocks.proof.mockResolvedValueOnce('unproven');
      const end = await complete(state.agent);
      expect(end).toMatchObject({ proven: false, stage: 'finalized-zero-proof-false' });
      if (!end.proven) {
        expect(end.retryable).not.toBe(true);
        expect(end.final).not.toBe(true);
      }
    });

    it.each([
      ['a public graph', (state: ReturnType<typeof fixture>) => { state.isPrivate.mockResolvedValueOnce(false); }, 'not-private'],
      ['a removed subscription', (state: ReturnType<typeof fixture>) => { state.subscriptions.get(CG)!.subscribed = false; }, 'not-subscribed'],
    ] as const)('does not try again on %s', async (_label, arrange, stage) => {
      const state = fixture();
      arrange(state);
      const preparation = await state.agent.prepareContextGraphReadinessWithPrivateEmptyVmV1({
        contextGraphId: CG, attemptPrivateEmptyVm: true, callerAgentAddress: CALLER,
      });
      const attempt = await preparation.inspectAndCommit({ inspectMetadata: true }, (end) => end);
      expect(attempt.proven).toBe(false);
      if (stage === 'not-private') expect(attempt).toMatchObject({ final: true, stage });
      else expect(attempt).toMatchObject({ proven: false });
    });
  });

  describe('an approved member whose authority has not settled here yet', () => {
    const approved = (state: ReturnType<typeof fixture>, agentAddress = CALLER.toUpperCase().replace('0X', '0x')) => {
      (state.agent as unknown as { localApprovedAgentByCG: Map<string, string> }).localApprovedAgentByCG = new Map([[CG, agentAddress]]);
    };
    const notSettled: Array<[string, Record<string, unknown>]> = [
      ['denied', { outcome: 'denied' }],
      ['allowed from another source', { outcome: 'allowed', source: 'legacy-local' }],
      ['allowed without an on-chain id', { outcome: 'allowed', source: 'registered-chain' }],
    ];
    const UNREGISTERED = { outcome: 'allowed', source: 'registered-chain', onChainId: 3n, registration: 'unregistered' };

    it('waits for the later attempts when the graph is not registered: it may stay so', async () => {
      const state = fixture();
      approved(state);
      state.authority.mockResolvedValue(UNREGISTERED as never);
      const end = await complete(state.agent);
      expect(end).toMatchObject({ proven: false, stage: 'authority-not-registered-allowed' });
      if (!end.proven) {
        expect(end.retryable).not.toBe(true);
        expect(end.final).not.toBe(true);
      }
      expect(mocks.proof).not.toHaveBeenCalled();
    });

    it('without the approval, a graph that is not registered is that caller\'s answer', async () => {
      const state = fixture();
      state.authority.mockResolvedValue(UNREGISTERED as never);
      expect(await complete(state.agent)).toMatchObject({ proven: false, final: true });
    });

    it.each(notSettled)('asks again when the authority is %s, and proves nothing', async (_label, decision) => {
      const state = fixture();
      approved(state);
      state.authority.mockResolvedValue(decision as never);
      const commit = vi.fn();
      expect(await complete(state.agent, commit)).toMatchObject({
        proven: false, retryable: true, stage: 'authority-not-registered-allowed',
      });
      expect(mocks.proof).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    });

    it.each(notSettled)('without the approval, %s is that caller\'s answer', async (_label, decision) => {
      const state = fixture();
      state.authority.mockResolvedValue(decision as never);
      expect(await complete(state.agent)).toMatchObject({ proven: false, final: true });
      expect(mocks.proof).not.toHaveBeenCalled();
    });

    it('does not take another agent\'s approval for the caller\'s', async () => {
      const state = fixture();
      approved(state, `0x${'99'.repeat(20)}`);
      state.authority.mockResolvedValue({ outcome: 'denied' } as never);
      expect(await complete(state.agent)).toMatchObject({ proven: false, final: true });
    });

    it('asks again when the indexed authority is missing or does not match', async () => {
      const state = fixture();
      approved(state);
      state.chainSnapshot.mockResolvedValueOnce(null as never);
      expect(await complete(state.agent)).toMatchObject({
        proven: false, retryable: true, stage: 'indexed-private-authority-absent',
      });
      state.chainSnapshot.mockResolvedValueOnce({
        expectedNameHash: NAME_HASH, expectedOnChainId: 3n,
        snapshot: { chainId: '31337', contextGraphId: '3', active: true, accessPolicy: 0, governanceContract: `0x${'22'.repeat(20)}`, nameHash: NAME_HASH },
      } as never);
      expect(await complete(state.agent)).toMatchObject({
        proven: false, retryable: true, stage: 'indexed-private-authority-absent',
      });
      expect(mocks.proof).not.toHaveBeenCalled();
    });

    it('without the approval, a missing index is not asked about again soon, but may be later', async () => {
      const state = fixture();
      state.chainSnapshot.mockResolvedValueOnce(null as never);
      const end = await complete(state.agent);
      expect(end).toMatchObject({ proven: false, stage: 'indexed-private-authority-absent' });
      if (!end.proven) {
        expect(end.retryable).not.toBe(true);
        expect(end.final).not.toBe(true);
      }
    });

    it('keeps asking past a live denial at the final fence, and does not commit', async () => {
      const state = fixture();
      approved(state);
      state.authority.mockResolvedValue({ outcome: 'denied' } as never);
      const commit = vi.fn();
      expect(await complete(state.agent, commit)).toMatchObject({ proven: false, retryable: true });
      expect(commit).not.toHaveBeenCalled();
    });

    it('needs the full proof all the same: a proof that holds still meets the final authority', async () => {
      const state = fixture();
      approved(state);
      state.authority.mockResolvedValueOnce({ outcome: 'allowed', source: 'registered-chain', onChainId: 3n } as never)
        .mockResolvedValueOnce({ outcome: 'denied' } as never);
      const commit = vi.fn();
      const end = await complete(state.agent, commit);
      expect(end).toMatchObject({ proven: false, stage: 'post-proof-authority-changed' });
      expect(commit).not.toHaveBeenCalled();
      expect(mocks.proof).toHaveBeenCalledOnce();
    });

    it('never treats a proof that does not hold as proven, whatever the approval', async () => {
      const state = fixture();
      approved(state);
      for (const proof of ['unproven', 'not-empty'] as const) {
        mocks.proof.mockResolvedValueOnce(proof);
        expect((await complete(state.agent)).proven).toBe(false);
      }
    });

    it('still proves the graph once every condition holds', async () => {
      const state = fixture();
      approved(state);
      state.authority.mockResolvedValueOnce({ outcome: 'denied' } as never);
      expect((await complete(state.agent)).proven).toBe(false);
      expect(await prove(state.agent)).toBe(true);
    });
  });
});
