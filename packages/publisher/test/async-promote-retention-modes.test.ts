/**
 * OT-RFC-73 P10a: the modes (`off`, `report`, `delete`), the counters and the per-pass report gauge, the batch log, the clock guard, the fault injection between
 * sibling deletes, and the identity of the admission coordinator the sweep consults.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore, StoreSchedulerBusyError, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PromoteAdmissionAttempt, PromoteAdmissionCoordinator } from '../src/promote-admission.js';
import { jobSubject } from '../src/async-promote-queue-utils.js';
import { ShareRetentionAdmissionUnavailableError, createShareRetention, type ShareRetentionBatchResult } from '../src/async-promote-retention.js';
import { emptyClassCounts } from '../src/async-promote-retention-policy.js';
import {
  AG, GRAPH, NOW, W, WF, DELETABLE_KINDS, captureLogger, drain, genPopulation, graphFingerprint, insertQuads, mk, newRetention, pick, present, put,
  registerPendingFlight, retired, rng, rowOf, spy, storedIds, verifiedSubjects, type Logged, type QueryResult,
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

  it('a scan that breaks the ORDER BY contract poisons its pass: the rows the sweep judged twice are never published as the gauge, the next clean pass is', async () => {
    const store = new OxigraphStore();
    await put(store, ...Array.from({ length: 6 }, (_, i) => mk(`s${i}`, 'succeeded', {}, 10 * W + i * 1000)));
    let unordered = true;
    const { store: spied } = spy(store, async (_sparql, source, run) => {
      const res = await run();
      if (!unordered || source !== 'publisher.asyncPromote.retention.scan' || res.type !== 'bindings') return res;
      unordered = false;                                                                 // one non-conforming answer: newest first
      return { ...res, bindings: [...res.bindings].reverse() } as QueryResult;
    });
    let t = NOW;
    const retention = newRetention(spied, { mode: 'report', now: () => t, rescanIntervalMs: 1000 });
    expect(await retention.runBatch()).toMatchObject({ anomalies: 1, wouldDelete: 6, hasMore: true, passCompleted: false });
    const second = await retention.runBatch();                                           // the cursor did not move on the broken answer: the same six rows again
    expect(second).toMatchObject({ anomalies: 0, wouldDelete: 6, hasMore: false, passCompleted: false });
    expect(retention.counters().lastCompletePass).toBeUndefined();                       // not { succeeded: 12 }: a pass that met an anomaly never completes
    t += 2000;                                                                           // the safety rescan starts a fresh pass
    const clean = await drain(retention);
    expect(clean.filter(r => r.passCompleted)).toHaveLength(1);
    expect(retention.counters().lastCompletePass).toMatchObject({ scanned: 6, wouldDelete: { succeeded: 6, cancelled: 0, retired_no_effect: 0 } });
    expect(retention.counters().anomalies).toBe(1);
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

describe('delete mode logs every deletion hold at info with job ids, class, updatedAt and age; report mode logs one line per completed pass', () => {
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

  it('report mode writes ONE summary line per completed pass and nothing per hold or per job: no job id, no would_delete line, however many holds and passes', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    const logger = captureLogger();
    let t = NOW;
    const retention = newRetention(store, { mode: 'report', logger, now: () => t, batchSize: 3, sliceSize: 2, rescanIntervalMs: 1000 });
    const first = await drain(retention);
    expect(first.reduce((n, r) => n + r.holds, 0)).toBeGreaterThanOrEqual(4);                  // 7 would-delete jobs in holds of 2, in batches of 3: many holds, many batches
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(lines(logger.infos, 'would_delete')).toEqual([]);
    expect(lines(logger.infos, 'deleted')).toEqual([]);
    expect(logger.infos).toHaveLength(1);                                                       // the pass summary and nothing else
    const [summary] = logger.infos;
    const gauge = retention.counters().lastCompletePass!;
    expect(summary).toMatch(/^async_promote_retention_pass mode=report scanned=\d+ wouldDelete=\{[^}]*\} deleted=\{[^}]*\} kept=\{[^}]*\}$/);
    expect(summary).not.toMatch(/jobs=|jobId|updatedAt|ageMs/);
    for (const id of ['s1', 's2', 's3', 'c1', 'c2', 'r1', 'r2', 'fatal-1', 'bound-1', 'young-1', 'queued-1']) expect(summary, id).not.toContain(`"${id}"`);
    const field = (name: string) => JSON.parse(new RegExp(` ${name}=(\\{[^}]*\\})`).exec(summary!)![1]!) as Record<string, number>;
    expect(field('wouldDelete')).toEqual({ succeeded: 3, cancelled: 2, retired_no_effect: 2 });   // the gauge of the pass, by class
    expect(field('wouldDelete')).toEqual(gauge.wouldDelete);
    expect(field('deleted')).toEqual({ succeeded: 0, cancelled: 0, retired_no_effect: 0 });
    expect(field('kept')).toEqual(gauge.kept);                                                  // counts by reason
    expect(field('kept')).toMatchObject({ failed_retained: 2, unfinished_bound_obligation: 1, too_recent: 0 });
    expect(Number(/ scanned=(\d+)/.exec(summary!)![1])).toBe(gauge.scanned);
    // a second pass is one more summary line, still no per-job lines
    t += 5000;
    await drain(retention);
    expect(logger.infos.filter(l => l.startsWith('async_promote_retention_pass '))).toHaveLength(2);
    expect(logger.infos).toHaveLength(2);
    expect(logger.warns).toEqual([]);
  });

  it('delete mode keeps its per-hold audit line with job ids, and still writes one summary line per completed pass', async () => {
    const store = new OxigraphStore();
    await standardStore(store);
    const logger = captureLogger();
    await drain(newRetention(store, { logger, batchSize: 100, sliceSize: 3 }));
    expect(lines(logger.infos, 'deleted').flatMap(jobsOf).map(j => j.jobId).sort()).toEqual(['c1', 'c2', 'r1', 'r2', 's1', 's2', 's3']);
    expect(lines(logger.infos, 'would_delete')).toEqual([]);
    const pass = logger.infos.filter(l => l.startsWith('async_promote_retention_pass '));
    expect(pass).toHaveLength(1);
    expect(pass[0]).toContain('mode=delete');
    expect(pass[0]).toContain('deleted={"succeeded":3,"cancelled":2,"retired_no_effect":2}');
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
  const DAY = 24 * 3_600_000;
  // `tick(ms)`: time passes (a timer fires late, a batch runs long): both clocks advance. `leap(ms)`: the wall clock steps and the monotonic clock does not.
  const rig = async (over: Record<string, unknown> = {}) => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    const clock = { wall: NOW, mono: 0 };
    const tick = (ms: number) => { clock.wall += ms; clock.mono += ms; };
    const leap = (ms: number) => { clock.wall += ms; };
    const logger = captureLogger();
    const retention = newRetention(spied, { intervalMs: INTERVAL, now: () => clock.wall, monotonicNow: () => clock.mono, logger, batchSize: 100, ...over });
    return { store, spied, log, clock, tick, leap, logger, retention };
  };

  it('runs the first tick, a tick on schedule, and a leap of exactly the tolerance (k intervals); skips one beyond it', async () => {
    const { store, tick, leap, retention } = await rig();
    await put(store, ...Array.from({ length: 4 }, (_, i) => mk(`s${i}`, 'succeeded', {}, 10 * W + i)));
    expect((await retention.runBatch()).skipped).toBeUndefined();
    tick(INTERVAL);
    expect((await retention.runBatch()).skipped).toBeUndefined();
    leap(3 * INTERVAL);                                                                 // exactly clockGuardFactor (3) intervals ahead of the monotonic clock
    expect((await retention.runBatch()).skipped).toBeUndefined();
    leap(3 * INTERVAL + 1);
    expect(await retention.runBatch()).toMatchObject({ skipped: 'clock_jump', scanned: 0, deleted: 0 });
    expect(retention.counters().skipped.clock_jump).toBe(1);
  });

  it('skips every tick while the clock is behind the last sweep start (a skipped tick is not a sweep start), makes no store call, and resumes once it has caught up; a later leap is still caught', async () => {
    const { store, log, tick, leap, logger, retention } = await rig();
    await put(store, mk('s1', 'succeeded', {}, 100 * W));
    await retention.runBatch();
    expect(await present(store, 's1')).toBe('');
    const calls = log.length;
    const BACK = 1_800_000;
    leap(-BACK);                                                                         // half an hour back
    expect(await retention.runBatch()).toMatchObject({ skipped: 'clock_backwards', scanned: 0, deleted: 0 });
    expect(logger.warns.at(-1)).toContain('skipped=clock_backwards');
    await put(store, mk('s2', 'succeeded', {}, 50 * W));                                 // 50 minutes old by the right clock, 20 by this one: old enough either way
    for (let elapsed = INTERVAL; elapsed < BACK; elapsed += INTERVAL) {                  // still behind the last sweep start
      tick(INTERVAL);
      expect((await retention.runBatch()).skipped, `after ${elapsed} ms`).toBe('clock_backwards');
    }
    expect(log.length).toBe(calls);                                                      // the skipped ticks made no store call
    expect(await present(store, 's2')).not.toBe('');
    tick(INTERVAL);                                                                      // caught up with the start of the last sweep
    expect((await retention.runBatch()).skipped).toBeUndefined();
    expect(await present(store, 's2')).toBe('');
    expect(retention.counters().skipped.clock_backwards).toBe(BACK / INTERVAL);
    leap(365 * DAY);                                                                     // a forward leap after the step back is a jump against the baseline of the tick that ran
    expect((await retention.runBatch()).skipped).toBe('clock_jump');
  });

  it('a clock that stepped back and returns is not a jump: the next tick runs at once', async () => {
    const { store, tick, leap, retention } = await rig();
    await put(store, mk('s1', 'succeeded', {}, 100 * W));
    await retention.runBatch();
    leap(-1_800_000);
    expect((await retention.runBatch()).skipped).toBe('clock_backwards');
    await put(store, mk('s2', 'succeeded', {}, 50 * W));
    leap(1_800_000);                                                                     // the clock is right again
    tick(INTERVAL);
    expect((await retention.runBatch()).skipped).toBeUndefined();
    expect(await present(store, 's2')).toBe('');
  });

  it('a forward leap is skipped and NEVER trusted afterwards: with the production 7-day windows rows that are really a minute old survive every later tick on the leapt clock, and the sweep resumes when the clock comes back', async () => {
    const { store, log, tick, leap, retention } = await rig({ succeededMaxAgeMs: 7 * DAY, benignFailedMaxAgeMs: 7 * DAY });
    await put(store, mk('old', 'succeeded', {}, 8 * DAY));
    expect((await retention.runBatch()).skipped).toBeUndefined();                       // tick 1 runs
    expect(await present(store, 'old')).toBe('');
    await put(store, mk('young-s', 'succeeded', {}, INTERVAL), mk('young-c', 'failed', { reason: 'cancelled' }, INTERVAL));   // really one minute old
    const calls = log.length;
    leap(365 * DAY);                                                                     // the clock jumps a year ahead: both would now count as a year old
    for (let i = 0; i < 6; i++) {                                                        // the jump, then every following tick on schedule on the leapt clock
      expect(await retention.runBatch(), `tick ${i + 2}`).toMatchObject({ skipped: 'clock_jump', scanned: 0, deleted: 0 });
      tick(INTERVAL);
    }
    expect(log.length).toBe(calls);                                                      // not a single store call
    expect(await present(store, 'young-s')).not.toBe('');
    expect(await present(store, 'young-c')).not.toBe('');
    expect(retention.counters().skipped.clock_jump).toBe(6);
    expect(retention.counters().deleted).toEqual({ succeeded: 1, cancelled: 0, retired_no_effect: 0 });
    await put(store, mk('aged', 'succeeded', {}, 7.5 * DAY));                            // a row that really is old enough, waiting
    leap(-365 * DAY);                                                                    // the clock comes back
    expect(await retention.runBatch()).toMatchObject({ deleted: 1 });
    expect(await present(store, 'aged')).toBe('');
    expect(await present(store, 'young-s')).not.toBe('');                                // still really young by the sound clock
    expect(await present(store, 'young-c')).not.toBe('');
  });

  it('a late timer or a batch that runs long is not a jump (both clocks advance), and never wedges the sweep', async () => {
    const store = new OxigraphStore();
    const clock = { wall: NOW, mono: 0 };
    let slowOnce = true;
    const { store: spied } = spy(store, undefined, { after: (e: Logged) => { if (slowOnce && e.source?.endsWith('.scan')) { slowOnce = false; clock.wall += 300_000; clock.mono += 300_000; } } });
    const retention = newRetention(spied, { intervalMs: INTERVAL, clockGuardFactor: 1, now: () => clock.wall, monotonicNow: () => clock.mono, batchSize: 100 });
    await put(store, mk('s', 'succeeded', {}, 10 * W));
    await retention.runBatch();                                                          // took 5 minutes: five intervals, with a tolerance of one
    clock.wall += INTERVAL + 300_000; clock.mono += INTERVAL + 300_000;
    expect((await retention.runBatch()).skipped).toBeUndefined();
    clock.wall += 3 * 24 * 3_600_000; clock.mono += 3 * 24 * 3_600_000;                  // the event loop was stalled for three days
    expect((await retention.runBatch()).skipped).toBeUndefined();
    clock.wall += INTERVAL + 1;                                                          // only the wall clock moved: beyond the tolerance of one interval
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

  it('skips a tick whose monotonic clock does not read a finite number', async () => {
    const { store, clock, retention } = await rig();
    await put(store, mk('s', 'succeeded', {}, 10 * W));
    clock.mono = Number.NaN;
    expect(await retention.runBatch()).toMatchObject({ skipped: 'clock_invalid', deleted: 0 });
    expect(await present(store, 's')).not.toBe('');
    clock.mono = 0;
    expect((await retention.runBatch()).skipped).toBeUndefined();
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

  /**
   * A real queue whose first admission commits and then loses its reply: job `lost-ack-1` stays a pending (indeterminate) admission in the queue's own coordinator.
   * The job has since finished, long ago, as far as the store is concerned (written behind the queue's back: nothing observed it).
   */
  async function lostAckQueue() {
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
    await raw.deleteByPattern({ subject: jobSubject('lost-ack-1'), graph: GRAPH });
    await put(raw, mk('lost-ack-1', 'succeeded', {}, 10 * W));
    return { raw, store, queue };
  }
  /** Another object over the same data: the coordinator of the queue's store object is not its coordinator. */
  const anotherObjectOver = (raw: TripleStore) => new Proxy(raw, { get(t, p) { const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; } }) as TripleStore;
  const direct = (store: TripleStore, over: Record<string, unknown> = {}) =>
    createShareRetention({ store, mode: 'delete', intervalMs: 60_000, now: () => NOW, monotonicNow: () => 0, logger: captureLogger(), batchSize: 10, ...over });

  it('an admission still pending through the queue protects its job from the sweep built over the same store object, until a durable read settles it', async () => {
    const { raw, store, queue } = await lostAckQueue();
    const retention = newRetention(store, { batchSize: 10 });
    expect(PromoteAdmissionCoordinator.for(store, GRAPH).hasPendingJob('lost-ack-1')).toBe(true);
    const res = await retention.runBatch();
    expect(res).toMatchObject({ deleted: 0, kept: { pending_admission: 1 } });
    expect(await present(raw, 'lost-ack-1')).not.toBe('');

    // a sweep that holds the queue's coordinator explicitly is protected too, over any store object
    const viaWrapper = anotherObjectOver(raw);
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

  it('a sweep over the queue\'s own store object, with nothing standing in for the queue, keeps the pending admission (pending_admission) in both active modes', async () => {
    const { raw, store } = await lostAckQueue();
    for (const mode of ['delete', 'report'] as const) {
      expect(await direct(store, { mode }).runBatch()).toMatchObject({ deleted: 0, wouldDelete: 0, kept: { pending_admission: 1 } });
    }
    expect(await present(raw, 'lost-ack-1')).not.toBe('');
  });

  it('refuses to be created for a store object the queue was never built with: a typed error, not one store call, not one delete, and no coordinator made on the side', async () => {
    const { raw, store } = await lostAckQueue();
    const other = anotherObjectOver(raw);                                                 // the same data, but not the queue's store object
    const { store: spied, log } = spy(other);
    const before = await graphFingerprint(raw);
    for (const mode of ['delete', 'report'] as const) {
      let error: unknown;
      try { direct(spied, { mode }); } catch (cause) { error = cause; }
      expect(error, mode).toBeInstanceOf(ShareRetentionAdmissionUnavailableError);
      expect(error).toMatchObject({ name: 'ShareRetentionAdmissionUnavailableError', code: 'SHARE_RETENTION_ADMISSION_UNAVAILABLE', graphUri: GRAPH });
    }
    expect(log).toEqual([]);                                                              // it refused before any store call
    expect(await graphFingerprint(raw)).toBe(before);                                     // so the pending job is still there
    expect(await present(raw, 'lost-ack-1')).not.toBe('');
    expect(PromoteAdmissionCoordinator.existing(spied, GRAPH)).toBeUndefined();           // the refusal made no coordinator (a made one would be empty)
    expect(PromoteAdmissionCoordinator.existing(other, GRAPH)).toBeUndefined();
    // a graph the queue was not built with is refused the same way, over the queue's own store object
    expect(() => direct(store, { graphUri: 'urn:test:other-control' })).toThrow(ShareRetentionAdmissionUnavailableError);
    expect(PromoteAdmissionCoordinator.existing(store, 'urn:test:other-control')).toBeUndefined();
    // the queue's own store object, and the queue's coordinator passed in, are accepted
    expect(() => direct(store)).not.toThrow();
    expect(() => direct(other, { admissions: PromoteAdmissionCoordinator.existing(store, GRAPH) })).not.toThrow();
  });

  it('the non-creating lookup finds exactly the coordinator the queue made, and mode off needs none (it never judges a job)', async () => {
    const raw = new OxigraphStore();
    expect(PromoteAdmissionCoordinator.existing(raw, GRAPH)).toBeUndefined();
    const { store: spied, log } = spy(raw);
    const off = createShareRetention({ store: spied, intervalMs: 60_000, now: () => NOW, logger: captureLogger() });      // no mode: off
    expect(off.mode).toBe('off');
    expect(await off.runBatch()).toMatchObject({ skipped: 'off' });
    expect(log).toEqual([]);
    expect(PromoteAdmissionCoordinator.existing(spied, GRAPH)).toBeUndefined();            // creating a sweep (off, or refused) never creates a coordinator
    const queued = new TripleStoreAsyncPromoteQueue(raw, { now: () => NOW });
    expect(queued).toBeDefined();
    expect(PromoteAdmissionCoordinator.existing(raw, GRAPH)).toBe(PromoteAdmissionCoordinator.for(raw, GRAPH));
    expect(() => direct(raw)).not.toThrow();                                               // built after the queue: accepted
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
