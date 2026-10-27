import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PROMOTE_STATE, PROMOTE_UPDATED_AT, PROMOTE_PAYLOAD, jobSubject, literal, integer } from '../src/async-promote-queue-utils.js';
import { buildRetentionScanQuery, buildRetentionTieQuery, buildRetentionVerifyQuery } from '../src/async-promote-retention-scan.js';
import { SHARE_RETENTION_DEFAULTS, createShareRetention, type ShareRetentionBatchResult } from '../src/async-promote-retention.js';
import {
  AG, DELETABLE, GRAPH, LEASE, NOW, NO_MARKERS, POST_COMMIT_ERROR, STARTED, W, WF,
  decide, deletedSubjects, drain, insertQuads, mk, newRetention, pick, present, put, registerPendingFlight, retired, rng, rowOf, spy, storedIds, verifiedSubjects, from,
  captureLogger, policy, standInForTheQueue, type Kind, type Quads, type QueryResult,
} from './_helpers/share-retention-fixtures.js';

// Share-queue retention, the proofs the measured prototype carried (OT-RFC-73 P10a, AC7) on the production API. They pin (1) the exclusion list job by job,
// (2) that no excluded job is ever deleted on randomised stores (independent oracle), (3) bounded, lock-sliced behaviour, (4) that the queue keeps working
// while a sweep runs, (5) that the scan always makes progress: thousands of old rows that can never be deleted neither starve the deletable ones nor are looked
// at again and again (keyset cursor). The prototype's paced driver is not part of the core (the timer is P10b's); its tests are replaced by the overlap and the
// clock-guard tests. The tests that changed with the production policy say so: the SPARQL delete guard is gone (deletes are per subject, under the lock).

describe('retention decision (one job)', () => {
  it('deletes an old succeeded job, an old operator-cancelled job and an old certified no-effect rejection', () => {
    expect(decide(mk('s', 'succeeded'))).toEqual({ delete: true, jobClass: 'succeeded' });
    expect(decide(mk('c', 'failed', { reason: 'cancelled' }))).toEqual({ delete: true, jobClass: 'cancelled' });
    expect(decide(retired('r'))).toEqual({ delete: true, jobClass: 'retired_no_effect' });
  });

  it.each([
    ['queued', mk('q', 'queued'), 'not_terminal'],
    ['running', mk('r', 'running', { lease: LEASE }), 'not_terminal'],
    ['failed_retrying', mk('fr', 'failed_retrying'), 'not_terminal'],
    ['failed bound share without a certified retirement (owns the recovery obligation)', mk('fb', 'failed', { bound: true }), 'unfinished_bound_obligation'],
    ['failed with a post-commit failure (replay budget remaining)', mk('pc', 'failed', { commitMarker: STARTED, attempt: { count: 1, maxRetries: 5, lastError: POST_COMMIT_ERROR } }), 'failed_retained'],
    ['failed with an exhausted post-commit recovery (needs the operator)', mk('ex', 'failed', { reason: 'automatic post-commit recovery exhausted after 5 attempts; needs operator inspection' }), 'failed_retained'],
    ['failed partial-promote ambiguity', mk('amb', 'failed', { reason: 'partial promote ambiguity: lease expired while job was running; needs operator inspection' }), 'failed_retained'],
    ['failed legacy / fatal error', mk('fatal', 'failed', { attempt: { count: 5, maxRetries: 5, lastError: { message: 'boom', retryable: false, classification: 'fatal', recordedAt: 1 } } }), 'failed_retained'],
    ['cancelled-looking row that already started promote', mk('cs', 'failed', { reason: 'cancelled', commitMarker: STARTED }), 'failed_retained'],
    ['written by a newer queue format', mk('nf', 'succeeded', { formatVersion: 5 }), 'newer_format'],
    ['younger than the window', mk('y', 'succeeded', {}, W - 1), 'too_recent'],
    ['updatedAt in the future', mk('fut', 'succeeded', {}, -1000), 'future_dated'],
  ])('keeps %s', (_name, j, reason) => { expect(decide(j as ReturnType<typeof mk>)).toEqual({ delete: false, reason }); });

  it('never deletes a failed job when no benign-failed window is configured, and respects each window exactly at its boundary', () => {
    expect(decide(mk('c', 'failed', { reason: 'cancelled' }), { succeededMaxAgeMs: W })).toEqual({ delete: false, reason: 'failed_retained' });
    expect(decide(mk('e', 'succeeded', {}, W))).toEqual({ delete: true, jobClass: 'succeeded' });
    expect(decide(mk('e', 'succeeded', {}, W - 1))).toEqual({ delete: false, reason: 'too_recent' });
    expect(decide(mk('f', 'failed', { reason: 'cancelled' }, WF))).toEqual({ delete: true, jobClass: 'cancelled' });
    expect(decide(mk('f', 'failed', { reason: 'cancelled' }, WF - 1))).toEqual({ delete: false, reason: 'too_recent' });
  });

  it('keeps a job an uncertain admission still refers to', () => {
    expect(decide(mk('p', 'succeeded'), policy, id => id === 'p')).toEqual({ delete: false, reason: 'pending_admission' });
  });
});

describe('retention batch against the real queue', () => {
  it('scan, tie and verify queries are bounded, ordered by a numeric key and subject-scoped', () => {
    const scan = buildRetentionScanQuery(GRAPH, 'succeeded', NOW - W, 500, { after: 1234, inclusive: false });
    expect(scan).toMatch(/ORDER BY \?updatedAt LIMIT 501$/);                                     // one row more than the batch: "fewer than limit + 1" = end of the region
    expect(scan).toContain(`?job <${PROMOTE_STATE}> "succeeded" ; <${PROMOTE_UPDATED_AT}> ?updatedAt`);
    expect(scan).toContain(`FILTER (?updatedAt <= ${NOW - W})`);
    expect(scan).toContain('FILTER (?updatedAt > 1234)');
    expect(buildRetentionScanQuery(GRAPH, 'failed', NOW - W, 5, { after: 1234, inclusive: true })).toContain('FILTER (?updatedAt >= 1234)');
    expect(buildRetentionScanQuery(GRAPH, 'failed', NOW - W, 5)).not.toContain('FILTER (?updatedAt >');
    const tie = buildRetentionTieQuery(GRAPH, 'succeeded', 42, 10, 'urn:dkg:promote-queue:job:Ab-1');
    expect(tie).toContain('FILTER (?updatedAt = 42)');
    expect(tie).toContain('FILTER (STR(?job) > "urn:dkg:promote-queue:job:Ab-1")');
    expect(tie).toMatch(/ORDER BY STR\(\?job\) LIMIT 11$/);
    const verify = buildRetentionVerifyQuery(GRAPH, [jobSubject('a')]);
    expect(verify).toContain(`VALUES ?job { <${jobSubject('a')}> }`);
    expect(verify).toContain(`OPTIONAL { ?job <${PROMOTE_STATE}> ?state }`);
  });

  it('deletes exactly the eligible jobs, in bounded batches, one verify per lock slice and one per-subject delete per job', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    const old = Array.from({ length: 25 }, (_, i) => mk(`old-${i}`, 'succeeded', {}, 10 * W + i * 7));
    const keep = [mk('young', 'succeeded', {}, 1000), mk('queued', 'queued'), mk('failed-bound', 'failed', { bound: true }), mk('fatal', 'failed', { reason: 'partial promote ambiguity: x' })];
    await put(store, ...old, ...keep);
    const retention = newRetention(spied, { batchSize: 10, sliceSize: 5 });
    const first = await retention.runBatch();
    expect(first).toMatchObject({ scanned: 10, deleted: 10, hasMore: true, anomalies: 0, holds: 2 });
    expect(from(log, 'verify')).toHaveLength(2);                                               // 10 candidates / slices of 5
    expect(deletedSubjects(log)).toHaveLength(10);                                             // one delete per job
    expect(log.filter(l => l.kind === 'update')).toHaveLength(0);                              // never a bulk update
    await drain(retention);
    for (const j of old) expect(await present(store, j.jobId)).toBe('');
    for (const j of keep) expect(await present(store, j.jobId)).not.toBe('');
    expect(await retention.runBatch()).toMatchObject({ deleted: 0, scanned: 0, hasMore: false });
  });

  it('does not need update() and never calls it: a store without the capability gives the same outcome as one that has it', async () => {
    const store = new OxigraphStore();
    let updates = 0;
    const noUpdate = new Proxy(store, { get(t, p) { if (p === 'update') { return undefined; } const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; } });
    const countingUpdate = new Proxy(store, { get(t, p) { if (p === 'update') return async () => { updates++; }; const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; } });
    await put(store, mk('a', 'succeeded', {}, 10 * W), mk('b', 'succeeded', {}, 10 * W + 1), mk('c', 'succeeded', {}, 1));
    const res = await newRetention(noUpdate, { batchSize: 10 }).runBatch();
    expect(res.deleted).toBe(2);
    expect(res.deletedJobs.map(d => d.jobId).sort()).toEqual(['a', 'b']);
    expect(await present(store, 'c')).not.toBe('');
    await put(store, mk('d', 'succeeded', {}, 10 * W));
    expect((await newRetention(countingUpdate, { batchSize: 10 }).runBatch()).deleted).toBe(1);
    expect(updates).toBe(0);
  });

  it('never deletes a job named by an uncertain admission, and deletes it once that admission is settled (the cursor is rewound to it, not to the start)', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await put(store, mk('uncertain', 'succeeded', {}, 20 * W), ...Array.from({ length: 30 }, (_, i) => mk(`fatal-${i}`, 'failed', { reason: 'partial promote ambiguity: x' }, 10 * W + i)), mk('plain', 'succeeded', {}, 5 * W));
    let t = NOW;
    const retention = newRetention(spied, { now: () => t, batchSize: 5 });
    const flight = registerPendingFlight(spied, 'uncertain');
    for (let i = 0; i < 12; i++) await retention.runBatch();                                    // a whole pass: 32 rows, 5 per call
    expect(await present(store, 'plain')).toBe('');
    expect(await present(store, 'uncertain')).not.toBe('');
    t += 6_000;                                                                                 // past the retry delay: the cursor goes back to the pending row, still protected
    const before = verifiedSubjects(log).length;
    for (let i = 0; i < 12; i++) await retention.runBatch();
    expect(await present(store, 'uncertain')).not.toBe('');
    expect(verifiedSubjects(log).length - before).toBe(1);                                       // the cursor went back to the pending row ONLY (the 30 fatal rows were not looked at again)
    flight.clearAll();
    t += 6_000;
    for (let i = 0; i < 12; i++) await retention.runBatch();
    expect(await present(store, 'uncertain')).toBe('');
    expect((await storedIds(store)).size).toBe(30);                                              // the fatal rows are untouched
  });

  it('never deletes a payload it cannot read, an index row without a payload, or a row whose payload disagrees with its index triples (state or age)', async () => {
    const store = new OxigraphStore();
    await put(store, mk('corrupt', 'succeeded', {}, 10 * W), mk('lying-state', 'queued', {}, 10 * W + 1), mk('lying-age', 'succeeded', {}, 100));
    await store.deleteByPattern({ subject: jobSubject('corrupt'), predicate: PROMOTE_PAYLOAD, graph: GRAPH });
    await store.insert([{ subject: jobSubject('corrupt'), predicate: PROMOTE_PAYLOAD, object: literal('{"jobId":"corrupt"}'), graph: GRAPH }]);
    await store.deleteByPattern({ subject: jobSubject('lying-state'), predicate: PROMOTE_STATE, graph: GRAPH });
    await store.insert([{ subject: jobSubject('lying-state'), predicate: PROMOTE_STATE, object: literal('succeeded'), graph: GRAPH }]);
    await store.deleteByPattern({ subject: jobSubject('lying-age'), predicate: PROMOTE_UPDATED_AT, graph: GRAPH });
    await store.insert([{ subject: jobSubject('lying-age'), predicate: PROMOTE_UPDATED_AT, object: integer(1), graph: GRAPH }]);
    await store.insert([{ subject: jobSubject('orphan'), predicate: PROMOTE_STATE, object: literal('succeeded'), graph: GRAPH }, { subject: jobSubject('orphan'), predicate: PROMOTE_UPDATED_AT, object: integer(1), graph: GRAPH }]);
    const before = await Promise.all(['corrupt', 'lying-state', 'lying-age', 'orphan'].map(id => present(store, id)));
    const retention = newRetention(store, { batchSize: 2 });
    const kept: Record<string, number> = {};
    for (let i = 0; i < 6; i++) for (const [k, v] of Object.entries((await retention.runBatch()).kept)) kept[k] = (kept[k] ?? 0) + v;
    expect(await Promise.all(['corrupt', 'lying-state', 'lying-age', 'orphan'].map(id => present(store, id)))).toEqual(before);
    expect(kept).toMatchObject({ unreadable: 1, index_mismatch: 1, too_recent: 1, vanished: 1 });
  });

  it('keeps a row whose stored state triple is missing, doubled or different from its payload (index_mismatch), and a row with two payload triples (unreadable)', async () => {
    const store = new OxigraphStore();
    await put(store, mk('no-state', 'succeeded', {}, 10 * W), mk('two-states', 'succeeded', {}, 10 * W + 1), mk('state-differs', 'succeeded', {}, 10 * W + 2), mk('two-payloads', 'succeeded', {}, 10 * W + 3), mk('control', 'succeeded', {}, 10 * W + 4));
    await store.deleteByPattern({ subject: jobSubject('no-state'), predicate: PROMOTE_STATE, graph: GRAPH });
    await store.insert([{ subject: jobSubject('two-states'), predicate: PROMOTE_STATE, object: literal('failed'), graph: GRAPH }]);
    await store.deleteByPattern({ subject: jobSubject('state-differs'), predicate: PROMOTE_STATE, graph: GRAPH });
    await store.insert([{ subject: jobSubject('state-differs'), predicate: PROMOTE_STATE, object: literal('failed'), graph: GRAPH }]);
    await store.insert([{ subject: jobSubject('two-payloads'), predicate: PROMOTE_PAYLOAD, object: literal(JSON.stringify(mk('two-payloads', 'succeeded', { reason: 'second' }, 10 * W + 3))), graph: GRAPH }]);
    const snapshot = await Promise.all(['no-state', 'two-states', 'state-differs', 'two-payloads'].map(id => present(store, id)));
    const retention = newRetention(store, { batchSize: 3 });
    const total: Record<string, number> = {};
    for (let i = 0; i < 6; i++) for (const [k, v] of Object.entries((await retention.runBatch()).kept)) total[k] = (total[k] ?? 0) + v;
    expect(await Promise.all(['no-state', 'two-states', 'state-differs', 'two-payloads'].map(id => present(store, id)))).toEqual(snapshot);
    expect(await present(store, 'control')).toBe('');
    expect(total['index_mismatch']).toBeGreaterThanOrEqual(2);
    expect(total['unreadable']).toBeGreaterThanOrEqual(1);
  });

  it('keeps a row whose payload names another job than its subject (unreadable), although it is otherwise a deletable job', async () => {
    const store = new OxigraphStore();
    await put(store, mk('subject-1', 'succeeded', {}, 10 * W), mk('control', 'succeeded', {}, 10 * W + 1));
    await store.deleteByPattern({ subject: jobSubject('subject-1'), predicate: PROMOTE_PAYLOAD, graph: GRAPH });
    await store.insert([{ subject: jobSubject('subject-1'), predicate: PROMOTE_PAYLOAD, object: literal(JSON.stringify(mk('other-job', 'succeeded', {}, 10 * W))), graph: GRAPH }]);
    const before = await present(store, 'subject-1');
    const res = await newRetention(store, { batchSize: 10 }).runBatch();
    expect(res.kept.unreadable).toBe(1);
    expect(await present(store, 'subject-1')).toBe(before);
    expect(await present(store, 'control')).toBe('');
  });

  it('a delete removes the triples of its own subject in the control graph and nothing else: the same subject in another graph, other subjects and other graphs survive', async () => {
    const store = new OxigraphStore();
    const OTHER_GRAPH = 'urn:dkg:publisher:journal';
    await put(store, mk('s', 'succeeded'), mk('f', 'failed', { reason: 'cancelled' }), mk('q', 'queued'), mk('bystander', 'succeeded', {}, 1000));
    const foreign = [
      { subject: jobSubject('s'), predicate: 'urn:test:p', object: '"same subject, other graph"', graph: OTHER_GRAPH },
      { subject: 'urn:test:journal:entry-1', predicate: 'urn:test:p', object: '"journal row"', graph: OTHER_GRAPH },
    ];
    await store.insert(foreign);
    const otherBefore = (await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${OTHER_GRAPH}> { ?s ?p ?o } }`) as { bindings: unknown[] }).bindings.length;
    expect(otherBefore).toBe(2);
    const res = await newRetention(store).runBatch();
    expect(res.deletedJobs.map(d => d.jobId).sort()).toEqual(['f', 's']);
    expect([await present(store, 's'), await present(store, 'f')]).toEqual(['', '']);
    for (const id of ['q', 'bystander']) expect(await present(store, id), id).not.toBe('');
    expect(await present(store, 's', OTHER_GRAPH)).not.toBe('');                                  // same subject IRI, other graph: untouched
    expect((await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${OTHER_GRAPH}> { ?s ?p ?o } }`) as { bindings: unknown[] }).bindings.length).toBe(otherBefore);
  });

  it('never interpolates a subject the job-id grammar does not allow: an engine that names one gets it kept as unreadable, never verified or deleted', async () => {
    const store = new OxigraphStore();
    await put(store, mk('good', 'succeeded', {}, 10 * W));
    const evil = 'urn:dkg:promote-queue:job:x> } DROP ALL # <';
    const wrongPrefix = 'urn:dkg:other:job:y';
    const { store: spied, log } = spy(store, async (sparql, source, run) => {
      const result = await run();
      if (source !== 'publisher.asyncPromote.retention.scan' || !sparql.includes('"succeeded"') || result.type !== 'bindings') return result;
      const old = `"${NOW - 100 * W}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
      return { ...result, bindings: [{ job: evil, updatedAt: old }, { job: wrongPrefix, updatedAt: old }, ...result.bindings] } as QueryResult;
    });
    const res = await newRetention(spied, { batchSize: 10 }).runBatch();
    expect(res.kept.unreadable).toBe(2);
    expect(res.deletedJobs.map(j => j.jobId)).toEqual(['good']);
    expect(log.filter(l => l.sparql.includes('DROP ALL') || l.sparql.includes('urn:dkg:other:job:y'))).toEqual([]);
  });

  it('a job another operation re-queues between the scan and the verification survives, the other jobs of the slice are deleted', async () => {
    const store = new OxigraphStore();
    await put(store, mk('a', 'succeeded', {}, 10 * W), mk('revived', 'succeeded', {}, 10 * W + 1), mk('c', 'succeeded', {}, 10 * W + 2));
    let flipped = false;
    const { store: spied } = spy(store, async (_sparql, source, run) => {
      const result = await run();
      if (source === 'publisher.asyncPromote.retention.scan' && !flipped) {
        flipped = true;                                                                         // the scan has named the rows; the revival lands before the slice's verification
        await store.deleteByPattern({ subject: jobSubject('revived'), predicate: PROMOTE_STATE, graph: GRAPH });
        await store.insert([{ subject: jobSubject('revived'), predicate: PROMOTE_STATE, object: literal('queued'), graph: GRAPH }]);
      }
      return result;
    });
    await newRetention(spied, { batchSize: 10 }).runBatch();
    expect(flipped).toBe(true);
    expect(await present(store, 'a')).toBe('');
    expect(await present(store, 'c')).toBe('');
    expect(await present(store, 'revived')).not.toBe('');
  });

  it('caps the batch size at 1000 and floors both windows at 24 hours, so a misconfiguration cannot make one scan huge or shrink the 7-day D-6 window to minutes', () => {
    const DAY = 24 * 3_600_000;
    const store = new OxigraphStore();
    standInForTheQueue(store);
    const base = { store, mode: 'delete' as const, intervalMs: 60_000 };
    expect(SHARE_RETENTION_DEFAULTS).toMatchObject({ batchSize: 100, maxBatchSize: 1000, minWindowMs: DAY });
    for (const batchSize of [1001, 5000, 100_000, Number.MAX_SAFE_INTEGER]) expect(() => createShareRetention({ ...base, batchSize }), `batchSize ${batchSize}`).toThrow(/batchSize must be a positive integer of at most 1000/);
    for (const batchSize of [1, 100, 999, 1000]) expect(() => createShareRetention({ ...base, batchSize }), `batchSize ${batchSize}`).not.toThrow();
    for (const ms of [1, 1000, 60_000, 3_600_000, DAY - 1]) {
      expect(() => createShareRetention({ ...base, succeededMaxAgeMs: ms }), `succeeded ${ms}`).toThrow(/succeededMaxAgeMs must be at least 86400000 ms/);
      expect(() => createShareRetention({ ...base, benignFailedMaxAgeMs: ms }), `benign ${ms}`).toThrow(/benignFailedMaxAgeMs must be at least 86400000 ms/);
    }
    for (const ms of [DAY, DAY + 1, 7 * DAY, 30 * DAY]) expect(() => createShareRetention({ ...base, succeededMaxAgeMs: ms, benignFailedMaxAgeMs: ms }), `window ${ms}`).not.toThrow();
    expect(() => createShareRetention({ ...base, benignFailedMaxAgeMs: null })).not.toThrow();              // failed classes switched off: no window to floor
    expect(() => createShareRetention({ ...base, mode: 'report', succeededMaxAgeMs: 60_000 })).toThrow('succeededMaxAgeMs');   // the floors hold in every active mode
    expect(() => createShareRetention({ ...base, mode: 'report', batchSize: 1001 })).toThrow('batchSize');
  });

  it('a window at the floor behaves as configured: a succeeded job just over 24 hours old goes, one just under stays', async () => {
    const DAY = 24 * 3_600_000;
    const store = new OxigraphStore();
    await put(store, mk('over', 'succeeded', {}, DAY + 1), mk('exact', 'succeeded', {}, DAY), mk('under', 'succeeded', {}, DAY - 1), mk('cancelled-over', 'failed', { reason: 'cancelled' }, DAY + 1), mk('cancelled-under', 'failed', { reason: 'cancelled' }, DAY - 1));
    await drain(newRetention(store, { succeededMaxAgeMs: DAY, benignFailedMaxAgeMs: DAY, batchSize: 10 }));
    expect([...(await storedIds(store))].sort()).toEqual(['cancelled-under', 'under']);
  });

  it('rejects invalid configuration and reports a store failure as data, never as a throw', async () => {
    const store = new OxigraphStore();
    const base = { store, mode: 'delete' as const, intervalMs: 60_000 };
    expect(() => createShareRetention({ ...base, succeededMaxAgeMs: 0 })).toThrow('succeededMaxAgeMs');
    expect(() => createShareRetention({ ...base, benignFailedMaxAgeMs: -1 })).toThrow('benignFailedMaxAgeMs');
    expect(() => createShareRetention({ ...base, batchSize: 0 })).toThrow('batchSize');
    expect(() => createShareRetention({ ...base, sliceSize: 1.5 })).toThrow('sliceSize');
    expect(() => createShareRetention({ ...base, sliceSize: 101 })).toThrow('sliceSize');
    expect(() => createShareRetention({ ...base, rescanIntervalMs: 0 })).toThrow('rescanIntervalMs');
    expect(() => createShareRetention({ ...base, rescanIntervalMs: Number.NaN })).toThrow('rescanIntervalMs');
    expect(() => createShareRetention({ ...base, holdBudgetMs: 51 })).toThrow('holdBudgetMs');
    expect(() => createShareRetention({ ...base, holdBudgetMs: 0 })).toThrow('holdBudgetMs');
    expect(() => createShareRetention({ ...base, intervalMs: 0 })).toThrow('intervalMs');
    expect(() => createShareRetention({ ...base, clockGuardFactor: 0.5 })).toThrow('clockGuardFactor');
    expect(() => createShareRetention({ ...base, graphUri: 'urn:g> } DROP ALL #' })).toThrow('graphUri');
    expect(() => createShareRetention({ ...base, mode: 'purge' as never })).toThrow('mode');
    const broken = new Proxy(new OxigraphStore(), { get(t, p) { if (p === 'query') return async () => { throw new Error('store down'); }; const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; } });
    expect(await newRetention(broken, { batchSize: 5 }).runBatch()).toMatchObject({ scanned: 0, deleted: 0, error: { phase: 'scan', message: 'store down' } });
  });

  it('batches never overlap: a call made while one is in flight reports that and changes nothing, also across two sweeps over the same store and graph', async () => {
    const store = new OxigraphStore();
    await put(store, ...Array.from({ length: 12 }, (_, i) => mk(`o-${i}`, 'succeeded', {}, 10 * W + i)));
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const { store: spied } = spy(store, async (_sparql, source, run) => { if (source === 'publisher.asyncPromote.retention.scan') await gate; return run(); });
    const retention = newRetention(spied, { batchSize: 5 });
    const twin = newRetention(spied, { batchSize: 5 });                                          // a second sweep object over the same store and graph
    const first = retention.runBatch();
    await new Promise(r => setTimeout(r, 5));
    for (const second of [await retention.runBatch(), await twin.runBatch()]) {
      expect(second).toMatchObject({ skipped: 'overlap', scanned: 0, scanQueries: 0, deleted: 0, hasMore: true });
    }
    expect(retention.counters().skipped.overlap).toBe(1);
    release();
    expect(await first).toMatchObject({ scanned: 5, deleted: 5 });
    for (let i = 0; i < 4; i++) await retention.runBatch();                                      // the guard is released afterwards (also after a failed batch: try / finally)
    expect((await storedIds(store)).size).toBe(0);
  });

  it('keeps admitting, claiming and completing work while a sweep runs, and never touches a live job', async () => {
    const store = new OxigraphStore();
    await put(store, ...Array.from({ length: 60 }, (_, i) => mk(`old-${i}`, 'succeeded', {}, 10 * W + i * 3)));
    let t = NOW, n = 0;
    const queue = new TripleStoreAsyncPromoteQueue(store, { now: () => t, idGenerator: () => `live-${++n}` });
    const retention = newRetention(store, { batchSize: 7, sliceSize: 2, now: () => NOW });
    const sweep = (async () => { for (let i = 0; i < 12; i++) await retention.runBatch(); })();
    const live: string[] = [];
    for (let i = 0; i < 6; i++) {
      live.push(await queue.enqueue({ contextGraphId: 'cg', assertionName: `fresh-${i}`, agentAddress: AG, entities: 'all' }));
      const claimed = await queue.claimNext('w');
      if (claimed && i % 2 === 0) { await queue.recordCommitMarker(claimed.jobId, claimed.lease!.claimToken, 'swmInserted'); await queue.succeed(claimed.jobId, claimed.lease!.claimToken, { promotedCount: 1, succeededAt: t }); }
      t += 1000;
    }
    await sweep;
    for (const id of live) expect(await queue.getStatus(id)).not.toBeNull();                 // young (live or just finished): untouched
    expect((await queue.list({})).filter(j => j.jobId.startsWith('old-'))).toHaveLength(0);  // all history swept
  });
});

describe('retention scan progress (keyset cursor): rows that cannot be deleted never starve the ones that can', () => {
  const K = 5000, D = 600;                                                                   // far beyond any in-memory quarantine

  it(`${K} old undeletable rows (fatal / bound failed, newer format, corrupt, orphan index rows, index lying about the state), 2 000 of them OLDER than every deletable row and the rest interleaved with ${D} deletable ones: every deletable row is gone after ceil(M / batch) calls, each row is judged exactly once, and a parked sweep does no more work`, async () => {
    const r = rng(20261903);
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    const undeletableKinds: Kind[] = ['fatal', 'fatal', 'fatal', 'fatal', 'bound', 'bound', 'newer', 'newer', 'corrupt', 'orphan', 'lying'];
    const rows = new Map<string, Kind>();
    const quads: Quads = [];
    let age = 100 * W;
    for (let i = 0; i < 2000; i++) { const kind = pick(r, undeletableKinds), id = `u-${i}`; rows.set(id, kind); quads.push(...rowOf(kind, id, age)); age -= 3; }   // the oldest rows of the store come first
    const rest: Kind[] = [...Array.from({ length: K - 2000 }, () => pick(r, undeletableKinds)), ...Array.from({ length: D }, () => pick(r, ['succeeded', 'succeeded', 'cancelled', 'retired'] as Kind[]))];
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rest[i], rest[j]] = [rest[j]!, rest[i]!]; }
    rest.forEach((kind, i) => { const id = `m-${i}`; rows.set(id, kind); quads.push(...rowOf(kind, id, 2 * W + (rest.length - i) * 5)); });
    await insertQuads(store, quads);
    const M = rows.size, batch = 500;
    expect([...rows.values()].filter(k => !DELETABLE.has(k)).length).toBe(K);
    const before = new Map<string, string>();
    for (const [id, kind] of rows) if (!DELETABLE.has(kind)) before.set(id, await present(store, id));
    const retention = newRetention(spied, { batchSize: batch, sliceSize: 100 });
    const results: ShareRetentionBatchResult[] = [];
    for (let call = 0; call < Math.ceil(M / batch) + 1; call++) results.push(await retention.runBatch());
    for (const res of results) { expect(res.error).toBeUndefined(); expect(res.anomalies).toBe(0); expect(res.scanned).toBeLessThanOrEqual(batch); expect(res.scanQueries).toBeLessThanOrEqual(2); }
    const left = await storedIds(store);
    for (const [id, kind] of rows) {
      if (DELETABLE.has(kind)) expect(left.has(id), `${id} (${kind}) should be deleted`).toBe(false);
      else if (kind !== 'orphan') expect(await present(store, id), `${id} (${kind}) must be untouched`).toBe(before.get(id));
    }
    for (const [id, kind] of rows) if (kind === 'orphan') expect(await present(store, id)).toBe(before.get(id));
    const judged = verifiedSubjects(log);
    expect(new Set(judged).size).toBe(judged.length);                                           // no row was verified twice
    expect(results.reduce((a, x) => a + x.scanned, 0)).toBe(M);                                  // every old row was judged exactly once
    const mark = log.length;
    for (let i = 0; i < 5; i++) expect(await retention.runBatch()).toMatchObject({ scanned: 0, deleted: 0, hasMore: false, scanQueries: 2 });
    expect(log.slice(mark).filter(l => l.source !== 'publisher.asyncPromote.retention.scan')).toHaveLength(0);   // parked: only the two (empty) frontier scans, no verify, no delete
  }, 120_000);

  it('the reviewer reproduction (400 old fatal failed rows in front of 300 eligible succeeded rows, benign window on, batch 100) now deletes all 300 and judges each row once', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    const quads: Quads = [];
    for (let i = 0; i < 400; i++) quads.push(...rowOf('fatal', `fatal-${i}`, 50 * W - i));
    for (let i = 0; i < 300; i++) quads.push(...rowOf('succeeded', `ok-${i}`, 20 * W - i));
    await insertQuads(store, quads);
    const retention = newRetention(spied, { batchSize: 100 });
    for (let i = 0; i < 9; i++) await retention.runBatch();                                    // ceil(700 / 100) + 2
    expect((await storedIds(store)).size).toBe(400);
    const judged = verifiedSubjects(log);
    expect(judged.length).toBe(700);
    expect(new Set(judged).size).toBe(700);
  });

  it('an engine that returns the undeletable rows first (they are the OLDEST rows, so any engine honouring ORDER BY does) is no obstacle at any batch size or lock slice', async () => {
    for (const [batch, slice] of [[1, 1], [7, 3], [64, 64], [1000, 100]] as const) {
      const store = new OxigraphStore();
      const quads: Quads = [];
      for (let i = 0; i < 300; i++) quads.push(...rowOf(i % 3 ? 'fatal' : 'newer', `u-${i}`, 80 * W - i));
      for (let i = 0; i < 40; i++) quads.push(...rowOf('succeeded', `d-${i}`, 20 * W - i));
      await insertQuads(store, quads);
      const retention = newRetention(store, { batchSize: batch, sliceSize: slice });
      for (let call = 0, needed = Math.ceil(340 / batch) + 2; call < needed; call++) await retention.runBatch();
      expect((await storedIds(store)).size, `batch ${batch}`).toBe(300);
    }
  }, 120_000);

  it('rows that share ONE updatedAt (a group larger than a batch, mixed-case and punctuated ids) are walked in key order: all judged once, deletable ones deleted', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    const quads: Quads = [];
    const ids: Array<[string, Kind]> = [];
    for (let i = 0; i < 600; i++) {
      const id = `${pick(rng(i + 1), ['Ab', 'aB', 'a.b', 'A_b', 'a:B', 'z'])}-${i.toString(36)}`;
      const kind: Kind = i % 2 ? 'succeeded' : 'fatal';
      ids.push([id, kind]); quads.push(...rowOf(kind, id, 10 * W));                              // identical updatedAt for all
    }
    quads.push(...rowOf('succeeded', 'older', 12 * W), ...rowOf('succeeded', 'newer-but-old', 9 * W));   // neighbours on both sides of the group
    await insertQuads(store, quads);
    const retention = newRetention(spied, { batchSize: 64, sliceSize: 25 });
    const results: ShareRetentionBatchResult[] = [];
    for (let i = 0; i < 40 && !(results.at(-1) && !results.at(-1)!.hasMore); i++) results.push(await retention.runBatch());
    expect(results.every(x => x.anomalies === 0 && !x.error)).toBe(true);
    const left = await storedIds(store);
    for (const [id, kind] of ids) expect(left.has(id), id).toBe(!DELETABLE.has(kind));
    expect(left.has('older')).toBe(false);
    expect(left.has('newer-but-old')).toBe(false);
    const judged = verifiedSubjects(log);
    expect(new Set(judged).size).toBe(judged.length);
    expect(judged.length).toBe(602);
  });

  it('a parked sweep still picks up rows that become old enough later (the cursor sits at the frontier, not at the end of time), and finds nothing to re-judge behind it', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await insertQuads(store, [...Array.from({ length: 50 }, (_, i) => rowOf('fatal', `f-${i}`, 20 * W + i)), ...rowOf('succeeded', 'a', 15 * W)].flat());
    let t = NOW;
    const retention = newRetention(spied, { now: () => t, batchSize: 40, rescanIntervalMs: Infinity });      // the clock jumps by days below: no safety rescan may restart the walk
    for (let i = 0; i < 3; i++) await retention.runBatch();
    await insertQuads(store, [...rowOf('succeeded', 'b', 30 * 1000), ...rowOf('succeeded', 'c', 10 * 1000)]);      // 30 s and 10 s old: not eligible yet
    expect((await retention.runBatch()).deleted).toBe(0);
    t += W - 20_000;                                                                              // b is now W + 10 s old, c is W - 10 s old
    const mark = verifiedSubjects(log).length;
    expect((await retention.runBatch()).deletedJobs.map(d => d.jobId)).toEqual(['b']);
    t += 20_000;
    expect((await retention.runBatch()).deletedJobs.map(d => d.jobId)).toEqual(['c']);
    expect(verifiedSubjects(log).length - mark).toBe(2);                                          // only the two new rows were judged
  });

  it('a payload younger than its index triple is kept until it ages into the window, then the cursor is rewound to it (and only to it)', async () => {
    const store = new OxigraphStore();
    const { store: spied, log } = spy(store);
    await insertQuads(store, [...Array.from({ length: 20 }, (_, i) => rowOf('newer', `n-${i}`, 30 * W + i)), ...rowOf('succeeded', 'skewed', 10_000)].flat());
    await store.deleteByPattern({ subject: jobSubject('skewed'), predicate: PROMOTE_UPDATED_AT, graph: GRAPH });
    await store.insert([{ subject: jobSubject('skewed'), predicate: PROMOTE_UPDATED_AT, object: integer(NOW - 5 * W), graph: GRAPH }]);       // index: old; payload: 10 s old
    let t = NOW;
    const retention = newRetention(spied, { now: () => t, batchSize: 100, rescanIntervalMs: Infinity });     // the clock jumps by days below: no safety rescan may restart the walk
    const first = await retention.runBatch();
    expect(first.kept.too_recent).toBe(1);
    expect(await present(store, 'skewed')).not.toBe('');
    t += W / 2;
    await retention.runBatch();                                                                   // not due yet (the payload is W / 2 + 10 s old < the window)
    expect(await present(store, 'skewed')).not.toBe('');
    const mark = verifiedSubjects(log).length;
    t += W / 2;                                                                                   // W + 10 s old now
    await retention.runBatch();
    expect(await present(store, 'skewed')).toBe('');
    expect(verifiedSubjects(log).length - mark).toBe(1);                                         // the 20 older newer-format rows sit BEFORE the skewed row: they are not re-judged
  });

  it('rows written behind the cursor (a back-dated clock, a restore) are found by the safety rescan, not before', async () => {
    const store = new OxigraphStore();
    await insertQuads(store, Array.from({ length: 30 }, (_, i) => rowOf(i % 2 ? 'fatal' : 'newer', `f-${i}`, 20 * W + i)).flat());
    let t = NOW;
    const retention = newRetention(store, { now: () => t, batchSize: 100, rescanIntervalMs: 600_000 });
    await retention.runBatch();
    await insertQuads(store, rowOf('succeeded', 'backdated', 90 * W));                           // older than everything the cursor has passed
    t += 300_000;
    expect((await retention.runBatch()).deleted).toBe(0);
    expect(await present(store, 'backdated')).not.toBe('');
    t += 400_000;                                                                                  // > rescanIntervalMs after the first call
    await retention.runBatch();
    await retention.runBatch();
    expect(await present(store, 'backdated')).toBe('');
    expect((await storedIds(store)).size).toBe(30);
  });

  it('a failed batch moves no cursor: the next call judges the same rows again and nothing is lost', async () => {
    const store = new OxigraphStore();
    await insertQuads(store, [...Array.from({ length: 40 }, (_, i) => rowOf('fatal', `f-${i}`, 30 * W + i)), ...Array.from({ length: 20 }, (_, i) => rowOf('succeeded', `s-${i}`, 20 * W + i))].flat());
    let failVerify = 1;
    const { store: spied } = spy(store, async (_sparql, source, run) => { if (source === 'publisher.asyncPromote.retention.verify' && failVerify-- > 0) throw new Error('verify down'); return run(); });
    const retention = newRetention(spied, { batchSize: 30, sliceSize: 10 });
    const res = await retention.runBatch();
    expect(res).toMatchObject({ deleted: 0, error: { phase: 'verify', message: 'verify down' } });
    for (let i = 0; i < 5; i++) await retention.runBatch();
    expect((await storedIds(store)).size).toBe(40);
  });

  it('both scanned classes make progress (alternating priority): a huge succeeded backlog does not starve the failed class, nor the other way round', async () => {
    const store = new OxigraphStore();
    await insertQuads(store, [...Array.from({ length: 1500 }, (_, i) => rowOf('succeeded', `s-${i}`, 20 * W + i)), ...Array.from({ length: 1500 }, (_, i) => rowOf('cancelled', `c-${i}`, 20 * W + 5000 + i))].flat());
    const retention = newRetention(store, { batchSize: 100 });
    const res1 = await retention.runBatch();
    const res2 = await retention.runBatch();
    expect(res1.deletedJobs.concat(res2.deletedJobs).some(d => d.jobClass === 'succeeded')).toBe(true);
    expect(res1.deletedJobs.concat(res2.deletedJobs).some(d => d.jobClass === 'cancelled')).toBe(true);
  });

  it('another policy (windows) judges the rows a narrower one left: a sweep without the benign window never scans the failed class, a wider one does', async () => {
    const store = new OxigraphStore();
    await insertQuads(store, [...rowOf('cancelled', 'c', 20 * W), ...rowOf('succeeded', 's', 20 * W + 1)].flat());
    await newRetention(store, { benignFailedMaxAgeMs: null, batchSize: 10 }).runBatch();           // benign failed deletion off: the cancelled job is not even scanned
    expect(await present(store, 'c')).not.toBe('');
    expect(await present(store, 's')).toBe('');
    await newRetention(store, { batchSize: 10 }).runBatch();
    expect(await present(store, 'c')).toBe('');
  });

  it('an engine that does not honour ORDER BY is detected (anomalies), never moves a cursor on its answer, and still deletes only what is eligible; the same sweep then drains once the engine conforms', async () => {
    const store = new OxigraphStore();
    const quads: Quads = [];
    for (let i = 0; i < 120; i++) quads.push(...rowOf(i % 2 ? 'fatal' : 'newer', `u-${i}`, 90 * W - i));
    for (let i = 0; i < 30; i++) quads.push(...rowOf('succeeded', `d-${i}`, 20 * W - i));
    await insertQuads(store, quads);
    let engine: 'undeletable-first' | 'newest-first' | 'conforming' = 'undeletable-first';
    // the legitimately free order of an UNORDERED scan, adversarially chosen (undeletable rows first, then LIMIT; or newest first), applied to the ORDER BY query
    const adversary = async (sparql: string, source: string | undefined, run: () => Promise<QueryResult>): Promise<QueryResult> => {
      if (engine === 'conforming' || source !== 'publisher.asyncPromote.retention.scan' || !sparql.includes('ORDER BY ?updatedAt')) return run();
      const limit = Number(/LIMIT (\d+)$/.exec(sparql)![1]);
      const all = await store.query(sparql.replace(/ ORDER BY \?updatedAt LIMIT \d+$/, ''));
      if (all.type !== 'bindings') return all;
      const u = (b: Record<string, string>) => Number(/^"?(\d+)/.exec(b['updatedAt']!)![1]);
      const rank = (b: Record<string, string>) => (engine === 'newest-first' ? -u(b) : b['job']!.includes(':job:d-') ? 1 : 0);
      return { type: 'bindings', bindings: [...all.bindings].sort((a, b) => rank(a) - rank(b)).slice(0, limit) } as QueryResult;
    };
    const { store: spied } = spy(store, adversary);
    const retention = newRetention(spied, { batchSize: 20 });
    let anomalies = 0;
    for (const mode of ['undeletable-first', 'newest-first'] as const) {
      engine = mode;
      for (let i = 0; i < 4; i++) { const res = await retention.runBatch(); anomalies += res.anomalies; expect(res.hasMore, mode).toBe(true); }
      expect(anomalies, `the tripwire fired under ${mode}`).toBeGreaterThan(0);
      anomalies = 0;
    }
    for (let i = 0; i < 120; i++) expect(await present(store, `u-${i}`), `u-${i}`).not.toBe('');   // safety is independent of the engine's order
    engine = 'conforming';                                                                           // the engine is fixed: the SAME sweep (same cursors) must still reach every deletable row
    for (let i = 0; i < 12; i++) await retention.runBatch();
    expect((await storedIds(store)).size).toBe(120);
    expect(retention.counters().lastCompletePass).toBeUndefined();                                   // the pass that met the anomaly publishes no summary (its tally counted rows twice)
  });
});

describe('retention safety on randomised stores (independent oracle)', () => {
  it('no excluded job is ever deleted, every eligible one is, nothing else changes (150 cases, all classes, ages around both cutoffs, pending admissions, a clock that advances)', async () => {
    const r = rng(20261702);
    let deleted = 0, kept = 0, delayed = 0;
    for (let c = 0; c < 150; c++) {
      const store = new OxigraphStore();
      const jobs: ReturnType<typeof mk>[] = [];
      for (let i = 0, n = 1 + Math.floor(r() * 14); i < n; i++) {
        const age = pick(r, [10 * W, W + 1, W, W - 1, 1000, -5000, WF, WF - 1]) + (r() < 0.5 ? 0 : i);           // equal ages (ties) and distinct ones
        const kind = pick(r, ['succeeded', 'succeeded', 'queued', 'running', 'failed_retrying', 'failed-plain', 'failed-cancelled', 'failed-bound', 'failed-retired', 'failed-ambiguity', 'newer']);
        jobs.push(kind === 'succeeded' ? mk(`j${i}`, 'succeeded', {}, age) : kind === 'queued' ? mk(`j${i}`, 'queued', {}, age) : kind === 'running' ? mk(`j${i}`, 'running', { lease: LEASE }, age)
          : kind === 'failed_retrying' ? mk(`j${i}`, 'failed_retrying', {}, age) : kind === 'failed-plain' ? mk(`j${i}`, 'failed', {}, age)
          : kind === 'failed-cancelled' ? mk(`j${i}`, 'failed', { reason: 'cancelled' }, age) : kind === 'failed-bound' ? mk(`j${i}`, 'failed', { bound: true }, age)
          : kind === 'failed-retired' ? retired(`j${i}`, age) : kind === 'failed-ambiguity' ? mk(`j${i}`, 'failed', { reason: 'partial promote ambiguity: x' }, age)
          : mk(`j${i}`, 'succeeded', { formatVersion: 5 }, age));
      }
      await put(store, ...jobs);
      const before = new Map<string, string>(); for (const j of jobs) before.set(j.jobId, await present(store, j.jobId));
      const withBenign = r() < 0.7;
      let t = NOW;
      const batchSize = pick(r, [1, 3, 50]), sliceSize = pick(r, [1, 4, 100]);
      const retention = newRetention(store, { now: () => t, batchSize, sliceSize, benignFailedMaxAgeMs: withBenign ? WF : null });
      const pendingIds = new Set(jobs.filter(() => r() < 0.15).map(j => j.jobId));
      const flights = [...pendingIds].map(id => registerPendingFlight(store, id));
      const deletedAt = new Map<string, number>();
      const quiesce = async () => { let quiet = 0; for (let k = 0; k < 300 && quiet < 2; k++) { const res = await retention.runBatch(); for (const d of res.deletedJobs) deletedAt.set(d.jobId, t); quiet = res.scanned === 0 && !res.hasMore ? quiet + 1 : 0; } };
      const eligibleAt = (j: ReturnType<typeof mk>, at: number, honourPending: boolean) => {
        // the oracle: written from the exclusion list, not from the product predicate
        const e = j.attempt.lastError;
        const isRetired = j.state === 'failed' && j.request.recoveryBinding !== undefined && e?.diagnosticCode === 'PROMOTE_NO_EFFECT_REJECTION';
        const bound = j.request.recoveryBinding !== undefined;
        const aged = (max: number) => at - j.updatedAt >= max;
        return (j.formatVersion ?? 0) <= 4 && !(honourPending && pendingIds.has(j.jobId)) && ((j.state === 'succeeded' && aged(W))
          || (withBenign && j.state === 'failed' && aged(WF) && ((isRetired) || (j.reason === 'cancelled' && !bound))));
      };
      await quiesce();                                                                                // phase 1: now = NOW, flights pending
      for (const id of pendingIds) expect(await present(store, id), `pending ${id} must survive`).toBe(before.get(id));
      t = NOW + 6_000; await quiesce();                                                               // phase 2: past the retry delay, flights still pending
      for (const id of pendingIds) expect(await present(store, id), `pending ${id} must still survive`).toBe(before.get(id));
      for (const flight of flights) flight.clear();
      t = NOW + 12_000; await quiesce();                                                              // phase 3: flights settled
      for (const j of jobs) {
        const after = await present(store, j.jobId);
        if (deletedAt.has(j.jobId)) { expect(eligibleAt(j, deletedAt.get(j.jobId)!, false), `${j.jobId} ${j.state} was deleted at +${deletedAt.get(j.jobId)! - NOW} ms but is excluded then`).toBe(true); expect(after).toBe(''); deleted++; }
        else { expect(eligibleAt(j, t, false), `${j.jobId} ${j.state} is eligible at the end but was left behind`).toBe(false); expect(after, `${j.jobId} ${j.state} must be untouched`).toBe(before.get(j.jobId)); kept++; }
        if (deletedAt.has(j.jobId) && deletedAt.get(j.jobId)! > NOW) delayed++;
      }
    }
    expect(deleted).toBeGreaterThan(100);
    expect(kept).toBeGreaterThan(100);
    expect(delayed).toBeGreaterThan(10);                                                               // rows that only became eligible (or unblocked) after the clock moved
  }, 120_000);
});

describe('keep rules the policy adds to the prototype', () => {
  it.each([
    ['a cancelled job that carries a post-commit failure', mk('c1', 'failed', { reason: 'cancelled', attempt: { count: 1, maxRetries: 5, lastError: POST_COMMIT_ERROR } }), 'post_commit_recoverable'],
    ['a cancelled job whose free text asks for manual inspection', mk('c2', 'failed', { reason: 'cancelled', attempt: { count: 1, maxRetries: 5, lastError: { message: 'partial promote ambiguity', retryable: false, classification: 'fatal', recordedAt: 1 } } }), 'failed_retained'],
    ['a cancelled job whose free text is not a string (the predicates throw: kept as unreadable)', mk('c3', 'failed', { reason: 'cancelled', attempt: { count: 1, maxRetries: 5, lastError: { message: 42, retryable: false, classification: 'fatal', recordedAt: 1 } } }), 'unreadable'],
    ['a cancelled job that swm-inserted', mk('c4', 'failed', { reason: 'cancelled', commitMarker: { ...NO_MARKERS, swmInserted: true } }), 'failed_retained'],
    ['a bound cancelled job (it owns a recovery obligation)', mk('c5', 'failed', { reason: 'cancelled', bound: true }), 'unfinished_bound_obligation'],
  ])('keeps %s', (_name, job, reason) => { expect(decide(job as ReturnType<typeof mk>)).toEqual({ delete: false, reason }); });

  it('a job with an unrecognised state string is kept (unknown_state), and the log of a batch names no payload', async () => {
    expect(decide(mk('u', 'archived' as never))).toEqual({ delete: false, reason: 'unknown_state' });
    const store = new OxigraphStore();
    await put(store, mk('s', 'succeeded', { request: { contextGraphId: 'cg', assertionName: 'secret-assertion-name', entities: 'all', agentAddress: AG } }));
    const logger = captureLogger();
    await newRetention(store, { logger }).runBatch();
    expect(logger.infos.join('\n')).not.toContain('secret-assertion-name');
  });

  it('the default windows are the D-6 window of seven days for both classes', async () => {
    const store = new OxigraphStore();
    const day = 24 * 3_600_000;
    await put(store, mk('s6', 'succeeded', {}, 6 * day), mk('s7', 'succeeded', {}, 7 * day), mk('c6', 'failed', { reason: 'cancelled' }, 6 * day), mk('c7', 'failed', { reason: 'cancelled' }, 7 * day),
      mk('r7', 'failed', {}, 30 * day));
    standInForTheQueue(store);                                                                    // no queue is built here; the sweep needs the coordinator its constructor makes
    const retention = createShareRetention({ store, mode: 'delete', intervalMs: 60_000, now: () => NOW, monotonicNow: () => 0, logger: captureLogger() });
    await drain(retention);
    expect([...(await storedIds(store))].sort()).toEqual(['c6', 'r7', 's6']);
  });
});
