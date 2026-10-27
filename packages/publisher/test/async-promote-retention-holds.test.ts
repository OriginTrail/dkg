/**
 * OT-RFC-73 P10a: how share retention takes the queue's mutex. Slices of at most `sliceSize` jobs per hold (default 10), verify and per-subject deletes inside
 * the hold on the control path, the mutex released between slices, a hold budget (default 50 ms) the slice size adapts to, and the interleavings with the
 * queue's own operations (admission, claim, recover, a pending admission) that must never cost a job that is no longer, or not yet, deletable.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { SHARE_RETENTION_DEFAULTS } from '../src/async-promote-retention.js';
import { JOB_SUBJECT_PREFIX } from '../src/async-promote-retention-scan.js';
import { jobSubject } from '../src/async-promote-queue-utils.js';
import { withPromoteControlLock } from '../src/promote-control-lock.js';
import { AG, GRAPH, NOW, W, deletedSubjects, drain, from, mk, newRetention, present, put, registerPendingFlight, retired, spy, storedIds, type Logged } from './_helpers/share-retention-fixtures.js';

const RETENTION = 'publisher.asyncPromote.retention.';
const isRetention = (l: Logged) => l.source?.startsWith(RETENTION) === true;
const verifySizes = (log: Logged[]) => from(log, 'verify').map(l => [...l.sparql.matchAll(new RegExp(`<${JOB_SUBJECT_PREFIX}[^>]+>`, 'g'))].length);
/**
 * The store calls of a run as letters: V a retention verify, d a retention delete, x any other labelled queue call. A queue call between a hold's verify and its
 * own deletes (`V d* x+ d`) would mean the mutex was not held across the hold.
 */
const holdTrace = (log: Logged[]) => log.map(l => (l.source === `${RETENTION}verify` ? 'V' : l.source === `${RETENTION}delete` ? 'd' : l.source?.startsWith('publisher.asyncPromote.') && !isRetention(l) ? 'x' : '')).join('');
/** Deletes that name a job the hold they belong to did not verify: always empty. */
function deletedBeforeVerified(log: Logged[]): string[] {
  const unjudged: string[] = [];
  let verified = new Set<string>();
  for (const l of log) {
    if (l.source === `${RETENTION}verify`) verified = new Set([...l.sparql.matchAll(new RegExp(`<(${JOB_SUBJECT_PREFIX}[^>]+)>`, 'g'))].map(m => m[1]!));
    else if (l.source === `${RETENTION}delete`) { const subject = (JSON.parse(l.sparql) as { subject: string }).subject; if (!verified.has(subject)) unjudged.push(subject); }
  }
  return unjudged;
}
const oldJobs = (n: number, prefix = 'old', baseAge = 10 * W) => Array.from({ length: n }, (_, i) => mk(`${prefix}-${String(i).padStart(3, '0')}`, 'succeeded', {}, baseAge + i));

describe('the slice size', () => {
  it('defaults to at most 10 jobs per mutex hold with a 50 ms hold budget, and the budget cannot be raised', () => {
    expect(SHARE_RETENTION_DEFAULTS).toMatchObject({ sliceSize: 10, holdBudgetMs: 50, maxHoldBudgetMs: 50 });
  });

  it('puts at most 10 jobs under one hold by default: 25 deletable rows are verified as 10 + 10 + 5, one delete each', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await put(store, ...oldJobs(25));
    const res = await newRetention(spied, { batchSize: 100 }).runBatch();
    expect(res).toMatchObject({ scanned: 25, deleted: 25, holds: 3 });
    expect(res.error).toBeUndefined();
    expect(verifySizes(log)).toEqual([10, 10, 5]);
    expect(deletedSubjects(log)).toHaveLength(25);
    expect(new Set(deletedSubjects(log)).size).toBe(25);
    expect(deletedBeforeVerified(log)).toEqual([]);                                     // every delete names a job the SAME hold had just verified
  });

  it.each([1, 3, 7])('honours a configured slice of %i', async (sliceSize) => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await put(store, ...oldJobs(10));
    await newRetention(spied, { batchSize: 100, sliceSize }).runBatch();
    expect(Math.max(...verifySizes(log))).toBe(sliceSize);
    expect(verifySizes(log).reduce((a, n) => a + n, 0)).toBe(10);
    expect((await storedIds(store)).size).toBe(0);
  });

  it('judges every row of a slice in one verify query, and the scan never sees the lock', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await put(store, ...oldJobs(4));
    await newRetention(spied, { batchSize: 100 }).runBatch();
    expect(from(log, 'verify')).toHaveLength(1);
    expect(from(log, 'scan').length).toBeGreaterThan(0);
  });
});

describe('verify and delete are on the control path, the scan is background, deletes are per subject', () => {
  it('tags every call with its row of the tagging table and never issues a bulk update', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await put(store, ...oldJobs(6), retired('r1'), mk('c1', 'failed', { reason: 'cancelled' }));
    await newRetention(spied, { batchSize: 100, sliceSize: 4 }).runBatch();
    const scans = from(log, 'scan'), verifies = from(log, 'verify'), deletes = from(log, 'delete');
    expect(scans.length).toBeGreaterThan(0);
    for (const call of scans) expect(call.options).toEqual({ source: `${RETENTION}scan`, priority: 'background' });          // background, no control tag
    for (const call of verifies) expect(call.options).toEqual({ source: `${RETENTION}verify`, controlQueue: 'share' });       // control, no priority
    for (const call of deletes) expect(call.options).toEqual({ source: `${RETENTION}delete`, controlQueue: 'share' });
    expect(log.filter(l => l.kind === 'update')).toHaveLength(0);
    expect(deletes.every(l => l.kind === 'deleteByPatternWithoutCount')).toBe(true);
    expect(deletes).toHaveLength(8);
    for (const call of deletes) {
      const pattern = JSON.parse(call.sparql) as Record<string, unknown>;
      expect(Object.keys(pattern).sort()).toEqual(['graph', 'subject']);                  // a subject in a graph: no predicate or object wildcard, no prefix
      expect(pattern['graph']).toBe(GRAPH);
    }
  });

  it('flushes once per hold that deleted something, with no options (they never reach a scheduler), and not at all in a hold that deleted nothing', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await put(store, ...oldJobs(6), mk('fatal', 'failed', { reason: 'partial promote ambiguity: x' }));
    await newRetention(spied, { batchSize: 100, sliceSize: 3 }).runBatch();
    expect(log.filter(l => l.kind === 'flush')).toHaveLength(2);
    expect(log.filter(l => l.kind === 'flush').every(l => l.options === undefined)).toBe(true);
    const only = spy(new OxigraphStore());
    await put(only.store, mk('fatal', 'failed', { reason: 'partial promote ambiguity: x' }));
    await newRetention(only.store).runBatch();
    expect(only.log.filter(l => l.kind === 'flush')).toHaveLength(0);
    expect(only.log.filter(l => l.kind === 'createGraph')).toHaveLength(0);              // a sweep creates nothing
  });
});

describe('the mutex is released between slices', () => {
  it('lets an admission in between two holds of a batch instead of after the whole batch', async () => {
    const store = new OxigraphStore();
    let enqueued: Promise<string> | undefined;
    let n = 0;
    const holder: { queue?: TripleStoreAsyncPromoteQueue } = {};
    const { store: spied, log } = spy(store, undefined, {
      before: (entry) => {
        if (entry.source === `${RETENTION}verify` && enqueued === undefined) {          // inside the first hold: an admission arrives and waits for the mutex
          enqueued = holder.queue!.enqueue({ contextGraphId: 'cg', assertionName: 'arriving', agentAddress: AG, entities: 'all' });
        }
      },
    });
    holder.queue = new TripleStoreAsyncPromoteQueue(spied, { now: () => NOW, idGenerator: () => `admitted-${++n}` });
    await put(store, ...oldJobs(25));
    const res = await newRetention(spied, { batchSize: 100, sliceSize: 5 }).runBatch();
    expect(await enqueued).toBe('admitted-1');
    expect(res).toMatchObject({ deleted: 25, holds: 5 });
    const write = log.findIndex(l => l.source === 'publisher.asyncPromote.writeJob');
    const firstDelete = log.findIndex(l => l.source === `${RETENTION}delete`);
    const lastDelete = log.map(l => l.source).lastIndexOf(`${RETENTION}delete`);
    expect(write).toBeGreaterThan(firstDelete);
    expect(write).toBeLessThan(lastDelete);                                               // the admission persisted while the batch still had slices to go
    expect(holdTrace(log)).not.toMatch(/Vd*x+d/);                                          // ... between two holds, never inside one
    expect(holdTrace(log)).toMatch(/V(d{5})x+V/);                                          // exactly: a full hold of five deletes, then the admission, then the next hold's verify
  });

  it('still serialises with the queue: a hold never overlaps a queue operation', async () => {
    const store = new OxigraphStore();
    let n = 0;
    const holder: { queue?: TripleStoreAsyncPromoteQueue } = {};
    const { store: spied, log } = spy(store);
    holder.queue = new TripleStoreAsyncPromoteQueue(spied, { now: () => NOW, idGenerator: () => `q-${++n}` });
    await put(store, ...oldJobs(30));
    const retention = newRetention(spied, { batchSize: 100, sliceSize: 5 });
    const work = Array.from({ length: 6 }, (_, i) => holder.queue!.enqueue({ contextGraphId: 'cg', assertionName: `a-${i}`, agentAddress: AG, entities: 'all' }));
    await Promise.all([retention.runBatch(), ...work]);
    expect(holdTrace(log)).not.toMatch(/Vd*x+d/);
    expect((await storedIds(store)).size).toBe(6);                                        // the 30 old jobs are gone, the 6 admissions are in
  });
});

/**
 * From inside a store call: can the queue's mutex be taken right now? `free` is false when someone holds it (the probe gives up waiting after `waitMs`);
 * `settled` resolves once the probe's own turn at the mutex is over, which for a held mutex is after the holder let go.
 */
async function mutexFree(waitMs = 30) {
  let got = false;
  const settled = withPromoteControlLock(GRAPH, async () => { got = true; });
  await Promise.race([settled, new Promise<void>(resolve => setTimeout(resolve, waitMs))]);
  return { free: got, settled };
}
const kinds = (log: Logged[]) => log.map(l => (l.kind === 'flush' ? 'F' : l.source === `${RETENTION}verify` ? 'V' : l.source === `${RETENTION}delete` ? 'd' : '')).join('');

describe('the store flush runs after the hold, outside the mutex and outside the hold budget', () => {
  it('flushes once per hold that deleted, after the hold released the mutex: the order is verify, deletes, flush, and the mutex is free during the flush', async () => {
    const store = new OxigraphStore();
    await put(store, ...oldJobs(5));
    const probes: Array<Awaited<ReturnType<typeof mutexFree>>> = [];
    const { store: spied, log } = spy(store, undefined, { before: async (entry) => { if (entry.kind === 'flush') probes.push(await mutexFree()); } });
    const res = await newRetention(spied, { batchSize: 100, sliceSize: 2 }).runBatch();
    await Promise.all(probes.map(p => p.settled));
    expect(res).toMatchObject({ scanned: 5, deleted: 5, holds: 3 });
    expect(res.error).toBeUndefined();
    expect(kinds(log)).toBe('VddFVddFVdF');                                                // a flush follows each hold's last delete and precedes the next verify
    expect(probes.map(p => p.free)).toEqual([true, true, true]);                           // the hold had let go of the mutex before it flushed
  });

  it('a slow flush is no part of a hold: the slice does not shrink, no hold ends past the budget, and nothing is deferred because of it', async () => {
    const clock = { t: 0 };
    const inner = new OxigraphStore();
    const { store: spied, log } = spy(inner, undefined, { after: (entry) => {
      if (entry.kind === 'flush') clock.t += 500;                                          // a full-store snapshot on a file-backed store
      else if (entry.source === `${RETENTION}verify` || entry.source === `${RETENTION}delete`) clock.t += 1;
    } });
    await put(inner, ...oldJobs(25));
    const retention = newRetention(spied, { batchSize: 100, monotonicNow: () => clock.t });
    const res = await retention.runBatch();
    expect(res).toMatchObject({ scanned: 25, deleted: 25, holds: 3, holdBudgetExceeded: 0, maxHoldMs: 11 });   // verify 1 + ten deletes of 1 ms; the 500 ms flushes are not in it
    expect(verifySizes(log)).toEqual([10, 10, 5]);
    expect(log.filter(l => l.kind === 'flush')).toHaveLength(3);
    expect(retention.counters()).toMatchObject({ sliceSize: 10, holdBudgetExceeded: 0, maxHoldMs: 11 });
  });

  it('a hold that deleted nothing flushes nothing', async () => {
    const store = new OxigraphStore();
    await put(store, ...Array.from({ length: 4 }, (_, i) => mk(`fatal-${i}`, 'failed', {}, 10 * W + i)));
    const { store: spied, log } = spy(store);
    const res = await newRetention(spied, { batchSize: 100 }).runBatch();
    expect(res).toMatchObject({ deleted: 0, scanned: 4, kept: { failed_retained: 4 } });
    expect(log.filter(l => l.kind === 'flush')).toEqual([]);
  });
});

describe('the hold budget', () => {
  /** A store whose every verify and delete takes `cost.ms` on a fake monotonic clock; the retention reads that clock. */
  function timed(cost: { ms: number }) {
    const clock = { t: 0 };
    const inner = new OxigraphStore();
    const seen = spy(inner, undefined, { after: (entry) => { if (entry.source === `${RETENTION}verify` || entry.source === `${RETENTION}delete`) clock.t += cost.ms; } });
    return { ...seen, inner, clock, mono: () => clock.t };
  }
  /** The jobs deleted per hold, from the call log (a hold is a verify followed by its deletes). */
  const deletesPerHold = (log: Logged[]) => {
    const counts: number[] = [];
    for (const l of log) { if (l.source === `${RETENTION}verify`) counts.push(0); else if (l.source === `${RETENTION}delete`) counts[counts.length - 1]!++; }
    return counts;
  };

  it('keeps every hold within the budget by deleting only what fits, and learns the slice size from the first hold', async () => {
    const cost = { ms: 20 };
    const t = timed(cost);
    await put(t.inner, ...oldJobs(12));
    const retention = newRetention(t.store, { batchSize: 12, monotonicNow: t.mono });
    const res = await retention.runBatch();
    expect(res).toMatchObject({ scanned: 12, deleted: 12, holdBudgetExceeded: 0 });
    expect(res.error).toBeUndefined();
    expect(res.maxHoldMs).toBeLessThanOrEqual(SHARE_RETENTION_DEFAULTS.holdBudgetMs);   // verify 20 + delete 20 = 40; a second delete would have been 60
    expect(deletesPerHold(t.log).every(n => n <= 1)).toBe(true);
    expect(res.holds).toBe(12);
    expect(retention.counters().sliceSize).toBe(1);
    expect(res.deletedJobs.map(j => j.jobId)).toEqual(oldJobs(12).map(j => j.jobId).reverse());   // the oldest first
  });

  it('puts the whole slice under one hold when the store is fast', async () => {
    const t = timed({ ms: 1 });
    await put(t.inner, ...oldJobs(25));
    const res = await newRetention(t.store, { batchSize: 25, monotonicNow: t.mono }).runBatch();
    expect(deletesPerHold(t.log)).toEqual([10, 10, 5]);
    expect(res).toMatchObject({ holds: 3, holdBudgetExceeded: 0 });
    expect(res.maxHoldMs).toBe(11);
  });

  it('still makes progress, one job per hold, when a single verify and delete already exceed the budget, and counts every hold past the budget', async () => {
    const t = timed({ ms: 60 });
    await put(t.inner, ...oldJobs(5));
    const retention = newRetention(t.store, { batchSize: 5, monotonicNow: t.mono });
    const res = await retention.runBatch();
    expect(res).toMatchObject({ deleted: 5, holds: 5, holdBudgetExceeded: 5, maxHoldMs: 120 });
    expect(deletesPerHold(t.log)).toEqual([1, 1, 1, 1, 1]);
    expect(retention.counters()).toMatchObject({ holdBudgetExceeded: 5, sliceSize: 1, maxHoldMs: 120 });
  });

  it('grows the slice back, one job per cheap hold, once the store is fast again, but never past the configured size', async () => {
    const cost = { ms: 60 };
    const t = timed(cost);
    await put(t.inner, ...oldJobs(2, 'slow'));
    const retention = newRetention(t.store, { batchSize: 100, sliceSize: 6, monotonicNow: t.mono });
    await retention.runBatch();
    expect(retention.counters().sliceSize).toBe(1);
    cost.ms = 1;
    const mark = t.log.length;
    await put(t.inner, ...oldJobs(40, 'fast', 5 * W));          // younger than the slow ones, so after the parked cursor
    await retention.runBatch();
    const sizes = verifySizes(t.log.slice(mark));
    expect(sizes.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Math.max(...sizes)).toBe(6);
    expect(retention.counters().sliceSize).toBe(6);
  });

  it('halves the slice after a hold past the budget even when nothing was deferred: a slow verify in report mode, which never deletes', async () => {
    const t = timed({ ms: 60 });
    await put(t.inner, ...oldJobs(20));
    const retention = newRetention(t.store, { mode: 'report', batchSize: 20, sliceSize: 8, monotonicNow: t.mono });
    const res = await retention.runBatch();
    expect(res).toMatchObject({ wouldDelete: 20, deleted: 0 });
    expect(verifySizes(t.log)).toEqual([8, 4, 2, 1, 1, 1, 1, 1, 1]);                    // 8, then half of it after every hold of 60 ms, down to one
    expect(res).toMatchObject({ holds: 9, holdBudgetExceeded: 9 });
    expect(retention.counters().sliceSize).toBe(1);
  });

  it('halves the slice after a hold past the budget in delete mode too, when a slow verify finds nothing to delete (so nothing is deferred)', async () => {
    const t = timed({ ms: 60 });
    await put(t.inner, ...Array.from({ length: 15 }, (_, i) => mk(`fatal-${String(i).padStart(2, '0')}`, 'failed', {}, 10 * W + i)));
    const retention = newRetention(t.store, { batchSize: 15, sliceSize: 8, monotonicNow: t.mono });
    const res = await retention.runBatch();
    expect(res).toMatchObject({ scanned: 15, deleted: 0, kept: { failed_retained: 15 }, holdBudgetExceeded: 4 });
    expect(verifySizes(t.log)).toEqual([8, 4, 2, 1]);
    expect(deletesPerHold(t.log)).toEqual([0, 0, 0, 0]);
    expect(retention.counters().sliceSize).toBe(1);
  });

  it('verifies again the jobs a hold had no time for: a deferred job another operation put back to work is kept, never deleted unjudged', async () => {
    const t = timed({ ms: 20 });
    await put(t.inner, ...oldJobs(6));                                                  // deleted oldest first: old-005 is the first, old-000 the last
    let deletes = 0;
    const { store: spied, log } = spy(t.inner, undefined, {
      after: async (entry) => {
        if (entry.source === `${RETENTION}delete`) t.clock.t += 20;
        if (entry.source === `${RETENTION}verify`) t.clock.t += 20;
        if (entry.source === `${RETENTION}delete` && ++deletes === 1) {                  // hold 1 had time for one delete; old-002 is among the five it deferred
          await t.inner.deleteByPattern({ subject: jobSubject('old-002'), graph: GRAPH });
          await put(t.inner, mk('old-002', 'queued', {}, 10 * W));
        }
      },
    });
    const res = await newRetention(spied, { batchSize: 6, monotonicNow: t.mono }).runBatch();
    expect(res.deletedJobs.map(j => j.jobId)).toEqual(['old-005', 'old-004', 'old-003', 'old-001', 'old-000']);
    expect(res.kept.not_terminal).toBe(1);
    expect(await present(t.inner, 'old-002')).not.toBe('');
    expect(verifySizes(log)[0]).toBe(6);                                                // the first hold verified all six, deleted one and deferred five
    expect(deletedBeforeVerified(log)).toEqual([]);                                     // every delete names a job the SAME hold had just verified
  });
});

describe('interleavings with the queue never cost a job that is no longer, or not yet, deletable', () => {
  const queueOver = (store: ReturnType<typeof spy>['store']) => {
    let n = 0;
    return new TripleStoreAsyncPromoteQueue(store, { now: () => NOW, idGenerator: () => `fresh-${++n}`, claimTokenGenerator: () => 'token' });
  };

  it('an operator recover of a cancelled job between the scan and its verification keeps the job', async () => {
    const store = new OxigraphStore();
    const holder: { queue?: TripleStoreAsyncPromoteQueue } = {};
    let revived = false;
    const { store: spied } = spy(store, undefined, {
      after: async (entry) => {                                                           // the scan runs outside the lock: the operation may be awaited here
        if (entry.source === `${RETENTION}scan` && entry.sparql.includes('"failed"') && !revived) { revived = true; await holder.queue!.recover('cancelled-1'); }
      },
    });
    holder.queue = queueOver(spied);
    await put(store, mk('cancelled-1', 'failed', { reason: 'cancelled' }), mk('cancelled-2', 'failed', { reason: 'cancelled' }, 10 * W + 5), ...oldJobs(2));
    const res = await newRetention(spied, { batchSize: 100 }).runBatch();
    expect(revived).toBe(true);
    expect(res.deletedJobs.map(j => j.jobId).sort()).toEqual(['cancelled-2', 'old-000', 'old-001']);
    expect(res.kept.not_terminal).toBe(1);
    expect(await holder.queue.getStatus('cancelled-1')).toMatchObject({ state: 'queued' });
  });

  it('a recover that lands BETWEEN two holds of a batch keeps the job the later hold was about to judge', async () => {
    const store = new OxigraphStore();
    const holder: { queue?: TripleStoreAsyncPromoteQueue } = {};
    let deletes = 0;
    let recovered: Promise<void> | undefined;
    const { store: spied } = spy(store, undefined, {
      after: (entry) => {                                                                 // inside hold 1: the recover queues behind it for the mutex and runs before hold 2
        if (entry.source === `${RETENTION}delete` && ++deletes === 3) recovered = holder.queue!.recover('cancelled-late');
      },
    });
    holder.queue = queueOver(spied);
    // the oldest rows first: three succeeded (hold 1), then the cancelled job, then more succeeded
    await put(store, mk('s1', 'succeeded', {}, 100 * W), mk('s2', 'succeeded', {}, 99 * W), mk('s3', 'succeeded', {}, 98 * W), mk('cancelled-late', 'failed', { reason: 'cancelled' }, 97 * W),
      mk('s4', 'succeeded', {}, 96 * W), mk('s5', 'succeeded', {}, 95 * W));
    const res = await newRetention(spied, { batchSize: 100, sliceSize: 3 }).runBatch();
    await recovered;
    expect(recovered).toBeDefined();
    expect(res.deletedJobs.map(j => j.jobId).sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(await holder.queue.getStatus('cancelled-late')).toMatchObject({ state: 'queued' });
    expect(res.kept.not_terminal).toBe(1);
  });

  it('a claim and a heartbeat between holds are served, and the claimed job is never a candidate', async () => {
    const store = new OxigraphStore();
    const holder: { queue?: TripleStoreAsyncPromoteQueue } = {};
    let claim: Promise<unknown> | undefined;
    let seen = 0;
    const { store: spied, log } = spy(store, undefined, {
      after: (entry) => {
        if (entry.source === `${RETENTION}delete` && ++seen === 2) {                        // the last delete of hold 1: the claim and its heartbeat queue behind it
          claim = holder.queue!.claimNext('worker').then(job => holder.queue!.heartbeat(job!.jobId, job!.lease!.claimToken).then(() => job));
        }
      },
    });
    holder.queue = queueOver(spied);
    await put(store, mk('waiting', 'queued', {}, 1000), ...oldJobs(6));
    const res = await newRetention(spied, { batchSize: 100, sliceSize: 2 }).runBatch();
    expect(await claim).toMatchObject({ jobId: 'waiting' });
    expect(res.deleted).toBe(6);
    expect(await holder.queue.getStatus('waiting')).toMatchObject({ state: 'running' });
    expect(from(log, 'verify').filter(l => l.sparql.includes('waiting'))).toHaveLength(0);
    expect(holdTrace(log)).not.toMatch(/Vd*x+d/);
  });

  it('an admission that becomes pending for a job BETWEEN two holds protects it from the later hold', async () => {
    const store = new OxigraphStore();
    let seen = 0;
    let flight: ReturnType<typeof registerPendingFlight> | undefined;
    const { store: spied } = spy(store, undefined, {
      after: (entry) => { if (entry.source === `${RETENTION}delete` && ++seen === 2) flight = registerPendingFlight(spied, 'old-003'); },
    });
    await put(store, ...oldJobs(6));                                                    // deleted oldest first: old-005 .. old-000; old-003 is in hold 2
    const retention = newRetention(spied, { batchSize: 100, sliceSize: 2 });
    const res = await retention.runBatch();
    expect(res.deletedJobs.map(j => j.jobId).sort()).toEqual(['old-000', 'old-001', 'old-002', 'old-004', 'old-005']);
    expect(res.kept.pending_admission).toBe(1);
    expect(await present(store, 'old-003')).not.toBe('');
    flight!.clear();
    await retention.runBatch();
    expect(await present(store, 'old-003')).not.toBe('');                                // the parked cursor does not come back by itself (delete mode rewinds after the retry delay) ...
    const later = newRetention(spied, { batchSize: 100 });                                // ... but a sweep that judges it again, once the admission settled, deletes it
    await later.runBatch();
    expect(await present(store, 'old-003')).toBe('');
  });

  it('operations interleaved with every store call of a batch: nothing that became non-terminal or pending is deleted afterwards', async () => {
    const store = new OxigraphStore();
    const holder: { queue?: TripleStoreAsyncPromoteQueue } = {};
    const revivable = Array.from({ length: 8 }, (_, i) => mk(`cx-${i}`, 'failed', { reason: 'cancelled' }, 10 * W + i));
    const guarded = Array.from({ length: 8 }, (_, i) => mk(`gx-${i}`, 'succeeded', {}, 10 * W + 100 + i));
    const revived = new Set<string>(), guardedAt = new Map<string, number>();
    const ops: Promise<unknown>[] = [];
    let step = 0;
    const { store: spied, log } = spy(store, undefined, {
      before: (entry) => {
        if (!isRetention(entry)) return;
        const k = step++;
        // Every operation queues for the mutex behind the hold in progress (or runs outside it): it lands between two holds, as in production.
        if (k % 3 === 0) { const id = revivable[(k / 3) % revivable.length]!.jobId; ops.push(holder.queue!.recover(id).then(() => { revived.add(id); }, () => undefined)); }
        if (k % 3 === 1) {
          const g = guarded[k % guarded.length]!.jobId;
          ops.push(withPromoteControlLock(GRAPH, async () => { if (!guardedAt.has(g)) { registerPendingFlight(spied, g); guardedAt.set(g, log.length); } }));
        }
        if (k % 3 === 2) ops.push(holder.queue!.enqueue({ contextGraphId: 'cg', assertionName: `chaos-${k}`, agentAddress: AG, entities: 'all' }).catch(() => undefined));
      },
    });
    holder.queue = queueOver(spied);
    await put(store, ...revivable, ...guarded);
    await drain(newRetention(spied, { batchSize: 4, sliceSize: 2 }));
    await Promise.all(ops);
    const deletes = new Map<string, number>(log.flatMap(l => (l.source === `${RETENTION}delete` ? [[(JSON.parse(l.sparql) as { subject: string }).subject.slice(JOB_SUBJECT_PREFIX.length), l.at] as const] : [])));
    for (const id of revived) expect(deletes.has(id), `${id} was revived and must not be deleted`).toBe(false);
    for (const [id, at] of guardedAt) if (deletes.has(id)) expect(deletes.get(id)!, `${id} was deleted after an admission became pending for it`).toBeLessThan(at);
    expect(revived.size).toBeGreaterThan(0);
    expect(guardedAt.size).toBeGreaterThan(2);
    for (const id of revived) expect(await present(store, id)).not.toBe('');
    expect(holdTrace(log)).not.toMatch(/Vd*x+d/);
    expect(deletedBeforeVerified(log)).toEqual([]);
  });
});
