// Hermetic tests for lib/scoring.mjs — no network, no fleet, no child processes.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTCOMES, GATE_KINDS,
  classifyFailure, aggregate, evaluateGate, computeVerdict, formatVerdict,
} from '../lib/scoring.mjs';
import { FAILURE_CLASSES } from '../lib/evidence.mjs';

// util.percentile is a concurrent module; inject a local nearest-rank
// implementation matching its frozen contract (p in (0,100], empty -> null).
const nearestRank = (values, p) => {
  const s = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (s.length === 0) return null;
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
};

// ── classifyFailure ──────────────────────────────────────────────────────────

test('classifyFailure ports the rfc59 patterns to the closed enum', () => {
  assert.equal(classifyFailure({ stdout: 'Error: TooLowAllowance(0x123)' }), 'too_low_allowance');
  assert.equal(classifyFailure({ stderr: 'wallet is locked by another publish' }), 'publisher_wedge');
  assert.equal(classifyFailure({ stdout: 'failed to negotiate security protocol' }), 'transport_error');
  assert.equal(classifyFailure({ stdout: 'stream has been reset' }), 'transport_error');
  assert.equal(classifyFailure({ stderr: 'read ECONNRESET' }), 'transport_error');
  assert.equal(classifyFailure({ stdout: 'ACK quorum not met after 3 rounds' }), 'quorum_or_backoff');
  assert.equal(classifyFailure({ stdout: 'peer TEMPORARILY_UNAVAILABLE, backoff scheduled' }), 'quorum_or_backoff');
  assert.equal(classifyFailure({ stderr: 'client timed out after 30000ms' }), 'timeout');
  assert.equal(classifyFailure({ jobError: 'job deadline exceeded' }), 'timeout');
});

test('classifyFailure extends the enum: shed, rpc exhaustion, readback, aborted', () => {
  assert.equal(classifyFailure({ httpStatus: 503 }), 'admission_shed');
  assert.equal(classifyFailure({ stdout: 'request shed by admission control' }), 'admission_shed');
  assert.equal(classifyFailure({ stderr: 'HTTP 503 Service Unavailable' }), 'admission_shed');
  assert.equal(classifyFailure({ stderr: 'RPC providers exhausted after failover' }), 'rpc_exhaustion');
  assert.equal(classifyFailure({ stdout: 'readback mismatch on subject 12' }), 'readback_mismatch');
  assert.equal(classifyFailure({ stderr: 'AbortError: The operation was aborted' }), 'aborted');
});

test('classifyFailure passes exact enum tokens and error:<class> through', () => {
  for (const cls of FAILURE_CLASSES) {
    assert.equal(classifyFailure({ jobError: cls }), cls);
  }
  assert.equal(classifyFailure({ jobError: ' propagation_timeout ' }), 'propagation_timeout');
  assert.equal(classifyFailure({ jobError: 'error:HttpError' }), 'error:httperror');
});

test('classifyFailure never matches shed inside established/published words', () => {
  // "established"/"published" contain the substring "shed" — must NOT classify.
  assert.throws(() => classifyFailure({ stdout: 'connection established with peer' }), /unclassifiable/);
  assert.throws(() => classifyFailure({ stdout: 'entity was garbled-published mystery state' }), /unclassifiable/);
});

test('classifyFailure throws loudly on unknown input, with the offending excerpt', () => {
  assert.throws(
    () => classifyFailure({ stdout: 'some novel garbage nobody classified' }),
    (err) => err.message.includes('novel garbage') && /unclassifiable/.test(err.message),
  );
  assert.throws(() => classifyFailure({}), /unclassifiable/);
  assert.throws(() => classifyFailure({ httpStatus: 500 }), /httpStatus=500/);
});

// ── aggregate ────────────────────────────────────────────────────────────────

const opRow = (outcome, publishMs, over = {}) => ({
  op: 'publish', lane: 'public', outcome,
  durations_ms: publishMs === undefined ? undefined : { publish: publishMs },
  ...over,
});

test('aggregate: successes-only percentiles, aborted excluded from denominator', () => {
  const rows = [
    opRow('success', 100), opRow('success', 200), opRow('success', 300),
    opRow('success', 400), opRow('success', 500), opRow('success', 600),
    opRow('timeout', undefined), opRow('quorum_or_backoff', undefined),
    opRow('aborted', undefined), opRow('aborted', undefined),
  ];
  const agg = aggregate(rows, { op: 'publish', lane: 'public', durationField: 'publish', _percentile: nearestRank });
  assert.equal(agg.attempts, 10);
  assert.equal(agg.successes, 6);
  assert.equal(agg.failed, 2);
  assert.equal(agg.aborted, 2);
  // §6: aborted (harness quiesce) excluded from the success-rate denominator
  assert.equal(agg.successRate, 6 / 8);
  assert.equal(agg.durationsMs.count, 6);
  assert.equal(agg.durationsMs.p50, 300);
  assert.equal(agg.durationsMs.p95, 600);
  assert.equal(agg.durationsMs.p99, 600);
  assert.equal(agg.durationsMs.max, 600);
  assert.deepEqual(agg.failuresByClass, { timeout: 1, quorum_or_backoff: 1 });
  assert.equal(agg.partial, false);
});

test('aggregate: failed-op latencies never enter percentiles', () => {
  const rows = [
    opRow('success', 50_000),
    opRow('timeout', 5, { durations_ms: { publish: 5 } }), // fast failure must not improve p95
  ];
  const agg = aggregate(rows, { op: 'publish', lane: 'public', durationField: 'publish', _percentile: nearestRank });
  assert.equal(agg.durationsMs.p95, 50_000);
  assert.equal(agg.durationsMs.count, 1);
});

test('aggregate: partial runs carry attempted/completed/inFlight', () => {
  const rows = [opRow('success', 10), opRow('aborted'), opRow('aborted'), opRow('transport_error')];
  const agg = aggregate(rows, { op: 'publish', lane: 'public', durationField: 'publish', partial: true, _percentile: nearestRank });
  assert.equal(agg.partial, true);
  assert.equal(agg.attempted, 4);
  assert.equal(agg.completed, 2);
  assert.equal(agg.inFlight, 2);
  assert.equal(agg.successRate, 1 / 2);
});

test('aggregate: filters to the requested (op, lane); pre-filtered rows pass', () => {
  const rows = [
    opRow('success', 10),
    opRow('success', 99, { lane: 'private' }),
    opRow('success', 98, { op: 'query' }),
    { outcome: 'success', durations_ms: { publish: 20 } }, // no op/lane => caller pre-filtered
  ];
  const agg = aggregate(rows, { op: 'publish', lane: 'public', durationField: 'publish', _percentile: nearestRank });
  assert.equal(agg.attempts, 2);
  assert.equal(agg.durationsMs.max, 20);
});

test('aggregate: zero rows and error:<class> outcomes', () => {
  const empty = aggregate([], { op: 'publish', lane: 'public', durationField: 'publish', _percentile: nearestRank });
  assert.equal(empty.attempts, 0);
  assert.equal(empty.successRate, null);
  assert.equal(empty.durationsMs.p95, null);

  const agg = aggregate([opRow('error:HttpError')], { op: 'publish', lane: 'public', durationField: 'publish', _percentile: nearestRank });
  assert.deepEqual(agg.failuresByClass, { 'error:HttpError': 1 });
});

test('aggregate: outcome outside the closed enum throws — never fold silently', () => {
  assert.throws(
    () => aggregate([opRow('mystery_class')], { op: 'publish', lane: 'public', durationField: 'publish', _percentile: nearestRank }),
    /closed failure enum/,
  );
});

// ── evaluateGate ─────────────────────────────────────────────────────────────

test('evaluateGate: percentile gate without coverage fields throws (spec bug)', () => {
  assert.throws(
    () => evaluateGate({ id: 'p95', kind: 'percentile', threshold: 60_000, observed: 1000 }),
    /minSamples/,
  );
  assert.throws(
    () => evaluateGate({ id: 'p95', kind: 'percentile', threshold: 60_000, observed: 1000, minSamples: 100 }),
    /minSuccessRate/,
  );
  assert.throws(
    () => evaluateGate({ id: 'sr', kind: 'successRate', threshold: 0.95, observed: 1 }),
    /minSamples/,
  );
});

test('evaluateGate: coverage shortfall is INCONCLUSIVE, not PASS/FAIL', () => {
  const lowSamples = evaluateGate({
    id: 'p95', kind: 'percentile', threshold: 60_000, observed: 1000,
    samples: 40, minSamples: 100, successRate: 1, minSuccessRate: 0.95,
  });
  assert.equal(lowSamples.outcome, 'INCONCLUSIVE');
  assert.match(lowSamples.evidence.reason, /insufficient samples: 40 < minSamples 100/);

  const lowSuccess = evaluateGate({
    id: 'p95', kind: 'percentile', threshold: 60_000, observed: 1000,
    samples: 100, minSamples: 100, successRate: 0.5, minSuccessRate: 0.95,
  });
  assert.equal(lowSuccess.outcome, 'INCONCLUSIVE');
  assert.match(lowSuccess.evidence.reason, /below coverage/);

  const srLow = evaluateGate({
    id: 'sr', kind: 'successRate', threshold: 0.95, observed: 1, samples: 3, minSamples: 100,
  });
  assert.equal(srLow.outcome, 'INCONCLUSIVE');
});

test('evaluateGate: threshold comparison per kind', () => {
  const covered = { samples: 100, minSamples: 100, successRate: 0.97, minSuccessRate: 0.95 };
  assert.equal(evaluateGate({ id: 'g', kind: 'percentile', threshold: 60_000, observed: 42_000, ...covered }).outcome, 'PASS');
  assert.equal(evaluateGate({ id: 'g', kind: 'percentile', threshold: 60_000, observed: 61_000, ...covered }).outcome, 'FAIL');
  assert.equal(evaluateGate({ id: 'g', kind: 'successRate', threshold: 0.95, observed: 0.97, samples: 100, minSamples: 100 }).outcome, 'PASS');
  assert.equal(evaluateGate({ id: 'g', kind: 'successRate', threshold: 0.95, observed: 0.90, samples: 100, minSamples: 100 }).outcome, 'FAIL');
  assert.equal(evaluateGate({ id: 'g', kind: 'exactZero', observed: 0 }).outcome, 'PASS');
  const ez = evaluateGate({ id: 'g', kind: 'exactZero', observed: 2 });
  assert.equal(ez.outcome, 'FAIL');
  assert.equal(ez.threshold, 0);
  assert.equal(evaluateGate({ id: 'g', kind: 'bool', observed: true }).outcome, 'PASS');
  assert.equal(evaluateGate({ id: 'g', kind: 'bool', observed: false }).outcome, 'FAIL');
  assert.equal(evaluateGate({ id: 'g', kind: 'max', threshold: 0.9, observed: 0.85 }).outcome, 'PASS');
  assert.equal(evaluateGate({ id: 'g', kind: 'max', threshold: 0.9, observed: 0.95 }).outcome, 'FAIL');
});

test('evaluateGate: inconclusiveReason passthrough and missing observed fail closed', () => {
  const forced = evaluateGate({
    id: 'g', kind: 'bool', observed: true, inconclusiveReason: 'fleet SHA changed mid-run',
  });
  assert.equal(forced.outcome, 'INCONCLUSIVE');
  assert.equal(forced.evidence.reason, 'fleet SHA changed mid-run');

  assert.equal(evaluateGate({ id: 'g', kind: 'max', threshold: 1, observed: NaN }).outcome, 'INCONCLUSIVE');
  assert.equal(evaluateGate({ id: 'g', kind: 'exactZero', observed: undefined }).outcome, 'INCONCLUSIVE');
  assert.equal(evaluateGate({ id: 'g', kind: 'bool', observed: undefined }).outcome, 'INCONCLUSIVE');
});

test('evaluateGate: invalid kind or missing id throws', () => {
  assert.throws(() => evaluateGate({ id: 'g', kind: 'median', threshold: 1, observed: 1 }), /unknown kind/);
  assert.throws(() => evaluateGate({ kind: 'bool', observed: true }), /gate\.id/);
  assert.deepEqual([...GATE_KINDS], ['successRate', 'percentile', 'exactZero', 'bool', 'max']);
});

// ── computeVerdict / formatVerdict ──────────────────────────────────────────

const g = (id, outcome) => ({ id, outcome, observed: 1, threshold: 1, evidence: {} });

test('computeVerdict folds FAIL > INCONCLUSIVE > PASS', () => {
  assert.equal(computeVerdict({ gates: [g('a', 'PASS'), g('b', 'PASS')] }).outcome, 'PASS');
  assert.equal(computeVerdict({ gates: [g('a', 'PASS'), g('b', 'INCONCLUSIVE')] }).outcome, 'INCONCLUSIVE');
  assert.equal(computeVerdict({ gates: [g('a', 'FAIL'), g('b', 'INCONCLUSIVE'), g('c', 'PASS')] }).outcome, 'FAIL');
});

test('computeVerdict: SAFETY_ABORT takes precedence over everything', () => {
  const v = computeVerdict({ gates: [g('a', 'PASS'), g('b', 'PASS')], safetyAbort: true });
  assert.equal(v.outcome, 'SAFETY_ABORT');
  assert.equal(computeVerdict({ gates: [g('a', 'FAIL')], safetyAbort: true }).outcome, 'SAFETY_ABORT');
  assert.ok(OUTCOMES.includes(v.outcome));
});

test('computeVerdict rejects invalid gate outcomes', () => {
  assert.throws(() => computeVerdict({ gates: [g('a', 'MAYBE')] }), /invalid outcome/);
});

test('formatVerdict renders a fixed-width row per gate with the outcome header', () => {
  const verdict = computeVerdict({
    gates: [
      { id: 'overall-success-rate', outcome: 'PASS', observed: 0.97, threshold: 0.95, evidence: {} },
      { id: 'publish-p95-ms', outcome: 'FAIL', observed: 61_000, threshold: 60_000, evidence: {} },
      { id: 'gated-signatures', outcome: 'INCONCLUSIVE', observed: null, threshold: 0, evidence: { reason: 'cursor vacuumed' } },
    ],
  });
  const text = formatVerdict(verdict);
  const lines = text.split('\n');
  assert.match(lines[0], /^VERDICT: FAIL {2}\(1 pass, 1 fail, 1 inconclusive of 3 gates\)$/);
  assert.match(lines[1], /^GATE\s+OUTCOME\s+OBSERVED\s+THRESHOLD\s+NOTE$/);
  // one row per gate, and the OUTCOME column is aligned across all rows
  const idWidth = Math.max('GATE'.length, ...verdict.gates.map((x) => x.id.length));
  for (const gate of verdict.gates) {
    const row = lines.find((l) => l.startsWith(gate.id));
    assert.ok(row, `row for ${gate.id}`);
    assert.equal(row.indexOf(gate.outcome), idWidth + 2);
  }
  assert.ok(lines.find((l) => l.includes('cursor vacuumed')));
  // fixed-width and colorless
  assert.ok(!text.includes('['));
});

test('formatVerdict for SAFETY_ABORT verdicts', () => {
  const text = formatVerdict(computeVerdict({ gates: [g('a', 'PASS')], safetyAbort: true }));
  assert.match(text, /^VERDICT: SAFETY_ABORT/);
});
