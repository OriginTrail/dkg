// OT-RFC-61 §6 — scoring semantics: aggregates, coverage gates, verdict.
// Implements the Phase 0 contract; exported signatures are frozen.

import { FAILURE_CLASSES } from './evidence.mjs';
import { percentile as utilPercentile } from './util.mjs';

/** Run outcomes. */
export const OUTCOMES = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE', 'SAFETY_ABORT', 'NOT_RUN']);

/** Gate kinds understood by evaluateGate (extra export; scenario.buildGates may reuse). */
export const GATE_KINDS = Object.freeze(['successRate', 'percentile', 'exactZero', 'bool', 'max']);

const GATE_OUTCOMES = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Classify a failure from client output/daemon state into the closed enum
 * (evidence.mjs FAILURE_CLASSES) — rfc59 classifyFailure port, extended.
 * Recognition order:
 *  1. an input field that IS an enum member (or a pre-composed `error:<class>`)
 *     passes through verbatim — daemon jobs / callers may pre-classify;
 *  2. HTTP 503 or shed markers => admission_shed (word-boundary matched:
 *     "established"/"published" never classify as shed);
 *  3. the rfc59 text patterns in their original precedence
 *     (allowance, wallet-lock wedge, transport, quorum/backoff, timeout),
 *     extended with rpc_exhaustion, readback_mismatch, and client-abort markers.
 * Unknown → throws (never fold silently); caller may catch and use `error:<class>`.
 * @param {{stdout?: string, stderr?: string, jobError?: string, httpStatus?: number}} e
 * @returns {string}
 */
export function classifyFailure(e) {
  const fields = [e?.jobError, e?.stderr, e?.stdout];

  // 1. exact class token / pre-composed error:<class> passthrough
  for (const f of fields) {
    if (typeof f !== 'string') continue;
    const v = f.trim().toLowerCase();
    if (FAILURE_CLASSES.includes(v)) return v;
    if (/^error:[a-z0-9_.-]+$/i.test(v)) return v;
  }

  const raw = fields.filter((f) => typeof f === 'string' && f.length > 0).join('\n');
  const t = raw.toLowerCase();

  // 2. admission shed: HTTP 503 or explicit shed markers
  if (e?.httpStatus === 503) return 'admission_shed';
  if (/\bshed\b|\bshedding\b|load[ _-]?shed|admission[^a-z]{0,10}reject|service unavailable|\b503\b/.test(t)) {
    return 'admission_shed';
  }

  // 3. rfc59 patterns (original precedence), extended
  if (t.includes('toolowallowance') || t.includes('allowance')) return 'too_low_allowance';
  if ((t.includes('wallet') && t.includes('lock')) || t.includes('wedge')) return 'publisher_wedge';
  if (t.includes('negotiate') || t.includes('transport') || t.includes('stream has been reset')
    || t.includes('econnreset') || t.includes('econnrefused') || t.includes('socket hang up')
    || t.includes('epipe')) return 'transport_error';
  if (t.includes('quorum') || t.includes('temporarily_unavailable') || t.includes('backoff')) {
    return 'quorum_or_backoff';
  }
  if (t.includes('rpc') && (t.includes('exhaust') || t.includes('failover') || t.includes('all providers'))) {
    return 'rpc_exhaustion';
  }
  if (/readback[^a-z]{0,10}mismatch/.test(t)) return 'readback_mismatch';
  if (t.includes('timed out') || t.includes('timeout') || t.includes('etimedout')
    || t.includes('deadline exceeded')) return 'timeout';
  if (t.includes('operation was aborted') || t.includes('aborterror')) return 'aborted';

  const excerpt = raw.trim().slice(0, 200) || '<empty>';
  const status = e?.httpStatus !== undefined ? ` (httpStatus=${e.httpStatus})` : '';
  throw new Error(`classifyFailure: unclassifiable failure${status} — never fold silently: "${excerpt}"`);
}

/**
 * Aggregate op_result records for one (op, lane): attempts, successes,
 * successRate, nearest-rank p50/p95/p99/max over SUCCESSFUL durations only,
 * failure counts by class, partial flag + attempted/completed/inFlight when the
 * run was quiesced (§6: in-flight at harness quiesce => outcome 'aborted',
 * excluded from the success-rate denominator; SUT-aborted ops carry an ordinary
 * failure class on their op_result and remain failures).
 * Records carrying op/lane fields are filtered to the requested pair; records
 * without those fields are assumed pre-filtered by the caller.
 * A non-success outcome outside FAILURE_CLASSES / `error:<class>` throws.
 * Returns {op, lane, attempts, successes, failed, aborted, successRate,
 *   durationsMs: {field, count, p50, p95, p99, max}, failuresByClass, partial,
 *   attempted?, completed?, inFlight?}.
 * @param {Array<object>} opResults
 * @param {{op: string, lane: string, durationField: string, partial?: boolean,
 *          _percentile?: (values: number[], p: number) => number|null}} opts
 */
export function aggregate(opResults, opts) {
  if (!opts || typeof opts.op !== 'string' || typeof opts.lane !== 'string'
    || typeof opts.durationField !== 'string') {
    throw new TypeError('aggregate: opts {op, lane, durationField} required');
  }
  const pct = opts._percentile ?? utilPercentile;
  const rows = (Array.isArray(opResults) ? opResults : []).filter((r) => r
    && (r.op === undefined || r.op === opts.op)
    && (r.lane === undefined || r.lane === opts.lane));

  let successes = 0;
  let aborted = 0;
  const failuresByClass = {};
  const durations = [];
  for (const r of rows) {
    const outcome = r.outcome;
    if (outcome === 'success') {
      successes += 1;
      const d = r.durations_ms?.[opts.durationField] ?? r[opts.durationField];
      if (isNum(d)) durations.push(d);
    } else if (outcome === 'aborted') {
      aborted += 1; // harness quiesce — environment-invalidated (§6)
    } else {
      const cls = typeof outcome === 'string' ? outcome : '';
      if (!FAILURE_CLASSES.includes(cls) && !cls.startsWith('error:')) {
        throw new Error(`aggregate: op_result outcome outside the closed failure enum: ${JSON.stringify(outcome)}`);
      }
      failuresByClass[cls] = (failuresByClass[cls] ?? 0) + 1;
    }
  }

  const attempts = rows.length;
  const denominator = attempts - aborted;
  const out = {
    op: opts.op,
    lane: opts.lane,
    attempts,
    successes,
    failed: attempts - successes - aborted,
    aborted,
    successRate: denominator > 0 ? successes / denominator : null,
    durationsMs: {
      field: opts.durationField,
      count: durations.length,
      p50: pct(durations, 50),
      p95: pct(durations, 95),
      p99: pct(durations, 99),
      max: durations.length > 0 ? Math.max(...durations) : null,
    },
    failuresByClass,
    partial: opts.partial === true,
  };
  if (out.partial) {
    out.attempted = attempts;
    out.completed = attempts - aborted;
    out.inFlight = aborted;
  }
  return out;
}

/**
 * Evaluate one gate. Every latency/percentile gate REQUIRES minSamples and
 * minSuccessRate (RFC-61 §6 coverage gates) — absent coverage fields => throw
 * (a spec bug, not a runtime condition); successRate gates require minSamples
 * (their threshold IS the minimum success rate). Coverage shortfall or a
 * missing/NaN observed value => INCONCLUSIVE with a reason; an explicit
 * inconclusiveReason forces INCONCLUSIVE. Otherwise threshold compare:
 *   successRate: observed >= threshold; percentile/max: observed <= threshold;
 *   exactZero: observed === 0; bool: observed === true.
 * Returns {id, kind, outcome: 'PASS'|'FAIL'|'INCONCLUSIVE', observed, threshold, evidence}.
 * @param {{id: string, kind: 'successRate'|'percentile'|'exactZero'|'bool'|'max',
 *          threshold: any, observed: any, samples?: number, minSamples?: number,
 *          successRate?: number, minSuccessRate?: number, inconclusiveReason?: string}} gate
 */
export function evaluateGate(gate) {
  if (!gate || typeof gate.id !== 'string' || gate.id.length === 0) {
    throw new TypeError('evaluateGate: gate.id required');
  }
  const { id, kind } = gate;
  if (!GATE_KINDS.includes(kind)) {
    throw new TypeError(`evaluateGate: gate '${id}' has unknown kind ${JSON.stringify(kind)}`);
  }

  // RFC-61 §6: coverage gates are mandatory on latency SLOs — absence is a spec bug.
  if (kind === 'percentile') {
    if (!isNum(gate.minSamples)) {
      throw new Error(`gate '${id}': percentile SLO without minSamples — RFC-61 §6 coverage gates are mandatory (spec bug, fix the scenario/goal)`);
    }
    if (!isNum(gate.minSuccessRate)) {
      throw new Error(`gate '${id}': percentile SLO without minSuccessRate — RFC-61 §6 coverage gates are mandatory (spec bug, fix the scenario/goal)`);
    }
  }
  if (kind === 'successRate' && !isNum(gate.minSamples)) {
    throw new Error(`gate '${id}': successRate gate without minSamples — RFC-61 §6 coverage gates are mandatory (spec bug, fix the scenario/goal)`);
  }

  const threshold = kind === 'exactZero' ? 0 : kind === 'bool' ? true : gate.threshold;
  if (kind !== 'exactZero' && kind !== 'bool' && !isNum(threshold)) {
    throw new TypeError(`gate '${id}': numeric threshold required for kind '${kind}'`);
  }

  const evidence = {};
  for (const k of ['samples', 'minSamples', 'successRate', 'minSuccessRate']) {
    if (gate[k] !== undefined) evidence[k] = gate[k];
  }
  const done = (outcome, reason) => {
    if (reason) evidence.reason = reason;
    return { id, kind, outcome, observed: gate.observed ?? null, threshold, evidence };
  };

  if (gate.inconclusiveReason) return done('INCONCLUSIVE', gate.inconclusiveReason);

  if (kind === 'percentile' || kind === 'successRate') {
    const samples = isNum(gate.samples) ? gate.samples : 0;
    evidence.samples = samples;
    if (samples < gate.minSamples) {
      return done('INCONCLUSIVE', `insufficient samples: ${samples} < minSamples ${gate.minSamples}`);
    }
  }
  if (kind === 'percentile') {
    const sr = isNum(gate.successRate) ? gate.successRate : null;
    if (sr === null || sr < gate.minSuccessRate) {
      return done('INCONCLUSIVE', `success rate ${sr === null ? 'unavailable' : sr} below coverage minSuccessRate ${gate.minSuccessRate}`);
    }
  }

  const obs = gate.observed;
  if (kind === 'bool') {
    if (typeof obs !== 'boolean') return done('INCONCLUSIVE', 'observed-unavailable');
    return done(obs === true ? 'PASS' : 'FAIL');
  }
  if (!isNum(obs)) return done('INCONCLUSIVE', 'observed-unavailable');
  switch (kind) {
    case 'successRate': return done(obs >= threshold ? 'PASS' : 'FAIL');
    case 'percentile':
    case 'max': return done(obs <= threshold ? 'PASS' : 'FAIL');
    case 'exactZero': return done(obs === 0 ? 'PASS' : 'FAIL');
    /* c8 ignore next */
    default: throw new Error(`unreachable kind ${kind}`);
  }
}

/**
 * Fold gate outcomes into the run verdict:
 * any FAIL => FAIL; else any INCONCLUSIVE => INCONCLUSIVE; else PASS.
 * A safetyAbort flag forces SAFETY_ABORT regardless (terminal, consumes attempt).
 * A gate outcome outside PASS/FAIL/INCONCLUSIVE throws (fail loudly, §6).
 * @param {{gates: Array<object>, safetyAbort?: boolean}} p
 * @returns {{outcome: string, gates: Array<object>}}
 */
export function computeVerdict(p) {
  const gates = Array.isArray(p?.gates) ? p.gates : [];
  for (const g of gates) {
    if (!g || !GATE_OUTCOMES.includes(g.outcome)) {
      throw new TypeError(`computeVerdict: gate ${JSON.stringify(g?.id)} has invalid outcome ${JSON.stringify(g?.outcome)}`);
    }
  }
  let outcome;
  if (p?.safetyAbort === true) outcome = 'SAFETY_ABORT';
  else if (gates.some((g) => g.outcome === 'FAIL')) outcome = 'FAIL';
  else if (gates.some((g) => g.outcome === 'INCONCLUSIVE')) outcome = 'INCONCLUSIVE';
  else outcome = 'PASS';
  return { outcome, gates };
}

function formatCell(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toPrecision(4)));
  }
  return String(v);
}

/** Render a human verdict table (fixed-width, no color) for terminal output.
 * @param {{outcome: string, gates: Array<object>}} verdict @returns {string} */
export function formatVerdict(verdict) {
  const gates = Array.isArray(verdict?.gates) ? verdict.gates : [];
  const header = ['GATE', 'OUTCOME', 'OBSERVED', 'THRESHOLD', 'NOTE'];
  const rows = gates.map((g) => [
    formatCell(g.id),
    formatCell(g.outcome),
    formatCell(g.observed),
    formatCell(g.threshold),
    formatCell(g.evidence?.reason ?? g.reason ?? ''),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmtRow = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const tally = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (const g of gates) if (tally[g.outcome] !== undefined) tally[g.outcome] += 1;
  return [
    `VERDICT: ${verdict?.outcome ?? 'UNKNOWN'}  (${tally.PASS} pass, ${tally.FAIL} fail, ${tally.INCONCLUSIVE} inconclusive of ${gates.length} gates)`,
    fmtRow(header),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(fmtRow),
  ].join('\n');
}
