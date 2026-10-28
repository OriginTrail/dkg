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
  CONTROL_FINALIZED_AT, CONTROL_LIFECYCLE_KEY, CONTROL_PAYLOAD, CONTROL_STATUS, DEFAULT_CONTROL_GRAPH_URI, DEFAULT_WALLET_LOCK_GRAPH_URI, jobSubject, requestSubject, serializeJob,
} from '../src/async-lift-control-plane.js';
import { decodeLiftJobPayload } from '../src/lift-job-payload-codec.js';
import type { LiftJob } from '../src/lift-job.js';
import { LIFT_JOB_SUBJECT_PREFIX, buildLiftRetentionScanQuery, buildLiftRetentionTieQuery } from '../src/async-lift-retention-scan.js';
import { LiftLegacyScanMemo } from '../src/lift-legacy-scan-memo.js';
import { LiftJobPayloadUnreadableError } from '../src/lift-job-payload-unreadable.js';
import { LiftJobStoreSelectors, lifecycleKeyOfJob, parseInventoryPayload } from '../src/lift-job-store-selectors.js';
import { bindingJobIds } from '../src/async-lift-lifecycle-siblings.js';
import {
  DAY, NOW, WINDOW, at, bySource, createRetentionTemplates, fin, graphFingerprint, keyedQuads, present, seedKeyed, seedWalletLock, spyStore, stampKeyed, type KeyedSpec, type RetentionTemplates,
} from './_helpers/lift-retention-fixtures.js';
import { RETENTION, captureLogger, drain, newRetention, removedJobIds, verifiedSubjects } from './_helpers/lift-retention-sweep.js';

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
      ['a second stored lifecycle key next to the payload\'s (online review 4395740472)', (quads: Quad[]) => [...quads, { subject: jobSubject('f'), predicate: CONTROL_LIFECYCLE_KEY, object: '"music-social\\u001fsomething-else\\u001f"', graph: DEFAULT_CONTROL_GRAPH_URI }], 'index_mismatch'],
      ['the same second key stored before the payload\'s (the engine returns the bindings in the other order)', (quads: Quad[]) => [{ subject: jobSubject('f'), predicate: CONTROL_LIFECYCLE_KEY, object: '"music-social\\u001fsomething-else\\u001f"', graph: DEFAULT_CONTROL_GRAPH_URI }, ...quads], 'index_mismatch'],
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

describe('finish times a JS number cannot hold exactly, and repeated rows (online review round 1: 4394031868, 4394031890)', () => {
  // The cursor holds a JS number and the engine compares terms exactly. Before the scan read `xsd:integer` finish times only, a decimal that a double rounds
  // (`100.0000000000000001`) came back after a cursor at 100 forever, and a job indexed at 100 and 100.0 came back twice in the tie walk at 100: either was an anomaly on every
  // call, and the job at 200 behind it was never reached. The retained record J is a finalized job of its own key whose finish-time index the case writes; E, at 200, can go.
  const XSD = 'http://www.w3.org/2001/XMLSchema#';
  const int = (n: number) => `"${n}"^^<${XSD}integer>`;
  const dec = (lexical: string) => `"${lexical}"^^<${XSD}decimal>`;
  const J: KeyedSpec = { id: 'J', key: 'kj', state: 'finalized', acceptedAt: 50, finalizedAt: 100 };
  const E: KeyedSpec = { id: 'E', key: 'ke', state: 'finalized', acceptedAt: 150, finalizedAt: 200 };
  const withFinishTerms = (spec: KeyedSpec, terms: readonly string[]): Quad[] =>
    keyedQuads(templates, spec).flatMap((quad) => (quad.predicate === CONTROL_FINALIZED_AT ? terms.map((object) => ({ ...quad, object })) : [quad]));
  /** At most `max` calls, stopping when the pass is over or a call failed. */
  const calls = async (retention: ReturnType<typeof newRetention>, max = 6): Promise<PublisherRetentionBatchResult[]> => {
    const results: PublisherRetentionBatchResult[] = [];
    for (let i = 0; i < max; i++) { const res = await retention.runBatch(); results.push(res); if (!res.hasMore || res.error) break; }
    return results;
  };
  const CASES: ReadonlyArray<{ label: string; terms: string[]; judgedJ: number }> = [
    { label: 'J indexed at the integer 100 and the decimal 100.0 (equal in every engine)', terms: [int(100), dec('100.0')], judgedJ: 1 },
    { label: 'J indexed at the decimals 100.0000000000000001 and 100.0000000000000002 (both 100 as doubles)', terms: [dec('100.0000000000000001'), dec('100.0000000000000002')], judgedJ: 0 },
    { label: 'J indexed at two integers, 100 and 300', terms: [int(100), int(300)], judgedJ: 2 },
    { label: 'J indexed at the decimal 100.0000000000000001 alone (the review\'s repro)', terms: [dec('100.0000000000000001')], judgedJ: 0 },
  ];

  it.each(CASES.flatMap((c) => (['delete', 'report'] as const).map((mode) => [c.label, mode, c] as const)))('%s, %s mode: J stays untouched, E behind it is reached, the pass completes in at most 3 calls at batch size 1 and 2, no anomaly', async (_label, mode, c) => {
    for (const batchSize of [1, 2]) {
      const store = new OxigraphStore();
      stores.push(store);
      await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
      await store.insert([...withFinishTerms(J, c.terms), ...keyedQuads(templates, E)]);
      const before = await present(store, 'J');
      const retention = newRetention(publisherOver(store), { mode, batchSize });
      const results = await calls(retention);
      const where = `batch size ${batchSize}: ${results.length} calls, anomalies ${results.map((r) => r.anomalies).join(',')}`;
      expect(results.at(-1)!.hasMore, where).toBe(false);
      expect(results.length, where).toBeLessThanOrEqual(3);
      expect(results.every((r) => r.anomalies === 0 && r.error === undefined), where).toBe(true);
      expect(results.filter((r) => r.passCompleted), where).toHaveLength(1);
      expect(mode === 'delete' ? deletedIds(results) : wouldDeleteIds(results), where).toEqual(['E']);
      expect(mode === 'delete' ? wouldDeleteIds(results) : deletedIds(results), where).toEqual([]);
      expect(await present(store, 'J'), where).toBe(before);
      // a J the scan can read (it has an integer finish time) is judged at each one an answer holds, and kept: its index does not match its one payload; one it cannot read is not a candidate at all
      expect(kept(results), where).toEqual(c.judgedJ > 0 ? { index_mismatch: c.judgedJ } : {});
      expect(results.reduce((n, r) => n + r.scanned, 0), where).toBe(1 + c.judgedJ);
      expect(retention.counters().lastCompletePass, where).toMatchObject(mode === 'delete' ? { deleted: { finalized: 1 }, wouldDelete: { finalized: 0 } } : { deleted: { finalized: 0 }, wouldDelete: { finalized: 1 } });
    }
  });

  it.each(['delete', 'report'] as const)('%s mode: an engine that answers one subject twice (two integer forms of one value, "100" and "0100", which Oxigraph merges, so the repeat is made on its answer) judges it once and reaches the job behind it', async (mode) => {
    // J is retained by a wallet lock, so neither mode removes it. Batch size 1: the window of the range scan is J twice, so the walk enters the tie at 100, whose answer is J twice too.
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [J, E]);
    await seedWalletLock(store, 'J', 'wallet-1', 'released');
    const before = await present(store, 'J');
    const served: string[][] = [];
    const spy = spyStore(store, {
      rewrite: async (entry, run) => {
        if (entry.source !== `${RETENTION}scan`) return run();
        const all = await store.query(entry.text.replace(/ LIMIT \d+$/, ''));
        if (all.type !== 'bindings') return all;
        const bindings = all.bindings.flatMap((b) => (b['job'] === jobSubject('J') ? [b, b] : [b])).slice(0, Number(/LIMIT (\d+)$/.exec(entry.text)![1]));
        served.push(bindings.map((b) => String(b['job']).slice(jobSubject('').length)));
        return { ...all, bindings };
      },
    });
    const retention = newRetention(publisherOver(spy.store), { mode, batchSize: 1 });
    const results = await calls(retention);
    const where = `${results.length} calls, anomalies ${results.map((r) => r.anomalies).join(',')}, served ${JSON.stringify(served)}`;
    expect(served.some((ids) => ids.length === 2 && ids[0] === 'J' && ids[1] === 'J'), `the engine repeated J (${where})`).toBe(true);
    expect(results.at(-1)!.hasMore, where).toBe(false);
    expect(results.length, where).toBeLessThanOrEqual(4);
    expect(results.every((r) => r.anomalies === 0 && r.error === undefined), where).toBe(true);
    expect(results.filter((r) => r.passCompleted), where).toHaveLength(1);
    expect(verifiedSubjects(spy.log), where).toEqual([jobSubject('J'), jobSubject('E')]);            // each judged once, in order
    expect(kept(results), where).toEqual({ bound_obligation: 1 });
    expect(mode === 'delete' ? deletedIds(results) : wouldDeleteIds(results), where).toEqual(['E']);
    expect(await present(store, 'J'), where).toBe(before);
  });
});

describe('subjects that are not publisher jobs cannot stall a pass (verification of online review round 1: the share scan\'s subject filter, P10a cdfd3448a)', () => {
  // A foreign writer's subject that carries the finalized status and an integer finish time. A blank node has no STR, so ORDER BY STR(?job) leaves its rows in engine order and the
  // key check of the tie walk rejects them; an IRI outside the job prefix that mixes astral and high BMP characters is ordered by code point in Oxigraph and by UTF-16 in the key check.
  // Before the scan read IRIs under the job prefix only, either was an anomaly on every call, and the job behind it was never reached.
  const XSD_INT = '^^<http://www.w3.org/2001/XMLSchema#integer>';
  const T = Math.round(10 * DAY);
  const E = fin('E', 'ke', 20);
  const foreign = (subject: string, finalizedAt = T): Quad[] => [
    { subject, predicate: CONTROL_STATUS, object: '"finalized"', graph: DEFAULT_CONTROL_GRAPH_URI },
    { subject, predicate: CONTROL_FINALIZED_AT, object: `"${finalizedAt}"${XSD_INT}`, graph: DEFAULT_CONTROL_GRAPH_URI },
  ];
  const tieGroup = (subjects: readonly string[]): Quad[] => subjects.flatMap((subject) => foreign(subject));
  async function storeWith(quads: readonly Quad[]): Promise<OxigraphStore> {
    const store = new OxigraphStore();
    stores.push(store);
    await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
    await store.insert([...quads]);
    return store;
  }
  /** Every triple of the control graph except those of the real jobs named in `jobs` (job and request subjects), as sorted lines: what a sweep must leave as it found it. */
  const notJobs = async (store: OxigraphStore, ...jobs: string[]): Promise<string> => {
    const skip = new Set(jobs.flatMap((id) => [jobSubject(id), requestSubject(id)]));
    const r = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { ?s ?p ?o } }`);
    return r.type === 'bindings' ? r.bindings.filter((b) => !skip.has(b['s']!)).map((b) => `${b['s']} ${b['p']} ${b['o']}`).sort().join('\n') : '';
  };
  const calls = async (retention: ReturnType<typeof newRetention>, max = 12): Promise<PublisherRetentionBatchResult[]> => {
    const results: PublisherRetentionBatchResult[] = [];
    for (let i = 0; i < max; i++) { const res = await retention.runBatch(); results.push(res); if (!res.hasMore || res.error) break; }
    return results;
  };
  const passOf = (mode: 'delete' | 'report', n: number) => (mode === 'delete' ? { deleted: { finalized: n }, wouldDelete: { finalized: 0 } } : { deleted: { finalized: 0 }, wouldDelete: { finalized: n } });

  it.each(['delete', 'report'] as const)('%s mode: five blank nodes sharing one finish time (a tie group larger than the batch) in front of an eligible job: the job is reached, the pass completes, no anomaly, the blank nodes are untouched', async (mode) => {
    for (const batchSize of [1, 2, 3, 4]) {
      const store = await storeWith([...tieGroup(['_:b1', '_:b2', '_:b3', '_:b4', '_:b5']), ...keyedQuads(templates, E)]);
      const foreignBefore = await notJobs(store, 'E');
      expect(foreignBefore.split('\n')).toHaveLength(10);
      const retention = newRetention(publisherOver(store), { mode, batchSize });
      const results = await calls(retention);
      const at = `batch size ${batchSize}: ${results.length} calls, anomalies ${results.map((r) => r.anomalies).join(',')}, scanned ${results.map((r) => r.scanned).join(',')}`;
      expect(results.at(-1)!.hasMore, at).toBe(false);
      expect(results.every((r) => r.anomalies === 0 && r.error === undefined), at).toBe(true);
      expect(retention.counters().anomalies, at).toBe(0);
      expect(results.filter((r) => r.passCompleted), at).toHaveLength(1);
      expect(results.reduce((n, r) => n + r.scanned, 0), `${at}: the blank nodes are not candidates, the job is`).toBe(1);
      expect(mode === 'delete' ? deletedIds(results) : wouldDeleteIds(results), at).toEqual(['E']);
      expect((await present(store, 'E')) !== '', at).toBe(mode !== 'delete');
      expect(retention.counters().lastCompletePass, at).toMatchObject({ ...passOf(mode, 1), kept: { unreadable: 0 } });
      expect(await notJobs(store, 'E'), `${at}: the blank nodes are untouched`).toBe(foreignBefore);
    }
  });

  it('blank nodes among distinct finish times (the range scan, no tie group) are no candidates either: never judged, never counted, never deleted', async () => {
    const store = await storeWith([...foreign('_:early', Math.round(5 * DAY)), ...foreign('_:mid', Math.round(15 * DAY)), ...keyedQuads(templates, fin('E1', 'k1', 10)), ...keyedQuads(templates, fin('E2', 'k2', 20))]);
    const foreignBefore = await notJobs(store, 'E1', 'E2');
    const retention = newRetention(publisherOver(store), { batchSize: 2 });
    const results = await calls(retention);
    expect(results.at(-1)!.hasMore).toBe(false);
    expect(results.every((r) => r.anomalies === 0 && r.error === undefined)).toBe(true);
    expect(results.reduce((n, r) => n + r.scanned, 0)).toBe(2);
    expect(retention.counters().lastCompletePass).toMatchObject({ scanned: 2, deleted: { finalized: 2 }, kept: { unreadable: 0 } });
    expect(await notJobs(store, 'E1', 'E2')).toBe(foreignBefore);
  });

  // The engine labels a blank node afresh in every store, so where its rows land among the real jobs of a group varies from store to store: eight stores.
  it('a tie group that mixes blank nodes and real jobs: every real job of the group is judged once, the blank nodes are skipped (eight stores, the engine labels blank nodes afresh)', async () => {
    const jobs = ['m1', 'm2', 'm3', 'm4'];
    for (let attempt = 0; attempt < 8; attempt++) {
      const store = await storeWith([...tieGroup(['_:x1', '_:x2', '_:x3']), ...jobs.flatMap((id) => keyedQuads(templates, { ...fin(id, `key-${id}`, 5), finalizedAt: T }))]);
      const foreignBefore = await notJobs(store, ...jobs);
      const spy = spyStore(store);
      const results = await calls(newRetention(publisherOver(spy.store), { batchSize: 2 }), 20);
      expect(results.at(-1)!.hasMore, `store ${attempt}`).toBe(false);
      expect(results.every((r) => r.anomalies === 0 && r.error === undefined), `store ${attempt}`).toBe(true);
      expect(verifiedSubjects(spy.log).sort(), `store ${attempt}`).toEqual(jobs.map((id) => jobSubject(id)));
      for (const id of jobs) expect(await present(store, id), `store ${attempt}: ${id}`).toBe('');
      expect(await notJobs(store, ...jobs), `store ${attempt}: the three blank nodes are as they were`).toBe(foreignBefore);
    }
  });

  // An IRI outside the job prefix is no publisher job either. An ASCII one was already kept safely (as unreadable, once each), but one that mixes astral and high BMP characters
  // stalled the pass: an engine orders it by code point and the key check by UTF-16.
  it.each(['delete', 'report'] as const)('%s mode: IRI subjects with another prefix sharing one finish time (ASCII, and mixing astral and high BMP characters), in front of an eligible job: not read, the job is reached, no anomaly, untouched', async (mode) => {
    const others = [
      ['ASCII', ['urn:other:job:o1', 'urn:dkg:publisher:lift-request:o2', 'urn:dkg:publisher:lift-jobs:o3', 'http://example.org/job/o4', 'urn:dkg:publisher:lift-job']],
      ['astral and high BMP', ['urn:other:～', 'urn:other:\u{1F600}', 'urn:other:a', 'urn:other:\u{10000}', 'urn:other:｟']],
    ] as const;
    for (const [label, subjects] of others) for (const batchSize of [1, 2, 3]) {
      const store = await storeWith([...tieGroup(subjects), ...keyedQuads(templates, E)]);
      const foreignBefore = await notJobs(store, 'E');
      const spy = spyStore(store);
      const retention = newRetention(publisherOver(spy.store), { mode, batchSize });
      const results = await calls(retention);
      const at = `${label}, batch size ${batchSize}: ${results.length} calls, anomalies ${results.map((r) => r.anomalies).join(',')}`;
      expect(results.at(-1)!.hasMore, at).toBe(false);
      expect(results.every((r) => r.anomalies === 0 && r.error === undefined), at).toBe(true);
      expect(results.reduce((n, r) => n + r.scanned, 0), `${at}: the foreign subjects are not candidates`).toBe(1);
      expect(verifiedSubjects(spy.log), `${at}: only the publisher job IRI is ever verified`).toEqual([jobSubject('E')]);
      expect(removedJobIds(spy.log), at).toEqual(mode === 'delete' ? ['E'] : []);
      expect(retention.counters().lastCompletePass, at).toMatchObject({ ...passOf(mode, 1), kept: { unreadable: 0 } });
      expect(await notJobs(store, 'E'), at).toBe(foreignBefore);
    }
  });

  // The limit that stays: under the job prefix a non-ASCII id needs a foreign writer (the queue's ids are ASCII, `isSafeJobId`), and an engine that orders such ids by code point
  // disagrees with the key check, which reads UTF-16. The scan fails closed: an anomaly on every call that meets the pair, no cursor moves, nothing foreign is touched.
  it('in-prefix IRI subjects with astral and high BMP characters (needs a foreign writer) fail closed: anomalies, no pass completes, nothing foreign is touched', async () => {
    const store = await storeWith([...tieGroup(['～', '\u{1F600}', 'a'].map((id) => jobSubject(id))), ...keyedQuads(templates, E)]);
    const foreignBefore = await notJobs(store, 'E');
    const retention = newRetention(publisherOver(store), { mode: 'report', batchSize: 1 });
    const results = await calls(retention, 6);
    expect(results.at(-1)!.hasMore).toBe(true);
    expect(results.some((r) => r.anomalies > 0)).toBe(true);
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(retention.counters().lastCompletePass).toBeUndefined();
    expect(await notJobs(store, 'E')).toBe(foreignBefore);
  });

  it('the scan and tie queries select IRI subjects under the job prefix only', () => {
    const prefix = `FILTER (STRSTARTS(STR(?job), ${JSON.stringify(LIFT_JOB_SUBJECT_PREFIX)}))`;
    for (const query of [
      buildLiftRetentionScanQuery(DEFAULT_CONTROL_GRAPH_URI, NOW - WINDOW, 5), buildLiftRetentionScanQuery(DEFAULT_CONTROL_GRAPH_URI, NOW - WINDOW, 5, { after: 7 }),
      buildLiftRetentionTieQuery(DEFAULT_CONTROL_GRAPH_URI, 42, 10), buildLiftRetentionTieQuery(DEFAULT_CONTROL_GRAPH_URI, 42, 10, jobSubject('a')),
    ]) {
      expect(query).toContain('FILTER (isIRI(?job))');
      expect(query).toContain(prefix);
    }
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

  it('keeps the candidates of a key one of whose records is stored under it with a payload of another key: the read refuses that key with the same error type, the sweep goes on', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [fin('good', 'good', 10), fin('victim', 'bad', 10)]);
    const badKey = keyedQuads(templates, fin('victim', 'bad', 10)).find((quad) => quad.predicate === CONTROL_LIFECYCLE_KEY)!.object;
    await store.insert(keyedQuads(templates, at('stray', 'elsewhere', 'accepted', 5)).map((quad) => (quad.predicate === CONTROL_LIFECYCLE_KEY ? { ...quad, object: badKey } : quad)));
    const publisher = publisherOver(store);
    const key = lifecycleKeyOfJob(stampKeyed(templates, fin('victim', 'bad', 10)))!;
    const refusal = await publisher.retentionAccess().runClaimTransaction((tx) => tx.siblings(key)).then(() => undefined, (cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(LiftJobPayloadUnreadableError);
    expect((refusal as Error).message).toBe(`Malformed persisted LiftJob payload: lifecycle index does not match ${key}`);
    const results = await drain(newRetention(publisher));
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(deletedIds(results)).toEqual(['good']);
    expect(kept(results)).toEqual({ siblings_unreadable: 1 });
    expect(await present(store, 'victim')).not.toBe('');
  });

  it('ends the batch on a store failure of the sibling read even when its message reads like an undecodable record\'s: only the error type says a key is unreadable', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [fin('a', 'a', 10)]);
    let fail = true;
    const message = 'Malformed persisted LiftJob payload: the store answered garbage';
    const spy = spyStore(store, { before: (entry) => { if (fail && entry.source === `${RETENTION}siblings`) throw new Error(message); } });
    const retention = newRetention(publisherOver(spy.store));
    const failed = await retention.runBatch();
    expect(failed.error).toEqual({ phase: 'verify', message });
    expect(failed.kept.siblings_unreadable).toBe(0);
    expect(await present(store, 'a')).not.toBe('');
    fail = false;
    expect(deletedIds(await drain(retention))).toEqual(['a']);
  });
});

describe('two records of one job id: the key is kept whole, whatever order the engine returns its rows in (online review round 3: 4396325296)', () => {
  // Admission's read keeps one record per job id, the last row's. With two records of one id, the engine's row order decides which one admission sees, and the
  // sweep, which reads the key the same way, would judge the binding from that one alone: delete the record it saw, and the hidden one can bind the key.
  /** The quads of `spec` (by default as `keyedQuads` writes them) stored under the subjects of job `subjectId`: its payload still names `spec.id`. */
  const storedUnder = (spec: KeyedSpec, subjectId: string, quads = keyedQuads(templates, spec)): Quad[] => quads.map((quad) => ({
    ...quad,
    subject: quad.subject === jobSubject(spec.id) ? jobSubject(subjectId) : quad.subject === requestSubject(spec.id) ? requestSubject(subjectId) : quad.subject,
    object: quad.object === `<${requestSubject(spec.id)}>` ? `<${requestSubject(subjectId)}>` : quad.object,
  }));
  /** The quads without their lifecycle-key triples: the record of a job stored before the key was indexed, which the read reaches through its legacy branch (on in a fresh store). */
  const unkeyed = (quads: Quad[]): Quad[] => quads.filter((quad) => quad.predicate !== CONTROL_LIFECYCLE_KEY);
  /** The quads of `spec`'s failed job written the pre-upgrade way (a legacy-v0 payload with no claim or validation), which the decoder reads as `compatibility`. */
  const legacyV0Failed = (spec: KeyedSpec): Quad[] => {
    const { claim: _claim, validation: _validation, ...job } = stampKeyed(templates, spec) as unknown as Record<string, unknown>;
    const failure = { ...(job['failure'] as Record<string, unknown>), failedFromState: 'claimed' };
    const quads = serializeJob({ ...job, failure } as unknown as LiftJob, DEFAULT_CONTROL_GRAPH_URI, { payloadSchema: 'legacy-v0' });
    const decoded = decodeLiftJobPayload(quads.find((quad) => quad.predicate === CONTROL_PAYLOAD)?.object);
    if (decoded.kind !== 'compatibility') throw new Error(`fixture: ${spec.id}'s legacy-v0 failed payload decodes as ${decoded.kind}, not compatibility`);
    return quads;
  };
  /** Job f's two payloads with every other job's rows between them: the rows of f's other payload first, then the other jobs', then those of f's payload in the named status. */
  const SPLIT_ORDERS = ['split, f finalized last', 'split, f failed last'] as const;
  type RowOrder = 'engine' | 'ascending' | 'descending' | (typeof SPLIT_ORDERS)[number];
  const splitAroundF = (rows: Array<Record<string, string>>, order: (typeof SPLIT_ORDERS)[number]): Array<Record<string, string>> => {
    const last = order === 'split, f finalized last' ? 'finalized' : 'failed';
    const part = (row: Record<string, string>): number => { const job = parseInventoryPayload(row['payload']); return job?.jobId !== 'f' ? 1 : job.status === last ? 2 : 0; };
    return [0, 1, 2].flatMap((n) => rows.filter((row) => part(row) === n));
  };
  /**
   * `store` with the rows of every sibling read (the one query that binds `?indexed`) in the engine's order, sorted by payload text or split: each of two payloads of one job
   * id is the last row in one of the sorted orders, which keep the rows of one id together, and a split order puts another job's rows between f's two payloads. `seen` gets
   * the records of each answer the stub rewrites, in its order (`id:status`, one per run of rows with one payload).
   */
  const siblingRowsIn = (store: OxigraphStore, order: RowOrder, seen?: string[][]): OxigraphStore => (order === 'engine' ? store : spyStore(store, {
    rewrite: async (entry, run) => {
      const answer = await run();
      if (answer.type !== 'bindings' || !entry.text.includes('?indexed')) return answer;
      const sorted = [...answer.bindings].sort((a, b) => (a['payload']! < b['payload']! ? -1 : a['payload']! > b['payload']! ? 1 : 0));
      const bindings = order === 'ascending' ? sorted : order === 'descending' ? sorted.reverse() : splitAroundF(sorted, order);
      seen?.push(bindings.filter((row, i) => row['payload'] !== bindings[i - 1]?.['payload']).map((row) => {
        const job = parseInventoryPayload(row['payload']);
        return job === null ? 'undecodable' : `${job.jobId}:${job.status}`;
      }));
      return { ...answer, bindings };
    },
  }).store);
  /** Admission's own read of the key named `name` (`vmPublishAdmissionCandidates`) and the binding it answers with, in the given row orders (by default the two sorted ones). */
  const admissionViews = async (store: OxigraphStore, name: string, orders: readonly RowOrder[] = ['ascending', 'descending']): Promise<string[]> => {
    const key = lifecycleKeyOfJob(stampKeyed(templates, fin('probe', name, 1)))!;
    const views: string[] = [];
    for (const order of orders) {
      const records = await new LiftJobStoreSelectors(siblingRowsIn(store, order), DEFAULT_CONTROL_GRAPH_URI, (job) => job).vmPublishAdmissionCandidates(key);
      views.push(`records ${records.map((job) => `${job.jobId}:${job.status}`).sort().join(' ')}, binds ${bindingJobIds(records, key).join(' ') || 'nothing'}`);
    }
    return views;
  };
  const CASES: Array<readonly [string, () => Quad[][], Record<string, number>]> = [
    ['subject z holds an older retryable failed payload of job f, subject f the old finalized job f (the review\'s case)',
      () => [keyedQuads(templates, fin('f', 'key', 10)), storedUnder(at('f', 'key', 'retryable', 5), 'z')], { siblings_unreadable: 1 }],
    ['one id with no subject mismatch: subject f holds two payloads of job f, a newer finalized one and an older retryable failed one, next to the old finalized g',
      () => [keyedQuads(templates, fin('g', 'key', 20)), keyedQuads(templates, fin('f', 'key', 30)), keyedQuads(templates, at('f', 'key', 'retryable', 10))], { unreadable: 1, siblings_unreadable: 1 }],
    // Each row below pins one part of the check (verification of round 3): every row the read returns is checked, from either branch and whatever its payload's schema,
    // and the refusal keeps every candidate of the key, not only the first.
    ['the review\'s case with both records stored without their lifecycle-key triples, read through the legacy branch (its rows bind no ?indexed)',
      () => [unkeyed(keyedQuads(templates, fin('f', 'key', 10))), unkeyed(storedUnder(at('f', 'key', 'retryable', 5), 'z'))], { siblings_unreadable: 1 }],
    ['the review\'s case with z\'s failed payload of job f written the pre-upgrade way, which decodes as compatibility',
      () => [keyedQuads(templates, fin('f', 'key', 10)), storedUnder(at('f', 'key', 'retryable', 5), 'z', legacyV0Failed(at('f', 'key', 'retryable', 5)))], { siblings_unreadable: 1 }],
    ['the review\'s case with a second old finalized candidate in the key, g, finished before f: both candidates are kept',
      () => [keyedQuads(templates, fin('g', 'key', 8)), keyedQuads(templates, fin('f', 'key', 10)), storedUnder(at('f', 'key', 'retryable', 5), 'z')], { siblings_unreadable: 2 }],
    ['one id, two payloads in one status: subject f holds two retryable failed payloads of job f (accepted day 30 and day 10), next to the old finalized g (day 20)',
      () => [keyedQuads(templates, fin('g', 'key', 20)), keyedQuads(templates, at('f', 'key', 'retryable', 30)), keyedQuads(templates, at('f', 'key', 'retryable', 10))], { siblings_unreadable: 1 }],
  ];

  it.each(CASES.flatMap(([label, records, reasons]) => (['delete', 'report'] as const).map((mode) => [label, mode, records, reasons] as const)))('%s, %s mode: every record stays and admission answers as before, in every row order', async (_label, mode, records, reasons) => {
    for (const insertion of ['as listed', 'reversed'] as const) {
      for (const order of ['engine', 'ascending', 'descending'] as const) {
        const where = `inserted ${insertion}, sibling rows in ${order} order`;
        const store = new OxigraphStore();
        stores.push(store);
        await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
        for (const quads of insertion === 'as listed' ? records() : records().reverse()) await store.insert(quads);
        const graph = await graphFingerprint(store, DEFAULT_CONTROL_GRAPH_URI);
        const views = await admissionViews(store, 'key');
        expect(views[0], `${where}: each sorted order shows admission the other record of the id`).not.toBe(views[1]);
        const results = await drain(newRetention(publisherOver(siblingRowsIn(store, order)), { mode }));
        // soft: a failure names every insertion and row order that fails, not only the first
        expect.soft(results.every((r) => r.error === undefined), where).toBe(true);
        expect.soft([...deletedIds(results), ...wouldDeleteIds(results)], where).toEqual([]);
        expect.soft(kept(results), where).toEqual(reasons);
        expect.soft(await graphFingerprint(store, DEFAULT_CONTROL_GRAPH_URI) === graph, `${where}: both records of the id stay, byte for byte`).toBe(true);
        expect.soft(await admissionViews(store, 'key'), `${where}: admission binds what it bound, in either row order`).toEqual(views);
      }
    }
  });

  // Verification of round 3, second pass: every row above reaches the check with the two payloads of one id as adjacent rows, and two mutants of its two-payloads test
  // passed them all (comparing each row only with the row before it, and forgetting the ids it has seen once it holds two). Here g's rows sit between f's two payloads.
  it.each((['delete', 'report'] as const).flatMap((mode) => SPLIT_ORDERS.map((order) => [mode, order] as const)))('subject f holds two payloads of job f and the engine returns g\'s row between them, %s mode, sibling rows in %s order: every record stays and admission answers as before', async (mode, order) => {
    const records = (): Quad[][] => [keyedQuads(templates, fin('g', 'key', 20)), keyedQuads(templates, fin('f', 'key', 30)), keyedQuads(templates, at('f', 'key', 'retryable', 10))];
    const between = order === 'split, f finalized last' ? ['f:failed', 'g:finalized', 'f:finalized'] : ['f:finalized', 'g:finalized', 'f:failed'];
    for (const insertion of ['as listed', 'reversed'] as const) {
      const where = `inserted ${insertion}`;
      const store = new OxigraphStore();
      stores.push(store);
      await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
      for (const quads of insertion === 'as listed' ? records() : records().reverse()) await store.insert(quads);
      const graph = await graphFingerprint(store, DEFAULT_CONTROL_GRAPH_URI);
      const views = await admissionViews(store, 'key', SPLIT_ORDERS);
      expect(views[0], `${where}: each split order shows admission the other record of f`).not.toBe(views[1]);
      const seen: string[][] = [];
      const results = await drain(newRetention(publisherOver(siblingRowsIn(store, order, seen)), { mode }));
      expect(seen.length, `${where}: the sweep read the key`).toBeGreaterThan(0);
      for (const read of seen) expect(read, `${where}: the sweep's read has g's record between f's two`).toEqual(between);
      expect.soft(results.every((r) => r.error === undefined), where).toBe(true);
      expect.soft([...deletedIds(results), ...wouldDeleteIds(results)], where).toEqual([]);
      expect.soft(kept(results), where).toEqual({ unreadable: 1, siblings_unreadable: 1 });
      expect.soft(await graphFingerprint(store, DEFAULT_CONTROL_GRAPH_URI) === graph, `${where}: every record stays, byte for byte`).toBe(true);
      expect.soft(await admissionViews(store, 'key', SPLIT_ORDERS), `${where}: admission binds what it bound, in either split order`).toEqual(views);
    }
  });

  it('the sweep\'s read refuses the key with the error type of an unreadable record; admission\'s read is unchanged and still answers', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [fin('f', 'key', 10)]);
    await store.insert(storedUnder(at('f', 'key', 'retryable', 5), 'z'));
    const key = lifecycleKeyOfJob(stampKeyed(templates, fin('f', 'key', 10)))!;
    const refusal = await publisherOver(store).retentionAccess().runClaimTransaction((tx) => tx.siblings(key)).then(() => undefined, (cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(LiftJobPayloadUnreadableError);
    expect((refusal as Error).message).toBe(`Malformed persisted LiftJob payload: subject ${jobSubject('z')} holds a payload of job f`);
    expect((await admissionViews(store, 'key')).sort()).toEqual(['records f:failed, binds f', 'records f:finalized, binds nothing']);
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
