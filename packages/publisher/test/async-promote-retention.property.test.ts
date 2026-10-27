import { expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { propertyOptions } from '../../../scripts/testing/property-options.js';
import {
  NOW, W, WF, POPULATION_KINDS, drain, genPopulation, graphFingerprint, newRetention, pick, present, put, registerPendingFlight, rng,
  type PopulationKind,
} from './_helpers/share-retention-fixtures.js';
import type { PromoteRetentionJobClass } from '../src/async-promote-retention-policy.js';

// AC7 (OT-RFC-73): share retention never deletes a non-terminal, held, bound-obligation, pending-admission or post-commit-recoverable job, deletes only the classes
// D-6 allows, and never deletes a row dated after `now`. Each fast-check run is one random population of every job shape the policy distinguishes, a random mode,
// batch and slice size, random uncertain admissions and a clock that moves between passes; it replays from the integer seed fast-check prints. The oracle is written
// from the generator's own knowledge of what it built (the KIND of each job), not from the product predicate. The PR budget is the repository default (100 runs,
// fixed seed); the nightly profile raises it through DKG_PROPERTY_RUNS (1,000) and DKG_PROPERTY_SEED.

const options = propertyOptions();

/** The only class a kind may ever be deleted as; every other kind is protected, whatever its age. */
const ALLOWED_CLASS: Readonly<Partial<Record<PopulationKind, PromoteRetentionJobClass>>> = {
  'succeeded': 'succeeded', 'succeeded-legacy': 'succeeded', 'failed-cancelled': 'cancelled', 'failed-retired': 'retired_no_effect',
};
const WINDOW: Readonly<Record<PromoteRetentionJobClass, number>> = { succeeded: W, cancelled: WF, retired_no_effect: WF };

interface Tally {
  cases: number; deleted: number; byClass: Record<PromoteRetentionJobClass, number>;
  protectedOldEnough: number; pendingProtected: number; futureDated: number; clockSkips: number; kindsSeen: Set<PopulationKind>;
}

async function oneCase(seed: number, tally: Tally): Promise<void> {
  const r = rng(seed);
  const population = genPopulation(r, 1 + Math.floor(r() * 26));
  const kinds = new Map(population.map(p => [p.job.jobId, p.kind] as const));
  const jobs = new Map(population.map(p => [p.job.jobId, p.job] as const));
  const mode = pick(r, ['report', 'delete', 'delete'] as const);
  const withBenign = r() < 0.75;
  const batchSize = pick(r, [1, 2, 5, 100]), sliceSize = pick(r, [1, 3, 10]);
  const pending = new Set(population.filter(() => r() < 0.15).map(p => p.job.jobId));

  const store = new OxigraphStore();
  try {
    await put(store, ...population.map(p => p.job));
    const control = await graphFingerprint(store);
    const before = new Map<string, string>();
    for (const id of jobs.keys()) before.set(id, await present(store, id));
    const flights = [...pending].map(id => registerPendingFlight(store, id));

    let t = NOW;
    const INTERVAL = 600_000;
    const retention = newRetention(store, { mode, batchSize, sliceSize, benignFailedMaxAgeMs: withBenign ? WF : null, now: () => t, intervalMs: INTERVAL, rescanIntervalMs: 1000 });
    type Flag = { jobId: string; jobClass: PromoteRetentionJobClass; updatedAt: number; at: number };
    const passes: Flag[][] = [];
    const pass = async () => {
      const flags: Flag[] = [];
      for (const res of await drain(retention, 400)) {
        expect(res.error).toBeUndefined();
        expect(res.anomalies).toBe(0);
        if (res.skipped) { tally.clockSkips++; continue; }
        for (const j of mode === 'delete' ? res.deletedJobs : res.wouldDeleteJobs) flags.push({ jobId: j.jobId, jobClass: j.jobClass, updatedAt: j.updatedAt, at: t });
      }
      passes.push(flags);
    };

    await pass();                                                                        // phase 1: now = NOW, admissions pending
    t = NOW + 2_000; await pass();                                                       // phase 2: the clock moves a little, admissions still pending
    t = t - 30 * 60_000; await pass();                                                   // phase 3: a clock that stepped back (the guard skips the tick) ...
    t = NOW + 5_000; await pass();                                                       // ... and back to the right time (half an hour later: skipped as a jump)
    for (const flight of flights) flight.clear();
    t = NOW + 9_000; await pass();                                                       // phase 4: admissions settled
    t = NOW + 13_000; await pass();

    for (const kind of kinds.values()) tally.kindsSeen.add(kind);
    const flagged = passes.flat();
    // 1. only the allowed class of the allowed kinds is ever flagged, as old as its window, never dated after the pass's clock, never while pending
    for (const f of flagged) {
      const kind = kinds.get(f.jobId)!;
      expect(ALLOWED_CLASS[kind], `${f.jobId} (${kind}) was flagged but is protected`).toBe(f.jobClass);
      expect(f.updatedAt, `${f.jobId} is dated after the clock of its pass`).toBeLessThanOrEqual(f.at);
      expect(f.at - f.updatedAt, `${f.jobId} (${f.jobClass}) is younger than its window`).toBeGreaterThanOrEqual(WINDOW[f.jobClass]);
      expect(jobs.get(f.jobId)!.updatedAt).toBe(f.updatedAt);
      if (pending.has(f.jobId)) expect(f.at, `${f.jobId} was flagged while an admission was pending`).toBeGreaterThanOrEqual(NOW + 9_000);
      if (!withBenign) expect(f.jobClass, 'the benign classes are off').toBe('succeeded');
    }
    // 2. the store: report touched nothing; delete removed exactly what it flagged, once and completely, and left every other job byte-identical
    const flaggedIds = new Set(flagged.map(f => f.jobId));
    if (mode === 'delete') expect(flaggedIds.size, 'a job is deleted once').toBe(flagged.length);
    if (mode === 'report') expect(await graphFingerprint(store)).toBe(control);
    const lastPass = new Set(passes[passes.length - 1]!.map(f => f.jobId));
    for (const [id, job] of jobs) {
      const after = await present(store, id);
      const kind = kinds.get(id)!;
      const allowed = ALLOWED_CLASS[kind];
      const eligibleAtEnd = allowed !== undefined && (withBenign || allowed === 'succeeded') && job.updatedAt <= NOW + 13_000 && NOW + 13_000 - job.updatedAt >= WINDOW[allowed];
      if (mode === 'delete' && flaggedIds.has(id)) expect(after, `${id} was deleted: no triple may remain`).toBe('');
      else expect(after, `${id} (${kind}) must be untouched`).toBe(before.get(id));
      // 3. nothing eligible is left behind once the admissions settled and the clock is sane (the sweep is also LIVE): delete has removed it, report names it in the last pass
      if (eligibleAtEnd) expect((mode === 'delete' ? flaggedIds : lastPass).has(id), `${id} (${kind}) is eligible at the end but was left behind`).toBe(true);
      // floors for the claim
      if (allowed === undefined && NOW + 13_000 - job.updatedAt >= WF) tally.protectedOldEnough++;
      if (pending.has(id) && eligibleAtEnd) tally.pendingProtected++;
      if (job.updatedAt > NOW + 13_000) tally.futureDated++;
    }
    if (mode === 'delete') { tally.deleted += flagged.length; for (const f of flagged) tally.byClass[f.jobClass]++; }
    tally.cases++;
  } finally {
    await store.close();
  }
}

it('retention never flags a protected job, only the D-6 classes, never a row dated after now, and misses no eligible job (random populations, modes, slices, pending admissions, a clock that moves)', async () => {
  const tally: Tally = { cases: 0, deleted: 0, byClass: { succeeded: 0, cancelled: 0, retired_no_effect: 0 }, protectedOldEnough: 0, pendingProtected: 0, futureDated: 0, clockSkips: 0, kindsSeen: new Set() };
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 0x7fffffff }), seed => oneCase(seed, tally)),
    { seed: options.seed, numRuns: options.numRuns, endOnFailure: true, ...(options.path ? { path: options.path } : {}) });
  // The generator must really reach what the claim is about. The floors apply from the 100-run default up and only to a full run (a replay of one failing path
  // executes just the cases along it).
  if (!options.path) {
    expect(tally.cases).toBe(options.numRuns);
    if (options.numRuns >= 100) {
      expect([...tally.kindsSeen].sort()).toEqual([...POPULATION_KINDS].sort());
      expect(tally.protectedOldEnough).toBeGreaterThan(options.numRuns);               // many old protected jobs: the property is not vacuous
      expect(tally.byClass.succeeded).toBeGreaterThan(0);
      expect(tally.byClass.cancelled).toBeGreaterThan(0);
      expect(tally.byClass.retired_no_effect).toBeGreaterThan(0);
      expect(tally.pendingProtected).toBeGreaterThan(0);
      expect(tally.futureDated).toBeGreaterThan(0);
      expect(tally.clockSkips).toBeGreaterThan(0);
    }
  }
  console.log(`retention AC7 property: seed=${options.seed} runs=${tally.cases} deleted=${tally.deleted} by-class=${JSON.stringify(tally.byClass)} old-protected-seen=${tally.protectedOldEnough} pending-eligible=${tally.pendingProtected} future-dated=${tally.futureDated} clock-skips=${tally.clockSkips}`);
}, 300_000);
