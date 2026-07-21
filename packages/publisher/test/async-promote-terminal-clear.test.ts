import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  type AsyncPromoteQueue,
  type AsyncPromoteQueueConfig,
  type PromoteRequest,
  type PromoteTerminalJobClearer,
} from '../src/async-promote-queue-types.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';

// #1837 — atomic by-exact-jobId TERMINAL clear for the SWM promote queue.
describe('#1837 promote queue clearTerminalJob', () => {
  let store: OxigraphStore;
  let now: number;
  let idCounter: number;

  beforeEach(() => {
    store = new OxigraphStore();
    now = 1_000_000;
    idCounter = 0;
  });

  function createQueue(overrides: Partial<AsyncPromoteQueueConfig> = {}): AsyncPromoteQueue & PromoteTerminalJobClearer {
    return new TripleStoreAsyncPromoteQueue(store, {
      now: () => now,
      idGenerator: () => `job-${++idCounter}`,
      ...overrides,
    }) as TripleStoreAsyncPromoteQueue;
  }

  function makeRequest(overrides: Partial<PromoteRequest> = {}): PromoteRequest {
    return { contextGraphId: 'graphify', subGraphName: 'code', assertionName: 'shard-1', entities: 'all', ...overrides };
  }

  async function enqueueSucceeded(queue: AsyncPromoteQueue, req?: Partial<PromoteRequest>): Promise<string> {
    const jobId = await queue.enqueue(makeRequest(req));
    const claimed = await queue.claimNext('worker-1');
    const token = claimed!.lease!.claimToken;
    // Worker records commit progress — required before succeed().
    await queue.recordCommitMarker(jobId, token, 'swmInserted');
    await queue.recordCommitMarker(jobId, token, 'wmCleaned');
    await queue.recordCommitMarker(jobId, token, 'lifecycleStamped');
    await queue.recordCommitMarker(jobId, token, 'gossiped');
    await queue.succeed(jobId, token, { promotedCount: 1, succeededAt: now });
    return jobId;
  }

  async function enqueueTerminalFailed(queue: AsyncPromoteQueue, req?: Partial<PromoteRequest>): Promise<string> {
    const jobId = await queue.enqueue(makeRequest(req));
    const claimed = await queue.claimNext('worker-1');
    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: 'permanent', retryable: false, classification: 'permanent', recordedAt: now,
    });
    return jobId;
  }

  it('clears an exact succeeded job (cleared); no other job changes', async () => {
    const queue = createQueue();
    const target = await enqueueSucceeded(queue, { assertionName: 'a' });
    const other = await enqueueSucceeded(queue, { assertionName: 'b' });
    expect(await queue.clearTerminalJob(target)).toEqual({ outcome: 'cleared' });
    expect(await queue.getStatus(target)).toBeNull();
    expect((await queue.getStatus(other))?.state).toBe('succeeded'); // untouched
  });

  it('clears an exact terminal-failed job (incl. no retry_recovery carve-out)', async () => {
    const queue = createQueue();
    const jobId = await enqueueTerminalFailed(queue);
    expect(await queue.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
    expect(await queue.getStatus(jobId)).toBeNull();
  });

  it('rejects a queued job as nonterminal without mutation', async () => {
    const queue = createQueue();
    const queued = await queue.enqueue(makeRequest());
    expect(await queue.clearTerminalJob(queued)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await queue.getStatus(queued))?.state).toBe('queued');
  });

  it('rejects a running job as nonterminal without mutation', async () => {
    const queue = createQueue();
    const runningId = await queue.enqueue(makeRequest());
    await queue.claimNext('worker-1');
    expect((await queue.getStatus(runningId))?.state).toBe('running');
    expect(await queue.clearTerminalJob(runningId)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await queue.getStatus(runningId))?.state).toBe('running');
  });

  it('rejects a failed_retrying job as nonterminal without mutation', async () => {
    const queue = createQueue({ backoff: () => 10_000 });
    const retryingId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await queue.fail(retryingId, claimed!.lease!.claimToken, {
      message: 'transient', retryable: true, classification: 'transient', recordedAt: now,
    });
    expect((await queue.getStatus(retryingId))?.state).toBe('failed_retrying');
    expect(await queue.clearTerminalJob(retryingId)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await queue.getStatus(retryingId))?.state).toBe('failed_retrying');
  });

  it('is idempotent: an absent / already-cleared job returns already_absent', async () => {
    const queue = createQueue();
    expect(await queue.clearTerminalJob('never-existed')).toEqual({ outcome: 'already_absent' });
    const jobId = await enqueueSucceeded(queue);
    expect(await queue.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
    expect(await queue.clearTerminalJob(jobId)).toEqual({ outcome: 'already_absent' }); // repeat
  });

  it('rejects a malformed (empty) jobId without mutation', async () => {
    const queue = createQueue();
    expect(await queue.clearTerminalJob('')).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(await queue.clearTerminalJob('   ')).toEqual({ outcome: 'rejected', reason: 'malformed' });
  });

  it('concurrent clears of one terminal job are deterministic: one cleared, rest already_absent, no other job affected', async () => {
    const queue = createQueue();
    const target = await enqueueSucceeded(queue, { assertionName: 'a' });
    const other = await enqueueSucceeded(queue, { assertionName: 'b' });
    const results = await Promise.all([
      queue.clearTerminalJob(target), queue.clearTerminalJob(target), queue.clearTerminalJob(target),
    ]);
    expect(results.filter((r) => r.outcome === 'cleared')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_absent')).toHaveLength(2);
    expect((await queue.getStatus(other))?.state).toBe('succeeded'); // never affected
  });
});
