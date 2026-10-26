// Known answers for the async queue contention verdict library (OT-RFC-73 P2a). Pure functions only: no backend, no dist.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CENSOR_MS, RUNGS, admissionSummary, depthSeries, equivalent, extractRecord, finalizeRequests, flat, groundTruth, guards, halve, kneeReached, ledgerMarkdown,
  median, noiseMargin, p8cTrigger, pairKey, pairRuns, percentile, pickReproductionRung, shareBacklog, summarize, validity,
} from '../../repro/async-queue-contention/verdict.mjs';
import { OBSERVER_CALLS, walkPages } from '../../repro/async-queue-contention/workload.mjs';

const rec = (p95Ms, o = {}) => ({ key: o.key ?? 'k', p95Ms, failureFrac: o.failureFrac ?? 0.5, valid: o.valid ?? true, completionsPerMin: o.completionsPerMin ?? 100 });
const pairsOf = (aVals, bVals, opts = {}) => aVals.map((a, i) => ({ key: `r${i}`, a: rec(a, opts.a), b: rec(bVals[i], opts.b), valid: opts.valid?.[i] ?? true }));

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
    mk('measure', 10_000, 'typed_reject_not_admitted', { code: 'PROMOTE_ADMISSION_UNAVAILABLE', phase: 'lock', admissionOutcome: 'not_admitted' }),
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
  const jobs = new Map([['a', [{}]], ['c', [{}]], ['e', [{}, {}]]]);
  assert.deepEqual(groundTruth(reqs, jobs), { nonSuccess: 2, uncertainButAdmitted: 1, notAdmitted: 1, successWithoutPersistedJob: 1, doubleAdmissions: 1 });
});

test('kneeReached is inclusive on both edges', () => {
  assert.equal(kneeReached({ p95Ms: 4999, failureFrac: 0.049 }), false);
  assert.equal(kneeReached({ p95Ms: 5000, failureFrac: 0 }), true);
  assert.equal(kneeReached({ p95Ms: 100, failureFrac: 0.05 }), true);
});

test('pickReproductionRung returns the first knee rung and the one below it', () => {
  const ladder = [{ id: 'L1', p95Ms: 300, failureFrac: 0 }, { id: 'L2', p95Ms: 900, failureFrac: 0 }, { id: 'L3', p95Ms: 10_200, failureFrac: 0.51 }, { id: 'L4', p95Ms: 11_000, failureFrac: 0.99 }];
  assert.deepEqual(pickReproductionRung(ladder), { status: 'found', rung: 'L3', subKneeRung: 'L2' });
  assert.deepEqual(pickReproductionRung(ladder.slice(2)), { status: 'below-ladder', rung: 'L3', subKneeRung: null });
  assert.deepEqual(pickReproductionRung(ladder.slice(0, 2)), { status: 'no-knee', rung: null, subKneeRung: null });
  assert.equal(RUNGS.find((r) => r.id === 'L3').lambda, 8, 'the G0/G0b reproduction load');
});

test('pairRuns reports missing runs and an invalid run makes the pair not count', () => {
  const cell = (history, repeat) => ({ history, observer: 'default', rung: 'L3', repeat });
  const mk = (history, repeat, valid = true) => ({ key: pairKey({ cell: cell(history, repeat) }), cell: cell(history, repeat), valid });
  assert.equal(pairKey({ cell: cell(0, 1) }), '0|default|L3|1');
  assert.equal(pairKey({ cell: cell(0, 1) }, { ignoreHistory: true }), 'default|L3|1');
  const { pairs, missing } = pairRuns([mk(0, 0), mk(0, 1), mk(0, 2, false)], [mk(0, 0), mk(0, 2), mk(0, 3)]);
  assert.deepEqual(pairs.map((p) => [p.key, p.valid]), [['0|default|L3|0', true], ['0|default|L3|2', false]]);
  assert.deepEqual(missing, [{ key: '0|default|L3|1', missingIn: 'b' }, { key: '0|default|L3|3', missingIn: 'a' }]);
  const flatKey = (r) => pairKey(r, { ignoreHistory: true });
  assert.equal(pairRuns([mk(0, 0)], [mk('50k', 0)], flatKey).pairs.length, 1);
  assert.equal(pairRuns([mk(0, 0, false), mk(0, 0, true)], [mk(0, 0)]).pairs[0].valid, true, 'a valid rerun replaces the discarded run');
});

test('halve: candidate P95 <= 0.5 x base in 3 of 3 paired repeats', () => {
  const pass = halve(pairsOf([10_000, 11_000, 9000], [4000, 5500, 4500]));
  assert.equal(pass.status, 'pass');
  assert.deepEqual(pass.perRepeat.map((r) => r.ratio), [0.4, 0.5, 0.5]);
  const fail = halve(pairsOf([10_000, 11_000, 9000], [4000, 5501, 4500]));
  assert.equal(fail.status, 'fail');
  assert.equal(fail.perRepeat[1].ratio, 0.5001);
  assert.equal(fail.perRepeat[1].ok, false);
  const two = halve(pairsOf([10_000, 11_000, 9000], [4000, 5500, 4500], { valid: [true, true, false] }));
  assert.equal(two.status, 'incomplete');
  assert.equal(two.have, 2);
  const healthy = pairsOf([10_000, 4000, 9000], [4000, 1000, 4500]);
  healthy[1].a.failureFrac = 0;
  assert.equal(halve(healthy).status, 'incomplete', 'a base run below the knee proves nothing');
});

test('flat: history 50k P95 <= 1.25 x history 0 in 3 of 3 paired repeats', () => {
  assert.equal(flat(pairsOf([800, 900, 1000], [1000, 1125, 1250])).status, 'pass');
  const fail = flat(pairsOf([800, 900, 1000], [1000, 1126, 1250]));
  assert.equal(fail.status, 'fail');
  assert.equal(fail.perRepeat[1].ratio, 1.2511);
});

test('noiseMargin is the worst A/A deviation with a 10 % floor; equivalent needs it declared', () => {
  const aa = (pairs) => pairs.map(([a, b], i) => ({ key: `r${i}`, a: rec(a), b: rec(b), valid: true }));
  assert.equal(noiseMargin(aa([[1000, 1040], [1000, 930], [1000, 1080]])), 0.1);
  assert.equal(noiseMargin(aa([[1000, 1040], [1000, 1220], [1000, 980]])), 0.22);
  assert.equal(noiseMargin(aa([[1000, 500]])), 1, 'a halving counts as a 100 % deviation');
  const ab = pairsOf([1000, 1000, 1000], [1050, 970, 1200]);
  assert.equal(equivalent(ab, 0.22).status, 'pass');
  assert.equal(equivalent(ab, 0.1).status, 'fail');
  assert.equal(equivalent(pairsOf([1000, 1000, 1000], [1000, 1000, 800]), 0.2).status, 'fail', 'below 1/(1+m) fails too');
  assert.throws(() => equivalent(ab), /margin/);
});

test('guards report the candidate failure fraction and completions without gating', () => {
  const pairs = pairsOf([10_000, 10_000], [4000, 4000]);
  pairs[0].b.failureFrac = 0.03;
  pairs[1].b.failureFrac = 0.02;
  pairs[1].b.completionsPerMin = 80;
  const g = guards(pairs);
  assert.deepEqual(g.failureFrac.map((x) => x.ok), [false, true]);
  assert.deepEqual(g.completions.map((x) => [x.ratio, x.ok]), [[1, true], [0.8, false]]);
});

test('depthSeries and shareBacklog sample interval depth every second', () => {
  assert.deepEqual(depthSeries([[0, 2500], [1000, Infinity]], 0, 4000), { n: 4, mean: 1.5, max: 2, first: 1, last: 1, slopePerMin: 0 });
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
  assert.deepEqual(p8cTrigger({ claimNext: series(100, 250), backlogMax: 10, runMs }), { evaluable: true, ratio: 2.5, backlogTrip: false, trigger: true });
  assert.equal(p8cTrigger({ claimNext: series(100, 190), backlogMax: 10, runMs }).trigger, false);
  assert.equal(p8cTrigger({ claimNext: series(100, 190), backlogMax: 5000, runMs }).trigger, false);
  assert.equal(p8cTrigger({ claimNext: series(100, 190), backlogMax: 5001, runMs }).trigger, true);
  const short = p8cTrigger({ claimNext: series(100, 250), backlogMax: 10, runMs: 180_000 });
  assert.equal(short.evaluable, false);
  assert.equal(short.trigger, false);
  assert.equal(p8cTrigger({ claimNext: series(100, 250).slice(0, 25), backlogMax: 0, runMs }).evaluable, false, 'fewer than 20 samples in the last window');
});

test('validity: arrivals within 4 sigma, drained, no invariant break, driver headroom, quiet idle publisher', () => {
  const ok = { lambda: 8, measureMs: 180_000, measured: 1440, stillInflight: 0, reconcileError: null, successWithoutJob: 0, doubleAdmissions: 0, driverCpu: 0.5, idlePublisherErrors: 0 };
  assert.equal(validity(ok).ok, true);
  assert.equal(validity(ok).arrivalsExpected, 1440);
  assert.equal(validity({ ...ok, measured: 1300 }).arrivalsWithin4Sigma, true, '140 <= 4 x sqrt(1440) = 151.8');
  assert.equal(validity({ ...ok, measured: 1250 }).arrivalsWithin4Sigma, false);
  assert.equal(validity({ ...ok, driverCpu: 0.79 }).driverHeadroomOk, true);
  assert.equal(validity({ ...ok, driverCpu: 0.81 }).ok, false);
  for (const bad of [{ stillInflight: 2 }, { reconcileError: 'boom' }, { successWithoutJob: 1 }, { doubleAdmissions: 1 }, { idlePublisherErrors: 3 }]) assert.equal(validity({ ...ok, ...bad }).ok, false, JSON.stringify(bad));
});

test('extractRecord maps a summary and ledgerMarkdown lists every run', () => {
  const summary = (valid, p95) => ({
    meta: { runId: 'r1', label: 'base', cell: { history: 0, observer: 'default', rung: 'L3', repeat: 1 }, git: { sha: '0123456789abcdef', dirty: false }, scriptSha256: 'abc', distStaleSuspected: false },
    submission: { F: 0.51, latencyMs: { p95 } }, worker: { completionsPerMin: 120 }, observer: { latencyMs: { p95: 900 } },
    validity: { ok: valid, drained: valid, driverHeadroomOk: true },
  });
  const good = extractRecord(summary(true, 10_200));
  assert.deepEqual(good, {
    key: '0|default|L3|1', label: 'base', cell: { history: 0, observer: 'default', rung: 'L3', repeat: 1 }, repeat: 1, valid: true, failedChecks: [], p95Ms: 10_200, failureFrac: 0.51,
    completionsPerMin: 120, observerP95Ms: 900, git: { sha: '0123456789abcdef', dirty: false }, scriptSha256: 'abc', distStaleSuspected: false, runId: 'r1',
  });
  const bad = extractRecord(summary(false, 9000));
  assert.deepEqual(bad.failedChecks, ['ok', 'drained']);
  const table = ledgerMarkdown([good, bad]).split('\n');
  assert.equal(table.length, 4);
  assert.match(table[3], /INVALID: ok, drained/);
});

test('walkPages walks every page and stops on a falsy cursor; the paged seam is empty until P8a/P9b', async () => {
  const pages = [{ rows: 100, nextCursor: 'c1' }, { rows: 100, nextCursor: 'c2' }, { rows: 37, nextCursor: null }], seen = [];
  const walked = await walkPages(async (cursor) => { seen.push(cursor); return pages[seen.length - 1]; });
  assert.deepEqual([walked.rows, walked.pages, walked.pageMs.length], [237, 3, 3]);
  assert.deepEqual(seen, [undefined, 'c1', 'c2']);
  const single = await walkPages(async () => ({ rows: 5 }));
  assert.deepEqual([single.rows, single.pages, single.pageMs.length], [5, 1, 1]);
  await assert.rejects(walkPages(async () => ({ rows: 1, nextCursor: 'same' })), /did not advance/);
  // This documents the seam: the PR that adds the paged listing (P8a / P9b) fills `paged` and MUST also update `default` (see workload.mjs); it changes this assertion.
  assert.equal(OBSERVER_CALLS.paged, null);
  assert.equal(typeof OBSERVER_CALLS.default, 'function');
  assert.equal((await OBSERVER_CALLS.default({ list: async (options) => { assert.deepEqual(options, {}); return [1, 2]; } })).rows, 2);
});

// ---------------------------------------------------------------- the verdict subcommand end to end (no backend)
const ENTRY = fileURLToPath(new URL('../../repro/async-queue-contention.mjs', import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), 'aqc-verdict-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes <root>/<name>/r<i>/summary.json for each p95 and returns the directory. */
function runs(name, p95s, { history = '0', observer = 'default', valid = [], F = 0.5, sha = 'abc', dirty = false } = {}) {
  p95s.forEach((p95, i) => {
    const dir = path.join(tmp, name, `r${i}`);
    mkdirSync(dir, { recursive: true });
    const ok = valid[i] ?? true;
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
      meta: { runId: `${name}-${i}`, label: name, cell: { history, observer, rung: 'L3', repeat: i }, git: { sha: '0123456789abcdef', dirty }, scriptSha256: sha, distStaleSuspected: false },
      submission: { F, latencyMs: { p95 } }, worker: { completionsPerMin: 100 }, observer: { latencyMs: { p95: 10 } }, validity: { drained: ok, ok },
    }));
  });
  return path.join(tmp, name);
}
const cli = (...args) => { const r = spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };

test('verdict halve: exit 0 on a pass, 1 on a fail, 2 when incomplete', () => {
  const base = runs('base', [10_000, 11_000, 9000]);
  const pass = cli('verdict', '--rule', 'halve', '--a', base, '--b', runs('good', [4000, 5500, 4500]));
  assert.equal(pass.code, 0);
  assert.match(pass.out, /halve: candidate P95 <= 0\.5 x base: PASS/);
  const fail = cli('verdict', '--rule', 'halve', '--a', base, '--b', runs('slow', [4000, 5501, 4500]));
  assert.equal(fail.code, 1);
  assert.match(fail.out, /FAIL/);
  const incomplete = cli('verdict', '--rule', 'halve', '--a', base, '--b', runs('thin', [4000, 5500, 4500], { valid: [true, false, true] }));
  assert.equal(incomplete.code, 2);
  assert.match(incomplete.out, /INCOMPLETE \(2 valid pairs/);
  const json = JSON.parse(cli('verdict', '--rule', 'halve', '--a', base, '--b', path.join(tmp, 'good'), '--json').out);
  assert.deepEqual([json.result.status, json.result.perRepeat.length, json.missing.length], ['pass', 3, 0]);
});

test('verdict flat pairs across histories and honours --where', () => {
  const lo = runs('h0', [800, 900, 1000]), hi = runs('h50k', [1000, 1125, 1250], { history: '50k' });
  assert.equal(cli('verdict', '--rule', 'flat', '--a', lo, '--b', hi, '--where', 'observer=default').code, 0);
  assert.equal(cli('verdict', '--rule', 'flat', '--a', lo, '--b', runs('h50k-slow', [1000, 1126, 1250], { history: '50k' })).code, 1);
  const none = cli('verdict', '--rule', 'flat', '--a', lo, '--b', hi, '--where', 'observer=paged');
  assert.equal(none.code, 2, 'no run matches the filter: incomplete, not a pass');
});

test('verdict aa prints the noise margin, equal needs it declared, ledger lists every run', () => {
  const first = runs('aa-1', [1000, 1000, 1000]), second = runs('aa-2', [1040, 1220, 980]);
  const aa = cli('verdict', '--rule', 'aa', '--a', first, '--b', second);
  assert.equal(aa.code, 0);
  assert.equal(JSON.parse(aa.out).margin, 0.22);
  assert.equal(cli('verdict', '--rule', 'equal', '--a', first, '--b', second).code, 2);
  assert.equal(cli('verdict', '--rule', 'equal', '--a', first, '--b', second, '--margin', '0.22').code, 0);
  assert.equal(cli('verdict', '--rule', 'equal', '--a', first, '--b', second, '--margin', '0.1').code, 1);
  const ledger = cli('verdict', '--rule', 'ledger', '--a', first, '--b', runs('aa-3', [1, 2], { valid: [true, false] }));
  assert.equal(ledger.code, 0);
  assert.equal(ledger.out.trim().split('\n').length, 2 + 3 + 2);
  assert.match(ledger.out, /aa-3-1 \| 0\/default\/L3\/r1 \| INVALID: drained, ok/);
});

test('verdict warns about differing script hashes and dirty trees, and refuses bad usage', () => {
  const a = runs('w-a', [10_000, 10_000, 10_000], { sha: 'one' }), b = runs('w-b', [1, 1, 1], { sha: 'two', dirty: true });
  const out = cli('verdict', '--rule', 'halve', '--a', a, '--b', b).out;
  assert.match(out, /warning: base and candidate ran different benchmark script files/);
  assert.match(out, /warning: a run came from a dirty working tree/);
  assert.equal(cli('verdict', '--rule', 'nope', '--a', a, '--b', b).code, 2);
  assert.equal(cli('verdict', '--rule', 'halve', '--a', a).code, 2);
  assert.equal(cli('verdict', '--rule', 'halve', '--a', path.join(tmp, 'missing'), '--b', b).code, 2);
  assert.equal(cli('verdict', '--bogus').code, 2);
  assert.equal(cli('frobnicate').code, 2);
});

test('run refuses the paged observer before touching a backend and a non-loopback backend with exit 3', () => {
  assert.equal(cli('run', '--rung', 'L3', '--observer', 'paged').code, 2);
  assert.match(cli('run', '--rung', 'L3', '--observer', 'paged').err, /paged listing is not available in this build \(needs P8a\/P9b\)/);
  assert.equal(cli('run', '--rung', 'L9').code, 2);
  assert.equal(cli('run').code, 2);
  const refused = cli('run', '--rung', 'L3', '--blazegraph-url', 'http://10.1.2.3:9999/bigdata/namespace/kb/sparql');
  assert.equal(refused.code, 3);
  assert.match(refused.err, /refusing the non-loopback backend 10\.1\.2\.3/);
});

test('run --dry loads the built product and prints the resolved config without a backend', () => {
  const r = cli('run', '--dry', '--rung', 'L3', '--history', '10k', '--repeat', '2');
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.deepEqual([out.dry, out.config.lambda, out.config.history, out.config.seed, out.config.warmupMs, out.config.measureMs], [true, 8, '10k', 7302, 30_000, 180_000]);
  assert.match(out.provenance.scriptSha256, /^[0-9a-f]{64}$/);
});
