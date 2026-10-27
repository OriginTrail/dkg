/**
 * Characterization of the share queue's complete reads (OT-RFC-73 P8a). The listing, statistics and post-commit sweep
 * move to paged and aggregate reads in P8a; `claimNext`, its lane-conflict guard and recovery keep their complete reads.
 * This file passes unchanged against the code before P8a and has to keep passing after it:
 *
 *   - `list()` returns every matching job, sorted by ready time (`nextRetryAt` when set, else `enqueuedAt`) and then
 *     `jobId.localeCompare`, however many jobs there are; `limit` cuts after that sort; a listing observes the jobs it read;
 *   - `getStats()` counts every state, zero-filled;
 *   - `recoverPostCommitFailures()` requeues or exhausts exactly the post-commit failures the recovery policy names, in
 *     queue order, defers a row whose assertion another active job owns, and touches nothing else;
 *   - `claimNext` reads the complete active set (never a page of it), orders by ready time and holds back a candidate whose
 *     claim lane a running job holds, including the legacy rows that carry no lane.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PROMOTE_JOB_STATES, PromoteJobConflictError, type PromoteJob, type PromoteJobState } from '../src/async-promote-queue-types.js';
import { PROMOTE_POST_COMMIT_FAILURE_MESSAGE } from '../src/promote-replay-safety.js';
import { ROW_AGENT, ROW_NOW as NOW, seedShareRows, seedUnreadableRow, shareRow, type ShareRowSpec } from './_helpers/share-job-rows.js';

function queueOver(store: TripleStore, clock = NOW) {
  let now = clock;
  const queue = new TripleStoreAsyncPromoteQueue(store, {
    now: () => now, claimTokenGenerator: () => 't', backoff: () => 1_000, idGenerator: () => 'generated',
  });
  return { queue, setNow: (value: number) => { now = value; } };
}

async function seeded(specs: readonly ShareRowSpec[], clock = NOW) {
  const store = new OxigraphStore();
  await seedShareRows(store, specs);
  return { store, ...queueOver(store, clock) };
}

const ids = (jobs: readonly PromoteJob[]) => jobs.map((job) => job.jobId);

describe('list(): order, filters and completeness', () => {
  const population: ShareRowSpec[] = [
    { id: 'late', state: 'failed', enqueuedAt: NOW + 50 },
    { id: 'B-up', state: 'queued', enqueuedAt: NOW + 10 },
    { id: 'retry', state: 'failed_retrying', enqueuedAt: NOW, nextRetryAt: NOW + 30 },
    { id: 'a-low', state: 'queued', enqueuedAt: NOW + 10, contextGraphId: 'cg-other' },
    { id: 'early', state: 'succeeded', enqueuedAt: NOW + 5 },
    { id: 'busy', state: 'running', enqueuedAt: NOW + 60 },
  ];

  it('sorts by ready time and breaks a tie with jobId.localeCompare, not with code point order', async () => {
    // The pair is chosen so the two orders differ: a-low < B-up by locale, B-up < a-low by code point.
    expect('a-low'.localeCompare('B-up')).toBeLessThan(0);
    expect(['a-low', 'B-up'].sort()).toEqual(['B-up', 'a-low']);
    const { queue } = await seeded(population);
    // `retry` was enqueued first but is ready at +30, so it sorts by its retry time.
    expect(ids(await queue.list())).toEqual(['early', 'a-low', 'B-up', 'retry', 'late', 'busy']);
  });

  it('cuts at limit after the sort, and treats a missing, zero or negative limit as none', async () => {
    const { queue } = await seeded(population);
    expect(ids(await queue.list({ limit: 3 }))).toEqual(['early', 'a-low', 'B-up']);
    expect(ids(await queue.list({ limit: 2.9 }))).toEqual(['early', 'a-low']);
    expect(await queue.list({ limit: 0 })).toHaveLength(6);
    expect(await queue.list({ limit: -4 })).toHaveLength(6);
    expect(await queue.list({ limit: 100 })).toHaveLength(6);
  });

  it('filters by state (duplicates collapse, an empty list means no filter) and by context graph', async () => {
    const { queue } = await seeded(population);
    expect(ids(await queue.list({ state: ['queued', 'queued', 'running'] }))).toEqual(['a-low', 'B-up', 'busy']);
    expect(await queue.list({ state: [] })).toHaveLength(6);
    expect(ids(await queue.list({ contextGraphId: 'cg-other' }))).toEqual(['a-low']);
    expect(ids(await queue.list({ contextGraphId: 'cg-other', state: ['queued'] }))).toEqual(['a-low']);
    expect(await queue.list({ contextGraphId: 'cg-other', state: ['failed'] })).toEqual([]);
    expect(await queue.list({ contextGraphId: 'cg-none' })).toEqual([]);
    expect(ids(await queue.list({ state: ['queued', 'failed_retrying'], limit: 2 }))).toEqual(['a-low', 'B-up']);
  });

  it('returns the whole stored job, not a projection of it', async () => {
    const { queue } = await seeded(population);
    const [early, , , , , busy] = await queue.list();
    expect(early).toEqual(shareRow({ id: 'early', state: 'succeeded', enqueuedAt: NOW + 5 }));
    expect(busy).toEqual(shareRow({ id: 'busy', state: 'running', enqueuedAt: NOW + 60 }));
  });

  it('skips a row it cannot decode and a row in a state it does not know, without failing', async () => {
    const store = new OxigraphStore();
    await seedShareRows(store, [{ id: 'good', state: 'queued' }, { id: 'odd-state', state: 'bogus' as PromoteJobState }]);
    await seedUnreadableRow(store, 'broken', 'queued');
    const { queue } = queueOver(store);
    expect(ids(await queue.list())).toEqual(['good']);
    expect(ids(await queue.list({ state: ['queued'] }))).toEqual(['good']);
  });

  it('returns every job of a history longer than any page, in the same order', async () => {
    const specs: ShareRowSpec[] = [];
    for (let i = 0; i < 1_250; i++) specs.push({ id: `done-${i}`, state: 'succeeded', enqueuedAt: NOW - 10_000 + i, contextGraphId: i % 2 ? 'cg-odd' : 'cg-even' });
    for (let i = 0; i < 40; i++) specs.push({ id: `live-${i}`, state: 'queued', enqueuedAt: NOW + i });
    const { queue } = await seeded(specs);
    const all = await queue.list();
    expect(all).toHaveLength(1_290);
    expect(ids(all)).toEqual([...specs].sort((a, b) => (a.enqueuedAt! - b.enqueuedAt!) || a.id.localeCompare(b.id)).map((spec) => spec.id));
    expect(await queue.list({ state: ['queued'] })).toHaveLength(40);
    expect(await queue.list({ contextGraphId: 'cg-odd', state: ['succeeded'] })).toHaveLength(625);
    expect(ids(await queue.list({ limit: 3 }))).toEqual(['done-0', 'done-1', 'done-2']);
  });

  it('observes the jobs it read: a later admission of an active job\'s selector is answered from that observation', async () => {
    const { queue } = await seeded([{ id: 'owner', state: 'queued', name: 'sel' }]);
    const request = { contextGraphId: 'cg-rows', assertionName: 'sel', entities: 'all' as const, agentAddress: ROW_AGENT };
    // Nothing has read the row yet: the admission finds the owner by its durable lookup, which is not an observation.
    await expect(queue.enqueue(request)).rejects.toMatchObject({ existingJobId: 'owner', observedAdmission: false });
    const { queue: other } = await seeded([{ id: 'owner', state: 'queued', name: 'sel' }]);
    await other.list();
    const rejection = await other.enqueue(request).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PromoteJobConflictError);
    expect(rejection).toMatchObject({ existingJobId: 'owner', observedAdmission: true });
  });
});

describe('getStats()', () => {
  it('counts every state, with a zero for each state nothing is in', async () => {
    const { queue } = await seeded([
      { id: 'q1', state: 'queued' }, { id: 'q2', state: 'queued' }, { id: 'q3', state: 'queued' },
      { id: 'r1', state: 'running' }, { id: 's1', state: 'succeeded' }, { id: 's2', state: 'succeeded' },
      { id: 'f1', state: 'failed' }, { id: 'odd', state: 'bogus' as PromoteJobState },
    ]);
    expect(await queue.getStats()).toEqual({ queued: 3, running: 1, succeeded: 2, failed: 1, failed_retrying: 0 });
    expect(Object.keys(await queue.getStats()).sort()).toEqual([...PROMOTE_JOB_STATES].sort());
  });

  it('is all zeros for an empty queue and counts a history longer than any page', async () => {
    expect(await (await seeded([])).queue.getStats()).toEqual({ queued: 0, running: 0, succeeded: 0, failed: 0, failed_retrying: 0 });
    const specs: ShareRowSpec[] = [];
    for (let i = 0; i < 1_300; i++) specs.push({ id: `h-${i}`, state: i % 5 === 0 ? 'failed' : 'succeeded', enqueuedAt: NOW + i });
    const stats = await (await seeded(specs)).queue.getStats();
    expect(stats).toMatchObject({ failed: 260, succeeded: 1_040 });
  });
});

describe('recoverPostCommitFailures()', () => {
  const postCommit = { message: PROMOTE_POST_COMMIT_FAILURE_MESSAGE, retryable: false, classification: 'fatal' as const, recordedAt: NOW, diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE' };
  const legacyMessage = { message: PROMOTE_POST_COMMIT_FAILURE_MESSAGE, retryable: false, classification: 'fatal' as const, recordedAt: NOW };
  const other = { message: 'assertion not found', retryable: false, classification: 'fatal' as const, recordedAt: NOW };
  const failed = (id: string, at: number, over: Partial<ShareRowSpec> = {}): ShareRowSpec =>
    ({ id, state: 'failed', enqueuedAt: NOW + at, lastError: postCommit, attemptCount: 1, maxRetries: 3, ...over });

  const population: ShareRowSpec[] = [
    failed('requeue-code', 10),
    failed('requeue-message', 20, { lastError: legacyMessage }),
    failed('exhausted', 30, { attemptCount: 3 }),
    failed('other-error', 40, { lastError: other }),
    failed('has-reason', 50, { reason: 'cancelled' }),
    failed('swm-inserted', 60, { swmInserted: true }),
    failed('newer-format', 70, { formatVersion: 5 }),
    failed('older-format', 80, { formatVersion: 1 }),
    failed('author-only', 90, { formatVersion: 2, agentAddress: null, authorAgentAddress: ROW_AGENT }),
    failed('manual', 100, { lastError: { ...postCommit, message: 'partial promote ambiguity: seen after the insert' } }),
    failed('deferred', 110, { name: 'owned' }),
    { id: 'owner', state: 'queued', enqueuedAt: NOW + 5, name: 'owned' },
    { id: 'done', state: 'succeeded', enqueuedAt: NOW + 15, lastError: postCommit },
    { id: 'retrying', state: 'failed_retrying', enqueuedAt: NOW + 25, lastError: postCommit },
    failed('requeue-late', 120, { name: 'late-asset' }),
  ];

  it('requeues, exhausts and skips exactly the rows the recovery policy names, in queue order', async () => {
    const { queue, setNow } = await seeded(population);
    setNow(NOW + 500);
    expect(await queue.recoverPostCommitFailures()).toEqual([
      { jobId: 'requeue-code', action: 'requeued', attempt: 1, maxAttempts: 3, nextRetryAt: NOW + 1_500 },
      { jobId: 'requeue-message', action: 'requeued', attempt: 1, maxAttempts: 3, nextRetryAt: NOW + 1_500 },
      { jobId: 'exhausted', action: 'exhausted', attempt: 3, maxAttempts: 3 },
      { jobId: 'requeue-late', action: 'requeued', attempt: 1, maxAttempts: 3, nextRetryAt: NOW + 1_500 },
    ]);
    const state = async (id: string) => (await queue.getStatus(id))!;
    expect(await state('requeue-code')).toMatchObject({ state: 'failed_retrying', attempt: { count: 1, maxRetries: 3, nextRetryAt: NOW + 1_500 } });
    expect((await state('requeue-code')).attempt.lastError).toMatchObject({ diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE', retryable: true });
    expect(await state('exhausted')).toMatchObject({ state: 'failed', reason: 'automatic post-commit recovery exhausted after 3 attempts; needs operator inspection', updatedAt: NOW + 500 });
    for (const untouched of ['other-error', 'has-reason', 'swm-inserted', 'newer-format', 'older-format', 'author-only', 'manual', 'deferred']) {
      expect(await state(untouched), untouched).toEqual(shareRow(population.find((spec) => spec.id === untouched)!));
    }
    expect((await state('done')).state).toBe('succeeded');
    // Idempotent: the requeued rows left the failed state and the exhausted row carries its verdict.
    expect(await queue.recoverPostCommitFailures()).toEqual([]);
  });

  it('recovers a deferred row once the job that owned its assertion is gone', async () => {
    const { queue, setNow } = await seeded(population);
    setNow(NOW + 500);
    await queue.recoverPostCommitFailures();
    await queue.cancel('owner');
    expect(await queue.recoverPostCommitFailures()).toEqual([
      { jobId: 'deferred', action: 'requeued', attempt: 1, maxAttempts: 3, nextRetryAt: NOW + 1_500 },
    ]);
  });

  it('handles a failed backlog longer than any page: every recoverable row once, every other row untouched', async () => {
    const specs: ShareRowSpec[] = [];
    for (let i = 0; i < 260; i++) {
      specs.push(i % 3 === 0 ? failed(`pc-${String(i).padStart(3, '0')}`, i) : failed(`x-${String(i).padStart(3, '0')}`, i, { lastError: other }));
    }
    for (let i = 0; i < 300; i++) specs.push({ id: `ok-${i}`, state: 'succeeded', enqueuedAt: NOW - 10_000 + i });
    const { queue, setNow } = await seeded(specs);
    setNow(NOW + 1_000);
    const events = await queue.recoverPostCommitFailures();
    const expected = specs.filter((spec) => spec.id.startsWith('pc-')).map((spec) => spec.id);
    expect(events.map((event) => event.jobId)).toEqual(expected);
    expect(events.every((event) => event.action === 'requeued')).toBe(true);
    expect((await queue.getStats())).toMatchObject({ failed: 260 - expected.length, failed_retrying: expected.length, succeeded: 300 });
  });
});

describe('claimNext(): the complete active set, ready-time order and the lane-conflict guard', () => {
  async function drain(queue: TripleStoreAsyncPromoteQueue, workers = 'w'): Promise<string[]> {
    const order: string[] = [];
    for (;;) {
      const job = await queue.claimNext(workers);
      if (!job) return order;
      order.push(job.jobId);
    }
  }

  it('sees a due retry that sorts first among more active jobs than any page holds, and then the rest in order', async () => {
    const specs: ShareRowSpec[] = [];
    for (let i = 0; i < 1_100; i++) specs.push({ id: `q-${String(i).padStart(4, '0')}`, state: 'queued', enqueuedAt: NOW + 10 + i });
    specs.push({ id: 'retry-due', state: 'failed_retrying', enqueuedAt: NOW + 5_000, nextRetryAt: NOW + 1 });
    for (let i = 0; i < 300; i++) specs.push({ id: `old-${i}`, state: 'succeeded', enqueuedAt: NOW - 5_000 + i });
    const { queue } = await seeded(specs, NOW + 9_000);
    const claimed: string[] = [];
    for (let i = 0; i < 4; i++) claimed.push((await queue.claimNext('w'))!.jobId);
    expect(claimed).toEqual(['retry-due', 'q-0000', 'q-0001', 'q-0002']);
  });

  it('reads the active states only, so a long history does not enter the claim read', async () => {
    const store = new OxigraphStore();
    await seedShareRows(store, [{ id: 'job', state: 'queued' }, { id: 'old', state: 'succeeded', enqueuedAt: NOW - 1_000 }]);
    const queries: string[] = [];
    const recording = new Proxy(store, { get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'query') return typeof value === 'function' ? value.bind(target) : value;
      return (text: string, options?: { source?: string }) => {
        if (options?.source === 'publisher.asyncPromote.claimNext.candidates') queries.push(text);
        return target.query(text, options);
      };
    } }) as TripleStore;
    const { queue } = queueOver(recording);
    expect((await queue.claimNext('w'))?.jobId).toBe('job');
    expect(queries).toHaveLength(1);
    for (const state of ['queued', 'running', 'failed_retrying']) expect(queries[0]).toContain(`"${state}"`);
    expect(queries[0]).not.toContain('"succeeded"');
    expect(queries[0]).not.toContain('"failed"');
    expect(queries[0]).not.toMatch(/LIMIT|OFFSET/i);
  });

  it('holds back a candidate only for a running job on its own lane', async () => {
    const other = '0x2222222222222222222222222222222222222222';
    const { queue } = await seeded([
      { id: 'holder', state: 'running', name: 'asset', agentAddress: ROW_AGENT, enqueuedAt: NOW },
      { id: 'same-lane', state: 'queued', name: 'asset', agentAddress: ROW_AGENT, enqueuedAt: NOW + 1 },
      { id: 'other-lane', state: 'queued', name: 'asset', agentAddress: other, enqueuedAt: NOW + 2 },
      { id: 'other-asset', state: 'queued', name: 'asset-2', agentAddress: ROW_AGENT, enqueuedAt: NOW + 3 },
    ]);
    expect(await drain(queue)).toEqual(['other-lane', 'other-asset']);
  });

  it('lets a running job that carries no lane (a pre-v3 row) hold every lane of its assertion', async () => {
    const other = '0x2222222222222222222222222222222222222222';
    const { queue } = await seeded([
      { id: 'legacy-holder', state: 'running', name: 'asset', agentAddress: null, formatVersion: 2, enqueuedAt: NOW },
      { id: 'lane-a', state: 'queued', name: 'asset', agentAddress: ROW_AGENT, enqueuedAt: NOW + 1 },
      { id: 'lane-b', state: 'queued', name: 'asset', agentAddress: other, enqueuedAt: NOW + 2 },
      { id: 'elsewhere', state: 'queued', name: 'asset-2', agentAddress: ROW_AGENT, enqueuedAt: NOW + 3 },
    ]);
    expect(await drain(queue)).toEqual(['elsewhere']);
  });

  it('holds back a pre-v3 candidate that carries no lane while any lane of its assertion is running', async () => {
    const { queue } = await seeded([
      { id: 'holder', state: 'running', name: 'asset', agentAddress: ROW_AGENT, enqueuedAt: NOW },
      { id: 'legacy-candidate', state: 'queued', name: 'asset', agentAddress: null, formatVersion: 2, enqueuedAt: NOW + 1 },
      { id: 'free', state: 'queued', name: 'asset-2', enqueuedAt: NOW + 2 },
    ]);
    expect(await drain(queue)).toEqual(['free']);
  });

  it('claims two jobs of one lane one after the other, because the first claim is then running', async () => {
    const { queue } = await seeded([
      { id: 'first', state: 'queued', name: 'asset', enqueuedAt: NOW },
      { id: 'second', state: 'queued', name: 'asset', enqueuedAt: NOW + 1 },
    ]);
    expect((await queue.claimNext('w'))?.jobId).toBe('first');
    expect(await queue.claimNext('w')).toBeNull();
  });
});
