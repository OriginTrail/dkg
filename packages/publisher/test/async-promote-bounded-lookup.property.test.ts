import { expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { propertyOptions } from '../../../scripts/testing/property-options.js';
import { collapsingStore, differentialCase, rng, type DifferentialCase } from './_helpers/promote-lookup-differential.js';

// Decision-identity differential (OT-RFC-73 AC4, decision D-5): the bounded conflict lookup against the previous lookup, on randomised stores, in memory.
// Each fast-check run is one store generated from its own integer seed, so a failing run replays from the seed fast-check prints. The PR budget is the
// repository default (100 runs, fixed seed); the nightly profile raises it through DKG_PROPERTY_RUNS (1,000) and DKG_PROPERTY_SEED.
// Two engines: `exact` compares literals as written (in-memory Oxigraph), `collapse` identifies the legacy key and the default-lane key (they differ
// only by a trailing U+001F) the way Blazegraph does, so the unchanged query text repeats rows there: that is the positive control, the engine on which
// a lost dedupe would show up as a candidate multiset difference. The real Blazegraph run of the same oracle is test-live/.

const options = propertyOptions();

it.each(['exact', 'collapse'] as const)('the bounded lookup decides exactly as the previous one, candidate id MULTISETS included, on randomised stores (%s engine)', async engine => {
  const total: DifferentialCase & { cases: number } = { cases: 0, conflicts: 0, wildcard: 0, multi: 0, repeatedRows: 0 };
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 0x7fffffff }), async caseSeed => {
    const inner = new OxigraphStore();
    let seen: DifferentialCase;
    try { seen = await differentialCase(engine === 'collapse' ? collapsingStore(inner) : inner, 'urn:dkg:promote-queue:control-plane', rng(caseSeed)); } finally { await inner.close(); }
    total.cases++; total.conflicts += seen.conflicts; total.wildcard += seen.wildcard; total.multi += seen.multi; total.repeatedRows += seen.repeatedRows;
  }), { seed: options.seed + (engine === 'exact' ? 0 : 1), numRuns: options.numRuns, endOnFailure: true, ...(options.path ? { path: options.path } : {}) });
  // The generator must really reach the branches the claim is about. The floors apply from the 100-run default up (a smaller smoke budget cannot promise them)
  // and only to a full run: a replay of one failing path (DKG_PROPERTY_PATH) executes just the cases along that path, so it has no budget to count.
  if (!options.path) {
    expect(total.cases).toBe(options.numRuns);
    if (options.numRuns >= 100) {
      expect(total.conflicts).toBeGreaterThanOrEqual(Math.floor(options.numRuns * 0.1));
      expect(total.wildcard).toBeGreaterThanOrEqual(Math.floor(options.numRuns * 0.2));            // the legacy wildcard lane (assertionWildcard query) is a third of the cases by construction
      if (engine === 'collapse') expect(total.repeatedRows).toBeGreaterThan(0);                   // positive control: the model makes the unchanged query repeat rows
    }
  }
  if (engine === 'exact') expect(total.repeatedRows).toBe(0);
  console.log(`bounded lookup differential (${engine}): seed=${options.seed} runs=${total.cases} conflicts=${total.conflicts} wildcard=${total.wildcard} multi-match=${total.multi} repeated-rows=${total.repeatedRows}`);
}, 120_000);
