/**
 * OT-RFC-73 P11, publisher retention: the records of a lifecycle key leave OLDEST FIRST in every state the store can be in, so what a sweep leaves behind is always a
 * suffix of the key and the key's newest record is there until the last one goes (plan section 5.3, AC7).
 *
 * The sweep walks the finalized rows by finish time and judges each key from its records, a hold at a time. Three things can put an older record out of the way of a
 * newer one, and each case here builds one of them:
 *  - the sweep KEEPS the older record for a reason that can pass (it is dated after now, an older failed job stood in front of it, the key could not be read) and the
 *    scan moves on: the reason passes between two batches of ONE pass and the newer record, judged by a later batch, is no longer held back;
 *  - the older record is one the sweep can NEVER delete (a pre-upgrade payload it does not rewrite, a stored index the scan does not match): nothing held the newer
 *    record back at all.
 * A newer record goes only behind an older one the sweep deletes first. Binding never changes in these cases (what is left in front is finalized), which is why the
 * binding view is asserted too, but it is the ORDER that these tests are about.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher, type PublisherRetentionBatchResult } from '../src/index.js';
import { CONTROL_FINALIZED_AT, CONTROL_LIFECYCLE_KEY, CONTROL_PAYLOAD, CONTROL_STATUS, DEFAULT_CONTROL_GRAPH_URI, jobSubject } from '../src/async-lift-control-plane.js';
import {
  DAY, NOW, at, createRetentionTemplates, fin, keyedQuads, present, type KeyedSpec, type RetentionTemplates,
} from './_helpers/lift-retention-fixtures.js';
import { drain, newRetention } from './_helpers/lift-retention-sweep.js';

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
