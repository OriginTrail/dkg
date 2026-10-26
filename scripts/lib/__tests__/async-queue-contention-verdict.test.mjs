// Known answers for the async queue contention verdict library and the CLI around it (OT-RFC-73 P2a). No backend. Only
// the `run --dry` tests need the built workspace (pnpm run build:packages): a refused or invalid invocation exits
// before the product is loaded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DATA_OPS_PER_SHARE } from '../../repro/async-queue-contention/fixture.mjs';
import {
  CENSOR_MS,
  RUNGS,
  admissionSummary,
  comparability,
  depthSeries,
  equivalent,
  extractRecord,
  finalizeRequests,
  flat,
  groundTruth,
  guards,
  halve,
  integrityWarnings,
  kneeReached,
  ledgerMarkdown,
  median,
  noiseMargin,
  p8cTrigger,
  pairKey,
  pairRuns,
  percentile,
  pickReproductionRung,
  repeatsPerCell,
  shareBacklog,
  summarize,
  validity,
} from '../../repro/async-queue-contention/verdict.mjs';
import { OBSERVER_CALLS, walkPages } from '../../repro/async-queue-contention/workload.mjs';

const rec = (p95Ms, o = {}) => ({
  key: o.key ?? 'k',
  p95Ms,
  failureFrac: o.failureFrac ?? 0.5,
  valid: o.valid ?? true,
  completionsPerMin: o.completionsPerMin ?? 100,
});
const pairsOf = (aVals, bVals, opts = {}) =>
  aVals.map((a, i) => ({ key: `r${i}`, a: rec(a, opts.a), b: rec(bVals[i], opts.b), valid: opts.valid?.[i] ?? true }));

test('percentile and summarize use linear interpolation', () => {
  const s = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(s, { n: 10, mean: 5.5, p50: 5.5, p95: 9.55, p99: 9.91, max: 10 });
  assert.deepEqual(summarize([7]), { n: 1, mean: 7, p50: 7, p95: 7, p99: 7, max: 7 });
  assert.deepEqual(summarize([]), { n: 0 });
  assert.equal(percentile([], 0.5), null);
  assert.equal(median([3, 1, 2]), 2);
});

test('finalizeRequests censors at 20 s and counts unfinished requests as caller timeouts', () => {
  const reqs = [
    { intended: 0, ended: 25_000, outcome: 'success' },
    { intended: 0, outcome: undefined },
    { intended: 0, ended: 19_999, outcome: 'success' },
    { intended: 100, ended: 20_100, outcome: 'typed_reject_not_admitted' },
  ];
  finalizeRequests(reqs);
  assert.equal(reqs[0].outcome, 'caller_timeout');
  assert.equal(reqs[0].lateOutcome, 'success');
  assert.equal(reqs[0].latCensored, CENSOR_MS);
  assert.equal(reqs[1].outcome, 'caller_timeout');
  assert.equal(reqs[1].lateOutcome, 'unfinished');
  assert.equal(reqs[2].outcome, 'success');
  assert.equal(reqs[2].latCensored, 19_999);
  assert.equal(reqs[3].outcome, 'typed_reject_not_admitted', 'exactly 20 s is not censored');
});

test('admissionSummary reads only the measure window', () => {
  const mk = (windowTag, ended, outcome, extra = {}) => ({ windowTag, intended: 0, ended, outcome, ...extra });
  const reqs = [
    ...Array.from({ length: 8 }, () => mk('measure', 100, 'success', { preMs: 40, enqMs: 60 })),
    mk('measure', 10_000, 'typed_reject_not_admitted', {
      code: 'PROMOTE_ADMISSION_UNAVAILABLE',
      phase: 'lock',
      admissionOutcome: 'not_admitted',
    }),
    mk('measure', 30_000, 'success'),
    mk('warmup', 90_000, 'error'),
    mk('cooldown', 90_000, 'error'),
  ];
  finalizeRequests(reqs);
  const s = admissionSummary(reqs);
  assert.equal(s.n, 10);
  assert.equal(s.nWarmup, 1);
  assert.equal(s.nCooldown, 1);
  assert.equal(s.F, 0.2);
  assert.deepEqual(s.outcomes, { success: 8, typed_reject_not_admitted: 1, caller_timeout: 1 });
  assert.equal(s.latencyMs.p95, 15_500, 'censored values [100 x8, 10000, 20000]');
  assert.equal(s.latencyMs.max, 20_000);
  assert.equal(s.preflightMs.n, 8);
  assert.equal(s.enqueueMs.n, 8);
  assert.ok(s.outcomeDetail['caller_timeout|success||'.concat('|late=success')]);
  assert.equal(admissionSummary([]).F, null);
});

test('groundTruth finds success without a job, double admissions and uncertain-but-admitted requests', () => {
  const reqs = [
    { key: 'a', windowTag: 'measure', outcome: 'success' },
    { key: 'b', windowTag: 'measure', outcome: 'success' },
    { key: 'c', windowTag: 'measure', outcome: 'indeterminate' },
    { key: 'd', windowTag: 'measure', outcome: 'typed_reject_not_admitted' },
    { key: 'e', windowTag: 'warmup', outcome: 'success' },
  ];
  const jobs = new Map([
    ['a', [{}]],
    ['c', [{}]],
    ['e', [{}, {}]],
  ]);
  assert.deepEqual(groundTruth(reqs, jobs), {
    nonSuccess: 2,
    uncertainButAdmitted: 1,
    notAdmitted: 1,
    successWithoutPersistedJob: 1,
    doubleAdmissions: 1,
  });
});

test('kneeReached is inclusive on both edges', () => {
  assert.equal(kneeReached({ p95Ms: 4999, failureFrac: 0.049 }), false);
  assert.equal(kneeReached({ p95Ms: 5000, failureFrac: 0 }), true);
  assert.equal(kneeReached({ p95Ms: 100, failureFrac: 0.05 }), true);
});

test('pickReproductionRung returns the first knee rung and the one below it', () => {
  const ladder = [
    { id: 'L1', p95Ms: 300, failureFrac: 0 },
    { id: 'L2', p95Ms: 900, failureFrac: 0 },
    { id: 'L3', p95Ms: 10_200, failureFrac: 0.51 },
    { id: 'L4', p95Ms: 11_000, failureFrac: 0.99 },
  ];
  assert.deepEqual(pickReproductionRung(ladder), { status: 'found', rung: 'L3', subKneeRung: 'L2' });
  assert.deepEqual(pickReproductionRung(ladder.slice(2)), { status: 'below-ladder', rung: 'L3', subKneeRung: null });
  assert.deepEqual(pickReproductionRung(ladder.slice(0, 2)), { status: 'no-knee', rung: null, subKneeRung: null });
  assert.equal(RUNGS.find((r) => r.id === 'L3').lambda, 8, 'the G0/G0b reproduction load');
});

test('pairRuns reports missing runs and an invalid run makes the pair not count', () => {
  const cell = (history, repeat) => ({ history, observer: 'default', rung: 'L3', repeat });
  const mk = (history, repeat, valid = true) => ({
    key: pairKey({ cell: cell(history, repeat) }),
    cell: cell(history, repeat),
    valid,
  });
  assert.equal(pairKey({ cell: cell(0, 1) }), '0|default|L3|1');
  assert.equal(pairKey({ cell: cell(0, 1) }, { ignoreHistory: true }), 'default|L3|1');
  const { pairs, missing } = pairRuns([mk(0, 0), mk(0, 1), mk(0, 2, false)], [mk(0, 0), mk(0, 2), mk(0, 3)]);
  assert.deepEqual(
    pairs.map((p) => [p.key, p.valid]),
    [
      ['0|default|L3|0', true],
      ['0|default|L3|2', false],
    ],
  );
  assert.deepEqual(missing, [
    { key: '0|default|L3|1', missingIn: 'b' },
    { key: '0|default|L3|3', missingIn: 'a' },
  ]);
  const flatKey = (r) => pairKey(r, { ignoreHistory: true });
  assert.equal(pairRuns([mk(0, 0)], [mk('50k', 0)], flatKey).pairs.length, 1);
  assert.equal(
    pairRuns([mk(0, 0, false), mk(0, 0, true)], [mk(0, 0)]).pairs[0].valid,
    true,
    'a valid rerun replaces the discarded run',
  );
});

const config = (o = {}) => ({
  windows: { warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 },
  env: { DKG_STORE_MAX_CONCURRENT: '2', DKG_STORE_QUEUE_LIMIT: '64' },
  lambda: 8,
  content: 4,
  aggregate: 2,
  seed: 7300,
  observerMs: 5000,
  calibrationSha256: 'cal',
  seedFileSha256: null,
  cpus: 10,
  ...o,
});
const withConfig = (o = {}, extra = {}) => ({ key: 'k0', runId: 'r', valid: true, config: config(o), ...extra });

test('comparability names the settings two runs of a pair must share and only reports an env difference', () => {
  assert.deepEqual(comparability(withConfig(), withConfig()), { differs: [], envDiffers: false });
  const env = { DKG_STORE_QUEUE_LIMIT: '64', DKG_STORE_MAX_CONCURRENT: '2' };
  assert.equal(comparability(withConfig(), withConfig({ env })).envDiffers, false, 'key order does not matter');
  assert.equal(comparability(withConfig(), withConfig({ env: { DKG_STORE_MAX_CONCURRENT: '4' } })).envDiffers, true);
  const other = withConfig({
    windows: { warmupMs: 30_000, measureMs: 60_000, cooldownMs: 10_000 },
    lambda: 4,
    content: 3,
    aggregate: 1,
    seed: 7301,
    observerMs: 1000,
    calibrationSha256: 'other',
    seedFileSha256: 'seed',
    cpus: 8,
  });
  assert.deepEqual(comparability(withConfig(), other).differs, [
    'windows',
    'lambda',
    'content',
    'aggregate',
    'seed',
    'observerMs',
    'calibrationSha256',
    'seedFileSha256',
    'cpus',
  ]);
  assert.equal(
    comparability(withConfig(), other, { ignoreSeed: true }).differs.includes('seedFileSha256'),
    false,
    'the flatness rule compares histories',
  );
  assert.deepEqual(
    comparability(withConfig(), other, { ignoreSeed: true }).differs.filter((k) => k === 'seed' || k === 'observerMs'),
    ['seed', 'observerMs'],
    'but the arrival schedule and the observer load must still match',
  );
  assert.deepEqual(comparability({}, {}), { differs: [], envDiffers: false }, 'records without a config compare equal');
});

test('pairRuns does not count a pair that differs in shared settings or has two valid runs of one cell', () => {
  const same = pairRuns([withConfig()], [withConfig()]);
  assert.deepEqual([same.pairs[0].valid, same.pairs[0].reasons], [true, []]);
  const windows = pairRuns([withConfig()], [withConfig({ windows: { warmupMs: 1, measureMs: 1, cooldownMs: 1 } })])
    .pairs[0];
  assert.deepEqual([windows.valid, windows.reasons], [false, ['the runs differ in windows']]);
  const envOnly = pairRuns([withConfig()], [withConfig({ env: {} })]).pairs[0];
  assert.deepEqual([envOnly.valid, envOnly.envDiffers], [true, true]);
  const twice = pairRuns([withConfig({}, { runId: 'first' }), withConfig({}, { runId: 'second' })], [withConfig()])
    .pairs[0];
  assert.equal(twice.valid, false);
  assert.match(twice.reasons[0], /a has 2 valid runs for this key \(first, second\)/);
  const rerun = pairRuns([withConfig({}, { valid: false }), withConfig()], [withConfig()]).pairs[0];
  assert.equal(rerun.valid, true, 'one valid run and any number of discarded ones is unambiguous');
  const flatPair = pairRuns([withConfig()], [withConfig({ seedFileSha256: 'seed' })], undefined, { ignoreSeed: true })
    .pairs[0];
  assert.equal(flatPair.valid, true);
});

test('pairRuns does not count a pair whose runs differ in the arrival seed or the observer period', () => {
  const pair = (b, opts) => pairRuns([withConfig()], [withConfig(b)], undefined, opts).pairs[0];
  assert.equal(pair({}).valid, true);
  const seed = pair({ seed: 7301 });
  assert.deepEqual([seed.valid, seed.reasons], [false, ['the runs differ in seed']]);
  const period = pair({ observerMs: 1000 });
  assert.deepEqual([period.valid, period.reasons], [false, ['the runs differ in observerMs']]);
  const flatSeed = pair({ seed: 7301 }, { ignoreSeed: true });
  assert.equal(flatSeed.valid, false, 'the flatness rule compares histories, not schedules');
  assert.equal(pair({ observerMs: 1000 }, { ignoreSeed: true }).valid, false);
  // from the run summaries: the metadata of a run carries both settings
  const record = (cell) => {
    const full = { history: 0, observer: 'default', rung: 'L3', repeat: 1, ...cell };
    return extractRecord(summaryOf(true, 1000, { meta: { cell: full } }));
  };
  const base = { seed: 7301, observerMs: 5000 };
  assert.equal(pairRuns([record(base)], [record(base)]).pairs[0].valid, true);
  assert.equal(pairRuns([record(base)], [record({ ...base, seed: 7302 })]).pairs[0].valid, false);
  assert.equal(pairRuns([record(base)], [record({ ...base, observerMs: 1000 })]).pairs[0].valid, false);
});

/** Valid pairs [a, b] P95s per cell; the key is the pairKey of the cell and the repeat index. */
const cellPairs = (spec) =>
  spec.flatMap(([cell, p95s]) => p95s.map(([a, b], i) => ({ key: `${cell}|${i}`, a: rec(a), b: rec(b), valid: true })));

test('a rule needs three valid paired repeats in every cell: the pairs of different cells do not add up', () => {
  const cells = ['0|default|L3', '0|none|L3', '50k|default|L3'];
  const oneEach = cellPairs(cells.map((cell) => [cell, [[10_000, 4000]]]));
  assert.deepEqual(repeatsPerCell(oneEach), { cells: Object.fromEntries(cells.map((c) => [c, 1])), have: 1 });
  for (const result of [halve(oneEach), flat(oneEach), equivalent(oneEach, 0.5)]) {
    assert.equal(result.status, 'incomplete', result.label);
    assert.deepEqual([result.have, result.need], [1, 3]);
    assert.match(result.reason, /needs 3 valid paired repeats in every cell, the thinnest has 1 \(/);
  }
  const three = [[10_000, 4000], [11_000, 5500], [9000, 4500]];
  const full = cellPairs([['0|default|L3', three], ['0|none|L3', three]]);
  assert.deepEqual([halve(full).status, halve(full).have], ['pass', 3]);
  const thin = cellPairs([['0|default|L3', three], ['0|none|L3', three.slice(0, 2)]]);
  const incomplete = halve(thin);
  assert.deepEqual([incomplete.status, incomplete.have], ['incomplete', 2]);
  assert.deepEqual(incomplete.cells, { '0|default|L3': 3, '0|none|L3': 2 });
  const slow = cellPairs([['0|default|L3', three], ['0|none|L3', [[10_000, 4000], [11_000, 5501], [9000, 4500]]]]);
  assert.equal(halve(slow).status, 'fail', 'every cell is judged: one failing repeat fails the rule');
  // a cell with no valid pair at all is not a cell of the verdict; a discarded run does not block it
  const stray = [...cellPairs([['0|default|L3', three]]), { key: '0|none|L3|0', a: rec(1), b: rec(1), valid: false }];
  assert.equal(halve(stray).status, 'pass');
  assert.deepEqual(repeatsPerCell([]), { cells: {}, have: 0 });
});

test('halve: candidate P95 <= 0.5 x base in 3 of 3 paired repeats', () => {
  const pass = halve(pairsOf([10_000, 11_000, 9000], [4000, 5500, 4500]));
  assert.equal(pass.status, 'pass');
  assert.deepEqual(
    pass.perRepeat.map((r) => r.ratio),
    [0.4, 0.5, 0.5],
  );
  const fail = halve(pairsOf([10_000, 11_000, 9000], [4000, 5501, 4500]));
  assert.equal(fail.status, 'fail');
  assert.equal(fail.perRepeat[1].ratio, 0.5001);
  assert.equal(fail.perRepeat[1].ok, false);
  const two = halve(pairsOf([10_000, 11_000, 9000], [4000, 5500, 4500], { valid: [true, true, false] }));
  assert.equal(two.status, 'incomplete');
  assert.equal(two.have, 2);
  const healthy = pairsOf([10_000, 4000, 9000], [4000, 1000, 4500]);
  healthy[1].a.failureFrac = 0;
  const weak = halve(healthy);
  assert.equal(
    weak.status,
    'pass',
    'the rung is calibrated once; a repeat that lands just under the knee does not make the verdict incomplete',
  );
  assert.deepEqual(weak.belowKnee, ['r1'], 'but it is reported');
  assert.deepEqual(halve(pairsOf([10_000, 11_000, 9000], [4000, 5500, 4500])).belowKnee, []);
});

test('flat: history 50k P95 <= 1.25 x history 0 in 3 of 3 paired repeats', () => {
  assert.equal(flat(pairsOf([800, 900, 1000], [1000, 1125, 1250])).status, 'pass');
  const fail = flat(pairsOf([800, 900, 1000], [1000, 1126, 1250]));
  assert.equal(fail.status, 'fail');
  assert.equal(fail.perRepeat[1].ratio, 1.2511);
});

test('noiseMargin is the worst A/A deviation with a 10 % floor; equivalent needs it declared', () => {
  const aa = (pairs) => pairs.map(([a, b], i) => ({ key: `r${i}`, a: rec(a), b: rec(b), valid: true }));
  assert.equal(
    noiseMargin(
      aa([
        [1000, 1040],
        [1000, 930],
        [1000, 1080],
      ]),
    ),
    0.1,
  );
  assert.equal(
    noiseMargin(
      aa([
        [1000, 1040],
        [1000, 1220],
        [1000, 980],
      ]),
    ),
    0.22,
  );
  assert.equal(noiseMargin(aa([[1000, 500]])), 1, 'a halving counts as a 100 % deviation');
  const ab = pairsOf([1000, 1000, 1000], [1050, 970, 1200]);
  assert.equal(equivalent(ab, 0.22).status, 'pass');
  assert.equal(equivalent(ab, 0.1).status, 'fail');
  assert.equal(
    equivalent(pairsOf([1000, 1000, 1000], [1000, 1000, 800]), 0.2).status,
    'fail',
    'below 1/(1+m) fails too',
  );
  assert.throws(() => equivalent(ab), /margin/);
});

test('guards report the candidate failure fraction and completions without gating', () => {
  const pairs = pairsOf([10_000, 10_000], [4000, 4000]);
  pairs[0].b.failureFrac = 0.03;
  pairs[1].b.failureFrac = 0.02;
  pairs[1].b.completionsPerMin = 80;
  const g = guards(pairs);
  assert.deepEqual(
    g.failureFrac.map((x) => x.ok),
    [false, true],
  );
  assert.deepEqual(
    g.completions.map((x) => [x.ratio, x.ok]),
    [
      [1, true],
      [0.8, false],
    ],
  );
});

test('depthSeries and shareBacklog sample interval depth every second', () => {
  assert.deepEqual(
    depthSeries(
      [
        [0, 2500],
        [1000, Infinity],
      ],
      0,
      4000,
    ),
    { n: 4, mean: 1.5, max: 2, first: 1, last: 1, slopePerMin: 0 },
  );
  assert.equal(depthSeries([], 0, 0).n, 0);
  const requests = [
    { rawOutcome: 'success', outcome: 'success', jobId: 'j1', ended: 0 },
    { rawOutcome: 'success', outcome: 'caller_timeout', jobId: 'j2', ended: 1000 },
    { rawOutcome: 'typed_reject_not_admitted', outcome: 'typed_reject_not_admitted', ended: 500 },
  ];
  const b = shareBacklog({ requests, completions: [{ jobId: 'j1', t: 2500 }], from: 0, to: 4000 });
  assert.deepEqual([b.mean, b.max, b.first, b.last, b.slopePerMin, b.jobs, b.openAtEnd], [1.5, 2, 1, 1, 0, 2, 1]);
});

test('p8cTrigger: claimNext P95 doubling between the first and last 5 minutes, or a 5,000-job backlog', () => {
  const runMs = 900_000;
  const series = (firstMs, lastMs) => [
    ...Array.from({ length: 30 }, (_, i) => ({ t: i * 1000, ms: firstMs })),
    ...Array.from({ length: 30 }, (_, i) => ({ t: runMs - 300_000 + i * 1000, ms: lastMs })),
  ];
  assert.deepEqual(p8cTrigger({ claimNext: series(100, 250), backlogMax: 10, runMs }), {
    evaluable: true,
    ratio: 2.5,
    backlogTrip: false,
    trigger: true,
  });
  assert.equal(p8cTrigger({ claimNext: series(100, 190), backlogMax: 10, runMs }).trigger, false);
  assert.equal(p8cTrigger({ claimNext: series(100, 190), backlogMax: 5000, runMs }).trigger, false);
  assert.equal(p8cTrigger({ claimNext: series(100, 190), backlogMax: 5001, runMs }).trigger, true);
  const short = p8cTrigger({ claimNext: series(100, 250), backlogMax: 10, runMs: 180_000 });
  assert.equal(short.evaluable, false);
  assert.equal(short.trigger, false);
  assert.equal(
    p8cTrigger({ claimNext: series(100, 250).slice(0, 25), backlogMax: 0, runMs }).evaluable,
    false,
    'fewer than 20 samples in the last window',
  );
});

test('validity: arrivals, drain, invariants, driver headroom, quiet idle publisher', () => {
  const worker = {
    agentErrors: 0,
    crashes: 0,
    failedTerminal: 0,
    succeeded: 100,
    attempted: 104,
    dataOps: 100 * DATA_OPS_PER_SHARE + 100,
  };
  const ok = {
    lambda: 8,
    measureMs: 180_000,
    measured: 1440,
    stillInflight: 0,
    reconcileError: null,
    successWithoutJob: 0,
    doubleAdmissions: 0,
    driverCpu: 0.5,
    idlePublisherErrors: 0,
    worker,
    seedFileVerified: true,
  };
  assert.equal(validity(ok).ok, true);
  assert.equal(validity(ok).arrivalsExpected, 1440);
  assert.equal(validity({ ...ok, measured: 1300 }).arrivalsWithin4Sigma, true, '140 <= 4 x sqrt(1440) = 151.8');
  assert.equal(validity({ ...ok, measured: 1250 }).arrivalsWithin4Sigma, false);
  assert.equal(validity({ ...ok, driverCpu: 0.79 }).driverHeadroomOk, true);
  assert.equal(validity({ ...ok, driverCpu: 0.81 }).ok, false);
  for (const bad of [
    { stillInflight: 2 },
    { reconcileError: 'boom' },
    { successWithoutJob: 1 },
    { doubleAdmissions: 1 },
    { idlePublisherErrors: 3 },
  ]) {
    assert.equal(validity({ ...ok, ...bad }).ok, false, JSON.stringify(bad));
  }
});

test('validity fails a run whose worker side did not work (agent errors, crashes, replayed operations)', () => {
  const run = {
    lambda: 8,
    measureMs: 180_000,
    measured: 1440,
    stillInflight: 0,
    reconcileError: null,
    successWithoutJob: 0,
    doubleAdmissions: 0,
    driverCpu: 0.5,
    idlePublisherErrors: 0,
    seedFileVerified: true,
  };
  const good = {
    agentErrors: 0,
    crashes: 0,
    failedTerminal: 0,
    succeeded: 50,
    attempted: 50,
    dataOps: 50 * DATA_OPS_PER_SHARE,
  };
  assert.equal(validity({ ...run, worker: good }).ok, true);
  const failing = (worker) => validity({ ...run, worker: { ...good, ...worker } });
  assert.equal(
    failing({ agentErrors: 1 }).workerContractOk,
    false,
    'the fake agent threw something that is not a store rejection',
  );
  assert.equal(failing({ crashes: 1 }).workerContractOk, false, 'the supervisor logged a crashed job');
  assert.equal(failing({ failedTerminal: 1 }).workerContractOk, false);
  assert.equal(failing({ succeeded: 0, dataOps: 0 }).workerContractOk, false, 'no job completed at all');
  assert.equal(
    failing({ dataOps: 49 * DATA_OPS_PER_SHARE }).dataPlaneReplayed,
    false,
    'fewer replay operations than completed shares can have issued',
  );
  assert.equal(failing({ attempted: 49 }).dataPlaneReplayed, false, 'more replay operations than the attempts allow');
  assert.equal(
    failing({ succeeded: 40, attempted: 55, dataOps: 55 * DATA_OPS_PER_SHARE }).ok,
    true,
    'retried and cut-short attempts are within the bounds',
  );
  assert.equal(validity(run).ok, false, 'a summary without worker evidence is not valid');
  assert.equal(validity({ ...run, worker: good, seedFileVerified: false }).seedFileVerified, false);
  assert.equal(validity({ ...run, worker: good, seedFileVerified: false }).ok, false);
});

const summaryOf = (valid, p95, o = {}) => ({
  meta: {
    runId: 'r1',
    label: 'base',
    cell: {
      history: 0,
      observer: 'default',
      rung: 'L3',
      repeat: 1,
      lambda: 8,
      content: 4,
      aggregate: 2,
      seed: 7301,
      observerMs: 5000,
    },
    git: { sha: '0123456789abcdef', dirty: false },
    scriptSha256: 'abc',
    distStaleSuspected: false,
    windows: { warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 },
    env: { DKG_STORE_MAX_CONCURRENT: '2' },
    host: { cpus: 10 },
    calibration: { sha256: 'cal', windowsDiffer: false },
    seedFile: { sha256: 'manifest', loadedSha256: 'loaded' },
    ...o.meta,
  },
  submission: { F: 0.51, latencyMs: { p95 } },
  worker: {
    completionsPerMin: 120,
    counters: { succeeded: 400, failedTerminal: 1 },
    agent: { agentErrors: 2 },
    p8c: { evaluable: true, ratio: 1.5, backlogTrip: false, trigger: false },
    ...o.worker,
  },
  observer: { latencyMs: { p95: 900 } },
  validity: { ok: valid, drained: valid, driverHeadroomOk: true },
});

test('extractRecord maps a summary and ledgerMarkdown lists every run', () => {
  const good = extractRecord(summaryOf(true, 10_200));
  assert.deepEqual(good, {
    key: '0|default|L3|1',
    label: 'base',
    cell: {
      history: 0,
      observer: 'default',
      rung: 'L3',
      repeat: 1,
      lambda: 8,
      content: 4,
      aggregate: 2,
      seed: 7301,
      observerMs: 5000,
    },
    repeat: 1,
    valid: true,
    failedChecks: [],
    p95Ms: 10_200,
    failureFrac: 0.51,
    completionsPerMin: 120,
    observerP95Ms: 900,
    workerCounters: { succeeded: 400, failedTerminal: 1, agentErrors: 2 },
    p8c: { evaluable: true, ratio: 1.5, backlogTrip: false, trigger: false },
    config: {
      windows: { warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 },
      env: { DKG_STORE_MAX_CONCURRENT: '2' },
      lambda: 8,
      content: 4,
      aggregate: 2,
      seed: 7301,
      observerMs: 5000,
      calibrationSha256: 'cal',
      seedFileSha256: 'loaded',
      cpus: 10,
    },
    windowsDifferFromCalibration: false,
    git: { sha: '0123456789abcdef', dirty: false },
    scriptSha256: 'abc',
    distStaleSuspected: false,
    runId: 'r1',
  });
  const bad = extractRecord(summaryOf(false, 9000, { meta: { seedFile: { sha256: 'manifest' }, calibration: null } }));
  assert.deepEqual(bad.failedChecks, ['ok', 'drained']);
  assert.equal(
    bad.config.seedFileSha256,
    'manifest',
    'a summary without the loaded hash falls back to the manifest hash',
  );
  assert.equal(bad.config.calibrationSha256, null);
  const legacySchedule = extractRecord(
    summaryOf(true, 1, { meta: { cell: { history: 0, observer: 'default', rung: 'L3', repeat: 1 } } }),
  );
  assert.deepEqual(
    [legacySchedule.config.seed, legacySchedule.config.observerMs],
    [null, null],
    'a summary from before the schedule was recorded compares as unknown, not as a match to a known value',
  );
  const table = ledgerMarkdown([good, bad]).split('\n');
  assert.equal(table.length, 4);
  assert.match(table[0], /\| worker ok\/failed\/agent errors \| P8c \|/);
  assert.match(table[2], /\| 400\/1\/2 \| ok \|/);
  assert.match(table[3], /INVALID: ok, drained/);
  const legacy = extractRecord({ ...summaryOf(true, 1), worker: undefined });
  assert.deepEqual(legacy.workerCounters, { succeeded: null, failedTerminal: null, agentErrors: null });
  assert.match(
    ledgerMarkdown([legacy]).split('\n')[2],
    /\| \/\/ \| n\/e \|/,
    'a summary without worker evidence leaves the cells empty',
  );
  const trip = extractRecord(
    summaryOf(true, 1, { worker: { p8c: { evaluable: true, ratio: 2.5, backlogTrip: false, trigger: true } } }),
  );
  assert.match(ledgerMarkdown([trip]).split('\n')[2], /\| TRIP \|/);
});

test('integrityWarnings reports what a verdict reader must see next to the result', () => {
  const rec = (runId, o = {}) => ({
    runId,
    scriptSha256: 'same',
    distStaleSuspected: false,
    git: { dirty: false },
    p8c: null,
    windowsDifferFromCalibration: false,
    ...o,
  });
  assert.deepEqual(integrityWarnings([rec('a'), rec('b')], [], null), []);
  const warnings = integrityWarnings(
    [
      rec('a', { scriptSha256: 'one', distStaleSuspected: true }),
      rec('b', { scriptSha256: 'two', git: { dirty: true }, windowsDifferFromCalibration: true }),
      rec('c', { p8c: { evaluable: true, ratio: 2.5, backlogTrip: false, trigger: true } }),
      rec('d', { p8c: { evaluable: false, ratio: null, backlogTrip: true, trigger: true } }),
    ],
    [
      { key: 'k0', reasons: ['the runs differ in windows'], envDiffers: false },
      { key: 'k1', reasons: [], envDiffers: true },
      { key: 'k2', reasons: [], envDiffers: true },
    ],
    { belowKnee: ['k2'] },
  );
  assert.deepEqual(warnings, [
    'base and candidate ran different benchmark script files (scriptSha256 differs)',
    'a run suspected a stale dist build (rebuild the worktree packages and rerun)',
    'a run came from a dirty working tree',
    'pair k0 does not count: the runs differ in windows',
    'the DKG_STORE_* env differs between the arms in k1, k2 (expected only for the knob under test)',
    'run c: P8c trigger (claimNext P95 ratio 2.5): record it in the PR',
    'run d: P8c trigger (active backlog above 5,000): record it in the PR',
    "runs with windows other than their calibration's: b",
    'the base run is below the knee in k2: the halving test is weak in those repeats',
  ]);
});

test('walkPages walks every page and stops on a falsy cursor; the paged seam is empty until P8a/P9b', async () => {
  const pages = [
    { rows: 100, nextCursor: 'c1' },
    { rows: 100, nextCursor: 'c2' },
    { rows: 37, nextCursor: null },
  ];
  const seen = [];
  const walked = await walkPages(async (cursor) => {
    seen.push(cursor);
    return pages[seen.length - 1];
  });
  assert.deepEqual([walked.rows, walked.pages, walked.pageMs.length], [237, 3, 3]);
  assert.deepEqual(seen, [undefined, 'c1', 'c2']);
  const single = await walkPages(async () => ({ rows: 5 }));
  assert.deepEqual([single.rows, single.pages, single.pageMs.length], [5, 1, 1]);
  await assert.rejects(
    walkPages(async () => ({ rows: 1, nextCursor: 'same' })),
    /did not advance/,
  );
  // This documents the seam: the PR that adds the paged listing (P8a / P9b) fills `paged` and MUST also update
  // `default` (see workload.mjs); it changes this assertion.
  assert.equal(OBSERVER_CALLS.paged, null);
  assert.equal(typeof OBSERVER_CALLS.default, 'function');
  assert.equal(
    (
      await OBSERVER_CALLS.default({
        list: async (options) => {
          assert.deepEqual(options, {});
          return [1, 2];
        },
      })
    ).rows,
    2,
  );
});

// ---------------------------------------------------------------- the verdict subcommand end to end (no backend)
const ENTRY = fileURLToPath(new URL('../../repro/async-queue-contention.mjs', import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), 'aqc-verdict-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * Writes <root>/<name>/<tag>r<i>/summary.json for each p95 and returns the directory (a `tag` puts runs of several
 * cells in one directory). `cellExtra` is added to each run's cell; `meta` and `worker` are merged into the summary.
 */
function runs(
  name,
  p95s,
  {
    history = '0',
    observer = 'default',
    tag = '',
    cellExtra = {},
    valid = [],
    F = 0.5,
    sha = 'abc',
    dirty = false,
    meta = {},
    worker = {},
  } = {},
) {
  p95s.forEach((p95, i) => {
    const dir = path.join(tmp, name, `${tag}r${i}`);
    mkdirSync(dir, { recursive: true });
    const ok = valid[i] ?? true;
    writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        meta: {
          runId: `${name}-${tag}${i}`,
          label: name,
          cell: { history, observer, rung: 'L3', repeat: i, ...cellExtra },
          git: { sha: '0123456789abcdef', dirty },
          scriptSha256: sha,
          distStaleSuspected: false,
          ...meta,
        },
        submission: { F, latencyMs: { p95 } },
        worker: { completionsPerMin: 100, ...worker },
        observer: { latencyMs: { p95: 10 } },
        validity: { drained: ok, ok },
      }),
    );
  });
  return path.join(tmp, name);
}
const cli = (...args) => {
  const r = spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('verdict halve: exit 0 on a pass, 1 on a fail, 2 when incomplete', () => {
  const base = runs('base', [10_000, 11_000, 9000]);
  const pass = cli('verdict', '--rule', 'halve', '--a', base, '--b', runs('good', [4000, 5500, 4500]));
  assert.equal(pass.code, 0);
  assert.match(pass.out, /halve: candidate P95 <= 0\.5 x base: PASS/);
  const fail = cli('verdict', '--rule', 'halve', '--a', base, '--b', runs('slow', [4000, 5501, 4500]));
  assert.equal(fail.code, 1);
  assert.match(fail.out, /FAIL/);
  const incomplete = cli(
    'verdict',
    '--rule',
    'halve',
    '--a',
    base,
    '--b',
    runs('thin', [4000, 5500, 4500], { valid: [true, false, true] }),
  );
  assert.equal(incomplete.code, 2);
  assert.match(incomplete.out, /INCOMPLETE \(2 valid pairs/);
  const json = JSON.parse(cli('verdict', '--rule', 'halve', '--a', base, '--b', path.join(tmp, 'good'), '--json').out);
  assert.deepEqual([json.result.status, json.result.perRepeat.length, json.missing.length], ['pass', 3, 0]);
});

test('verdict flat pairs across histories and honours --where', () => {
  const lo = runs('h0', [800, 900, 1000]);
  const hi = runs('h50k', [1000, 1125, 1250], { history: '50k' });
  assert.equal(cli('verdict', '--rule', 'flat', '--a', lo, '--b', hi, '--where', 'observer=default').code, 0);
  assert.equal(
    cli('verdict', '--rule', 'flat', '--a', lo, '--b', runs('h50k-slow', [1000, 1126, 1250], { history: '50k' })).code,
    1,
  );
  const none = cli('verdict', '--rule', 'flat', '--a', lo, '--b', hi, '--where', 'observer=paged');
  assert.equal(none.code, 2, 'no run matches the filter: incomplete, not a pass');
});

test('verdict aa prints the noise margin, equal needs it declared, ledger lists every run', () => {
  const first = runs('aa-1', [1000, 1000, 1000]);
  const second = runs('aa-2', [1040, 1220, 980]);
  const aa = cli('verdict', '--rule', 'aa', '--a', first, '--b', second);
  assert.equal(aa.code, 0);
  assert.equal(JSON.parse(aa.out).margin, 0.22);
  assert.equal(cli('verdict', '--rule', 'equal', '--a', first, '--b', second).code, 2);
  assert.equal(cli('verdict', '--rule', 'equal', '--a', first, '--b', second, '--margin', '0.22').code, 0);
  assert.equal(cli('verdict', '--rule', 'equal', '--a', first, '--b', second, '--margin', '0.1').code, 1);
  const ledger = cli(
    'verdict',
    '--rule',
    'ledger',
    '--a',
    first,
    '--b',
    runs('aa-3', [1, 2], { valid: [true, false] }),
  );
  assert.equal(ledger.code, 0);
  assert.equal(ledger.out.trim().split('\n').length, 2 + 3 + 2);
  assert.match(ledger.out, /aa-3-1 \| 0\/default\/L3\/r1 \| INVALID: drained, ok/);
});

test('verdict warns about differing script hashes and dirty trees, and refuses bad usage', () => {
  const a = runs('w-a', [10_000, 10_000, 10_000], { sha: 'one' });
  const b = runs('w-b', [1, 1, 1], { sha: 'two', dirty: true });
  const out = cli('verdict', '--rule', 'halve', '--a', a, '--b', b).out;
  assert.match(out, /warning: base and candidate ran different benchmark script files/);
  assert.match(out, /warning: a run came from a dirty working tree/);
  assert.equal(cli('verdict', '--rule', 'nope', '--a', a, '--b', b).code, 2);
  assert.equal(cli('verdict', '--rule', 'halve', '--a', a).code, 2);
  assert.equal(cli('verdict', '--rule', 'halve', '--a', path.join(tmp, 'missing'), '--b', b).code, 2);
  assert.equal(cli('verdict', '--bogus').code, 2);
  assert.equal(cli('frobnicate').code, 2);
});

const WINDOWS = { warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 };

test('verdict does not count a pair whose runs differ in windows, load or host, and says so', () => {
  const a = runs('m-a', [10_000, 11_000, 9000], { meta: { windows: WINDOWS, host: { cpus: 10 } } });
  const same = runs('m-same', [4000, 5500, 4500], { meta: { windows: WINDOWS, host: { cpus: 10 } } });
  assert.equal(cli('verdict', '--rule', 'halve', '--a', a, '--b', same).code, 0);
  const short = runs('m-short', [4000, 5500, 4500], {
    meta: { windows: { ...WINDOWS, measureMs: 60_000 }, host: { cpus: 10 } },
  });
  const r = cli('verdict', '--rule', 'halve', '--a', a, '--b', short);
  assert.equal(r.code, 2, 'three pairs that do not share the windows are not three valid pairs');
  assert.match(r.out, /INCOMPLETE \(0 valid pairs/);
  assert.match(r.out, /warning: pair 0\|default\|L3\|0 does not count: the runs differ in windows/);
  const otherHost = runs('m-host', [4000, 5500, 4500], { meta: { windows: WINDOWS, host: { cpus: 4 } } });
  assert.match(cli('verdict', '--rule', 'halve', '--a', a, '--b', otherHost).out, /the runs differ in cpus/);
});

test('verdict does not count a pair whose runs differ in the arrival seed or the observer period', () => {
  const load = { seed: 7300, observerMs: 5000 };
  const a = runs('s-a', [10_000, 11_000, 9000], { cellExtra: load });
  const same = runs('s-same', [4000, 5500, 4500], { cellExtra: load });
  assert.equal(cli('verdict', '--rule', 'halve', '--a', a, '--b', same).code, 0);
  for (const [name, other, differs] of [
    ['s-seed', { ...load, seed: 7301 }, 'seed'],
    ['s-period', { ...load, observerMs: 1000 }, 'observerMs'],
  ]) {
    const r = cli('verdict', '--rule', 'halve', '--a', a, '--b', runs(name, [4000, 5500, 4500], { cellExtra: other }));
    assert.equal(r.code, 2, `${differs}: three pairs on different loads are not three valid pairs`);
    assert.match(r.out, /INCOMPLETE \(0 valid pairs/);
    assert.match(r.out, new RegExp(`does not count: the runs differ in ${differs}`));
  }
});

test('verdict needs three valid paired repeats in every cell, for the rules and for the A/A count', () => {
  // three cells (history x observer), one repeat each, in both arms: three valid pairs, but not three of any one cell
  const cells = (name, p95) => {
    runs(name, [p95], { tag: 'h0-' });
    runs(name, [p95], { history: '50k', tag: 'h50k-' });
    runs(name, [p95], { observer: 'none', tag: 'none-' });
    return path.join(tmp, name);
  };
  const a = cells('c-a', 10_000);
  const b = cells('c-b', 4000);
  const halved = cli('verdict', '--rule', 'halve', '--a', a, '--b', b);
  assert.equal(halved.code, 2);
  assert.match(halved.out, /INCOMPLETE \(1 valid pairs, 3 needed\) - needs 3 valid paired repeats in every cell/);
  const aa = cli('verdict', '--rule', 'aa', '--a', a, '--b', b);
  assert.equal(aa.code, 2, 'the A/A noise margin is not declared from three different cells');
  assert.equal(JSON.parse(aa.out).validPairs, 1);
  // a cell with its three repeats next to a thin one: the whole input is incomplete, one cell on its own is judged
  const mixed = (name, p95) => {
    runs(name, [p95, p95, p95], { tag: 'default-' });
    runs(name, [p95], { observer: 'none', tag: 'none-' });
    return path.join(tmp, name);
  };
  const ma = mixed('c-ma', 10_000);
  const mb = mixed('c-mb', 4000);
  assert.equal(cli('verdict', '--rule', 'halve', '--a', ma, '--b', mb).code, 2);
  assert.equal(cli('verdict', '--rule', 'aa', '--a', ma, '--b', mb).code, 2);
  assert.equal(cli('verdict', '--rule', 'halve', '--a', ma, '--b', mb, '--where', 'observer=default').code, 0);
  const aaOne = cli('verdict', '--rule', 'aa', '--a', ma, '--b', mb, '--where', 'observer=default');
  assert.deepEqual([aaOne.code, JSON.parse(aaOne.out).validPairs], [0, 3]);
});

test('verdict does not pick between two valid runs of a cell, and reports env, P8c and a base under the knee', () => {
  const a = runs('d-a', [10_000, 11_000, 9000]);
  const b = runs('d-b', [4000, 5500, 4500], { meta: { env: { DKG_STORE_MAX_CONCURRENT: '2' } } });
  mkdirSync(path.join(tmp, 'd-b', 'again'), { recursive: true });
  writeFileSync(
    path.join(tmp, 'd-b', 'again', 'summary.json'),
    JSON.stringify({
      meta: {
        runId: 'd-b-again',
        cell: { history: '0', observer: 'default', rung: 'L3', repeat: 1 },
        git: {},
        scriptSha256: 'abc',
      },
      submission: { F: 0.5, latencyMs: { p95: 100 } },
      validity: { ok: true },
    }),
  );
  const ambiguous = cli('verdict', '--rule', 'halve', '--a', a, '--b', b);
  assert.equal(ambiguous.code, 2);
  assert.match(
    ambiguous.out,
    /pair 0\|default\|L3\|1 does not count: b has 2 valid runs for this key \(d-b-again, d-b-1\)/,
  );
  assert.match(ambiguous.out, /the DKG_STORE_\* env differs between the arms/);
  rmSync(path.join(tmp, 'd-b', 'again'), { recursive: true });
  const p8c = { evaluable: true, ratio: 3, backlogTrip: false, trigger: true };
  const trip = runs('d-trip', [4000, 5500, 4500], { worker: { p8c } });
  const tripped = cli('verdict', '--rule', 'halve', '--a', a, '--b', trip);
  assert.equal(tripped.code, 0, 'the P8c trigger is reported, it does not change the verdict');
  assert.match(tripped.out, /warning: run d-trip-0: P8c trigger \(claimNext P95 ratio 3\)/);
  // the base has no failures, so its first repeat (P95 1000 ms) is under the knee while the other two (11 s, 9 s) are
  // over it
  const soft = cli(
    'verdict',
    '--rule',
    'halve',
    '--a',
    runs('d-soft', [1000, 11_000, 9000], { F: 0 }),
    '--b',
    runs('d-fast', [400, 5000, 4000], { F: 0 }),
    '--json',
  );
  assert.equal(soft.code, 0);
  const softResult = JSON.parse(soft.out);
  assert.deepEqual([softResult.result.status, softResult.result.belowKnee], ['pass', ['0|default|L3|0']]);
  assert.equal(
    softResult.warnings.at(-1),
    'the base run is below the knee in 0|default|L3|0: the halving test is weak in those repeats',
  );
  assert.match(cli('verdict', '--rule', 'ledger', '--a', trip).out.split('\n')[2], /\| TRIP \|/);
});

test('verdict refuses a margin that is not a number and an unreadable summary', () => {
  const a = runs('x-a', [1000, 1000, 1000]);
  const b = runs('x-b', [1000, 1000, 1000]);
  assert.equal(cli('verdict', '--rule', 'equal', '--a', a, '--b', b, '--margin', 'wide').code, 2);
  assert.equal(cli('verdict', '--rule', 'equal', '--a', a, '--b', b, '--margin', '-1').code, 2);
  mkdirSync(path.join(tmp, 'x-bad'), { recursive: true });
  writeFileSync(path.join(tmp, 'x-bad', 'summary.json'), '{ not json');
  const bad = cli('verdict', '--rule', 'ledger', '--a', path.join(tmp, 'x-bad'));
  assert.equal(bad.code, 2);
  assert.match(bad.err, /cannot read the run summary/);
});

test('run refuses the paged observer before touching a backend and a non-loopback backend with exit 3', () => {
  assert.equal(cli('run', '--rung', 'L3', '--observer', 'paged').code, 2);
  assert.match(
    cli('run', '--rung', 'L3', '--observer', 'paged').err,
    /paged listing is not available in this build \(needs P8a\/P9b\)/,
  );
  assert.equal(cli('run', '--rung', 'L9').code, 2);
  assert.equal(cli('run').code, 2);
  const refused = cli('run', '--rung', 'L3', '--blazegraph-url', 'http://10.1.2.3:9999/bigdata/namespace/kb/sparql');
  assert.equal(refused.code, 3);
  assert.match(refused.err, /refusing the non-loopback backend 10\.1\.2\.3/);
});

test('run refuses non-integer counts, a missing seed file or calibration and bad windows with exit 2', () => {
  const fail = (...args) => {
    const r = cli('run', '--dry', '--rung', 'L3', ...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
    return r.err;
  };
  assert.match(fail('--repeat', 'x'), /--repeat must be an integer >= 0/);
  assert.match(fail('--repeat', '1.5'), /--repeat must be an integer/);
  assert.match(fail('--repeat=-1'), /--repeat must be an integer/);
  assert.match(fail('--seed', 'foo'), /--seed must be an integer >= 0/);
  assert.match(fail('--observer-ms', 'abc'), /--observer-ms must be an integer >= 1/);
  assert.match(fail('--observer-ms', '0'), /--observer-ms must be an integer >= 1/);
  assert.match(fail('--history', 'lots'), /--history: not a count/);
  assert.match(fail('--measure', '0'), /seconds \(measure > 0\)/);
  assert.match(fail('--warmup', 'soon'), /seconds/);
  assert.match(fail('--seed-file', path.join(tmp, 'nope.nq.gz'), '--history', '10k'), /seed file .* does not exist/);
  writeFileSync(path.join(tmp, 'bare.nq'), '');
  assert.match(
    fail('--seed-file', path.join(tmp, 'bare.nq'), '--history', '10k'),
    /cannot read the seed file manifest/,
  );
  // --repeats is checked by the parent before any child process starts, so it needs neither a backend nor the build
  assert.match(cli('run', '--rung', 'L3', '--repeats', '0').err, /--repeats must be an integer >= 1/);
  assert.match(cli('run', '--rung', 'L3', '--repeats', 'two').err, /--repeats must be an integer >= 1/);
  const missing = cli('run', '--dry', '--calibration', path.join(tmp, 'nope.json'));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /cannot read the calibration/);
  writeFileSync(path.join(tmp, 'norung.json'), JSON.stringify({ status: 'found', reproductionRung: 'L9', rungs: [] }));
  assert.match(cli('run', '--dry', '--calibration', path.join(tmp, 'norung.json')).err, /lists no rung L9/);
});

test('calibrate refuses the flags that decide what a calibration run is, and bad counts, with exit 2', () => {
  const owned = [
    ['--rung', 'L3'],
    ['--lambda', '4'],
    ['--calibration', 'x.json'],
    ['--history', '10k'],
    ['--observer', 'paged'],
    ['--repeat', '1'],
    ['--seed', '9'],
    ['--dry'],
  ];
  for (const args of owned) {
    const r = cli('calibrate', ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /calibrate sets the rung, history 0 and observer default itself: remove --/);
  }
  assert.match(cli('calibrate', '--calib-repeats', '0').err, /--calib-repeats must be an integer >= 1/);
  assert.match(cli('calibrate', '--ladder', 'L9').err, /unknown ladder entry L9/);
  assert.match(cli('calibrate', '--measure', '0').err, /seconds/);
});

test('run --dry loads the built product and prints the resolved config without a backend', () => {
  const r = cli('run', '--dry', '--rung', 'L3', '--history', '10k', '--repeat', '2');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.deepEqual(
    [out.dry, out.config.lambda, out.config.history, out.config.seed, out.config.warmupMs, out.config.measureMs],
    [true, 8, '10k', 7302, 30_000, 180_000],
  );
  assert.match(out.provenance.scriptSha256, /^[0-9a-f]{64}$/);
});

test('run --calibration takes the calibration windows as its defaults and flags a run that overrides them', () => {
  const file = path.join(tmp, 'calibration.json');
  const rung = { id: 'L2', lambda: 4, content: 3, aggregate: 1 };
  const windows = { warmupMs: 15_000, measureMs: 60_000, cooldownMs: 5000 };
  writeFileSync(
    file,
    JSON.stringify({
      status: 'found',
      reproductionRung: 'L3',
      subKneeRung: 'L2',
      windows,
      rungs: [rung, { ...rung, id: 'L3', lambda: 8 }],
    }),
  );
  const seed = path.join(tmp, 'seed.nq');
  writeFileSync(seed, '');
  writeFileSync(`${seed}.json`, JSON.stringify({ jobs: 10_000, sha256: 'abc', baseTime: 1 }));
  const dry = (...args) => {
    const r = cli('run', '--dry', ...args);
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out).config;
  };
  const adopted = dry('--calibration', file);
  assert.deepEqual(
    [adopted.rung, adopted.lambda, adopted.warmupMs, adopted.measureMs, adopted.cooldownMs],
    ['L3', 8, 15_000, 60_000, 5000],
  );
  assert.deepEqual([adopted.calibration.windowsDiffer, adopted.calibration.sha256.length], [false, 64]);
  const sub = dry('--calibration', file, '--at', 'sub-knee');
  assert.deepEqual([sub.rung, sub.lambda], ['L2', 4]);
  const longer = dry('--calibration', file, '--measure', '180');
  assert.deepEqual([longer.measureMs, longer.warmupMs, longer.calibration.windowsDiffer], [180_000, 15_000, true]);
  assert.equal(dry('--rung', 'L3').measureMs, 180_000, 'without a calibration the run defaults apply');
  const seeded = dry('--rung', 'L3', '--history', '10k', '--seed-file', seed);
  assert.deepEqual([seeded.seedFile.sha256, seeded.seedFile.jobs], ['abc', 10_000]);
  assert.equal(
    cli('run', '--dry', '--rung', 'L3', '--history', '50k', '--seed-file', seed).code,
    2,
    'the seed file holds 10k jobs',
  );
});
