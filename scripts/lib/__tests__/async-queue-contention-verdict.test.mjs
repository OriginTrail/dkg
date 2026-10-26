// Known answers for the async queue contention verdict library and the CLI around it (OT-RFC-73 P2a). No backend. Only
// the `run --dry` tests need the built workspace (pnpm run build:packages): a refused or invalid invocation exits
// before the product is loaded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DATA_OPS_PER_SHARE } from '../../repro/async-queue-contention/fixture.mjs';
import {
  CENSOR_MS,
  RUNGS,
  aaDeclaration,
  admissionSummary,
  comparability,
  depthSeries,
  equivalent,
  extractRecord,
  finalizeRequests,
  flat,
  flatArmProblems,
  groundTruth,
  guards,
  halve,
  integrityWarnings,
  kneeReached,
  ledgerMarkdown,
  median,
  noiseMargin,
  p8cOfRun,
  p8cTrigger,
  pairKey,
  p95Ratio,
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
/** The runs of these pairs labelled with the histories of the arms (the flatness rule's base 0, candidate 50k). */
const onHistories = (pairs, a = '0', b = '50k') =>
  pairs.map((p) => ({ ...p, a: { ...p.a, cell: { history: a } }, b: { ...p.b, cell: { history: b } } }));

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
  platform: 'linux-x64',
  cpuModel: 'Intel(R) Xeon(R) CPU',
  hostId: 'host-a',
  ...o,
});
const withConfig = (o = {}, extra = {}) => ({ key: 'k0', runId: 'r', valid: true, config: config(o), ...extra });

test('comparability names the settings two runs of a pair must share and only reports an env difference', () => {
  assert.deepEqual(comparability(withConfig(), withConfig()), { differs: [], envDiffers: false, unverified: [] });
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
    platform: 'darwin-arm64',
    cpuModel: 'Apple M4',
    hostId: 'host-b',
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
    'platform',
    'cpuModel',
    'hostId',
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
  assert.deepEqual(
    comparability({}, {}),
    { differs: [], envDiffers: false, unverified: ['platform', 'cpuModel', 'hostId'] },
    'records without a config do not differ, but their host cannot be confirmed to be the same',
  );
});

test('comparability needs one platform, CPU model and host; a host field a summary lacks is unverified', () => {
  const on = (o) => withConfig(o);
  // cpus=10 on both: only the platform and the CPU model tell a Linux Intel host from a macOS Apple one
  const linux = on({ cpus: 10, platform: 'linux-x64', cpuModel: 'Intel(R) Xeon(R) CPU', hostId: null });
  const mac = on({ cpus: 10, platform: 'darwin-arm64', cpuModel: 'Apple M4', hostId: null });
  assert.deepEqual(comparability(linux, mac).differs, ['platform', 'cpuModel']);
  assert.deepEqual(comparability(linux, on({ cpuModel: 'Apple M4', platform: 'linux-x64', hostId: null })).differs, [
    'cpuModel',
  ]);
  assert.deepEqual(comparability(on({ hostId: 'host-a' }), on({ hostId: 'host-b' })).differs, ['hostId']);
  assert.deepEqual(comparability(on({ hostId: 'host-a' }), on({ hostId: 'host-a' })), {
    differs: [],
    envDiffers: false,
    unverified: [],
  });
  // a summary from before these fields were recorded: nothing to compare, so nothing differs, but nothing confirms the
  // host either
  const old = on({ platform: null, cpuModel: null, hostId: null });
  assert.deepEqual(comparability(old, old), {
    differs: [],
    envDiffers: false,
    unverified: ['platform', 'cpuModel', 'hostId'],
  });
  assert.deepEqual(
    comparability(old, on({})).unverified,
    ['platform', 'cpuModel', 'hostId'],
    'one side lacking is enough',
  );
  assert.deepEqual(comparability(on({}), old).differs, []);
  // unknown on one field never hides a known difference on another
  const partial = comparability(on({ platform: null, cpuModel: 'Apple M4' }), on({ platform: 'darwin-arm64' }));
  assert.deepEqual([partial.differs, partial.unverified], [['cpuModel'], ['platform']]);
  const known = comparability(on({ platform: 'darwin-arm64', cpuModel: null, hostId: null }), on({ hostId: null }));
  assert.deepEqual([known.differs, known.unverified], [['platform'], ['cpuModel', 'hostId']]);
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

test('pairRuns does not count a pair recorded on different hosts, however many CPUs they share', () => {
  const record = (host) => extractRecord(summaryOf(true, 1000, { meta: { host } }));
  const linux = { cpus: 10, platform: 'linux-x64', model: 'Intel(R) Xeon(R) CPU', hostId: 'host-a' };
  const mac = { cpus: 10, platform: 'darwin-arm64', model: 'Apple M4', hostId: 'host-b' };
  const pair = (a, b, opts) => pairRuns([record(a)], [record(b)], undefined, opts).pairs[0];
  assert.deepEqual([pair(linux, linux).valid, pair(linux, linux).reasons], [true, []]);
  // cpus=10 on both, and nothing else in the configuration differs
  const across = pair({ ...linux, hostId: undefined }, { ...mac, hostId: undefined });
  assert.equal(across.valid, false);
  assert.deepEqual(across.reasons, ['the runs differ in platform, cpuModel']);
  assert.equal(pair(linux, mac).valid, false);
  assert.match(pair(linux, mac).reasons[0], /differ in platform, cpuModel, hostId/);
  assert.equal(pair(linux, mac, { ignoreSeed: true }).valid, false, 'the flatness rule compares histories, not hosts');
  // one machine model, two machines
  assert.deepEqual(pair(linux, { ...linux, hostId: 'host-c' }).reasons, ['the runs differ in hostId']);
  // summaries from before the identity was recorded still pair (nothing differs) but are flagged as unconfirmed
  const old = pair({ cpus: 10 }, { cpus: 10 });
  assert.deepEqual([old.valid, old.reasons, old.unverified], [true, [], ['platform', 'cpuModel', 'hostId']]);
  const mixed = pair({ cpus: 10 }, linux);
  assert.deepEqual([mixed.valid, mixed.unverified], [true, ['platform', 'cpuModel', 'hostId']]);
  // a known difference is not hidden by an unknown field next to it
  const half = pair({ cpus: 10, platform: 'linux-x64' }, { cpus: 10, platform: 'darwin-arm64' });
  assert.deepEqual(
    [half.valid, half.reasons, half.unverified],
    [false, ['the runs differ in platform'], ['cpuModel', 'hostId']],
  );
  assert.deepEqual(pair(linux, linux).unverified, []);
  // and the repeats of such a pair do not add up to a verdict
  const pairs = [0, 1, 2].map((i) => ({ ...pair(linux, mac), key: `0|default|L3|${i}` }));
  assert.deepEqual([halve(pairs).status, halve(pairs).have], ['incomplete', 0]);
});

/** Valid pairs [a, b] P95s per cell; the key is the pairKey of the cell and the repeat index. */
const cellPairs = (spec) =>
  spec.flatMap(([cell, p95s]) => p95s.map(([a, b], i) => ({ key: `${cell}|${i}`, a: rec(a), b: rec(b), valid: true })));

test('a rule needs three valid paired repeats in every cell: the pairs of different cells do not add up', () => {
  const cells = ['0|default|L3', '0|none|L3', '50k|default|L3'];
  const oneEach = cellPairs(cells.map((cell) => [cell, [[10_000, 4000]]]));
  assert.deepEqual(repeatsPerCell(oneEach), { cells: Object.fromEntries(cells.map((c) => [c, 1])), have: 1 });
  for (const result of [halve(oneEach), flat(onHistories(oneEach)), equivalent(oneEach, 0.5)]) {
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
  // a cell that is in the comparison but has no valid pair is still a cell of the verdict (with 0 valid repeats): a
  // discarded run does not make it go away
  const stray = [...cellPairs([['0|default|L3', three]]), { key: '0|none|L3|0', a: rec(1), b: rec(1), valid: false }];
  const strayResult = halve(stray);
  assert.deepEqual([strayResult.status, strayResult.have], ['incomplete', 0]);
  assert.deepEqual(strayResult.cells, { '0|default|L3': 3, '0|none|L3': 0 });
  assert.deepEqual(repeatsPerCell([]), { cells: {}, have: 0 });
});

test('a cell with no valid pair at all makes every rule incomplete and is named with its 0 valid repeats', () => {
  const three = [[10_000, 4000], [11_000, 5500], [9000, 4500]];
  const history0 = cellPairs([['0|default|L3', three]]);
  assert.equal(halve(history0).status, 'pass', 'history 0 on its own passes');
  // history 50k: three repeats, every one of them discarded (invalid), so no valid pair in that cell
  const history50k = cellPairs([['50k|default|L3', three]]).map((p) => ({ ...p, valid: false }));
  const pairs = [...history0, ...history50k];
  const expectedCells = { '0|default|L3': 3, '50k|default|L3': 0 };
  assert.deepEqual(repeatsPerCell(pairs), { cells: expectedCells, have: 0 });
  for (const result of [halve(pairs), equivalent(pairs, 0.5), flat(onHistories(pairs))]) {
    assert.equal(result.status, 'incomplete', `${result.label}: never a pass with an unverified cell`);
    assert.deepEqual([result.have, result.cells], [0, expectedCells], result.label);
    assert.match(result.reason, /needs 3 valid paired repeats in every cell, the thinnest has 0 \(/, result.label);
    assert.match(result.reason, /; no valid pair in 50k\|default\|L3$/, result.label);
  }
  // a cell that has runs in one arm only is a cell of the verdict too: pairRuns reports it as missing, not as a pair
  const onlyInA = [{ key: '50k|default|L3|0', missingIn: 'b' }];
  assert.deepEqual(repeatsPerCell(history0, onlyInA), {
    cells: { '0|default|L3': 3, '50k|default|L3': 0 },
    have: 0,
  });
  for (const result of [
    halve(history0, { missing: onlyInA }),
    equivalent(history0, 0.5, { missing: onlyInA }),
    flat(onHistories(history0), { missing: onlyInA }),
  ]) {
    assert.equal(result.status, 'incomplete', result.label);
    assert.match(result.reason, /; no valid pair in 50k\|default\|L3$/, result.label);
  }
  // a missing repeat of a cell that has valid pairs is not a cell of its own
  assert.deepEqual(repeatsPerCell(history0, [{ key: '0|default|L3|9', missingIn: 'a' }]).cells, { '0|default|L3': 3 });
});

test('a valid rerun replaces a discarded repeat in the same cell, so the cell keeps its three valid pairs', () => {
  const side = (history, repeat, valid, p95Ms) => {
    const cell = { history, observer: 'default', rung: 'L3', repeat };
    return { key: pairKey({ cell }), cell, valid, p95Ms, failureFrac: 0.5, completionsPerMin: 100 };
  };
  const base = [
    side('0', 0, true, 10_000),
    side('0', 1, false, 99_999),
    side('0', 1, true, 11_000),
    side('0', 2, true, 9000),
  ];
  const head = [side('0', 0, true, 4000), side('0', 1, true, 5500), side('0', 2, true, 4500)];
  const { pairs, missing } = pairRuns(base, head);
  assert.deepEqual(missing, []);
  assert.deepEqual(
    pairs.map((p) => [p.key, p.valid, p.a.p95Ms]),
    [
      ['0|default|L3|0', true, 10_000],
      ['0|default|L3|1', true, 11_000],
      ['0|default|L3|2', true, 9000],
    ],
    'the discarded run is replaced, not paired',
  );
  const result = halve(pairs, { missing });
  assert.deepEqual([result.status, result.have, result.cells], ['pass', 3, { '0|default|L3': 3 }]);
  // without the rerun the repeat is a pair that does not count, and the cell is one short
  const discarded = pairRuns([base[0], base[1], base[3]], head);
  const short = halve(discarded.pairs);
  assert.deepEqual([discarded.pairs[1].valid, short.status, short.have], [false, 'incomplete', 2]);
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
  assert.equal(flat(onHistories(pairsOf([800, 900, 1000], [1000, 1125, 1250]))).status, 'pass');
  const fail = flat(onHistories(pairsOf([800, 900, 1000], [1000, 1126, 1250])));
  assert.equal(fail.status, 'fail');
  assert.equal(fail.perRepeat[1].ratio, 1.2511);
});

test('flat needs history 0 in arm a and history 50k in arm b: reversed, equal or unlabelled arms never pass', () => {
  const good = onHistories(pairsOf([800, 900, 1000], [1000, 1125, 1250]));
  assert.deepEqual(flatArmProblems(good.map((p) => p.a), good.map((p) => p.b)), []);
  // swapped arms: base 5000 ms at history 50k against 1000 ms at history 0 is a ratio of 0.2, far under the limit
  const reversed = flat(onHistories(pairsOf([5000, 5000, 5000], [1000, 1000, 1000]), '50k', '0'));
  assert.equal(reversed.status, 'incomplete');
  assert.deepEqual([reversed.have, reversed.perRepeat], [0, []]);
  assert.match(reversed.reason, /--a must hold history 0 runs only \(found history 50k\)/);
  assert.match(reversed.reason, /--b must hold history 50k runs only \(found history 0\)/);
  // one history against itself is a ratio of 1
  const same = flat(onHistories(pairsOf([1000, 1000, 1000], [1000, 1000, 1000]), '0', '0'));
  assert.equal(same.status, 'incomplete');
  assert.match(same.reason, /--b must hold history 50k runs only \(found history 0\)/);
  assert.doesNotMatch(same.reason, /--a must/);
  const sameLarge = flat(onHistories(pairsOf([1000, 1000, 1000], [1000, 1000, 1000]), '50k', '50k'));
  assert.equal(sameLarge.status, 'incomplete');
  assert.match(sameLarge.reason, /--a must hold history 0 runs only \(found history 50k\)/);
  // another history is not the large one
  assert.equal(flat(onHistories(pairsOf([800, 900, 1000], [1000, 1000, 1000]), '0', '10k')).status, 'incomplete');
  // numbers and strings read alike: a summary written by hand may carry history 0 as a number
  assert.equal(flat(onHistories(pairsOf([800, 900, 1000], [1000, 1125, 1250]), 0, '50k')).status, 'pass');
  // records that carry no history cannot be told from either arm
  const unlabelled = flat(pairsOf([800, 900, 1000], [1000, 1125, 1250]));
  assert.equal(unlabelled.status, 'incomplete');
  assert.match(unlabelled.reason, /found history undefined/);
  // the whole arms are checked, not only the runs that paired: a stray history 50k run in arm a counts
  const stray = flat(good, {
    aRecords: [...good.map((p) => p.a), { cell: { history: '50k' } }],
    bRecords: good.map((p) => p.b),
  });
  assert.equal(stray.status, 'incomplete');
  assert.match(stray.reason, /--a must hold history 0 runs only \(found history 50k\)/);
  // no runs at all is not an orientation problem: it is incomplete for want of pairs
  assert.deepEqual(flatArmProblems([], []), []);
  assert.equal(flat([]).status, 'incomplete');
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
  // the margin is rounded up, never to nearest: a margin under the worst deviation fails the very pairs that set it
  for (const [a, b] of [
    [1000, 1123.44],
    [1123.44, 1000],
  ]) {
    const same = aa([
      [a, b],
      [a, b],
      [a, b],
    ]);
    const margin = noiseMargin(same);
    assert.ok(margin >= 0.12344, `${a} vs ${b}: margin ${margin} is under the 12.344 % deviation`);
    assert.ok(margin <= 0.1235, `${a} vs ${b}: margin ${margin} is rounded up to 4 decimals, no further`);
    const replay = pairsOf([a, a, a], [b, b, b]);
    assert.equal(equivalent(replay, margin).status, 'pass', `${a} vs ${b}: the A/A pairs pass their own margin`);
  }
  assert.equal(noiseMargin(aa([[1000, 1100]])), 0.1, 'an exact 10 % deviation stays on the floor');
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

test('zero P95s: 0 vs 0 is a ratio of 1, a zero against a nonzero P95 is unbounded, never NaN', () => {
  const aa = (pairs) => pairs.map(([a, b], i) => ({ key: `r${i}`, a: rec(a), b: rec(b), valid: true }));
  // the one ratio every rule and the A/A margin read
  assert.equal(p95Ratio(0, 0), 1);
  assert.equal(p95Ratio(0, 5), Infinity, 'a nonzero candidate over a base of 0');
  assert.equal(p95Ratio(5, 0), 0, 'a candidate of 0 over a nonzero base');
  assert.equal(p95Ratio(1000, 1250), 1.25);

  // three identical zero pairs: no deviation, the 10 % floor is the margin, and the pairs pass it
  const zeros = aa([
    [0, 0],
    [0, 0],
    [0, 0],
  ]);
  assert.equal(noiseMargin(zeros), 0.1);
  const zeroRun = pairsOf([0, 0, 0], [0, 0, 0]);
  const same = equivalent(zeroRun, noiseMargin(zeros));
  assert.equal(same.status, 'pass');
  assert.deepEqual(
    same.perRepeat.map((r) => r.ratio),
    [1, 1, 1],
  );
  // a zero pair among healthy ones does not move the margin either
  assert.equal(
    noiseMargin(
      aa([
        [0, 0],
        [1000, 1220],
        [1000, 980],
      ]),
    ),
    0.22,
  );

  // a zero against a nonzero P95 deviates without bound, in either order: no margin, not NaN
  for (const pair of [
    [0, 5],
    [5, 0],
  ]) {
    const margin = noiseMargin(aa([pair, [1000, 1000], [1000, 1000]]));
    assert.equal(margin, Infinity, `${pair}: an unbounded margin`);
    assert.throws(() => equivalent(pairsOf([0, 0, 0], [0, 0, 0]), margin), /margin/, 'it cannot be declared');
  }

  // ratioRule: the zero cases, once for halve, flat and equal
  const bothZero = pairsOf([0, 0, 0], [0, 0, 0]);
  assert.equal(halve(bothZero).status, 'fail', '0 vs 0 is a ratio of 1, above 0.5');
  assert.equal(flat(onHistories(bothZero)).status, 'pass', '0 vs 0 is a ratio of 1, inside 1.25');
  const zeroBase = pairsOf([0, 0, 0], [5, 5, 5]);
  for (const result of [halve(zeroBase), flat(onHistories(zeroBase)), equivalent(zeroBase, 0.5)]) {
    assert.equal(result.status, 'fail', `${result.label}: a nonzero candidate over a base of 0 is unbounded`);
    assert.ok(result.perRepeat.every((r) => r.ratio === Infinity && !r.ok));
  }
  const zeroCandidate = pairsOf([5, 5, 5], [0, 0, 0]);
  assert.equal(halve(zeroCandidate).status, 'pass', 'a candidate P95 of 0 over a nonzero base is a ratio of 0');
  assert.ok(halve(zeroCandidate).perRepeat.every((r) => r.ratio === 0));
  assert.equal(flat(onHistories(zeroCandidate)).status, 'pass');
  assert.equal(equivalent(zeroCandidate, 0.5).status, 'fail', 'a ratio of 0 is under 1 / (1 + m)');
});

test('aaDeclaration: complete only with 3 valid repeats per cell and a finite margin', () => {
  const aa = (pairs) => pairs.map(([a, b], i) => ({ key: `cell|r${i}`, a: rec(a), b: rec(b), valid: true }));
  const zeros = aaDeclaration(
    aa([
      [0, 0],
      [0, 0],
      [0, 0],
    ]),
  );
  assert.deepEqual(zeros, { margin: 0.1, validPairs: 3, cells: { cell: 3 }, status: 'complete' });

  for (const pair of [
    [0, 5],
    [5, 0],
  ]) {
    const unbounded = aaDeclaration(
      aa([
        [1000, 1040],
        [1000, 1000],
        pair,
      ]),
    );
    assert.equal(unbounded.status, 'incomplete', `${pair}: no success`);
    assert.equal(unbounded.margin, null, 'no number to declare');
    assert.equal(unbounded.validPairs, 3, 'the repeat count alone is complete');
    assert.match(unbounded.reason, /noise margin is unbounded.*P95 of 0 against a nonzero P95/);
  }

  // too few repeats stays incomplete, with its own reason, and both reasons are stated together
  const two = aaDeclaration(
    aa([
      [1000, 1040],
      [1000, 1000],
    ]),
  );
  assert.equal(two.status, 'incomplete');
  assert.equal(two.margin, 0.1);
  assert.match(two.reason, /needs 3 valid paired repeats in every cell, the thinnest has 2/);
  assert.doesNotMatch(two.reason, /unbounded/);
  const both = aaDeclaration(
    aa([
      [0, 5],
      [1000, 1000],
    ]),
  );
  assert.match(both.reason, /thinnest has 2.*unbounded/);
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

test('shareBacklog counts an indeterminate admission that reconciliation found persisted, in any window', () => {
  const requests = [
    { key: 'a', windowTag: 'measure', rawOutcome: 'success', outcome: 'success', jobId: 'j1', ended: 0 },
    // the client could not tell whether the write landed; the queue's own rows say it did, so it is a job to finish
    { key: 'b', windowTag: 'warmup', rawOutcome: 'indeterminate', outcome: 'indeterminate', ended: 1000 },
    { key: 'c', windowTag: 'measure', rawOutcome: 'typed_reject_not_admitted', outcome: 'typed_reject_not_admitted', ended: 500 },
  ];
  const persisted = new Map([
    ['a', [{ jobId: 'j1' }]],
    ['b', [{ jobId: 'j2' }]],
  ]);
  assert.equal(groundTruth(requests, persisted).uncertainButAdmitted, 0, 'the persisted job id is stamped outside the measure window too');
  const b = shareBacklog({ requests, completions: [{ jobId: 'j1', t: 2500 }], from: 0, to: 4000 });
  assert.deepEqual([b.mean, b.max, b.first, b.last, b.jobs, b.openAtEnd], [1.5, 2, 1, 1, 2, 1]);
  // the reconciled job finishing ends its interval like an acknowledged one
  const done = shareBacklog({
    requests,
    completions: [
      { jobId: 'j1', t: 2500 },
      { jobId: 'j2', t: 2800 },
    ],
    from: 0,
    to: 4000,
  });
  assert.deepEqual([done.max, done.last, done.jobs, done.openAtEnd], [2, 0, 2, 0]);
  // without reconciliation evidence only the acknowledged job is known
  const unreconciled = shareBacklog({
    requests: requests.map(({ gtJobId: _gtJobId, ...r }) => r),
    completions: [],
    from: 0,
    to: 4000,
  });
  assert.deepEqual([unreconciled.max, unreconciled.jobs], [1, 1]);

  // under admission contention the indeterminate ones are the backlog: the P8c indicator must see them
  const many = Array.from({ length: 5000 }, (_, i) => ({
    key: `k${i}`,
    windowTag: 'measure',
    rawOutcome: 'success',
    outcome: 'success',
    jobId: `s${i}`,
    ended: 0,
  }));
  many.push({ key: 'x', windowTag: 'measure', rawOutcome: 'indeterminate', outcome: 'indeterminate', ended: 0 });
  groundTruth(many, new Map([['x', [{ jobId: 'sx' }]]]));
  const backlog = shareBacklog({ requests: many, completions: [], from: 0, to: 1000 });
  assert.equal(backlog.max, 5001);
  assert.equal(p8cTrigger({ claimNext: [], backlogMax: backlog.max, horizonMs: 1000 }).backlogTrip, true);
});

test('p8cTrigger: claimNext P95 doubling between the first and last 5 minutes, or a 5,000-job backlog', () => {
  const horizonMs = 900_000;
  const series = (firstMs, lastMs) => [
    ...Array.from({ length: 30 }, (_, i) => ({ t: i * 1000, ms: firstMs })),
    ...Array.from({ length: 30 }, (_, i) => ({ t: horizonMs - 300_000 + i * 1000, ms: lastMs })),
  ];
  assert.deepEqual(p8cTrigger({ claimNext: series(100, 250), backlogMax: 10, horizonMs }), {
    evaluable: true,
    ratio: 2.5,
    backlogTrip: false,
    trigger: true,
  });
  assert.equal(p8cTrigger({ claimNext: series(100, 190), backlogMax: 10, horizonMs }).trigger, false);
  assert.equal(p8cTrigger({ claimNext: series(100, 190), backlogMax: 5000, horizonMs }).trigger, false);
  assert.equal(p8cTrigger({ claimNext: series(100, 190), backlogMax: 5001, horizonMs }).trigger, true);
  const short = p8cTrigger({ claimNext: series(100, 250), backlogMax: 10, horizonMs: 180_000 });
  assert.equal(short.evaluable, false);
  assert.equal(short.trigger, false);
  assert.equal(
    p8cTrigger({ claimNext: series(100, 250).slice(0, 25), backlogMax: 0, horizonMs }).evaluable,
    false,
    'fewer than 20 samples in the last window',
  );
});

test('p8cOfRun judges the 5,000-job backlog leg on the whole run, not on the measurement window', () => {
  const windows = { warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 };
  const admitted = (n, ended, prefix) =>
    Array.from({ length: n }, (_, i) => ({
      key: `${prefix}${i}`,
      windowTag: 'measure',
      rawOutcome: 'success',
      outcome: 'success',
      jobId: `${prefix}${i}`,
      ended,
    }));
  const claimNext = []; // no claimNext sample: the ratio leg cannot trip
  const judged = (requests, completions = []) => p8cOfRun({ requests, completions, claimNext, windows });

  // 4,990 open jobs through the measurement window, 5,010 by the end of the cooldown
  const growing = [...admitted(4990, 40_000, 'm'), ...admitted(20, 215_000, 'c')];
  const run = judged(growing);
  assert.equal(run.backlog.max, 4990, 'the measurement window statistics are the window');
  assert.equal(
    p8cTrigger({ claimNext, backlogMax: run.backlog.max, horizonMs: 220_000 }).backlogTrip,
    false,
    'the window maximum alone does not trip: that is what was judged before',
  );
  assert.deepEqual(run.p8c, { evaluable: false, ratio: null, backlogTrip: true, trigger: true, backlogMax: 5010 });

  // a peak in the warmup that has drained by the measurement window is still a backlog past the read's bound
  const drainedAt20s = Array.from({ length: 5010 }, (_, i) => ({ jobId: `w${i}`, t: 20_000 }));
  const early = judged(admitted(5010, 5_000, 'w'), drainedAt20s);
  assert.deepEqual([early.backlog.max, early.p8c.backlogMax, early.p8c.backlogTrip], [0, 5010, true]);

  // 5,000 exactly is not above 5,000, in any window
  const edge = judged([...admitted(4990, 40_000, 'm'), ...admitted(10, 215_000, 'c')]);
  assert.deepEqual([edge.p8c.backlogMax, edge.p8c.backlogTrip, edge.p8c.trigger], [5000, false, false]);

  // no request at all: a zero backlog, not a missing one
  assert.deepEqual(judged([]).p8c, {
    evaluable: false,
    ratio: null,
    backlogTrip: false,
    trigger: false,
    backlogMax: 0,
  });
});

test('p8cOfRun reads the exact whole-run backlog peak, not the one-second samples of it', () => {
  const windows = { warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 };
  const horizon = windows.warmupMs + windows.measureMs + windows.cooldownMs;
  assert.equal(horizon, 220_000);
  const admittedAt = (n, ended, prefix) =>
    Array.from({ length: n }, (_, i) => ({
      key: `${prefix}${i}`,
      windowTag: 'measure',
      rawOutcome: 'success',
      outcome: 'success',
      jobId: `${prefix}${i}`,
      ended,
    }));
  const judged = (requests, completions = []) => p8cOfRun({ requests, completions, claimNext: [], windows });
  const done = (prefix, t) => ({ jobId: prefix, t });

  // 5,000 jobs open from the start, then one admitted at 100 ms and completed at 900 ms: the backlog reaches 5,001 for
  // 800 ms, between the samples at t = 0 and t = 1,000 ms
  const burst = judged([...admittedAt(5000, 0, 'open'), ...admittedAt(1, 100, 'blip')], [done('blip0', 900)]);
  assert.deepEqual(burst.p8c, { evaluable: false, ratio: null, backlogTrip: true, trigger: true, backlogMax: 5001 });
  assert.equal(burst.backlog.max, 5000, 'the measurement window statistics are the samples of the window, unchanged');

  // 5,010 acknowledged at 219,500 ms, with the 220 s horizon and no completion: after the last whole-second sample
  const late = judged(admittedAt(5010, 219_500, 'late'));
  assert.deepEqual(late.p8c, { evaluable: false, ratio: null, backlogTrip: true, trigger: true, backlogMax: 5010 });
  assert.equal(late.backlog.max, 0);

  // exactly 5,000 is not above 5,000, however it is reached
  const edgeLate = judged(admittedAt(5000, 219_500, 'edge'));
  assert.deepEqual([edgeLate.p8c.backlogMax, edgeLate.p8c.backlogTrip, edgeLate.p8c.trigger], [5000, false, false]);
  const edgeBurst = judged([...admittedAt(4999, 0, 'open'), ...admittedAt(1, 100, 'blip')], [done('blip0', 900)]);
  assert.deepEqual([edgeBurst.p8c.backlogMax, edgeBurst.p8c.backlogTrip], [5000, false]);

  // a completion at the instant of an admission is not a phantom peak: a job done at 500 ms hands over to one admitted
  // at 500 ms (intervals are [admitted, completed)), so the depth never exceeds 5,000 ...
  const handover = judged(
    [...admittedAt(4999, 0, 'open'), ...admittedAt(1, 100, 'first'), ...admittedAt(1, 500, 'second')],
    [done('first0', 500), done('second0', 900)],
  );
  assert.deepEqual([handover.p8c.backlogMax, handover.p8c.backlogTrip], [5000, false]);
  // ... and with one millisecond of overlap it does: 5,001
  const overlap = judged(
    [...admittedAt(4999, 0, 'open'), ...admittedAt(1, 100, 'first'), ...admittedAt(1, 500, 'second')],
    [done('first0', 501), done('second0', 900)],
  );
  assert.deepEqual([overlap.p8c.backlogMax, overlap.p8c.backlogTrip], [5001, true]);

  // a job completed no later than it was acknowledged is never open: no phantom peak either
  const instant = judged([...admittedAt(5000, 0, 'open'), ...admittedAt(1, 100, 'quick')], [done('quick0', 100)]);
  assert.equal(instant.p8c.backlogMax, 5000);
  const beforeAck = judged([...admittedAt(5000, 0, 'open'), ...admittedAt(1, 100, 'quick')], [done('quick0', 40)]);
  assert.equal(beforeAck.p8c.backlogMax, 5000);

  // the horizon is part of the run: a job acknowledged at the end of the cooldown counts, one after it does not
  assert.equal(judged([...admittedAt(5000, 0, 'open'), ...admittedAt(1, horizon, 'end')]).p8c.backlogMax, 5001);
  assert.equal(judged([...admittedAt(5000, 0, 'open'), ...admittedAt(1, horizon + 1, 'after')]).p8c.backlogMax, 5000);
  assert.equal(judged(admittedAt(3, 0, 'x')).p8c.backlogMax, 3);
  assert.equal(judged([]).p8c.backlogMax, 0);
});

test('P8c claimNext windows end at the workload horizon: a slow shutdown cannot change the result', () => {
  const windows = { warmupMs: 60_000, measureMs: 780_000, cooldownMs: 60_000 };
  const horizon = windows.warmupMs + windows.measureMs + windows.cooldownMs;
  assert.equal(horizon, 900_000);
  // 100 ms claims in the first 5 min, 250 ms ones in the last 5 min up to the horizon: a ratio of 2.5
  const workload = [
    ...Array.from({ length: 30 }, (_, i) => ({ t: i * 1000, ms: 100 })),
    ...Array.from({ length: 30 }, (_, i) => ({ t: horizon - 300_000 + i * 1000, ms: 250 })),
  ];
  const judged = (claimNext, extra = {}) =>
    p8cOfRun({ requests: [], completions: [], claimNext, windows, ...extra }).p8c;
  const base = judged(workload);
  assert.deepEqual(base, { evaluable: true, ratio: 2.5, backlogTrip: false, trigger: true, backlogMax: 0 });

  // a 50 s drain after the horizon: the run ends at 950 s (the old input), and the winding-down worker keeps polling an
  // empty queue, fast. None of that is workload: the same claims in the workload give the same verdict
  const windDown = Array.from({ length: 50 }, (_, i) => ({ t: horizon + i * 1000, ms: 5 }));
  assert.deepEqual(judged([...workload, ...windDown], { runMs: 950_000 }), base);
  assert.deepEqual(judged([...workload, ...windDown]), base);
  // slow claims in the shutdown cannot trip a run that did not trip either ...
  const calm = [
    ...workload.slice(0, 30),
    ...workload.slice(30).map((c) => ({ ...c, ms: 150 })),
    ...Array.from({ length: 50 }, (_, i) => ({ t: horizon + i * 1000, ms: 5000 })),
  ];
  assert.deepEqual(judged(calm, { runMs: 950_000 }), {
    evaluable: true,
    ratio: 1.5,
    backlogTrip: false,
    trigger: false,
    backlogMax: 0,
  });
  // ... and the shutdown cannot make a run evaluable that has no claim in its last 5 min of workload
  const noLast = judged([...workload.slice(0, 30), ...windDown]);
  assert.deepEqual([noLast.evaluable, noLast.trigger], [false, false]);

  // the horizon is half-open, like the arrivals: a claim started 1 ms before it is workload, one at it is shutdown
  const slowAt = (t) => [...workload, ...Array.from({ length: 4 }, () => ({ t, ms: 100_000 }))];
  assert.equal(p8cTrigger({ claimNext: slowAt(horizon - 1), backlogMax: 0, horizonMs: horizon }).ratio, 1000);
  assert.equal(p8cTrigger({ claimNext: slowAt(horizon), backlogMax: 0, horizonMs: horizon }).ratio, 2.5);
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
    admissionsPending: 0,
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
    { admissionsPending: 1 },
  ]) {
    assert.equal(validity({ ...ok, ...bad }).ok, false, JSON.stringify(bad));
  }
  // admission writes still running when the ground truth was read: the reconciliation is unresolved, the run invalid
  assert.equal(validity(ok).admissionsSettled, true);
  for (const unresolved of [1, 12, null, undefined]) {
    const checks = validity({ ...ok, admissionsPending: unresolved });
    assert.deepEqual([checks.admissionsSettled, checks.ok], [false, false], String(unresolved));
  }
  const { admissionsPending: _omitted, ...withoutField } = ok;
  assert.equal(validity(withoutField).admissionsSettled, false, 'a summary without the evidence is not valid');
});

test('validity fails a run whose measure window saw no request, however short the window', () => {
  const worker = {
    agentErrors: 0,
    crashes: 0,
    failedTerminal: 0,
    succeeded: 20,
    attempted: 20,
    dataOps: 20 * DATA_OPS_PER_SHARE,
  };
  // --measure 0.1 at 8 shares/s expects 0.8 arrivals: zero is inside the 4-sigma band, and the warmup completions
  // satisfy the worker contract, so nothing else rejects a run that measured nothing
  const empty = {
    lambda: 8,
    measureMs: 100,
    measured: 0,
    stillInflight: 0,
    admissionsPending: 0,
    reconcileError: null,
    successWithoutJob: 0,
    doubleAdmissions: 0,
    driverCpu: 0.1,
    idlePublisherErrors: 0,
    worker,
    seedFileVerified: true,
  };
  const checks = validity(empty);
  assert.deepEqual(
    [checks.arrivalsWithin4Sigma, checks.workerContractOk, checks.dataPlaneReplayed],
    [true, true, true],
    'the other checks hold',
  );
  assert.deepEqual([checks.measurementObserved, checks.ok], [false, false]);
  const one = validity({ ...empty, measured: 1 });
  assert.deepEqual([one.measurementObserved, one.ok], [true, true], 'a single request in the window is enough');
  assert.equal(validity({ ...empty, measured: Number.NaN }).measurementObserved, false);
  assert.equal(validity({ ...empty, measureMs: 180_000, measured: 0 }).ok, false, 'and a long window still needs one');
});

test('validity fails a run whose worker side did not work (agent errors, crashes, replayed operations)', () => {
  const run = {
    lambda: 8,
    measureMs: 180_000,
    measured: 1440,
    stillInflight: 0,
    admissionsPending: 0,
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
    host: { cpus: 10, platform: 'linux-x64', model: 'Intel(R) Xeon(R) CPU', hostId: 'host-a' },
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
      platform: 'linux-x64',
      cpuModel: 'Intel(R) Xeon(R) CPU',
      hostId: 'host-a',
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
  const legacyHost = extractRecord(summaryOf(true, 1, { meta: { host: { cpus: 10 } } }));
  assert.deepEqual(
    [legacyHost.config.cpus, legacyHost.config.platform, legacyHost.config.cpuModel, legacyHost.config.hostId],
    [10, null, null, null],
    'a summary from before the host identity was recorded compares as unknown, not as a match to a known host',
  );
  const noHost = extractRecord(summaryOf(true, 1, { meta: { host: undefined } }));
  assert.deepEqual([noHost.config.cpus, noHost.config.platform, noHost.config.hostId], [null, null, null]);
  const table = ledgerMarkdown([good, bad]).split('\n');
  assert.equal(table.length, 4);
  // a run with no measured request has no P95 and no failure fraction: it never counts, whatever validity.ok says
  const emptyWindow = (submission) => ({ ...summaryOf(true, 1), submission });
  for (const submission of [
    { n: 0, F: null, latencyMs: null },
    { n: 0, F: null, latencyMs: { p95: null } },
    { n: 3, F: 0.1, latencyMs: null },
    { n: 3, latencyMs: { p95: 100 } },
    { n: 3, F: 0.1, latencyMs: { p95: Number.NaN } },
  ]) {
    const empty = extractRecord(emptyWindow(submission));
    assert.deepEqual([empty.valid, empty.failedChecks], [false, ['finiteMetrics']], JSON.stringify(submission));
  }
  const failing = extractRecord({
    ...emptyWindow({ n: 0, F: null, latencyMs: null }),
    validity: { ok: false, measurementObserved: false },
  });
  assert.deepEqual(failing.failedChecks, ['ok', 'measurementObserved', 'finiteMetrics']);
  assert.equal(extractRecord(emptyWindow({ n: 1, F: 0, latencyMs: { p95: 0 } })).valid, true, 'zero is a metric');
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
      rec('e', { p8c: { evaluable: false, ratio: null, backlogTrip: true, trigger: true, backlogMax: 5010 } }),
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
    'run e: P8c trigger (active backlog above 5,000 (run maximum 5010)): record it in the PR',
    "runs with windows other than their calibration's: b",
    'the base run is below the knee in k2: the halving test is weak in those repeats',
  ]);
  // pairs whose runs do not record the host cannot be confirmed to come from one machine: one warning, naming them
  const unconfirmed = integrityWarnings(
    [rec('a'), rec('b')],
    [
      { key: 'k0', reasons: [], envDiffers: false, unverified: ['platform', 'cpuModel', 'hostId'] },
      { key: 'k1', reasons: [], envDiffers: false, unverified: ['hostId'] },
      { key: 'k2', reasons: [], envDiffers: false, unverified: [] },
    ],
    null,
  );
  assert.equal(unconfirmed.length, 1);
  assert.match(unconfirmed[0], /^host identity \(platform, cpuModel, hostId\) is missing from a run of k0, k1: /);
  assert.match(unconfirmed[0], /cannot be confirmed to come from one machine/);
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
    submission = null,
    checks = null,
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
        submission: submission ?? { F, latencyMs: { p95 } },
        worker: { completionsPerMin: 100, ...worker },
        observer: { latencyMs: { p95: 10 } },
        validity: checks ?? { drained: ok, ok },
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

test('verdict flat needs --a at history 0 and --b at history 50k: reversed or equal arms never pass', () => {
  const lo = runs('fl-h0', [1000, 1000, 1000]);
  const hi = runs('fl-h50k', [5000, 5000, 5000], { history: '50k' });
  const oriented = cli('verdict', '--rule', 'flat', '--a', lo, '--b', hi);
  assert.equal(oriented.code, 1, 'history 50k at 5 x the P95 of history 0 fails the rule');
  // the same two directories the other way round: b/a = 0.2, which an unchecked rule reads as a pass
  const reversed = cli('verdict', '--rule', 'flat', '--a', hi, '--b', lo);
  assert.equal(reversed.code, 2);
  assert.match(reversed.out, /flat: history 50k P95 <= 1\.25 x history 0: INCOMPLETE/);
  assert.match(reversed.out, /--a must hold history 0 runs only \(found history 50k\)/);
  assert.match(reversed.out, /--b must hold history 50k runs only \(found history 0\)/);
  // one history against itself
  const itself = cli('verdict', '--rule', 'flat', '--a', lo, '--b', lo);
  assert.equal(itself.code, 2);
  assert.match(itself.out, /--b must hold history 50k runs only \(found history 0\)/);
  const itself50k = cli('verdict', '--rule', 'flat', '--a', hi, '--b', hi);
  assert.equal(itself50k.code, 2);
  assert.match(itself50k.out, /--a must hold history 0 runs only \(found history 50k\)/);
  // --where applies to both arms, so it cannot pick the two histories apart
  assert.equal(cli('verdict', '--rule', 'flat', '--a', lo, '--b', hi, '--where', 'history=0').code, 2);
  // a stray run of the wrong history in an arm is not ignored because it did not pair
  const stray = runs('fl-stray', [1000, 1000, 1000], { tag: 'h0-' });
  runs('fl-stray', [1000], { history: '50k', observer: 'paged', tag: 'h50k-' });
  const mixed = cli('verdict', '--rule', 'flat', '--a', stray, '--b', hi);
  assert.equal(mixed.code, 2);
  assert.match(mixed.out, /--a must hold history 0 runs only \(found history 50k\)/);
  const json = JSON.parse(cli('verdict', '--rule', 'flat', '--a', hi, '--b', lo, '--json').out);
  assert.deepEqual([json.result.status, json.result.perRepeat], ['incomplete', []]);
  assert.match(json.result.reason, /compares history 0 \(--a\) with history 50k \(--b\)/);
});

test('verdict does not count a run with no request in its measure window: incomplete, not a FAIL', () => {
  // the run a --measure 0.1 invocation can produce: resolved from the real CLI config, then judged by the real checks
  const dry = cli('run', '--dry', '--rung', 'L3', '--measure', '0.1');
  assert.equal(dry.code, 0, dry.err);
  const { lambda, measureMs } = JSON.parse(dry.out).config;
  assert.equal(measureMs, 100);
  const worker = {
    agentErrors: 0,
    crashes: 0,
    failedTerminal: 0,
    succeeded: 20,
    attempted: 20,
    dataOps: 20 * DATA_OPS_PER_SHARE,
  };
  const emptyChecks = validity({
    lambda,
    measureMs,
    measured: 0,
    stillInflight: 0,
    admissionsPending: 0,
    reconcileError: null,
    successWithoutJob: 0,
    doubleAdmissions: 0,
    driverCpu: 0.1,
    idlePublisherErrors: 0,
    worker,
    seedFileVerified: true,
  });
  const empty = { n: 0, nWarmup: 20, nCooldown: 1, outcomes: {}, F: null, latencyMs: null };
  const base = runs('em-base', [10_000, 11_000, 9000]);
  const never = (name, opts) => runs(name, [0, 0, 0], { submission: empty, ...opts });
  // (1) the summary carries the run's own checks
  const measured = never('em-checks', { checks: emptyChecks });
  const r1 = cli('verdict', '--rule', 'halve', '--a', base, '--b', measured);
  assert.equal(r1.code, 2, `incomplete, not a FAIL: ${r1.out}`);
  assert.match(r1.out, /INCOMPLETE \(0 valid pairs, 3 needed\)/);
  assert.doesNotMatch(r1.out, /NaN|null/);
  // the same runs as a base: no valid base either
  assert.equal(cli('verdict', '--rule', 'halve', '--a', measured, '--b', base).code, 2);
  assert.match(
    cli('verdict', '--rule', 'ledger', '--a', measured).out,
    /INVALID: measurementObserved, ok, finiteMetrics/,
    'the ledger says why',
  );
  // (2) a summary written before the measurement check existed: validity.ok holds, the metrics are null
  const legacy = never('em-legacy', { checks: { drained: true, ok: true } });
  const r2 = cli('verdict', '--rule', 'halve', '--a', base, '--b', legacy);
  assert.equal(r2.code, 2, `incomplete, not a FAIL: ${r2.out}`);
  assert.match(r2.out, /INCOMPLETE \(0 valid pairs, 3 needed\)/);
  assert.match(cli('verdict', '--rule', 'ledger', '--a', legacy).out, /INVALID: finiteMetrics/);
  // the other rules read the same records
  assert.equal(cli('verdict', '--rule', 'equal', '--a', base, '--b', legacy, '--margin', '0.2').code, 2);
  const flatLo = runs('em-h0', [1000, 1000, 1000]);
  const flatHi = never('em-h50k', { history: '50k', checks: emptyChecks });
  assert.equal(cli('verdict', '--rule', 'flat', '--a', flatLo, '--b', flatHi).code, 2);
  assert.equal(cli('verdict', '--rule', 'aa', '--a', base, '--b', legacy).code, 2);
  // one empty repeat in an otherwise complete arm leaves the cell one pair short instead of failing it
  const partial = runs('em-partial', [4000, 5500, 4500]);
  const some = JSON.parse(readFileSync(path.join(partial, 'r1', 'summary.json'), 'utf8'));
  writeFileSync(
    path.join(partial, 'r1', 'summary.json'),
    JSON.stringify({ ...some, submission: empty, validity: emptyChecks }),
  );
  const short = cli('verdict', '--rule', 'halve', '--a', base, '--b', partial);
  assert.equal(short.code, 2);
  assert.match(short.out, /INCOMPLETE \(2 valid pairs, 3 needed\)/);
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

test('verdict aa exits 0 only with a finite margin: 0 vs 0 is fine, a zero against a nonzero is incomplete', () => {
  // identical zero P95s: the margin is the floor, and the equal rule accepts the same pairs with it
  const z1 = runs('aa-z1', [0, 0, 0]);
  const z2 = runs('aa-z2', [0, 0, 0]);
  const zeros = cli('verdict', '--rule', 'aa', '--a', z1, '--b', z2);
  assert.equal(zeros.code, 0, zeros.err);
  assert.equal(JSON.parse(zeros.out).margin, 0.1);
  assert.equal(JSON.parse(zeros.out).status, 'complete');
  assert.equal(cli('verdict', '--rule', 'equal', '--a', z1, '--b', z2, '--margin', '0.1').code, 0);

  // a zero against a nonzero P95 in one repeat: three valid repeats, but no margin to declare
  for (const [name, first, second] of [
    ['zero-then-some', [1000, 1000, 0], [1000, 1000, 500]],
    ['some-then-zero', [1000, 1000, 500], [1000, 1000, 0]],
  ]) {
    const r = cli('verdict', '--rule', 'aa', '--a', runs(`${name}-1`, first), '--b', runs(`${name}-2`, second));
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    const out = JSON.parse(r.out);
    assert.equal(out.margin, null);
    assert.equal(out.status, 'incomplete');
    assert.equal(out.validPairs, 3);
    assert.match(out.reason, /noise margin is unbounded/);
  }
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

test('verdict does not count a pair from another platform or CPU model, and warns of an unrecorded host', () => {
  const linux = { cpus: 10, platform: 'linux-x64', model: 'Intel(R) Xeon(R) CPU', hostId: 'host-a' };
  const mac = { cpus: 10, platform: 'darwin-arm64', model: 'Apple M4', hostId: 'host-b' };
  const arm = (name, p95s, host) => runs(name, p95s, { meta: { windows: WINDOWS, host } });
  const base = arm('hp-base', [10_000, 11_000, 9000], linux);
  const same = cli('verdict', '--rule', 'halve', '--a', base, '--b', arm('hp-same', [4000, 5500, 4500], linux));
  assert.equal(same.code, 0);
  assert.doesNotMatch(same.out, /host identity/);
  // the same number of CPUs, a different machine: not three valid pairs
  const across = cli('verdict', '--rule', 'halve', '--a', base, '--b', arm('hp-mac', [4000, 5500, 4500], mac));
  assert.equal(across.code, 2);
  assert.match(across.out, /INCOMPLETE \(0 valid pairs, 3 needed\)/);
  assert.match(
    across.out,
    /warning: pair 0\|default\|L3\|0 does not count: the runs differ in platform, cpuModel, hostId/,
  );
  const noHostId = { ...mac, hostId: undefined };
  const linuxNoHostId = { ...linux, hostId: undefined };
  const model = cli(
    'verdict',
    '--rule',
    'halve',
    '--a',
    arm('hp-l2', [10_000, 11_000, 9000], linuxNoHostId),
    '--b',
    arm('hp-m2', [4000, 5500, 4500], noHostId),
  );
  assert.equal(model.code, 2);
  assert.match(model.out, /the runs differ in platform, cpuModel\n/);
  // another machine of the same kind
  const sibling = arm('hp-twin', [4000, 5500, 4500], { ...linux, hostId: 'host-c' });
  const twin = cli('verdict', '--rule', 'halve', '--a', base, '--b', sibling);
  assert.equal(twin.code, 2);
  assert.match(twin.out, /the runs differ in hostId/);
  // summaries from before the host identity was recorded still pair, and the verdict says the host is unconfirmed
  const old = cli(
    'verdict',
    '--rule',
    'halve',
    '--a',
    arm('hp-old-a', [10_000, 11_000, 9000], { cpus: 10 }),
    '--b',
    arm('hp-old-b', [4000, 5500, 4500], { cpus: 10 }),
  );
  assert.equal(old.code, 0);
  assert.match(
    old.out,
    /warning: host identity \(platform, cpuModel, hostId\) is missing from a run of 0\|default\|L3\|0, /,
  );
  // the A/A count reads the same pairs
  const aaB = arm('hp-aa', [10_000, 11_000, 9000], mac);
  const aa = JSON.parse(cli('verdict', '--rule', 'aa', '--a', base, '--b', aaB).out);
  assert.equal(aa.validPairs, 0);
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

test('verdict does not leave out an included cell that has no valid pair: incomplete, naming the cell', () => {
  const arm = (name, p95, { valid50k, with50k = true, observers = [] } = {}) => {
    runs(name, [p95, p95, p95], { tag: 'h0-' });
    if (with50k) runs(name, [p95, p95, p95], { history: '50k', tag: 'h50k-', valid: valid50k });
    for (const observer of observers) runs(name, [p95, p95, p95], { observer, tag: `${observer}-` });
    return path.join(tmp, name);
  };
  const base = arm('z-base', 10_000);
  const allInvalid = arm('z-bad', 4000, { valid50k: [false, false, false] });
  // history 0: three passing repeats; history 50k: three invalid repeats (in both arms, no pair of it counts)
  const r = cli('verdict', '--rule', 'halve', '--a', base, '--b', allInvalid);
  assert.equal(r.code, 2, `incomplete, never a PASS: ${r.out}`);
  assert.match(r.out, /halve: candidate P95 <= 0\.5 x base: INCOMPLETE \(0 valid pairs, 3 needed\)/);
  assert.match(r.out, /the thinnest has 0 \(\{"0\|default\|L3":3,"50k\|default\|L3":0\}\)/);
  assert.match(r.out, /; no valid pair in 50k\|default\|L3\n/);
  const json = JSON.parse(cli('verdict', '--rule', 'halve', '--a', base, '--b', allInvalid, '--json').out);
  assert.deepEqual([json.result.status, json.result.have], ['incomplete', 0]);
  assert.deepEqual(json.result.cells, { '0|default|L3': 3, '50k|default|L3': 0 });
  assert.equal(cli('verdict', '--rule', 'equal', '--margin', '0.5', '--a', base, '--b', allInvalid).code, 2);
  // --where is the way to judge the cell that has its pairs on its own: the filtered-out cell is not in the verdict
  assert.equal(cli('verdict', '--rule', 'halve', '--a', base, '--b', allInvalid, '--where', 'history=0').code, 0);
  assert.equal(cli('verdict', '--rule', 'halve', '--a', base, '--b', allInvalid, '--where', 'history=50k').code, 2);
  // a cell that only one arm holds is a cell of the verdict too
  const withoutCell = arm('z-none', 4000, { with50k: false });
  const lopsided = cli('verdict', '--rule', 'halve', '--a', base, '--b', withoutCell);
  assert.equal(lopsided.code, 2);
  assert.match(lopsided.out, /; no valid pair in 50k\|default\|L3\n/);
  assert.match(lopsided.out, /missing in b: 50k\|default\|L3\|0/);
  assert.equal(cli('verdict', '--rule', 'halve', '--a', withoutCell, '--b', base).code, 2, 'in either arm');
  // the A/A count is judged the same way: no noise margin from a cell with no valid pair
  const aa = cli('verdict', '--rule', 'aa', '--a', base, '--b', allInvalid);
  assert.equal(aa.code, 2);
  assert.deepEqual(JSON.parse(aa.out).cells, { '0|default|L3': 3, '50k|default|L3': 0 });
  assert.equal(JSON.parse(aa.out).validPairs, 0);
  assert.equal(cli('verdict', '--rule', 'aa', '--a', base, '--b', allInvalid, '--where', 'history=0').code, 0);
  // the flatness rule: observer cells (history is the arm), one of which has no valid pair
  const lo = arm('z-lo', 1000, { with50k: false, observers: ['paged'] });
  const hiValid = path.join(tmp, 'z-hi');
  runs('z-hi', [1000, 1000, 1000], { history: '50k', tag: 'default-' });
  runs('z-hi', [1000, 1000, 1000], { history: '50k', observer: 'paged', tag: 'paged-', valid: [false, false, false] });
  const flatCells = cli('verdict', '--rule', 'flat', '--a', lo, '--b', hiValid);
  assert.equal(flatCells.code, 2);
  assert.match(flatCells.out, /; no valid pair in paged\|L3\n/);
  assert.equal(cli('verdict', '--rule', 'flat', '--a', lo, '--b', hiValid, '--where', 'observer=default').code, 0);
  // valid reruns replace the discarded repeats of a cell: the cell keeps its three valid pairs
  const rerun = arm('z-rerun', 4000, { valid50k: [false, true, true] });
  runs('z-rerun', [4000], { history: '50k', tag: 'h50k-rerun-', cellExtra: { repeat: 0 } });
  const replaced = cli('verdict', '--rule', 'halve', '--a', base, '--b', rerun);
  assert.equal(replaced.code, 0, replaced.out);
  assert.match(replaced.out, /PASS \(3 valid pairs, 3 needed\)/);
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
