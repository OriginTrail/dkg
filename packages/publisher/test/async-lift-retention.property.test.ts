import { expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';
import {
  DAY, NOW, WINDOW, createRetentionTemplates, faultyStore, pick, present, rng, seedKeyed, type RetentionTemplates,
} from './_helpers/lift-retention-fixtures.js';
import { drain, newRetention } from './_helpers/lift-retention-sweep.js';
import { bindingOracle, genPopulation, keyedOf, prefixOracle } from './_helpers/lift-retention-population.js';

// AC7 (OT-RFC-73) for the publisher queue: retention never deletes a job that is not finalized (so never a failed, held, non-terminal or recoverable one), deletes only what D-6
// allows (a finalized job 7 days after it finished), never a job dated after `now`, never changes the binding decision of a lifecycle key, and keeps a key's newest record in
// every intermediate state. Each fast-check run is one random population of lifecycle keys with random histories (every state the queue has, old and young finalized
// records, records dated in the future, records that finished out of order), a random mode, batch and slice size, and a store that may fail in the middle of a delete;
// it replays from the integer seed fast-check prints. The oracle is written from the generator's own knowledge of what it built (the STATE of each record and the order of
// the key), not from the product's predicates: its binding rule is re-stated from the documented admission rule, not imported. The PR budget is the repository default
// (100 runs, fixed seed); the nightly profile raises it through DKG_PROPERTY_RUNS (1,000) and DKG_PROPERTY_SEED.

const options = propertyOptions();
const GRAPH = 'urn:dkg:publisher:control-plane';

interface Tally {
  cases: number; deleted: number; keptBehindFailed: number; inversions: number; futureDated: number; faultsInjected: number; keys: number; reportEqualsDelete: number; clockSkips: number;
}

async function oneCase(seed: number, templates: RetentionTemplates, tally: Tally): Promise<void> {
  const r = rng(seed);
  const recs = genPopulation(r);
  const specs = recs.map((rec) => rec.spec);
  const byKey = keyedOf(recs);
  const batchSize = pick(r, [1, 2, 5, 100]);
  const sliceSize = pick(r, [1, 3, 10]);
  const injectFault = r() < 0.5;

  // ---- the oracle, from the spec alone
  const expectedPrefix = new Map<string, string[]>();                                           // per key: ids a full run removes
  for (const [key, group] of byKey) expectedPrefix.set(key, prefixOracle(group, NOW).map((s) => s.id));
  const rawOld = specs.filter((s) => s.kind === 'raw' && NOW - s.finalizedAt! >= WINDOW).map((s) => s.id);
  const expectedDeleted = new Set([...expectedPrefix.values()].flat().concat(rawOld));
  const bindingBefore = new Map([...byKey].map(([key, group]) => [key, bindingOracle(group)] as const));

  const store = new OxigraphStore();
  const reportStore = new OxigraphStore();
  try {
    await seedKeyed(store, templates, specs);
    await seedKeyed(reportStore, templates, specs);
    const before = new Map<string, string>();
    for (const s of specs) before.set(s.id, await present(store, s.id, GRAPH));

    const publisherOver = (s: OxigraphStore) => new TripleStoreAsyncLiftPublisher(s, { now: () => NOW, idGenerator: () => 'unused' });
    const view = async (p: TripleStoreAsyncLiftPublisher, key: string): Promise<string[]> => {
      const lookup = await p.lookupKnowledgeAssetVmPublishJobByIntent({ contextGraphId: 'music-social', name: key });
      return lookup.kind === 'active' ? [lookup.job.jobId] : lookup.kind === 'conflict' ? lookup.jobs.map((j) => j.jobId) : [];
    };
    // the state of the store, as the property reads it: which job ids still have their job subject
    const left = async (p: TripleStoreAsyncLiftPublisher) => new Set((await p.list()).map((job) => job.jobId));

    // ---- report mode on the same snapshot names exactly what the first delete pass removes
    const reportPublisher = publisherOver(reportStore);
    const report = await drain(newRetention(reportPublisher, { mode: 'report', batchSize, sliceSize }));
    expect(report.every((res) => res.error === undefined && res.anomalies === 0)).toBe(true);
    const wouldDelete = new Set(report.flatMap((res) => res.wouldDeleteJobs.map((j) => j.jobId)));
    for (const s of specs) expect(await present(reportStore, s.id, GRAPH), `report mode touched ${s.id}`).toBe(before.get(s.id));

    // ---- delete mode: optionally with a store that fails in the middle, then healthy passes to the end
    const publisher = publisherOver(store);
    const initialView = new Map<string, string[]>();
    for (const key of byKey.keys()) initialView.set(key, await view(publisher, key));
    for (const [key, ids] of bindingBefore) expect(initialView.get(key), `the production binding of ${key} before`).toEqual(ids);

    let faultAt = -1;
    if (injectFault) {
      // count the calls of a clean run on a copy to pick a call that is really part of it
      const probe = new OxigraphStore();
      try {
        await seedKeyed(probe, templates, specs);
        let calls = 0;
        const counting = faultyStore(probe, () => { calls++; return undefined; });
        await drain(newRetention(publisherOver(counting as OxigraphStore), { batchSize, sliceSize }));
        faultAt = Math.floor(r() * Math.max(1, calls));
      } finally { await probe.close(); }
    }
    let n = 0;
    const target = injectFault ? faultyStore(store, () => (n++ === faultAt ? new Error('injected') : undefined)) : store;
    const first = await drain(newRetention(publisherOver(target as OxigraphStore), { batchSize, sliceSize }));
    if (injectFault && first.some((res) => res.error !== undefined)) tally.faultsInjected += 1;

    // the state right after the (possibly failed) first run: AC7 holds at every stage
    const stage = async () => {
      const present_ = await left(publisher);
      for (const s of specs) {
        if (!present_.has(s.id)) {
          expect(expectedDeleted.has(s.id), `${s.id} (${s.state}) was removed but the spec does not allow it`).toBe(true);
          expect(['finalized'].includes(s.state), `${s.id} is not finalized`).toBe(true);
        }
      }
      for (const [key, group] of byKey) {
        const ordered = [...group].sort((a, b) => a.acceptedAt - b.acceptedAt);
        const remaining = ordered.filter((s) => present_.has(s.id));
        // what is gone is a prefix of the oldest-first order: the remaining records are a suffix, so the newest is there until the last one goes
        expect(remaining.map((s) => s.id), `${key}: the records left are a suffix of the key`).toEqual(ordered.slice(ordered.length - remaining.length).map((s) => s.id));
        // every record that is not deleted is untouched
        for (const s of remaining) expect(await present(store, s.id, GRAPH), `${s.id} must be untouched`).toBe(before.get(s.id));
        // the binding decision of the key is the one it had, by the oracle and by the production selector
        expect(bindingOracle(remaining), `${key}: oracle binding`).toEqual(bindingBefore.get(key));
        expect(await view(publisher, key), `${key}: production binding`).toEqual(bindingBefore.get(key));
      }
    };
    await stage();

    let t = NOW;
    const healthy = newRetention(publisher, { batchSize, sliceSize, now: () => t, rescanIntervalMs: 1000 });
    for (let pass = 0; pass < 8; pass++) {
      const results = await drain(healthy);
      expect(results.every((res) => res.error === undefined && res.anomalies === 0), `pass ${pass}`).toBe(true);
      await stage();
      t += 5000;
    }
    const finalLeft = await left(publisher);
    expect(new Set(specs.filter((s) => !finalLeft.has(s.id)).map((s) => s.id)), 'exactly what the spec says is gone').toEqual(expectedDeleted);
    // report names what the first pass of delete removes from the same snapshot (a record that finished out of order waits for the next pass in both modes)
    for (const id of wouldDelete) expect(expectedDeleted.has(id), `${id} reported but not allowed`).toBe(true);
    if (!injectFault) {
      expect(new Set(first.flatMap((res) => res.deletedJobs.map((j) => j.jobId))), 'report == the first delete pass, on the same snapshot').toEqual(wouldDelete);
      tally.reportEqualsDelete += 1;
    }

    // ---- a clock that leapt a year ahead deletes nothing, ever
    const beforeLeap = finalLeft;
    let mono = 0;
    const leapt = newRetention(publisher, { now: () => (mono === 0 ? NOW : NOW + 400 * DAY + mono), monotonicNow: () => mono, intervalMs: 60_000 });
    await leapt.runBatch();
    mono = 60_000;
    const skipped = await leapt.runBatch();
    expect(skipped.skipped).toBe('clock_jump');
    expect(await left(publisher)).toEqual(beforeLeap);
    tally.clockSkips += 1;

    // ---- floors for the claim
    for (const rec of recs) {
      if (rec.kind === 'future-update' || rec.kind === 'future-finish') tally.futureDated += 1;
    }
    for (const [, group] of byKey) {
      const ordered = [...group].sort((a, b) => a.acceptedAt - b.acceptedAt);
      const firstBlocker = ordered.findIndex((s) => !prefixOracle(ordered, NOW).some((p) => p.id === s.id));
      if (firstBlocker >= 0 && ordered.slice(firstBlocker + 1).some((s) => s.state === 'finalized' && NOW - (s.finalizedAt ?? NOW) >= WINDOW && s.updatedAt === undefined)) tally.keptBehindFailed += 1;
      const prefix = prefixOracle(ordered, NOW);
      if (prefix.some((p, i) => prefix.slice(0, i).some((q) => q.finalizedAt! >= p.finalizedAt!))) tally.inversions += 1;
      tally.keys += 1;
    }
    tally.deleted += expectedDeleted.size;
    tally.cases += 1;
  } finally {
    await store.close();
    await reportStore.close();
  }
}

it('retention never deletes anything but old finalized records, never changes the binding of a key, keeps its newest record at every stage, and misses nothing the spec allows (random keys, histories, modes, slices and store failures)', async () => {
  const templates = await createRetentionTemplates();
  const tally: Tally = { cases: 0, deleted: 0, keptBehindFailed: 0, inversions: 0, futureDated: 0, faultsInjected: 0, keys: 0, reportEqualsDelete: 0, clockSkips: 0 };
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 0x7fffffff }), (seed) => oneCase(seed, templates, tally)),
    { seed: options.seed, numRuns: options.numRuns, endOnFailure: true, ...(options.path ? { path: options.path } : {}) });
  // The generator must really reach what the claim is about. The floors apply from the 100-run default up and only to a full run (a replay of one failing path
  // executes just the cases along it).
  if (!options.path) {
    expect(tally.cases).toBe(options.numRuns);
    if (options.numRuns >= 100) {
      expect(tally.deleted).toBeGreaterThan(options.numRuns);                           // many records really deleted: the property is not vacuous
      expect(tally.keptBehindFailed).toBeGreaterThan(10);                                // old finalized records an older sibling really held back
      expect(tally.inversions).toBeGreaterThan(0);                                       // finished out of order
      expect(tally.futureDated).toBeGreaterThan(0);
      expect(tally.faultsInjected).toBeGreaterThan(10);                                  // runs that really stopped in the middle
      expect(tally.clockSkips).toBe(options.numRuns);
    }
  }
  console.log(`publisher retention AC7 property: seed=${options.seed} runs=${tally.cases} deleted=${tally.deleted} keys=${tally.keys} held-back-keys=${tally.keptBehindFailed} out-of-order-keys=${tally.inversions} future-dated=${tally.futureDated} faults=${tally.faultsInjected}`);
}, 600_000);
