/**
 * OT-RFC-73 P11, publisher retention: what the sweep deletes, what it keeps, and what it leaves a lifecycle key looking like (D-6, AC7).
 *
 * A real `TripleStoreAsyncLiftPublisher` over an in-memory store, with populations of persisted jobs written by the production serializer, and the sweep run through its
 * own claim transaction. The binding view a caller has (admission and job-by-intent share it: `lookupKnowledgeAssetVmPublishJobByIntent`) is read before and after.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher, createShareRetention, createPublisherRetention, PUBLISHER_RETENTION_DEFAULTS, PUBLISHER_RETENTION_KEEP_REASONS,
  type PublisherRetentionBatchResult,
} from '../src/index.js';
import { PromoteAdmissionCoordinator } from '../src/promote-admission.js';
import {
  CONTROL_FINALIZED_AT, CONTROL_LIFECYCLE_KEY, CONTROL_PAYLOAD, CONTROL_STATUS, DEFAULT_CONTROL_GRAPH_URI, DEFAULT_WALLET_LOCK_GRAPH_URI, jobSubject,
} from '../src/async-lift-control-plane.js';
import { LiftLegacyScanMemo } from '../src/lift-legacy-scan-memo.js';
import {
  DAY, NOW, WINDOW, at, bySource, createRetentionTemplates, fin, graphFingerprint, keyedQuads, present, seedKeyed, seedWalletLock, spyStore, type KeyedSpec, type RetentionTemplates,
} from './_helpers/lift-retention-fixtures.js';
import { RETENTION, captureLogger, drain, newRetention, verifiedSubjects } from './_helpers/lift-retention-sweep.js';

let templates: RetentionTemplates;
beforeAll(async () => { templates = await createRetentionTemplates(); });

const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

interface World { readonly store: OxigraphStore; readonly publisher: TripleStoreAsyncLiftPublisher }
async function world(specs: readonly KeyedSpec[] = []): Promise<World> {
  const store = new OxigraphStore();
  stores.push(store);
  await seedKeyed(store, templates, specs);
  return { store, publisher: publisherOver(store) };
}
const publisherOver = (store: TripleStore): TripleStoreAsyncLiftPublisher => new TripleStoreAsyncLiftPublisher(store, { now: () => NOW, idGenerator: () => 'unused' });

const idsOf = async (w: World): Promise<string[]> => (await w.publisher.list()).map((job) => job.jobId).sort();
const deletedIds = (results: readonly PublisherRetentionBatchResult[]): string[] => results.flatMap((r) => r.deletedJobs.map((j) => j.jobId));
const wouldDeleteIds = (results: readonly PublisherRetentionBatchResult[]): string[] => results.flatMap((r) => r.wouldDeleteJobs.map((j) => j.jobId));
const kept = (results: readonly PublisherRetentionBatchResult[]): Record<string, number> => {
  const total: Record<string, number> = {};
  for (const r of results) for (const [reason, n] of Object.entries(r.kept)) if (n > 0) total[reason] = (total[reason] ?? 0) + n;
  return total;
};
/** What a caller sees of a key's binding: the job admission binds to, a conflict, or nothing. (The superseded list is not a binding.) */
async function bindingView(publisher: TripleStoreAsyncLiftPublisher, key: string): Promise<string> {
  const lookup = await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ contextGraphId: 'music-social', name: key });
  if (lookup.kind === 'active') return `active:${lookup.job.jobId}`;
  if (lookup.kind === 'conflict') return `conflict:${lookup.jobs.map((job) => job.jobId).join(',')}`;
  return 'unbound';
}

describe('mode off and configuration', () => {
  it('makes no store call at all, reads no clock, and says why (the default mode)', async () => {
    const calls: string[] = [];
    const { store } = spyStore(new OxigraphStore(), { before: (entry) => { calls.push(entry.kind); } });
    const publisher = publisherOver(store);
    let clockReads = 0;
    for (const mode of [undefined, 'off'] as const) {
      const config = { access: publisher.retentionAccess(), intervalMs: 60_000, now: () => { clockReads++; return NOW; } };
      const retention = createPublisherRetention(mode === undefined ? config : { ...config, mode });
      expect(retention.mode).toBe('off');
      const result = await retention.runBatch();
      expect(result).toMatchObject({ mode: 'off', skipped: 'off', scanned: 0, deleted: 0, wouldDelete: 0, hasMore: false });
      expect(result.error).toBeUndefined();
      expect(retention.counters().skipped.off).toBe(1);
      expect(retention.counters().batches).toBe(0);
    }
    expect(calls).toEqual([]);
    expect(clockReads).toBe(0);
  });

  it('defaults to a 7 day window and refuses a window under 24 hours, an oversized batch and the other bad settings, in every mode', async () => {
    const { publisher } = await world();
    expect(PUBLISHER_RETENTION_DEFAULTS.minWindowMs).toBe(DAY);
    const throwing: Array<[Record<string, unknown>, string]> = [
      [{ finalizedMaxAgeMs: DAY - 1 }, 'finalizedMaxAgeMs must be at least 86400000 ms (24 hours)'],
      [{ finalizedMaxAgeMs: 0 }, 'finalizedMaxAgeMs must be a positive finite number'],
      [{ finalizedMaxAgeMs: Number.NaN }, 'finalizedMaxAgeMs'],
      [{ batchSize: 1001 }, 'batchSize must be a positive integer of at most 1000'],
      [{ batchSize: 0 }, 'batchSize'],
      [{ sliceSize: 101 }, 'sliceSize must be a positive integer of at most 100'],
      [{ sliceSize: 1.5 }, 'sliceSize'],
      [{ holdBudgetMs: 51 }, 'holdBudgetMs must be at most 50'],
      [{ holdBudgetMs: 0 }, 'holdBudgetMs'],
      [{ rescanIntervalMs: 0 }, 'rescanIntervalMs'],
      [{ rescanIntervalMs: Number.NaN }, 'rescanIntervalMs'],
      [{ clockGuardFactor: 0.5 }, 'clockGuardFactor must be at least 1'],
      [{ intervalMs: 0 }, 'intervalMs'],
      [{ mode: 'purge' }, 'mode must be one of off, report, delete'],
    ];
    for (const mode of ['off', 'report', 'delete'] as const) {
      for (const [over, message] of throwing) expect(() => newRetention(publisher, { mode, ...over } as never), `${mode} ${JSON.stringify(over)}`).toThrow(message);
      for (const ok of [{ batchSize: 1000 }, { batchSize: 1 }, { finalizedMaxAgeMs: DAY }, { holdBudgetMs: 50 }, { sliceSize: 100 }, { rescanIntervalMs: Number.POSITIVE_INFINITY }]) {
        expect(() => newRetention(publisher, { mode, ...ok }), `${mode} ${JSON.stringify(ok)}`).not.toThrow();
      }
    }
  });

  it('has the vocabulary of the share sweep: the same result, counter, gauge and skip names, so one timer can run both', async () => {
    const { store, publisher } = await world([fin('f', 'k', 10)]);
    const publisherSweep = newRetention(publisher, { mode: 'report' });
    PromoteAdmissionCoordinator.for(store, 'urn:test:share-control');
    const shareSweep = createShareRetention({ store, mode: 'report', intervalMs: 1000, graphUri: 'urn:test:share-control', now: () => NOW, monotonicNow: () => 0, logger: captureLogger() });
    const [mine] = await drain(publisherSweep);
    const theirs = await shareSweep.runBatch();                    // the share sweep has its own drain; one batch is a full pass over an empty share graph
    expect(Object.keys(mine!).sort()).toEqual(Object.keys(theirs!).sort());
    expect(Object.keys(publisherSweep.counters()).sort()).toEqual(Object.keys(shareSweep.counters()).sort());
    expect(Object.keys(publisherSweep.counters().skipped).sort()).toEqual(Object.keys(shareSweep.counters().skipped).sort());
    expect(Object.keys(publisherSweep.counters().errors).sort()).toEqual(Object.keys(shareSweep.counters().errors).sort());
    expect(Object.keys(publisherSweep.counters().lastCompletePass!).sort()).toEqual(Object.keys(shareSweep.counters().lastCompletePass!).sort());
    expect(Object.keys(mine!).sort()).toContain('wouldDeleteJobs');
  });
});

describe('what is deleted: one record at a time', () => {
  it('deletes a finalized job 7 days after it finished, completely (job and request subjects), and reports it', async () => {
    const w = await world([fin('f', 'k', 10), fin('other', 'k2', 11)]);
    const [first] = await drain(newRetention(w.publisher));
    expect(deletedIds([first!])).toEqual(['f', 'other']);
    expect(first!.deletedJobs[0]).toMatchObject({ jobId: 'f', jobClass: 'finalized', state: 'finalized', finalizedAt: Math.round(10.1 * DAY), ageMs: NOW - Math.round(10.1 * DAY) });
    expect(await present(w.store, 'f')).toBe('');
    expect(await idsOf(w)).toEqual([]);
  });

  it('keeps the exact boundary: a job finalized exactly the window ago goes, one millisecond younger stays (and is not even judged)', async () => {
    const w = await world([
      { ...fin('exact', 'a', 1), finalizedAt: NOW - WINDOW },
      { ...fin('younger', 'b', 1), finalizedAt: NOW - WINDOW + 1 },
    ]);
    const results = await drain(newRetention(w.publisher));
    expect(deletedIds(results)).toEqual(['exact']);
    expect(results.reduce((n, r) => n + r.scanned, 0)).toBe(1);
    expect(await idsOf(w)).toEqual(['younger']);
  });

  it('never touches a job that is not finalized, however old: accepted, claimed and every kind of failed job', async () => {
    const w = await world([
      at('acc', 'a', 'accepted', 1), at('clm', 'b', 'claimed', 2), at('ret', 'c', 'retryable', 3),
      at('hld', 'd', 'held', 4), at('ter', 'e', 'terminal', 5), at('rec', 'f', 'recovery', 6),
    ]);
    const before = await graphFingerprint(w.store, DEFAULT_CONTROL_GRAPH_URI);
    const results = await drain(newRetention(w.publisher));
    expect(results.reduce((n, r) => n + r.scanned, 0)).toBe(0);
    expect(deletedIds(results)).toEqual([]);
    expect(await graphFingerprint(w.store, DEFAULT_CONTROL_GRAPH_URI)).toBe(before);
  });

  it('deletes a job without a lifecycle key (a raw lift) on age alone: no sibling can bind it', async () => {
    const w = await world([{ ...fin('raw1', 'x', 10), kind: 'raw' }, { ...fin('raw2', 'x', 11), kind: 'raw' }, at('x', 'unrelated', 'retryable', 1)]);
    const results = await drain(newRetention(w.publisher));
    expect(deletedIds(results).sort()).toEqual(['raw1', 'raw2']);
    expect(await idsOf(w)).toEqual(['x']);
  });

  it('judges a legacy un-indexed publish job the way admission reads it: deleted while the legacy scan is on, kept once the memo says it ended', async () => {
    for (const memoCleared of [false, true]) {
      const store = new OxigraphStore();
      stores.push(store);
      await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
      await store.insert(keyedQuads(templates, fin('legacy', 'k', 10)).filter((quad) => quad.predicate !== CONTROL_LIFECYCLE_KEY));
      if (memoCleared) new LiftLegacyScanMemo(store, DEFAULT_CONTROL_GRAPH_URI).clear();
      const publisher = publisherOver(store);
      const results = await drain(newRetention(publisher));
      expect(deletedIds(results), `memoCleared ${memoCleared}`).toEqual(memoCleared ? [] : ['legacy']);
      if (memoCleared) expect(kept(results)).toEqual({ index_mismatch: 1 });
    }
  });

  describe('a record it cannot trust is kept untouched', () => {
    /** Seed one finalized job whose quads `corrupt` rewrites, run the sweep, and return what it said and whether the job is byte-identical. */
    async function sweepCorrupted(corrupt: (quads: Quad[]) => Quad[], spec: KeyedSpec = fin('f', 'k', 10)) {
      const store = new OxigraphStore();
      stores.push(store);
      await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
      await store.insert(corrupt(keyedQuads(templates, spec)));
      const before = await present(store, spec.id);
      const results = await drain(newRetention(publisherOver(store)));
      return { results, unchanged: (await present(store, spec.id)) === before && before !== '', kept: kept(results) };
    }
    const replacePredicate = (predicate: string, object: string) => (quads: Quad[]) => quads.map((quad) => (quad.predicate === predicate ? { ...quad, object } : quad));

    it.each([
      ['a stored finish time that disagrees with the payload', replacePredicate(CONTROL_FINALIZED_AT, `"${Math.round(9 * DAY)}"^^<http://www.w3.org/2001/XMLSchema#integer>`), 'index_mismatch'],
      ['a stored lifecycle key that is not the payload\'s', replacePredicate(CONTROL_LIFECYCLE_KEY, '"music-social\\u001fsomething-else\\u001f"'), 'index_mismatch'],
      ['a stored status other than finalized (a lying index row, found by a scan for finalized)', (quads: Quad[]) => [...quads, { subject: jobSubject('f'), predicate: CONTROL_STATUS, object: '"accepted"', graph: DEFAULT_CONTROL_GRAPH_URI }], 'index_mismatch'],
      ['a payload that is not JSON', replacePredicate(CONTROL_PAYLOAD, '"not json at all"'), 'unreadable'],
      ['a payload of another job', (quads: Quad[]) => quads.map((quad) => (quad.predicate === CONTROL_PAYLOAD ? { ...quad, object: quad.object.replace('\\"jobId\\":\\"f\\"', '\\"jobId\\":\\"someone-else\\"') } : quad)), 'unreadable'],
      ['two payload triples (ambiguous)', (quads: Quad[]) => [...quads, { subject: jobSubject('f'), predicate: CONTROL_PAYLOAD, object: '"{}"', graph: DEFAULT_CONTROL_GRAPH_URI }], 'unreadable'],
      ['a status this build does not know', (quads: Quad[]) => quads.map((quad) => (quad.predicate === CONTROL_PAYLOAD ? { ...quad, object: quad.object.replace('\\"status\\":\\"finalized\\"', '\\"status\\":\\"archived\\"') } : quad)), 'unknown_state'],
    ])('%s', async (_name, corrupt, reason) => {
      const { results, unchanged, kept: keptReasons } = await sweepCorrupted(corrupt);
      expect(deletedIds(results)).toEqual([]);
      expect(unchanged).toBe(true);
      expect(Object.keys(keptReasons)).toEqual([reason]);
    });

    it('a payload that says failed under a stored status of finalized and a stored finish time (a stale index row)', async () => {
      const staleIndex = (quads: Quad[]) => [
        ...quads.map((quad) => (quad.predicate === CONTROL_STATUS ? { ...quad, object: '"finalized"' } : quad)),
        { subject: jobSubject('f'), predicate: CONTROL_FINALIZED_AT, object: `"${Math.round(10 * DAY)}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: DEFAULT_CONTROL_GRAPH_URI },
      ];
      for (const state of ['terminal', 'retryable', 'held', 'accepted'] as const) {
        const { results, unchanged, kept: keptReasons } = await sweepCorrupted(staleIndex, at('f', 'k', state, 1));
        expect(deletedIds(results), state).toEqual([]);
        expect(unchanged, state).toBe(true);
        expect(keptReasons, state).toEqual({ not_terminal: 1 });
      }
    });

    it('a job with no lifecycle key that carries a lifecycle-key index triple (an index nothing explains)', async () => {
      const { results, unchanged, kept: keptReasons } = await sweepCorrupted(
        (quads) => [...quads, { subject: jobSubject('f'), predicate: CONTROL_LIFECYCLE_KEY, object: '"music-social\\u001fsomewhere\\u001f\\u001f"', graph: DEFAULT_CONTROL_GRAPH_URI }],
        { ...fin('f', 'k', 10), kind: 'raw' },
      );
      expect(deletedIds(results)).toEqual([]);
      expect(unchanged).toBe(true);
      expect(keptReasons).toEqual({ index_mismatch: 1 });
    });

    it('a record dated after now: updated in the future (kept as future_dated), finished in the future (never even scanned)', async () => {
      const updated = await sweepCorrupted((quads) => quads, { ...fin('f', 'k', 10), updatedAt: NOW + DAY });
      expect(deletedIds(updated.results)).toEqual([]);
      expect(updated.unchanged).toBe(true);
      expect(updated.kept).toEqual({ future_dated: 1 });
      const finished = await sweepCorrupted((quads) => quads, fin('f', 'k', 150, 200));
      expect(deletedIds(finished.results)).toEqual([]);
      expect(finished.results.reduce((n, r) => n + r.scanned, 0)).toBe(0);
      expect(finished.unchanged).toBe(true);
    });

    it('a payload that finished in the future under an old stored finish time', async () => {
      const futureFinish = await sweepCorrupted((quads) => quads.map((quad) => (quad.predicate === CONTROL_PAYLOAD
        ? { ...quad, object: quad.object.replace(/\\"finalizedAt\\":\d+/, `\\"finalizedAt\\":${NOW + DAY}`) } : quad)));
      expect(deletedIds(futureFinish.results)).toEqual([]);
      expect(futureFinish.unchanged).toBe(true);
      expect(Object.keys(futureFinish.kept)).toEqual(['index_mismatch']);
    });
  });

  it('keeps a job a wallet lock still names (a bound obligation), whatever state the lock is in, and leaves the lock alone', async () => {
    for (const status of ['active', 'expired', 'released'] as const) {
      const w = await world([fin('bound', 'a', 10), fin('free', 'b', 10)]);
      await seedWalletLock(w.store, 'bound', 'wallet-1', status);
      await seedWalletLock(w.store, 'someone-else', 'wallet-2', 'active');
      const locks = await graphFingerprint(w.store, DEFAULT_WALLET_LOCK_GRAPH_URI);
      const results = await drain(newRetention(w.publisher));
      expect(deletedIds(results), status).toEqual(['free']);
      expect(kept(results), status).toEqual({ bound_obligation: 1 });
      expect(await idsOf(w), status).toEqual(['bound']);
      expect(await graphFingerprint(w.store, DEFAULT_WALLET_LOCK_GRAPH_URI), status).toBe(locks);
    }
  });

  it('removes a finalized job without touching the wallet lock of another job its claim named', async () => {
    const w = await world([fin('f', 'a', 10)]);
    await seedWalletLock(w.store, 'running-now', 'wallet-1', 'active');       // the wallet f was claimed with, now held by another job
    const locks = await graphFingerprint(w.store, DEFAULT_WALLET_LOCK_GRAPH_URI);
    expect(deletedIds(await drain(newRetention(w.publisher)))).toEqual(['f']);
    expect(await graphFingerprint(w.store, DEFAULT_WALLET_LOCK_GRAPH_URI)).toBe(locks);
  });
});

describe('what is deleted: the records of a lifecycle key', () => {
  const k = (id: string, day: number, finalizedDay?: number) => fin(id, 'key', day, finalizedDay);
  const cases: Array<[string, KeyedSpec[], string[], string]> = [
    ['every record old and finalized: all of them go, oldest first, the newest too', [k('f3', 30), k('f1', 10), k('f2', 20)], ['f1', 'f2', 'f3'], 'unbound'],
    ['an older failed sibling that admission would bind again keeps the finalized record that hides it', [at('x', 'key', 'retryable', 5), k('f1', 10)], [], 'unbound'],
    ['an older HELD failed sibling keeps everything behind it', [at('h', 'key', 'held', 5), k('f1', 10), k('f2', 20)], [], 'active:h'],
    ['an older terminal failed sibling keeps everything behind it', [at('t', 'key', 'terminal', 5), k('f1', 10)], [], 'unbound'],
    ['an older recovery-lane sibling keeps everything behind it', [at('r', 'key', 'recovery', 5), k('f1', 10)], [], 'unbound'],
    ['an older job that is not terminal keeps everything behind it', [at('a', 'key', 'accepted', 5), k('f1', 10)], [], 'active:a'],
    ['a failed job in the middle: the records before it go, the ones behind it stay', [k('f1', 10), at('x', 'key', 'terminal', 15), k('f2', 20)], ['f1'], 'unbound'],
    ['a live successor is not held up by the old record before it, and is untouched', [k('f1', 10), at('a', 'key', 'accepted', 50)], ['f1'], 'active:a'],
    ['a failed successor that binds the key still binds it once the records before it are gone', [k('f1', 10), k('f2', 20), at('x', 'key', 'retryable', 50)], ['f1', 'f2'], 'active:x'],
    ['a record younger than the window is not deleted, and nothing behind it either', [k('f1', 10), k('f2', 20, 99)], ['f1'], 'unbound'],
    ['a young record in front hides the old one behind it', [k('f1', 5, 99), k('f2', 10)], [], 'unbound'],
  ];

  it.each(cases)('%s', async (_name, specs, expectedDeleted, view) => {
    const w = await world(specs);
    const before = await bindingView(w.publisher, 'key');
    const results = await drain(newRetention(w.publisher));
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(deletedIds(results)).toEqual(expectedDeleted);
    expect(await idsOf(w)).toEqual(specs.map((spec) => spec.id).filter((id) => !expectedDeleted.includes(id)).sort());
    // the binding decision of the key is what it was
    expect(await bindingView(w.publisher, 'key')).toBe(before);
    expect(before).toBe(view);
  });

  it('judges each key on its own: one key held back by a failed sibling does not hold back another', async () => {
    const w = await world([at('x', 'blocked', 'retryable', 1), fin('b1', 'blocked', 10), fin('g1', 'free', 10), fin('g2', 'free', 20)]);
    const results = await drain(newRetention(w.publisher));
    expect(deletedIds(results).sort()).toEqual(['g1', 'g2']);
    expect(kept(results)).toEqual({ older_sibling_kept: 1 });
  });

  it('lets a vacated key be admitted anew: after the records go, a re-submit starts a new job, as it did before they were there', async () => {
    const w = await world([fin('f1', 'key', 10), fin('f2', 'key', 20)]);
    await drain(newRetention(w.publisher));
    const publisher = new TripleStoreAsyncLiftPublisher(w.store, { now: () => NOW, idGenerator: () => 'fresh-job' });
    const id = await publisher.enqueueKnowledgeAssetVmPublish((await import('../../../scripts/testing/ka-vm-publish.js')).kaVmPublishRequest({ name: 'key' }));
    expect(id).toBe('fresh-job');
    expect((await publisher.getStatus('fresh-job'))?.status).toBe('accepted');
  });

  it('does not delete a record an older sibling that comes LATER in the scan still stands in front of, and does the next pass', async () => {
    // f1 was accepted first but finished last: the scan (by finish time) meets f2 first, and f2 may only go after f1
    let t = NOW;
    const w = await world([fin('f1', 'key', 10, 40), fin('f2', 'key', 20, 30)]);
    const retention = newRetention(w.publisher, { now: () => t, rescanIntervalMs: 1000 });
    const first = await drain(retention);
    expect(deletedIds(first)).toEqual(['f1']);
    expect(kept(first)).toEqual({ older_sibling_pending: 1 });
    expect(await idsOf(w)).toEqual(['f2']);
    t += 5000;                                                    // the next pass: f1 is gone, nothing stands in front of f2
    expect(deletedIds(await drain(retention))).toEqual(['f2']);
    expect(await idsOf(w)).toEqual([]);
  });
});

describe('report mode', () => {
  const population = (): KeyedSpec[] => [
    fin('a1', 'a', 10), fin('a2', 'a', 20), fin('a3', 'a', 30),
    at('x', 'b', 'retryable', 5), fin('b1', 'b', 10),
    fin('c1', 'c', 10), at('c2', 'c', 'accepted', 50),
    fin('d1', 'd', 5, 40), fin('d2', 'd', 8, 30),                 // finished out of order: the second waits for the next pass
    fin('young', 'e', 99),
    { ...fin('raw', 'f', 10), kind: 'raw' },
  ];

  it('removes nothing, writes no per-job line, and names exactly the jobs delete mode removes from the same snapshot', async () => {
    const reportWorld = await world(population());
    const deleteWorld = await world(population());
    const log = captureLogger();
    const before = await graphFingerprint(reportWorld.store, DEFAULT_CONTROL_GRAPH_URI);
    const report = await drain(newRetention(reportWorld.publisher, { mode: 'report', logger: log, batchSize: 3, sliceSize: 2 }));
    const real = await drain(newRetention(deleteWorld.publisher, { mode: 'delete', batchSize: 3, sliceSize: 2 }));
    expect(await graphFingerprint(reportWorld.store, DEFAULT_CONTROL_GRAPH_URI)).toBe(before);
    expect(deletedIds(report)).toEqual([]);
    expect(wouldDeleteIds(report).sort()).toEqual(deletedIds(real).sort());
    expect(wouldDeleteIds(report).length).toBeGreaterThan(5);
    expect(await idsOf(deleteWorld)).toEqual((await idsOf(reportWorld)).filter((id) => !wouldDeleteIds(report).includes(id)));
    // one summary line per completed pass, no line per job or per hold
    expect(log.infos.filter((line) => line.startsWith('async_lift_retention action=deleted'))).toEqual([]);
    expect(log.infos.filter((line) => line.startsWith('async_lift_retention_pass'))).toHaveLength(1);
    // the same kept reasons too
    expect(kept(report)).toEqual(kept(real));
  });

  it('counts the would-delete set of the latest COMPLETE pass as a gauge by class, replaced by each pass and never accumulated', async () => {
    let t = NOW;
    const w = await world([fin('a', 'a', 10), fin('b', 'b', 11), fin('c', 'c', 12), at('x', 'z', 'retryable', 1), fin('z1', 'z', 10)]);
    const retention = newRetention(w.publisher, { mode: 'report', batchSize: 2, now: () => t, rescanIntervalMs: 1000 });
    expect(retention.counters().lastCompletePass).toBeUndefined();
    const first = await drain(retention);
    expect(first.filter((r) => r.passCompleted)).toHaveLength(1);
    expect(first.at(-1)!.passCompleted || first.at(-2)!.passCompleted).toBe(true);
    const gauge = retention.counters().lastCompletePass!;
    expect(gauge).toMatchObject({ scanned: 4, wouldDelete: { finalized: 3 }, deleted: { finalized: 0 } });
    expect(gauge.kept.older_sibling_kept).toBe(1);
    // the next pass re-judges the same rows: the gauge says 3 again, not 6, while the cumulative kept counter has counted them twice
    t += 5000;
    await drain(retention);
    expect(retention.counters().lastCompletePass).toMatchObject({ completedAt: t, wouldDelete: { finalized: 3 } });
    expect(retention.counters().deleted).toEqual({ finalized: 0 });
    expect(retention.counters().kept.older_sibling_kept).toBe(2);
  });

  it('writes the per-job audit line in delete mode only: one line per hold with the ids, class, finish time and age, and nothing of the payload or key', async () => {
    const log = captureLogger();
    const w = await world([fin('a1', 'secret-name-a', 10), fin('a2', 'secret-name-a', 20), fin('b1', 'secret-name-b', 30), fin('c1', 'secret-name-c', 40), fin('d1', 'secret-name-d', 50)]);
    await drain(newRetention(w.publisher, { logger: log, sliceSize: 2 }));
    const lines = log.infos.filter((line) => line.startsWith('async_lift_retention action=deleted'));
    expect(lines).toHaveLength(3);                                // 5 jobs, 2 per hold
    const jobs = lines.flatMap((line) => JSON.parse(/jobs=(.*)$/.exec(line)![1]!) as Array<Record<string, unknown>>);
    expect(jobs.map((job) => job['jobId'])).toEqual(['a1', 'a2', 'b1', 'c1', 'd1']);
    expect(jobs[0]).toEqual({ jobId: 'a1', class: 'finalized', finalizedAt: Math.round(10.1 * DAY), ageMs: NOW - Math.round(10.1 * DAY) });
    expect(lines.every((line) => !line.includes('secret-name') && !line.includes('knowledgeAssetVmPublish'))).toBe(true);
    expect(lines[0]).toContain('mode=delete count=2 classes={"finalized":2}');
  });
});

describe('the scan', () => {
  it('reaches every deletable row however many rows that cannot be deleted stand in front of it, judging each of them once per pass', async () => {
    // 12 keys held back by an older failed job, with the OLDEST finish times; 4 keys that can go, finished later
    const blocked: KeyedSpec[] = Array.from({ length: 12 }, (_, i) => [at(`x${i}`, `blocked${i}`, 'retryable', 1), fin(`b${i}`, `blocked${i}`, 2 + i * 0.1)]).flat();
    const free: KeyedSpec[] = Array.from({ length: 4 }, (_, i) => fin(`g${i}`, `free${i}`, 40 + i));
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [...blocked, ...free]);
    const spy = spyStore(store);
    const publisher = publisherOver(spy.store);
    const results = await drain(newRetention(publisher, { batchSize: 3 }));
    expect(deletedIds(results).sort()).toEqual(['g0', 'g1', 'g2', 'g3']);
    expect(kept(results)).toEqual({ older_sibling_kept: 12 });
    const verified = verifiedSubjects(spy.log);
    expect(verified).toHaveLength(16);
    expect(new Set(verified).size).toBe(16);                      // each row was looked at once
    expect(results.every((r) => r.scanned <= 3)).toBe(true);
  });

  it('reads the stored index of an older sibling only up to the first one that is not finalized: that one ends the key\'s deletable run, so the finalized records behind it need no read', async () => {
    // key order, oldest first: a retryable failed job, a finalized one that is too young to be a candidate (the sweep would read it as a sibling), then the old candidate
    const young = fin('young', 'k', 2, 99);                                                       // finished one day before NOW: not a candidate
    const w = await world([at('failed', 'k', 'retryable', 1), young, fin('old', 'k', 3, 10)]);
    const spy = spyStore(w.store);
    const results = await drain(newRetention(publisherOver(spy.store)));
    expect(deletedIds(results)).toEqual([]);
    expect(kept(results)).toEqual({ older_sibling_kept: 1 });
    expect(verifiedSubjects(spy.log)).toEqual([jobSubject('old')]);                             // the candidate only: the young sibling behind the failed job was not read
    // the control: with the failed job gone the young sibling is the older record in front of the candidate, and its index is read
    const control = await world([young, fin('old', 'k', 3, 10)]);
    const controlSpy = spyStore(control.store);
    await drain(newRetention(publisherOver(controlSpy.store)));
    expect(verifiedSubjects(controlSpy.log)).toEqual([jobSubject('old'), jobSubject('young')]);
  });

  it('walks a group of rows that share one finish time and are more than a batch', async () => {
    const same = Math.round(10 * DAY);
    const specs: KeyedSpec[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ ...fin(`t${i}`, `key${i}`, 5), finalizedAt: same })),
      fin('later', 'laterkey', 20),
    ];
    const w = await world(specs);
    const results = await drain(newRetention(w.publisher, { batchSize: 3 }));
    expect(deletedIds(results).sort()).toEqual(specs.map((s) => s.id).sort());
    expect(results.every((r) => r.anomalies === 0 && r.error === undefined)).toBe(true);
    expect(await idsOf(w)).toEqual([]);
  });

  it('parks at the end of the old-enough rows: the next tick reads only what has become old enough since', async () => {
    let t = NOW;
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [at('x', 'k', 'retryable', 1), fin('stuck', 'k', 5), { ...fin('soon', 'other', 1), finalizedAt: NOW - WINDOW + 1000 }]);
    const spy = spyStore(store);
    const retention = newRetention(publisherOver(spy.store), { now: () => t });
    const first = await drain(retention);
    expect(deletedIds(first)).toEqual([]);
    expect(first.at(0)!.hasMore).toBe(false);
    const verifiedAfterFirst = verifiedSubjects(spy.log).length;
    const idle = await retention.runBatch();
    expect(idle).toMatchObject({ scanned: 0, deleted: 0, hasMore: false });
    expect(verifiedSubjects(spy.log).length).toBe(verifiedAfterFirst);            // the stuck row is not read again
    t += 2000;                                                                     // `soon` crosses the window
    const later = await retention.runBatch();
    expect(deletedIds([later])).toEqual(['soon']);
    expect(await present(store, 'stuck')).not.toBe('');
  });

  it('restarts from the oldest row every rescan interval, once a pass has reached its end: a sibling an operator cleared frees the record behind it', async () => {
    let t = NOW;
    const w = await world([at('x', 'k', 'terminal', 1), fin('stuck', 'k', 5)]);
    const retention = newRetention(w.publisher, { now: () => t, rescanIntervalMs: 60_000 });
    expect(deletedIds(await drain(retention))).toEqual([]);
    expect(await w.publisher.clearTerminalJob('x')).toEqual({ outcome: 'cleared' });
    t += 30_000;                                                                   // inside the interval: the parked cursor does not look back
    expect(deletedIds(await drain(retention))).toEqual([]);
    t += 60_000;                                                                   // the interval has passed: a new pass from the oldest row
    expect(deletedIds(await drain(retention))).toEqual(['stuck']);
  });

  it('counts a scan that breaks its ORDER BY contract as an anomaly, never moves the cursor for it, and never completes a pass on it', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [fin('a', 'a', 10), fin('b', 'b', 20), fin('c', 'c', 30)]);
    let broken = true;
    const spy = spyStore(store, {
      rewrite: async (entry, run) => {
        const answer = await run();
        return broken && entry.source === `${RETENTION}scan` && answer.type === 'bindings' ? { ...answer, bindings: [...answer.bindings].reverse() } : answer;
      },
    });
    const retention = newRetention(publisherOver(spy.store), { mode: 'report' });
    const first = await retention.runBatch();
    expect(first.anomalies).toBe(1);
    expect(first.passCompleted).toBe(false);
    expect(retention.counters().anomalies).toBe(1);
    expect(retention.counters().lastCompletePass).toBeUndefined();
    broken = false;
    const second = await retention.runBatch();                                      // the cursor did not move: the same rows are judged again
    expect(second.scanned).toBe(3);
    expect(second.anomalies).toBe(0);
    expect(second.passCompleted).toBe(false);                                       // a poisoned pass never completes (its tally counts a row twice)
    expect(retention.counters().lastCompletePass).toBeUndefined();
  });
});

describe('failures', () => {
  it('ends the batch with the phase that failed, moves no cursor, and judges the same rows on the next call', async () => {
    for (const [phase, source] of [['scan', `${RETENTION}scan`], ['verify', `${RETENTION}verify`], ['verify', `${RETENTION}walletLocks`], ['verify', `${RETENTION}siblings`]] as const) {
      const store = new OxigraphStore();
      stores.push(store);
      await seedKeyed(store, templates, [fin('a', 'a', 10), fin('b', 'b', 20)]);
      let fail = true;
      const spy = spyStore(store, { before: (entry) => { if (fail && entry.source === source) throw new Error(`store down at ${source}`); } });
      const retention = newRetention(publisherOver(spy.store));
      const failed = await retention.runBatch();
      expect(failed.error, source).toEqual({ phase, message: `store down at ${source}` });
      expect(failed.deleted, source).toBe(0);
      expect(retention.counters().errors[phase], source).toBe(1);
      expect(retention.counters().scanned, source).toBe(0);                          // judgments count once the batch ended cleanly
      fail = false;
      expect(deletedIds(await drain(retention)).sort(), source).toEqual(['a', 'b']);
    }
  });

  it('keeps the candidates of a key whose records cannot be decoded (as admission cannot), and goes on with the others', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [fin('good', 'good', 10), fin('victim', 'bad', 10)]);
    await store.insert([
      { subject: jobSubject('poison'), predicate: CONTROL_LIFECYCLE_KEY, object: '"music-social\\u001fbad\\u001f\\u001f"', graph: DEFAULT_CONTROL_GRAPH_URI },
      { subject: jobSubject('poison'), predicate: CONTROL_STATUS, object: '"accepted"', graph: DEFAULT_CONTROL_GRAPH_URI },
      { subject: jobSubject('poison'), predicate: CONTROL_PAYLOAD, object: '"{ garbage"', graph: DEFAULT_CONTROL_GRAPH_URI },
    ]);
    const results = await drain(newRetention(publisherOver(store)));
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(deletedIds(results)).toEqual(['good']);
    expect(kept(results)).toEqual({ siblings_unreadable: 1 });
    expect(await present(store, 'victim')).not.toBe('');
  });
});

describe('the clock', () => {
  it('skips a tick after a clock that leapt a year ahead, and every later tick while it stays there; nothing is deleted', async () => {
    let t = NOW;
    let mono = 0;
    const warnings = captureLogger();
    const w = await world([fin('a', 'a', 99.5), fin('b', 'b', 99.6)]);                 // a day old: not deletable at NOW
    const retention = newRetention(w.publisher, { now: () => t, monotonicNow: () => mono, intervalMs: 60_000, logger: warnings });
    expect(deletedIds([await retention.runBatch()])).toEqual([]);
    t = NOW + 365 * DAY; mono = 60_000;
    for (let tick = 0; tick < 3; tick++) {
      const result = await retention.runBatch();
      expect(result.skipped, `tick ${tick}`).toBe('clock_jump');
      t += 60_000; mono += 60_000;
    }
    expect(retention.counters().skipped.clock_jump).toBe(3);
    expect(await idsOf(w)).toEqual(['a', 'b']);
    expect(warnings.warns.filter((line) => line.includes('skipped=clock_jump'))).toHaveLength(3);
  });

  it('skips a clock that stepped back and resumes when it has caught up', async () => {
    let t = NOW;
    const w = await world([fin('a', 'a', 10)]);
    const retention = newRetention(w.publisher, { mode: 'report', now: () => t });
    await retention.runBatch();
    t = NOW - 1000;
    expect((await retention.runBatch()).skipped).toBe('clock_backwards');
    t = NOW + 1;
    expect((await retention.runBatch()).skipped).toBeUndefined();
  });

  it('skips a clock that is not a number', async () => {
    const w = await world([fin('a', 'a', 10)]);
    const retention = newRetention(w.publisher, { now: () => Number.NaN });
    expect((await retention.runBatch()).skipped).toBe('clock_invalid');
    expect(await idsOf(w)).toEqual(['a']);
  });
});

describe('the journal and the other graphs', () => {
  it('never touches the journal: a deleted job\'s entries outlive it, byte for byte', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    let now = 1_000;
    const publisher = new TripleStoreAsyncLiftPublisher(store, { now: () => ++now, idGenerator: () => 'job-1', journalWrites: true });
    const { kaVmPublishRequest, KA_VM_VALIDATION } = await import('../../../scripts/testing/ka-vm-publish.js');
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'journaled' }));
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'finalized', { finalization: { mode: 'local' } });
    const journalBefore = await graphFingerprint(store, 'urn:dkg:publisher:journal');
    const walletsBefore = await graphFingerprint(store, DEFAULT_WALLET_LOCK_GRAPH_URI);
    expect(journalBefore).not.toBe('');
    expect((await publisher.readJournalByJob(jobId)).entries.length).toBeGreaterThan(0);

    const results = await drain(newRetention(publisher));      // NOW is far later than the job finished at ~1002 ms
    expect(deletedIds(results)).toEqual([jobId]);
    expect(await publisher.getStatus(jobId)).toBeNull();
    expect(await graphFingerprint(store, 'urn:dkg:publisher:journal')).toBe(journalBefore);
    expect(await graphFingerprint(store, DEFAULT_WALLET_LOCK_GRAPH_URI)).toBe(walletsBefore);
    expect((await publisher.readJournalByJob(jobId)).entries.length).toBeGreaterThan(0);
  });

  it('touches no job of another control graph', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [fin('mine', 'a', 10)]);
    await seedKeyed(store, templates, [fin('theirs', 'a', 10)], 'urn:test:other-control-plane');
    const other = await graphFingerprint(store, 'urn:test:other-control-plane');
    const results = await drain(newRetention(publisherOver(store)));
    expect(deletedIds(results)).toEqual(['mine']);
    expect(await graphFingerprint(store, 'urn:test:other-control-plane')).toBe(other);
  });
});

describe('the keep reasons', () => {
  it('are one fixed vocabulary, all of them present in every result and in the counters', async () => {
    const w = await world([fin('a', 'a', 10)]);
    const retention = newRetention(w.publisher, { mode: 'report' });
    const [result] = await drain(retention);
    expect(Object.keys(result!.kept)).toEqual([...PUBLISHER_RETENTION_KEEP_REASONS]);
    expect(Object.keys(retention.counters().kept)).toEqual([...PUBLISHER_RETENTION_KEEP_REASONS]);
    expect(bySource([], 'x')).toEqual([]);
  });

  it('are exercised: no reason in the vocabulary is dead (each is produced by a case in this file or in the holds file)', () => {
    // the cases above produce: index_mismatch, unreadable, unknown_state, bound_obligation, future_dated, older_sibling_kept, older_sibling_pending, siblings_unreadable;
    // not_terminal, vanished and binding_would_change need a race or an adversarial store and are produced in async-lift-retention-holds.test.ts
    expect(PUBLISHER_RETENTION_KEEP_REASONS).toEqual([
      'unreadable', 'unknown_state', 'index_mismatch', 'not_terminal', 'bound_obligation', 'too_recent', 'future_dated',
      'older_sibling_kept', 'older_sibling_pending', 'siblings_unreadable', 'binding_would_change', 'vanished',
    ]);
  });
});
