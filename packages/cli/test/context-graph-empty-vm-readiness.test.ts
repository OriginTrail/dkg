import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { settlePrivateEmptyVmAtSubscribe } from '../src/context-graph-empty-vm-readiness.js';
import { withProvenEmptyPrivateVmReadiness } from '../src/context-graph-empty-vm-readiness-owner.js';
import { withContextGraphReadinessMutationLock } from '../src/context-graph-readiness.js';

afterEach(() => vi.restoreAllMocks());

describe('private empty-VM subscribe settlement', () => {
  it('skips chain-public admission without polling metadata', async () => {
    const agent = { hasConfirmedMetaState: vi.fn() } as unknown as DKGAgent;
    expect(await settlePrivateEmptyVmAtSubscribe(
      agent, {} as DashboardDB, 'graph',
      { source: 'registered-chain', reason: 'chain-public' },
      `0x${'11'.repeat(20)}`,
    )).toBe(false);
    expect(agent.hasConfirmedMetaState).not.toHaveBeenCalled();
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
    let privateReadStarted!: () => void;
    const privateRead = new Promise<void>((resolve) => { privateReadStarted = resolve; });
    const proof = vi.fn(async () => ({ proven: false as const }));
    const agent = {
      hasConfirmedMetaState: async () => true,
      isPrivateContextGraph: async () => { privateReadStarted(); return true; },
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
      // A macrotask after the private-metadata read lets the settlement
      // enqueue behind the held owner before the deadline fires.
      await privateRead;
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
