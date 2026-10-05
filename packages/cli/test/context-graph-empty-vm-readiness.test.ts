import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { settlePrivateEmptyVmAtSubscribe } from '../src/context-graph-empty-vm-readiness.js';
import { withProvenEmptyPrivateVmReadiness } from '../src/context-graph-empty-vm-readiness-owner.js';
import { withContextGraphReadinessMutationLock } from '../src/context-graph-readiness.js';

afterEach(() => vi.restoreAllMocks());

describe('private empty-VM subscribe settlement', () => {
  it('does not start an agent proof when the deadline is already aborted', async () => {
    const deadline = new AbortController();
    deadline.abort();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const agent = { proveRegisteredPrivateEmptyVmV1: vi.fn() } as unknown as DKGAgent;
    expect(await settlePrivateEmptyVmAtSubscribe(
      agent, {} as DashboardDB, 'graph',
      { source: 'registered-chain', reason: 'chain-participant' },
      `0x${'11'.repeat(20)}`,
    )).toBe(false);
    expect(agent.proveRegisteredPrivateEmptyVmV1).not.toHaveBeenCalled();
  });

  it('delegates metadata and private-policy prerequisites to the agent proof', async () => {
    const metadataRead = vi.fn();
    const privateRead = vi.fn();
    const proof = vi.fn(async () => ({ proven: false as const }));
    const agent = {
      hasConfirmedMetaState: metadataRead,
      isPrivateContextGraph: privateRead,
      proveRegisteredPrivateEmptyVmV1: proof,
    } as unknown as DKGAgent;
    expect(await settlePrivateEmptyVmAtSubscribe(
      agent, {} as DashboardDB, 'graph',
      { source: 'registered-chain', reason: 'chain-participant' },
      `0x${'11'.repeat(20)}`,
    )).toBe(false);
    expect(proof).toHaveBeenCalledOnce();
    expect(metadataRead).not.toHaveBeenCalled();
    expect(privateRead).not.toHaveBeenCalled();
  });

  it('skips chain-public admission without starting a private proof', async () => {
    const agent = { proveRegisteredPrivateEmptyVmV1: vi.fn() } as unknown as DKGAgent;
    expect(await settlePrivateEmptyVmAtSubscribe(
      agent, {} as DashboardDB, 'graph',
      { source: 'registered-chain', reason: 'chain-public' },
      `0x${'11'.repeat(20)}`,
    )).toBe(false);
    expect(agent.proveRegisteredPrivateEmptyVmV1).not.toHaveBeenCalled();
  });

  it('retries a metadata-transition proof and commits only the later fenced success', async () => {
    const writeReadiness = vi.fn();
    const markSubscription = vi.fn();
    const proof = vi.fn(async (_id: string, _caller: string, commit: () => void) => {
      if (proof.mock.calls.length === 1) return { proven: false as const, retryable: true as const };
      commit();
      return { proven: true as const, value: undefined };
    });
    const agent = {
      hasConfirmedMetaState: async () => true,
      isPrivateContextGraph: async () => true,
      proveRegisteredPrivateEmptyVmV1: proof,
      markContextGraphSubscriptionState: markSubscription,
    } as unknown as DKGAgent;
    const dashboard = { setContextGraphReadinessProvenance: writeReadiness } as unknown as DashboardDB;

    expect(await settlePrivateEmptyVmAtSubscribe(
      agent, dashboard, 'graph',
      { source: 'registered-chain', reason: 'chain-participant' },
      `0x${'11'.repeat(20)}`,
    )).toBe(true);
    expect(proof).toHaveBeenCalledTimes(2);
    expect(writeReadiness).toHaveBeenCalledWith('graph', expect.objectContaining({
      durableVerified: true, sharedMemoryVerified: false,
    }));
    expect(markSubscription).toHaveBeenCalledTimes(1);
  });

  it('does not retry a terminal private-authority denial', async () => {
    const proof = vi.fn(async () => ({ proven: false as const }));
    const agent = {
      hasConfirmedMetaState: async () => true,
      isPrivateContextGraph: async () => true,
      proveRegisteredPrivateEmptyVmV1: proof,
    } as unknown as DKGAgent;
    expect(await settlePrivateEmptyVmAtSubscribe(
      agent, {} as DashboardDB, 'graph',
      { source: 'registered-chain', reason: 'chain-participant' },
      `0x${'11'.repeat(20)}`,
    )).toBe(false);
    expect(proof).toHaveBeenCalledTimes(1);
  });

  it('does not commit when authority is denied after a metadata retry', async () => {
    const writeReadiness = vi.fn();
    const markSubscription = vi.fn();
    const proof = vi.fn(async () => (
      proof.mock.calls.length === 1
        ? { proven: false as const, retryable: true as const }
        : { proven: false as const }
    ));
    const agent = {
      hasConfirmedMetaState: async () => true,
      isPrivateContextGraph: async () => true,
      proveRegisteredPrivateEmptyVmV1: proof,
      markContextGraphSubscriptionState: markSubscription,
    } as unknown as DKGAgent;
    const dashboard = { setContextGraphReadinessProvenance: writeReadiness } as unknown as DashboardDB;
    expect(await settlePrivateEmptyVmAtSubscribe(
      agent, dashboard, 'graph',
      { source: 'registered-chain', reason: 'chain-participant' },
      `0x${'11'.repeat(20)}`,
    )).toBe(false);
    expect(proof).toHaveBeenCalledTimes(2);
    expect(writeReadiness).not.toHaveBeenCalled();
    expect(markSubscription).not.toHaveBeenCalled();
  });

  it('returns at its deadline even when a proof backend has not settled', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let proofStarted!: () => void;
    const started = new Promise<void>((resolve) => { proofStarted = resolve; });
    let releaseProof!: () => void;
    const pendingProof = new Promise<void>((resolve) => { releaseProof = resolve; });
    const proof = vi.fn(async (_id: string, _caller: string, _commit: () => void, signal: AbortSignal) => {
      expect(signal).toBe(deadline.signal);
      proofStarted();
      await pendingProof;
      return { proven: false as const };
    });
    const agent = {
      hasConfirmedMetaState: async () => true,
      isPrivateContextGraph: async () => true,
      proveRegisteredPrivateEmptyVmV1: proof,
    } as unknown as DKGAgent;
    const settlement = settlePrivateEmptyVmAtSubscribe(
      agent, {} as DashboardDB, 'graph',
      { source: 'registered-chain', reason: 'chain-participant' },
      `0x${'11'.repeat(20)}`,
    );
    try {
      await started;
      deadline.abort();
      await expect(settlement).resolves.toBe(false);
      expect(proof).toHaveBeenCalledOnce();
    } finally {
      releaseProof();
    }
  });

  it('releases queued readiness work on timeout while a proof backend remains pending', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let proofStarted!: () => void;
    const started = new Promise<void>((resolve) => { proofStarted = resolve; });
    let releaseProof!: () => void;
    const pendingProof = new Promise<void>((resolve) => { releaseProof = resolve; });
    const writeReadiness = vi.fn();
    const markSubscription = vi.fn();
    const agent = {
      hasConfirmedMetaState: async () => true,
      isPrivateContextGraph: async () => true,
      markContextGraphSubscriptionState: markSubscription,
      proveRegisteredPrivateEmptyVmV1: async (
        _id: string, _caller: string, commit: () => void,
      ) => {
        proofStarted();
        await pendingProof;
        commit();
        return { proven: true as const, value: undefined };
      },
    } as unknown as DKGAgent;
    const dashboard = { setContextGraphReadinessProvenance: writeReadiness } as unknown as DashboardDB;
    const settlement = settlePrivateEmptyVmAtSubscribe(
      agent, dashboard, 'graph',
      { source: 'registered-chain', reason: 'chain-participant' },
      `0x${'11'.repeat(20)}`,
    );
    try {
      await started;
      const queued = vi.fn(async () => 'released');
      const next = withContextGraphReadinessMutationLock(agent, 'graph', queued);
      deadline.abort();
      await expect(settlement).resolves.toBe(false);
      await vi.waitFor(() => expect(queued).toHaveBeenCalledOnce(), { timeout: 200 });
      await expect(next).resolves.toBe('released');
      expect(writeReadiness).not.toHaveBeenCalled();
      expect(markSubscription).not.toHaveBeenCalled();
    } finally {
      releaseProof();
    }
    await Promise.resolve();
    expect(writeReadiness).not.toHaveBeenCalled();
    expect(markSubscription).not.toHaveBeenCalled();
  });

  it('settles a timed-out waiter before acquiring a busy readiness lock', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let releaseOwner!: () => void;
    const ownerHeld = new Promise<void>((resolve) => { releaseOwner = resolve; });
    let ownerStarted!: () => void;
    const started = new Promise<void>((resolve) => { ownerStarted = resolve; });
    const proof = vi.fn(async () => ({ proven: false as const }));
    const agent = {
      proveRegisteredPrivateEmptyVmV1: proof,
    } as unknown as DKGAgent;
    const owner = withContextGraphReadinessMutationLock(agent, 'graph', async () => {
      ownerStarted();
      await ownerHeld;
    });
    await started;
    const settlement = settlePrivateEmptyVmAtSubscribe(
      agent, {} as DashboardDB, 'graph',
      { source: 'registered-chain', reason: 'chain-participant' },
      `0x${'11'.repeat(20)}`,
    );
    try {
      // Give the proof caller a turn to queue behind the held owner.
      await new Promise<void>((resolve) => setImmediate(resolve));
      deadline.abort();
      await expect(settlement).resolves.toBe(false);
      expect(proof).not.toHaveBeenCalled();
    } finally {
      releaseOwner();
      await owner;
    }
    expect(await withContextGraphReadinessMutationLock(agent, 'graph', async () => 'next')).toBe('next');
    expect(proof).not.toHaveBeenCalled();
  });

  it('propagates a synchronous persistence error from the fenced callback', async () => {
    const failure = new Error('persistence failed');
    const agent = {
      proveRegisteredPrivateEmptyVmV1: async (
        _id: string, _caller: string, commit: () => unknown,
      ) => ({ proven: true as const, value: commit() }),
    } as unknown as DKGAgent;
    await expect(withProvenEmptyPrivateVmReadiness({
      agent, contextGraphId: 'graph', callerAgentAddress: `0x${'11'.repeat(20)}`,
      commit: () => { throw failure; }, signal: new AbortController().signal,
    })).rejects.toBe(failure);
  });

  it('does not start a proof for an already-aborted queued task', async () => {
    const deadline = new AbortController();
    deadline.abort();
    const proof = vi.fn();
    const commit = vi.fn();
    const agent = { proveRegisteredPrivateEmptyVmV1: proof } as unknown as DKGAgent;
    expect(await withProvenEmptyPrivateVmReadiness({
      agent, contextGraphId: 'graph', callerAgentAddress: `0x${'11'.repeat(20)}`,
      commit, signal: deadline.signal,
    })).toEqual({ proven: false });
    expect(proof).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('observes a backend rejection after the deadline releases the readiness lock', async () => {
    const deadline = new AbortController();
    let started!: () => void;
    const proofStarted = new Promise<void>((resolve) => { started = resolve; });
    let rejectProof!: (error: Error) => void;
    const pendingProof = new Promise<void>((_resolve, reject) => { rejectProof = reject; });
    const commit = vi.fn();
    const agent = {
      proveRegisteredPrivateEmptyVmV1: async () => {
        started();
        await pendingProof;
        return { proven: false as const };
      },
    } as unknown as DKGAgent;
    const settlement = withProvenEmptyPrivateVmReadiness({
      agent, contextGraphId: 'graph', callerAgentAddress: `0x${'11'.repeat(20)}`,
      commit, signal: deadline.signal,
    });
    await proofStarted;
    deadline.abort();
    await expect(settlement).resolves.toEqual({ proven: false });
    await expect(withContextGraphReadinessMutationLock(agent, 'graph', async () => 'next')).resolves.toBe('next');
    rejectProof(new Error('backend stopped after deadline'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(commit).not.toHaveBeenCalled();
  });

  it('observes a backend rejection when cancellation wins before the proof wait attaches', async () => {
    const deadline = new AbortController();
    const commit = vi.fn();
    const agent = {
      proveRegisteredPrivateEmptyVmV1: () => {
        deadline.abort();
        return Promise.reject(new Error('backend stopped'));
      },
    } as unknown as DKGAgent;
    expect(await withProvenEmptyPrivateVmReadiness({
      agent, contextGraphId: 'graph', callerAgentAddress: `0x${'11'.repeat(20)}`,
      commit, signal: deadline.signal,
    })).toEqual({ proven: false });
    expect(commit).not.toHaveBeenCalled();
  });
});
