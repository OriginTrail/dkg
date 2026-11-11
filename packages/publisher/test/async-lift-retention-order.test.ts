/**
 * OT-RFC-73 P11, publisher retention: the records of a lifecycle key leave OLDEST FIRST in every state the store can be in, so what a sweep leaves behind is always a
 * suffix of the key and the key's newest record is there until the last one goes (plan section 5.3, AC7).
 *
 * The sweep walks the finalized rows by finish time and judges each key from its records, a hold at a time. Three things can put an older record out of the way of a
 * newer one, and each case here builds one of them:
 *  - the sweep KEEPS the older record for a reason that can pass (it is dated after now, a wallet lock names it, an older failed job stood in front of it, the key could
 *    not be read) and the scan moves on: the reason passes between two batches of ONE pass and the newer record, judged by a later batch, is no longer held back;
 *  - the older record is one the sweep can NEVER delete (a pre-upgrade payload it does not rewrite, a stored index the scan does not match, a stored key that admission
 *    does not read it by): nothing held the newer record back at all;
 *  - the two finished at the same instant, and the scan meets the newer one first (the rows of one finish time come by subject when they are more than a batch, and in
 *    the engine's order inside one batch).
 * A newer record goes only behind an older one the sweep deletes first. Binding never changes in these cases (what is left in front is finalized), which is why the
 * binding view is asserted too, but it is the ORDER that these tests are about.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher, type PublisherRetentionBatchResult } from '../src/index.js';
import {
  CONTROL_FINALIZED_AT, CONTROL_LIFECYCLE_KEY, CONTROL_PAYLOAD, CONTROL_STATUS, DEFAULT_CONTROL_GRAPH_URI, DEFAULT_WALLET_LOCK_GRAPH_URI, jobSubject,
} from '../src/async-lift-control-plane.js';
import { bindingJobIds } from '../src/async-lift-lifecycle-siblings.js';
import { LiftJobPayloadUnreadableError } from '../src/lift-job-payload-unreadable.js';
import { lifecycleKeyOfJob } from '../src/lift-job-store-selectors.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import {
  DAY, NOW, at, createRetentionTemplates, fin, keyedQuads, present, seedWalletLock, spyStore, stampKeyed, type KeyedSpec, type RetentionTemplates, type SpyHooks,
} from './_helpers/lift-retention-fixtures.js';
import { drain, expectKeySuffix, newRetention, publisherOver, removedJobIds } from './_helpers/lift-retention-sweep.js';

const HOUR = 60 * 60 * 1000;
const INTEGER = '^^<http://www.w3.org/2001/XMLSchema#integer>';

let templates: RetentionTemplates;
beforeAll(async () => { templates = await createRetentionTemplates(); });
const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

async function world(specs: readonly KeyedSpec[], rewrite: (quads: Quad[], spec: KeyedSpec) => Quad[] = (quads) => quads) {
  const store = new OxigraphStore();
  stores.push(store);
  await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
  await store.insert(specs.flatMap((spec) => rewrite(keyedQuads(templates, spec), spec)));
  return { store, publisher: new TripleStoreAsyncLiftPublisher(store, { now: () => NOW, idGenerator: () => 'unused' }) };
}
type World = Awaited<ReturnType<typeof world>>;

const idsOf = async (w: World): Promise<string[]> => (await w.publisher.list()).map((job) => job.jobId).sort();
const deletedIds = (results: readonly PublisherRetentionBatchResult[]): string[] => results.flatMap((r) => r.deletedJobs.map((j) => j.jobId));
const wouldDeleteIds = (results: readonly PublisherRetentionBatchResult[]): string[] => results.flatMap((r) => r.wouldDeleteJobs.map((j) => j.jobId));
const kept = (results: readonly PublisherRetentionBatchResult[]): Record<string, number> => {
  const total: Record<string, number> = {};
  for (const r of results) for (const [reason, n] of Object.entries(r.kept)) if (n > 0) total[reason] = (total[reason] ?? 0) + n;
  return total;
};
async function bindingView(publisher: TripleStoreAsyncLiftPublisher, key: string): Promise<string> {
  const lookup = await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ contextGraphId: 'music-social', name: key });
  return lookup.kind === 'active' ? `active:${lookup.job.jobId}` : lookup.kind === 'conflict' ? 'conflict' : 'unbound';
}
/** Admission's answer for the key named `name`: its records read inside the claim transaction as admission reads them, and the binding selector over them, or the read's refusal. */
async function admissionAnswer(publisher: TripleStoreAsyncLiftPublisher, name: string): Promise<string> {
  const key = lifecycleKeyOfJob(stampKeyed(templates, fin('probe', name, 1)))!;
  return publisher.retentionAccess().runClaimTransaction((tx) => tx.siblings(key)).then(
    (records) => `binds:${bindingJobIds(records, key).join(',')}`,
    (cause: unknown) => `refused:${cause instanceof LiftJobPayloadUnreadableError}:${(cause as Error).message}`,
  );
}

/** What is left of a key (`order`: its records oldest first) is a suffix of it, and its newest record is there until the last one goes. */
async function expectSuffix(w: World, order: readonly string[], when: string): Promise<void> {
  expectKeySuffix(await idsOf(w), order, when);
}
/** `drain`, with no error and the suffix asserted after every batch; `between` runs after each batch that did not end the pass (a change between two batches). */
async function walk(
  retention: ReturnType<typeof newRetention>, w: World, order: readonly string[], label: string, between?: (batch: number) => Promise<void>,
): Promise<PublisherRetentionBatchResult[]> {
  const results: PublisherRetentionBatchResult[] = [];
  for (let i = 0; i < 50; i++) {
    const res = await retention.runBatch();
    results.push(res);
    expect(res.error, `${label} batch ${i}`).toBeUndefined();
    await expectSuffix(w, order, `${label} batch ${i}`);
    if (!res.hasMore && res.scanned === 0) break;
    await between?.(i);
  }
  return results;
}
/** The stored finish time of `id`, replaced by `day` (an `xsd:integer`, as the queue writes it). */
async function setFinishIndex(w: World, id: string, day: number): Promise<void> {
  await w.store.deleteByPattern({ subject: jobSubject(id), predicate: CONTROL_FINALIZED_AT, graph: DEFAULT_CONTROL_GRAPH_URI });
  await w.store.insert([{ subject: jobSubject(id), predicate: CONTROL_FINALIZED_AT, object: `"${Math.round(day * DAY)}"${INTEGER}`, graph: DEFAULT_CONTROL_GRAPH_URI }]);
}

describe('a reason to keep an older record passes between two batches of one pass', () => {
  it('an older record dated after now whose date passes: the record behind it waits, and the next pass takes the two in order', async () => {
    // A is kept as future_dated by batch 1; the clock passes its date; batch 2 meets B, and A (now deletable) is in front of it in the key
    let t = NOW;
    const w = await world([{ ...fin('A', 'k', 10, 11), updatedAt: NOW + HOUR }, fin('B', 'k', 20, 21), at('C', 'k', 'accepted', 50)]);
    const retention = newRetention(w.publisher, { batchSize: 1, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await retention.runBatch();
    expect(first.kept.future_dated).toBe(1);
    t = NOW + 2 * HOUR;
    const rest = await drain(retention);
    expect(deletedIds(rest)).toEqual([]);                                          // B does not go ahead of A
    expect(kept(rest)).toEqual({ older_sibling_pending: 1 });
    expect(await idsOf(w)).toEqual(['A', 'B', 'C']);
    expect(await bindingView(w.publisher, 'k')).toBe('active:C');
    t = NOW + 30 * HOUR;                                                           // the next pass starts at the oldest row
    const next = await drain(retention);
    expect(deletedIds(next)).toEqual(['A', 'B']);
    expect(await idsOf(w)).toEqual(['C']);
  });

  it('an older failed record an operator clears: the finalized record it held back is not left in front of the one behind it', async () => {
    const w = await world([at('x', 'key', 'terminal', 5), fin('a', 'key', 10), fin('b', 'key', 20)]);
    let t = NOW;
    const retention = newRetention(w.publisher, { batchSize: 1, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await retention.runBatch();
    expect(first.kept.older_sibling_kept).toBe(1);                                 // a, behind the failed x
    expect(await w.publisher.clear('failed')).toBe(1);                             // an operator clears x between the two batches
    const rest = await drain(retention);
    expect(deletedIds(rest)).toEqual([]);                                          // b must not go while a stays
    expect(await idsOf(w)).toEqual(['a', 'b']);
    t = NOW + 30 * HOUR;
    expect(deletedIds(await drain(retention))).toEqual(['a', 'b']);
  });

  it('a key that could not be read for batch 1 and can for batch 2: the record batch 1 kept still goes first', async () => {
    const w = await world([fin('a', 'k', 10), fin('b', 'k', 20)]);
    await w.store.insert([
      { subject: jobSubject('poison'), predicate: CONTROL_LIFECYCLE_KEY, object: '"music-social\\u001fk\\u001f\\u001f"', graph: DEFAULT_CONTROL_GRAPH_URI },
      { subject: jobSubject('poison'), predicate: CONTROL_STATUS, object: '"accepted"', graph: DEFAULT_CONTROL_GRAPH_URI },
      { subject: jobSubject('poison'), predicate: CONTROL_PAYLOAD, object: '"{ garbage"', graph: DEFAULT_CONTROL_GRAPH_URI },
    ]);
    let t = NOW;
    const retention = newRetention(w.publisher, { batchSize: 1, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await retention.runBatch();
    expect(first.kept.siblings_unreadable).toBe(1);                                // a
    await w.store.deleteByPattern({ subject: jobSubject('poison'), graph: DEFAULT_CONTROL_GRAPH_URI });
    const rest = await drain(retention);
    expect(deletedIds(rest)).toEqual([]);
    expect(await idsOf(w)).toEqual(['a', 'b']);
    t = NOW + 30 * HOUR;
    expect(deletedIds(await drain(retention))).toEqual(['a', 'b']);
  });

  it.each([
    ['in one batch', {}],
    ['one batch each', { batchSize: 1 }],
  ])('an older record a wallet lock names (%s): the plan of its key does not read the locks, so the records behind it wait, and go after it once the lock is gone', async (_name, over) => {
    // a is kept as bound_obligation by the checks of the job alone; the plan of the key reads a as an old finalized record and would let a, b and c go. Only the mark
    // the bound record leaves on its key keeps b and c (the key's newest) from going while a stays.
    const order = ['a', 'b', 'c'];
    const specs = [fin('a', 'k', 10), fin('b', 'k', 20), fin('c', 'k', 30)];
    let t = NOW;
    const w = await world(specs);
    await seedWalletLock(w.store, 'a', 'wallet-1', 'released');
    const retention = newRetention(w.publisher, { ...over, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await walk(retention, w, order, 'pass 1');
    expect(deletedIds(first)).toEqual([]);
    expect(kept(first)).toEqual({ bound_obligation: 1, older_sibling_pending: 2 });
    expect(await idsOf(w)).toEqual(['a', 'b', 'c']);
    const reportWorld = await world(specs);
    await seedWalletLock(reportWorld.store, 'a', 'wallet-1', 'released');
    const report = await walk(newRetention(reportWorld.publisher, { mode: 'report', ...over }), reportWorld, order, 'report');
    expect(wouldDeleteIds(report)).toEqual([]);
    expect(kept(report)).toEqual({ bound_obligation: 1, older_sibling_pending: 2 });
    await w.store.deleteByPattern({ graph: DEFAULT_WALLET_LOCK_GRAPH_URI });         // the lock is gone; the next pass takes the three, oldest first
    t = NOW + 30 * HOUR;
    expect(deletedIds(await walk(retention, w, order, 'pass 2'))).toEqual(['a', 'b', 'c']);
  });

  it('two older records kept for reasons that can pass, met newest first: the record behind both waits for the OLDER one, whose reason passed first', async () => {
    // A (accepted day 10, finished day 31, updated after now), B (day 20, finished 32), C (day 30, finished 25). The walk meets C first (kept: A in front of it is dated
    // after now), then A (kept: dated after now). The clock passes A's date, and then the walk meets B with A, deletable now, still in front of it: B must wait. The key's
    // mark is the OLDEST record kept (A), not the newest one kept (C, which is behind B).
    const order = ['A', 'B', 'C'];
    let t = NOW;
    const w = await world([{ ...fin('A', 'k', 10, 31), updatedAt: NOW + HOUR }, fin('B', 'k', 20, 32), fin('C', 'k', 30, 25)]);
    const retention = newRetention(w.publisher, { batchSize: 1, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await retention.runBatch();
    expect(kept([first])).toEqual({ older_sibling_kept: 1 });                    // C, behind A
    await expectSuffix(w, order, 'batch 1');
    const second = await retention.runBatch();
    expect(kept([second])).toEqual({ future_dated: 1 });                         // A
    await expectSuffix(w, order, 'batch 2');
    t = NOW + 2 * HOUR;                                                            // A's date passes
    const rest = await walk(retention, w, order, 'pass 1 after the clock passed A');
    expect(deletedIds(rest)).toEqual([]);                                          // B does not go ahead of A
    expect(kept(rest)).toEqual({ older_sibling_pending: 1 });
    expect(await idsOf(w)).toEqual(['A', 'B', 'C']);
    t = NOW + 30 * HOUR;                                                           // the next pass: A and B go, C (finished before B) waits for the one after
    expect(deletedIds(await walk(retention, w, order, 'pass 2'))).toEqual(['A', 'B']);
    t = NOW + 60 * HOUR;
    expect(deletedIds(await walk(retention, w, order, 'pass 3'))).toEqual(['C']);
  });
});

describe('an older record the sweep can never delete keeps every record behind it', () => {
  /** The record a pre-upgrade node stored: a v0 payload of a local finalization with chain evidence, which the decoder reads as `compatibility`. */
  const legacy = (id: string, day: number, finalizedDay = day + 0.1): KeyedSpec => ({ ...fin(id, 'k', day, finalizedDay), compat: true });

  it.each([
    ['in the same batch', {}],
    ['one batch each', { batchSize: 1 }],
    ['one record per slice', { sliceSize: 1 }],
  ])('a pre-upgrade finalized record in front of a newer one (%s): nothing behind it is deleted, in report mode either', async (_name, over) => {
    const specs = [legacy('c', 10), fin('b', 'k', 20), fin('d', 'k', 30)];
    const reportWorld = await world(specs);
    const deleteWorld = await world(specs);
    const report = await drain(newRetention(reportWorld.publisher, { mode: 'report', ...over }));
    const real = await drain(newRetention(deleteWorld.publisher, { ...over }));
    expect(deletedIds(real)).toEqual([]);
    expect(wouldDeleteIds(report)).toEqual([]);
    expect(await idsOf(deleteWorld)).toEqual(['b', 'c', 'd']);
  });

  it('a pre-upgrade record at the newest end, or after the records that go: those go, it stays', async () => {
    const w = await world([fin('a', 'k', 10), fin('b', 'k', 20), legacy('c', 30)]);
    expect(deletedIds(await drain(newRetention(w.publisher)))).toEqual(['a', 'b']);
    expect(await idsOf(w)).toEqual(['c']);
  });

  const stale: Array<[string, (quads: Quad[]) => Quad[]]> = [
    ['no stored finish time', (quads) => quads.filter((quad) => quad.predicate !== CONTROL_FINALIZED_AT)],
    // the scan reads `xsd:integer` finish times only (online review round 1), so it never meets a record whose finish time is stored as a decimal of the same value
    ['a stored finish time that is a decimal of the right value', (quads) => quads.map((quad) => (quad.predicate === CONTROL_FINALIZED_AT ? { ...quad, object: quad.object.replace(/^"(\d+)"\^\^<[^>]+>$/, '"$1.0"^^<http://www.w3.org/2001/XMLSchema#decimal>') } : quad))],
    ['a stored finish time in the future (the scan does not reach it yet)', (quads) => quads.map((quad) => (quad.predicate === CONTROL_FINALIZED_AT ? { ...quad, object: `"${NOW + DAY}"${INTEGER}` } : quad))],
    ['a stored status that is not finalized (a stale index row)', (quads) => quads.map((quad) => (quad.predicate === CONTROL_STATUS ? { ...quad, object: '"accepted"' } : quad))],
  ];
  it.each(stale)('a finalized record with %s in front of a newer one: the scan never meets it, so the record behind it stays', async (_name, corrupt) => {
    const specs = [fin('a', 'k', 10), fin('b', 'k', 20), fin('c', 'k', 30)];
    for (const [mode, over] of [['delete', {}], ['delete', { batchSize: 1 }], ['report', {}]] as const) {
      const w = await world(specs, (quads, spec) => (spec.id === 'a' ? corrupt(quads) : quads));
      const before = await present(w.store, 'a');
      const results = await drain(newRetention(w.publisher, { mode, ...over }));
      expect(results.every((r) => r.error === undefined), mode).toBe(true);
      expect(deletedIds(results), mode).toEqual([]);
      expect(wouldDeleteIds(results), mode).toEqual([]);
      expect(kept(results), mode).toMatchObject({ older_sibling_kept: 2 });        // b and c wait behind a
      expect(await idsOf(w), mode).toEqual(['a', 'b', 'c']);
      expect(await present(w.store, 'a'), mode).toBe(before);
    }
  });

  it.each([
    ['in one batch', {}],
    ['one batch each', { batchSize: 1 }],
  ])('a finalized record whose stored key names another key, in front of newer ones (%s): the scan meets it, admission does not reach it, and the records behind it stay', async (_name, over) => {
    // The key's records are read by the stored key triple, so a is not among them: the plan of k sees b and c only and would let both go. Only the mark the unreachable
    // candidate leaves on the key of its payload keeps them.
    const order = ['a', 'b', 'c'];
    const specs = [fin('a', 'k', 10), fin('b', 'k', 20), fin('c', 'k', 30)];
    const otherKey = (quads: Quad[], spec: KeyedSpec) => (spec.id !== 'a' ? quads
      : quads.map((quad) => (quad.predicate === CONTROL_LIFECYCLE_KEY ? { ...quad, object: '"music-social\\u001fsomething-else\\u001f"' } : quad)));
    for (const mode of ['delete', 'report'] as const) {
      const w = await world(specs, otherKey);
      const before = await present(w.store, 'a');
      const results = await walk(newRetention(w.publisher, { mode, ...over }), w, order, mode);
      expect(deletedIds(results), mode).toEqual([]);
      expect(wouldDeleteIds(results), mode).toEqual([]);
      expect(kept(results), mode).toEqual({ index_mismatch: 1, older_sibling_pending: 2 });
      expect(await idsOf(w), mode).toEqual(['a', 'b', 'c']);
      expect(await present(w.store, 'a'), mode).toBe(before);
    }
  });

  it.each([
    ['in one batch', {}],
    ['one batch each', { batchSize: 1 }],
  ])('a finalized record that carries a second stored key next to its own, in front of newer ones (%s; online review 4395740472): it stays, the records behind it stay, and the other key\'s admission answer is the same', async (_name, over) => {
    // a's payload and its own key triple say k; a second key triple names `other`. Admission for `other` reads a by that triple and refuses the key (a's payload names k), which
    // also keeps x, other's older failed job, from binding it again. The sweep reads k's records by k's triple and finds a among them: only the number of a's key triples says
    // that a is indexed under a second key, whose answer deleting a would change. So a is kept (index_mismatch), and, being a record the sweep never deletes, it holds b and c.
    const order = ['a', 'b', 'c'];
    const specs = [fin('a', 'k', 10), fin('b', 'k', 20), fin('c', 'k', 30), at('x', 'other', 'retryable', 5)];
    const otherKey = keyedQuads(templates, specs[3]!).find((quad) => quad.predicate === CONTROL_LIFECYCLE_KEY)!;
    const secondKey = (quads: Quad[], spec: KeyedSpec) => (spec.id === 'a' ? [...quads, { ...otherKey, subject: jobSubject('a') }] : quads);
    for (const mode of ['delete', 'report'] as const) {
      const w = await world(specs, secondKey);
      const before = await present(w.store, 'a');
      const answer = await admissionAnswer(w.publisher, 'other');
      expect(answer, mode).toMatch(/^refused:true:Malformed persisted LiftJob payload: lifecycle index does not match /);
      const results = await walk(newRetention(w.publisher, { mode, ...over }), w, order, mode);
      expect(deletedIds(results), mode).toEqual([]);
      expect(wouldDeleteIds(results), mode).toEqual([]);
      expect(kept(results), mode).toEqual({ index_mismatch: 1, older_sibling_kept: 2 });
      expect(await idsOf(w), mode).toEqual(['a', 'b', 'c', 'x']);
      expect(await present(w.store, 'a'), mode).toBe(before);
      expect(await admissionAnswer(w.publisher, 'other'), mode).toBe(answer);
      // and admission itself still refuses `other` rather than re-accepting x
      const resubmit = new TripleStoreAsyncLiftPublisher(w.store, { now: () => NOW, idGenerator: () => 'fresh' }).enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'other' }));
      expect(await resubmit.then((id) => `admitted:${id}`, (cause: unknown) => `refused:${cause instanceof LiftJobPayloadUnreadableError}`), mode).toBe('refused:true');
    }
  });
});

describe('a record the sweep reads through another job\'s subject', () => {
  const rename = (from: string, to: string) => (quads: Quad[]) => quads.map((quad) => (quad.predicate === CONTROL_PAYLOAD ? { ...quad, object: quad.object.replace(`\\"jobId\\":\\"${from}\\"`, `\\"jobId\\":\\"${to}\\"`) } : quad));

  it('is not trusted: z is stored under its own subject but names job x, and the subject x holds a payload that names y; the record behind z stays', async () => {
    // Admission reads z as job x (the payload's id); the sweep can only delete it through the subject of its own id, which is a different record. Two corruptions, one outcome: keep.
    const w = await world([fin('x', 'other', 5), fin('z', 'k', 10), fin('m', 'k', 20)], (quads, spec) => (spec.id === 'x' ? rename('x', 'y')(quads) : spec.id === 'z' ? rename('z', 'x')(quads) : quads));
    const results = await drain(newRetention(w.publisher, { batchSize: 1 }));
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(deletedIds(results)).toEqual([]);
    expect(await present(w.store, 'm')).not.toBe('');
  });

  it('is refused without a lookup when its id is not one the job-id grammar allows: the batch does not fail and the record behind it stays', async () => {
    const w = await world([fin('z', 'k', 10), fin('m', 'k', 20)], (quads, spec) => (spec.id === 'z' ? rename('z', 'bad id> } #')(quads) : quads));
    const results = await drain(newRetention(w.publisher, { batchSize: 1 }));
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(deletedIds(results)).toEqual([]);
    expect(await present(w.store, 'm')).not.toBe('');
  });
});

describe('records of one key that finished at the same instant', () => {
  // The key's order is by acceptance (then job id); the scan walks by finish time and the rows of ONE finish time by subject (the tie walk across batches reads them so,
  // and every batch is judged so, #3554). So a pass lets a key's records go only up to the first one the walk meets no later than the one before it: a record that tied
  // with an older one and sorts before it by subject is met first, and then it waits, with every record behind it. Comparing the finish time and then the subject is
  // what these cases pin.

  it('the scan meets the newer of two tied records first: it is kept, the older one goes, and the newer one goes in the next pass', async () => {
    // b-old accepted on day 10, a-new on day 20, both finished on day 30: the tie walk meets a-new first (subject order), with b-old still in front of it in the key
    const order = ['b-old', 'a-new'];
    const specs = [fin('b-old', 'k', 10, 30), fin('a-new', 'k', 20, 30)];
    let t = NOW;
    const w = await world(specs);
    const retention = newRetention(w.publisher, { batchSize: 1, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await retention.runBatch();
    expect(first.scanned).toBe(1);
    expect(deletedIds([first])).toEqual([]);                                       // a-new must not go while b-old stays
    expect(kept([first])).toEqual({ older_sibling_pending: 1 });
    expect(await idsOf(w)).toEqual(['a-new', 'b-old']);
    await expectSuffix(w, order, 'after the first batch');
    const rest = await walk(retention, w, order, 'pass 1');
    expect(deletedIds(rest)).toEqual(['b-old']);
    expect(await idsOf(w)).toEqual(['a-new']);
    t = NOW + 30 * HOUR;                                                           // the next pass: nothing stands in front of a-new
    expect(deletedIds(await walk(retention, w, order, 'pass 2'))).toEqual(['a-new']);
    expect(await idsOf(w)).toEqual([]);
    // report mode names the same first pass
    const reportWorld = await world(specs);
    expect(wouldDeleteIds(await drain(newRetention(reportWorld.publisher, { mode: 'report', batchSize: 1 })))).toEqual(['b-old']);
  });

  it.each([
    ['one batch each', { batchSize: 1 }],
    ['all in one hold', {}],
  ])('three records, a strict rise then a tie the scan meets newest first (%s): the newest waits, the two in front of it go', async (_name, over) => {
    // c1 (day 5, finished 25), c2 (day 10, finished 30), b3 (day 20, finished 30): the walk meets c1, then b3 before c2
    const order = ['c1', 'c2', 'b3'];
    const w = await world([fin('c1', 'k', 5, 25), fin('c2', 'k', 10, 30), fin('b3', 'k', 20, 30)]);
    const results = await walk(newRetention(w.publisher, over), w, order, 'pass 1');
    expect(deletedIds(results)).toEqual(['c1', 'c2']);
    expect(kept(results)).toEqual({ older_sibling_pending: 1 });
    expect(await idsOf(w)).toEqual(['b3']);
  });

  it('the scan meets the OLDER of two tied records first, a batch apart: delete takes both in one pass, in order, and report names both (#3554)', async () => {
    // a-old accepted on day 10, b-new on day 20, both finished on day 30. Delete removes a-old in batch 1, so b-new leads the key when batch 2 meets it. Report removes
    // nothing, so a-old is still in front of b-new when batch 2 meets it: the walk met a-old first (it sorts first by subject), so b-new is in the run and goes as well.
    // Comparing finish times alone kept b-new in report, which then named fewer records than the first delete pass removed.
    const order = ['a-old', 'b-new'];
    const specs = [fin('a-old', 'k', 10, 30), fin('b-new', 'k', 20, 30)];
    const w = await world(specs);
    expect(deletedIds(await walk(newRetention(w.publisher, { batchSize: 1 }), w, order, 'delete'))).toEqual(['a-old', 'b-new']);
    const reportWorld = await world(specs);
    const report = await drain(newRetention(reportWorld.publisher, { mode: 'report', batchSize: 1 }));
    expect(wouldDeleteIds(report)).toEqual(['a-old', 'b-new']);
    expect(kept(report)).toEqual({});
  });

  it.each(['the engine\'s', 'the reverse'] as const)('inside one batch, tied rows in %s subject order are judged by subject: both modes take them oldest first, one hold each (#3554)', async (engine) => {
    // The same two records, one batch, one candidate per hold. The scan's ORDER BY ?finalizedAt leaves two rows of one finish time in any order the engine likes, and one
    // that answers b-new first must change nothing: a batch judges its rows by finish time and then by subject, the order the key rule compares them in. Judged in the
    // answer's order, b-new would go in the first hold while a-old, older in its key, was still there.
    const order = ['a-old', 'b-new'];
    const specs = [fin('a-old', 'k', 10, 30), fin('b-new', 'k', 20, 30)];
    const reversed: SpyHooks = engine === 'the engine\'s' ? {} : {
      rewrite: async (entry, run) => {
        const answer = await run();
        if (entry.source !== 'publisher.asyncLift.retention.scan' || answer.type !== 'bindings') return answer;
        const at = (row: Record<string, string>) => Number(/^"(\d+)"/.exec(row['finalizedAt'] ?? '')?.[1]);
        return { ...answer, bindings: [...answer.bindings].sort((x, y) => at(x) - at(y) || (x['job']! < y['job']! ? 1 : -1)) };
      },
    };
    for (const mode of ['delete', 'report'] as const) {
      const w = await world(specs);
      const spy = spyStore(w.store, reversed);
      const results = await walk(newRetention(publisherOver(spy.store), { mode, sliceSize: 1 }), w, order, `${engine} ${mode}`);
      expect(results.reduce((n, r) => n + r.holds, 0), mode).toBe(2);
      if (mode === 'delete') expect(removedJobIds(spy.log), mode).toEqual(['a-old', 'b-new']);
      expect(mode === 'delete' ? deletedIds(results) : wouldDeleteIds(results), mode).toEqual(['a-old', 'b-new']);
    }
  });
});

describe('the mark of a key: the oldest record the walk kept, in the key\'s own order (acceptance time, then job id)', () => {
  it('two records accepted in the same millisecond, met newer first (online review 4394031865): the newer one waits, the older one goes when the walk reaches it, the newer one in the next pass', async () => {
    // a and b share their acceptance time, so the job id orders them: a is the older. a finished on day 40, b on day 30, one row per batch: the walk meets b first, with a in front
    // of it, so b waits and becomes the key's mark. Then it meets a, which comes BEFORE the mark in the key's order, and a goes. A mark of the acceptance time alone held a back
    // too (it was accepted at the mark's millisecond), and every pass then kept both.
    const order = ['a', 'b'];
    const specs = [fin('a', 'k', 10, 40), fin('b', 'k', 10, 30)];
    let t = NOW;
    const w = await world(specs);
    const retention = newRetention(w.publisher, { batchSize: 1, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await walk(retention, w, order, 'pass 1');
    expect(deletedIds(first)).toEqual(['a']);
    expect(kept(first)).toEqual({ older_sibling_pending: 1 });
    expect(await idsOf(w)).toEqual(['b']);
    t = NOW + 30 * HOUR;                                                           // the next pass: nothing stands in front of b
    expect(deletedIds(await walk(retention, w, order, 'pass 2'))).toEqual(['b']);
    expect(await idsOf(w)).toEqual([]);
    // report names no more than delete removes: a, in every pass (it removes nothing, so b keeps finding a in front of it)
    const reportWorld = await world(specs);
    let r = NOW;
    const report = newRetention(reportWorld.publisher, { mode: 'report', batchSize: 1, now: () => r, rescanIntervalMs: 24 * HOUR });
    expect(wouldDeleteIds(await walk(report, reportWorld, order, 'report pass 1'))).toEqual(['a']);
    r = NOW + 30 * HOUR;
    expect(wouldDeleteIds(await walk(report, reportWorld, order, 'report pass 2'))).toEqual(['a']);
  });

  it.each([
    ['one batch each', { batchSize: 1 }],
    ['in one batch', {}],
  ])('a record accepted in the same millisecond as an older one the walk kept, and after it by job id, waits for it (%s)', async (_name, over) => {
    // a and b share their acceptance time (a first by id); a wallet lock names a. The plan of the key does not read the locks, and b finished after a, so only the mark a leaves
    // keeps b while a stays: the mark compares the job id too, and a record equal to it in acceptance time but after it by id is after it.
    const order = ['a', 'b'];
    const w = await world([fin('a', 'k', 10, 30), fin('b', 'k', 10, 40)]);
    await seedWalletLock(w.store, 'a', 'wallet-1', 'released');
    const results = await walk(newRetention(w.publisher, over), w, order, 'pass 1');
    expect(deletedIds(results)).toEqual([]);
    expect(kept(results)).toEqual({ bound_obligation: 1, older_sibling_pending: 1 });
    expect(await idsOf(w)).toEqual(['a', 'b']);
  });

  it.each([
    ['newer kept first, then older', { p1: 20, p2: 30, p3: 10 }],
    ['older kept first, then newer', { p1: 10, p2: 30, p3: 20 }],
  ] as const)('three records accepted in one millisecond, two of them kept (%s): p2, between the two by job id, waits while p1 stays', async (_name, finished) => {
    // p1, p2 and p3 share their acceptance time, so the job id orders them; a wallet lock names p1, one row per batch. The plan does not read the locks and p2 finished after p1,
    // so only the mark keeps p2. It must move to p1 when the walk keeps p1 after p3 (the first case: a mark of the acceptance time alone, compared with `<`, stays on p3), and
    // stay on p1 when the walk keeps p3 after p1 (the second: compared with `<=`, p3 takes it). Either way p2 would go while the older p1 stays.
    const order = ['p1', 'p2', 'p3'];
    const w = await world([fin('p1', 'k', 10, finished.p1), fin('p2', 'k', 10, finished.p2), fin('p3', 'k', 10, finished.p3)]);
    await seedWalletLock(w.store, 'p1', 'wallet-1', 'released');
    const results = await walk(newRetention(w.publisher, { batchSize: 1 }), w, order, 'pass 1');
    expect(deletedIds(results)).toEqual([]);
    expect(kept(results)).toEqual({ bound_obligation: 1, older_sibling_pending: 2 });
    expect(await idsOf(w)).toEqual(['p1', 'p2', 'p3']);
  });

  it('the record that is the mark, met again later in the walk and deletable by then, is not held back by itself', async () => {
    // j is stored with a second, stray finish time (day 10; its payload and its own triple say day 15). The walk meets it at day 10 and keeps it (index_mismatch): j is the key's
    // mark. The stray triple is removed before the next batch, which meets j again at day 15, where the index agrees. Nothing older than j was kept, so j goes in this pass.
    const order = ['j'];
    const w = await world([fin('j', 'k', 5, 15)], (quads) => [...quads, { subject: jobSubject('j'), predicate: CONTROL_FINALIZED_AT, object: `"${Math.round(10 * DAY)}"${INTEGER}`, graph: DEFAULT_CONTROL_GRAPH_URI }]);
    const stray = { subject: jobSubject('j'), predicate: CONTROL_FINALIZED_AT, object: `"${Math.round(10 * DAY)}"${INTEGER}`, graph: DEFAULT_CONTROL_GRAPH_URI };
    const results = await walk(newRetention(w.publisher, { batchSize: 1 }), w, order, 'pass 1', async (batch) => { if (batch === 0) await w.store.delete([stray]); });
    expect(kept(results)).toEqual({ index_mismatch: 1 });
    expect(deletedIds(results)).toEqual(['j']);
  });

  it('the oldest record kept is met BEFORE a newer one kept: the mark stays on the oldest, and a record between the two waits', async () => {
    // A (finished day 10), B (day 30), C (day 20), accepted in that order; wallet locks name A and C. The walk meets A (kept), C (kept), then B. The plan does not read the locks and
    // B's finish rises after A's, so only the mark keeps B: it must still be A, the OLDER record kept, not C, the one kept last (which is behind B).
    const order = ['A', 'B', 'C'];
    let t = NOW;
    const w = await world([fin('A', 'k', 1, 10), fin('B', 'k', 2, 30), fin('C', 'k', 3, 20)]);
    await seedWalletLock(w.store, 'A', 'wallet-1', 'released');
    await seedWalletLock(w.store, 'C', 'wallet-2', 'released');
    const retention = newRetention(w.publisher, { batchSize: 1, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await walk(retention, w, order, 'pass 1');
    expect(deletedIds(first)).toEqual([]);
    expect(kept(first)).toEqual({ bound_obligation: 2, older_sibling_pending: 1 });
    await w.store.deleteByPattern({ graph: DEFAULT_WALLET_LOCK_GRAPH_URI });         // the locks are gone: A and B go, C (finished before B) waits for the pass after
    t = NOW + 30 * HOUR;
    expect(deletedIds(await walk(retention, w, order, 'pass 2'))).toEqual(['A', 'B']);
    t = NOW + 60 * HOUR;
    expect(deletedIds(await walk(retention, w, order, 'pass 3'))).toEqual(['C']);
  });

  it('an older record kept because its stored finish time disagreed, repaired behind the cursor before the next batch: the records behind it still wait', async () => {
    // A's payload says day 10, its stored finish time day 15: the walk meets it at day 15 and keeps it (index_mismatch). Before the next batch the index is repaired to day 10,
    // behind the cursor, so the walk does not meet A again in this pass, and the plan of the key now reads A as an old finalized record it could delete: only the mark A left
    // keeps B and C (the key's newest) while A stays. The next pass meets A at day 10 and takes the three in order.
    const order = ['A', 'B', 'C'];
    let t = NOW;
    const w = await world([fin('A', 'k', 1, 10), fin('B', 'k', 2, 20), fin('C', 'k', 3, 30)],
      (quads, spec) => (spec.id !== 'A' ? quads : quads.map((quad) => (quad.predicate === CONTROL_FINALIZED_AT ? { ...quad, object: `"${Math.round(15 * DAY)}"${INTEGER}` } : quad))));
    const retention = newRetention(w.publisher, { batchSize: 1, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await walk(retention, w, order, 'pass 1', async (batch) => { if (batch === 0) await setFinishIndex(w, 'A', 10); });
    expect(deletedIds(first)).toEqual([]);
    expect(kept(first)).toEqual({ index_mismatch: 1, older_sibling_pending: 2 });
    t = NOW + 30 * HOUR;
    expect(deletedIds(await walk(retention, w, order, 'pass 2'))).toEqual(['A', 'B', 'C']);
  });

  it('a record met before an older one of its key waits and becomes the mark, so the newest record, met after the older one went, waits too (the mutation review\'s scenario)', async () => {
    // A (accepted day 10, finished 31), B (day 20, finished 25), C (day 30, finished 32), one row per batch. The walk meets B first: A stands in front of it, B waits (the mark).
    // Then A, which goes. Then C: with A gone, the plan of the key is B, C, rising, so only the mark B left keeps C (the key's newest) while B stays.
    const order = ['A', 'B', 'C'];
    let t = NOW;
    const w = await world([fin('A', 'k', 10, 31), fin('B', 'k', 20, 25), fin('C', 'k', 30, 32)]);
    const retention = newRetention(w.publisher, { batchSize: 1, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await walk(retention, w, order, 'pass 1');
    expect(deletedIds(first)).toEqual(['A']);
    expect(kept(first)).toEqual({ older_sibling_pending: 2 });
    t = NOW + 30 * HOUR;
    expect(deletedIds(await walk(retention, w, order, 'pass 2'))).toEqual(['B', 'C']);
  });

  it.each([
    ['one batch each', { batchSize: 1 }],
    ['in one batch', {}],
  ])('a key whose records finished in the reverse of their acceptance order loses one record per pass, oldest first (%s)', async (_name, over) => {
    // A (accepted day 10, finished 50), B (day 20, finished 40), C (day 30, finished 30). The walk meets C, then B, then A. A record met after a successor goes in that pass only
    // if it is in the rising run from the key's oldest remaining record (and before the key's mark): A is that record; B, met after C, is not in the run, because A (finished
    // later) is still in front of it. So B waits for the second pass, C for the third.
    const order = ['A', 'B', 'C'];
    let t = NOW;
    const w = await world([fin('A', 'k', 10, 50), fin('B', 'k', 20, 40), fin('C', 'k', 30, 30)]);
    const retention = newRetention(w.publisher, { ...over, now: () => t, rescanIntervalMs: 24 * HOUR });
    const passes: string[][] = [];
    for (let pass = 0; pass < 3; pass++) {
      t = NOW + pass * 30 * HOUR;
      passes.push(deletedIds(await walk(retention, w, order, `pass ${pass + 1}`)));
    }
    expect(passes).toEqual([['A'], ['B'], ['C']]);
  });

  it.each(['delete', 'report'] as const)('%s mode: a record met after a successor that does not lead the rising run from the key\'s oldest remaining record, but is in it, goes in the same pass', async (mode) => {
    // Z (another key, finished day 15), X (accepted day 1, finished 25), R (day 2, finished 30), S (day 3, finished 20), two rows per batch. Batch 1 is Z and S: the run from X
    // is X, R (S finished before R), so S waits and is the key's mark. Batch 2 is X and R: both are in the run and before the mark, so both go. R, accepted before S, finished and
    // met after it, goes in that pass although X, not R, leads the run.
    const order = ['X', 'R', 'S'];
    let t = NOW;
    const w = await world([fin('Z', 'z', 14, 15), fin('X', 'k', 1, 25), fin('R', 'k', 2, 30), fin('S', 'k', 3, 20)]);
    const retention = newRetention(w.publisher, { mode, batchSize: 2, now: () => t, rescanIntervalMs: 24 * HOUR });
    const first = await walk(retention, w, order, 'pass 1');
    expect(mode === 'delete' ? deletedIds(first) : wouldDeleteIds(first)).toEqual(['Z', 'X', 'R']);
    expect(kept(first)).toEqual({ older_sibling_pending: 1 });
    if (mode === 'report') return;
    expect(await idsOf(w)).toEqual(['S']);
    t = NOW + 30 * HOUR;
    expect(deletedIds(await walk(retention, w, order, 'pass 2'))).toEqual(['S']);
  });
});
