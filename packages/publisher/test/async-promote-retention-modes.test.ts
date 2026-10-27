/**
 * OT-RFC-73 P10a: the modes (`off`, `report`, `delete`), the counters and the per-pass report gauge, the batch log, the clock guard, the fault injection between
 * sibling deletes, and the identity of the admission coordinator the sweep consults.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore, StoreSchedulerBusyError, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PromoteAdmissionAttempt, PromoteAdmissionCoordinator } from '../src/promote-admission.js';
import { jobSubject } from '../src/async-promote-queue-utils.js';
import { createShareRetention, type ShareRetentionBatchResult } from '../src/async-promote-retention.js';
import { emptyClassCounts } from '../src/async-promote-retention-policy.js';
import {
  AG, GRAPH, NOW, W, WF, DELETABLE_KINDS, captureLogger, drain, genPopulation, graphFingerprint, insertQuads, mk, newRetention, pick, present, put,
  registerPendingFlight, retired, rng, rowOf, spy, storedIds, verifiedSubjects, type Logged,
} from './_helpers/share-retention-fixtures.js';

const MUTATIONS = new Set(['insert', 'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'update', 'flush', 'replaceSubject', 'createGraph']);
const classCounts = (jobs: ReadonlyArray<{ jobClass: string }>) => { const c = emptyClassCounts(); for (const j of jobs) c[j.jobClass as keyof typeof c] += 1; return c; };
const lines = (infos: string[], action: string) => infos.filter(l => l.includes(`action=${action} `));
const jobsOf = (line: string) => JSON.parse(/ jobs=(\[.*\])$/.exec(line)![1]!) as Array<{ jobId: string; class: string; updatedAt: number; ageMs: number }>;

/** 3 succeeded, 2 operator-cancelled, 2 retired no-effect: all old enough; plus rows that must never count. */
async function standardStore(store: TripleStore) {
  await put(store,
    mk('s1', 'succeeded', {}, 10 * W), mk('s2', 'succeeded', {}, 11 * W), mk('s3', 'succeeded', {}, 12 * W),
    mk('c1', 'failed', { reason: 'cancelled' }, 10 * W), mk('c2', 'failed', { reason: 'cancelled' }, 11 * W),
    retired('r1', 10 * W), retired('r2', 11 * W),
    mk('fatal-1', 'failed', {}, 20 * W), mk('fatal-2', 'failed', {}, 21 * W), mk('bound-1', 'failed', { bound: true }, 20 * W),
    mk('young-1', 'succeeded', {}, 1000), mk('queued-1', 'queued', {}, 30 * W));
}

describe('mode off (the default)', () => {
  it('does nothing when no mode is given: no store call at all, however often it is called', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await standardStore(store);
    const before = await graphFingerprint(store);
    const retention = createShareRetention({ store: spied, intervalMs: 60_000, now: () => NOW, logger: captureLogger() });
    expect(retention.mode).toBe('off');
    for (let i = 0; i < 3; i++) expect(await retention.runBatch()).toMatchObject({ mode: 'off', skipped: 'off', scanned: 0, deleted: 0, wouldDelete: 0, hasMore: false });
    expect(log).toEqual([]);
    expect(await graphFingerprint(store)).toBe(before);
    expect(retention.counters()).toMatchObject({ mode: 'off', batches: 0, skipped: { off: 3 }, scanned: 0 });
  });

  it('is the same when `off` is given explicitly, and writes no log line', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    const logger = captureLogger();
    const retention = newRetention(store, { mode: 'off', logger });
    await retention.runBatch();
    expect(logger.infos).toEqual([]);
    expect(logger.warns).toEqual([]);
    expect((await storedIds(store)).size).toBe(12);
  });
});

describe('mode report', () => {
  it('judges and counts what delete would remove, and changes nothing: no mutating store call, an identical graph', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await standardStore(store);
    const before = await graphFingerprint(store);
    const retention = newRetention(spied, { mode: 'report', batchSize: 4, sliceSize: 3 });
    const results = await drain(retention);
    expect(log.filter(l => MUTATIONS.has(l.kind))).toEqual([]);                          // not even a flush
    expect(await graphFingerprint(store)).toBe(before);
    const would = results.flatMap(r => r.wouldDeleteJobs);
    expect(would.map(j => j.jobId).sort()).toEqual(['c1', 'c2', 'r1', 'r2', 's1', 's2', 's3']);
    expect(results.every(r => r.deleted === 0 && r.deletedJobs.length === 0)).toBe(true);
    expect(retention.counters().deleted).toEqual(emptyClassCounts());
  });

  it('takes the same hold as delete would, on the control path: the verify under the lock is what makes the set equal', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await standardStore(store);
    await newRetention(spied, { mode: 'report', batchSize: 100, sliceSize: 5 }).runBatch();
    const verifies = log.filter(l => l.source === 'publisher.asyncPromote.retention.verify');
    expect(verifies.length).toBeGreaterThan(0);
    for (const v of verifies) expect(v.options).toEqual({ source: 'publisher.asyncPromote.retention.verify', controlQueue: 'share' });
  });

  it('skips a pending admission and everything else delete would skip, so the would-delete set is the delete set', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    const flight = registerPendingFlight(store, 's2');
    const report = await drain(newRetention(store, { mode: 'report' }));
    expect(report.flatMap(r => r.wouldDeleteJobs).map(j => j.jobId).sort()).toEqual(['c1', 'c2', 'r1', 'r2', 's1', 's3']);
    expect(report.reduce((n, r) => n + r.kept.pending_admission, 0)).toBe(1);
    flight.clear();
  });

  it('judges every row once per pass: a row kept for a pending admission is not revisited within the pass, so nothing after it is counted twice; the next pass takes it', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await put(store, mk('pend', 'succeeded', {}, 20 * W), mk('a', 'succeeded', {}, 10 * W), mk('b', 'succeeded', {}, 10 * W - 1), mk('c', 'failed', { reason: 'cancelled' }, 9 * W));
    const flight = registerPendingFlight(spied, 'pend');
    let t = NOW;
    const retention = newRetention(spied, { mode: 'report', now: () => t, batchSize: 100, rescanIntervalMs: 3_600_000 });
    expect(await retention.runBatch()).toMatchObject({ wouldDelete: 3, passCompleted: true, kept: { pending_admission: 1 } });
    t += 6_000;                                                                          // past the retry delay delete mode would use to go back to the pending row
    await retention.runBatch();
    await retention.runBatch();
    const judged = verifiedSubjects(log);
    expect(judged).toHaveLength(4);
    expect(new Set(judged).size).toBe(4);                                                // each row verified exactly once
    flight.clear();
    t += 3_600_000;                                                                      // the next pass starts from the beginning and finds the settled admission's job
    const next = await drain(retention);
    expect(next.flatMap(r => r.wouldDeleteJobs).map(j => j.jobId).sort()).toEqual(['a', 'b', 'c', 'pend']);
    expect(retention.counters().lastCompletePass?.wouldDelete).toEqual({ succeeded: 3, cancelled: 1, retired_no_effect: 0 });
  });

  it.each(Array.from({ length: 40 }, (_, i) => 20261100 + i))('seed %i: on the same snapshot the would-delete set equals the delete set (ids, classes and ages), and the gauge is its histogram', async (seed) => {
    const r = rng(seed);
    const population = genPopulation(r, 4 + Math.floor(r() * 30));
    const [reportStore, deleteStore] = [new OxigraphStore(), new OxigraphStore()];
    for (const store of [reportStore, deleteStore]) await put(store, ...population.map(p => p.job));
    const pending = population.filter(() => r() < 0.1).map(p => p.job.jobId);
    for (const store of [reportStore, deleteStore]) for (const id of pending) registerPendingFlight(store, id);
    const withBenign = r() < 0.75;
    const common = { benignFailedMaxAgeMs: withBenign ? WF : null };
    const reportRetention = newRetention(reportStore, { ...common, mode: 'report', batchSize: pick(r, [1, 3, 50]), sliceSize: pick(r, [1, 4, 10]) });
    const deleteRetention = newRetention(deleteStore, { ...common, mode: 'delete', batchSize: pick(r, [2, 5, 100]), sliceSize: pick(r, [1, 3, 10]) });
    const reported = (await drain(reportRetention)).flatMap(x => x.wouldDeleteJobs);
    const deleted = (await drain(deleteRetention)).flatMap(x => x.deletedJobs);
    const key = (j: { jobId: string; jobClass: string; updatedAt: number }) => `${j.jobId}|${j.jobClass}|${j.updatedAt}`;
    expect(reported.map(key).sort()).toEqual(deleted.map(key).sort());
    // report removed nothing; delete removed exactly that set
    expect((await storedIds(reportStore)).size).toBe(population.length);
    expect((await storedIds(deleteStore)).size).toBe(population.length - deleted.length);
    for (const j of deleted) expect(await present(deleteStore, j.jobId)).toBe('');
    // and the kinds are the D-6 classes, nothing else
    const kinds = new Map(population.map(p => [p.job.jobId, p.kind] as const));
    for (const j of reported) expect(DELETABLE_KINDS.has(kinds.get(j.jobId)!), `${j.jobId} ${kinds.get(j.jobId)}`).toBe(true);
    expect(reportRetention.counters().lastCompletePass?.wouldDelete).toEqual(classCounts(reported));
  });
});

describe('the report gauge: the would-delete count by class of the latest complete pass, not cumulative', () => {
  const rescan = { rescanIntervalMs: 1000, batchSize: 4 };

  it('is empty until a pass has completed, then holds that pass, and a second pass over the same rows does not double it', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    let t = NOW;
    const retention = newRetention(store, { mode: 'report', now: () => t, ...rescan });
    const first = await retention.runBatch();                                            // 4 of 10 old rows judged
    expect(first).toMatchObject({ hasMore: true, passCompleted: false });
    expect(retention.counters().lastCompletePass).toBeUndefined();
    let completed: ShareRetentionBatchResult | undefined;
    for (let i = 0; i < 10 && !completed; i++) { const res = await retention.runBatch(); if (res.passCompleted) completed = res; }
    expect(completed).toBeDefined();
    const pass1 = retention.counters().lastCompletePass!;
    expect(pass1.wouldDelete).toEqual({ succeeded: 3, cancelled: 2, retired_no_effect: 2 });
    expect(pass1.deleted).toEqual(emptyClassCounts());
    expect(pass1.scanned).toBe(10);                                                      // the 7 deletable + 3 retained failed rows older than the benign window
    expect(pass1.kept.failed_retained).toBe(2);
    expect(pass1.kept.unfinished_bound_obligation).toBe(1);

    t += 2000;                                                                           // past rescanIntervalMs: a fresh pass over the same, unchanged rows
    const partial = await retention.runBatch();
    expect(partial.passCompleted).toBe(false);
    expect(retention.counters().lastCompletePass).toEqual(pass1);                        // a pass in progress never replaces the gauge
    for (let i = 0; i < 10; i++) if ((await retention.runBatch()).passCompleted) break;
    const pass2 = retention.counters().lastCompletePass!;
    expect(pass2.wouldDelete).toEqual({ succeeded: 3, cancelled: 2, retired_no_effect: 2 });   // not 6 / 4 / 4
    expect(pass2.completedAt).toBe(t);
    expect(retention.counters().deleted).toEqual(emptyClassCounts());
  });

  it('follows the population: rows that left or arrived between passes change the next complete pass, and only that one', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    let t = NOW;
    const retention = newRetention(store, { mode: 'report', now: () => t, ...rescan });
    await drain(retention);
    expect(retention.counters().lastCompletePass!.wouldDelete).toEqual({ succeeded: 3, cancelled: 2, retired_no_effect: 2 });
    await store.deleteByPattern({ subject: jobSubject('s1'), graph: GRAPH });
    await store.deleteByPattern({ subject: jobSubject('s2'), graph: GRAPH });
    await put(store, retired('r3', 15 * W), retired('r4', 16 * W));
    t += 2000;
    const mid = await retention.runBatch();
    expect(mid.passCompleted).toBe(false);
    expect(retention.counters().lastCompletePass!.wouldDelete).toEqual({ succeeded: 3, cancelled: 2, retired_no_effect: 2 });   // still the old complete pass
    await drain(retention);
    expect(retention.counters().lastCompletePass!.wouldDelete).toEqual({ succeeded: 1, cancelled: 2, retired_no_effect: 4 });
  });

  it('a parked sweep that picks up rows aging in does not move the gauge: they belong to the next pass', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    let t = NOW;
    const retention = newRetention(store, { mode: 'report', now: () => t, batchSize: 100, rescanIntervalMs: 10 ** 9 });
    await drain(retention);
    const pass = retention.counters().lastCompletePass!;
    await put(store, mk('late', 'succeeded', {}, 10_000));
    t += W;                                                                              // 'late' is old enough now
    const res = await retention.runBatch();
    expect(res.wouldDelete).toBe(2);                                                     // 'late' and 'young-1' are old enough now: judged ...
    expect(res.passCompleted).toBe(false);
    expect(retention.counters().lastCompletePass).toEqual(pass);                         // ... but not part of the complete pass
  });

  it('in delete mode the pass summary carries what was deleted, and the would-delete gauge is zero', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    const retention = newRetention(store, { mode: 'delete', batchSize: 4, sliceSize: 2 });
    await drain(retention);
    const pass = retention.counters().lastCompletePass!;
    expect(pass.deleted).toEqual({ succeeded: 3, cancelled: 2, retired_no_effect: 2 });
    expect(pass.wouldDelete).toEqual(emptyClassCounts());
    expect(retention.counters().deleted).toEqual({ succeeded: 3, cancelled: 2, retired_no_effect: 2 });
  });
});

describe('counters', () => {
  it('count deletions by class and judgments by keep reason, cumulatively, and skips and errors by kind', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    const retention = newRetention(store, { batchSize: 4 });
    await drain(retention);
    const c = retention.counters();
    expect(c.mode).toBe('delete');
    expect(c.deleted).toEqual({ succeeded: 3, cancelled: 2, retired_no_effect: 2 });
    expect(c.kept).toMatchObject({ failed_retained: 2, unfinished_bound_obligation: 1, too_recent: 0, pending_admission: 0 });
    expect(c.scanned).toBe(10);
    expect(c.batches).toBeGreaterThan(0);
    expect(c.holds).toBeGreaterThan(0);
    expect(c.errors).toEqual({ scan: 0, verify: 0, delete: 0 });
    expect(c.skipped).toEqual({ off: 0, overlap: 0, clock_invalid: 0, clock_backwards: 0, clock_jump: 0 });
    // the snapshot is a copy
    (c.deleted as Record<string, number>)['succeeded'] = 99;
    expect(retention.counters().deleted.succeeded).toBe(3);
  });

  it('count an error once and judge the rows again on the next call without counting their keeps twice', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    let fail = true;
    const { store: spied } = spy(store, async (_sparql, source, run) => {
      if (fail && source === 'publisher.asyncPromote.retention.verify') { fail = false; throw new Error('verify down'); }
      return run();
    });
    const retention = newRetention(spied, { batchSize: 100 });
    expect(await retention.runBatch()).toMatchObject({ error: { phase: 'verify', message: 'verify down' }, deleted: 0 });
    expect(retention.counters()).toMatchObject({ errors: { verify: 1 }, scanned: 0 });
    await drain(retention);
    expect(retention.counters()).toMatchObject({ scanned: 10, kept: { failed_retained: 2, unfinished_bound_obligation: 1 } });
  });
});

describe('every deletion batch is logged at info with job ids, class, updatedAt and age', () => {
  it('writes one line per hold that deleted, listing exactly the jobs deleted in it', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    const logger = captureLogger();
    const retention = newRetention(store, { logger, batchSize: 100, sliceSize: 3 });
    const res = await retention.runBatch();
    const deletedLines = lines(logger.infos, 'deleted');
    expect(deletedLines).toHaveLength(3);                                                // 7 jobs in holds of 3
    const logged = deletedLines.flatMap(jobsOf);
    expect(logged.map(j => j.jobId).sort()).toEqual(res.deletedJobs.map(j => j.jobId).sort());
    for (const j of logged) {
      const done = res.deletedJobs.find(d => d.jobId === j.jobId)!;
      expect(j).toEqual({ jobId: done.jobId, class: done.jobClass, updatedAt: done.updatedAt, ageMs: NOW - done.updatedAt });
      expect(j.ageMs).toBeGreaterThanOrEqual(W);
    }
    for (const line of deletedLines) {
      expect(line).toMatch(/^async_promote_retention action=deleted mode=delete count=\d+ classes=\{.*\} now=\d+ jobs=\[/);
      expect(JSON.parse(/ classes=(\{[^}]*\})/.exec(line)![1]!)).toEqual(classCounts(jobsOf(line).map(j => ({ jobClass: j.class }))));
    }
    expect(logger.warns).toEqual([]);
  });

  it('logs a report batch as would_delete, never as deleted, and one line per completed pass', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    const logger = captureLogger();
    await drain(newRetention(store, { mode: 'report', logger, batchSize: 3, sliceSize: 5 }));
    expect(lines(logger.infos, 'deleted')).toEqual([]);
    expect(lines(logger.infos, 'would_delete').flatMap(jobsOf).map(j => j.jobId).sort()).toEqual(['c1', 'c2', 'r1', 'r2', 's1', 's2', 's3']);
    const pass = logger.infos.filter(l => l.startsWith('async_promote_retention_pass '));
    expect(pass).toHaveLength(1);
    expect(pass[0]).toContain('mode=report');
    expect(pass[0]).toContain('wouldDelete={"succeeded":3,"cancelled":2,"retired_no_effect":2}');
  });

  it('logs nothing for a hold that deleted nothing, and a failed logger never alters the sweep', async () => {
    const store = new OxigraphStore();
    await put(store, mk('fatal', 'failed', {}, 20 * W), mk('s', 'succeeded', {}, 10 * W));
    const logger = { info: () => { throw new Error('log sink down'); }, warn: () => { throw new Error('log sink down'); } };
    const res = await newRetention(store, { logger }).runBatch();
    expect(res.deleted).toBe(1);
    expect(res.error).toBeUndefined();
    expect(await present(store, 's')).toBe('');
  });
});

describe('fault injection between sibling deletes', () => {
  it.each([0, 1, 2, 3, 4])('a store failure at delete %i of 5: the earlier jobs are gone completely, the later ones intact, the failing one is named, and the next call finishes', async (failAt) => {
    const store = new OxigraphStore();
    await put(store, ...Array.from({ length: 5 }, (_, i) => mk(`d${i}`, 'succeeded', {}, 10 * W + (4 - i))), mk('bystander', 'queued', {}, 10 * W));
    const before = new Map<string, string>();
    for (const id of ['d0', 'd1', 'd2', 'd3', 'd4', 'bystander']) before.set(id, await present(store, id));
    let deletes = 0, armed = true;
    const { store: spied } = spy(store, undefined, { before: (entry: Logged) => { if (armed && entry.source === 'publisher.asyncPromote.retention.delete' && deletes++ === failAt) { armed = false; throw new Error('store dropped the delete'); } } });
    const logger = captureLogger();
    const retention = newRetention(spied, { logger, batchSize: 100, sliceSize: 10 });
    const res = await retention.runBatch();
    expect(res.error).toEqual({ phase: 'delete', message: 'store dropped the delete' });
    expect(res.deleted).toBe(failAt);
    expect(res.deletedJobs.map(j => j.jobId)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4'].slice(0, failAt));      // oldest first
    for (let i = 0; i < 5; i++) {
      const after = await present(store, `d${i}`);
      expect(after, `d${i}`).toBe(i < failAt ? '' : before.get(`d${i}`));                // never half a job: gone entirely, or untouched
    }
    expect(await present(store, 'bystander')).toBe(before.get('bystander'));
    expect(logger.warns.join('\n')).toContain(`delete_outcome_unknown jobId=d${failAt}`);
    if (failAt > 0) expect(lines(logger.infos, 'deleted').flatMap(jobsOf).map(j => j.jobId)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4'].slice(0, failAt));
    expect(retention.counters().errors.delete).toBe(1);
    await drain(retention);                                                              // the cursor did not move: the next call judges the rest again
    expect([...(await storedIds(store))]).toEqual(['bystander']);
  });

  it('a failing flush after the deletes reports the delete phase but loses no record of what was deleted', async () => {
    const store = new OxigraphStore();
    await put(store, mk('a', 'succeeded', {}, 10 * W), mk('b', 'succeeded', {}, 10 * W + 1));
    let armed = true;
    const { store: spied } = spy(store, undefined, { before: (entry: Logged) => { if (armed && entry.kind === 'flush') { armed = false; throw new Error('flush failed'); } } });
    const logger = captureLogger();
    const res = await newRetention(spied, { logger }).runBatch();
    expect(res.error).toEqual({ phase: 'delete', message: 'flush failed' });
    expect(res.deletedJobs.map(j => j.jobId).sort()).toEqual(['a', 'b']);
    expect(lines(logger.infos, 'deleted').flatMap(jobsOf).map(j => j.jobId).sort()).toEqual(['a', 'b']);
  });
});

describe('the clock guard', () => {
  const INTERVAL = 60_000;
  const rig = async (over: Record<string, unknown> = {}) => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    const clock = { wall: NOW, mono: 0 };
    const logger = captureLogger();
    const retention = newRetention(spied, { intervalMs: INTERVAL, now: () => clock.wall, monotonicNow: () => clock.mono, logger, batchSize: 100, ...over });
    return { store, spied, log, clock, logger, retention };
  };

  it('runs the first tick, and a tick on schedule, and a tick at exactly k intervals; skips one later than that', async () => {
    const { store, clock, retention } = await rig();
    await put(store, ...Array.from({ length: 4 }, (_, i) => mk(`s${i}`, 'succeeded', {}, 10 * W + i)));
    expect((await retention.runBatch()).skipped).toBeUndefined();
    clock.wall += INTERVAL;
    expect((await retention.runBatch()).skipped).toBeUndefined();
    clock.wall += 3 * INTERVAL;                                                         // exactly clockGuardFactor (3) intervals after the previous start
    expect((await retention.runBatch()).skipped).toBeUndefined();
    clock.wall += 3 * INTERVAL + 1;
    expect(await retention.runBatch()).toMatchObject({ skipped: 'clock_jump', scanned: 0, deleted: 0 });
    expect(retention.counters().skipped.clock_jump).toBe(1);
  });

  it('skips a tick when the clock stepped back, makes no store call, and resumes on the next tick (the skipped tick re-baselines the guard)', async () => {
    const { store, log, clock, logger, retention } = await rig();
    await put(store, mk('s1', 'succeeded', {}, 100 * W));
    await retention.runBatch();
    expect(await present(store, 's1')).toBe('');
    const calls = log.length;
    clock.wall -= 1_800_000;                                                             // half an hour back
    expect(await retention.runBatch()).toMatchObject({ skipped: 'clock_backwards', scanned: 0, deleted: 0 });
    expect(log.length).toBe(calls);
    expect(logger.warns.at(-1)).toContain('skipped=clock_backwards');
    await put(store, mk('s2', 'succeeded', {}, 50 * W));                                 // 50 minutes old by the right clock, 20 by this one: old enough either way
    clock.wall += INTERVAL;
    expect((await retention.runBatch()).skipped).toBeUndefined();
    expect(await present(store, 's2')).toBe('');
    expect(retention.counters().skipped.clock_backwards).toBe(1);
  });

  it('a forward leap deletes nothing even though every row now looks old; the next tick, on schedule again, judges by the new clock', async () => {
    const { store, log, clock, retention } = await rig();
    await put(store, mk('young', 'succeeded', {}, W / 2), mk('old', 'succeeded', {}, 10 * W));
    await retention.runBatch();
    expect(await present(store, 'old')).toBe('');
    expect(await present(store, 'young')).not.toBe('');
    const calls = log.length;
    clock.wall += 10 * W;                                                               // the clock leaps: 'young' would now count as 10 minutes old
    expect(await retention.runBatch()).toMatchObject({ skipped: 'clock_jump', deleted: 0 });
    expect(log.length).toBe(calls);
    expect(await present(store, 'young')).not.toBe('');
    clock.wall += INTERVAL;
    expect((await retention.runBatch()).skipped).toBeUndefined();
    expect(await present(store, 'young')).toBe('');
  });

  it('allows for the time the previous batch itself took (the caller paces ticks from the end of a batch)', async () => {
    const store = new OxigraphStore();
    const clock = { wall: NOW, mono: 0 };
    let slowOnce = true;
    const { store: spied } = spy(store, undefined, { after: (e: Logged) => { if (slowOnce && e.source?.endsWith('.scan')) { slowOnce = false; clock.mono += 300_000; } } });
    const retention = newRetention(spied, { intervalMs: INTERVAL, clockGuardFactor: 1, now: () => clock.wall, monotonicNow: () => clock.mono, batchSize: 100 });
    await put(store, mk('s', 'succeeded', {}, 10 * W));
    await retention.runBatch();                                                          // took 5 minutes on the monotonic clock
    clock.wall += INTERVAL + 300_000;                                                    // one interval after the END of that batch: on schedule
    expect((await retention.runBatch()).skipped).toBeUndefined();
    clock.wall += INTERVAL + 1;                                                          // that batch was instant, so the allowance is back to one interval
    expect((await retention.runBatch()).skipped).toBe('clock_jump');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('skips a tick whose wall clock reads %s, and does not let it become the baseline', async (bad) => {
    const { store, clock, retention } = await rig();
    await put(store, mk('s', 'succeeded', {}, 10 * W));
    clock.wall = bad;
    expect(await retention.runBatch()).toMatchObject({ skipped: 'clock_invalid', deleted: 0 });
    clock.wall = NOW;
    expect((await retention.runBatch()).skipped).toBeUndefined();                       // there was no previous start to compare with
    expect(await present(store, 's')).toBe('');
  });

  it('never deletes a row dated after now: an index that says old but a payload dated in the future, and a future row of every deletable class', async () => {
    const store = new OxigraphStore();
    await put(store, mk('sf', 'succeeded', {}, -60_000), mk('cf', 'failed', { reason: 'cancelled' }, -60_000), { ...retired('rf'), updatedAt: NOW + 60_000 }, mk('skew', 'succeeded', {}, -5000));
    await store.deleteByPattern({ subject: jobSubject('skew'), predicate: 'urn:dkg:promote-queue:updatedAt', graph: GRAPH });
    await store.insert([{ subject: jobSubject('skew'), predicate: 'urn:dkg:promote-queue:updatedAt', object: `"${NOW - 5 * W}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: GRAPH }]);     // index: old, payload: dated NOW + 5 s
    const retention = newRetention(store, { batchSize: 100 });
    const results = await drain(retention);
    expect(results.flatMap(r => r.deletedJobs)).toEqual([]);
    expect(await present(store, 'skew')).not.toBe('');
    expect(results.reduce((n, r) => n + r.kept.future_dated, 0)).toBeGreaterThanOrEqual(1);
    // and in report mode the rows are not counted as would-delete either
    const report = await drain(newRetention(store, { mode: 'report', batchSize: 100 }));
    expect(report.flatMap(r => r.wouldDeleteJobs)).toEqual([]);
  });

  it('reads the wall clock once per batch: a payload that is young when the batch starts is kept even if the clock moves on while the batch runs', async () => {
    const store = new OxigraphStore();
    await put(store, mk('young-payload', 'succeeded', {}, 10_000), mk('control', 'succeeded', {}, 10 * W));
    await store.deleteByPattern({ subject: jobSubject('young-payload'), predicate: 'urn:dkg:promote-queue:updatedAt', graph: GRAPH });
    await store.insert([{ subject: jobSubject('young-payload'), predicate: 'urn:dkg:promote-queue:updatedAt', object: `"${NOW - 5 * W}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: GRAPH }]);   // index: old, payload: 10 s old
    let t = NOW;
    const { store: spied } = spy(store, undefined, { after: (e: Logged) => { if (e.source?.endsWith('.scan')) t += 5 * W; } });   // the clock leaps while the batch runs
    const res = await newRetention(spied, { now: () => t, batchSize: 100 }).runBatch();
    expect(res.kept.too_recent).toBe(1);                                                 // judged by the clock of the batch's start
    expect(await present(store, 'young-payload')).not.toBe('');
    expect(await present(store, 'control')).toBe('');
  });
});

describe('the admission coordinator the sweep consults is the queue\'s own', () => {
  it('hasPendingJob is true exactly while an admission that handed the job ID to persistence is unsettled', async () => {
    const coordinator = new PromoteAdmissionCoordinator();
    const flights = (coordinator as unknown as { pending: Map<string, unknown> }).pending;
    expect(coordinator.hasPendingJob('j')).toBe(false);
    const early = new PromoteAdmissionAttempt(60_000, () => {});                          // still before persistence: it has no job ID yet
    flights.set('early', { attempt: early, result: Promise.resolve('x'), scope: {} });
    expect(coordinator.hasPendingJob('j')).toBe(false);
    const persisting = new PromoteAdmissionAttempt(60_000, () => {});
    persisting.beginPersistence('j');
    flights.set('persisting', { attempt: persisting, result: Promise.resolve('x'), scope: {} });
    expect(coordinator.hasPendingJob('j')).toBe(true);
    expect(coordinator.hasPendingJob('other')).toBe(false);
    coordinator.observe(mk('j', 'queued'));                                              // a durable observation of the job settles the admission
    expect(coordinator.hasPendingJob('j')).toBe(false);
  });

  it('an admission still pending through the queue protects its job from the sweep built over the same store object, until a durable read settles it', async () => {
    const raw = new OxigraphStore();
    let armed = true;
    // the write commits, then the response is lost: the queue keeps the admission pending with the job ID (an indeterminate admission)
    const store = new Proxy(raw, { get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p !== 'replaceSubject' || typeof v !== 'function') return typeof v === 'function' ? v.bind(t) : v;
      return async (...args: unknown[]) => {
        const out = await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
        if (armed) { armed = false; throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'nested.query', { storeOperation: 'query' }); }
        return out;
      };
    } }) as TripleStore;
    const queue = new TripleStoreAsyncPromoteQueue(store, { now: () => NOW, idGenerator: () => 'lost-ack-1', admissionTimeoutMs: 1000 });
    const admission = await queue.enqueue({ contextGraphId: 'cg', assertionName: 'lost', agentAddress: AG, entities: 'all' }).then(() => undefined, (e: unknown) => e) as { admissionOutcome?: string; jobId?: string };
    expect(admission).toMatchObject({ admissionOutcome: 'indeterminate', jobId: 'lost-ack-1' });
    // the job has since finished, long ago, as far as the store is concerned (written behind the queue's back: nothing observed it)
    await raw.deleteByPattern({ subject: jobSubject('lost-ack-1'), graph: GRAPH });
    await put(raw, mk('lost-ack-1', 'succeeded', {}, 10 * W));

    const retention = newRetention(store, { batchSize: 10 });
    expect(PromoteAdmissionCoordinator.for(store, GRAPH).hasPendingJob('lost-ack-1')).toBe(true);
    const res = await retention.runBatch();
    expect(res).toMatchObject({ deleted: 0, kept: { pending_admission: 1 } });
    expect(await present(raw, 'lost-ack-1')).not.toBe('');

    // a sweep that holds the queue's coordinator explicitly is protected too, over any store object
    const viaWrapper = new Proxy(raw, { get(t, p) { const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; } }) as TripleStore;
    expect(PromoteAdmissionCoordinator.for(viaWrapper, GRAPH)).not.toBe(PromoteAdmissionCoordinator.for(store, GRAPH));     // a different store object has a different coordinator
    const explicit = newRetention(viaWrapper, { admissions: PromoteAdmissionCoordinator.for(store, GRAPH), batchSize: 10 });
    expect(await explicit.runBatch()).toMatchObject({ deleted: 0, kept: { pending_admission: 1 } });

    // a durable read of the job through the queue settles the admission; the next sweep may delete it
    expect(await queue.getStatus('lost-ack-1')).toMatchObject({ state: 'succeeded' });
    expect(PromoteAdmissionCoordinator.for(store, GRAPH).hasPendingJob('lost-ack-1')).toBe(false);
    const later = newRetention(store, { batchSize: 10 });
    expect(await later.runBatch()).toMatchObject({ deleted: 1 });
    expect(await present(raw, 'lost-ack-1')).toBe('');
  });

  it('a delete invalidates the coordinator\'s observation of the job it removed', async () => {
    const store = new OxigraphStore();
    await put(store, mk('s', 'succeeded', {}, 10 * W));
    const coordinator = PromoteAdmissionCoordinator.for(store, GRAPH);
    const invalidated: string[] = [];
    const original = coordinator.invalidate.bind(coordinator);
    coordinator.invalidate = (id: string) => { invalidated.push(id); original(id); };
    await newRetention(store).runBatch();
    expect(invalidated).toEqual(['s']);
  });
});

describe('a retention judges only the graph it was given', () => {
  it('judges only the graph it was given and leaves the default control graph alone', async () => {
    const store = new OxigraphStore();
    const OTHER = 'urn:test:custom-promote-control';
    await insertQuads(store, rowOf('succeeded', 'a', 10 * W));
    await insertQuads(store, rowOf('succeeded', 'b', 10 * W).map(q => ({ ...q, graph: OTHER })));
    const res = await newRetention(store, { graphUri: OTHER, batchSize: 10 }).runBatch();
    expect(res.deletedJobs.map(j => j.jobId)).toEqual(['b']);
    expect(await present(store, 'a')).not.toBe('');
    expect(await present(store, 'b', OTHER)).toBe('');
  });
});
