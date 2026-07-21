import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher, type AsyncLiftPublisherConfig } from '../src/index.js';
import { DEFAULT_CONTROL_GRAPH_URI, jobSubject, serializeJob } from '../src/async-lift-control-plane.js';

// #1837 — atomic by-exact-jobId TERMINAL clear for the async publisher (lift) queue.
describe('#1837 lift publisher clearTerminalJob', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
  });

  function createPublisher(config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {}): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      journalWrites: true,
      ...config,
    });
  }

  function kaVmPublishRequest(overrides: Record<string, unknown> = {}) {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social', name: 'albums', shareOperationId: 'share-op-1',
      roots: [] as string[], contentScopeVersion: 2 as const, kaUal, assertionVersion: '1',
      publicTripleCount: 2, privateTripleCount: 0,
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
        authorAddress: authorAddress as `0x${string}`,
        signature: { r: (`0x${'34'.repeat(32)}`) as `0x${string}`, vs: (`0x${'56'.repeat(32)}`) as `0x${string}` },
        schemeVersion: 1,
        reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
      },
      sealChainId: '31337' as `${bigint}`, sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z', sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      intentKey: `sha256:${'ab'.repeat(32)}`, wmCurrentAssertion: '12'.repeat(32), swmCurrentAssertion: '12'.repeat(32),
      kaNumber: kaNumber.toString(), reservedUal: kaUal, ...overrides,
    };
  }
  const bx = { txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, walletId: 'wallet-1' };
  const inc = { blockNumber: 10, blockHash: `0x${'aa'.repeat(32)}` as `0x${string}`, blockTimestamp: 1 };

  async function driveToValidated(p: TripleStoreAsyncLiftPublisher, o: Record<string, unknown> = {}): Promise<string> {
    const jobId = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest(o));
    await p.claimNext('wallet-1');
    await p.update(jobId, 'validated', {
      validation: { canonicalRoots: [], canonicalRootMap: {}, swmQuadCount: 2, authorityProofRef: 'knowledge-asset-lifecycle', transitionType: 'CREATE' },
    });
    return jobId;
  }
  async function driveToFinalized(p: TripleStoreAsyncLiftPublisher, o: Record<string, unknown> = {}): Promise<string> {
    const jobId = await driveToValidated(p, o);
    await p.update(jobId, 'broadcast', { broadcast: bx });
    await p.update(jobId, 'included', { broadcast: bx, inclusion: inc });
    await p.update(jobId, 'finalized', { broadcast: bx, inclusion: inc, finalization: { mode: 'local' } });
    return jobId;
  }
  // Terminal, non-retryable (tx_reverted → fail_job): clearable, retry() won't touch it.
  async function driveToTerminalFailed(p: TripleStoreAsyncLiftPublisher, o: Record<string, unknown> = {}): Promise<string> {
    const jobId = await driveToValidated(p, o);
    await p.update(jobId, 'broadcast', { broadcast: bx });
    await p.recordPublishFailure(jobId, { error: new Error('tx reverted on chain'), failedFromState: 'broadcast', errorPayloadRef: 'urn:err:1' });
    return jobId;
  }
  it('clears an exact finalized job (cleared); no other job changes', async () => {
    const p = createPublisher();
    const target = await driveToFinalized(p, { name: 'a' });
    const other = await driveToFinalized(p, { name: 'b' });
    expect(await p.clearTerminalJob(target)).toEqual({ outcome: 'cleared' });
    expect(await p.getStatus(target)).toBeNull();
    expect((await p.getStatus(other))?.status).toBe('finalized'); // untouched
  });

  it('clears an exact terminal (non-retryable) failed job', async () => {
    const p = createPublisher();
    const jobId = await driveToTerminalFailed(p);
    expect((await p.getStatus(jobId))?.status).toBe('failed');
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
    expect(await p.getStatus(jobId)).toBeNull();
  });

  it('rejects an accepted (queued) job as nonterminal without mutation', async () => {
    const p = createPublisher();
    const accepted = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(await p.clearTerminalJob(accepted)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(accepted))?.status).toBe('accepted');
  });

  it('rejects a validated job as nonterminal without mutation', async () => {
    const p = createPublisher();
    const validated = await driveToValidated(p);
    expect(await p.clearTerminalJob(validated)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(validated))?.status).toBe('validated');
  });

  it('rejects a broadcast job as nonterminal without mutation', async () => {
    const p = createPublisher();
    const broadcast = await driveToValidated(p);
    await p.update(broadcast, 'broadcast', { broadcast: bx });
    expect(await p.clearTerminalJob(broadcast)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(broadcast))?.status).toBe('broadcast');
  });

  it('rejects a retry_recovery-protected failed job as nonterminal (a pending tx may still land)', async () => {
    // retry_recovery is a raw-lift-only recovery resolution (KA-VM canRetryFailedRecovery
    // is false), so inject a synthetic retry_recovery-failed job to exercise the guard the
    // clearer shares with bulk clear(). Start from a real terminal-failed job and rewrite
    // its persisted resolution.
    const p = createPublisher();
    const jobId = await driveToTerminalFailed(p);
    const job = await p.getStatus(jobId);
    if (!job || !('failure' in job)) throw new Error('expected a failed job');
    const mutated = { ...job, failure: { ...job.failure, resolution: 'retry_recovery' } };
    await store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(serializeJob(mutated as typeof job, DEFAULT_CONTROL_GRAPH_URI));
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(jobId))?.status).toBe('failed'); // unchanged
  });

  it('is idempotent: absent / already-cleared → already_absent', async () => {
    const p = createPublisher();
    expect(await p.clearTerminalJob('never-existed')).toEqual({ outcome: 'already_absent' });
    const jobId = await driveToFinalized(p);
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'already_absent' });
  });

  it('rejects a malformed (empty) jobId without mutation', async () => {
    const p = createPublisher();
    expect(await p.clearTerminalJob('')).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(await p.clearTerminalJob('  ')).toEqual({ outcome: 'rejected', reason: 'malformed' });
  });

  it('preserves the #1829 journal: clearing a terminal job leaves its journal lineage readable', async () => {
    const p = createPublisher();
    const jobId = await driveToFinalized(p);
    expect((await p.readJournalByJob(jobId)).entries.length).toBeGreaterThan(0);
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
    expect(await p.getStatus(jobId)).toBeNull(); // gone from control plane
    const journal = await p.readJournalByJob(jobId);
    expect(journal.entries.length).toBeGreaterThan(0); // lineage survives the clear
    expect(journal.entries.some((e) => e.kind === 'finalized')).toBe(true);
  });

  it('no-sweep: a clearable-failed job reaccepted by concurrent retry() is never deleted while active', async () => {
    // maxRetries:1 + a retryable failure (rpc_unavailable/reset_to_accepted) → the job is
    // BOTH clearable (terminal failed, not retry_recovery) AND reacceptable by retry().
    // clearTerminalJob and retry() both run under withClaimLock, so they serialize:
    // whichever wins, an ACTIVE job is never swept.
    const p = createPublisher({ maxRetries: 1 });
    const jobId = await driveToValidated(p, { name: 'race' });
    await p.update(jobId, 'broadcast', { broadcast: bx });
    await p.recordPublishFailure(jobId, { error: new Error('rpc temporarily down'), failedFromState: 'broadcast', errorPayloadRef: 'urn:err:2' });
    const failed = await p.getStatus(jobId);
    expect(failed?.status).toBe('failed');
    expect(failed && 'failure' in failed && failed.failure.retryable).toBe(true);

    const [clearOutcome, retried] = await Promise.all([p.clearTerminalJob(jobId), p.retry({ status: 'failed' })]);
    const after = await p.getStatus(jobId);
    if (clearOutcome.outcome === 'cleared') {
      // clear won: job gone, retry could not have reaccepted it.
      expect(after).toBeNull();
      expect(retried).toBe(0);
    } else {
      // retry won: job is active ('accepted'); clear must have rejected it, NOT deleted it.
      expect(clearOutcome).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
      expect(after?.status).toBe('accepted');
      expect(retried).toBe(1);
    }
  });

  it('concurrent clears of one terminal job are deterministic: one cleared, rest already_absent', async () => {
    const p = createPublisher();
    const target = await driveToFinalized(p, { name: 'a' });
    const other = await driveToFinalized(p, { name: 'b' });
    const results = await Promise.all([p.clearTerminalJob(target), p.clearTerminalJob(target), p.clearTerminalJob(target)]);
    expect(results.filter((r) => r.outcome === 'cleared')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_absent')).toHaveLength(2);
    expect((await p.getStatus(other))?.status).toBe('finalized'); // never affected
  });
});
