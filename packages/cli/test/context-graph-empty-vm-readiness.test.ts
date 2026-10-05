import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { settlePrivateEmptyVmAtSubscribe } from '../src/context-graph-empty-vm-readiness.js';

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
      return false;
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
});
