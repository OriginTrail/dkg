// The weekly CI health report's arithmetic: pure functions over ci.yml runs
// and their jobs, shaped as the Actions REST API returns them, so the tests can
// drive them with fixtures. scripts/ci/ci-health-report.mjs reads the API and
// publishes the result; the canary alert (canary-alert.mjs) shares the
// root-failure rule.

export const CI_GATE_JOB = 'CI gate';
export const PROFILE_JOB = 'Verify execution profile';
export const COVERAGE_JOB = 'Verify merged package coverage';
export const CANARY_ALERT_JOB = 'Alert on red testnet-canary CI';
export const CANARY_BRANCH = 'testnet-canary';
// The aggregate jobs repeat a lane's verdict; the alert only reports one.
const AGGREGATE_JOBS = new Set([CI_GATE_JOB, PROFILE_JOB]);
const NOT_LANES = new Set([CI_GATE_JOB, PROFILE_JOB, CANARY_ALERT_JOB]);
// nightly-ci.yml dispatches the nightly with the workflow token.
const NIGHTLY_ACTOR = 'github-actions[bot]';
const FAILED = new Set(['failure', 'timed_out']);
const MINUTE = 60_000;
const DAY = 86_400_000;
// A shard whose p50 is this far above the median shard's means the timing
// table the split is planned from needs refreshing.
export const SHARD_SPREAD_WARNING = 1.25;

const time = (value) => Date.parse(value);
const ratio = (part, whole) => (whole > 0 ? part / whole : undefined);

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = key(item);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return groups;
}

// Linear interpolation between the closest ranks (numpy's default); undefined
// for no values.
export function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  return sorted[low] + (sorted[Math.ceil(rank)] - sorted[low]) * (rank - low);
}
const median = (values) => percentile(values, 50);

// The stream a ci.yml run belongs to. The nightly is the run nightly-ci.yml
// dispatches on testnet-canary; other dispatches are manual.
export function runKind(run) {
  switch (run.event) {
    case 'pull_request':
      return 'pr';
    case 'merge_group':
      return 'queue';
    case 'push':
      return run.head_branch === CANARY_BRANCH ? 'canary-push' : 'push';
    case 'workflow_dispatch':
      return run.head_branch === CANARY_BRANCH
        && [run.actor?.login, run.triggering_actor?.login].includes(NIGHTLY_ACTOR) ? 'nightly' : 'dispatch';
    default:
      return 'other';
  }
}

export const RUN_KINDS = Object.freeze([
  ['pr', 'Pull requests'],
  ['queue', 'Merge queue'],
  ['canary-push', 'testnet-canary pushes'],
  ['nightly', 'Nightly (testnet-canary)'],
  ['push', 'Other pushes'],
  ['dispatch', 'Manual dispatches'],
  ['other', 'Other events'],
]);
const SHORT_KINDS = new Map([['pr', 'PR'], ['queue', 'queue'], ['canary-push', 'canary'], ['nightly', 'nightly'], ['push', 'push'], ['dispatch', 'dispatch'], ['other', 'other']]);

// ci.yml names a dispatch's run after the profile it was dispatched with.
const DISPATCH_RUN_NAME = /^CI \((standard|nightly-equivalent)\)$/;

// The execution profile in a run's concurrency group: a dispatch's own, as its
// run name records it. A dispatch from before ci.yml recorded it falls back to
// its stream: the nightly's runs are nightly-equivalent, manual ones standard.
export function runProfile(run) {
  if (run.event !== 'workflow_dispatch') return 'standard';
  return DISPATCH_RUN_NAME.exec(run.display_title ?? '')?.[1] ?? (runKind(run) === 'nightly' ? 'nightly-equivalent' : 'standard');
}

// ci.yml's concurrency group (ci-CI-<PR number or ref>-<profile>): a run
// entering the group cancels an older one still in progress. A pull request is
// keyed by its head branch, since the run of a merged PR no longer lists its
// number.
export function concurrencyGroup(run) {
  const kind = runKind(run);
  if (kind === 'pr') return `pr ${run.head_repository?.full_name ?? ''} ${run.head_branch}`;
  if (kind === 'queue') return `queue ${run.head_branch}`;
  return `ref ${run.head_branch} ${runProfile(run)}`;
}

// Whether `other` entered `run`'s concurrency group in [start, end]: when it
// was created, if after `run`, or when its latest re-run started
// (run_started_at, which a re-run resets). A re-run keeps its creation time,
// so a retry of an older run cancels a newer one too. Earlier re-runs are not
// on the run.
function enteredDuring(other, run, { start, end }) {
  const created = time(other.created_at);
  const retried = other.run_attempt > 1 ? time(other.run_started_at) : NaN;
  return (created > time(run.created_at) && created >= start && created <= end) || (retried >= start && retried <= end);
}

// When a run's latest attempt executed: from the first start to the last
// completion of its own jobs, leaving out skipped ones and the copies a re-run
// carries over from an earlier attempt (they keep that attempt's times), and
// from no later than the attempt's start (run_started_at, which a re-run
// resets). With no job times, from that start to the run's last update.
export function attemptWindow(run, jobs = []) {
  const attempts = [...jobsByAttempt(jobs).values()];
  const key = (job) => [job.name, job.started_at, job.completed_at, job.conclusion].join('\u0000');
  const earlier = new Set(attempts.slice(0, -1).flat().map(key));
  const own = (attempts.at(-1) ?? []).filter((job) => job.conclusion !== 'skipped' && !earlier.has(key(job)) && duration(job) >= 0);
  const started = time(run.run_started_at ?? run.created_at);
  if (own.length === 0) return { start: started, end: time(run.updated_at) };
  return {
    start: Math.min(...own.map((job) => time(job.started_at)), Number.isFinite(started) ? started : Infinity),
    end: Math.max(...own.map((job) => time(job.completed_at))),
  };
}

// Each run's stream and outcome: success; failure (failed, timed out or never
// started); superseded (cancelled because another run entered its
// concurrency group while its latest attempt ran: churn, not a verdict);
// cancelled (by a job timeout, by hand or by the merge queue dropping its
// entry); pending; other (skipped, neutral, ...). `jobsByRun` narrows a
// cancelled run's latest attempt to when its jobs ran (attemptWindow).
export function classifyRuns(runs, jobsByRun = new Map()) {
  const groups = groupBy(runs, concurrencyGroup);
  return runs.map((run) => {
    let outcome = 'other';
    if (run.status !== 'completed') outcome = 'pending';
    else if (run.conclusion === 'success') outcome = 'success';
    else if (['failure', 'timed_out', 'startup_failure'].includes(run.conclusion)) outcome = 'failure';
    else if (run.conclusion === 'cancelled') {
      const window = attemptWindow(run, jobsByRun.get(run.id));
      const superseded = groups.get(concurrencyGroup(run)).some((other) => other.id !== run.id && enteredDuring(other, run, window));
      outcome = superseded ? 'superseded' : 'cancelled';
    }
    return { run, kind: runKind(run), outcome };
  });
}

const duration = (job) => time(job.completed_at) - time(job.started_at);

// A job's lane: its name without the shard ("[2/7]") or the matrix values
// GitHub appends to a matrix job whose name does not use them
// ("(0, query, 0, 1, query, false)").
export function laneOf(name) {
  const shard = /\s\[(\d+)\/(\d+)\]/.exec(name);
  const lane = name.replace(/\s\[\d+\/\d+\]/, '').replace(/\s\([^()]*,[^()]*\)$/, '').trim();
  return shard ? { lane, shard: Number(shard[1]), shards: Number(shard[2]) } : { lane };
}

// A run's jobs by attempt, in order. A re-run attempt lists every job: the
// ones it did not re-run are copies with new ids and the earlier attempt's
// timestamps and result.
export function jobsByAttempt(jobs) {
  const attempts = groupBy(jobs, (job) => job.run_attempt ?? 1);
  return new Map([...attempts].sort(([a], [b]) => a - b));
}
const latestAttempt = (jobs) => [...jobsByAttempt(jobs).values()].at(-1) ?? [];

// The first step that failed, by step number, or else the step a cancelled job
// stopped in.
export function failedStep(job) {
  const steps = (job.steps ?? [])
    .filter((step) => ['failure', 'timed_out', 'cancelled'].includes(step.conclusion))
    .sort((a, b) => a.number - b.number);
  return (steps.find((step) => step.conclusion !== 'cancelled') ?? steps[0])?.name;
}

// What made one attempt red, most specific first: its failed test lanes, else
// its cancelled ones (a job timeout), else merged coverage, else the
// aggregates. The aggregate jobs (CI gate, Verify execution profile) only
// repeat a lane's verdict, and merged coverage fails whenever a test lane
// left no receipt, a timed-out one included, so coverage is the cause only
// when no test lane failed or was cancelled.
export function rootFailures(jobs) {
  const completed = jobs.filter((job) => job.status === 'completed' && job.name !== CANARY_ALERT_JOB);
  const failed = completed.filter((job) => FAILED.has(job.conclusion));
  const cancelled = completed.filter((job) => job.conclusion === 'cancelled' && !AGGREGATE_JOBS.has(job.name));
  const lanes = failed.filter((job) => !AGGREGATE_JOBS.has(job.name));
  const isTest = (job) => job.name !== COVERAGE_JOB;
  const roots = [lanes.filter(isTest), cancelled.filter(isTest), lanes, cancelled, failed].find((set) => set.length > 0) ?? [];
  return roots.map((job) => ({ name: job.name, ...laneOf(job.name), conclusion: job.conclusion, step: failedStep(job), job }));
}

// Root failures by lane: each lane's failed jobs (its shards) and steps.
export function failuresByLane(roots) {
  return [...groupBy(roots, (root) => root.lane)].map(([lane, jobs]) => ({
    lane,
    jobs,
    steps: [...new Set(jobs.map((root) => root.step).filter(Boolean))],
    cancelled: jobs.every((root) => root.conclusion === 'cancelled'),
  }));
}

// Successful first-attempt pull request runs, from the run's start to the CI
// gate job's completion: how long a green PR waits for its required check.
export function prTimeToGreen(classified, jobsByRun) {
  const values = [];
  for (const { run, kind, outcome } of classified) {
    if (kind !== 'pr' || outcome !== 'success' || run.run_attempt !== 1) continue;
    const gate = (jobsByRun.get(run.id) ?? []).find((job) => job.name === CI_GATE_JOB && (job.run_attempt ?? 1) === 1);
    if (gate?.conclusion !== 'success' || !gate.completed_at) continue;
    values.push(time(gate.completed_at) - time(run.run_started_at ?? run.created_at));
  }
  return { runs: values.length, p50: median(values), p90: percentile(values, 90) };
}

// Outcome counts by stream, with an `all` total. The failure rate is over
// finished verdicts (passed or failed); the cancel rate over finished runs.
export function outcomeTable(classified) {
  const empty = (kind, label) => ({ kind, label, runs: 0, success: 0, failure: 0, superseded: 0, cancelled: 0, pending: 0, other: 0 });
  const rows = new Map(RUN_KINDS.map(([kind, label]) => [kind, empty(kind, label)]));
  const all = empty('all', 'All runs');
  for (const { kind, outcome } of classified) {
    for (const row of [rows.get(kind), all]) {
      row.runs += 1;
      row[outcome] += 1;
    }
  }
  const rates = (row) => ({
    ...row,
    failureRate: ratio(row.failure, row.success + row.failure),
    cancelRate: ratio(row.superseded + row.cancelled, row.runs - row.pending),
  });
  return { rows: [...rows.values()].filter((row) => row.runs > 0).map(rates), all: rates(all) };
}

// The lanes that failed runs, most first: in how many runs each was a root
// failure, in how many it ran, from which streams, and the step it failed at
// most often. A run counts once per lane, however many attempts or shards
// failed.
export function topRootFailures(entries) {
  const lanes = new Map();
  const lane = (name) => lanes.get(name) ?? lanes.set(name, {
    lane: name, failed: 0, ran: 0, cancelled: 0, maxShards: 0, kinds: new Map(), steps: new Map(), last: undefined,
  }).get(name);
  for (const { run, kind, jobs } of entries) {
    const ran = new Set(jobs.filter((job) => job.status === 'completed' && job.conclusion !== 'skipped' && job.name !== CANARY_ALERT_JOB)
      .map((job) => laneOf(job.name).lane));
    for (const name of ran) lane(name).ran += 1;
    const failed = new Map();
    for (const attemptJobs of jobsByAttempt(jobs).values()) {
      for (const group of failuresByLane(rootFailures(attemptJobs))) {
        const seen = failed.get(group.lane) ?? { shards: 0, steps: new Set(), cancelled: true };
        seen.shards = Math.max(seen.shards, group.jobs.length);
        for (const step of group.steps) seen.steps.add(step);
        seen.cancelled &&= group.cancelled;
        failed.set(group.lane, seen);
      }
    }
    for (const [name, seen] of failed) {
      const entry = lane(name);
      entry.failed += 1;
      if (!ran.has(name)) entry.ran += 1;
      if (seen.cancelled) entry.cancelled += 1;
      entry.maxShards = Math.max(entry.maxShards, seen.shards);
      entry.kinds.set(kind, (entry.kinds.get(kind) ?? 0) + 1);
      for (const step of seen.steps) entry.steps.set(step, (entry.steps.get(step) ?? 0) + 1);
      if (!entry.last || time(run.created_at) > time(entry.last.created_at)) entry.last = run;
    }
  }
  return [...lanes.values()]
    .filter((entry) => entry.failed > 0)
    .map((entry) => {
      const [step, stepCount] = [...entry.steps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
      return { ...entry, kinds: Object.fromEntries(entry.kinds), steps: Object.fromEntries(entry.steps), step, stepCount };
    })
    .sort((a, b) => b.failed - a.failed || a.lane.localeCompare(b.lane));
}

// A nightly-equivalent run (the nightly, or a dispatch of that profile) runs
// more property trials and suites than a standard one, so it is left out of
// comparisons with standard runs.
const extended = (run) => runProfile(run) === 'nightly-equivalent';

// Jobs that failed and then passed without a code change: in a later attempt
// of the same run (passed on retry), or in another run of the same head commit.
// The second is a candidate, not proof: a pull request run tests a merge with
// its moving base, and labels can change its plan. Nightly-equivalent runs are
// left out of it.
export function flakyJobs(entries) {
  const jobs = new Map();
  const job = (name) => jobs.get(name) ?? jobs.set(name, { name, ...laneOf(name), retried: [], sameCommit: [] }).get(name);
  const failedNames = (attemptJobs) => new Set(rootFailures(attemptJobs)
    .filter((root) => root.conclusion !== 'cancelled' && !NOT_LANES.has(root.name))
    .map((root) => root.name));
  for (const { run, jobs: runJobs } of entries) {
    const firstFailure = new Map();
    for (const [attempt, attemptJobs] of jobsByAttempt(runJobs)) {
      for (const name of failedNames(attemptJobs)) if (!firstFailure.has(name)) firstFailure.set(name, attempt);
      for (const { name, conclusion } of attemptJobs) {
        if (conclusion === 'success' && firstFailure.get(name) < attempt && !job(name).retried.includes(run)) job(name).retried.push(run);
      }
    }
  }
  const byCommit = groupBy(entries.filter(({ run }) => !extended(run)), ({ run }) => run.head_sha);
  for (const [sha, commitEntries] of byCommit) {
    if (commitEntries.length < 2) continue;
    const failed = new Map();
    const passed = new Map();
    const add = (map, name, id) => map.set(name, new Set([...(map.get(name) ?? []), id]));
    for (const { run, jobs: runJobs } of commitEntries) {
      for (const attemptJobs of jobsByAttempt(runJobs).values()) for (const name of failedNames(attemptJobs)) add(failed, name, run.id);
      for (const { name, conclusion } of latestAttempt(runJobs)) if (conclusion === 'success') add(passed, name, run.id);
    }
    for (const [name, failedRuns] of failed) {
      const passedRuns = [...(passed.get(name) ?? [])];
      if ([...failedRuns].some((failedRun) => passedRuns.some((passedRun) => passedRun !== failedRun))) {
        job(name).sameCommit.push({ sha, runs: commitEntries.map((entry) => entry.run) });
      }
    }
  }
  return [...jobs.values()]
    .filter((entry) => entry.retried.length || entry.sameCommit.length)
    .sort((a, b) => b.retried.length + b.sameCommit.length - a.retried.length - a.sameCommit.length || a.name.localeCompare(b.name));
}

// Lane wall times from the latest attempt of each run (its carried-over jobs
// are real executions, counted once): a lane's time in a run is its slowest
// job, kept when every job of the lane passed. Nightly-equivalent runs are
// left out. Per sharded lane, each shard's p50 in
// the lane's latest layout (its shard count can change within a week) shows
// how even the split is: the slowest shard's p50 over the median shard's.
export function laneTimings(entries) {
  const lanes = new Map();
  const ordered = [...entries].sort((a, b) => time(a.run.created_at) - time(b.run.created_at));
  for (const { run, jobs } of ordered) {
    if (extended(run)) continue;
    const ran = latestAttempt(jobs).filter((job) => job.status === 'completed' && job.conclusion !== 'skipped' && !NOT_LANES.has(job.name));
    for (const [name, laneJobs] of groupBy(ran, (job) => laneOf(job.name).lane)) {
      if (!laneJobs.every((job) => job.conclusion === 'success' && duration(job) > 0)) continue;
      const entry = lanes.get(name) ?? lanes.set(name, { lane: name, times: [], layouts: new Map(), shardCount: 0 }).get(name);
      entry.times.push(Math.max(...laneJobs.map(duration)));
      for (const laneJob of laneJobs) {
        const { shard, shards } = laneOf(laneJob.name);
        if (shard === undefined) continue;
        entry.shardCount = shards;
        if (!entry.layouts.has(shards)) entry.layouts.set(shards, new Map());
        const layout = entry.layouts.get(shards);
        if (!layout.has(shard)) layout.set(shard, []);
        layout.get(shard).push(duration(laneJob));
      }
    }
  }
  return [...lanes.values()].map(({ lane, times, layouts, shardCount }) => {
    const shardTimes = [...(layouts.get(shardCount) ?? [])].map(([shard, values]) => ({ shard, runs: values.length, p50: median(values) })).sort((a, b) => a.shard - b.shard);
    const slowest = shardTimes.reduce((best, shard) => (!best || shard.p50 > best.p50 ? shard : best), undefined);
    const medianShard = median(shardTimes.map((shard) => shard.p50));
    return {
      lane,
      runs: times.length,
      p50: median(times),
      p90: percentile(times, 90),
      shardCount,
      shards: shardTimes,
      slowestShard: slowest?.shard,
      spread: shardTimes.length > 1 && medianShard > 0 ? slowest.p50 / medianShard : undefined,
    };
  }).sort((a, b) => b.p90 - a.p90 || a.lane.localeCompare(b.lane));
}

// The nightly runs, oldest first, with what failed each red one, and the
// dispatcher runs (nightly-ci.yml on main) that started no nightly at all.
export function nightlyResults({ classified, jobsByRun, dispatcherRuns = [] }) {
  const nightlies = classified.filter(({ kind }) => kind === 'nightly').sort((a, b) => time(a.run.created_at) - time(b.run.created_at));
  const rows = nightlies.map(({ run, outcome }) => ({
    run,
    outcome,
    minutes: outcome === 'pending' ? undefined : (time(run.updated_at) - time(run.run_started_at ?? run.created_at)) / MINUTE,
    failures: ['success', 'pending'].includes(outcome) ? [] : failuresByLane(rootFailures(latestAttempt(jobsByRun.get(run.id) ?? []))),
  }));
  const started = (dispatcher) => nightlies.some(({ run }) => time(run.created_at) >= time(dispatcher.created_at) - MINUTE
    && time(run.created_at) - time(dispatcher.created_at) <= 15 * MINUTE);
  const missed = dispatcherRuns.filter((dispatcher) => dispatcher.status === 'completed' && !started(dispatcher));
  return { rows, missed };
}

// The files the disabled-test audit (disabled-test-scanner.mjs, which loads
// TypeScript) reads exceptions from, mirrored without a dependency; a test
// keeps the two in step.
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/i;
const TEST_FILE_NAME = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIRECTORY = /(^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)/;
const VITEST_CONFIG_FILE = /(^|\/)(?:vitest(?:[.-][^/]*)?|vite\.config)\.[cm]?[jt]sx?$/i;
const EXCLUDED_TREE = /(^|\/)(?:node_modules|dist|build|out|generated|coverage|\.nyc_output|\.turbo)(?:\/|$)/;
const ARCHIVE_TREE = /(^|\/)(?:test|tests)\/archive(?:\/|$)/;

export function isTestExceptionFile(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (EXCLUDED_TREE.test(file)) return false;
  const d1 = SOURCE_EXTENSION.test(file) && !ARCHIVE_TREE.test(file) && (TEST_FILE_NAME.test(base) || TEST_DIRECTORY.test(file));
  const d2 = VITEST_CONFIG_FILE.test(file) && !TEST_FILE_NAME.test(base);
  return d1 || d2;
}

// Each `test-disable-allow:` exception in a comment of `source` that opens a
// line, a `//` line or a block comment, with its metadata. Text in a string
// (the audit's own test fixtures) does not open a line as a comment and is
// skipped. The audit also accepts a comment after code on its line; that form
// is not read here, and ci-health.test.mjs fails if a tracked file uses it.
export function parseTestExceptions(source) {
  const lines = source.split(/\r?\n/);
  const exceptions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    const first = lines[index].trimStart();
    let text;
    if (first.startsWith('//')) text = first;
    else if (first.startsWith('/*')) {
      const block = [first];
      while (!block.at(-1).includes('*/') && index + 1 < lines.length) block.push(lines[++index]);
      text = block.join('\n');
    } else continue;
    if (!text.includes('test-disable-allow:')) continue;
    exceptions.push({
      line: start + 1,
      ticket: /test-disable-allow:\s*D[12]\s+(\S+)/i.exec(text)?.[1],
      owner: /\bowner=([\w@.-]+)/.exec(text)?.[1],
      lane: /\blane=([\w:-]+)/.exec(text)?.[1],
      expires: /\bexpires=(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1],
    });
  }
  return exceptions;
}

// An exception's deadline, as the audit reads `expires=`: the end of that day
// in UTC; undefined for a missing or impossible date.
export function exceptionDeadline(expires) {
  const deadline = Date.parse(`${expires}T23:59:59Z`);
  return Number.isFinite(deadline) && new Date(deadline).toISOString().slice(0, 10) === expires ? deadline : undefined;
}

// The exceptions whose deadline has passed or comes within `days`, soonest
// first: once a deadline passes, the disabled-test audit fails every branch's
// lint at once. `next` is the first deadline after that window.
export function expiringTestExceptions(exceptions, { now, days }) {
  const dated = exceptions
    .map((exception) => ({ ...exception, deadline: exceptionDeadline(exception.expires) }))
    .filter((exception) => exception.deadline !== undefined)
    .sort((a, b) => a.deadline - b.deadline || String(a.file).localeCompare(String(b.file)) || a.line - b.line);
  const rows = dated.filter(({ deadline }) => deadline - now <= days * DAY).map((exception) => ({
    ...exception,
    expired: exception.deadline < now,
    daysLeft: Math.floor((exception.deadline - now) / DAY),
  }));
  const later = dated.filter(({ deadline }) => deadline - now > days * DAY);
  const next = later[0] && { expires: later[0].expires, count: later.filter(({ expires }) => expires === later[0].expires).length };
  return { rows, next, scanned: exceptions.length };
}

export function buildHealthReport({
  repo,
  serverUrl = 'https://github.com',
  window,
  previousWindow,
  runs,
  jobsByRun,
  unreadRuns = 0,
  dispatcherRuns = [],
  exceptions = [],
  exceptionDays = 14,
  generatedAt,
  requestCount,
}) {
  const classified = classifyRuns(runs, jobsByRun);
  const within = ({ start, end }) => classified.filter(({ run }) => time(run.created_at) >= start && time(run.created_at) < end);
  const current = within(window);
  const previous = within(previousWindow);
  const entries = current.filter(({ run }) => jobsByRun.has(run.id)).map((entry) => ({ ...entry, jobs: jobsByRun.get(entry.run.id) }));
  return {
    repo,
    serverUrl,
    window,
    previousWindow,
    generatedAt,
    requestCount,
    runs: current.length,
    runsWithJobs: entries.length,
    unreadRuns,
    timeToGreen: { current: prTimeToGreen(current, jobsByRun), previous: prTimeToGreen(previous, jobsByRun) },
    outcomes: { current: outcomeTable(current), previous: outcomeTable(previous) },
    rootFailures: topRootFailures(entries),
    flaky: flakyJobs(entries),
    lanes: laneTimings(entries),
    nightly: nightlyResults({ classified: current, jobsByRun, dispatcherRuns }),
    exceptions: { days: exceptionDays, ...expiringTestExceptions(exceptions, { now: generatedAt, days: exceptionDays }) },
  };
}

// Text for a markdown table cell or line from a job, step or commit title: one
// line, no table pipes or HTML, and no @-mention that would notify someone.
export function inline(text, max = 120) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const short = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return short.replace(/[|<>`]/g, (character) => ({ '|': '\\|', '<': '&lt;', '>': '&gt;', '`': "'" })[character]).replace(/@(?=\w)/g, '@​');
}

const minutes = (ms) => (ms === undefined ? 'n/a' : `${(ms / MINUTE).toFixed(1)} min`);
const percent = (value) => (value === undefined ? 'n/a' : `${Math.round(value * 100)}%`);
const signed = (ms) => (ms === undefined ? 'n/a' : `${ms >= 0 ? '+' : '-'}${(Math.abs(ms) / MINUTE).toFixed(1)} min`);
const delta = (now, before) => (now === undefined || before === undefined ? undefined : now - before);
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const day = (value) => String(value).slice(0, 10);
const runLink = (run, text = `#${run.id}`) => `[${text}](${run.html_url})`;
const kinds = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${SHORT_KINDS.get(kind) ?? kind} ${count}`).join(', ');

function table(header, rows) {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)];
}

const LIMITS = { failures: 12, flaky: 12, lanes: 15, exceptions: 30 };
const more = (rows, limit, noun) => (rows.length > limit ? [`_${rows.length - limit} more ${noun} not shown._`, ''] : []);

const reportDays = ({ start, end }) => Math.round((end - start) / DAY);
const reportTitle = ({ start, end }) => `CI health: ${day(new Date(start).toISOString())} to ${day(new Date(end).toISOString())}`;

// The report's headline figures, one bullet each.
function headline(model) {
  const { timeToGreen: ttg, outcomes, exceptions } = model;
  const row = (kind) => outcomes.current.rows.find((entry) => entry.kind === kind);
  const prior = (kind) => outcomes.previous.rows.find((entry) => entry.kind === kind);
  const canary = row('canary-push');
  const queue = row('queue');
  const nightly = model.nightly.rows;
  const top = model.rootFailures[0];
  return [
    `- **PR time to green:** p50 ${minutes(ttg.current.p50)} (${signed(delta(ttg.current.p50, ttg.previous.p50))} on the prior week), p90 ${minutes(ttg.current.p90)} (${signed(delta(ttg.current.p90, ttg.previous.p90))}), over ${ttg.current.runs} first-attempt green PR runs.`,
    `- **Failure rate:** ${percent(outcomes.current.all.failureRate)} of finished runs (prior week ${percent(outcomes.previous.all.failureRate)}); pull requests ${percent(row('pr')?.failureRate)}, merge queue ${percent(queue?.failureRate)}, testnet-canary pushes ${percent(canary?.failureRate)}.`,
    `- **Cancelled:** ${percent(row('pr')?.cancelRate)} of PR runs (prior week ${percent(prior('pr')?.cancelRate)}) and ${percent(canary?.cancelRate)} of testnet-canary pushes (prior week ${percent(prior('canary-push')?.cancelRate)}).`,
    `- **Merge queue:** ${queue?.runs ?? 0} runs, ${queue?.success ?? 0} passed, ${queue?.failure ?? 0} failed, ${queue?.cancelled ?? 0} cancelled by the queue.`,
    `- **Nightly:** ${nightly.filter(({ outcome }) => outcome === 'success').length} of ${nightly.length} green${model.nightly.missed.length ? `; ${model.nightly.missed.length} dispatch(es) started no run` : ''}.`,
    top ? `- **Top root failure:** ${inline(top.lane)}, ${top.failed} run(s)${top.step ? `, most often at \`${inline(top.step, 80)}\`` : ''}.` : '- **Top root failure:** none.',
    `- **Test exceptions:** ${exceptions.rows.filter(({ expired }) => expired).length} expired, ${exceptions.rows.filter(({ expired }) => !expired).length} expire within ${exceptions.days} days.`,
  ];
}

// The headline alone, for the weekly comment on the report issue.
export function renderHealthHeadline(model) {
  return [`**${reportTitle(model.window)}**`, '', ...headline(model)].join('\n');
}

export function renderHealthReport(model) {
  const { timeToGreen: ttg, outcomes, window: span, exceptions } = model;
  const nightly = model.nightly.rows;
  const days = reportDays(span);
  const lines = [
    `## ${reportTitle(span)}`,
    '',
    `ci.yml runs on ${model.repo} created ${stamp(span.start)} to ${stamp(span.end)} UTC (${days} days), compared with the ${days} days before.`,
    '',
    ...headline(model),
    '',
    '### Runs by stream',
    '',
    ...table(['Stream', 'Runs', 'Passed', 'Failed', 'Failure rate', 'Superseded', 'Cancelled', 'Cancel rate', 'Running'], [
      ...outcomes.current.rows,
      outcomes.current.all,
    ].map((entry) => [
      entry.kind === 'all' ? `**${entry.label}**` : entry.label,
      entry.runs,
      entry.success,
      entry.failure,
      percent(entry.failureRate),
      entry.superseded,
      entry.cancelled,
      percent(entry.cancelRate),
      entry.pending,
    ])),
    '',
    '_Failure rate: failed over finished verdicts (passed or failed). Superseded: cancelled when a newer run of the same PR or branch started. Cancelled: cancelled with no newer run (a job timeout, a manual cancel, or the merge queue dropping the entry). Cancel rate: both over finished runs._',
    '',
    '### PR time to green',
    '',
    ...table(['Week', 'Runs', 'p50', 'p90'], [
      ['This week', ttg.current.runs, minutes(ttg.current.p50), minutes(ttg.current.p90)],
      ['Prior week', ttg.previous.runs, minutes(ttg.previous.p50), minutes(ttg.previous.p90)],
      ['Change', '', signed(delta(ttg.current.p50, ttg.previous.p50)), signed(delta(ttg.current.p90, ttg.previous.p90))],
    ]),
    '',
    '_Successful first-attempt pull_request runs, from the run start to the CI gate job completing._',
    '',
    '### Root failures',
    '',
  ];
  if (model.rootFailures.length) {
    lines.push(
      ...table(['Job', 'Failed runs', 'Ran in', 'Streams', 'Failed step (runs)', 'Latest'], model.rootFailures.slice(0, LIMITS.failures).map((entry) => [
        `${inline(entry.lane)}${entry.maxShards > 1 ? ` (up to ${entry.maxShards} jobs)` : ''}`,
        `${entry.failed}${entry.cancelled ? ` (${entry.cancelled} cancelled)` : ''}`,
        entry.ran,
        kinds(entry.kinds),
        entry.step ? `${inline(entry.step, 80)} (${entry.stepCount})` : '',
        runLink(entry.last),
      ])),
      '',
      ...more(model.rootFailures, LIMITS.failures, 'jobs'),
      '_A run counts once per job, over all its attempts. The CI gate and Verify execution profile count only when no lane failed, and merged coverage only when no test lane failed with it. "Cancelled" means the job was cancelled with no failure in its run: a timeout or a manual cancel._',
      '',
    );
  } else lines.push('No failed runs.', '');
  lines.push('### Flaky jobs', '');
  if (model.flaky.length) {
    lines.push(
      ...table(['Job', 'Passed on retry', 'Passed and failed on one commit', 'Example'], model.flaky.slice(0, LIMITS.flaky).map((entry) => [
        inline(entry.name),
        entry.retried.length || '',
        entry.sameCommit.length || '',
        entry.retried[0] ? runLink(entry.retried[0]) : entry.sameCommit[0].runs.slice(0, 3).map((run) => runLink(run)).join(' '),
      ])),
      '',
      ...more(model.flaky, LIMITS.flaky, 'jobs'),
      '_Passed on retry: failed in one attempt of a run and passed in a later attempt. One commit: failed in one run and passed in another of the same head commit, a candidate only, since a PR run tests a merge with its moving base and labels can change its plan (nightly runs left out)._',
      '',
    );
  } else lines.push('No job failed and then passed without a change.', '');
  lines.push('### Slowest lanes and shard balance', '');
  if (model.lanes.length) {
    lines.push(
      ...table(['Lane', 'Runs', 'p50', 'p90', 'Shards', 'Slowest shard p50 / median'], model.lanes.slice(0, LIMITS.lanes).map((entry) => [
        inline(entry.lane),
        entry.runs,
        minutes(entry.p50),
        minutes(entry.p90),
        entry.shardCount || '',
        entry.spread === undefined ? '' : `${entry.spread.toFixed(2)}x (shard ${entry.slowestShard})${entry.spread >= SHARD_SPREAD_WARNING ? ' **uneven**' : ''}`,
      ])),
      '',
      ...more(model.lanes, LIMITS.lanes, 'lanes'),
      `_A lane's time in a run is its slowest job, from runs where every job of the lane passed (nightly runs left out). Shards and spread are for the lane's latest shard count; a spread of ${SHARD_SPREAD_WARNING}x or more means one shard carries more than its share: refresh the timing table the lane is split by._`,
      '',
    );
  } else lines.push('No lane timings.', '');
  lines.push('### Nightly', '');
  if (nightly.length || model.nightly.missed.length) {
    lines.push(...table(['Started', 'Commit', 'Result', 'Duration', 'Root failures', 'Run'], nightly.map(({ run, outcome, minutes: length, failures }) => [
      stamp(time(run.run_started_at ?? run.created_at)),
      `\`${String(run.head_sha).slice(0, 10)}\``,
      outcome,
      length === undefined ? '' : `${length.toFixed(0)} min`,
      failures.map((failure) => `${inline(failure.lane, 70)}${failure.jobs.length > 1 ? ` (${failure.jobs.length} jobs)` : ''}${failure.steps[0] ? `: ${inline(failure.steps[0], 60)}` : ''}${failure.cancelled ? ' (cancelled)' : ''}`).join('; '),
      runLink(run),
    ])));
    for (const dispatcher of model.nightly.missed) {
      lines.push(`| ${stamp(time(dispatcher.created_at))} | | dispatcher ${dispatcher.conclusion}, no CI run | | | ${runLink(dispatcher)} |`);
    }
    lines.push('');
  } else lines.push(`No nightly ran in these ${days} days.`, '');
  lines.push(`### Test exceptions expiring within ${exceptions.days} days`, '');
  if (exceptions.rows.length) {
    lines.push(
      ...table(['Expires', 'Days left', 'Where', 'Owner', 'Lane', 'Ticket'], exceptions.rows.slice(0, LIMITS.exceptions).map((exception) => [
        exception.expires,
        exception.expired ? '**expired**' : exception.daysLeft,
        `\`${inline(exception.file, 100)}:${exception.line}\``,
        inline(exception.owner ?? ''),
        inline(exception.lane ?? ''),
        inline(exception.ticket ?? ''),
      ])),
      '',
      ...more(exceptions.rows, LIMITS.exceptions, 'exceptions'),
      '_The disabled-test audit fails every branch at once when a deadline passes: confirm the lane still runs the test, then renew `expires=` (at most 31 days ahead) or restore the test._',
      '',
    );
  } else {
    lines.push(`None of the ${exceptions.scanned} \`test-disable-allow:\` exceptions expires within ${exceptions.days} days${exceptions.next ? `; the next deadline is ${exceptions.next.expires} (${exceptions.next.count} exception${exceptions.next.count === 1 ? '' : 's'})` : ''}.`, '');
  }
  lines.push(
    '---',
    `_Generated ${new Date(model.generatedAt).toISOString().slice(0, 16)}Z by scripts/ci/ci-health-report.mjs from ${model.runs} runs (jobs read for ${model.runsWithJobs}; superseded and running ones are not read${model.unreadRuns ? `; ${model.unreadRuns} could not be read` : ''})${model.requestCount === undefined ? '' : ` in ${model.requestCount} API requests`}._`,
  );
  return `${lines.join('\n')}\n`;
}
