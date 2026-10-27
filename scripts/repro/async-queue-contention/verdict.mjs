// Pure library of the async queue contention benchmark (OT-RFC-73 P2a/P2b): statistics, the knee, rung choice, run
// pairing and the deterministic G1 / AC5 / AC2 rules. No I/O and no dist imports (fixture.mjs is a plain constants and
// replay-table module), so the node:test known answers run anywhere. The plan's rules are "3/3 paired repeats" rules
// (plan 8.3): there is no bootstrap, only per-repeat ratios against fixed limits.
// The rules judge one metric family (FAMILIES): the share stream's P95 (the default, P2a) or, from P2b, the publisher
// stream's publish P95, its pick-up p50 (D-15) or its worker-free pick-up p50 (D-16). A pair that lacks the family's
// metric is not a valid pair: the rule is INCOMPLETE, never a PASS and never a FAIL on a missing number.
import { DATA_OPS_PER_SHARE, LIFT_TAIL_OPS } from './fixture.mjs';

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

/**
 * Named loads of the publisher and mixed cells (P2b): the levels G0b ran (PSTAR publish-only, MIX mixed) and the low
 * publish rung. mu = publish submissions per second. Not a ladder: the publish ladder is calibrated per host and
 * pre-declared in the G2 protocol (calibrate covers the share ladder only), and the G1b rehearsal needs exactly these
 * fixed loads.
 */
export const PUBLISH_RUNGS = [
  { id: 'PLOW', lambda: 0, mu: 0.4, content: 3, aggregate: 1 },
  { id: 'PSTAR', lambda: 0, mu: 0.8, content: 4, aggregate: 2 },
  { id: 'MIX', lambda: 4, mu: 0.4, content: 3, aggregate: 1 },
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

/**
 * jobsByName: request key -> persisted jobs. Invariants: no success without a persisted job, no key admitted twice. Also
 * stamps r.gtJobId (the persisted job's id, every window) on each request the queue holds a job for: the admission
 * evidence shareBacklog counts, whatever the client was told.
 */
export function groundTruth(requests, jobsByName) {
  const m = requests.filter((r) => r.windowTag === 'measure');
  const jobsOf = (r) => jobsByName.get(r.key) ?? [];
  for (const r of requests) r.gtJobId = jobsOf(r)[0]?.jobId;
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
 * Largest depth the [start, end) intervals (end = Infinity allowed) reach at any instant of [from, to], both ends
 * included. Exact: a sweep over the +1 (start) and -1 (end) events, not a sampling, so a backlog that rises and falls
 * between two samples is seen, and so is one that appears after the last whole second. The intervals are half-open, as
 * in depthSeries, so at one instant the ends go first: a job completed at t and a job acknowledged at t are never open
 * together, and counting the start first would invent a depth the queue never had. An interval with no length (done at
 * or before it was acknowledged) is never open. An interval that began before `from` counts from `from`.
 */
export function peakDepth(intervals, from, to) {
  const events = [];
  for (const [a, b] of intervals) {
    if (!(a < b) || a > to || b <= from) continue;
    events.push([Math.max(a, from), 1]);
    if (b <= to) events.push([b, -1]);
  }
  events.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let depth = 0;
  let peak = 0;
  for (const [, step] of events) {
    depth += step;
    if (depth > peak) peak = depth;
  }
  return peak;
}

/**
 * Active share backlog: from each admitted request's response to its completion (or Infinity). A request is admitted
 * when the client was acknowledged (its job id) or when reconciliation found a persisted job for it (groundTruth's
 * gtJobId, run first): an indeterminate admission that landed is still an unfinished job. Times are run-relative ms.
 */
function backlogIntervals({ requests, completions }) {
  const doneAt = new Map(completions.map((c) => [c.jobId, c.t]));
  const jobIdOf = (r) => ((r.rawOutcome ?? r.outcome) === 'success' ? r.jobId : r.gtJobId);
  return requests
    .filter((r) => jobIdOf(r) !== undefined && r.ended !== undefined)
    .map((r) => [r.ended, Math.max(r.ended, doneAt.get(jobIdOf(r)) ?? Infinity)]);
}

/** The backlog statistics of [from, to), sampled every second (depthSeries), and the job counts. */
export function shareBacklog({ requests, completions, from, to }) {
  const intervals = backlogIntervals({ requests, completions });
  return {
    ...depthSeries(intervals, from, to),
    jobs: intervals.length,
    openAtEnd: intervals.filter(([, b]) => b === Infinity).length,
  };
}

/** The exact largest active backlog over [from, to] (peakDepth of the intervals shareBacklog samples). */
export const peakBacklog = ({ requests, completions, from, to }) =>
  peakDepth(backlogIntervals({ requests, completions }), from, to);

/**
 * Plan 8.3 trigger for the bounded claimNext candidate read (P8c): claimNext P95 over the last 5 min above 2x the first
 * 5 min, or an active backlog above 5,000. claimNext = [{t (run-relative start ms), ms}]. The windows are anchored to
 * the WORKLOAD horizon (horizonMs = warmup + measure + cooldown, where the producers stop), never to the moment the
 * run ended: the shutdown after the horizon (draining the producers, stopping the worker and the idle publisher) takes
 * as long as it takes, and a claim that starts after the horizon is the worker winding down, not workload, so it is
 * dropped and the last window is the 5 min up to the horizon. The ratio needs a horizon of at least 10 min and 20
 * samples in each end window; the backlog leg needs no window. backlogMax is the largest active backlog of the WHOLE
 * workload (warmup, measure and cooldown: p8cOfRun), not the measurement window's, and an exact maximum, not a sampled
 * one: a queue that grows past 5,000 only in the cooldown, or only between two samples, has still outgrown the read.
 */
export function p8cTrigger({ claimNext, backlogMax, horizonMs }) {
  const backlogTrip = backlogMax > 5000;
  const inWorkload = claimNext.filter((c) => c.t < horizonMs);
  const first = inWorkload
    .filter((c) => c.t < FIVE_MIN)
    .map((c) => c.ms)
    .sort(num);
  const last = inWorkload
    .filter((c) => c.t >= horizonMs - FIVE_MIN)
    .map((c) => c.ms)
    .sort(num);
  if (!(horizonMs >= 600_000) || first.length < 20 || last.length < 20)
    return { evaluable: false, ratio: null, backlogTrip, trigger: backlogTrip };
  const ratio = percentile(last, 0.95) / percentile(first, 0.95);
  return { evaluable: true, ratio: r2(ratio), backlogTrip, trigger: ratio > 2 || backlogTrip };
}

/**
 * The backlog figures of one run. `backlog` = the measurement window's statistics, sampled every second (what the
 * summary reports and the verdict reads), unchanged. `p8c` = the P8c trigger judged on the workload horizon
 * (warmup + measure + cooldown): the largest active backlog over it, taken exactly from the admission and completion
 * times (`backlogMax`, recorded in it; the end of the cooldown included, peakDepth for how ties at one instant are
 * ordered): the 5,000-job leg is neither a measurement-window statistic nor a sampled one; and the claimNext windows up
 * to it. How long the shutdown after the horizon took is not an input: it cannot change the result.
 */
export function p8cOfRun({ requests, completions, claimNext, windows }) {
  const { warmupMs, measureMs, cooldownMs } = windows;
  const horizonMs = warmupMs + measureMs + cooldownMs;
  const backlog = shareBacklog({ requests, completions, from: warmupMs, to: warmupMs + measureMs });
  const backlogMax = peakBacklog({ requests, completions, from: 0, to: horizonMs });
  return { backlog, p8c: { ...p8cTrigger({ claimNext, backlogMax, horizonMs }), backlogMax } };
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
const queueOf = (cell) => cell.queue ?? 'share';
const liftHistoryOf = (cell) => String(cell.liftHistory ?? '0');
const historyOf = (cell) => String(cell.history ?? '0');

/**
 * Pairing key of a record (history is dropped for the flatness rule, which compares histories, and the lift history for
 * its publisher variant). A share cell with no lift history keeps the P2a key; other queues and a lift history add a
 * segment, so the cells of different streams never pair.
 */
export const pairKey = (r, { ignoreHistory = false, ignoreLiftHistory = false } = {}) =>
  [
    ...(ignoreHistory ? [] : [r.cell.history]),
    r.cell.observer,
    r.cell.rung,
    ...(queueOf(r.cell) === 'share' ? [] : [queueOf(r.cell)]),
    ...(ignoreLiftHistory || liftHistoryOf(r.cell) === '0' ? [] : [`lift${liftHistoryOf(r.cell)}`]),
    r.cell.repeat,
  ].join('|');

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
 * Settings the two runs of a pair must share (plan 8.3: "identical flags"): `seed` is the arrival schedule and
 * `observerMs` the list observer's polling period; `mu` is the publish rate, `loadFactors` the probe and ACK load and
 * their cadences, `liftModel` the wallets, wallet hold and poll of the chain-time model. The seed files are left out
 * for the flatness rules, which compare histories. The last four identify the machine (the runbook runs both arms of a
 * verdict on the same physical host): the CPU count, the platform, the CPU model and a hash of the hostname.
 */
const SAME_IN_A_PAIR = [
  'windows',
  'lambda',
  'mu',
  'content',
  'aggregate',
  'seed',
  'observerMs',
  'calibrationSha256',
  'seedFileSha256',
  'liftSeedFileSha256',
  'loadFactors',
  'liftModel',
  'cpus',
  'platform',
  'cpuModel',
  'hostId',
];

/**
 * The machine settings of SAME_IN_A_PAIR that older summaries lack (only the CPU count was recorded): a missing value is
 * unknown. Unknown is not "different" (an old summary stays usable) and not "the same" either: two runs that differ in a
 * field both record are not a pair, and a field either lacks is listed as `unverified`, which the verdict reports as a
 * warning (integrityWarnings) so that an unconfirmed host never passes silently.
 */
const HOST_IDENTITY = ['platform', 'cpuModel', 'hostId'];
const isUnknown = (v) => v === null || v === undefined;

/**
 * { differs: the settings that differ, envDiffers, unverified: the HOST_IDENTITY fields that cannot be compared }. The
 * DKG_STORE_* env may differ on purpose (the knob under test), so it is only reported.
 */
export function comparability(a, b, { ignoreSeed = false, ignoreLiftSeed = false } = {}) {
  const left = a.config ?? {};
  const right = b.config ?? {};
  const unverified = HOST_IDENTITY.filter((k) => isUnknown(left[k]) || isUnknown(right[k]));
  const skipped = (k) => (ignoreSeed && k === 'seedFileSha256') || (ignoreLiftSeed && k === 'liftSeedFileSha256');
  const differs = SAME_IN_A_PAIR.filter(
    (k) => !skipped(k) && !unverified.includes(k) && canon(left[k]) !== canon(right[k]),
  );
  return { differs, envDiffers: canon(left.env) !== canon(right.env), unverified };
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
 * not count, `unverified` lists the host fields (HOST_IDENTITY) a run lacks, which do not stop a pair from counting.
 */
export function pairRuns(
  aRecords,
  bRecords,
  keyOf = (r) => r.key,
  { ignoreSeed = false, ignoreLiftSeed = false } = {},
) {
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
    const { differs, envDiffers, unverified } = comparability(a, b, { ignoreSeed, ignoreLiftSeed });
    if (differs.length) reasons.push(`the runs differ in ${differs.join(', ')}`);
    pairs.push({
      key,
      a,
      b,
      reasons,
      envDiffers,
      unverified,
      valid: Boolean(a.valid && b.valid) && reasons.length === 0,
    });
  }
  for (const key of B.chosen.keys()) if (!A.chosen.has(key)) missing.push({ key, missingIn: 'a' });
  return { pairs, missing };
}

/** The comparison cell of a pair key: the key without its trailing repeat (see pairKey). */
const cellOfKey = (key) => (key.includes('|') ? key.slice(0, key.lastIndexOf('|')) : '');

/**
 * Valid paired repeats per comparison cell (history, observer, rung): { cells: { cell: count }, have }. A rule needs
 * PAIRED_MIN in EVERY cell, so `have` is the thinnest cell's count and the valid pairs of different cells never add up.
 * A cell is in the comparison as soon as any run of it is, in either arm: a cell whose pairs are all discarded, and a
 * cell only one arm ran (`missing`, from pairRuns), is a cell with 0 valid repeats, never a cell to leave out. A rerun
 * that replaces a discarded run of the same key (pairRuns) is what brings such a cell back to its repeats.
 */
export function repeatsPerCell(pairs, missing = []) {
  const repeats = new Map();
  for (const { key } of [...pairs, ...missing]) {
    const cell = cellOfKey(key);
    if (!repeats.has(cell)) repeats.set(cell, new Set());
  }
  for (const p of pairs) if (p.valid) repeats.get(cellOfKey(p.key)).add(p.key);
  const cells = Object.fromEntries([...repeats].map(([cell, keys]) => [cell, keys.size]));
  const counts = Object.values(cells);
  return { cells, have: counts.length ? Math.min(...counts) : 0 };
}

/**
 * The ratio b/a of one pair's P95s (a = base or first run, b = candidate or second run), with the zero cases decided
 * once for every rule and for the A/A margin: 0 / 0 is 1 (two identical runs, no deviation), a candidate of 0 over a
 * nonzero base is 0 (a real, extreme improvement), and a nonzero candidate over a base of 0 is Infinity (unbounded: no
 * ratio limit holds, and an A/A pair like that sets no margin). Never NaN.
 */
export const p95Ratio = (a, b) => (a === 0 ? (b === 0 ? 1 : Infinity) : b / a);

/**
 * metric ratio b/a (p95Ratio) per valid pair against limit (and an optional lower bound). Pass: >= PAIRED_MIN valid
 * paired repeats in every cell and every pair inside the bounds. Incomplete (not a fail): fewer valid repeats in some
 * cell, a cell with none included (and named in the reason); `missing` = pairRuns' runs that only one arm has, which
 * put their cell in the comparison (repeatsPerCell). With checkKnee, `belowKnee` lists the pairs whose base run did not
 * reach the knee: the plan calibrates the rung once on the base and does not re-judge each repeat, so this is reported
 * (a halving test against a healthy base is weak), not gating.
 */
export function ratioRule({ pairs, missing = [], metric = 'p95Ms', limit, lower, label, checkKnee = false }) {
  const valid = pairs.filter((p) => p.valid);
  const perRepeat = valid.map((p) => {
    const a = p.a[metric];
    const b = p.b[metric];
    const ratio = p95Ratio(a, b);
    return { key: p.key, a, b, ratio: r4(ratio), ok: ratio <= limit && (lower === undefined || ratio >= lower) };
  });
  const { cells, have } = repeatsPerCell(pairs, missing);
  const out = { label, metric, limit, need: PAIRED_MIN, have, cells, perRepeat };
  if (checkKnee) out.belowKnee = valid.filter((p) => !kneeReached(p.a)).map((p) => p.key);
  if (have < PAIRED_MIN) {
    const perCell = Object.keys(cells).length > 1 ? ` (${JSON.stringify(cells)})` : '';
    const empty = Object.keys(cells).filter((cell) => cells[cell] === 0);
    const none = empty.length ? `; no valid pair in ${empty.join(', ')}` : '';
    return {
      ...out,
      status: 'incomplete',
      reason: `needs ${PAIRED_MIN} valid paired repeats in every cell, the thinnest has ${have}${perCell}${none}`,
    };
  }
  return { ...out, status: perRepeat.every((r) => r.ok) ? 'pass' : 'fail' };
}

/**
 * D-16: the accepted-but-unclaimed backlog and the claim-to-finish time are "always reported next to pick-up, with no
 * threshold". They ride with the two pick-up families (FAMILIES[..].companions) in the ledger, the rules' output and
 * the A/A declaration, and judge nothing: a slow pick-up beside a growing backlog is a worker-capacity finding to read,
 * not a rule to fail.
 */
export const PICKUP_COMPANIONS = Object.freeze([
  Object.freeze({ key: 'claimToFinishP50Ms', label: 'claim-to-finish p50 ms' }),
  Object.freeze({ key: 'unclaimedMax', label: 'unclaimed max' }),
]);

/**
 * The metric families the rules judge. `key` is the record field; `failure` and `completions` feed the reported guards;
 * `samples` is the field counting the sample behind the value (the worker-free pick-up needs a minimum, declared with
 * the protocol like the A/A margin); `companions` are the record fields reported next to the value, never judged.
 */
export const FAMILIES = {
  share: { key: 'p95Ms', label: 'P95', failure: 'failureFrac', completions: 'completionsPerMin' },
  publish: { key: 'publishP95Ms', label: 'publish P95', failure: 'publishFailureFrac', completions: 'publishPerMin' },
  pickup: {
    key: 'pickupP50Ms',
    label: 'pick-up p50',
    failure: 'publishFailureFrac',
    completions: 'publishPerMin',
    companions: PICKUP_COMPANIONS,
  },
  pickupFree: {
    key: 'pickupFreeP50Ms',
    label: 'worker-free pick-up p50',
    failure: 'publishFailureFrac',
    completions: 'publishPerMin',
    samples: 'pickupFreeN',
    companions: PICKUP_COMPANIONS,
  },
};
export const familyOf = (name = 'share') => {
  if (!Object.hasOwn(FAMILIES, name)) throw new Error(`unknown metric ${name} (${Object.keys(FAMILIES).join(', ')})`);
  return FAMILIES[name];
};

/**
 * The pairs that can be judged on a family: a valid pair whose runs lack the family's number (or, for the worker-free
 * pick-up, hold fewer than minSamples qualifying jobs) stops being valid and says why, so the rule is incomplete. A
 * pair that was not valid already is returned as it is.
 */
export function withMetric(pairs, name = 'share', { minSamples = 0 } = {}) {
  const f = familyOf(name);
  const problem = (r) => {
    if (!Number.isFinite(r[f.key])) return `no ${f.label}`;
    if (f.samples && !(r[f.samples] >= minSamples)) return `${r[f.samples] ?? 0} qualifying jobs, ${minSamples} needed`;
    return null;
  };
  return pairs.map((p) => {
    if (!p.valid) return p;
    const why = [
      ['a', problem(p.a)],
      ['b', problem(p.b)],
    ]
      .filter(([, w]) => w)
      .map(([side, w]) => `${side}: ${w}`);
    return why.length
      ? { ...p, valid: false, reasons: [...(p.reasons ?? []), `${f.label} unusable (${why.join('; ')})`] }
      : p;
  });
}

const labelled = (name, text) =>
  name === 'share' ? text.replace('{m}', 'P95') : text.replace('{m}', familyOf(name).label);

export const halve = (pairs, { missing = [], family = 'share', minSamples } = {}) =>
  ratioRule({
    pairs: withMetric(pairs, family, { minSamples }),
    missing,
    metric: familyOf(family).key,
    limit: HALVE_MAX,
    label: labelled(family, 'halve: candidate {m} <= 0.5 x base'),
    checkKnee: family === 'share',
  });

/** The histories the flatness rule compares: arm a is the base (history 0), arm b the candidate (history 50k). */
export const FLAT_ARMS = { a: '0', b: '50k' };
const FLAT_LABEL = 'flat: history 50k P95 <= 1.25 x history 0';
const liftFlatLabel = (bRecords, key) => {
  const histories = [...new Set(bRecords.map((r) => liftHistoryOf(r.cell ?? {})))];
  const b = histories.length === 1 ? ` ${histories[0]}` : '';
  return `flat: lift history${b} ${familyOf(key).label} <= 1.25 x lift history 0`;
};

/**
 * Why two arms are not the flatness rule's empty base and seeded candidate ([] when they are). The rule drops the
 * histories from the pairing key (it pairs across histories), so without this check two arms of the same history, or
 * the two arms swapped, would pair up and be judged: a reversed pair yields a ratio far under the limit and a
 * self-comparison a ratio of 1, both a PASS that says nothing about history. Arm a is EMPTY in both streams (share
 * history 0 and lift history 0: "its empty-history value", G2); arm b is the share P95's history 50k (AC5), whatever
 * lift history comes with it, or, for the publisher variant (AC5: "publisher flatness: same rule"), ONE non-zero lift
 * history (10k in G2's seeded cell), whatever share history comes with it.
 */
export function flatArmProblems(aRecords, bRecords, family = 'share') {
  const problems = [];
  const histories = (records, of) => [...new Set(records.map((r) => of(r.cell ?? {})))];
  const emptyA = (of, what) => {
    const found = histories(aRecords, of).filter((h) => h !== '0');
    if (found.length) problems.push(`--a must hold ${what} 0 runs only (found ${what} ${found.join(', ')})`);
  };
  if (family === 'share') {
    for (const [side, records] of [
      ['a', aRecords],
      ['b', bRecords],
    ]) {
      const want = FLAT_ARMS[side];
      const found = [...new Set(records.map((r) => String(r.cell?.history)))].filter((h) => h !== want);
      if (found.length)
        problems.push(`--${side} must hold history ${want} runs only (found history ${found.join(', ')})`);
    }
    emptyA(liftHistoryOf, 'lift history');
  } else {
    emptyA(historyOf, 'history');
    emptyA(liftHistoryOf, 'lift history');
    const foundB = histories(bRecords, liftHistoryOf);
    if (foundB.includes('0') || foundB.length > 1) {
      problems.push(`--b must hold runs of ONE non-zero lift history (found ${foundB.join(', ') || 'none'})`);
    }
  }
  return problems;
}

/**
 * AC5: history 50k P95 <= 1.25 x history 0. Arm a must be history 0 and arm b history 50k, whatever the pairs: a
 * mismatch is incomplete (never a pass) and says which arm is wrong. `aRecords` / `bRecords` default to the runs of the
 * pairs; pass the whole arms to also check the runs that did not pair. `missing` is pairRuns' unpaired runs.
 */
export function flat(
  pairs,
  { aRecords = pairs.map((p) => p.a), bRecords = pairs.map((p) => p.b), missing = [], family = 'share' } = {},
) {
  if (family !== 'share' && family !== 'publish') throw new Error(`the flatness rule judges a P95, not ${family}`);
  const problems = flatArmProblems(aRecords, bRecords, family);
  const metric = familyOf(family).key;
  const label = family === 'share' ? FLAT_LABEL : liftFlatLabel(bRecords, family);
  if (!problems.length) {
    return ratioRule({ pairs: withMetric(pairs, family), missing, metric, limit: FLAT_MAX, label });
  }
  return {
    label,
    metric,
    limit: FLAT_MAX,
    need: PAIRED_MIN,
    have: 0,
    cells: {},
    perRepeat: [],
    status: 'incomplete',
    reason:
      family === 'share'
        ? `the flatness rule compares history ${FLAT_ARMS.a} (--a) with history ${FLAT_ARMS.b} (--b): ${problems.join('; ')}`
        : `the publisher flatness rule compares lift history 0 (--a) with one lift history (--b): ${problems.join('; ')}`,
  };
}

/**
 * The relative deviation of an A/A pair's values of one metric (a P95, or a pick-up p50): |b - a| / min(a, b), the same
 * as the ratio's distance from 1 in the direction away from it. Identical values deviate by 0, zeros included (0 vs 0
 * is the ratio 1 of p95Ratio); a zero against a nonzero value deviates without bound (Infinity), never NaN.
 */
const p95Deviation = (a, b) => (a === b ? 0 : Math.abs(b - a) / Math.min(a, b));

/**
 * A/A: pairs of two same-build runs (a = first, b = second); the margin is the worst deviation of the family's metric
 * (the share P95 by default; the publish P95, the pick-up p50 or the worker-free pick-up p50 with `family`, and
 * `minSamples` for the last), never below the 10 % floor. It is rounded UP to 4 decimals, never to nearest:
 * equivalent() compares the unrounded ratios, so a margin a hair under the worst deviation would fail the very A/A
 * pairs that set it. A pair of two zero values deviates by 0 (the floor holds); a pair with one zero value deviates
 * without bound, so the margin is Infinity: no usable margin (aaDeclaration reports that as incomplete, equivalent()
 * refuses it). Every family decides its zeros the same way.
 */
export function noiseMargin(aaPairs, family = 'share', { minSamples } = {}) {
  const key = familyOf(family).key;
  const valid = withMetric(aaPairs, family, { minSamples }).filter((p) => p.valid);
  const worst = Math.max(NOISE_FLOOR, ...valid.map((p) => p95Deviation(p.a[key], p.b[key])));
  if (!Number.isFinite(worst)) return worst;
  // also covers equivalent()'s own comparison, whose floats can sit an ulp off the deviation computed above
  const covers = (m) =>
    valid.every((p) => {
      const ratio = p95Ratio(p.a[key], p.b[key]);
      return ratio <= 1 + m && ratio >= 1 / (1 + m);
    });
  let n = Math.round(worst * 1e4);
  while (n / 1e4 < worst || !covers(n / 1e4)) n++;
  return n / 1e4;
}

/**
 * The build a run measured, as its summary records it: the commit (meta.git.sha) and whether the working tree was dirty
 * (meta.git.dirty). That is the strongest identity a summary carries: scriptSha256 hashes the benchmark's own files,
 * not the product, and distStaleSuspected is only a warning. A clean run and a dirty run of one commit are two builds,
 * so the dirty flag is part of the identity. Two dirty runs of one commit cannot be told apart by what is recorded
 * (the edits are not fingerprinted); they count as one build and integrityWarnings still reports the dirty tree.
 * null when the commit or the flag is not recorded (git unavailable when the run started, or a summary that predates
 * it): an unknown build, which is not the same build.
 */
function buildIdentity(record) {
  const { sha, dirty } = record?.git ?? {};
  if (typeof sha !== 'string' || sha === '' || typeof dirty !== 'boolean') return null;
  return { sha, dirty, id: `${sha}${dirty ? '+dirty' : ''}`, short: `${sha.slice(0, 9)}${dirty ? '+dirty' : ''}` };
}

/**
 * Why the runs of two A/A arms are not known to be one build ([] when they are): an A/A margin is the noise of ONE
 * build run twice, and the pairing checks (comparability) allow different product revisions, because the A/B rules
 * compare two on purpose. So here every run of both arms, a discarded or unpaired one included, must record its build
 * identity (buildIdentity) and all of them the same one. A difference names the revisions of each arm. A missing
 * identity is a problem too: the same build needs positive evidence, an unknown build is not assumed to be the same.
 */
function aaBuildProblems(aRecords, bRecords) {
  const arms = [
    ['a', aRecords],
    ['b', bRecords],
  ];
  const unrecorded = [];
  const builds = new Map();
  const perArm = { a: new Set(), b: new Set() };
  for (const [side, records] of arms) {
    for (const r of records) {
      const build = buildIdentity(r);
      if (!build) {
        unrecorded.push(`${side}:${r.runId ?? r.key ?? '?'}`);
        continue;
      }
      builds.set(build.id, build);
      perArm[side].add(build.id);
    }
  }
  const problems = [];
  if (builds.size > 1) {
    const names = (side) => [...perArm[side]].map((id) => builds.get(id).short).join(', ') || 'none';
    problems.push(
      `the runs come from different builds (--a: ${names('a')}; --b: ${names('b')}): an A/A margin is the noise of ` +
        'one build run twice, a difference between revisions is not noise',
    );
  }
  if (unrecorded.length) {
    const shown = unrecorded.slice(0, 5).join(', ');
    problems.push(
      `no build identity (git sha and dirty flag) is recorded for ${unrecorded.length} run(s) (${shown}` +
        `${unrecorded.length > 5 ? ', ...' : ''}): an A/A margin needs evidence that every run is the same build`,
    );
  }
  return problems;
}

/**
 * The A/A declaration of two same-build arms' pairs: the noise margin, and whether it may be declared. Complete only
 * with PAIRED_MIN valid paired repeats in every cell (repeatsPerCell), a finite margin AND one build in both arms
 * (aaBuildProblems); any lack is incomplete with the reason stated, never a success. margin is null whenever it cannot
 * be declared: not finite (an unbounded A/A deviation: a zero P95 against a nonzero one) or computed across builds or
 * unknown ones, so it cannot be mistaken for a number to declare. `family` (and `minSamples`) is the metric the margin
 * is for (the share P95 by default), and a pair that lacks it is no valid repeat (withMetric); a zero value against a
 * nonzero one is unbounded in every family. `aRecords` / `bRecords` default to the runs of the pairs; pass the whole
 * arms to also check the runs that did not pair (as `flat` does). `missing` is pairRuns' unpaired runs.
 */
export function aaDeclaration(
  pairs,
  missing = [],
  { family = 'share', minSamples, aRecords = pairs.map((p) => p.a), bRecords = pairs.map((p) => p.b) } = {},
) {
  const { have, cells } = repeatsPerCell(withMetric(pairs, family, { minSamples }), missing);
  const margin = noiseMargin(pairs, family, { minSamples });
  const build = aaBuildProblems(aRecords, bRecords);
  const reasons = [...build];
  if (have < PAIRED_MIN)
    reasons.push(`needs ${PAIRED_MIN} valid paired repeats in every cell, the thinnest has ${have}`);
  if (!Number.isFinite(margin)) {
    const { label } = familyOf(family);
    reasons.push(
      `the noise margin is unbounded: an A/A pair has a ${label} of 0 against a nonzero ${label}, so no margin can be declared`,
    );
  }
  return {
    margin: Number.isFinite(margin) && !build.length ? margin : null,
    validPairs: have,
    cells,
    status: reasons.length ? 'incomplete' : 'complete',
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}
/**
 * AC2 path-off equivalence: every b/a inside [1/(1+m), 1+m]. The margin is required so it is declared before the A/B.
 */
export function equivalent(pairs, margin, { missing = [], family = 'share', minSamples } = {}) {
  if (!Number.isFinite(margin) || margin < 0)
    throw new Error('equivalent needs the declared margin (from the A/A pair)');
  return ratioRule({
    pairs: withMetric(pairs, family, { minSamples }),
    missing,
    metric: familyOf(family).key,
    limit: 1 + margin,
    lower: 1 / (1 + margin),
    label: labelled(family, `equal: candidate {m} within +-${margin} of base`),
  });
}
/**
 * A guardrail (G2's publish submission P95: "not worse than B0 by more than the A/A margin"): every b/a at most 1 + the
 * declared margin. Faster is fine, which is what separates it from the two-sided `equivalent`.
 */
export function noWorse(pairs, margin, { missing = [], family = 'share', minSamples } = {}) {
  if (!Number.isFinite(margin) || margin < 0) throw new Error('noWorse needs the declared margin (from the A/A pair)');
  return ratioRule({
    pairs: withMetric(pairs, family, { minSamples }),
    missing,
    metric: familyOf(family).key,
    limit: 1 + margin,
    label: labelled(family, `noworse: candidate {m} <= (1 + ${margin}) x base`),
  });
}
/**
 * The companions of a family's value for every valid pair, base (a) against candidate (b):
 * [{ key, <field>: { a, b } }], a field a run does not have as null. [] for a family without companions (the share and
 * publish P95s). Reported next to the result, never judged (PICKUP_COMPANIONS).
 */
export function companionsOf(pairs, family = 'share') {
  const companions = familyOf(family).companions ?? [];
  if (!companions.length) return [];
  return pairs
    .filter((p) => p.valid)
    .map((p) => ({
      key: p.key,
      ...Object.fromEntries(companions.map(({ key }) => [key, { a: p.a[key] ?? null, b: p.b[key] ?? null }])),
    }));
}

/** companionsOf as the lines a verdict prints under its result (none when there are none). */
export function companionLines(rows, family = 'share') {
  const companions = familyOf(family).companions ?? [];
  if (!rows.length) return [];
  const shown = (v) => (v === null || v === undefined ? 'n/a' : v);
  const change = (row, c) => `${c.label} ${shown(row[c.key].a)} -> ${shown(row[c.key].b)}`;
  return [
    `reported next to the ${familyOf(family).label}, no threshold (D-16):`,
    ...rows.map((row) => `  ${row.key}  ${companions.map((c) => change(row, c)).join('; ')}`),
  ];
}

/**
 * Reported, not gating (G0 rule R28 and the G2 table): candidate failure fraction <= 2 % per repeat, completions/min >=
 * 0.9 x base.
 */
export function guards(pairs, family = 'share') {
  const { failure, completions } = familyOf(family);
  const valid = pairs.filter((p) => p.valid);
  return {
    failureFrac: valid.map((p) => ({ key: p.key, value: p.b[failure], ok: p.b[failure] <= 0.02 })),
    completions: valid.map((p) => {
      const ratio = p.a[completions] ? r4(p.b[completions] / p.a[completions]) : null;
      return { key: p.key, ratio, ok: ratio === null || ratio >= 0.9 };
    }),
  };
}

// ---------------------------------------------------------------- validity and the run record
/** The most claimed jobs that may end in `failed` before the run is no publication lifecycle (G0 rule R28's 2 %). */
export const MAX_FAILED_JOB_FRACTION = 0.02;

/**
 * The publisher stream's checks (queue lift or both). `p` = { measured (publish requests in the measure window), mu,
 * successWithoutJob, doubleAdmissions, errors (runner errors), stopTimedOut, reclaimed (jobs the record shows retried or
 * recovered), claimed, finalized, failed (jobs the record shows terminally failed), wallets (the runner's workers, one
 * job each), executions, tailOps (the synthetic handler's counts) }; a missing field fails its check.
 * The handler never fails, so a retried or recovered job is a run defect (the record keeps the last claim only, which
 * would no longer be the first), and a terminal failure is a business failure the runner's exceptions do not show: the
 * runner survives a job that fails, so `publisherQuiet` alone would pass a run in which every claimed job failed. The
 * lifecycle checks therefore need evidence that publications finished: some job finalized, no more than
 * MAX_FAILED_JOB_FRACTION of the claimed jobs failed, and no more than one job per wallet left neither finalized nor
 * failed (a job the shutdown cut short). The body check ties the handler's work to the jobs the publisher finished and
 * cannot hold on nothing: the handler ran, no more executions than claims, at least the 16 tail operations of every
 * finished job and no more than its executions issued.
 */
function publisherChecks(p, measureMs) {
  const expected = (p.mu * measureMs) / 1000;
  return {
    publishMeasurementObserved: p.measured > 0,
    publishArrivalsWithin4Sigma: Math.abs(p.measured - expected) <= 4 * Math.sqrt(Math.max(expected, 1)),
    publishNoSuccessWithoutJob: p.successWithoutJob === 0,
    publishNoDoubleAdmission: p.doubleAdmissions === 0,
    publisherQuiet: p.errors === 0,
    publisherStopped: p.stopTimedOut === false,
    publisherNoReclaims: p.reclaimed === 0,
    publisherClaimed: p.claimed > 0,
    publisherFinalized: p.finalized > 0,
    publisherJobsNotFailed: Number.isFinite(p.failed) && p.failed <= MAX_FAILED_JOB_FRACTION * p.claimed,
    publisherJobsSettled: Number.isFinite(p.failed) && p.claimed - p.finalized - p.failed <= p.wallets,
    publisherBodyReplayed:
      p.executions > 0 &&
      p.tailOps > 0 &&
      p.executions <= p.claimed &&
      p.tailOps >= LIFT_TAIL_OPS * p.finalized &&
      p.tailOps <= LIFT_TAIL_OPS * p.executions,
  };
}

/**
 * Pure checks of one run; every key but `ok` is a boolean that must hold. `worker` = { agentErrors, crashes,
 * failedTerminal, succeeded, attempted, dataOps }: the fake agent and the supervisor must have worked, or a faster
 * admission could be nothing but a worker that no longer runs the 43-operation share body (a missing field fails the
 * check). `admissionsPending` = the queue's admission writes still running when reconciliation read the ground truth
 * (workload.mjs reconcileAdmissions): 0 when every one had settled, null when that could not be established; anything
 * but 0 (a missing field included) leaves the reconciliation unresolved and the run invalid.
 * P2b: `queue` is the run's stream(s): 'share' (default; the idle publisher runs beside it), 'lift' or 'both'. A lift
 * run has no share stream, so the share checks are left out; `publisher` (see publisherChecks) adds the publisher
 * stream's; `load` = { probes, ack, statusProbes, metricsProbes, probesUnfinished, acksStarted, acksUnfinished }
 * (probes.mjs loadEvidence) requires the probe and ACK load that was switched on to have run (probesRan, acksRan): the
 * counts are probes and ACKs STARTED in the measure window whatever their result, so a probe that got no answer still
 * ran (the answers are reported in summary.probes.noAnswer, not checked here). `probesUnfinished` = the metrics probes
 * and `acksUnfinished` the ACKs the end-of-run drain left running, whatever window they started in
 * (summary.probes.metricsUnfinished, summary.ack.acksUnfinished): their latency is only a lower bound, censored at the
 * drain, so a run with any has incomplete evidence (probesFinished, acksFinished; a missing count fails it).
 * `liftSeedFileVerified` is the lift seed file's hash check. Without these the result is the P2a one.
 */
export function validity({
  lambda,
  measureMs,
  measured,
  stillInflight,
  admissionsPending,
  reconcileError,
  successWithoutJob,
  doubleAdmissions,
  driverCpu,
  idlePublisherErrors,
  worker,
  seedFileVerified,
  queue = 'share',
  publisher = null,
  load = null,
  liftSeedFileVerified,
}) {
  const expected = (lambda * measureMs) / 1000;
  const w = worker ?? {};
  const withShare = queue !== 'lift';
  const checks = {
    // a window so short that its expected arrivals fit the 4-sigma band of zero (--measure 0.1) can pass the check
    // below with no request at all: the run then has nothing to compare
    ...(withShare
      ? {
          measurementObserved: measured > 0,
          arrivalsWithin4Sigma: Math.abs(measured - expected) <= 4 * Math.sqrt(Math.max(expected, 1)),
        }
      : {}),
    drained: stillInflight === 0,
    ...(withShare ? { admissionsSettled: admissionsPending === 0 } : {}),
    noReconcileError: !reconcileError,
    ...(withShare ? { noSuccessWithoutJob: successWithoutJob === 0, noDoubleAdmission: doubleAdmissions === 0 } : {}),
    driverHeadroomOk: driverCpu < 0.8,
    ...(queue === 'share' ? { idlePublisherQuiet: idlePublisherErrors === 0 } : {}),
    ...(withShare
      ? {
          workerContractOk: w.agentErrors === 0 && w.crashes === 0 && w.failedTerminal === 0 && w.succeeded > 0,
          dataPlaneReplayed:
            w.dataOps >= DATA_OPS_PER_SHARE * w.succeeded && w.dataOps <= DATA_OPS_PER_SHARE * w.attempted,
        }
      : {}),
    seedFileVerified: seedFileVerified === true,
    ...(liftSeedFileVerified === undefined ? {} : { liftSeedFileVerified: liftSeedFileVerified === true }),
    // a run with a publisher stream and no evidence from it is no run
    ...(publisher ? publisherChecks(publisher, measureMs) : queue === 'share' ? {} : { publisherEvidence: false }),
    ...(load?.probes
      ? {
          probesRan: load.statusProbes > 0 && load.metricsProbes > 0,
          probesFinished: load.probesUnfinished === 0,
        }
      : {}),
    ...(load?.ack ? { acksRan: load.acksStarted > 0, acksFinished: load.acksUnfinished === 0 } : {}),
  };
  return {
    arrivalsMeasured: measured,
    arrivalsExpected: r2(expected),
    ...(publisher
      ? { publishArrivalsMeasured: publisher.measured, publishArrivalsExpected: r2((publisher.mu * measureMs) / 1000) }
      : {}),
    ...checks,
    ok: Object.values(checks).every(Boolean),
  };
}

/**
 * summary.json -> the record the rules and the ledger read. A summary from before P2b (no queue in its cell, no publish,
 * probe or ack block) maps to exactly the P2a record; a P2b summary adds the publisher stream's numbers, the load's and
 * the settings a pair must share.
 */
export function extractRecord(s) {
  const { cell } = s.meta;
  const v = s.validity;
  const queue = cell.queue ?? 'share';
  const counters = s.worker?.counters ?? {};
  const seed = s.meta.seedFile;
  const p95Ms = s.submission.latencyMs?.p95 ?? null;
  const failureFrac = s.submission.F;
  const pub = s.publish ?? null;
  const publishP95Ms = pub?.latencyMs?.p95 ?? null;
  const publishFailureFrac = pub?.F ?? null;
  const pickupP50Ms = pub?.pickup?.p50 ?? null;
  // a run counts toward a verdict only with the metrics the rules compare: a run with no request in the measure window
  // (its worker checks can still hold on warmup completions) has none, and null / null is NaN, a FAIL, not "no data".
  // A lift run has no share stream; a run with a publisher stream also needs its P95, failures and pick-up.
  const shareOk = queue === 'lift' || (Number.isFinite(p95Ms) && Number.isFinite(failureFrac));
  const publishOk =
    queue === 'share' ||
    (Number.isFinite(publishP95Ms) && Number.isFinite(publishFailureFrac) && Number.isFinite(pickupP50Ms));
  const extended = cell.queue !== undefined || pub !== null || s.probes !== undefined || s.ack !== undefined;
  const liftSeed = s.meta.liftSeedFile;
  return {
    key: pairKey({ cell }),
    label: s.meta.label ?? null,
    cell,
    repeat: cell.repeat,
    valid: v.ok === true && shareOk && publishOk,
    failedChecks: [
      ...Object.keys(v).filter((k) => v[k] === false),
      ...(shareOk ? [] : ['finiteMetrics']),
      ...(publishOk ? [] : ['finitePublishMetrics']),
    ],
    p95Ms,
    failureFrac,
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
      seed: cell.seed ?? null,
      observerMs: cell.observerMs ?? null,
      cpus: s.meta.host?.cpus ?? null,
      platform: s.meta.host?.platform ?? null,
      cpuModel: s.meta.host?.model ?? null,
      hostId: s.meta.host?.hostId ?? null,
      ...(extended
        ? {
            mu: cell.mu ?? null,
            loadFactors: cell.loadFactors ?? null,
            liftModel: cell.liftModel ?? null,
            liftSeedFileSha256: liftSeed ? (liftSeed.loadedSha256 ?? liftSeed.sha256 ?? null) : null,
          }
        : {}),
    },
    windowsDifferFromCalibration: Boolean(s.meta.calibration?.windowsDiffer),
    git: s.meta.git,
    scriptSha256: s.meta.scriptSha256,
    distStaleSuspected: Boolean(s.meta.distStaleSuspected),
    runId: s.meta.runId,
    ...(extended
      ? {
          queue,
          factorsDifferFromCalibration: Boolean(s.meta.calibration?.factorsDiffer),
          publishP95Ms,
          publishFailureFrac,
          publishPerMin: pub?.completionsPerMin ?? null,
          pickupP50Ms,
          pickupN: pub?.pickup?.nAccepted ?? null,
          pickupCensored: pub?.pickup?.nCensored ?? null,
          pickupFreeP50Ms: pub?.workerFree?.p50 ?? null,
          pickupFreeN: pub?.workerFree?.nQualifying ?? null,
          claimToFinishP50Ms: pub?.claimToFinishMs?.p50 ?? null,
          unclaimedMax: pub?.unclaimed?.max ?? null,
          probeP95Ms: s.probes?.latencyMs?.p95 ?? null,
          probeNoAnswer: s.probes?.noAnswer ?? null,
          ackOpP95Ms: s.ack?.opMs?.p95 ?? null,
          readerFailFrac: s.readers?.failFrac ?? null,
        }
      : {}),
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
  const unconfirmed = pairs.filter((p) => p.unverified?.length);
  if (unconfirmed.length) {
    const fields = HOST_IDENTITY.filter((k) => unconfirmed.some((p) => p.unverified.includes(k)));
    warnings.push(
      `host identity (${fields.join(', ')}) is missing from a run of ${unconfirmed.map((p) => p.key).join(', ')}: ` +
        'those pairs cannot be confirmed to come from one machine (summaries from before it was recorded; the runbook ' +
        'requires the same physical host)',
    );
  }
  const envPairs = pairs.filter((p) => p.envDiffers).map((p) => p.key);
  if (envPairs.length) {
    warnings.push(
      `the DKG_STORE_* env differs between the arms in ${envPairs.join(', ')} (expected only for the knob under test)`,
    );
  }
  for (const r of records.filter((x) => x.p8c?.trigger)) {
    const why = [
      r.p8c.ratio !== null && r.p8c.ratio > 2 ? `claimNext P95 ratio ${r.p8c.ratio}` : null,
      r.p8c.backlogTrip
        ? `active backlog above 5,000${Number.isFinite(r.p8c.backlogMax) ? ` (run maximum ${r.p8c.backlogMax})` : ''}`
        : null,
    ];
    warnings.push(`run ${r.runId}: P8c trigger (${why.filter(Boolean).join(', ')}): record it in the PR`);
  }
  const offCalibration = records.filter((r) => r.windowsDifferFromCalibration).map((r) => r.runId);
  if (offCalibration.length)
    warnings.push(`runs with windows other than their calibration's: ${offCalibration.join(', ')}`);
  const offFactors = records.filter((r) => r.factorsDifferFromCalibration).map((r) => r.runId);
  if (offFactors.length)
    warnings.push(`runs with a probe or ACK load other than their calibration's: ${offFactors.join(', ')}`);
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
  // the publisher stream's and the load's columns come after the P2a ones, and only when a run has them
  const extended = records.some((r) => r.queue !== undefined);
  const extra = (r) =>
    extended
      ? [
          r.queue ?? '',
          r.cell.liftHistory ?? '',
          r.publishP95Ms ?? '',
          r.pickupP50Ms ?? '',
          r.pickupFreeP50Ms === null || r.pickupFreeP50Ms === undefined
            ? ''
            : `${r.pickupFreeP50Ms} (n ${r.pickupFreeN})`,
          // D-16: next to the pick-up, always
          ...PICKUP_COMPANIONS.map((c) => r[c.key] ?? ''),
          r.probeP95Ms === null || r.probeP95Ms === undefined ? '' : `${r.probeP95Ms} / ${r.probeNoAnswer}`,
          r.ackOpP95Ms ?? '',
        ]
      : [];
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
      ...extra(r),
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
    ...(extended
      ? [
          'queue',
          'lift history',
          'publish P95 ms',
          'pick-up p50 ms',
          'worker-free p50 ms',
          ...PICKUP_COMPANIONS.map((c) => c.label),
          'probe P95 / no-answer',
          'ACK op P95 ms',
        ]
      : []),
  ];
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...records.map(row)].join('\n');
}
