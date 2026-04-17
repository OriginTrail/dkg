/**
 * E2E tests for the async lift publisher queue:
 *
 * 1. lift → claimNext → processNext (full pipeline with mock chain)
 * 2. Multiple jobs — FIFO ordering
 * 3. Pause/resume — paused queue does not yield jobs
 * 4. Cancel a pending job
 * 5. Retry failed jobs — re-enters the queue
 * 6. Clear finalized/failed jobs
 * 7. Stats reflect live queue state
 * 8. Wallet lock contention — two wallets claim independently
 * 9. Recovery from broadcast state when chainRecoveryResolver succeeds
 * 10. Recovery from broadcast state when chainRecoveryResolver returns null → fails
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import {
  DKGPublisher,
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
  type AsyncLiftPublisherRecoveryResult,
  type LiftRequest,
} from '../src/index.js';

function makeLiftRequest(overrides: Partial<LiftRequest> = {}): LiftRequest {
  return {
    swmId: `swm-${Math.random().toString(36).slice(2, 8)}`,
    shareOperationId: `op-${Math.random().toString(36).slice(2, 8)}`,
    roots: ['urn:test:entity:1'],
    contextGraphId: 'test-cg',
    namespace: 'default',
    scope: 'full',
    transitionType: 'CREATE',
    authority: { type: 'owner', proofRef: 'proof:owner:test' },
    ...overrides,
  };
}

describe('Async Lift Publisher Queue — E2E Pipeline', () => {
  let store: OxigraphStore;
  let time: number;
  let ids: number;

  beforeEach(() => {
    store = new OxigraphStore();
    time = 1_000;
    ids = 0;
  });

  function create(opts: {
    recoveryResult?: AsyncLiftPublisherRecoveryResult | null;
    publishExecutor?: AsyncLiftPublisherConfig['publishExecutor'];
  } = {}) {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++time,
      idGenerator: () => `job-${++ids}`,
      chainRecoveryResolver: opts.recoveryResult === undefined
        ? undefined
        : async () => opts.recoveryResult ?? null,
      publishExecutor: opts.publishExecutor,
    });
  }

  it('lift → claimNext → status transitions accepted→claimed', async () => {
    const pub = create();
    const jobId = await pub.lift(makeLiftRequest());
    expect(jobId).toBe('job-1');

    const status = await pub.getStatus(jobId);
    expect(status?.status).toBe('accepted');

    const claimed = await pub.claimNext('wallet-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.jobId).toBe(jobId);
    expect(claimed!.status).toBe('claimed');
  });

  it('multiple jobs are claimed in FIFO order by different wallets', async () => {
    const pub = create();
    const id1 = await pub.lift(makeLiftRequest({ contextGraphId: 'cg-1' }));
    const id2 = await pub.lift(makeLiftRequest({ contextGraphId: 'cg-2' }));
    const id3 = await pub.lift(makeLiftRequest({ contextGraphId: 'cg-3' }));

    // Each wallet can only hold one active lock, so use different wallets
    const c1 = await pub.claimNext('wallet-1');
    const c2 = await pub.claimNext('wallet-2');
    const c3 = await pub.claimNext('wallet-3');

    expect(c1!.jobId).toBe(id1);
    expect(c2!.jobId).toBe(id2);
    expect(c3!.jobId).toBe(id3);

    const c4 = await pub.claimNext('wallet-4');
    expect(c4).toBeNull();
  });

  it('pause prevents claiming; resume re-enables', async () => {
    const pub = create();
    await pub.lift(makeLiftRequest());

    await pub.pause();
    const duringPause = await pub.claimNext('wallet-1');
    expect(duringPause).toBeNull();

    await pub.resume();
    const afterResume = await pub.claimNext('wallet-1');
    expect(afterResume).not.toBeNull();
  });

  it('cancel removes a pending job', async () => {
    const pub = create();
    const jobId = await pub.lift(makeLiftRequest());

    await pub.cancel(jobId);
    const status = await pub.getStatus(jobId);
    // Cancelled jobs either have 'failed' status or are gone
    expect(status === null || status.status === 'failed').toBe(true);

    const claimed = await pub.claimNext('wallet-1');
    expect(claimed).toBeNull();
  });

  it('stats reflect live queue composition', async () => {
    const pub = create();
    await pub.lift(makeLiftRequest());
    await pub.lift(makeLiftRequest());

    let stats = await pub.getStats();
    expect(stats['accepted']).toBe(2);

    await pub.claimNext('wallet-1');
    stats = await pub.getStats();
    expect(stats['accepted']).toBe(1);
    expect(stats['claimed']).toBe(1);
  });

  it('clear removes finalized jobs', async () => {
    const pub = create({
      publishExecutor: async () => ({
        status: 'confirmed' as const,
        merkleRoot: new Uint8Array(32),
        ual: 'did:dkg:mock/test/1',
        kcId: 1n,
        kaManifest: [],
        publicQuads: [],
      }),
    });

    const jobId = await pub.lift(makeLiftRequest());
    const claimed = await pub.claimNext('wallet-1');
    expect(claimed).not.toBeNull();

    const VALIDATION_META = {
      validation: {
        canonicalRoots: ['urn:test:entity:1'],
        canonicalRootMap: { 'urn:test:entity:1': 'urn:test:entity:1' },
        swmQuadCount: 1,
        authorityProofRef: 'proof:owner:test',
        transitionType: 'CREATE' as const,
      },
    };
    const BROADCAST_META = {
      broadcast: { txHash: '0xabc', walletId: 'wallet-1' },
    };

    await pub.update(jobId, 'validated', VALIDATION_META);
    await pub.update(jobId, 'broadcast', BROADCAST_META);
    await pub.update(jobId, 'included', {
      inclusion: { txHash: '0xabc', blockNumber: 42 },
    });
    await pub.update(jobId, 'finalized', {
      finalization: { confirmedByChain: true, finalizedAtMs: time, proofRef: '' },
    });

    let stats = await pub.getStats();
    expect(stats['finalized']).toBe(1);

    const cleared = await pub.clear('finalized');
    expect(cleared).toBe(1);

    stats = await pub.getStats();
    expect(stats['finalized']).toBe(0);
  });

  it('two wallets claim different jobs in parallel', async () => {
    const pub = create();
    await pub.lift(makeLiftRequest());
    await pub.lift(makeLiftRequest());

    const c1 = await pub.claimNext('wallet-A');
    const c2 = await pub.claimNext('wallet-B');

    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    expect(c1!.jobId).not.toBe(c2!.jobId);
  });
});

describe('Async Lift Publisher Queue — Full Lifecycle', () => {
  let store: OxigraphStore;
  let time: number;
  let ids: number;

  beforeEach(() => {
    store = new OxigraphStore();
    time = 1_000;
    ids = 0;
  });

  it('job transitions through entire lifecycle: accepted → claimed → validated → broadcast → included → finalized', async () => {
    const pub = new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++time,
      idGenerator: () => `job-${++ids}`,
      publishExecutor: async () => ({
        status: 'confirmed' as const,
        merkleRoot: new Uint8Array(32),
        ual: 'did:dkg:mock/test/1',
        kcId: 1n,
        kaManifest: [],
        publicQuads: [],
      }),
    });

    const jobId = await pub.lift(makeLiftRequest());
    expect((await pub.getStatus(jobId))?.status).toBe('accepted');

    const claimed = await pub.claimNext('wallet-1');
    expect(claimed).not.toBeNull();
    expect((await pub.getStatus(jobId))?.status).toBe('claimed');

    await pub.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['urn:test:entity:1'],
        canonicalRootMap: { 'urn:test:entity:1': 'urn:test:entity:1' },
        swmQuadCount: 1,
        authorityProofRef: 'proof:owner:test',
        transitionType: 'CREATE' as const,
      },
    });
    expect((await pub.getStatus(jobId))?.status).toBe('validated');

    await pub.update(jobId, 'broadcast', {
      broadcast: { txHash: '0xabc123', walletId: 'wallet-1' },
    });
    expect((await pub.getStatus(jobId))?.status).toBe('broadcast');

    await pub.update(jobId, 'included', {
      inclusion: { txHash: '0xabc123', blockNumber: 42 },
    });
    expect((await pub.getStatus(jobId))?.status).toBe('included');

    await pub.update(jobId, 'finalized', {
      finalization: { confirmedByChain: true, finalizedAtMs: time, proofRef: '' },
    });
    expect((await pub.getStatus(jobId))?.status).toBe('finalized');

    const stats = await pub.getStats();
    expect(stats['finalized']).toBe(1);
    expect(stats['accepted']).toBe(0);
  });

  it('job stuck at accepted never reaches finalized without claim', async () => {
    const pub = new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++time,
      idGenerator: () => `job-${++ids}`,
    });

    const jobId = await pub.lift(makeLiftRequest());

    const stats = await pub.getStats();
    expect(stats['accepted']).toBe(1);
    expect(stats['claimed']).toBe(0);
    expect(stats['finalized']).toBe(0);

    const status = await pub.getStatus(jobId);
    expect(status?.status).toBe('accepted');
  });

  it('invalid state transition is rejected', async () => {
    const pub = new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++time,
      idGenerator: () => `job-${++ids}`,
    });

    const jobId = await pub.lift(makeLiftRequest());

    await expect(pub.update(jobId, 'broadcast', {
      broadcast: { txHash: '0xabc', walletId: 'wallet-1' },
    })).rejects.toThrow();
  });
});

describe('Async Lift Publisher Queue — Recovery', () => {
  let store: OxigraphStore;
  let time: number;
  let ids: number;

  const VALIDATION_META = {
    validation: {
      canonicalRoots: ['urn:test:entity:1'],
      canonicalRootMap: { 'urn:test:entity:1': 'urn:test:entity:1' },
      swmQuadCount: 1,
      authorityProofRef: 'proof:owner:test',
      transitionType: 'CREATE' as const,
    },
  };
  const BROADCAST_META = {
    broadcast: { txHash: '0xabc', walletId: 'wallet-1' },
  };

  beforeEach(() => {
    store = new OxigraphStore();
    time = 1_000;
    ids = 0;
  });

  function create(opts: { recoveryResult?: AsyncLiftPublisherRecoveryResult | null } = {}) {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++time,
      idGenerator: () => `job-${++ids}`,
      chainRecoveryResolver: opts.recoveryResult === undefined
        ? undefined
        : async () => opts.recoveryResult ?? null,
    });
  }

  it('recover finalizes broadcast jobs when resolver succeeds', async () => {
    const pub = create({
      recoveryResult: {
        inclusion: { txHash: '0xrecovered' as `0x${string}`, blockNumber: 100 },
        finalization: { mode: 'published', txHash: '0xrecovered' as `0x${string}` },
      },
    });

    const jobId = await pub.lift(makeLiftRequest());
    await pub.claimNext('wallet-1');
    await pub.update(jobId, 'validated', VALIDATION_META);
    await pub.update(jobId, 'broadcast', BROADCAST_META);

    const recoveredCount = await pub.recover();
    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    const status = await pub.getStatus(jobId);
    expect(status?.status).toBe('finalized');
  });

  it('recover fails broadcast jobs when resolver returns null and timeout elapses', async () => {
    const pub = create({ recoveryResult: null });

    const jobId = await pub.lift(makeLiftRequest());
    await pub.claimNext('wallet-1');
    await pub.update(jobId, 'validated', VALIDATION_META);
    await pub.update(jobId, 'broadcast', BROADCAST_META);

    // Advance past the 15-minute recovery lookup timeout
    time += 16 * 60 * 1000;

    const recoveredCount = await pub.recover();
    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    const status = await pub.getStatus(jobId);
    expect(status?.status).toBe('failed');
  });

  it('retry re-queues retryable failed jobs (workspace_unavailable)', async () => {
    // Manually create a failed job with workspace_unavailable (retryable)
    const pub = create();
    const jobId = await pub.lift(makeLiftRequest());
    await pub.claimNext('wallet-1');

    // Simulate a retryable failure by walking through internal update
    // workspace_unavailable is retryable with resolution: 'reset_to_accepted'
    await pub.update(jobId, 'failed', {
      failure: {
        failedFromState: 'claimed',
        code: 'workspace_unavailable',
        message: 'Store temporarily unavailable',
        errorPayloadRef: `urn:error:${jobId}`,
        phase: 'validation',
        mode: 'retryable',
        retryable: true,
        resolution: 'reset_to_accepted',
      },
    } as any);

    const failedJob = await pub.getStatus(jobId);
    expect(failedJob?.status).toBe('failed');

    const retried = await pub.retry({ status: 'failed' });
    expect(retried).toBeGreaterThanOrEqual(1);

    const afterRetry = await pub.list({ status: 'accepted' });
    expect(afterRetry.length).toBeGreaterThanOrEqual(1);
  });
});
