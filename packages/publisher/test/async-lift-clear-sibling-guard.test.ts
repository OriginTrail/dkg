/**
 * OT-RFC-73 P11: the sibling guard of the publisher queue's bulk `clear(status)` (async-lift-guarded-clear.ts), always on and independent of the retention mode.
 *
 * `async-lift-bulk-clear-characterization.test.ts` shows what changed for the two cases that used to resurrect an older failed job. This file pins the guard itself: what it
 * reads and when, how it orders and locks its removals, what it does on a key it cannot read or a store that fails, and, over random populations judged by an independent
 * oracle, that bulk clear of finalized jobs never changes any key's binding and bulk clear of failed jobs never makes a kept record bind a key.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { CONTROL_LIFECYCLE_KEY, CONTROL_PAYLOAD, CONTROL_STATUS, DEFAULT_CONTROL_GRAPH_URI, jobSubject } from '../src/async-lift-control-plane.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import {
  NOW, at, bySource, createRetentionTemplates, faultyStore, fin, keyedQuads, pick, present, rng, seedKeyed, spyStore, type KeyedSpec, type RetentionTemplates,
} from './_helpers/lift-retention-fixtures.js';
import { bindingOracle, genPopulation, keyedOf, type Rec } from './_helpers/lift-retention-population.js';

let templates: RetentionTemplates;
beforeAll(async () => { templates = await createRetentionTemplates(); });
const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

const CLEAR_SIBLINGS = 'publisher.asyncLift.clear.siblings';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function setup(specs: readonly KeyedSpec[], hooks: Parameters<typeof spyStore>[1] = {}) {
  const raw = new OxigraphStore();
  stores.push(raw);
  await seedKeyed(raw, templates, specs);
  const spy = spyStore(raw, hooks);
  const mk = (store: OxigraphStore, id = 'fresh') => new TripleStoreAsyncLiftPublisher(store, { now: () => NOW, idGenerator: () => id });
  return { raw, ...spy, publisher: mk(spy.store), other: mk(raw), mk };
}
const idsLeft = async (p: TripleStoreAsyncLiftPublisher): Promise<string[]> => (await p.list()).map((job) => job.jobId).sort();
const view = async (p: TripleStoreAsyncLiftPublisher, key: string): Promise<string[]> => {
  const lookup = await p.lookupKnowledgeAssetVmPublishJobByIntent({ contextGraphId: 'music-social', name: key });
  return lookup.kind === 'active' ? [lookup.job.jobId] : lookup.kind === 'conflict' ? lookup.jobs.map((job) => job.jobId) : [];
};

describe('what the guard reads', () => {
  it('reads the records of a key only for a job it has found clearable and that has a key: none for a held, a recovery-lane or a keyless job', async () => {
    const t = await setup([
      fin('f1', 'a', 10), fin('f2', 'b', 20), at('hld', 'c', 'held', 30), at('rec', 'd', 'recovery', 31), { ...fin('raw', 'e', 40), kind: 'raw' }, at('acc', 'f', 'accepted', 50),
    ]);
    expect(await t.publisher.clear('finalized')).toBe(3);                          // f1, f2 and the raw lift
    expect(bySource(t.log, CLEAR_SIBLINGS)).toHaveLength(2);                       // f1's key and f2's key
    t.log.length = 0;
    expect(await t.publisher.clear('failed')).toBe(0);                             // the held and the recovery-lane job are not clearable
    expect(bySource(t.log, CLEAR_SIBLINGS)).toEqual([]);
    expect(await idsLeft(t.other)).toEqual(['acc', 'hld', 'rec']);
  });

  it('reads them through the control path labels of the bulk clear, under the claim lock and the job lock, one job at a time and oldest first', async () => {
    const t = await setup([fin('f3', 'c', 30), fin('f1', 'a', 10), fin('f2', 'b', 20)]);
    await t.publisher.clear('finalized');
    const sequence = t.log.filter((e) => e.source === CLEAR_SIBLINGS || e.source === 'publisher.asyncLift.deleteJob').map((e) => (e.source === CLEAR_SIBLINGS ? 'siblings' : 'delete'));
    expect(sequence).toEqual(['siblings', 'delete', 'siblings', 'delete', 'siblings', 'delete']);
    const deletes = t.log.filter((e) => e.source === 'publisher.asyncLift.deleteJob').map((e) => (JSON.parse(e.text) as { subject: string }).subject.replace('urn:dkg:publisher:lift-job:', ''));
    expect(deletes).toEqual(['f1', 'f2', 'f3']);
  });
});

describe('how it removes', () => {
  it('removes the records before a failed sibling and keeps the ones behind it, oldest first', async () => {
    const t = await setup([fin('f1', 'k', 10), fin('f2', 'k', 12), at('x', 'k', 'terminal', 15), fin('f3', 'k', 20), fin('f4', 'k', 25)]);
    expect(await t.publisher.clear('finalized')).toBe(2);
    expect(await idsLeft(t.other)).toEqual(['f3', 'f4', 'x']);
    expect(await t.publisher.clear('failed')).toBe(1);                             // x is history behind f4: removing it promotes nothing
    expect(await idsLeft(t.other)).toEqual(['f3', 'f4']);
    expect(await t.publisher.clear('finalized')).toBe(2);                          // with the sibling gone nothing stands in front of them
    expect(await idsLeft(t.other)).toEqual([]);
  });

  it('keeps the newest record while an older failed sibling is kept, and keeps no more than it must: the record before that sibling goes', async () => {
    const t = await setup([fin('f0', 'k', 5), at('x', 'k', 'retryable', 10), fin('f1', 'k', 20)]);
    expect(await view(t.other, 'k')).toEqual([]);
    expect(await t.publisher.clear('finalized')).toBe(1);
    expect(await idsLeft(t.other)).toEqual(['f1', 'x']);
    expect(await view(t.other, 'k')).toEqual([]);                                  // x is still hidden behind f1
  });

  it('waits for the claim lock like the targeted clear does, where it used to take only the job lock: an admission in flight finishes first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reachedLock = false;
    const t = await setup([fin('f1', 'k', 10)], {
      before: async (entry) => {
        if (entry.source === 'publisher.asyncLift.findActiveVmPublish' && !reachedLock) { reachedLock = true; await gate; }
      },
    });
    const admission = t.publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'other' }));
    await tick(); await tick();
    expect(reachedLock).toBe(true);
    const cleared = t.mk(t.store).clear('finalized');
    await tick(); await tick();
    expect(bySource(t.log, CLEAR_SIBLINGS)).toEqual([]);                          // not a single read of the guard, and no delete, while the admission holds the lock
    expect(await present(t.raw, 'f1')).not.toBe('');
    release();
    await admission;
    expect(await cleared).toBe(1);
    expect(await present(t.raw, 'f1')).toBe('');
  });

  it('leaves the earlier removals done and the later jobs intact when the store fails mid-pass, and never removes a record out of order', async () => {
    const specs = [fin('f1', 'k', 10), fin('f2', 'k', 20), fin('f3', 'k', 30), fin('f4', 'k', 40), at('live', 'k', 'accepted', 60)];
    for (let failAt = 0; failAt < 24; failAt++) {
      const raw = new OxigraphStore();
      stores.push(raw);
      await seedKeyed(raw, templates, specs);
      let n = 0;
      const publisher = new TripleStoreAsyncLiftPublisher(faultyStore(raw, () => (n++ === failAt ? new Error('injected') : undefined)), { now: () => NOW, idGenerator: () => 'x' });
      const outcome = await publisher.clear('finalized').then(() => 'done', () => 'failed');
      const left = await idsLeft(new TripleStoreAsyncLiftPublisher(raw, { now: () => NOW, idGenerator: () => 'x' }));
      const order = ['f1', 'f2', 'f3', 'f4'].filter((id) => left.includes(id));
      expect(left.includes('live'), `call ${failAt}`).toBe(true);
      expect(order, `call ${failAt} (${outcome})`).toEqual(['f1', 'f2', 'f3', 'f4'].slice(4 - order.length));        // what is left is a suffix: the newest goes last
      expect(await view(new TripleStoreAsyncLiftPublisher(raw, { now: () => NOW, idGenerator: () => 'x' }), 'k'), `call ${failAt}`).toEqual(['live']);
    }
  });
});

describe('a key it cannot read', () => {
  it('keeps the jobs of a key whose records do not decode, as admission cannot read it either, and clears the rest', async () => {
    const t = await setup([fin('good', 'good', 10), fin('victim', 'bad', 10), fin('also-good', 'good2', 20)]);
    await t.raw.insert([
      { subject: jobSubject('poison'), predicate: CONTROL_LIFECYCLE_KEY, object: '"music-social\\u001fbad\\u001f\\u001f"', graph: DEFAULT_CONTROL_GRAPH_URI },
      { subject: jobSubject('poison'), predicate: CONTROL_STATUS, object: '"accepted"', graph: DEFAULT_CONTROL_GRAPH_URI },
      { subject: jobSubject('poison'), predicate: CONTROL_PAYLOAD, object: '"{ garbage"', graph: DEFAULT_CONTROL_GRAPH_URI },
    ]);
    expect(await t.publisher.clear('finalized')).toBe(2);
    expect(await present(t.raw, 'victim')).not.toBe('');
    expect(await present(t.raw, 'good')).toBe('');
  });

  it('passes a store failure of the sibling read on: it is not a poisoned key', async () => {
    const t = await setup([fin('f1', 'k', 10)], { before: (entry) => { if (entry.source === CLEAR_SIBLINGS) throw new Error('store down'); } });
    await expect(t.publisher.clear('finalized')).rejects.toThrow('store down');
    expect(await present(t.raw, 'f1')).not.toBe('');
  });
});

describe('the targeted clear is the deliberate override and is not guarded', () => {
  it('clears the exact finalized job even where bulk clear keeps it, and the older failed job then binds the key: that is the operator\'s explicit choice', async () => {
    const t = await setup([at('x', 'k', 'retryable', 10), fin('f', 'k', 20)]);
    expect(await t.publisher.clear('finalized')).toBe(0);
    expect(await t.publisher.clearTerminalJob('f')).toEqual({ outcome: 'cleared' });
    expect(await view(t.other, 'k')).toEqual(['x']);
  });
});

describe('over random populations (an independent oracle)', () => {
  const options = propertyOptions();

  async function oneCase(seed: number, tally: { cases: number; kept: number; removed: number; promotionsAvoided: number }): Promise<void> {
    const r = rng(seed);
    const recs: Rec[] = genPopulation(r);
    const specs = recs.map((rec) => rec.spec);
    const byKey = keyedOf(recs);
    const status = pick(r, ['finalized', 'failed'] as const);
    const store = new OxigraphStore();
    try {
      await seedKeyed(store, templates, specs);
      const publisher = new TripleStoreAsyncLiftPublisher(store, { now: () => NOW, idGenerator: () => 'unused' });
      const before = new Map([...byKey].map(([key, group]) => [key, bindingOracle(group)] as const));
      for (const [key, ids] of before) expect(await view(publisher, key)).toEqual(ids);
      const removedCount = await publisher.clear(status);
      const left = new Set(await idsLeft(publisher));
      tally.removed += removedCount;
      for (const s of specs) {
        if (left.has(s.id)) continue;
        // only what bulk clear may take of that status, never a held job, never a recovery-lane one
        expect(status === 'finalized' ? s.state === 'finalized' : (s.state === 'retryable' || s.state === 'terminal'), `${s.id} (${s.state}) was removed by clear(${status})`).toBe(true);
      }
      for (const [key, group] of byKey) {
        const remaining = group.filter((s) => left.has(s.id));
        const after = bindingOracle(remaining);
        expect(await view(publisher, key), `${key}: production binding after clear(${status})`).toEqual(after);
        if (status === 'finalized') {
          // removing finalized records never changes who binds a key
          expect(after, `${key}: clear(finalized) changed the binding`).toEqual(before.get(key));
        } else {
          // removing failed records may vacate a key, never make a record bind it that did not before
          expect(after.every((id) => before.get(key)!.includes(id)), `${key}: clear(failed) promoted a kept record`).toBe(true);
        }
        // the key's newest record leaves last: what remains is a suffix of the key... except where the record is kept for a reason the pass does not remove (held, recovery lane, live)
        tally.kept += remaining.length;
        if (status === 'finalized' && group.some((s) => s.state !== 'finalized') && group.some((s) => s.state === 'finalized' && left.has(s.id))) tally.promotionsAvoided += 1;
      }
      tally.cases += 1;
    } finally {
      await store.close();
    }
  }

  it('never changes the binding of a key by clearing finalized jobs, and never makes a kept record bind a key by clearing failed ones', async () => {
    const tally = { cases: 0, kept: 0, removed: 0, promotionsAvoided: 0 };
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 0x7fffffff }), (seed) => oneCase(seed, tally)),
      { seed: options.seed, numRuns: options.numRuns, endOnFailure: true, ...(options.path ? { path: options.path } : {}) });
    if (!options.path && options.numRuns >= 100) {
      expect(tally.cases).toBe(options.numRuns);
      expect(tally.removed).toBeGreaterThan(options.numRuns / 2);
      expect(tally.promotionsAvoided).toBeGreaterThan(10);                          // finalized records the guard really kept behind a failed sibling
    }
    console.log(`bulk clear sibling guard property: seed=${options.seed} runs=${tally.cases} removed=${tally.removed} kept-behind-a-sibling-keys=${tally.promotionsAvoided}`);
  }, 300_000);

  it('keeps the guard from being a no-op: the same populations DO change a binding when the guard is skipped (the oracle can see a resurrection)', () => {
    // [older retryable x, newer finalized f]: removing f without the guard makes x bind. The oracle says so independently of the product.
    const group: KeyedSpec[] = [at('x', 'k', 'retryable', 10), fin('f', 'k', 20)];
    expect(bindingOracle(group)).toEqual([]);
    expect(bindingOracle(group.filter((s) => s.id !== 'f'))).toEqual(['x']);
    expect(keyedQuads(templates, group[0]!).length).toBeGreaterThan(0);
  });
});
