import { expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';
import {
  DAY, NOW, WINDOW, createRetentionTemplates, faultyStore, pick, present, rng, seedKeyed, type KeyedSpec, type RetentionTemplates,
} from './_helpers/lift-retention-fixtures.js';
import { drain, newRetention } from './_helpers/lift-retention-sweep.js';
import { bindingOracle, genPopulation, keyOrder, keyedOf, prefixOracle, tiedKeys } from './_helpers/lift-retention-population.js';

// AC7 (OT-RFC-73) for the publisher queue: retention never deletes a job that is not finalized (so never a failed, held, non-terminal or recoverable one), deletes only what D-6
// allows (a finalized job 7 days after it finished), never a job dated after `now`, never changes the binding decision of a lifecycle key, and keeps a key's newest record in
// every intermediate state. Each fast-check run is one random population of lifecycle keys with random histories (every state the queue has, old and young finalized
// records, records dated in the future, records that finished out of order or at the same instant, records accepted in the same millisecond), a random mode, batch and slice size, and a store that may fail in
// the middle of a delete; it replays from the integer seed fast-check prints. The oracle is written from the generator's own knowledge of what it built (the STATE of
// each record and the order of the key), not from the product's predicates: its binding rule is re-stated from the documented admission rule, not imported. The PR budget is the repository default
// (100 runs, fixed seed); the nightly profile raises it through DKG_PROPERTY_RUNS (1,000) and DKG_PROPERTY_SEED.
// The healthy passes are RESTLESS first: between two batches of one pass the clock moves on (a record dated after now stops being so) and an operator clears a terminal failed job
// (a record an older failed job held back is free), and the population holds records the sweep can never delete (a pre-upgrade payload, a record without its finish-time index).
// The suffix rule is asserted after every batch that deleted anything, in the first run too: nothing may be deleted ahead of an older record of its key that stays.

const options = propertyOptions();
const GRAPH = 'urn:dkg:publisher:control-plane';

interface Tally {
  cases: number; deleted: number; keptBehindFailed: number; inversions: number; futureDated: number; faultsInjected: number; keys: number; reportEqualsDelete: number; clockSkips: number;
  heldByUnreachable: number; midPassClears: number; clockPassedFutureUpdate: number; tiedPrefixes: number; tiedNewestFirst: number; reportEqualsDeleteOnTie: number;
  sameMsNewerFirst: number;
}

async function oneCase(seed: number, templates: RetentionTemplates, tally: Tally): Promise<void> {
  const r = rng(seed);
  const recs = genPopulation(r);
  const specs = recs.map((rec) => rec.spec);
  const byKey = keyedOf(recs);
  const ties = tiedKeys(recs);
  const batchSize = pick(r, [1, 2, 5, 100]);
  const sliceSize = pick(r, [1, 3, 10]);
  const injectFault = r() < 0.5;

  // ---- the oracle, from the spec alone
  const expectedPrefix = new Map<string, string[]>();                                           // per key: ids a full run removes
  for (const [key, group] of byKey) expectedPrefix.set(key, prefixOracle(group, NOW).map((s) => s.id));
  const rawOldAt = (time: number) => specs.filter((s) => s.kind === 'raw' && time - s.finalizedAt! >= WINDOW).map((s) => s.id);
  const expectedDeleted = new Set([...expectedPrefix.values()].flat().concat(rawOldAt(NOW)));
  // terminal failed records an operator cleared between two batches; the spec of the key is the records that are left, and what it allows grows with the time
  const cleared = new Set<string>();
  const liveByKey = (): Map<string, KeyedSpec[]> => new Map([...byKey].map(([key, group]) => [key, group.filter((s) => !cleared.has(s.id))] as const));
  const allowedAt = (time: number): Set<string> => new Set([...liveByKey().values()].flatMap((group) => prefixOracle(group, time).map((s) => s.id)).concat(rawOldAt(time)));
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

    // AC7 holds at every stage. `time` is the clock of the latest batch: what is gone must be allowed by then.
    const stage = async (time: number, deep = true) => {                  // `deep` also reads every record back and asks the production binding selector: too slow after every batch
      const present_ = await left(publisher);
      const allowed = allowedAt(time);
      for (const s of specs) {
        if (!present_.has(s.id) && !cleared.has(s.id)) {
          expect(allowed.has(s.id), `${s.id} (${s.state}) was removed but the spec does not allow it`).toBe(true);
          expect(['finalized'].includes(s.state), `${s.id} is not finalized`).toBe(true);
        }
      }
      for (const [key, group] of liveByKey()) {
        const ordered = [...group].sort(keyOrder);
        const remaining = ordered.filter((s) => present_.has(s.id));
        // what is gone is a prefix of the oldest-first order: the remaining records are a suffix, so the newest is there until the last one goes
        expect(remaining.map((s) => s.id), `${key}: the records left are a suffix of the key`).toEqual(ordered.slice(ordered.length - remaining.length).map((s) => s.id));
        // every record that is not deleted is untouched
        if (deep) for (const s of remaining) expect(await present(store, s.id, GRAPH), `${s.id} must be untouched`).toBe(before.get(s.id));
        // the binding decision of the key is the one it had, by the oracle and by the production selector
        expect(bindingOracle(remaining), `${key}: oracle binding`).toEqual(bindingBefore.get(key));
        if (deep) expect(await view(publisher, key), `${key}: production binding`).toEqual(bindingBefore.get(key));
      }
    };

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
    const first = await drain(newRetention(publisherOver(target as OxigraphStore), { batchSize, sliceSize }), 200, async (res) => { if (res.deleted > 0) await stage(NOW, false); });
    if (injectFault && first.some((res) => res.error !== undefined)) tally.faultsInjected += 1;

    // the state right after the (possibly failed) first run
    await stage(NOW);

    // restless passes: between two batches of one pass the clock moves on and an operator clears a terminal failed job that has a newer record (it binds nothing)
    let t = NOW;
    const healthy = newRetention(publisher, { batchSize, sliceSize, now: () => t, rescanIntervalMs: 1000 });
    const clearable = specs.filter((s) => s.state === 'terminal' && byKey.get(s.key)!.some((other) => other.acceptedAt > s.acceptedAt));
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 12; i++) {
        const batchTime = t;
        const res = await healthy.runBatch();
        expect(res.error === undefined && res.anomalies === 0, `restless pass ${pass} batch ${i}`).toBe(true);
        await stage(batchTime, false);
        if (!res.hasMore && res.scanned === 0) break;
        t += Math.round(r() * 0.8 * DAY);
        const victim = clearable.length > 0 && r() < 0.4 ? pick(r, clearable) : undefined;
        if (victim !== undefined && !cleared.has(victim.id) && (await publisher.clearTerminalJob(victim.id)).outcome === 'cleared') { cleared.add(victim.id); tally.midPassClears += 1; }
      }
      t += 5000;
    }
    for (const rec of recs) if (rec.kind === 'future-update' && rec.spec.updatedAt! <= t) tally.clockPassedFutureUpdate += 1;

    // then the clock stands still and the sweep finishes what the spec allows
    let tEnd = t;
    for (let pass = 0; pass < 8; pass++) {
      tEnd = t;
      const results = await drain(healthy);
      expect(results.every((res) => res.error === undefined && res.anomalies === 0), `pass ${pass}`).toBe(true);
      await stage(tEnd);
      t += 5000;
    }
    const finalLeft = await left(publisher);
    expect(new Set(specs.filter((s) => !finalLeft.has(s.id) && !cleared.has(s.id)).map((s) => s.id)), 'exactly what the spec says is gone').toEqual(allowedAt(tEnd));
    // report names what the first pass of delete removes from the same snapshot (a record that finished out of order waits for the next pass in both modes), for a key two
    // of whose records finished at the same instant too (#3554): both modes walk such records by subject and compare them in that order, so delete having removed the older
    // one by the time it meets the newer one changes nothing. (The monotonic clock stands still here, so no hold runs out of budget: see async-lift-retention-holds.test.ts.)
    for (const id of wouldDelete) expect(expectedDeleted.has(id), `${id} reported but not allowed`).toBe(true);
    if (!injectFault) {
      const deletedFirst = new Set(first.flatMap((res) => res.deletedJobs.map((j) => j.jobId)));
      expect(deletedFirst, 'report == the first delete pass, on the same snapshot').toEqual(wouldDelete);
      if (specs.some((s) => ties.has(s.key) && wouldDelete.has(s.id))) tally.reportEqualsDeleteOnTie += 1;
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
      const ordered = [...group].sort(keyOrder);
      const unreachable = ordered.findIndex((s) => s.compat === true || s.unindexed === true);
      if (unreachable >= 0 && ordered.slice(unreachable + 1).some((s) => s.state === 'finalized' && NOW - (s.finalizedAt ?? NOW) >= WINDOW && s.updatedAt === undefined)) tally.heldByUnreachable += 1;
      const firstBlocker = ordered.findIndex((s) => !prefixOracle(ordered, NOW).some((p) => p.id === s.id));
      if (firstBlocker >= 0 && ordered.slice(firstBlocker + 1).some((s) => s.state === 'finalized' && NOW - (s.finalizedAt ?? NOW) >= WINDOW && s.updatedAt === undefined)) tally.keptBehindFailed += 1;
      const prefix = prefixOracle(ordered, NOW);
      if (prefix.some((p, i) => prefix.slice(0, i).some((q) => q.finalizedAt! >= p.finalizedAt!))) tally.inversions += 1;
      const tie = prefix.findIndex((p, i) => i > 0 && prefix[i - 1]!.finalizedAt === p.finalizedAt);
      if (tie > 0) { tally.tiedPrefixes += 1; if (prefix[tie]!.id < prefix[tie - 1]!.id) tally.tiedNewestFirst += 1; }
      // two records of the run accepted in the same millisecond, the newer one (by id) finished first: the walk meets it first (online review 4394031865)
      if (prefix.some((p, i) => i > 0 && prefix[i - 1]!.acceptedAt === p.acceptedAt && p.finalizedAt! < prefix[i - 1]!.finalizedAt!)) tally.sameMsNewerFirst += 1;
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
  const tally: Tally = {
    cases: 0, deleted: 0, keptBehindFailed: 0, inversions: 0, futureDated: 0, faultsInjected: 0, keys: 0, reportEqualsDelete: 0, clockSkips: 0,
    heldByUnreachable: 0, midPassClears: 0, clockPassedFutureUpdate: 0, tiedPrefixes: 0, tiedNewestFirst: 0, reportEqualsDeleteOnTie: 0, sameMsNewerFirst: 0,
  };
  // Count the turns the event loop takes while the cases run (the floor below). Every term Oxigraph hands back from a query is a wasm object that is freed by a
  // FinalizationRegistry callback, and V8 runs those callbacks as tasks between two turns of the loop. A case is microtasks from start to end (the in-memory store never
  // waits for I/O), so without a turn between cases the callbacks of every case pile up: the wasm memory and the heap grew with the case index (about 2 MB a case) and a
  // case cost more the later it ran, which made the nightly's 1,000 runs unfinishable. A case therefore ends by letting the loop turn once, after its stores are unreachable.
  let turns = 0;
  let ticker: NodeJS.Immediate | undefined;
  const tick = (): void => { turns += 1; ticker = setImmediate(tick); };
  ticker = setImmediate(tick);
  try {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 0x7fffffff }), async (seed) => { await oneCase(seed, templates, tally); await new Promise<void>((resolve) => setImmediate(resolve)); }),
      { seed: options.seed, numRuns: options.numRuns, endOnFailure: true, ...(options.path ? { path: options.path } : {}) });
  } finally { clearImmediate(ticker); }
  // The generator must really reach what the claim is about. The floors apply from the 100-run default up (the three tie floors, same-millisecond included, from 1,000, see below) and only to a
  // full run (a replay of one failing path executes just the cases along it).
  if (!options.path) {
    expect(tally.cases).toBe(options.numRuns);
    expect(turns, 'the event loop turned between the cases').toBeGreaterThanOrEqual(tally.cases);
    if (options.numRuns >= 100) {
      expect(tally.deleted).toBeGreaterThan(options.numRuns);                           // many records really deleted: the property is not vacuous
      expect(tally.keptBehindFailed).toBeGreaterThan(10);                                // old finalized records an older sibling really held back
      expect(tally.inversions).toBeGreaterThan(0);                                       // finished out of order
      expect(tally.futureDated).toBeGreaterThan(0);
      expect(tally.faultsInjected).toBeGreaterThan(10);                                  // runs that really stopped in the middle
      expect(tally.clockSkips).toBe(options.numRuns);
      expect(tally.heldByUnreachable).toBeGreaterThan(5);                                // old records really held behind one the sweep can never delete
      expect(tally.midPassClears).toBeGreaterThan(5);                                    // failed jobs really cleared between two batches
      expect(tally.clockPassedFutureUpdate).toBeGreaterThan(5);                          // records dated after now that the clock really passed during the walk
    }
    // The tie floors need the larger budget. A tie inside a key's deletable run that the walk meets newest first comes up in about 4% of the cases (4.1% over 100,000
    // seeds of the generator; 5.4% over a reviewer's 400,000 before it accepted two records in one millisecond), one it meets oldest first in about 6% (6.2%), and two
    // records of a run accepted in one millisecond, the newer finished first, in about 2% (2.1%). So a 100-run run with a seed other than the fixed one (a dispatched
    // `standard` profile with its own seed) would miss at least one of them about one time in eight with no bug anywhere: 12.5% of 2,000 simulated 100-run runs missed
    // one, 11.2% the same-millisecond floor alone. From 1,000 runs (the nightly) a miss is beyond any practical chance (under e^-20 for each), so a failure
    // there means the generator stopped reaching them. The deterministic tests (async-lift-retention-order.test.ts) pin the behaviour at every budget.
    if (options.numRuns >= 1000) {
      expect(tally.tiedNewestFirst).toBeGreaterThan(0);                                  // keys whose deletable run holds a tie the walk meets newest first
      expect(tally.tiedPrefixes).toBeGreaterThan(tally.tiedNewestFirst);                 // and ties it meets oldest first
      expect(tally.sameMsNewerFirst).toBeGreaterThan(0);                                 // keys whose run holds two records accepted in one millisecond, the newer finished first
    }
  }
  console.log(`publisher retention AC7 property: seed=${options.seed} runs=${tally.cases} deleted=${tally.deleted} keys=${tally.keys} held-back-keys=${tally.keptBehindFailed} out-of-order-keys=${tally.inversions} future-dated=${tally.futureDated} faults=${tally.faultsInjected} unreachable-held=${tally.heldByUnreachable} mid-pass-clears=${tally.midPassClears} clock-passed=${tally.clockPassedFutureUpdate} tied-keys=${tally.tiedPrefixes} tied-newest-first=${tally.tiedNewestFirst} report-equals-delete-on-tie=${tally.reportEqualsDeleteOnTie} same-ms-newer-first=${tally.sameMsNewerFirst}`);
}, 600_000);
