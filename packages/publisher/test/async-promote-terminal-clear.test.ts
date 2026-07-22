import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  type AsyncPromoteQueue,
  type AsyncPromoteQueueConfig,
  type PromoteRequest,
  type PromoteTerminalJobClearer,
} from '../src/async-promote-queue-types.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_PAYLOAD, classifyJobPayload, jobSubject, literal, parseJobPayload } from '../src/async-promote-queue-utils.js';

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

  it('rejects an empty or SPARQL-unsafe jobId as malformed without querying/mutating', async () => {
    const queue = createQueue();
    expect(await queue.clearTerminalJob('')).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(await queue.clearTerminalJob('   ')).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(await queue.clearTerminalJob('bad id')).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(await queue.clearTerminalJob('bad>id')).toEqual({ outcome: 'rejected', reason: 'malformed' });
  });

  // #1893: a structurally-valid payload whose `state` is not a recognized enum value must be
  // a bounded reject (unknown) — classified from the single canonical payload read.
  it('rejects a job whose payload state is not a known enum value as unknown, without throwing', async () => {
    const queue = createQueue();
    const bogusJob = {
      jobId: 'bogus-1', state: 'bogus_state',
      request: makeRequest(), enqueuedAt: now, updatedAt: now,
      attempt: { count: 0, maxRetries: 3 },
    };
    await store.insert([
      { subject: jobSubject('bogus-1'), predicate: PROMOTE_PAYLOAD, object: literal(JSON.stringify(bogusJob)), graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI },
    ]);
    await expect(queue.clearTerminalJob('bogus-1')).resolves.toEqual({ outcome: 'rejected', reason: 'unknown' });
  });

  // #1893: a payload literal that is present but not a valid job is malformed, not unknown.
  it('rejects a subject with a corrupt payload literal as malformed', async () => {
    const queue = createQueue();
    await store.insert([
      { subject: jobSubject('corrupt-1'), predicate: PROMOTE_PAYLOAD, object: literal('not-a-job-json'), graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI },
    ]);
    await expect(queue.clearTerminalJob('corrupt-1')).resolves.toEqual({ outcome: 'rejected', reason: 'malformed' });
  });

  // #1893 (review): a payload that is otherwise well-formed but carries no string `state` is
  // structural corruption → malformed (HTTP 400), NOT the unknown-state path (HTTP 409).
  it('rejects a payload with a missing/non-string state as malformed, not unknown', async () => {
    const queue = createQueue();
    const noState = { jobId: 'nostate-1', request: makeRequest(), enqueuedAt: now, updatedAt: now, attempt: { count: 0, maxRetries: 3 } };
    await store.insert([
      { subject: jobSubject('nostate-1'), predicate: PROMOTE_PAYLOAD, object: literal(JSON.stringify(noState)), graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI },
    ]);
    await expect(queue.clearTerminalJob('nostate-1')).resolves.toEqual({ outcome: 'rejected', reason: 'malformed' });
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

// #1893 — the bounded classifier the single-read clear is built on.
describe('classifyJobPayload', () => {
  const validJob = {
    jobId: 'j1', state: 'queued',
    request: { contextGraphId: 'g', assertionName: 'a', entities: 'all' },
    enqueuedAt: 1, updatedAt: 1, attempt: { count: 0, maxRetries: 3 },
  };
  // Mirror serializeJob's PROMOTE_PAYLOAD encoding: literal(JSON.stringify(job)).
  const bind = (v: unknown) => literal(JSON.stringify(v));

  it('absent for an undefined or empty binding', () => {
    expect(classifyJobPayload(undefined)).toEqual({ kind: 'absent' });
    expect(classifyJobPayload('')).toEqual({ kind: 'absent' });
  });

  it('malformed for a non-JSON or structurally-invalid payload', () => {
    expect(classifyJobPayload(literal('not-json')).kind).toBe('malformed');
    expect(classifyJobPayload(bind({ ...validJob, jobId: '' })).kind).toBe('malformed');
    expect(classifyJobPayload(bind({ ...validJob, request: {} })).kind).toBe('malformed');
    expect(classifyJobPayload(bind({ ...validJob, enqueuedAt: 'x' })).kind).toBe('malformed');
  });

  // #1893 (review): a missing or non-string `state` is structural corruption — it must be
  // `malformed`, NOT `unknown` (which is reserved for a well-formed but non-enum state string).
  it('malformed for a missing or non-string state', () => {
    expect(classifyJobPayload(bind({ ...validJob, state: undefined })).kind).toBe('malformed'); // JSON.stringify drops the key
    expect(classifyJobPayload(bind({ ...validJob, state: '' })).kind).toBe('malformed');
    expect(classifyJobPayload(bind({ ...validJob, state: 42 })).kind).toBe('malformed');
    expect(classifyJobPayload(bind({ ...validJob, state: null })).kind).toBe('malformed');
  });

  it('job for a structurally-valid payload, INCLUDING a non-enum state string', () => {
    expect(classifyJobPayload(bind(validJob))).toMatchObject({ kind: 'job' });
    const result = classifyJobPayload(bind({ ...validJob, state: 'bogus_state' }));
    expect(result.kind).toBe('job');
    if (result.kind === 'job') expect(result.job.state).toBe('bogus_state');
  });

  // #1893 (review round 2): the classifier deliberately accepts a non-enum state string as
  // `kind: 'job'` (so the terminal clear can report `unknown`), which makes parseJobPayload the
  // ONLY runtime guard that keeps ordinary readers (list/getStatus/conflict) from surfacing a
  // row with an impossible state. Lock that strict enum-drop directly here: were it removed from
  // parseJobPayload, this asserts red even though the classifier tests above stay green.
  it('parseJobPayload re-applies the enum drop the classifier defers', () => {
    const nonEnum = bind({ ...validJob, state: 'bogus_state' });
    expect(classifyJobPayload(nonEnum).kind).toBe('job'); // classifier accepts it for terminal-clear classification
    expect(parseJobPayload(nonEnum)).toBeNull();          // strict wrapper rejects it for read/list/conflict callers
    expect(parseJobPayload(bind(validJob))).not.toBeNull(); // a valid enum state is returned unchanged
  });
});
