/**
 * OT-RFC-73 P11, publisher retention under the claim lock: slices, the hold budget, the flush, and what an admission, a claim, a clear or a failure does to a sweep
 * that is in the middle of a key (AC7: fault injection between sibling deletes, the concurrent-admission test).
 *
 * The sweep judges and deletes inside the queue's claim transaction, a slice at a time. Everything here is about the two things that can go wrong around that: another
 * writer getting in between a judgement and a delete (it cannot: it queues behind the transaction), and the sweep itself stopping half way (it can: every state it can
 * stop in keeps the key's newest record and its binding decision).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { DEFAULT_CONTROL_GRAPH_URI, jobSubject } from '../src/async-lift-control-plane.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import {
  DAY, NOW, at, bySource, createRetentionTemplates, fin, keyedQuads, present, seedKeyed, spyStore, type KeyedSpec, type Logged, type RetentionTemplates, type SpyHooks,
} from './_helpers/lift-retention-fixtures.js';
import { RETENTION, captureLogger, drain, expectKeySuffix, newRetention, removedJobIds, verifiedSubjects } from './_helpers/lift-retention-sweep.js';

let templates: RetentionTemplates;
beforeAll(async () => { templates = await createRetentionTemplates(); });
const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

/** A store with the given population, seen through a recording store, and a publisher over each of the two. */
async function setup(specs: readonly KeyedSpec[], hooks: SpyHooks = {}) {
  const raw = new OxigraphStore();
  stores.push(raw);
  await seedKeyed(raw, templates, specs);
  const spy = spyStore(raw, hooks);
  const mk = (store: OxigraphStore, id = 'adm-1') => new TripleStoreAsyncLiftPublisher(store, { now: () => NOW, idGenerator: () => id, journalWrites: false });
  return { raw, ...spy, publisher: mk(spy.store), other: mk(raw), mk };
}
const ids = (results: ReadonlyArray<{ deletedJobs: ReadonlyArray<{ jobId: string }> }>): string[] => results.flatMap((r) => r.deletedJobs.map((j) => j.jobId));
const kept = (results: ReadonlyArray<{ kept: Readonly<Record<string, number>> }>): Record<string, number> => {
  const total: Record<string, number> = {};
  for (const r of results) for (const [reason, n] of Object.entries(r.kept)) if (n > 0) total[reason] = (total[reason] ?? 0) + n;
  return total;
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/** How `promise` ends within `ms`: its value, its error, or `timedOut` when it is still pending (a wait for a lock that is never released fails the test, it does not hang it). */
const within = async <T>(promise: Promise<T>, ms = 2000): Promise<{ value?: T; error?: unknown; timedOut?: true }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  try { return await Promise.race([promise.then((value) => ({ value }), (error: unknown) => ({ error })), timeout]); } finally { clearTimeout(timer); }
};
const viewOf = async (publisher: TripleStoreAsyncLiftPublisher, key: string): Promise<string> => {
  const lookup = await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ contextGraphId: 'music-social', name: key });
  return lookup.kind === 'active' ? `active:${lookup.job.jobId}` : lookup.kind === 'conflict' ? 'conflict' : 'unbound';
};

describe('slices', () => {
  const distinctKeys = (n: number): KeyedSpec[] => Array.from({ length: n }, (_, i) => fin(`j${i}`, `key${i}`, 10 + i));

  it('verifies, reads the wallet locks and deletes a slice at a time, one subject at a time, and never with a bulk update', async () => {
    const t = await setup(distinctKeys(7));
    const retention = newRetention(t.publisher, { sliceSize: 3 });
    const results = await drain(retention);
    expect(ids(results)).toEqual(distinctKeys(7).map((s) => s.id));
    expect(results.reduce((n, r) => n + r.holds, 0)).toBe(3);
    const verifies = bySource(t.log, `${RETENTION}verify`);
    expect(verifies).toHaveLength(3);
    expect(verifies.map((v) => verifiedSubjects([v]).length)).toEqual([3, 3, 1]);
    expect(bySource(t.log, `${RETENTION}walletLocks`)).toHaveLength(3);
    // two deletes per job (the job subject, then its request subject); no update() of any kind
    expect(t.log.filter((e) => e.kind === 'update')).toEqual([]);
    expect(t.log.filter((e) => e.kind === 'deleteByPatternWithoutCount')).toHaveLength(14);
    expect(removedJobIds(t.log)).toEqual(distinctKeys(7).map((s) => s.id));
    expect(retention.counters()).toMatchObject({ holds: 3, deleted: { finalized: 7 } });
  });

  it('reads each key\'s records once per hold, and not at all for a job with no lifecycle key', async () => {
    const t = await setup([fin('a1', 'a', 10), fin('a2', 'a', 20), fin('b1', 'b', 10), { ...fin('raw', 'c', 10), kind: 'raw' }]);
    await drain(newRetention(t.publisher));
    expect(bySource(t.log, `${RETENTION}siblings`)).toHaveLength(2);                // one hold: key a once, key b once, the raw lift never
  });

  it('releases the claim lock between slices: an admission started during one slice runs before the next slice, never inside the first', async () => {
    let admission: Promise<string> | undefined;
    const events: string[] = [];
    let verifyReads = 0;
    let admitted = false;
    const t = await setup(distinctKeys(6), {
      before: (entry) => {
        if (entry.source === `${RETENTION}verify`) {
          verifyReads += 1;
          events.push(`verify${verifyReads}${admitted ? '+admitted' : ''}`);
          if (verifyReads === 1) admission = t.mk(t.store, 'newcomer').enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'newcomer' }));
        }
        if (entry.source === 'publisher.asyncLift.writeJob') { admitted = true; events.push('admitted'); }   // the admission's own write: it holds the lock here
        if (entry.kind === 'deleteByPatternWithoutCount') events.push('delete');
      },
    });
    const results = await drain(newRetention(t.publisher, { sliceSize: 3 }));
    expect(await admission).toBe('newcomer');
    expect(ids(results)).toHaveLength(6);
    // the first slice (3 jobs, 6 deletes) ran to its end before the admission got the lock; the admission was done before the second slice began
    expect(events.slice(0, 8)).toEqual(['verify1', 'delete', 'delete', 'delete', 'delete', 'delete', 'delete', 'admitted']);
    expect(events).toContain('verify2+admitted');
    expect((await t.other.getStatus('newcomer'))?.status).toBe('accepted');          // untouched: it was never a candidate
  });

  it('flushes the store once per hold that deleted, after the claim transaction is closed and never in report mode', async () => {
    const flushes: string[] = [];
    const raw = new OxigraphStore();
    stores.push(raw);
    (raw as unknown as { flush: () => Promise<void> }).flush = async () => { flushes.push('flush'); };
    await seedKeyed(raw, templates, distinctKeys(5));
    // the first flush is held open until the test lets it go (online review 4395740479)
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let flushStarted!: () => void;
    const flushing = new Promise<void>((resolve) => { flushStarted = resolve; });
    let flushCalls = 0;
    const spy = spyStore(raw, { before: async (entry) => { if (entry.kind === 'flush' && ++flushCalls === 1) { flushStarted(); await gate; } } });
    const publisher = new TripleStoreAsyncLiftPublisher(spy.store, { now: () => NOW, idGenerator: () => 'x' });
    let swept = false;
    const sweep = drain(newRetention(publisher, { sliceSize: 2 })).finally(() => { swept = true; });
    await flushing;
    const other = new TripleStoreAsyncLiftPublisher(raw, { now: () => NOW, idGenerator: () => 'during-flush', journalWrites: false });
    try {
      // while that flush is pending, an admission and then a claim each take the claim lock and complete: the flush holds no lock
      expect(await within(other.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'during-flush' })))).toEqual({ value: 'during-flush' });
      const claimed = await within(other.claimNext('wallet-1'));
      expect(claimed.value?.jobId, JSON.stringify(claimed)).toBe('during-flush');
      expect(swept).toBe(false);                                                  // the sweep is still inside its first flush
      expect(flushes).toEqual([]);
    } finally {
      release();
    }
    await sweep;
    expect(flushes).toHaveLength(3);
    expect((await other.getStatus('during-flush'))?.status).toBe('claimed');
    // report mode and a hold that deleted nothing never flush
    flushes.length = 0;
    const idle = newRetention(publisher, { mode: 'report' });
    await seedKeyed(raw, templates, [fin('r1', 'rk', 10)]);
    await drain(idle);
    expect(flushes).toEqual([]);
  });
});

describe('the hold budget', () => {
  it('stops deleting once the next delete would take the hold past the budget, verifies the rest again later, and shrinks the slice to what fits', async () => {
    let mono = 0;
    const specs = Array.from({ length: 6 }, (_, i) => fin(`j${i}`, `key${i}`, 10 + i));
    const t = await setup(specs, { before: () => { mono += 10; } });         // every store call takes 10 ms
    const retention = newRetention(t.publisher, { monotonicNow: () => mono, sliceSize: 6, holdBudgetMs: 50 });
    const results = await drain(retention);
    expect(ids(results)).toEqual(specs.map((s) => s.id));                      // everything is deleted in the end, oldest first
    expect(results.reduce((n, r) => n + r.holdBudgetExceeded, 0)).toBeGreaterThan(0);
    const counters = retention.counters();
    expect(counters.holdBudgetExceeded).toBeGreaterThan(0);
    expect(counters.sliceSize).toBe(1);                                          // one job per hold is what fits at 4 calls x 10 ms plus the reads
    expect(counters.holds).toBeGreaterThan(2);
    // deferred jobs were verified again under a later hold
    expect(verifiedSubjects(t.log).length).toBeGreaterThan(specs.length);
    // at least one delete per hold: the budget never starves a hold
    for (const r of results) if (r.deleted === 0 && r.holds > 0) expect(r.scanned).toBe(0);
  });

  it('is a budget on the holds, whatever the mode: a report pass under a slow store shrinks its slice and defers nothing', async () => {
    let mono = 0;
    const specs = Array.from({ length: 6 }, (_, i) => fin(`j${i}`, `key${i}`, 10 + i));
    const t = await setup(specs, { before: () => { mono += 40; } });
    const retention = newRetention(t.publisher, { mode: 'report', monotonicNow: () => mono, sliceSize: 6 });
    const results = await drain(retention);
    expect(results.flatMap((r) => r.wouldDeleteJobs).map((j) => j.jobId).sort()).toEqual(specs.map((s) => s.id));
    expect(retention.counters().sliceSize).toBeLessThan(6);
    expect(retention.counters().holdBudgetExceeded).toBeGreaterThan(0);
  });
});

describe('the last line before a delete', () => {
  it('keeps a record that changed between the judgement and the removal, whichever way it changed, and does not delete what follows it in its key', async () => {
    // The removal re-reads the job under its job lock and asks the sweep once more. A writer that holds only that lock (a worker transition, an administrative update) can change a
    // record after the claim-lock judgement: here the first removal's re-read finds the record dated after now (the clock of the judgement was NOW).
    for (const [change, reason] of [
      ['future', 'future_dated'],
      ['young', 'too_recent'],
    ] as const) {
      let touched = false;
      let raw!: OxigraphStore;
      const t = await setup([fin('f1', 'k', 10), fin('f2', 'k', 20), fin('g1', 'other', 10)], {
        before: async (entry) => {
          if (!touched && entry.source === 'publisher.asyncLift.getStatus') {
            touched = true;
            const replacement = keyedQuads(templates, change === 'future'
              ? { ...fin('f1', 'k', 10), updatedAt: NOW + 5 * DAY }
              : { ...fin('f1', 'k', 10), finalizedAt: NOW - DAY, updatedAt: NOW - DAY });
            await raw.deleteByPattern({ subject: jobSubject('f1'), graph: DEFAULT_CONTROL_GRAPH_URI });
            await raw.insert(replacement);
          }
        },
      });
      raw = t.raw;
      const results = await drain(newRetention(t.publisher));
      expect(results.every((r) => r.error === undefined), change).toBe(true);
      expect(kept(results), change).toEqual({ [reason]: 1, older_sibling_pending: 1 });                // f1 changed; f2, behind it in the key, waits
      expect(await t.other.getStatus('f1'), change).not.toBeNull();                     // the changed record stays
      expect(await t.other.getStatus('g1'), change).toBeNull();                         // an unrelated key is not held up
      // and f2, which comes after f1 in its key, is not deleted while f1 stands in front of it (the key is blocked for the rest of the walk)
      expect(await t.other.getStatus('f2'), change).not.toBeNull();
      await t.raw.close();
      stores.splice(stores.indexOf(t.raw), 1);
    }
  });

  it('keeps the records behind a changed one in later batches too, when its finish time moved earlier, behind the cursor, where the scan does not meet it again', async () => {
    // One row per batch. Batch 1 judges f1 alone, and its removal finds the finish time changed: still old enough, but EARLIER than the one the scan judged, so behind
    // the cursor. The holds of the later batches do not have f1 among their candidates, and the plan of the key reads it as an old finalized record in front of f2
    // and f3: only the mark the changed record left on its key keeps f2 and f3 (the key's newest) from going while f1 stays. The next pass meets f1 first.
    let touched = false;
    let raw!: OxigraphStore;
    let clock = NOW;
    const order = ['f1', 'f2', 'f3'];
    const t = await setup([fin('f1', 'k', 10), fin('f2', 'k', 20), fin('f3', 'k', 30)], {
      before: async (entry) => {
        if (!touched && entry.source === 'publisher.asyncLift.getStatus') {
          touched = true;
          await raw.deleteByPattern({ subject: jobSubject('f1'), graph: DEFAULT_CONTROL_GRAPH_URI });
          await raw.insert(keyedQuads(templates, fin('f1', 'k', 10, 10.05)));
        }
      },
    });
    raw = t.raw;
    const left = async (): Promise<string[]> => (await t.other.list()).map((job) => job.jobId);
    const retention = newRetention(t.publisher, { batchSize: 1, now: () => clock, rescanIntervalMs: DAY });
    let batch = 0;
    const suffixAfterEach = (pass: string) => async (res: { error?: unknown }) => {
      expect(res.error, `${pass} batch ${batch}`).toBeUndefined();
      expectKeySuffix(await left(), order, `${pass} batch ${batch++}`);
    };
    const first = await drain(retention, 50, suffixAfterEach('pass 1'));
    expect(touched).toBe(true);
    expect(ids(first)).toEqual([]);
    expect(kept(first)).toEqual({ index_mismatch: 1, older_sibling_pending: 2 });           // f1 changed under the job lock; f2 and f3, a batch each, wait
    expect((await left()).sort()).toEqual(['f1', 'f2', 'f3']);
    clock = NOW + 2 * DAY;
    batch = 0;
    expect(ids(await drain(retention, 50, suffixAfterEach('pass 2')))).toEqual(['f1', 'f2', 'f3']);
  });
});

describe('the last line before a delete: records rewritten under the job lock', () => {
  /** Run a sweep whose first removal finds `replace` stored for f1 (the clock of the judgement was NOW, and the judgement saw an ordinary finalized f1). */
  async function sweepRewritten(replace: KeyedSpec) {
    let touched = false;
    let raw!: OxigraphStore;
    const t = await setup([fin('f1', 'k', 10), fin('f2', 'k', 20), fin('g1', 'other', 10)], {
      before: async (entry) => {
        if (!touched && entry.source === 'publisher.asyncLift.getStatus') {
          touched = true;
          await raw.deleteByPattern({ subject: jobSubject('f1'), graph: DEFAULT_CONTROL_GRAPH_URI });
          await raw.insert(keyedQuads(templates, replace));
        }
      },
    });
    raw = t.raw;
    const results = await drain(newRetention(t.publisher));
    expect(results.every((r) => r.error === undefined)).toBe(true);
    return { t, results };
  }

  it('keeps a record that became a pre-upgrade payload (a compatibility record is never removed), and does not delete what follows it in its key', async () => {
    const { t, results } = await sweepRewritten({ ...fin('f1', 'k', 10), compat: true });
    expect(kept(results)).toEqual({ not_terminal: 1, older_sibling_pending: 1 });          // f1 refused by the transaction itself; f2 waits behind it
    expect(await t.other.getStatus('f1')).not.toBeNull();
    expect(await t.other.getStatus('f2')).not.toBeNull();
    expect(await t.other.getStatus('g1')).toBeNull();
  });

  it('keeps a record whose finish time is no longer the one judged, though it is still old enough, and does not delete what follows it in its key', async () => {
    const { t, results } = await sweepRewritten(fin('f1', 'k', 10, 12));
    expect(kept(results)).toEqual({ index_mismatch: 1, older_sibling_pending: 1 });
    expect(await t.other.getStatus('f1')).not.toBeNull();
    expect(await t.other.getStatus('f2')).not.toBeNull();
    expect(await t.other.getStatus('g1')).toBeNull();
  });
});

describe('batches never overlap', () => {
  it('skips a tick while another batch of the same store and graph is running, even from a second sweep object', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached = false;
    const t = await setup([fin('a', 'a', 10)], { before: async (entry) => { if (entry.source === `${RETENTION}verify` && !reached) { reached = true; await gate; } } });
    const first = newRetention(t.publisher);
    const second = newRetention(t.publisher);
    const running = first.runBatch();
    await tick(); await tick();
    expect(reached).toBe(true);
    const overlapped = await second.runBatch();
    expect(overlapped).toMatchObject({ skipped: 'overlap', hasMore: true, scanned: 0 });
    expect(second.counters().skipped.overlap).toBe(1);
    release();
    expect((await running).deleted).toBe(1);
    expect((await second.runBatch()).skipped).toBeUndefined();                        // the slot is free again
  });
});

describe('fault injection between sibling deletes (AC7)', () => {
  const key = 'k';
  const population = (): KeyedSpec[] => [
    fin('f1', key, 10), fin('f2', key, 20), fin('f3', key, 30), fin('f4', key, 40), at('live', key, 'accepted', 60),
    at('x', 'other', 'retryable', 5), fin('o1', 'other', 10),
  ];
  const order = ['f1', 'f2', 'f3', 'f4'];

  async function remaining(raw: OxigraphStore, publisher: TripleStoreAsyncLiftPublisher) {
    const jobSubjectsLeft: string[] = [];
    for (const id of ['f1', 'f2', 'f3', 'f4', 'live', 'x', 'o1']) {
      const lines = await present(raw, id);
      if (lines.includes(jobSubject(id))) jobSubjectsLeft.push(id);
    }
    return { jobSubjectsLeft, view: await viewOf(publisher, key), otherView: await viewOf(publisher, 'other') };
  }

  /** A store call as two runs are aligned on it: the method and the label its caller gave it. */
  const shape = (entry: Logged): string => `${entry.kind} ${entry.source ?? '-'}`;
  /** The phase a batch names for a failure of `entry`: the flush runs after the claim transaction of a hold that deleted, so the delete phase is still the batch's. */
  const phaseOf = (entry: Logged): 'scan' | 'verify' | 'delete' =>
    entry.source === `${RETENTION}scan` ? 'scan' : entry.source?.startsWith(RETENTION) ? 'verify' : 'delete';

  /** The store calls of a healthy drain over the population: each injected run is the same drain, aligned with this one call by call. */
  async function baselineCalls(): Promise<Logged[]> {
    const t = await setup(population());
    expect((await drain(newRetention(t.publisher))).every((r) => r.error === undefined)).toBe(true);
    return [...t.log];
  }

  it('fails the run at EVERY store call of a healthy run in turn and leaves, each time and whatever the result says, an oldest-first prefix of the key gone, its newest record and live successor there, and every binding as it was; the failure is reported (online review 4396942221)', async () => {
    const baseline = await baselineCalls();
    expect(baseline.length).toBeGreaterThan(15);
    let exercised = 0;
    for (let failAt = 0; failAt < baseline.length; failAt++) {
      const where = `call ${failAt} (${shape(baseline[failAt]!)})`;
      // the store wrapper records the call it failed: whether the fault fired is known without asking the sweep's result
      let n = 0;
      const fault: { fired?: Logged } = {};
      const t = await setup(population(), { before: (entry) => { if (n++ === failAt) { fault.fired = entry; throw new Error(`injected at call ${failAt}`); } } });
      const results = await drain(newRetention(t.publisher));
      // the run made the healthy run's calls up to the faulted one: a call the run never reached fails here, it is not skipped as a run without an error
      expect(fault.fired, `${where}: the fault fired`).toBeDefined();
      expect(t.log.slice(0, failAt + 1).map(shape), `${where}: aligned with the healthy run`).toEqual(baseline.slice(0, failAt + 1).map(shape));
      exercised += 1;
      // checked after every fault, before the result is read: a sweep that swallowed the failure and went on deleting fails here
      const { jobSubjectsLeft, view, otherView } = await remaining(t.raw, t.other);
      expect(jobSubjectsLeft.includes('live'), `${where}: the live successor`).toBe(true);
      expect(jobSubjectsLeft.includes('x'), `${where}: the failed sibling`).toBe(true);
      expect(jobSubjectsLeft.includes('o1'), `${where}: the record an older failed job hides`).toBe(true);
      // nothing but a finalized job of the key was ever removed; what is gone is a prefix of the oldest-first order
      expectKeySuffix(jobSubjectsLeft, order, where);
      // the binding decisions of both keys are what they were, whatever stage the sweep stopped in
      expect(view, where).toBe('active:live');
      expect(otherView, where).toBe('unbound');
      // the failure surfaced: the batch that made the call ends with it, in that call's phase, after clean batches, and no store call follows it
      expect(results.at(-1)!.error, `${where}: the failure is reported`).toEqual({ phase: phaseOf(fault.fired!), message: `injected at call ${failAt}` });
      expect(results.slice(0, -1).every((r) => r.error === undefined), `${where}: no earlier batch failed`).toBe(true);
      expect(t.log.length, `${where}: no store call after the failed one`).toBe(failAt + 1);
      // and the next, healthy run finishes the key
      const rest = await drain(newRetention(t.other));
      expect(rest.every((r) => r.error === undefined)).toBe(true);
      const after = await remaining(t.raw, t.other);
      expect(after.jobSubjectsLeft.sort(), `${where}: after the retry`).toEqual(['live', 'o1', 'x']);
      expect(after.view).toBe('active:live');
    }
    expect(exercised).toBe(baseline.length);
  });

  it('reports a failure of a job\'s second delete as an unknown outcome, never as a clean batch: the job subject is gone, the request subject may remain, the next sweep ends it', async () => {
    let jobDeleted = false;
    const log = captureLogger();
    const t = await setup([fin('f1', key, 10), fin('f2', key, 20), at('live', key, 'accepted', 60)], {
      before: (entry) => {
        if (entry.source === 'publisher.asyncLift.deleteJob') jobDeleted = true;
        if (entry.source === 'publisher.asyncLift.deleteJobRequest' && jobDeleted) throw new Error('request delete failed');
      },
    });
    const result = await newRetention(t.publisher, { logger: log }).runBatch();
    expect(result.error).toEqual({ phase: 'delete', message: 'request delete failed' });
    expect(log.warns.some((line) => line.includes('delete_outcome_unknown jobId=f1'))).toBe(true);
    expect(await present(t.raw, 'f1')).toContain('lift-request:f1');                // the orphan request subject
    expect(await present(t.raw, 'f1')).not.toContain(`${jobSubject('f1')} `);       // the job subject is gone
    expect(await viewOf(t.other, key)).toBe('active:live');
  });
});

describe('an admission, a claim or a clear that meets a sweep (AC7: the concurrent-admission test)', () => {
  it('queues an admission behind the hold that has already read its key, and then admits it against the key as the sweep left it', async () => {
    let gate!: () => void;
    const held = new Promise<void>((resolve) => { gate = resolve; });
    let admission: Promise<string> | undefined;
    let admitted = false;
    let deletesBeforeAdmission = 0;
    const t = await setup([fin('f1', 'key', 10), fin('f2', 'key', 20)], {
      before: async (entry) => {
        if (entry.source === `${RETENTION}siblings`) {                          // inside the hold: the sweep has judged the key and is about to delete
          admission = t.mk(t.raw, 'successor').enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'key' })).then((id) => { admitted = true; return id; });
          await tick();
          await held;
        }
        if (entry.kind === 'deleteByPatternWithoutCount' && !admitted) deletesBeforeAdmission += 1;
      },
    });
    const sweep = newRetention(t.publisher).runBatch();
    await tick(); await tick();
    expect(admission).toBeDefined();
    expect(admitted).toBe(false);                                                // the admission is queued behind the sweep's claim transaction
    gate();
    const result = await sweep;
    expect(result.deleted).toBe(2);
    expect(await admission).toBe('successor');
    expect(deletesBeforeAdmission).toBe(4);                                       // all four deletes happened while the admission waited
    expect((await t.other.getStatus('successor'))?.status).toBe('accepted');
    expect(await viewOf(t.other, 'key')).toBe('active:successor');
    expect(await t.other.getStatus('f1')).toBeNull();
    expect(await t.other.getStatus('f2')).toBeNull();
  });

  it('never deletes a job a new admission has just made non-terminal, or the finalized record that one needs: an admission between two slices is seen by the second', async () => {
    // key m: f1 (deleted by slice 1), f2 (slice 2). Between the slices a newcomer for the same key is admitted: f2 goes, the newcomer stays and binds.
    let verifyReads = 0;
    let admission: Promise<string> | undefined;
    const t = await setup([fin('f1', 'm', 10), fin('f2', 'm', 20), at('x', 'n', 'retryable', 5), fin('g1', 'n', 10)], {
      before: (entry) => {
        if (entry.source === `${RETENTION}verify` && ++verifyReads === 1) {
          admission = t.mk(t.raw, 'newcomer').enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'm' }));
        }
      },
    });
    const results = await drain(newRetention(t.publisher, { sliceSize: 1 }));
    expect(await admission).toBe('newcomer');
    expect(ids(results).sort()).toEqual(['f1', 'f2']);
    expect((await t.other.getStatus('newcomer'))?.status).toBe('accepted');
    expect(await viewOf(t.other, 'm')).toBe('active:newcomer');
    expect(await t.other.getStatus('g1')).not.toBeNull();                          // the record an older failed job hides is untouched
  });

  it('keeps the binding of a key when an admission between two slices reaccepts the failed job that binds it', async () => {
    // key n: g1 (finalized, finished last) then x (retryable, binds the key). key p goes first (slice 1). Re-submitting n during slice 1 reaccepts x before slice 2.
    let verifyReads = 0;
    let resubmit: Promise<string> | undefined;
    const t = await setup([fin('p1', 'p', 10), fin('p2', 'p', 20), fin('g1', 'n', 5, 40), at('x', 'n', 'retryable', 30)], {
      before: (entry) => {
        if (entry.source === `${RETENTION}verify` && ++verifyReads === 1) resubmit = t.mk(t.raw, 'unused').enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'n' }));
      },
    });
    expect(await viewOf(t.other, 'n')).toBe('active:x');
    const results = await drain(newRetention(t.publisher, { sliceSize: 2 }));
    expect(await resubmit).toBe('x');                                                // reaccepted, not replaced
    expect(ids(results)).toEqual(['p1', 'p2', 'g1']);
    expect((await t.other.getStatus('x'))?.status).toBe('accepted');               // the reaccepted job was never touched
    expect(await viewOf(t.other, 'n')).toBe('active:x');
  });

  it('queues a claim behind the hold, and the job it claims is untouched', async () => {
    let claim: Promise<unknown> | undefined;
    let verifyReads = 0;
    const t = await setup([fin('f1', 'old', 10), fin('f2', 'old', 20), at('a', 'live', 'accepted', 50)], {
      before: (entry) => {
        if (entry.source === `${RETENTION}verify` && ++verifyReads === 1) claim = t.other.claimNext('wallet-1');
      },
    });
    const results = await drain(newRetention(t.publisher));
    expect(ids(results)).toEqual(['f1', 'f2']);
    const claimed = await claim as { jobId: string } | null;
    expect(claimed?.jobId).toBe('a');
    expect((await t.other.getStatus('a'))?.status).toBe('claimed');
  });

  it('waits for an admission that is in flight, which holds the claim lock: the sweep reads nothing until it has finished', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reachedLock = false;
    const t = await setup([fin('f1', 'key', 10)], {
      before: async (entry) => {
        if (entry.source === 'publisher.asyncLift.findActiveVmPublish' && !reachedLock) { reachedLock = true; await gate; }
      },
    });
    const admission = t.publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'inflight' }));
    await tick(); await tick();
    expect(reachedLock).toBe(true);
    const sweep = newRetention(t.publisher).runBatch();
    await tick(); await tick();
    expect(bySource(t.log, `${RETENTION}verify`)).toEqual([]);                   // the scan may run (no lock); nothing is judged or deleted
    expect(await present(t.raw, 'f1')).not.toBe('');
    release();
    await admission;
    const result = await sweep;
    expect(result.deleted).toBe(1);
    expect((await t.other.getStatus('adm-1'))?.status).toBe('accepted');
  });

  it('finds a job a concurrent bulk clear removed between two slices gone, counts it as vanished, and carries on without an error', async () => {
    let verifyReads = 0;
    let clear: Promise<number> | undefined;
    const t = await setup([fin('a', 'ka', 10), fin('b', 'kb', 20), fin('c', 'kc', 30), fin('d', 'kd', 40)], {
      before: (entry) => {
        if (entry.source === `${RETENTION}verify` && ++verifyReads === 1) clear = t.mk(t.raw).clear('finalized');
      },
    });
    const results = await drain(newRetention(t.publisher, { sliceSize: 2 }));
    expect(results.every((r) => r.error === undefined)).toBe(true);
    const cleared = await clear!;
    expect(ids(results).length + cleared).toBe(4);
    expect(results.reduce((n, r) => n + r.kept.vanished, 0)).toBe(cleared);
    expect(await t.other.list()).toEqual([]);
  });

  it('does not delete the record a bulk clear keeps for the same reason: both apply the sibling rule, whichever gets there first', async () => {
    const t = await setup([at('x', 'k', 'retryable', 5), fin('f', 'k', 10)]);
    const [swept, cleared] = await Promise.all([drain(newRetention(t.publisher)), t.other.clear('finalized')]);
    expect(ids(swept)).toEqual([]);
    expect(cleared).toBe(0);
    expect(await t.other.getStatus('f')).not.toBeNull();
  });
});

describe('what a sweep does not do to the claim machinery', () => {
  it('runs on a paused publisher without resuming it, and leaves the wallet-lock graph alone', async () => {
    const t = await setup([fin('a', 'a', 10), fin('b', 'b', 20)]);
    const control = t.other.claimControl;
    await control.hold();
    expect(control.state).toBe('held');
    const locksBefore = t.log.length;
    const results = await drain(newRetention(t.publisher));                        // a paused publisher still lets maintenance run
    expect(ids(results)).toEqual(['a', 'b']);
    expect(control.state).toBe('held');
    expect(t.log.slice(locksBefore).filter((e) => e.kind === 'insert' || e.kind === 'replaceSubject' || e.kind === 'replaceSubjectAndInsert')).toEqual([]);
    await control.release();
    expect(control.state).toBe('running');
  });
});
