// Pure library of the async queue contention benchmark (OT-RFC-73 P2a): statistics, the knee, rung choice, run pairing
// and the deterministic G1 / AC5 / AC2 rules. No I/O and no dist imports (fixture.mjs is a plain constants and
// replay-table module), so the node:test known answers run anywhere. The plan's rules are "3/3 paired repeats" rules
// (plan 8.3): there is no bootstrap, only per-repeat ratios against fixed limits.
import { DATA_OPS_PER_SHARE } from './fixture.mjs';

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
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
export function summarize(values) {
  if (!values.length) return { n: 0 };
  const s = [...values].sort(num);
  return {
    n: s.length,
    mean: r2(sum(s) / s.length),
    p50: r2(percentile(s, 0.5)),
    p95: r2(percentile(s, 0.95)),
    p99: r2(percentile(s, 0.99)),
    max: r2(s[s.length - 1]),
  };
}
export const median = (values) => percentile([...values].sort(num), 0.5);

// ---------------------------------------------------------------- one run's requests
/**
 * In place. Latency is ended - intended (the open-loop schedule, so a stalled driver cannot hide late requests),
 * censored at CENSOR_MS.
 */
export function finalizeRequests(requests) {
  for (const r of requests) {
    r.rawOutcome = r.outcome;
    if (r.ended === undefined) {
      r.outcome = 'caller_timeout';
      r.lateOutcome = 'unfinished';
      r.latCensored = CENSOR_MS;
      r.latMs = undefined;
      continue;
    }
    r.latMs = r.ended - r.intended;
    if (r.latMs > CENSOR_MS) {
      r.outcome = 'caller_timeout';
      r.lateOutcome = r.rawOutcome ?? 'unknown';
      r.latCensored = CENSOR_MS;
    } else r.latCensored = r.latMs;
  }
}

export function admissionSummary(requests) {
  const m = requests.filter((r) => r.windowTag === 'measure');
  const outcomes = {};
  const outcomeDetail = {};
  for (const r of m) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    if (r.outcome === 'success') continue;
    const late = r.outcome === 'caller_timeout' && r.lateOutcome ? `|late=${r.lateOutcome}` : '';
    const k = `${r.outcome}|${r.code ?? r.lateOutcome ?? ''}|${r.phase ?? ''}|${r.admissionOutcome ?? ''}${late}`;
    outcomeDetail[k] = (outcomeDetail[k] ?? 0) + 1;
  }
  const cens = m.map((r) => r.latCensored).sort(num);
  const { p50, p95, p99, max, mean } = summarize(cens);
  return {
    n: m.length,
    nWarmup: requests.filter((r) => r.windowTag === 'warmup').length,
    nCooldown: requests.filter((r) => r.windowTag === 'cooldown').length,
    outcomes,
    outcomeDetail,
    F: m.length ? (m.length - (outcomes.success ?? 0)) / m.length : null,
    latencyMs: m.length ? { p50, p95, p99, max, mean } : null,
    preflightMs: summarize(m.filter((r) => r.preMs !== undefined).map((r) => r.preMs)),
    enqueueMs: summarize(m.filter((r) => r.enqMs !== undefined && r.outcome === 'success').map((r) => r.enqMs)),
  };
}

/** jobsByName: request key -> persisted jobs. Invariants: no success without a persisted job, no key admitted twice. */
export function groundTruth(requests, jobsByName) {
  const m = requests.filter((r) => r.windowTag === 'measure');
  const jobsOf = (r) => jobsByName.get(r.key) ?? [];
  let uncertainButAdmitted = 0;
  let nonSuccess = 0;
  let successWithoutPersistedJob = 0;
  for (const r of m) {
    r.gtAdmitted = jobsOf(r).length > 0;
    if (r.outcome === 'success') {
      if (!r.gtAdmitted) successWithoutPersistedJob++;
      continue;
    }
    nonSuccess++;
    if (r.gtAdmitted) uncertainButAdmitted++;
  }
  return {
    nonSuccess,
    uncertainButAdmitted,
    notAdmitted: nonSuccess - uncertainButAdmitted,
    successWithoutPersistedJob,
    doubleAdmissions: requests.filter((r) => jobsOf(r).length > 1).length,
  };
}

// ---------------------------------------------------------------- backlog and the P8c indicator
/** Depth of [start, end) intervals (end = Infinity allowed) sampled at every stepMs of [from, to). */
export function depthSeries(intervals, from, to, stepMs = 1000) {
  const samples = [];
  for (let t = from; t < to; t += stepMs)
    samples.push(intervals.reduce((n, [a, b]) => n + (a <= t && t < b ? 1 : 0), 0));
  if (!samples.length) return { n: 0, mean: null, max: null, first: null, last: null, slopePerMin: null };
  const n = samples.length;
  const mean = sum(samples) / n;
  const xs = samples.map((_, i) => (i * stepMs) / 60_000);
  const mx = sum(xs) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (samples[i] - mean);
    sxx += (xs[i] - mx) ** 2;
  }
  return {
    n,
    mean: r2(mean),
    max: Math.max(...samples),
    first: samples[0],
    last: samples[n - 1],
    slopePerMin: sxx > 0 ? r2(sxy / sxx) : 0,
  };
}

/**
 * Active share backlog from client data only: from each admitted request's response to its completion (or Infinity).
 * Times are run-relative ms.
 */
export function shareBacklog({ requests, completions, from, to }) {
  const doneAt = new Map(completions.map((c) => [c.jobId, c.t]));
  const intervals = requests
    .filter((r) => (r.rawOutcome ?? r.outcome) === 'success' && r.jobId !== undefined && r.ended !== undefined)
    .map((r) => [r.ended, Math.max(r.ended, doneAt.get(r.jobId) ?? Infinity)]);
  return {
    ...depthSeries(intervals, from, to),
    jobs: intervals.length,
    openAtEnd: intervals.filter(([, b]) => b === Infinity).length,
  };
}

/**
 * Plan 8.3 trigger for the bounded claimNext candidate read (P8c): claimNext P95 over the last 5 min above 2x the first
 * 5 min, or an active backlog above 5,000. claimNext = [{t (run-relative start ms), ms}]. The ratio needs a run of at
 * least 10 min and 20 samples in each end window; the backlog leg needs no window.
 */
export function p8cTrigger({ claimNext, backlogMax, runMs }) {
  const backlogTrip = backlogMax > 5000;
  const first = claimNext
    .filter((c) => c.t < FIVE_MIN)
    .map((c) => c.ms)
    .sort(num);
  const last = claimNext
    .filter((c) => c.t >= runMs - FIVE_MIN)
    .map((c) => c.ms)
    .sort(num);
  if (runMs < 600_000 || first.length < 20 || last.length < 20)
    return { evaluable: false, ratio: null, backlogTrip, trigger: backlogTrip };
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
export const pairKey = (r, { ignoreHistory = false } = {}) =>
  [...(ignoreHistory ? [] : [r.cell.history]), r.cell.observer, r.cell.rung, r.cell.repeat].join('|');

/**
 * Stable text of a value (object keys sorted), so two records compare equal whatever the order their JSON was written
 * in.
 */
const canon = (x) =>
  JSON.stringify(x ?? null, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => (p < q ? -1 : 1)))
      : v,
  );

/**
 * Settings the two runs of a pair must share (plan 8.3: "identical flags"). The seed file is left out for the flatness
 * rule, which compares histories.
 */
const SAME_IN_A_PAIR = ['windows', 'lambda', 'content', 'aggregate', 'calibrationSha256', 'seedFileSha256', 'cpus'];

/**
 * { differs: the settings that differ, envDiffers }. The DKG_STORE_* env may differ on purpose (the knob under test),
 * so it is only reported.
 */
export function comparability(a, b, { ignoreSeed = false } = {}) {
  const left = a.config ?? {};
  const right = b.config ?? {};
  const differs = SAME_IN_A_PAIR.filter(
    (k) => !(ignoreSeed && k === 'seedFileSha256') && canon(left[k]) !== canon(right[k]),
  );
  return { differs, envDiffers: canon(left.env) !== canon(right.env) };
}

/**
 * The run to use per key (a valid one beats an invalid one) and the keys with more than one valid run, which are
 * ambiguous.
 */
function indexRuns(records, keyOf) {
  const chosen = new Map();
  const valid = new Map();
  for (const r of records) {
    const k = keyOf(r);
    if (!chosen.get(k)?.valid || r.valid) chosen.set(k, r);
    if (r.valid) valid.set(k, [...(valid.get(k) ?? []), r.runId]);
  }
  return { chosen, ambiguous: new Map([...valid].filter(([, ids]) => ids.length > 1)) };
}

/**
 * Pairs the runs of two arms by key. A pair counts (valid) only when both runs are valid, the key has exactly one valid
 * run per arm, and the runs share the settings of SAME_IN_A_PAIR; `reasons` says why a pair with two valid runs does
 * not count.
 */
export function pairRuns(aRecords, bRecords, keyOf = (r) => r.key, { ignoreSeed = false } = {}) {
  const A = indexRuns(aRecords, keyOf);
  const B = indexRuns(bRecords, keyOf);
  const pairs = [];
  const missing = [];
  for (const [key, a] of A.chosen) {
    const b = B.chosen.get(key);
    if (!b) {
      missing.push({ key, missingIn: 'b' });
      continue;
    }
    const reasons = [];
    for (const [side, index] of [
      ['a', A],
      ['b', B],
    ]) {
      if (index.ambiguous.has(key)) {
        const ids = index.ambiguous.get(key);
        reasons.push(
          `${side} has ${ids.length} valid runs for this key (${ids.join(', ')}): ` +
            'remove the ones that are not meant to count',
        );
      }
    }
    const { differs, envDiffers } = comparability(a, b, { ignoreSeed });
    if (differs.length) reasons.push(`the runs differ in ${differs.join(', ')}`);
    pairs.push({ key, a, b, reasons, envDiffers, valid: Boolean(a.valid && b.valid) && reasons.length === 0 });
  }
  for (const key of B.chosen.keys()) if (!A.chosen.has(key)) missing.push({ key, missingIn: 'a' });
  return { pairs, missing };
}

/**
 * metric ratio b/a per valid pair against limit (and an optional lower bound). Pass: >= PAIRED_MIN valid pairs and
 * every pair inside the bounds. Incomplete (not a fail): fewer valid pairs. With checkKnee, `belowKnee` lists the pairs
 * whose base run did not reach the knee: the plan calibrates the rung once on the base and does not re-judge each
 * repeat, so this is reported (a halving test against a healthy base is weak), not gating.
 */
export function ratioRule({ pairs, metric = 'p95Ms', limit, lower, label, checkKnee = false }) {
  const valid = pairs.filter((p) => p.valid);
  const perRepeat = valid.map((p) => {
    const a = p.a[metric];
    const b = p.b[metric];
    const ratio = a === 0 ? (b === 0 ? 1 : Infinity) : b / a;
    return { key: p.key, a, b, ratio: r4(ratio), ok: ratio <= limit && (lower === undefined || ratio >= lower) };
  });
  const out = { label, metric, limit, need: PAIRED_MIN, have: valid.length, perRepeat };
  if (checkKnee) out.belowKnee = valid.filter((p) => !kneeReached(p.a)).map((p) => p.key);
  if (valid.length < PAIRED_MIN) {
    return { ...out, status: 'incomplete', reason: `needs ${PAIRED_MIN} valid paired repeats, has ${valid.length}` };
  }
  return { ...out, status: perRepeat.every((r) => r.ok) ? 'pass' : 'fail' };
}
export const halve = (pairs) =>
  ratioRule({ pairs, limit: HALVE_MAX, label: 'halve: candidate P95 <= 0.5 x base', checkKnee: true });
export const flat = (pairs) =>
  ratioRule({ pairs, limit: FLAT_MAX, label: 'flat: history 50k P95 <= 1.25 x history 0' });

/**
 * A/A: pairs of two same-build runs (a = first, b = second); the margin is the worst deviation, never below the 10 %
 * floor.
 */
export function noiseMargin(aaPairs) {
  const rho = aaPairs.filter((p) => p.valid).map((p) => p.b.p95Ms / p.a.p95Ms);
  return r4(Math.max(NOISE_FLOOR, ...rho.map((x) => Math.max(x, 1 / x) - 1)));
}
/**
 * AC2 path-off equivalence: every b/a inside [1/(1+m), 1+m]. The margin is required so it is declared before the A/B.
 */
export function equivalent(pairs, margin) {
  if (!Number.isFinite(margin) || margin < 0)
    throw new Error('equivalent needs the declared margin (from the A/A pair)');
  return ratioRule({
    pairs,
    limit: 1 + margin,
    lower: 1 / (1 + margin),
    label: `equal: candidate P95 within +-${margin} of base`,
  });
}
/**
 * Reported, not gating (G0 rule R28 and the G2 table): candidate failure fraction <= 2 % per repeat, completions/min >=
 * 0.9 x base.
 */
export function guards(pairs) {
  const valid = pairs.filter((p) => p.valid);
  return {
    failureFrac: valid.map((p) => ({ key: p.key, value: p.b.failureFrac, ok: p.b.failureFrac <= 0.02 })),
    completions: valid.map((p) => {
      const ratio = p.a.completionsPerMin ? r4(p.b.completionsPerMin / p.a.completionsPerMin) : null;
      return { key: p.key, ratio, ok: ratio === null || ratio >= 0.9 };
    }),
  };
}

// ---------------------------------------------------------------- validity and the run record
/**
 * Pure checks of one run; every key but `ok` is a boolean that must hold. `worker` = { agentErrors, crashes,
 * failedTerminal, succeeded, attempted, dataOps }: the fake agent and the supervisor must have worked, or a faster
 * admission could be nothing but a worker that no longer runs the 43-operation share body (a missing field fails the
 * check).
 */
export function validity({
  lambda,
  measureMs,
  measured,
  stillInflight,
  reconcileError,
  successWithoutJob,
  doubleAdmissions,
  driverCpu,
  idlePublisherErrors,
  worker,
  seedFileVerified,
}) {
  const expected = (lambda * measureMs) / 1000;
  const w = worker ?? {};
  const checks = {
    arrivalsWithin4Sigma: Math.abs(measured - expected) <= 4 * Math.sqrt(Math.max(expected, 1)),
    drained: stillInflight === 0,
    noReconcileError: !reconcileError,
    noSuccessWithoutJob: successWithoutJob === 0,
    noDoubleAdmission: doubleAdmissions === 0,
    driverHeadroomOk: driverCpu < 0.8,
    idlePublisherQuiet: idlePublisherErrors === 0,
    workerContractOk: w.agentErrors === 0 && w.crashes === 0 && w.failedTerminal === 0 && w.succeeded > 0,
    dataPlaneReplayed: w.dataOps >= DATA_OPS_PER_SHARE * w.succeeded && w.dataOps <= DATA_OPS_PER_SHARE * w.attempted,
    seedFileVerified: seedFileVerified === true,
  };
  return {
    arrivalsMeasured: measured,
    arrivalsExpected: r2(expected),
    ...checks,
    ok: Object.values(checks).every(Boolean),
  };
}

/** summary.json -> the record the rules and the ledger read. */
export function extractRecord(s) {
  const { cell } = s.meta;
  const v = s.validity;
  const counters = s.worker?.counters ?? {};
  const seed = s.meta.seedFile;
  return {
    key: pairKey({ cell }),
    label: s.meta.label ?? null,
    cell,
    repeat: cell.repeat,
    valid: v.ok === true,
    failedChecks: Object.keys(v).filter((k) => v[k] === false),
    p95Ms: s.submission.latencyMs?.p95 ?? null,
    failureFrac: s.submission.F,
    completionsPerMin: s.worker?.completionsPerMin ?? null,
    observerP95Ms: s.observer?.latencyMs?.p95 ?? null,
    workerCounters: {
      succeeded: counters.succeeded ?? null,
      failedTerminal: counters.failedTerminal ?? null,
      agentErrors: s.worker?.agent?.agentErrors ?? null,
    },
    p8c: s.worker?.p8c ?? null,
    config: {
      windows: s.meta.windows ?? null,
      env: s.meta.env ?? null,
      lambda: cell.lambda ?? null,
      content: cell.content ?? null,
      aggregate: cell.aggregate ?? null,
      calibrationSha256: s.meta.calibration?.sha256 ?? null,
      seedFileSha256: seed ? (seed.loadedSha256 ?? seed.sha256 ?? null) : null,
      cpus: s.meta.host?.cpus ?? null,
    },
    windowsDifferFromCalibration: Boolean(s.meta.calibration?.windowsDiffer),
    git: s.meta.git,
    scriptSha256: s.meta.scriptSha256,
    distStaleSuspected: Boolean(s.meta.distStaleSuspected),
    runId: s.meta.runId,
  };
}

/**
 * What a reader of a verdict must see next to the result: runs that differ in what they should share, a pair that does
 * not count and why, a P8c trigger (plan 8.3: it applies to any G1 run), a base run below the knee, windows that are
 * not the calibration's, a dirty or stale build.
 */
export function integrityWarnings(records, pairs, result) {
  const warnings = [];
  if (new Set(records.map((r) => r.scriptSha256)).size > 1) {
    warnings.push('base and candidate ran different benchmark script files (scriptSha256 differs)');
  }
  if (records.some((r) => r.distStaleSuspected)) {
    warnings.push('a run suspected a stale dist build (rebuild the worktree packages and rerun)');
  }
  if (records.some((r) => r.git?.dirty)) warnings.push('a run came from a dirty working tree');
  for (const p of pairs.filter((x) => x.reasons?.length))
    warnings.push(`pair ${p.key} does not count: ${p.reasons.join('; ')}`);
  const envPairs = pairs.filter((p) => p.envDiffers).map((p) => p.key);
  if (envPairs.length) {
    warnings.push(
      `the DKG_STORE_* env differs between the arms in ${envPairs.join(', ')} (expected only for the knob under test)`,
    );
  }
  for (const r of records.filter((x) => x.p8c?.trigger)) {
    const why = [
      r.p8c.ratio !== null && r.p8c.ratio > 2 ? `claimNext P95 ratio ${r.p8c.ratio}` : null,
      r.p8c.backlogTrip ? 'active backlog above 5,000' : null,
    ];
    warnings.push(`run ${r.runId}: P8c trigger (${why.filter(Boolean).join(', ')}): record it in the PR`);
  }
  const offCalibration = records.filter((r) => r.windowsDifferFromCalibration).map((r) => r.runId);
  if (offCalibration.length)
    warnings.push(`runs with windows other than their calibration's: ${offCalibration.join(', ')}`);
  if (result?.belowKnee?.length) {
    warnings.push(
      `the base run is below the knee in ${result.belowKnee.join(', ')}: the halving test is weak in those repeats`,
    );
  }
  return warnings;
}

const p8cCell = (p8c) => (p8c?.trigger ? 'TRIP' : p8c?.evaluable ? 'ok' : 'n/e');

/** Markdown table of EVERY run, discarded ones included with the failed checks (the PR lists each run). */
export function ledgerMarkdown(records) {
  const row = (r) => {
    const w = r.workerCounters ?? {};
    const cells = [
      r.label ?? '',
      r.runId,
      `${r.cell.history}/${r.cell.observer}/${r.cell.rung}/r${r.cell.repeat}`,
      r.valid ? 'valid' : `INVALID: ${r.failedChecks.join(', ')}`,
      r.p95Ms,
      r.failureFrac === null ? '' : r4(r.failureFrac),
      r.completionsPerMin ?? '',
      `${w.succeeded ?? ''}/${w.failedTerminal ?? ''}/${w.agentErrors ?? ''}`,
      p8cCell(r.p8c),
      r.observerP95Ms ?? '',
      `${String(r.git?.sha ?? '').slice(0, 9)}${r.git?.dirty ? '+dirty' : ''}`,
    ];
    return `| ${cells.join(' | ')} |`;
  };
  const head = [
    'label',
    'run',
    'history/observer/rung/repeat',
    'validity',
    'P95 ms',
    'F',
    'completions/min',
    'worker ok/failed/agent errors',
    'P8c',
    'observer P95 ms',
    'git',
  ];
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...records.map(row)].join('\n');
}
