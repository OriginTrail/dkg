import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, StoreSchedulerBusyError, StorePriorityScheduler, type TripleStore } from '@origintrail-official/dkg-storage';
import { jobSubject, literal, PROMOTE_PAYLOAD } from '../src/async-promote-queue-utils.js';
import { isAutomaticallyRecoverablePostCommitFailure } from '../src/async-promote-recovery-policy.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PromoteAdmissionAttempt, PromoteAdmissionCoordinator, type PromoteAdmissionEvent } from '../src/promote-admission.js';
import type { AsyncPromoteQueueConfig, PromoteRequest, PromoteJob } from '../src/async-promote-queue-types.js';

const request: PromoteRequest = { contextGraphId: 'admission-test', assertionName: 'asset', entities: 'all' };
function gate() {
  let release!: () => void, enter!: () => void;
  return { held: new Promise<void>(resolve => { release = resolve; }),
    entered: new Promise<void>(resolve => { enter = resolve; }),
    release: () => release(), enter: () => enter() };
}
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });
function fixture(intercept: (method: string, args: unknown[], run: () => Promise<unknown>) => Promise<unknown>) {
  const inner = new OxigraphStore(); stores.push(inner);
  const store = new Proxy(inner, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function'
      ? (...args: unknown[]) => intercept(String(prop), args, () => value.apply(target, args)) : value;
  } }) as TripleStore;
  const config = { graphUri: `urn:test:admission:${crypto.randomUUID()}`, admissionTimeoutMs: 25 } as AsyncPromoteQueueConfig;
  const queue = new TripleStoreAsyncPromoteQueue(store, config);
  return { inner, store, config, queue };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const bounded = <T>(promise: Promise<T>) => Promise.race([
  promise.then(value => ({ value }), error => ({ error })),
  new Promise<{ stalled: true }>(resolve => setTimeout(() => resolve({ stalled: true }), 100)),
]);

describe('async promote admission under store pressure (#3331)', () => {
  it('expires during conflict lookup and never admits later after the caller has a no-admission verdict', async () => {
    const delay = gate(); let armed = true;
    const { queue } = fixture(async (method, args, run) => {
      if (armed && method === 'query' && (args[1] as { source?: string })?.source === 'publisher.asyncPromote.findActiveConflict') {
        armed = false; delay.enter(); await delay.held;
      }
      return run();
    });
    const admission = bounded(queue.enqueue(request));
    try {
      await delay.entered;
      expect(await admission).toMatchObject({ error: { code: 'PROMOTE_ADMISSION_UNAVAILABLE', admissionOutcome: 'not_admitted', phase: 'conflict' } });
    } finally { delay.release(); }
    await tick();
    expect(await queue.list()).toEqual([]);
  });

  it('returns the original handle on replay while its persistence is still in flight', async () => {
    const delay = gate(); let armed = true;
    const { queue } = fixture(async (method, _args, run) => {
      if (armed && method === 'replaceSubject') { armed = false; delay.enter(); await delay.held; }
      return run();
    });
    const first = bounded(queue.enqueue(request));
    try {
      await delay.entered;
      const original = await first;
      expect(original).toMatchObject({ error: { admissionOutcome: 'indeterminate', phase: 'persist', jobId: expect.any(String) } });
      const replay = await bounded(queue.enqueue(request));
      expect(replay).toMatchObject({ error: { admissionOutcome: 'indeterminate', jobId: (original as { error: { jobId: string } }).error.jobId } });
    } finally { delay.release(); }
    await tick();
    expect(await queue.list()).toHaveLength(1);
  });

  it('reconciles an acknowledged owner without waiting behind an unrelated locked read', async () => {
    let armed = false; const delay = gate();
    const { queue } = fixture(async (method, args, run) => {
      if (armed && method === 'query' && (args[1] as { source?: string })?.source === 'publisher.asyncPromote.list') {
        armed = false; delay.enter(); await delay.held;
      }
      return run();
    });
    const id = await queue.enqueue(request);
    armed = true; const list = queue.list();
    try {
      await delay.entered;
      expect(await bounded(queue.enqueue(request))).toMatchObject({ error: { existingJobId: id } });
    } finally { delay.release(); await list; }
    expect(await queue.list()).toHaveLength(1);
  });

  it.each(['query', 'replaceSubject'] as const)('does not lift a post-commit nested %s not_started error into whole-admission evidence', async storeOperation => {
    let armed = true;
    const { queue } = fixture(async (method, _args, run) => {
      const result = await run();
      if (armed && method === 'flush') {
        armed = false;
        throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'nested.flush.query', { storeOperation });
      }
      return result;
    });
    const result = await bounded(queue.enqueue(request));
    expect(result).toMatchObject({ error: { code: 'PROMOTE_ADMISSION_UNAVAILABLE', admissionOutcome: 'indeterminate', jobId: expect.any(String) } });
    expect(await queue.list()).toHaveLength(1);
  });
});

it.each(['lock', 'graph'] as const)('bounds %s waiting without leaving a late admission', async phase => {
  const delay = gate(); let armed = true;
  const { queue } = fixture(async (method, args, run) => {
    if (armed && (phase === 'graph' ? method === 'createGraph'
      : method === 'query' && (args[1] as { source?: string })?.source === 'publisher.asyncPromote.list')) {
      armed = false; delay.enter(); await delay.held;
    }
    return run();
  });
  const blocker = phase === 'lock' ? queue.list() : undefined;
  const admission = bounded(queue.enqueue(request));
  try {
    await delay.entered;
    expect(await admission).toMatchObject({ error: { admissionOutcome: 'not_admitted', phase } });
  } finally { delay.release(); await blocker; }
  await tick();
  expect(await queue.list()).toEqual([]);
});

it('keeps cancellation, terminal clear and subsequent new sharing semantics', async () => {
  const { queue, store, config } = fixture(async (_method, _args, run) => run());
  const other = new TripleStoreAsyncPromoteQueue(store, config);
  const first = await queue.enqueue(request);
  await expect(other.enqueue(request)).rejects.toMatchObject({ existingJobId: first, observedAdmission: true });
  await other.cancel(first);
  await expect(queue.clearTerminalJob(first)).resolves.toEqual({ outcome: 'cleared' });
  const second = await queue.enqueue(request);
  expect(second).not.toBe(first);
  expect(await queue.list()).toHaveLength(1);
});

it('does not share positive observations between independent stores', async () => {
  const one = fixture(async (_method, _args, run) => run());
  const two = fixture(async (_method, _args, run) => run());
  const other = new TripleStoreAsyncPromoteQueue(two.store, one.config);
  expect(await other.enqueue(request)).not.toBe(await one.queue.enqueue(request));
});

it('uses durable conflict exclusion with a cold coordinator after restart', async () => {
  let lookups = 0;
  const { queue, inner, config } = fixture(async (method, args, run) => {
    if (method === 'query' && (args[1] as { source?: string })?.source === 'publisher.asyncPromote.findActiveConflict') lookups++;
    return run();
  });
  const id = await queue.enqueue(request);
  const restarted = new TripleStoreAsyncPromoteQueue(inner, config);
  await expect(restarted.enqueue(request)).rejects.toMatchObject({ existingJobId: id, observedAdmission: false });
  expect(lookups).toBe(1); // the restarted reader uses inner directly, not the observation
  expect(await restarted.list()).toHaveLength(1);
});

it('retains a failed persistence handle until an authoritative read finds the job', async () => {
  let armed = true, writes = 0;
  const { queue } = fixture(async (method, _args, run) => {
    if (method === 'replaceSubject') writes++;
    const result = await run();
    if (armed && method === 'flush') { armed = false; throw new Error('lost reply'); }
    return result;
  });
  const first = await bounded(queue.enqueue(request)) as { error: { jobId: string } };
  await expect(queue.enqueue(request)).rejects.toMatchObject({ jobId: first.error.jobId, admissionOutcome: 'indeterminate' });
  expect(writes).toBe(1);
  expect((await queue.getStatus(first.error.jobId))?.state).toBe('queued');
  await expect(queue.enqueue(request)).rejects.toMatchObject({ existingJobId: first.error.jobId });
  expect(writes).toBe(1);
});

it('retains unresolved uncertainty even when a read sees no job; never manufactures another operation', async () => {
  let writes = 0;
  const { queue } = fixture(async (method, _args, run) => {
    if (method === 'replaceSubject') { writes++; throw new Error('transport disconnected before acknowledgement'); }
    return run();
  });
  const first = await bounded(queue.enqueue(request)) as { error: { jobId: string } };
  expect(await queue.getStatus(first.error.jobId)).toBeNull();
  expect(await queue.clearTerminalJob(first.error.jobId)).toEqual({ outcome: 'already_absent' });
  await expect(queue.enqueue(request)).rejects.toMatchObject({ jobId: first.error.jobId, admissionOutcome: 'indeterminate' });
  expect(writes).toBe(1);
});

it('bounds pending entries while a blocked mutex drains expired requests', async () => {
  const delay = gate(); let armed = true;
  const { queue } = fixture(async (method, args, run) => {
    if (armed && method === 'query' && (args[1] as { source?: string })?.source === 'publisher.asyncPromote.list') {
      armed = false; delay.enter(); await delay.held;
    }
    return run();
  });
  const blocker = queue.list(); await delay.entered;
  try {
    const admissions = Array.from({ length: 64 }, (_, i) => bounded(queue.enqueue({ ...request, assertionName: `asset-${i}` })));
    await expect(queue.enqueue(request)).rejects.toMatchObject({ admissionOutcome: 'not_admitted', phase: 'lock' });
    for (const result of await Promise.all(admissions)) expect(result).toMatchObject({ error: { admissionOutcome: 'not_admitted' } });
    await expect(queue.enqueue(request)).rejects.toMatchObject({ admissionOutcome: 'not_admitted', phase: 'lock' });
  } finally { delay.release(); await blocker; }
  await tick();
  expect(await queue.list()).toEqual([]);
  await queue.enqueue(request);
});

it('distinguishes real scheduler rejection from admitted execution of the conflict read', async () => {
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0,
    healthReservedSlots: 0, backgroundReservedSlots: 0, queueWaitTimeoutMs: 5 });
  const delay = gate(); let admitted = false;
  const blocker = scheduler.run('normal', 'test.occupied', async () => { delay.enter(); await delay.held; });
  const { queue } = fixture(async (method, args, run) => {
    const source = (args[1] as { source?: string })?.source;
    return method === 'query' && source === 'publisher.asyncPromote.findActiveConflict'
      ? scheduler.run('normal', source, async () => { admitted = true; return run(); }, undefined, { storeOperation: 'query' })
      : run();
  });
  try {
    await delay.entered;
    await expect(queue.enqueue(request)).rejects.toMatchObject({ phase: 'conflict', admissionOutcome: 'not_admitted',
      cause: { code: 'STORE_SCHEDULER_BUSY', reason: 'queue_wait_timeout', outcome: 'not_started' } });
    expect(admitted).toBe(false);
  } finally { delay.release(); await blocker; }
  expect(await queue.list()).toEqual([]);
  await queue.enqueue(request);
  expect(admitted).toBe(true);
});

it('expires old observations and rechecks externally modified queue state', async () => {
  let now = performance.now(); vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { queue, inner, config } = fixture(async (_method, _args, run) => run());
  const id = await queue.enqueue(request);
  // Another store handle represents an external writer unknown to this cache.
  const external = new TripleStoreAsyncPromoteQueue(inner, config);
  await external.cancel(id);
  await expect(queue.enqueue(request)).rejects.toMatchObject({ existingJobId: id, observedAdmission: true });
  now += 5 * 60_000;
  expect(await queue.enqueue(request)).not.toBe(id);
});

it('a fresh absent status invalidates a stale positive observation after external clear', async () => {
  const { queue, inner, config } = fixture(async (_method, _args, run) => run());
  const id = await queue.enqueue(request);
  const external = new TripleStoreAsyncPromoteQueue(inner, config);
  await external.cancel(id); await external.clearTerminalJob(id);
  expect(await queue.getStatus(id)).toBeNull();
  expect(await queue.enqueue(request)).not.toBe(id);
});

it('checks the monotonic deadline before writing even if the event loop delayed the timer', async () => {
  let now = performance.now(); vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { queue } = fixture(async (method, args, run) => {
    const result = await run();
    if (method === 'query' && (args[1] as { source?: string })?.source === 'publisher.asyncPromote.findActiveConflict') now += 26;
    return result;
  });
  await expect(queue.enqueue(request)).rejects.toMatchObject({ admissionOutcome: 'not_admitted', phase: 'conflict' });
  expect(await queue.list()).toEqual([]);
});

it('releases a persistence attempt only when the primary atomic operation proves it never started', async () => {
  let armed = true;
  const { queue } = fixture(async (method, _args, run) => {
    if (armed && method === 'replaceSubject') {
      armed = false;
      throw new StoreSchedulerBusyError('queue_full', 'normal', 'publisher.asyncPromote.writeJob', { storeOperation: 'replaceSubject' });
    }
    return run();
  });
  await expect(queue.enqueue(request)).rejects.toMatchObject({ phase: 'persist', admissionOutcome: 'not_admitted', jobId: undefined });
  expect(await queue.list()).toEqual([]);
  await queue.enqueue(request);
  expect(await queue.list()).toHaveLength(1);
});

it('evicts excess positive observations without ever caching permission to admit', async () => {
  const coordinator = new PromoteAdmissionCoordinator();
  for (let i = 0; i < 1025; i++) coordinator.observe({
    jobId: `job-${i}`, request: { ...request, assertionName: `asset-${i}` }, state: 'queued',
    enqueuedAt: 0, updatedAt: 0, formatVersion: 4, attempt: { count: 0, maxRetries: 5 },
  } satisfies PromoteJob);
  const work = vi.fn(async () => 'durably-checked-id');
  await expect(coordinator.run({ ...request, assertionName: 'asset-0' }, work, 1000)).resolves.toBe('durably-checked-id');
  expect(work).toHaveBeenCalledTimes(1);
  await expect(coordinator.run({ ...request, assertionName: 'asset-1024' }, work, 1000)).rejects.toMatchObject({ existingJobId: 'job-1024' });
  expect(work).toHaveBeenCalledTimes(1);
});

it('keeps deadline and eventual phase observations distinct and payload-free', () => {
  const events: PromoteAdmissionEvent[] = [];
  const attempt = new PromoteAdmissionAttempt(1000, event => events.push(event));
  attempt.enter('graph'); attempt.enter('conflict'); attempt.beginPersistence('sensitive-job-id');
  attempt.report(attempt.expire().admissionOutcome, 'deadline');
  attempt.report('completed'); // eventual persistence acknowledgement after timeout
  expect(events.slice(-2)).toEqual([
    { event: 'deadline', phase: 'persist', elapsedMs: expect.any(Number), outcome: 'indeterminate' },
    { event: 'phase_settled', phase: 'persist', elapsedMs: expect.any(Number), outcome: 'completed' },
  ]);
  expect(JSON.stringify(events)).not.toContain('sensitive-job-id');
  const brokenObserver = new PromoteAdmissionAttempt(1000, () => { throw new Error('logger failed'); });
  expect(() => brokenObserver.enter('graph')).not.toThrow();
});

it.each(['inline', 'explicit-recovery', 'automatic-recovery'] as const)(
  'fences %s behind retained uncertainty even when no new row is visible', async mode => {
    let rejectWrite = false, writes = 0;
    const { queue } = fixture(async (method, _args, run) => {
      if (method === 'replaceSubject') {
        writes++;
        if (rejectWrite) throw new Error('lost persistence acknowledgement');
      }
      return run();
    });
    const selected = { ...request, agentAddress: `0x${'11'.repeat(20)}` };
    const oldId = await queue.enqueue(selected);
    const claimed = (await queue.claimNext('worker'))!;
    await queue.fail(oldId, claimed.lease!.claimToken, {
      message: 'Promote commit may have completed; retry the same sealed operation',
      diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE', retryable: false, classification: 'fatal', recordedAt: Date.now(),
    });
    const old = await queue.getStatus(oldId);
    expect(isAutomaticallyRecoverablePostCommitFailure(old!)).toBe(true);
    rejectWrite = true;
    const admission = await bounded(queue.enqueue(selected)) as { error: { jobId: string } };
    const id = admission.error.jobId;
    expect(id).toBeTypeOf('string');
    expect(await queue.getStatus(id)).toBeNull();
    const writesBefore = writes;
    if (mode === 'inline') {
      await expect(queue.enqueueAndClaim({ ...selected, entities: 'all', recoveryBinding: {
        version: 1, sealDigest: `0x${'11'.repeat(32)}`, inventoryRequired: false,
        intent: { version: 1, operationId: 'different-share', timestampMs: Date.now(),
          confirmationRequired: false, accessPolicy: 'public', allowedPeers: [] },
      } }, 'inline')).rejects.toMatchObject({ admissionOutcome: 'indeterminate', jobId: id });
    } else if (mode === 'explicit-recovery') {
      await expect(queue.recover(oldId)).rejects.toMatchObject({ admissionOutcome: 'indeterminate', jobId: id });
    } else {
      expect(await queue.recoverPostCommitFailures()).toEqual([]);
    }
    expect(writes).toBe(writesBefore);
    expect(await queue.getStatus(oldId)).toEqual(old);
    await expect(queue.enqueue(selected)).rejects.toMatchObject({ admissionOutcome: 'indeterminate', jobId: id });
    expect(await queue.list()).toHaveLength(1);
  },
);

it.each(['replaceSubject', 'flush'] as const)('retains the mutex after timeout until %s settles', async methodToHold => {
  let armed = true; const delay = gate();
  const { queue, store, config } = fixture(async (method, _args, run) => {
    if (armed && method === methodToHold) { armed = false; delay.enter(); await delay.held; }
    return run();
  });
  const admission = bounded(queue.enqueue(request));
  await delay.entered;
  const outcome = await admission as { error: { jobId: string } };
  expect(outcome).toMatchObject({ error: { admissionOutcome: 'indeterminate', jobId: expect.any(String) } });
  const other = new TripleStoreAsyncPromoteQueue(store, config);
  const query = vi.spyOn(store, 'query');
  let observed = false, claimed = false;
  const status = other.getStatus(outcome.error.jobId).then(job => { observed = true; return job; });
  const claim = other.claimNext('other-worker').then(job => { claimed = true; return job; });
  try {
    await tick();
    expect(query).not.toHaveBeenCalled();
    expect(observed).toBe(false); expect(claimed).toBe(false);
  } finally { delay.release(); }
  expect((await status)?.jobId).toBe(outcome.error.jobId);
  expect((await claim)?.jobId).toBe(outcome.error.jobId);
  expect(await queue.list()).toHaveLength(1);
});

it('settles retained uncertainty before clearing an externally completed job', async () => {
  let armed = true;
  const { queue, inner, config } = fixture(async (method, _args, run) => {
    const result = await run();
    if (armed && method === 'flush') { armed = false; throw new Error('lost admission acknowledgement'); }
    return result;
  });
  const admission = await bounded(queue.enqueue(request)) as { error: { jobId: string } };
  const id = admission.error.jobId;
  const external = new TripleStoreAsyncPromoteQueue(inner, config);
  const job = (await external.claimNext('external-worker'))!;
  await external.recordCommitMarker(id, job.lease!.claimToken, 'swmInserted');
  await external.succeed(id, job.lease!.claimToken, { promotedCount: 1, succeededAt: Date.now() });
  // Deliberately no status/list call on the original queue before clear.
  expect(await queue.clearTerminalJob(id)).toEqual({ outcome: 'cleared' });
  const next = await queue.enqueue(request);
  expect(next).not.toBe(id);
  expect((await queue.list()).map(job => job.jobId)).toEqual([next]);
});

it.each(['malformed', 'mismatched-id', 'unknown-state'] as const)('does not erase uncertainty when terminal clear sees %s evidence', async kind => {
  let armed = true;
  const { queue, inner, config } = fixture(async (method, _args, run) => {
    const result = await run();
    if (armed && method === 'flush') { armed = false; throw new Error('lost admission acknowledgement'); }
    return result;
  });
  const admission = await bounded(queue.enqueue(request)) as { error: { jobId: string } };
  const id = admission.error.jobId;
  const external = new TripleStoreAsyncPromoteQueue(inner, config);
  await external.cancel(id);
  const job = (await external.getStatus(id))!;
  const payload = kind === 'malformed' ? '{invalid' : JSON.stringify({ ...job,
    ...(kind === 'mismatched-id' ? { jobId: 'different-job' } : { state: 'unknown' }),
  });
  const pattern = { subject: jobSubject(id), predicate: PROMOTE_PAYLOAD, graph: config.graphUri! };
  await inner.deleteByPattern(pattern);
  await inner.insert([{ ...pattern, object: literal(payload) }]);
  expect(await queue.clearTerminalJob(id)).toEqual({ outcome: 'rejected', reason: kind === 'unknown-state' ? 'unknown' : 'malformed' });
  await expect(queue.enqueue(request)).rejects.toMatchObject({ admissionOutcome: 'indeterminate', jobId: id });
});
