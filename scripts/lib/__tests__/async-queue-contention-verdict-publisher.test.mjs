// Known answers for the publisher and mixed cells of the async queue contention verdict library and the CLI around it
// (OT-RFC-73 P2b): pairing by stream, the run's validity with a publisher stream, the record, the rules on the publisher
// metrics, the G1b rule at the command line and the run flags of the new cells. No backend. Only `run --dry` needs the
// built workspace (pnpm run build:packages): a refused or invalid invocation exits before the product is loaded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIFT_TAIL_OPS } from '../../repro/async-queue-contention/fixture.mjs';
import {
  G0B_REFERENCE,
  G1B_CELLS,
  G1B_SEED_BASE,
  G1B_SETUP,
} from '../../repro/async-queue-contention/g1b.mjs';
import {
  FAMILIES,
  PUBLISH_RUNGS,
  RUNGS,
  comparability,
  equivalent,
  extractRecord,
  familyOf,
  flat,
  flatArmProblems,
  guards,
  halve,
  integrityWarnings,
  ledgerMarkdown,
  noWorse,
  noiseMargin,
  pairKey,
  pairRuns,
  validity,
  withMetric,
} from '../../repro/async-queue-contention/verdict.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../repro/async-queue-contention.mjs');
const tmp = mkdtempSync(path.join(tmpdir(), 'aqc-verdict-publisher-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

// ---------------------------------------------------------------- pairing
const cellOf = (o = {}) => ({ history: 0, observer: 'default', rung: 'PSTAR', repeat: 1, ...o });

test('a share cell keeps its P2a key; another stream and a lift history join the key, so cells of different streams never pair', () => {
  assert.equal(pairKey({ cell: cellOf({ rung: 'L3' }) }), '0|default|L3|1');
  assert.equal(pairKey({ cell: cellOf({ rung: 'L3', queue: 'share', liftHistory: '0' }) }), '0|default|L3|1');
  assert.equal(pairKey({ cell: cellOf({ queue: 'lift' }) }), '0|default|PSTAR|lift|1');
  assert.equal(pairKey({ cell: cellOf({ queue: 'both', rung: 'MIX' }) }), '0|default|MIX|both|1');
  assert.equal(pairKey({ cell: cellOf({ queue: 'lift', liftHistory: '10k' }) }), '0|default|PSTAR|lift|lift10k|1');
  assert.equal(pairKey({ cell: cellOf({ queue: 'lift', liftHistory: '10k' }) }, { ignoreLiftHistory: true }), '0|default|PSTAR|lift|1');
  assert.equal(pairKey({ cell: cellOf({ queue: 'lift', liftHistory: '10k' }) }, { ignoreHistory: true }), 'default|PSTAR|lift|lift10k|1');
});

const cfgOf = (o = {}) => ({
  windows: { warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 },
  lambda: 4,
  mu: 0.4,
  content: 3,
  aggregate: 1,
  seed: 7301,
  observerMs: 5000,
  calibrationSha256: null,
  seedFileSha256: null,
  liftSeedFileSha256: null,
  loadFactors: G1B_SETUP.loadFactors,
  liftModel: G1B_SETUP.liftModel,
  cpus: 10,
  ...o,
});

test('a pair must share the publish rate, the load factors, the chain-time model and the lift seed file', () => {
  const a = { config: cfgOf() };
  const same = comparability(a, { config: cfgOf() });
  assert.deepEqual(same, { differs: [], envDiffers: false });
  for (const [k, v] of [
    ['mu', 0.8],
    ['loadFactors', { ...G1B_SETUP.loadFactors, ack: false }],
    ['liftModel', { ...G1B_SETUP.liftModel, walletHoldMs: 100 }],
    ['liftSeedFileSha256', 'other'],
  ])
    assert.deepEqual(comparability(a, { config: cfgOf({ [k]: v }) }).differs, [k], k);
  assert.deepEqual(comparability(a, { config: cfgOf({ liftSeedFileSha256: 'other' }) }, { ignoreLiftSeed: true }).differs, []);
  assert.deepEqual(comparability(a, { config: cfgOf({ seedFileSha256: 'other' }) }, { ignoreLiftSeed: true }).differs, ['seedFileSha256']);
  // a P2a record has none of these keys and compares equal to another such record
  const old = { config: { lambda: 8, seed: 1 } };
  assert.deepEqual(comparability(old, { config: { lambda: 8, seed: 1 } }).differs, []);
  const rec = (config) => ({ key: 'k', valid: true, runId: 'r', config });
  const { pairs } = pairRuns([rec(cfgOf())], [rec(cfgOf({ mu: 1 }))]);
  assert.equal(pairs[0].valid, false);
  assert.match(pairs[0].reasons[0], /the runs differ in mu/);
  assert.equal(pairRuns([rec(cfgOf())], [rec(cfgOf({ liftSeedFileSha256: 'x' }))], undefined, { ignoreLiftSeed: true }).pairs[0].valid, true);
});

// ---------------------------------------------------------------- validity
const base = {
  lambda: 4,
  measureMs: 180_000,
  measured: 720,
  stillInflight: 0,
  reconcileError: null,
  successWithoutJob: 0,
  doubleAdmissions: 0,
  driverCpu: 0.3,
  seedFileVerified: true,
};
const shareWorker = { agentErrors: 0, crashes: 0, failedTerminal: 0, succeeded: 100, attempted: 100, dataOps: 4300 };
const publisher = {
  measured: 72,
  mu: 0.4,
  successWithoutJob: 0,
  doubleAdmissions: 0,
  errors: 0,
  stopTimedOut: false,
  reclaimed: 0,
  claimed: 70,
  finalized: 68,
  executions: 69,
  tailOps: 69 * LIFT_TAIL_OPS,
};
const SHARE_CHECKS = ['measurementObserved', 'arrivalsWithin4Sigma', 'noSuccessWithoutJob', 'noDoubleAdmission', 'workerContractOk', 'dataPlaneReplayed'];
const PUBLISH_CHECKS = [
  'publishMeasurementObserved',
  'publishArrivalsWithin4Sigma',
  'publishNoSuccessWithoutJob',
  'publishNoDoubleAdmission',
  'publisherQuiet',
  'publisherStopped',
  'publisherNoReclaims',
  'publisherClaimed',
  'publisherBodyReplayed',
];

test('a publish-only run is judged on its publisher stream alone: no share check, no idle publisher', () => {
  const v = validity({ ...base, lambda: 0, measured: 0, queue: 'lift', publisher });
  assert.equal(v.ok, true, JSON.stringify(v));
  for (const k of [...SHARE_CHECKS, 'idlePublisherQuiet']) assert.equal(k in v, false, k);
  for (const k of PUBLISH_CHECKS) assert.equal(v[k], true, k);
  assert.deepEqual([v.publishArrivalsMeasured, v.publishArrivalsExpected], [72, 72]);
  assert.deepEqual(['drained', 'noReconcileError', 'driverHeadroomOk', 'seedFileVerified'].map((k) => v[k]), [true, true, true, true]);
});

test('a mixed run needs both streams\' evidence and has no idle publisher', () => {
  const v = validity({ ...base, queue: 'both', publisher, worker: shareWorker });
  assert.equal(v.ok, true, JSON.stringify(v));
  for (const k of [...SHARE_CHECKS, ...PUBLISH_CHECKS]) assert.equal(v[k], true, k);
  assert.equal('idlePublisherQuiet' in v, false);
  assert.equal(validity({ ...base, queue: 'both', publisher }).workerContractOk, false, 'no worker evidence');
  assert.equal(validity({ ...base, queue: 'both', worker: shareWorker }).ok, false, 'a mixed run without publisher evidence is no run');
});

test('every publisher check fails on the evidence it stands for, and on a missing field', () => {
  const run = (o) => validity({ ...base, lambda: 0, measured: 0, queue: 'lift', publisher: { ...publisher, ...o } });
  for (const [o, failing] of [
    [{ measured: 0 }, ['publishMeasurementObserved', 'publishArrivalsWithin4Sigma']],
    [{ measured: 72 + 4 * Math.sqrt(72) + 1 }, ['publishArrivalsWithin4Sigma']],
    [{ successWithoutJob: 1 }, ['publishNoSuccessWithoutJob']],
    [{ doubleAdmissions: 1 }, ['publishNoDoubleAdmission']],
    [{ errors: 1 }, ['publisherQuiet']],
    [{ stopTimedOut: true }, ['publisherStopped']],
    [{ stopTimedOut: null }, ['publisherStopped']],
    [{ reclaimed: 1 }, ['publisherNoReclaims']],
    [{ claimed: 0, executions: 0, finalized: 0, tailOps: 0 }, ['publisherClaimed']],
    [{ executions: 67 }, ['publisherBodyReplayed']], // fewer executions than finished jobs
    [{ executions: 71 }, ['publisherBodyReplayed']], // more executions than claimed jobs
    [{ tailOps: 68 * LIFT_TAIL_OPS - 1 }, ['publisherBodyReplayed']], // fewer tail operations than finished jobs replay
    [{ tailOps: 70 * LIFT_TAIL_OPS }, ['publisherBodyReplayed']], // more than the executions can have issued
    [{ errors: undefined }, ['publisherQuiet']],
    [{ executions: undefined }, ['publisherBodyReplayed']],
    [{ mu: undefined }, ['publishArrivalsWithin4Sigma']],
  ]) {
    const v = run(o);
    assert.equal(v.ok, false, JSON.stringify(o));
    assert.deepEqual(PUBLISH_CHECKS.filter((k) => v[k] === false), failing, JSON.stringify(o));
  }
  assert.equal(run({ executions: 68, tailOps: 68 * LIFT_TAIL_OPS }).ok, true, 'a job cut short by the shutdown may be unfinished');
});

test('the probes and ACKs that were switched on must have run, and a lift seed file must hash as its manifest says', () => {
  const run = (load, extra = {}) => validity({ ...base, queue: 'both', publisher, worker: shareWorker, load, ...extra });
  assert.equal(run({ probes: true, ack: true, statusProbes: 18, metricsProbes: 6, acksStarted: 45 }).ok, true);
  assert.deepEqual(
    [run({ probes: true, ack: false, statusProbes: 0, metricsProbes: 6 }).probesAnswered, run({ probes: true, ack: false, statusProbes: 3, metricsProbes: 0 }).probesAnswered],
    [false, false],
  );
  const noAck = run({ probes: false, ack: true, acksStarted: 0 });
  assert.deepEqual([noAck.acksRan, noAck.ok, 'probesAnswered' in noAck], [false, false, false]);
  assert.equal('probesAnswered' in run(null), false);
  assert.equal(run({ probes: true, statusProbes: undefined, metricsProbes: 1 }).probesAnswered, false, 'missing evidence fails');
  assert.equal(run(null, { liftSeedFileVerified: true }).liftSeedFileVerified, true);
  const bad = run(null, { liftSeedFileVerified: false });
  assert.deepEqual([bad.liftSeedFileVerified, bad.ok], [false, false]);
  assert.equal('liftSeedFileVerified' in run(null), false);
});

// ---------------------------------------------------------------- the record
const summaryOf = ({ queue = 'both', rung = 'MIX', repeat = 0, valid = true, share = 700, publish = 6000, pickup = 250, free = 240, freeN = 30, o = {} } = {}) => {
  const lift = queue !== 'share';
  const withShare = queue !== 'lift';
  const def = Object.values(G1B_CELLS).find((c) => c.rung === rung);
  return {
    meta: {
      runId: `${queue}-${rung}-r${repeat}`,
      label: 'head',
      cell: {
        history: '0',
        liftHistory: '0',
        queue,
        observer: 'default',
        rung,
        lambda: def?.load.lambda ?? 4,
        mu: def?.load.mu ?? 0.4,
        content: def?.load.content ?? 3,
        aggregate: def?.load.aggregate ?? 1,
        repeat,
        seed: G1B_SEED_BASE + repeat,
        observerMs: 5000,
        loadFactors: G1B_SETUP.loadFactors,
        liftModel: lift ? G1B_SETUP.liftModel : null,
        ...o.cell,
      },
      windows: G1B_SETUP.windows,
      env: { DKG_STORE_CONTROL_RESERVED_SLOTS: '2' },
      host: { cpus: 10 },
      git: { sha: '0123456789abcdef', dirty: false },
      scriptSha256: 'abc',
      calibration: null,
      liftSeedFile: o.liftSeedFile,
    },
    submission: withShare ? { n: 720, F: 0, latencyMs: { p95: share } } : { n: 0, F: null, latencyMs: null },
    publish: lift
      ? {
          n: 72,
          F: 0,
          latencyMs: { p95: publish },
          completionsPerMin: 24,
          pickup: { nAccepted: 72, nCensored: 0, p50: pickup },
          workerFree: { nQualifying: freeN, p50: free },
          claimToFinishMs: { p50: 3200 },
          unclaimed: { max: 4 },
          ...o.publish,
        }
      : undefined,
    probes: { latencyMs: { p95: 40 }, noAnswer: 0 },
    ack: { opMs: { p95: 12 } },
    readers: { failFrac: 0.01 },
    worker: withShare ? { completionsPerMin: 20, counters: { succeeded: 70, failedTerminal: 0 }, agent: { agentErrors: 0 } } : null,
    observer: { latencyMs: { p95: 30 } },
    validity: { ok: valid },
  };
};

test('a P2b summary maps to a record with the publisher stream\'s numbers; a P2a summary maps to exactly the P2a record', () => {
  const r = extractRecord(summaryOf());
  assert.equal(r.valid, true);
  assert.deepEqual(
    [r.queue, r.p95Ms, r.publishP95Ms, r.publishFailureFrac, r.publishPerMin, r.pickupP50Ms, r.pickupN, r.pickupCensored],
    ['both', 700, 6000, 0, 24, 250, 72, 0],
  );
  assert.deepEqual(
    [r.pickupFreeP50Ms, r.pickupFreeN, r.claimToFinishP50Ms, r.unclaimedMax, r.probeP95Ms, r.probeNoAnswer, r.ackOpP95Ms, r.readerFailFrac],
    [240, 30, 3200, 4, 40, 0, 12, 0.01],
  );
  assert.equal(r.key, '0|default|MIX|both|0');
  assert.deepEqual([r.config.mu, r.config.liftModel, r.config.loadFactors.probes, r.config.liftSeedFileSha256], [0.4, G1B_SETUP.liftModel, true, null]);
  const legacy = extractRecord({ ...summaryOf({ queue: 'share', rung: 'L3' }), meta: { ...summaryOf().meta, cell: { history: 0, observer: 'default', rung: 'L3', repeat: 1 } }, publish: undefined, probes: undefined, ack: undefined });
  assert.equal('queue' in legacy, false, 'the P2a record has none of the new fields');
  assert.equal('mu' in legacy.config, false);
  const shareCell = extractRecord(summaryOf({ queue: 'share', rung: 'L3' }));
  assert.equal(shareCell.key, '0|default|L3|0');
  assert.deepEqual([shareCell.valid, shareCell.publishP95Ms, shareCell.pickupP50Ms], [true, null, null]);
});

test('a publish-only record needs its own metrics, and a mixed one both streams\'', () => {
  const lift = extractRecord(summaryOf({ queue: 'lift', rung: 'PSTAR' }));
  assert.deepEqual([lift.valid, lift.p95Ms, lift.key], [true, null, '0|default|PSTAR|lift|0']);
  const failed = (o) => extractRecord(summaryOf(o));
  const noPickup = failed({ queue: 'lift', rung: 'PSTAR', pickup: null });
  assert.deepEqual([noPickup.valid, noPickup.failedChecks], [false, ['finitePublishMetrics']]);
  assert.deepEqual(failed({ queue: 'both', pickup: Number.NaN }).failedChecks, ['finitePublishMetrics']);
  assert.deepEqual(failed({ queue: 'both', publish: null }).failedChecks, ['finitePublishMetrics']);
  const noShare = extractRecord({ ...summaryOf(), submission: { n: 0, F: null, latencyMs: null } });
  assert.deepEqual([noShare.valid, noShare.failedChecks], [false, ['finiteMetrics']]);
  const both = extractRecord({ ...summaryOf({ valid: false }), validity: { ok: false, publisherQuiet: false } });
  assert.deepEqual(both.failedChecks, ['ok', 'publisherQuiet']);
  assert.equal(extractRecord(summaryOf({ o: { liftSeedFile: { sha256: 'm', loadedSha256: 'l' } } })).config.liftSeedFileSha256, 'l');
  assert.equal(extractRecord({ ...summaryOf(), meta: { ...summaryOf().meta, calibration: { sha256: 'c', factorsDiffer: true } } }).factorsDifferFromCalibration, true);
});

test('the ledger gains the publisher columns when a run has them, and warns about a probe or ACK load off the calibration', () => {
  const r = extractRecord(summaryOf());
  const [head, , row] = ledgerMarkdown([r]).split('\n');
  assert.match(head, /\| git \| queue \| lift history \| publish P95 ms \| pick-up p50 ms \| worker-free p50 ms \| probe P95 \/ no-answer \| ACK op P95 ms \|$/);
  assert.match(row, /\| both \| 0 \| 6000 \| 250 \| 240 \(n 30\) \| 40 \/ 0 \| 12 \|$/);
  const old = extractRecord({ ...summaryOf(), meta: { ...summaryOf().meta, cell: { history: 0, observer: 'default', rung: 'L3', repeat: 0 } }, publish: undefined, probes: undefined, ack: undefined });
  assert.doesNotMatch(ledgerMarkdown([old]).split('\n')[0], /queue/);
  const mixed = ledgerMarkdown([old, r]).split('\n');
  assert.deepEqual(mixed.map((l) => l.split('|').length), Array(4).fill(mixed[0].split('|').length), 'every row has every column');
  const off = { ...r, runId: 'x', factorsDifferFromCalibration: true };
  assert.ok(integrityWarnings([off], [], null).some((w) => /probe or ACK load other than their calibration's: x/.test(w)));
  assert.ok(!integrityWarnings([r], [], null).some((w) => /probe or ACK/.test(w)));
});

// ---------------------------------------------------------------- the rules on the publisher's metrics
const prec = (o = {}) => ({
  key: 'k',
  valid: true,
  p95Ms: 1000,
  failureFrac: 0,
  completionsPerMin: 20,
  publishP95Ms: 6000,
  publishFailureFrac: 0,
  publishPerMin: 24,
  pickupP50Ms: 1000,
  pickupFreeP50Ms: 800,
  pickupFreeN: 30,
  ...o,
});
const pairsOn = (aVals, bVals, key, extra = {}) =>
  aVals.map((a, i) => ({ key: `r${i}`, a: prec({ [key]: a, ...extra.a }), b: prec({ [key]: bVals[i], ...extra.b }), valid: true }));

test('the metric families name the record field each rule reads', () => {
  assert.deepEqual(Object.keys(FAMILIES), ['share', 'publish', 'pickup', 'pickupFree']);
  assert.deepEqual(Object.values(FAMILIES).map((f) => f.key), ['p95Ms', 'publishP95Ms', 'pickupP50Ms', 'pickupFreeP50Ms']);
  assert.equal(familyOf().key, 'p95Ms');
  assert.throws(() => familyOf('nope'), /unknown metric nope \(share, publish, pickup, pickupFree\)/);
  assert.throws(() => familyOf('toString'), /unknown metric/);
  assert.equal(PUBLISH_RUNGS.length, 3);
  assert.deepEqual(PUBLISH_RUNGS.find((r) => r.id === 'PSTAR'), { id: 'PSTAR', lambda: 0, mu: 0.8, content: 4, aggregate: 2 });
  assert.deepEqual(PUBLISH_RUNGS.find((r) => r.id === 'MIX'), { id: 'MIX', lambda: 4, mu: 0.4, content: 3, aggregate: 1 });
  assert.ok(RUNGS.every((r) => r.mu === undefined), 'the share ladder is untouched');
});

test('halve on the pick-up, the publish P95 and the worker-free pick-up: 3/3 pairs at half, else fail', () => {
  const pass = pairsOn([1000, 2000, 3000], [500, 900, 1500], 'pickupP50Ms');
  const r = halve(pass, { family: 'pickup' });
  assert.deepEqual([r.status, r.label, r.metric, r.perRepeat.map((x) => x.ratio)], ['pass', 'halve: candidate pick-up p50 <= 0.5 x base', 'pickupP50Ms', [0.5, 0.45, 0.5]]);
  assert.equal(halve(pairsOn([1000, 2000, 3000], [500, 900, 1501], 'pickupP50Ms'), { family: 'pickup' }).status, 'fail');
  assert.equal(halve(pairsOn([8000, 8000, 8000], [4000, 3999, 1], 'publishP95Ms'), { family: 'publish' }).status, 'pass');
  assert.equal(halve(pairsOn([1000, 1000, 1000], [500, 500, 500], 'pickupFreeP50Ms'), { family: 'pickupFree', minSamples: 20 }).status, 'pass');
  assert.equal(halve(pass).label, 'halve: candidate P95 <= 0.5 x base', 'the share rule keeps its label');
  assert.equal('belowKnee' in r, false, 'the knee is a share notion');
});

test('a pair without the family\'s number is not a pair: the rule is INCOMPLETE, never a PASS and never a FAIL', () => {
  const pairs = pairsOn([1000, 2000, 3000], [500, 900, 1500], 'pickupP50Ms');
  pairs[1].b.pickupP50Ms = null;
  const r = halve(pairs, { family: 'pickup' });
  assert.deepEqual([r.status, r.have, r.perRepeat.length], ['incomplete', 2, 2]);
  const marked = withMetric(pairs, 'pickup');
  assert.equal(marked[1].valid, false);
  assert.match(marked[1].reasons[0], /pick-up p50 unusable \(b: no pick-up p50\)/);
  assert.equal(marked[0].valid, true);
  const was = [{ key: 'x', valid: false, a: prec(), b: prec({ pickupP50Ms: null }) }];
  assert.deepEqual(withMetric(was, 'pickup'), was, 'an invalid pair stays as it was');
  const lift = pairsOn([1000, 2000, 3000], [500, 900, 1500], 'p95Ms', { a: { p95Ms: null }, b: { p95Ms: null } });
  assert.equal(halve(lift).status, 'incomplete', 'a publish-only run has no share P95');
});

test('the worker-free pick-up needs the declared number of qualifying jobs in both runs of a pair', () => {
  const pairs = pairsOn([1000, 1000, 1000], [400, 400, 400], 'pickupFreeP50Ms');
  assert.equal(halve(pairs, { family: 'pickupFree', minSamples: 30 }).status, 'pass');
  pairs[2].a.pickupFreeN = 29;
  const thin = halve(pairs, { family: 'pickupFree', minSamples: 30 });
  assert.deepEqual([thin.status, thin.have], ['incomplete', 2]);
  assert.match(withMetric(pairs, 'pickupFree', { minSamples: 30 })[2].reasons[0], /worker-free pick-up p50 unusable \(a: 29 qualifying jobs, 30 needed\)/);
  pairs[2].a.pickupFreeN = undefined;
  assert.match(withMetric(pairs, 'pickupFree', { minSamples: 30 })[2].reasons[0], /a: 0 qualifying jobs/);
  assert.equal(halve(pairsOn([1000, 1000, 1000], [400, 400, 400], 'pickupFreeP50Ms'), { family: 'pickupFree', minSamples: 31 }).status, 'incomplete', 'the fixture\'s runs hold 30 qualifying jobs');
});

test('equal is two-sided and noworse one-sided on the publish P95, both with the declared margin', () => {
  const pairs = (b) => pairsOn([6000, 6000, 6000], b, 'publishP95Ms');
  assert.equal(equivalent(pairs([6300, 5800, 6000]), 0.1, { family: 'publish' }).status, 'pass');
  const slow = equivalent(pairs([6700, 6000, 6000]), 0.1, { family: 'publish' });
  assert.deepEqual([slow.status, slow.label], ['fail', 'equal: candidate publish P95 within +-0.1 of base']);
  assert.equal(equivalent(pairs([3000, 6000, 6000]), 0.1, { family: 'publish' }).status, 'fail', 'much faster is not equal');
  const guard = noWorse(pairs([3000, 6000, 6599]), 0.1, { family: 'publish' });
  assert.deepEqual([guard.status, guard.label], ['pass', 'noworse: candidate publish P95 <= (1 + 0.1) x base']);
  assert.equal(noWorse(pairs([3000, 6000, 6601]), 0.1, { family: 'publish' }).status, 'fail');
  assert.equal(noWorse(pairsOn([1000, 1000, 1000], [1100, 1000, 900], 'p95Ms'), 0.1).label, 'noworse: candidate P95 <= (1 + 0.1) x base');
  assert.throws(() => noWorse(pairs([1, 1, 1])), /declared margin/);
  assert.throws(() => noWorse(pairs([1, 1, 1]), -1), /declared margin/);
  assert.equal(noWorse(pairsOn([6000, 6000], [1, 1], 'publishP95Ms'), 0.1, { family: 'publish' }).status, 'incomplete', 'two repeats are not three');
});

const onLift = (pairs, a = '0', b = '10k') =>
  pairs.map((p) => ({ ...p, a: { ...p.a, cell: { liftHistory: a } }, b: { ...p.b, cell: { liftHistory: b } } }));

test('publisher flatness: lift history b against 0, publish P95 within 1.25 x in 3/3 pairs', () => {
  const ok = onLift(pairsOn([6000, 6000, 6000], [7500, 6000, 6100], 'publishP95Ms'));
  const r = flat(ok, { family: 'publish' });
  assert.deepEqual([r.status, r.label, r.metric], ['pass', 'flat: lift history 10k publish P95 <= 1.25 x lift history 0', 'publishP95Ms']);
  assert.equal(flat(onLift(pairsOn([6000, 6000, 6000], [7501, 6000, 6100], 'publishP95Ms')), { family: 'publish' }).status, 'fail');
  assert.equal(flat(onLift(pairsOn([6000, 6000, 6000], [7500, 6000, 6100], 'publishP95Ms'), '0', '50k'), { family: 'publish' }).label, 'flat: lift history 50k publish P95 <= 1.25 x lift history 0');
  // the arms: a is 0 only, b ONE non-zero history, whatever the pairs say
  const swapped = flat(onLift(pairsOn([6000, 6000, 6000], [1, 1, 1], 'publishP95Ms'), '10k', '0'), { family: 'publish' });
  assert.equal(swapped.status, 'incomplete');
  assert.match(swapped.reason, /--a must hold lift history 0 runs only \(found lift history 10k\).*--b must hold runs of ONE non-zero lift history \(found 0\)/);
  assert.equal(flat(onLift(pairsOn([1, 1, 1], [1, 1, 1], 'publishP95Ms'), '0', '0'), { family: 'publish' }).status, 'incomplete', 'two empty histories');
  const mixedB = { aRecords: ok.map((p) => p.a), bRecords: [{ cell: { liftHistory: '10k' } }, { cell: { liftHistory: '50k' } }], family: 'publish' };
  assert.match(flat(ok, mixedB).reason, /ONE non-zero lift history \(found 10k, 50k\)/);
  assert.deepEqual(flatArmProblems([{ cell: { liftHistory: '0' } }], [{ cell: { liftHistory: '50k' } }], 'publish'), []);
  assert.deepEqual(flatArmProblems([{ cell: { history: '0' } }], [{ cell: { history: '50k' } }]), [], 'the share variant is unchanged');
  assert.deepEqual(flatArmProblems([{ cell: {} }], [{ cell: { liftHistory: '1k' } }], 'publish'), [], 'no lift history recorded is history 0');
  assert.throws(() => flat(ok, { family: 'pickup' }), /judges a P95, not pickup/);
  assert.equal(flat(onLift(pairsOn([6000, 6000], [1, 1], 'publishP95Ms')), { family: 'publish' }).status, 'incomplete');
});

test('the A/A margin and the reported guards follow the family', () => {
  const aa = pairsOn([6000, 5000, 4000], [6300, 5000, 4400], 'publishP95Ms');
  assert.equal(noiseMargin(aa, 'publish'), 0.1);
  const wide = pairsOn([6000, 5000, 4000], [7200, 5000, 4000], 'publishP95Ms');
  assert.equal(noiseMargin(wide, 'publish'), 0.2);
  assert.equal(noiseMargin(wide), 0.1, 'the share P95 of those records is flat');
  const missing = pairsOn([6000, 5000, 4000], [7200, 5000, 4000], 'pickupFreeP50Ms');
  missing[0].b.pickupFreeN = 3;
  assert.equal(noiseMargin(missing, 'pickupFree', { minSamples: 10 }), 0.1, 'a thin pair is left out of the margin');
  const g = guards(pairsOn([1, 1], [1, 1], 'publishP95Ms', { a: { publishPerMin: 24 }, b: { publishFailureFrac: 0.03, publishPerMin: 20 } }), 'publish');
  assert.deepEqual(g.failureFrac.map((x) => [x.value, x.ok]), [[0.03, false], [0.03, false]]);
  assert.deepEqual(g.completions.map((x) => [x.ratio, x.ok]), [[0.8333, false], [0.8333, false]]);
  assert.deepEqual(guards(pairsOn([1], [1], 'p95Ms')).failureFrac, [{ key: 'r0', value: 0, ok: true }]);
});

// ---------------------------------------------------------------- the command line
/** Writes the summaries of one cell's repeats under dir/<sub>/r<i>/summary.json. */
function writeCell(dir, id, over = () => ({})) {
  const def = G1B_CELLS[id];
  for (let repeat = 0; repeat < 5; repeat++) {
    const file = path.join(dir, id, `r${repeat}`, 'summary.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const o = over(repeat);
    writeFileSync(file, JSON.stringify(summaryOf({ queue: def.queue, rung: def.rung, repeat, share: G0B_REFERENCE[id].shareP95, pickup: G0B_REFERENCE[id].pickup, ...o })));
  }
}

test('verdict --rule g1b reads the three cells of one directory: exit 0 on a pass, 1 on a miss, 2 when a repeat is missing', () => {
  const dir = path.join(tmp, 'g1b-pass');
  for (const id of Object.keys(G1B_CELLS)) writeCell(dir, id);
  const pass = cli('verdict', '--rule', 'g1b', '--a', dir);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /^g1b: median of the five seeded repeats within the G0b band \(D-15\): PASS \(5 usable repeats in the thinnest cell, 5 needed\)/);
  assert.match(pass.stdout, /g9mix \(--queue both, rung MIX\): 5 of 5 repeats usable\n\s+share P95: median 701 ms vs G0b 701 ms \(\+0.0 %\), band 525.75\.\.876.25 ms {2}ok\n\s+pick-up p50: median 267 ms vs G0b 267 ms \(\+0.0 %\), band -233\.\.767 ms {2}ok/);
  assert.doesNotMatch(pass.stdout, /warning: no run recorded/, 'the runs recorded the path setting');
  const json = JSON.parse(cli('verdict', '--rule', 'g1b', '--a', dir, '--json').stdout);
  assert.deepEqual([json.result.status, json.result.have, json.warnings], ['pass', 5, []]);
  assert.deepEqual(Object.keys(json.result.cells), ['g9L3', 'g9mix', 'g9pub']);

  const miss = path.join(tmp, 'g1b-miss');
  for (const id of Object.keys(G1B_CELLS)) writeCell(miss, id, id === 'g9pub' ? () => ({ pickup: 4000 }) : undefined);
  const failed = cli('verdict', '--rule', 'g1b', '--a', miss);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL/);
  assert.match(failed.stdout, /pick-up p50: median 4000 ms vs G0b 1687 ms \(\+137.1 %\), band 1187\.\.2187 ms {2}MISS/);

  const thin = path.join(tmp, 'g1b-thin');
  for (const id of ['g9L3', 'g9mix']) writeCell(thin, id);
  const incomplete = cli('verdict', '--rule', 'g1b', '--a', thin);
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stdout, /INCOMPLETE \(0 usable repeats in the thinnest cell, 5 needed\) - needs 5 valid G0b-conforming repeats in every cell \(g9pub 0\)/);
  assert.match(incomplete.stdout, /problem: repeat 0: no run/);
});

test('verdict --rule g1b warns when no run recorded the control-path setting and refuses a second arm', () => {
  const dir = path.join(tmp, 'g1b-env');
  for (const id of Object.keys(G1B_CELLS)) {
    writeCell(dir, id);
    for (let repeat = 0; repeat < 5; repeat++) {
      const file = path.join(dir, id, `r${repeat}`, 'summary.json');
      const s = JSON.parse(readFileSync(file, 'utf8'));
      s.meta.env = {};
      writeFileSync(file, JSON.stringify(s));
    }
  }
  const run = cli('verdict', '--rule', 'g1b', '--a', dir);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /warning: no run recorded DKG_STORE_CONTROL_RESERVED_SLOTS/);
  const two = cli('verdict', '--rule', 'g1b', '--a', dir, '--b', dir);
  assert.equal(two.status, 2);
  assert.match(two.stderr, /judges one arm \(--a DIR\).*drop --b/);
});

/** Two arms of a publisher cell, 3 repeats each, written under tmp/<name>/{a,b}. */
function twoArms(name, { a, b, queue = 'lift', rung = 'PSTAR', cell = {} }) {
  const dir = path.join(tmp, name);
  for (const [arm, o] of [['a', a], ['b', b]]) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const file = path.join(dir, arm, `r${repeat}`, 'summary.json');
      mkdirSync(path.dirname(file), { recursive: true });
      const spec = { queue, rung, repeat, ...(typeof o === 'function' ? o(repeat) : o) };
      writeFileSync(file, JSON.stringify(summaryOf({ ...spec, o: { cell: cell[arm] } })));
    }
  }
  return dir;
}

test('verdict halve --metric pickup judges the pick-up of two arms; the worker-free metric needs its sample size declared', () => {
  const dir = twoArms('halve-pickup', { a: { pickup: 2000 }, b: { pickup: 900 } });
  const run = cli('verdict', '--rule', 'halve', '--metric', 'pickup', '--a', path.join(dir, 'a'), '--b', path.join(dir, 'b'));
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /^halve: candidate pick-up p50 <= 0.5 x base: PASS \(3 valid pairs, 3 needed\)/);
  assert.match(run.stdout, /0\|default\|PSTAR\|lift\|0 {2}2000 -> 900 {2}ratio 0.45 {2}ok/);
  const usage = (extra, pattern) => {
    const r = cli('verdict', '--rule', 'halve', '--a', path.join(dir, 'a'), '--b', path.join(dir, 'b'), ...extra);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, pattern);
  };
  usage(['--metric', 'pickupFree'], /--metric pickupFree needs --min-qualifying N/);
  usage(['--metric', 'pickup', '--min-qualifying', '20'], /--min-qualifying belongs to --metric pickupFree/);
  usage(['--metric', 'bogus'], /--metric must be share, publish, pickup, pickupFree/);
  usage(['--metric', 'pickupFree', '--min-qualifying', '0'], /--min-qualifying must be an integer >= 1/);
  const free = cli('verdict', '--rule', 'halve', '--metric', 'pickupFree', '--min-qualifying', '31', '--a', path.join(dir, 'a'), '--b', path.join(dir, 'b'));
  assert.equal(free.status, 2, 'the cell holds 30 qualifying jobs a run');
  assert.match(free.stdout, /INCOMPLETE .* - needs 3 valid paired repeats in every cell, the thinnest has 0/);
  assert.match(free.stdout, /worker-free pick-up p50 unusable \(a: 30 qualifying jobs, 31 needed; b: 30 qualifying jobs, 31 needed\)/);
  const enough = cli('verdict', '--rule', 'halve', '--metric', 'pickupFree', '--min-qualifying', '30', '--a', path.join(dir, 'a'), '--b', path.join(dir, 'b'));
  assert.equal(enough.status, 1, 'the worker-free pick-up of both arms is 240 ms: not halved');
  assert.match(enough.stdout, /FAIL/);
});

test('verdict aa, equal, noworse and flat take the metric; the margin and the arms are required as before', () => {
  const dir = twoArms('rules', { a: { publish: 6000 }, b: (r) => ({ publish: 6000 + 100 * r }) });
  const A = path.join(dir, 'a');
  const B = path.join(dir, 'b');
  const aa = cli('verdict', '--rule', 'aa', '--metric', 'publish', '--a', A, '--b', B);
  assert.equal(aa.status, 0);
  const printed = JSON.parse(aa.stdout);
  assert.deepEqual([printed.margin, printed.validPairs], [0.1, 3]);
  assert.equal(cli('verdict', '--rule', 'noworse', '--metric', 'publish', '--margin', '0.1', '--a', A, '--b', B).status, 0);
  assert.equal(cli('verdict', '--rule', 'noworse', '--metric', 'publish', '--margin', '0.01', '--a', A, '--b', B).status, 1);
  assert.equal(cli('verdict', '--rule', 'equal', '--metric', 'publish', '--margin', '0.1', '--a', A, '--b', B).status, 0);
  const noMargin = cli('verdict', '--rule', 'noworse', '--a', A, '--b', B);
  assert.equal(noMargin.status, 2);
  assert.match(noMargin.stderr, /--rule noworse needs --margin/);
  assert.match(cli('verdict', '--rule', 'sideways', '--a', A, '--b', B).stderr, /halve\|flat\|equal\|noworse\|aa\|g1b\|ledger/);
  const badFlat = cli('verdict', '--rule', 'flat', '--metric', 'pickup', '--a', A, '--b', B);
  assert.equal(badFlat.status, 2);
  assert.match(badFlat.stderr, /--rule flat judges a P95: --metric share or publish/);
});

test('verdict flat --metric publish pairs a lift history 0 arm with a 10k arm and judges the publish P95', () => {
  const dir = twoArms('lift-flat', {
    a: { publish: 6000 },
    b: { publish: 6500 },
    cell: { a: { liftHistory: '0' }, b: { liftHistory: '10k' } },
  });
  const run = cli('verdict', '--rule', 'flat', '--metric', 'publish', '--a', path.join(dir, 'a'), '--b', path.join(dir, 'b'));
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /^flat: lift history 10k publish P95 <= 1.25 x lift history 0: PASS \(3 valid pairs, 3 needed\)/);
  const swapped = cli('verdict', '--rule', 'flat', '--metric', 'publish', '--a', path.join(dir, 'b'), '--b', path.join(dir, 'a'));
  assert.equal(swapped.status, 2);
  assert.match(swapped.stdout, /INCOMPLETE .*--a must hold lift history 0 runs only/);
  // the cells carry their lift history in the ledger and filter with --where
  const filtered = cli('verdict', '--rule', 'ledger', '--a', path.join(dir, 'b'), '--where', 'liftHistory=10k,queue=lift');
  assert.equal(filtered.stdout.trim().split('\n').length, 5);
  assert.equal(cli('verdict', '--rule', 'ledger', '--a', path.join(dir, 'b'), '--where', 'queue=both').stdout.trim().split('\n').length, 2);
});

// ---------------------------------------------------------------- the run flags of the new cells
const dry = (...args) => {
  const r = cli('run', '--dry', ...args);
  return { ...r, config: r.status === 0 ? JSON.parse(r.stdout.trim().split('\n').pop()).config : null };
};

test('run --dry resolves the publisher and mixed cells: the queue, the rung\'s rates, the chain-time model and the load', () => {
  const mix = dry('--queue', 'both', '--rung', 'MIX', '--probes', '--ack-load', '--seed-base', '20262901', '--repeat', '2');
  assert.equal(mix.status, 0, mix.stderr);
  const c = mix.config;
  assert.deepEqual([c.queue, c.rung, c.lambda, c.mu, c.content, c.aggregate], ['both', 'MIX', 4, 0.4, 3, 1]);
  assert.deepEqual([c.seed, c.repeat], [20262903, 2], 'the G0b seed of repeat 2');
  assert.deepEqual(c.liftModel, G1B_SETUP.liftModel);
  assert.deepEqual(c.loadFactors, G1B_SETUP.loadFactors);
  assert.deepEqual([c.wallets, c.walletHoldMs, c.liftPollMs], [6, 3000, 1000]);
  const pub = dry('--queue', 'lift', '--rung', 'PSTAR', '--wallets', '3', '--wallet-hold-ms', '500', '--lift-poll-ms', '100', '--seed', '9');
  assert.deepEqual([pub.config.mu, pub.config.lambda, pub.config.liftModel, pub.config.seed], [0.8, 0, { wallets: 3, walletHoldMs: 500, liftPollMs: 100 }, 9]);
  assert.deepEqual(pub.config.loadFactors, { probes: false, ack: false, statusMs: null, metricsMs: null, countMs: null, ackMs: null, ackPayload: null });
  const share = dry('--rung', 'L3');
  assert.deepEqual([share.config.queue, share.config.mu, share.config.liftModel, share.config.seed], ['share', 0, null, 7300], 'a P2a share cell');
  assert.equal(dry('--queue', 'share', '--rung', 'L3', '--seed-base', '100', '--repeat', '4').config.seed, 104);
  const custom = dry('--queue', 'lift', '--mu', '1.5', '--content', '2', '--aggregate', '1');
  assert.deepEqual([custom.config.rung, custom.config.mu], ['custom-l0-m1.5-c2-a1', 1.5]);
  const customBoth = dry('--queue', 'both', '--lambda', '3', '--mu', '0.2', '--content', '0', '--aggregate', '0', '--probes', '--probe-status-ms', '2000', '--ack-load', '--ack-interval-ms', '500', '--ack-payload', '8');
  assert.equal(customBoth.config.rung, 'custom-l3-m0.2-c0-a0');
  assert.deepEqual(customBoth.config.loadFactors, { probes: true, ack: true, statusMs: 2000, metricsMs: 30_000, countMs: 60_000, ackMs: 500, ackPayload: 8 });
  const shareCustom = dry('--lambda', '2', '--content', '1', '--aggregate', '1');
  assert.equal(shareCustom.config.rung, 'custom-l2-c1-a1', 'the P2a name of a custom share load');
  assert.equal(dry('--queue', 'lift', '--rung', 'PSTAR', '--lift-history', '10k').config.liftHistory, '10k');
});

test('run refuses a rung that does not fit the stream, flags that belong to another stream, and a bad seed file, with exit 2', () => {
  const fails = (args, pattern) => {
    const r = dry(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, pattern, args.join(' '));
  };
  fails(['--rung', 'MIX'], /the load has publish arrivals \(mu 0.4\): use --queue lift or --queue both/);
  fails(['--queue', 'lift', '--rung', 'MIX'], /the load has share arrivals \(lambda 4\): use --queue both/);
  fails(['--queue', 'both', '--rung', 'L3'], /--queue both needs a positive publish rate mu \(--mu, or a rung with publish arrivals: PLOW, PSTAR, MIX\)/);
  fails(['--queue', 'lift', '--rung', 'L3'], /the load has share arrivals \(lambda 8\)|needs a positive publish rate/);
  fails(['--queue', 'sideways', '--rung', 'L3'], /--queue must be share, lift, both/);
  fails(['--queue', 'lift', '--lambda', '1', '--content', '1', '--aggregate', '1'], /all of --content --aggregate --mu/);
  fails(['--queue', 'both', '--mu', '1', '--content', '1', '--aggregate', '1'], /all of --lambda --content --aggregate --mu/);
  fails(['--lambda', '1', '--content', '1'], /all of --lambda --content --aggregate/);
  fails(['--rung', 'L3', '--wallets', '3'], /--wallets apply to --queue lift or both/);
  fails(['--rung', 'L3', '--wallet-hold-ms', '5', '--lift-poll-ms', '9'], /--wallet-hold-ms, --lift-poll-ms apply to --queue lift or both/);
  fails(['--queue', 'lift', '--rung', 'PSTAR', '--wallets', '0'], /--wallets must be an integer >= 1/);
  fails(['--rung', 'L3', '--probe-status-ms', '5'], /--probe-status-ms needs --probes/);
  fails(['--rung', 'L3', '--ack-payload', '5'], /--ack-payload needs --ack-load/);
  fails(['--rung', 'L3', '--probes', '--ack-load', '--ack-interval-ms', '0'], /--ack-interval-ms must be an integer >= 1/);
  fails(['--queue', 'lift', '--rung', 'PSTAR', '--history', '10k'], /--history seeds the share queue: a --queue lift run has none/);
  fails(['--queue', 'lift', '--rung', 'PSTAR', '--seed-file', '/nope'], /--seed-file seeds the share queue/);
  fails(['--queue', 'lift', '--rung', 'PSTAR', '--lift-history', 'lots'], /--lift-history: not a count: lots/);
  fails(['--queue', 'lift', '--rung', 'PSTAR', '--observer', 'paged'], /paged listing is not available in this build \(needs P8a\/P9b\)/);
  fails(['--rung', 'L3', '--seed-base', 'x'], /--seed-base must be an integer >= 0/);
});

test('run checks a lift seed file against --lift-history and its kind before the product is loaded', () => {
  const file = path.join(tmp, 'lift.nq.gz');
  const manifest = (m) => writeFileSync(`${file}.json`, JSON.stringify(m));
  writeFileSync(file, '');
  const fails = (pattern) => {
    const r = dry('--queue', 'lift', '--rung', 'PSTAR', '--lift-history', '10k', '--lift-seed-file', file);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, pattern);
  };
  const gone = dry('--queue', 'lift', '--rung', 'PSTAR', '--lift-history', '10k', '--lift-seed-file', path.join(tmp, 'nope.nq.gz'));
  assert.equal(gone.status, 2);
  assert.match(gone.stderr, /lift seed file .* does not exist/);
  fails(/cannot read the lift seed file manifest/);
  manifest({ kind: 'share', jobs: 10_000, sha256: 'x' });
  fails(/the lift seed file .* holds share jobs, not lift/);
  manifest({ kind: 'lift', jobs: 5000, sha256: 'x' });
  fails(/--lift-history 10000 does not match the lift seed file \(5000 jobs\)/);
  manifest({ kind: 'lift', jobs: 10_000, sha256: 'abc', baseTime: 7 });
  const ok = dry('--queue', 'lift', '--rung', 'PSTAR', '--lift-history', '10k', '--lift-seed-file', file);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([ok.config.liftSeedFile.sha256, ok.config.liftSeedFile.jobs, ok.config.liftHistory], ['abc', 10_000, '10k']);
  // a share seed file given as the share history of a mixed cell must be a share file
  const shareFile = path.join(tmp, 'share.nq.gz');
  writeFileSync(shareFile, '');
  writeFileSync(`${shareFile}.json`, JSON.stringify({ kind: 'lift', jobs: 10_000, sha256: 'x' }));
  const wrong = dry('--queue', 'both', '--rung', 'MIX', '--history', '10k', '--seed-file', shareFile);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /the seed file .* holds lift jobs, not share/);
});

test('a run flags a probe or ACK load other than the one its calibration was measured under', () => {
  const none = { probes: false, ack: false, statusMs: null, metricsMs: null, countMs: null, ackMs: null, ackPayload: null };
  const calibration = (factors) => {
    const file = path.join(tmp, `calibration-${factors ? JSON.stringify(factors).length : 'legacy'}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        status: 'found',
        reproductionRung: 'L3',
        subKneeRung: 'L2',
        rungs: [
          { id: 'L2', lambda: 4, content: 3, aggregate: 1 },
          { id: 'L3', lambda: 8, content: 4, aggregate: 2 },
        ],
        windows: { warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 },
        ...(factors ? { factors } : {}),
      }),
    );
    return file;
  };
  const differs = (file, ...flags) => dry('--calibration', file, ...flags).config.calibration.factorsDiffer;
  assert.equal(differs(calibration(G1B_SETUP.loadFactors), '--probes', '--ack-load'), false, 'the same load');
  assert.equal(differs(calibration(G1B_SETUP.loadFactors)), true, 'calibrated with the load, run without');
  assert.equal(differs(calibration(G1B_SETUP.loadFactors), '--probes', '--ack-load', '--ack-payload', '8'), true, 'another cadence');
  assert.equal(differs(calibration(none)), false);
  assert.equal(differs(calibration(none), '--probes'), true);
  const legacy = calibration(null);
  assert.equal(differs(legacy), false, 'a calibration from before P2b was measured without the load');
  assert.equal(differs(legacy, '--ack-load'), true);
});

test('calibrate sets the share rung itself: it refuses the stream and the publisher flags', () => {
  for (const flag of [['--queue', 'lift'], ['--mu', '1'], ['--lift-history', '10k'], ['--lift-seed-file', '/x']]) {
    const r = cli('calibrate', '--blazegraph-url', 'http://127.0.0.1:1/bigdata/namespace/kb/sparql', ...flag);
    assert.equal(r.status, 2, flag.join(' '));
    assert.match(r.stderr, new RegExp(`calibrate sets the rung.*remove ${flag[0]}`));
  }
});
