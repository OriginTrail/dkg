// Pure library of the async queue contention benchmark (OT-RFC-73 P2a): statistics, the knee, rung choice, run pairing and the
// deterministic G1 / AC5 / AC2 rules. No I/O and no dist imports, so the node:test known answers run anywhere.
// The plan's rules are "3/3 paired repeats" rules (plan 8.3): there is no bootstrap, only per-repeat ratios against fixed limits.

export const CENSOR_MS = 20_000; // a request slower than this counts as a failed (caller timeout) request
export const KNEE = { p95Ms: 5000, failureFrac: 0.05 };
export const FLAT_MAX = 1.25; // AC5: history 50k vs 0, P95 ratio limit
export const HALVE_MAX = 0.5; // G1 from P4: candidate P95 <= 0.5 x base P95
export const PAIRED_MIN = 3; // paired repeats a rule needs
export const NOISE_FLOOR = 0.1; // the data-plane margin of G2's row (10 %)
const FIVE_MIN = 300_000;

/** Default ladder: lambda = share submissions per second; readers are closed-loop content + aggregate clients. */
export const RUNGS = [
  { id: 'L0', lambda: 1, content: 1, aggregate: 1 },
  { id: 'L1', lambda: 2, content: 2, aggregate: 1 },
  { id: 'L2', lambda: 4, content: 3, aggregate: 1 },
  { id: 'L3', lambda: 8, content: 4, aggregate: 2 },
  { id: 'L4', lambda: 16, content: 6, aggregate: 3 },
  { id: 'L5', lambda: 32, content: 8, aggregate: 4 },
];

const num = (a, b) => a - b;
const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? x : Math.round(x * 100) / 100 || 0);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 || 0 : x);
const sum = (v) => v.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------- statistics
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
export function summarize(values) {
  if (!values.length) return { n: 0 };
  const s = [...values].sort(num);
  return { n: s.length, mean: r2(sum(s) / s.length), p50: r2(percentile(s, 0.5)), p95: r2(percentile(s, 0.95)), p99: r2(percentile(s, 0.99)), max: r2(s[s.length - 1]) };
}
export const median = (values) => percentile([...values].sort(num), 0.5);

// ---------------------------------------------------------------- one run's requests
/** In place. Latency is ended - intended (the open-loop schedule, so a stalled driver cannot hide late requests), censored at CENSOR_MS. */
export function finalizeRequests(requests) {
  for (const r of requests) {
    r.rawOutcome = r.outcome;
    if (r.ended === undefined) { r.outcome = 'caller_timeout'; r.lateOutcome = 'unfinished'; r.latCensored = CENSOR_MS; r.latMs = undefined; continue; }
    r.latMs = r.ended - r.intended;
    if (r.latMs > CENSOR_MS) { r.outcome = 'caller_timeout'; r.lateOutcome = r.rawOutcome ?? 'unknown'; r.latCensored = CENSOR_MS; } else r.latCensored = r.latMs;
  }
}

export function admissionSummary(requests) {
  const m = requests.filter((r) => r.windowTag === 'measure');
  const outcomes = {}, outcomeDetail = {};
  for (const r of m) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    if (r.outcome === 'success') continue;
    const k = `${r.outcome}|${r.code ?? r.lateOutcome ?? ''}|${r.phase ?? ''}|${r.admissionOutcome ?? ''}${r.outcome === 'caller_timeout' && r.lateOutcome ? `|late=${r.lateOutcome}` : ''}`;
    outcomeDetail[k] = (outcomeDetail[k] ?? 0) + 1;
  }
  const cens = m.map((r) => r.latCensored).sort(num);
  const { p50, p95, p99, max, mean } = summarize(cens);
  return {
    n: m.length, nWarmup: requests.filter((r) => r.windowTag === 'warmup').length, nCooldown: requests.filter((r) => r.windowTag === 'cooldown').length,
    outcomes, outcomeDetail, F: m.length ? (m.length - (outcomes.success ?? 0)) / m.length : null,
    latencyMs: m.length ? { p50, p95, p99, max, mean } : null,
    preflightMs: summarize(m.filter((r) => r.preMs !== undefined).map((r) => r.preMs)),
    enqueueMs: summarize(m.filter((r) => r.enqMs !== undefined && r.outcome === 'success').map((r) => r.enqMs)),
  };
}

/** jobsByName: request key -> persisted jobs. Invariants: no success without a persisted job, no key admitted twice. */
export function groundTruth(requests, jobsByName) {
  const m = requests.filter((r) => r.windowTag === 'measure');
  const jobsOf = (r) => jobsByName.get(r.key) ?? [];
  let uncertainButAdmitted = 0, nonSuccess = 0, successWithoutPersistedJob = 0;
  for (const r of m) {
    r.gtAdmitted = jobsOf(r).length > 0;
    if (r.outcome === 'success') { if (!r.gtAdmitted) successWithoutPersistedJob++; continue; }
    nonSuccess++;
    if (r.gtAdmitted) uncertainButAdmitted++;
  }
  return { nonSuccess, uncertainButAdmitted, notAdmitted: nonSuccess - uncertainButAdmitted, successWithoutPersistedJob, doubleAdmissions: requests.filter((r) => jobsOf(r).length > 1).length };
}

// ---------------------------------------------------------------- backlog and the P8c indicator
/** Depth of [start, end) intervals (end = Infinity allowed) sampled at every stepMs of [from, to). */
export function depthSeries(intervals, from, to, stepMs = 1000) {
  const samples = [];
  for (let t = from; t < to; t += stepMs) samples.push(intervals.reduce((n, [a, b]) => n + (a <= t && t < b ? 1 : 0), 0));
  if (!samples.length) return { n: 0, mean: null, max: null, first: null, last: null, slopePerMin: null };
  const n = samples.length, mean = sum(samples) / n, xs = samples.map((_, i) => (i * stepMs) / 60_000), mx = sum(xs) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (samples[i] - mean); sxx += (xs[i] - mx) ** 2; }
  return { n, mean: r2(mean), max: Math.max(...samples), first: samples[0], last: samples[n - 1], slopePerMin: sxx > 0 ? r2(sxy / sxx) : 0 };
}

/** Active share backlog from client data only: from each admitted request's response to its completion (or Infinity). Times are run-relative ms. */
export function shareBacklog({ requests, completions, from, to }) {
  const doneAt = new Map(completions.map((c) => [c.jobId, c.t]));
  const intervals = requests.filter((r) => (r.rawOutcome ?? r.outcome) === 'success' && r.jobId !== undefined && r.ended !== undefined)
    .map((r) => [r.ended, Math.max(r.ended, doneAt.get(r.jobId) ?? Infinity)]);
  return { ...depthSeries(intervals, from, to), jobs: intervals.length, openAtEnd: intervals.filter(([, b]) => b === Infinity).length };
}

/**
 * Plan 8.3 trigger for the bounded claimNext candidate read (P8c): claimNext P95 over the last 5 min above 2x the first 5 min, or an active backlog above 5,000.
 * claimNext = [{t (run-relative start ms), ms}]. The ratio needs a run of at least 10 min and 20 samples in each end window; the backlog leg needs no window.
 */
export function p8cTrigger({ claimNext, backlogMax, runMs }) {
  const backlogTrip = backlogMax > 5000;
  const first = claimNext.filter((c) => c.t < FIVE_MIN).map((c) => c.ms).sort(num);
  const last = claimNext.filter((c) => c.t >= runMs - FIVE_MIN).map((c) => c.ms).sort(num);
  if (runMs < 600_000 || first.length < 20 || last.length < 20) return { evaluable: false, ratio: null, backlogTrip, trigger: backlogTrip };
  const ratio = percentile(last, 0.95) / percentile(first, 0.95);
  return { evaluable: true, ratio: r2(ratio), backlogTrip, trigger: ratio > 2 || backlogTrip };
}

// ---------------------------------------------------------------- the knee and the reproduction rung
export const kneeReached = ({ p95Ms, failureFrac }) => p95Ms >= KNEE.p95Ms || failureFrac >= KNEE.failureFrac;

/** rungResults ascending [{id, p95Ms, failureFrac}] (medians over valid calibration runs). */
export function pickReproductionRung(rungResults) {
  const i = rungResults.findIndex(kneeReached);
  if (i < 0) return { status: 'no-knee', rung: null, subKneeRung: null };
  if (i === 0) return { status: 'below-ladder', rung: rungResults[0].id, subKneeRung: null };
  return { status: 'found', rung: rungResults[i].id, subKneeRung: rungResults[i - 1].id };
}

// ---------------------------------------------------------------- pairing and the rules
/** Pairing key of a record (history is dropped for the flatness rule, which compares histories). */
export const pairKey = (r, { ignoreHistory = false } = {}) => [...(ignoreHistory ? [] : [r.cell.history]), r.cell.observer, r.cell.rung, r.cell.repeat].join('|');

export function pairRuns(aRecords, bRecords, keyOf = (r) => r.key) {
  const index = (recs) => { const m = new Map(); for (const r of recs) { const k = keyOf(r); if (!m.get(k)?.valid || r.valid) m.set(k, r); } return m; }; // the last valid run of a key
  const am = index(aRecords), bm = index(bRecords), pairs = [], missing = [];
  for (const [key, a] of am) { const b = bm.get(key); if (b) pairs.push({ key, a, b, valid: Boolean(a.valid && b.valid) }); else missing.push({ key, missingIn: 'b' }); }
  for (const key of bm.keys()) if (!am.has(key)) missing.push({ key, missingIn: 'a' });
  return { pairs, missing };
}

/**
 * metric ratio b/a per valid pair against limit (and an optional lower bound). Pass: >= PAIRED_MIN valid pairs and every pair inside the bounds.
 * Incomplete (not a fail): fewer valid pairs, or requireKnee and a base run below the knee (a halving test where the base is healthy proves nothing).
 */
export function ratioRule({ pairs, metric = 'p95Ms', limit, lower, label, requireKnee = false }) {
  const valid = pairs.filter((p) => p.valid);
  const perRepeat = valid.map((p) => {
    const a = p.a[metric], b = p.b[metric], ratio = a === 0 ? (b === 0 ? 1 : Infinity) : b / a;
    return { key: p.key, a, b, ratio: r4(ratio), ok: ratio <= limit && (lower === undefined || ratio >= lower) };
  });
  const out = { label, metric, limit, need: PAIRED_MIN, have: valid.length, perRepeat };
  if (valid.length < PAIRED_MIN) return { ...out, status: 'incomplete', reason: `needs ${PAIRED_MIN} valid paired repeats, has ${valid.length}` };
  if (requireKnee && valid.some((p) => !kneeReached(p.a))) return { ...out, status: 'incomplete', reason: 'a base run is below the knee, so the halving test is vacuous at this rung' };
  return { ...out, status: perRepeat.every((r) => r.ok) ? 'pass' : 'fail' };
}
export const halve = (pairs) => ratioRule({ pairs, limit: HALVE_MAX, label: 'halve: candidate P95 <= 0.5 x base', requireKnee: true });
export const flat = (pairs) => ratioRule({ pairs, limit: FLAT_MAX, label: 'flat: history 50k P95 <= 1.25 x history 0' });

/** A/A: pairs of two same-build runs (a = first, b = second); the margin is the worst deviation, never below the 10 % floor. */
export function noiseMargin(aaPairs) {
  const rho = aaPairs.filter((p) => p.valid).map((p) => p.b.p95Ms / p.a.p95Ms);
  return r4(Math.max(NOISE_FLOOR, ...rho.map((x) => Math.max(x, 1 / x) - 1)));
}
/** AC2 path-off equivalence: every b/a inside [1/(1+m), 1+m]. The margin is required so it is declared before the A/B. */
export function equivalent(pairs, margin) {
  if (!Number.isFinite(margin) || margin < 0) throw new Error('equivalent needs the declared margin (from the A/A pair)');
  return ratioRule({ pairs, limit: 1 + margin, lower: 1 / (1 + margin), label: `equal: candidate P95 within +-${margin} of base` });
}
/** Reported, not gating (G0 rule R28 and the G2 table): candidate failure fraction <= 2 % per repeat, completions/min >= 0.9 x base. */
export function guards(pairs) {
  const valid = pairs.filter((p) => p.valid);
  return {
    failureFrac: valid.map((p) => ({ key: p.key, value: p.b.failureFrac, ok: p.b.failureFrac <= 0.02 })),
    completions: valid.map((p) => { const ratio = p.a.completionsPerMin ? r4(p.b.completionsPerMin / p.a.completionsPerMin) : null; return { key: p.key, ratio, ok: ratio === null || ratio >= 0.9 }; }),
  };
}

// ---------------------------------------------------------------- validity and the run record
/** Pure checks of one run; every key but `ok` is a boolean that must hold. */
export function validity({ lambda, measureMs, measured, stillInflight, reconcileError, successWithoutJob, doubleAdmissions, driverCpu, idlePublisherErrors }) {
  const expected = (lambda * measureMs) / 1000;
  const checks = {
    arrivalsWithin4Sigma: Math.abs(measured - expected) <= 4 * Math.sqrt(Math.max(expected, 1)),
    drained: stillInflight === 0, noReconcileError: !reconcileError, noSuccessWithoutJob: successWithoutJob === 0, noDoubleAdmission: doubleAdmissions === 0,
    driverHeadroomOk: driverCpu < 0.8, idlePublisherQuiet: idlePublisherErrors === 0,
  };
  return { arrivalsMeasured: measured, arrivalsExpected: r2(expected), ...checks, ok: Object.values(checks).every(Boolean) };
}

/** summary.json -> the record the rules and the ledger read. */
export function extractRecord(s) {
  const cell = s.meta.cell, v = s.validity;
  return {
    key: pairKey({ cell }), label: s.meta.label ?? null, cell, repeat: cell.repeat, valid: v.ok === true,
    failedChecks: Object.keys(v).filter((k) => v[k] === false), p95Ms: s.submission.latencyMs?.p95 ?? null, failureFrac: s.submission.F,
    completionsPerMin: s.worker?.completionsPerMin ?? null, observerP95Ms: s.observer?.latencyMs?.p95 ?? null,
    git: s.meta.git, scriptSha256: s.meta.scriptSha256, distStaleSuspected: Boolean(s.meta.distStaleSuspected), runId: s.meta.runId,
  };
}

/** Markdown table of EVERY run, discarded ones included with the failed checks (the PR lists each run). */
export function ledgerMarkdown(records) {
  const row = (r) => `| ${r.label ?? ''} | ${r.runId} | ${r.cell.history}/${r.cell.observer}/${r.cell.rung}/r${r.cell.repeat} | ${r.valid ? 'valid' : `INVALID: ${r.failedChecks.join(', ')}`} | ${r.p95Ms} | ${r.failureFrac === null ? '' : r4(r.failureFrac)} | ${r.completionsPerMin ?? ''} | ${r.observerP95Ms ?? ''} | ${String(r.git?.sha ?? '').slice(0, 9)}${r.git?.dirty ? '+dirty' : ''} |`;
  return ['| label | run | history/observer/rung/repeat | validity | P95 ms | F | completions/min | observer P95 ms | git |', '|---|---|---|---|---|---|---|---|---|', ...records.map(row)].join('\n');
}
