// The weekly CI health report (ci-health.mjs, scripts/ci/ci-health-report.mjs
// and .github/workflows/ci-health-report.yml) on fixtures shaped like the
// Actions API's runs and jobs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  attemptWindow,
  buildHealthReport,
  CI_GATE_JOB,
  classifyRuns,
  COVERAGE_JOB,
  expiringTestExceptions,
  flakyJobs,
  inline,
  isTestExceptionFile,
  laneOf,
  laneTimings,
  nightlyResults,
  outcomeTable,
  parseTestExceptions,
  percentile,
  PROFILE_JOB,
  prTimeToGreen,
  renderHealthHeadline,
  renderHealthReport,
  rootFailures,
  runProfile,
  topRootFailures,
} from '../ci-health.mjs';
import { inspectTestExceptions } from '../test-exceptions.mjs';
import { isScannableFile } from '../disabled-test-scanner.mjs';
import { createGitHubClient } from '../github-rest.mjs';
import { HEALTH_MARKER, issueBody, runHealthReport, runsNeedingJobs, trackedTestExceptions } from '../../ci/ci-health-report.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';
import { importClosure } from './script-imports.mjs';

const T0 = Date.parse('2026-11-04T00:00:00Z');
const MINUTE = 60_000;
const at = (minutes) => new Date(T0 + minutes * MINUTE).toISOString().replace('.000Z', 'Z');
let ids = 1000;
function run({ id = ids++, event = 'pull_request', branch = 'feature/a', conclusion = 'success', status = 'completed', attempt = 1, created = 0, updated = created + 30, started = created, sha = 'a'.repeat(40), actor = 'dev' } = {}) {
  return {
    id, event, status, conclusion, run_attempt: attempt, head_branch: branch, head_sha: sha,
    created_at: at(created), run_started_at: at(started), updated_at: at(updated),
    html_url: `https://github.com/OriginTrail/dkg/actions/runs/${id}`,
    actor: { login: actor }, triggering_actor: { login: actor }, head_repository: { full_name: 'OriginTrail/dkg' },
  };
}
function job(name, { conclusion = 'success', attempt = 1, start = 0, minutes = 5, steps = [] } = {}) {
  return {
    name, status: 'completed', conclusion, run_attempt: attempt, started_at: at(start), completed_at: at(start + minutes),
    steps: steps.map(([step, stepConclusion], index) => ({ name: step, conclusion: stepConclusion, number: index + 1 })),
  };
}
const gate = (options) => job(CI_GATE_JOB, { minutes: 0.2, ...options });
const failedLane = (name, step, options = {}) => job(name, { conclusion: 'failure', steps: [['Set up job', 'success'], [step, 'failure'], ['Upload report', 'failure']], ...options });

test('percentiles interpolate between the closest ranks', () => {
  assert.equal(percentile([], 50), undefined);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([4, 1, 3, 2], 50), 2.5);
  assert.ok(Math.abs(percentile([1, 2, 3, 4], 90) - 3.7) < 1e-9);
});

test('a lane drops the shard and the matrix values GitHub appends, and keeps a descriptive suffix', () => {
  assert.deepEqual(laneOf('Tornado: agent [3/11]'), { lane: 'Tornado: agent', shard: 3, shards: 11 });
  assert.deepEqual(laneOf('Kosava: node-ui e2e [1/7] (Playwright real-node devnet)'), { lane: 'Kosava: node-ui e2e (Playwright real-node devnet)', shard: 1, shards: 7 });
  assert.deepEqual(laneOf('Bura: query (0, query, 0, 1, query, false)'), { lane: 'Bura: query' });
  assert.deepEqual(laneOf('inventory-windows / SQLite lifecycle (Windows, inventory)'), { lane: 'inventory-windows / SQLite lifecycle' });
  assert.deepEqual(laneOf('Compile EVM test artifacts (0.8.20/london)'), { lane: 'Compile EVM test artifacts (0.8.20/london)' });
});

test('runs are sorted into streams, and a cancellation is superseded only by a newer run of its group', () => {
  const canary = { event: 'push', branch: 'testnet-canary' };
  const runs = [
    run({ id: 1, ...canary, conclusion: 'cancelled', created: 0, updated: 20 }),
    run({ id: 2, ...canary, conclusion: 'failure', created: 10, updated: 50 }),
    // Timed out with no newer canary push while it ran: a cancellation to explain.
    run({ id: 3, ...canary, conclusion: 'cancelled', created: 100, updated: 145 }),
    // A newer nightly does not supersede a push: different concurrency groups.
    run({ id: 4, event: 'workflow_dispatch', branch: 'testnet-canary', actor: 'github-actions[bot]', conclusion: 'cancelled', created: 110, updated: 160 }),
    run({ id: 5, event: 'workflow_dispatch', branch: 'testnet-canary', actor: 'github-actions[bot]', created: 170, updated: 220 }),
    // A PR's runs share its branch; another branch is another group.
    run({ id: 6, branch: 'feature/a', conclusion: 'cancelled', created: 0, updated: 5 }),
    run({ id: 7, branch: 'feature/a', created: 3 }),
    run({ id: 8, branch: 'feature/b', conclusion: 'cancelled', created: 0, updated: 5 }),
    run({ id: 9, event: 'merge_group', branch: 'gh-readonly-queue/testnet-canary/pr-1-abc', conclusion: 'cancelled' }),
    run({ id: 10, event: 'workflow_dispatch', branch: 'feature/a', actor: 'dev' }),
    run({ id: 11, event: 'push', branch: 'main', status: 'in_progress', conclusion: null }),
    run({ id: 12, conclusion: 'startup_failure' }),
    run({ id: 13, conclusion: 'skipped' }),
  ];
  const classified = Object.fromEntries(classifyRuns(runs).map(({ run: { id }, kind, outcome }) => [id, `${kind} ${outcome}`]));
  assert.deepEqual(classified, {
    1: 'canary-push superseded',
    2: 'canary-push failure',
    3: 'canary-push cancelled',
    4: 'nightly cancelled',
    5: 'nightly success',
    6: 'pr superseded',
    7: 'pr success',
    8: 'pr cancelled',
    9: 'queue cancelled',
    10: 'dispatch success',
    11: 'push pending',
    12: 'pr failure',
    13: 'pr other',
  });
  const table = outcomeTable(classifyRuns(runs));
  const canaryRow = table.rows.find(({ kind }) => kind === 'canary-push');
  assert.deepEqual([canaryRow.runs, canaryRow.failure, canaryRow.superseded, canaryRow.cancelled], [3, 1, 1, 1]);
  assert.equal(canaryRow.failureRate, 1);
  assert.equal(canaryRow.cancelRate, 2 / 3);
  assert.equal(table.all.runs, runs.length);
  assert.equal(table.all.cancelRate, 6 / 12, 'pending runs are not in the cancel rate');
});

test('a cancelled retry is judged by when its own attempt ran: a run that finished before the retry did not cancel it', () => {
  // A is created Monday 10:00 and re-run Tuesday 10:00, where it times out;
  // B, in the same group, ran Monday 11:00 and finished. The retry carries
  // over Monday's passing job with Monday's times.
  const day = 1440;
  const canary = { event: 'push', branch: 'testnet-canary' };
  const a = run({ id: 1, ...canary, conclusion: 'cancelled', attempt: 2, created: 0, started: day, updated: day + 45 });
  const b = run({ id: 2, ...canary, created: 60, updated: 100 });
  const aJobs = [
    job('Build packages', { start: 0, minutes: 6 }),
    failedLane('Tornado: agent [1/11]', 'Agent tests (shard 1/11)', { start: 6, minutes: 14 }),
    job('Build packages', { attempt: 2, start: 0, minutes: 6 }),
    job('Tornado: agent [1/11]', { attempt: 2, conclusion: 'cancelled', start: day, minutes: 45, steps: [['Agent tests (shard 1/11)', 'cancelled']] }),
    gate({ attempt: 2, conclusion: 'failure', start: day + 45 }),
  ];
  assert.deepEqual(attemptWindow(a, aJobs), { start: T0 + day * MINUTE, end: T0 + (day + 45.2) * MINUTE });
  const outcome = (runs, jobsByRun) => classifyRuns(runs, jobsByRun).find(({ run: { id } }) => id === 1).outcome;
  assert.equal(outcome([a, b]), 'cancelled', 'before its jobs are read, from the retry\'s start');
  assert.equal(outcome([a, b], new Map([[1, aJobs]])), 'cancelled', 'with its jobs, from when the retry\'s own jobs ran');
  const end = T0 + 3 * day * MINUTE;
  const weeks = { window: { start: end - 7 * day * MINUTE, end }, previousWindow: { start: end - 14 * day * MINUTE, end: end - 7 * day * MINUTE } };
  assert.ok(runsNeedingJobs(classifyRuns([a, b]), weeks).some(({ id }) => id === 1), 'its jobs are read for the report');
  assert.equal(topRootFailures([{ run: a, kind: 'canary-push', jobs: aJobs }])[0].lane, 'Tornado: agent');
  // A run created while the retry ran still cancelled it.
  const c = run({ id: 3, ...canary, created: day + 20, updated: day + 60 });
  assert.equal(outcome([a, b, c]), 'superseded');
  assert.equal(outcome([a, b, c], new Map([[1, aJobs]])), 'superseded');
  // Without a retry, or job times, the run's own span decides as before.
  assert.deepEqual(attemptWindow(b), { start: T0 + 60 * MINUTE, end: T0 + 100 * MINUTE });
});

test('a retry of an older run cancels a newer run of its group: the newer run is superseded, and its jobs are not read', () => {
  // A was created yesterday; B starts today at 10:00, and retrying A at 10:10 cancels B.
  const day = 1440;
  const a = run({ id: 61, branch: 'feature/retry', attempt: 2, created: 0, started: day + 610, updated: day + 650 });
  const b = run({ id: 62, branch: 'feature/retry', conclusion: 'cancelled', created: day + 600, updated: day + 610.2 });
  const bJobs = [
    job('Build packages', { start: day + 600, minutes: 6 }),
    job('Tornado: agent [1/11]', { conclusion: 'cancelled', start: day + 606, minutes: 4.2, steps: [['Agent tests (shard 1/11)', 'cancelled']] }),
  ];
  const outcome = (runs, jobsByRun) => classifyRuns(runs, jobsByRun).find(({ run: { id } }) => id === 62).outcome;
  assert.equal(outcome([a, b]), 'superseded');
  assert.equal(outcome([a, b], new Map([[62, bJobs]])), 'superseded');
  const end = T0 + 3 * day * MINUTE;
  const weeks = { window: { start: end - 7 * day * MINUTE, end }, previousWindow: { start: end - 14 * day * MINUTE, end: end - 7 * day * MINUTE } };
  assert.ok(!runsNeedingJobs(classifyRuns([a, b]), weeks).some(({ id }) => id === 62), 'its interrupted lane is not read as a root failure');
  // A's first attempt, created before B, explains nothing; nor does a retry started before or after B's attempt ran.
  assert.equal(outcome([{ ...a, run_attempt: 1, run_started_at: a.created_at }, b]), 'cancelled');
  assert.equal(outcome([{ ...a, run_started_at: at(day + 590) }, b]), 'cancelled');
  assert.equal(outcome([{ ...a, run_started_at: at(day + 700) }, b], new Map([[62, bJobs]])), 'cancelled');
});

test('a dispatch joins the concurrency group of the profile its run name records: a manual nightly-equivalent dispatch never supersedes a standard push', () => {
  const canary = { branch: 'testnet-canary' };
  const dispatch = (id, profile) => ({ ...run({ id, event: 'workflow_dispatch', ...canary, created: 10, updated: 90 }), display_title: `CI (${profile})` });
  const outcome = (runs, id) => classifyRuns(runs).find(({ run: { id: runId } }) => runId === id).outcome;
  // A canary push times out while a developer runs the nightly-equivalent profile.
  const push = run({ id: 71, event: 'push', ...canary, conclusion: 'cancelled', created: 0, updated: 45 });
  assert.equal(outcome([push, dispatch(72, 'nightly-equivalent')], 71), 'cancelled');
  // A standard dispatch shares the push's group, so it does cancel the push.
  assert.equal(outcome([push, dispatch(73, 'standard')], 71), 'superseded');
  // The nightly and a manual nightly-equivalent dispatch share a group.
  const nightly = run({ id: 74, event: 'workflow_dispatch', ...canary, actor: 'github-actions[bot]', conclusion: 'cancelled', created: 0, updated: 45 });
  assert.equal(outcome([nightly, dispatch(75, 'nightly-equivalent')], 74), 'superseded');
  assert.equal(outcome([nightly, dispatch(76, 'standard')], 74), 'cancelled');
  // A dispatch from before ci.yml named its runs falls back to its stream.
  assert.deepEqual([runProfile(nightly), runProfile(run({ event: 'workflow_dispatch', ...canary })), runProfile(push)], ['nightly-equivalent', 'standard', 'standard']);
  // ci.yml names only a dispatch's run, and each profile it offers reads back.
  const workflow = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  assert.match(workflow['run-name'], /^\$\{\{ github\.event_name == 'workflow_dispatch' && format\('[^']*', inputs\.profile\) \|\| ' ' \}\}$/);
  const [, template] = /format\('([^']*)', inputs\.profile\)/.exec(workflow['run-name']);
  const offered = workflow.on.workflow_dispatch.inputs.profile.options;
  assert.deepEqual(offered.map((profile) => runProfile({ event: 'workflow_dispatch', display_title: template.replace('{0}', profile) })), offered);
});

test('root failures skip the aggregates, treat merged coverage as derivative, and fall back to a cancelled job', () => {
  const names = (jobs) => rootFailures(jobs).map(({ name, step }) => `${name}: ${step}`);
  const e2e = [1, 2].map((shard) => failedLane(`Kosava: node-ui e2e [${shard}/7] (Playwright real-node devnet)`, 'Install Playwright Chromium'));
  assert.deepEqual(names([
    job('Build packages'),
    ...e2e,
    failedLane(PROFILE_JOB, 'Verify actual required execution'),
    failedLane(COVERAGE_JOB, 'Verify complete shards'),
    failedLane(CI_GATE_JOB, 'Verify selected lanes completed'),
    job('Alert on red testnet-canary CI', { conclusion: 'failure' }),
  ]), [
    'Kosava: node-ui e2e [1/7] (Playwright real-node devnet): Install Playwright Chromium',
    'Kosava: node-ui e2e [2/7] (Playwright real-node devnet): Install Playwright Chromium',
  ]);
  // Coverage failing with no failed or cancelled test lane is the cause.
  assert.deepEqual(names([job('Tornado: core'), failedLane(COVERAGE_JOB, 'Verify changed lines'), failedLane(CI_GATE_JOB, 'Require the coverage verdict')]), [
    `${COVERAGE_JOB}: Verify changed lines`,
  ]);
  // A timed-out job is cancelled, not failed: with nothing failed, it is the cause.
  const timeout = job('Tornado: Solidity coverage (push safety net)', { conclusion: 'cancelled', minutes: 45, steps: [['Compile', 'success'], ['Hardhat tests', 'cancelled']] });
  assert.deepEqual(names([timeout, failedLane(CI_GATE_JOB, 'Verify selected lanes completed')]), ['Tornado: Solidity coverage (push safety net): Hardhat tests']);
  // A timed-out test shard leaves no coverage receipt, so merged coverage
  // fails after it: the shard is the cause, not the coverage it emptied.
  const shard = job('Tornado: agent [4/11]', { conclusion: 'cancelled', minutes: 12, steps: [['Restore build outputs', 'success'], ['Agent tests (shard 4/11)', 'cancelled']] });
  assert.deepEqual(names([
    job('Tornado: agent [3/11]'),
    shard,
    failedLane(COVERAGE_JOB, 'Verify complete shards, production source, floors and changed lines'),
    failedLane(PROFILE_JOB, 'Verify actual required execution'),
    failedLane(CI_GATE_JOB, 'Verify selected lanes completed'),
  ]), ['Tornado: agent [4/11]: Agent tests (shard 4/11)']);
  // A failed test lane still outranks a cancelled one (fail-fast cancels its siblings).
  assert.deepEqual(names([failedLane('Tornado: agent [2/11]', 'Agent tests (shard 2/11)'), shard, failedLane(COVERAGE_JOB, 'Verify')]), ['Tornado: agent [2/11]: Agent tests (shard 2/11)']);
  // With only an aggregate red, the aggregate is all there is to report.
  assert.deepEqual(names([job('Build packages'), failedLane(CI_GATE_JOB, 'Verify selected lanes completed')]), [`${CI_GATE_JOB}: Verify selected lanes completed`]);
  assert.deepEqual(rootFailures([job('Build packages'), gate()]), []);
});

test('PR time to green counts first-attempt green PR runs from the run start to the CI gate', () => {
  const runs = [
    run({ id: 1, started: 0 }),
    run({ id: 2, started: 0 }),
    run({ id: 3, attempt: 2 }),
    run({ id: 4, conclusion: 'failure' }),
    run({ id: 5, event: 'merge_group', branch: 'gh-readonly-queue/x' }),
  ];
  const jobsByRun = new Map([
    [1, [job('Build packages'), gate({ start: 10 })]],
    [2, [gate({ start: 30 })]],
    [3, [gate({ start: 5, attempt: 2 })]],
    [4, [gate({ start: 5, conclusion: 'failure' })]],
    [5, [gate({ start: 5 })]],
  ]);
  const result = prTimeToGreen(classifyRuns(runs), jobsByRun);
  assert.equal(result.runs, 2);
  assert.equal(result.p50, 20.2 * MINUTE);
  assert.ok(Math.abs(result.p90 - 28.2 * MINUTE) < 1);
});

test('top root failures count a run once per lane, over attempts and shards, with its streams and steps', () => {
  const e2e = (shard, attempt = 1) => failedLane(`Kosava: node-ui e2e [${shard}/7] (x)`, 'Install Playwright Chromium', { attempt });
  const entries = classifyRuns([
    run({ id: 1, conclusion: 'failure', created: 0 }),
    run({ id: 2, event: 'push', branch: 'testnet-canary', conclusion: 'failure', created: 100, attempt: 2 }),
    run({ id: 3, created: 200 }),
  ]).map((entry) => ({ ...entry, jobs: {
    1: [job('Build packages'), e2e(1), e2e(2), gate({ conclusion: 'failure' })],
    2: [job('Build packages'), e2e(3), gate({ conclusion: 'failure' }), job('Build packages', { attempt: 2 }), e2e(3, 2), gate({ attempt: 2, conclusion: 'failure' })],
    3: [job('Build packages'), job('Kosava: node-ui e2e [1/7] (x)'), gate()],
  }[entry.run.id] }));
  const [top, ...rest] = topRootFailures(entries);
  assert.deepEqual(rest, []);
  assert.equal(top.lane, 'Kosava: node-ui e2e (x)');
  assert.equal(top.failed, 2);
  assert.equal(top.ran, 3);
  assert.equal(top.maxShards, 2);
  assert.deepEqual(top.kinds, { pr: 1, 'canary-push': 1 });
  assert.deepEqual([top.step, top.stepCount], ['Install Playwright Chromium', 2]);
  assert.equal(top.last.id, 2);

  // The weekly table names a timed-out shard, not the coverage check it emptied.
  const [timedOut, ...others] = topRootFailures(classifyRuns([run({ id: 4, conclusion: 'cancelled' })]).map((entry) => ({ ...entry, jobs: [
    job('Tornado: agent [4/11]', { conclusion: 'cancelled', steps: [['Agent tests (shard 4/11)', 'cancelled']] }),
    failedLane(COVERAGE_JOB, 'Verify complete shards'),
    gate({ conclusion: 'failure' }),
  ] })));
  assert.deepEqual(others, []);
  assert.deepEqual([timedOut.lane, timedOut.failed, timedOut.cancelled, timedOut.step], ['Tornado: agent', 1, 1, 'Agent tests (shard 4/11)']);
});

test('a job that failed and then passed on a retry or on the same commit is flaky; a carried-over pass is not', () => {
  const lane = 'Tornado: core + RDF + storage';
  const entries = classifyRuns([
    // Failed, re-run, passed: flaky on retry.
    run({ id: 1, attempt: 2, sha: 'b'.repeat(40) }),
    // Passed first, carried over into a re-run of another job: not flaky.
    run({ id: 2, attempt: 2, sha: 'c'.repeat(40) }),
    // Failed in one run and passed in another of the same commit.
    run({ id: 3, conclusion: 'failure', sha: 'd'.repeat(40), created: 0 }),
    run({ id: 4, sha: 'd'.repeat(40), created: 10 }),
    // The nightly runs more: its failure on a green commit is not a flake.
    run({ id: 5, event: 'push', branch: 'testnet-canary', sha: 'e'.repeat(40) }),
    run({ id: 6, event: 'workflow_dispatch', branch: 'testnet-canary', actor: 'github-actions[bot]', conclusion: 'failure', sha: 'e'.repeat(40) }),
    // So does a developer's nightly-equivalent dispatch; a standard dispatch is compared.
    run({ id: 7, event: 'push', branch: 'testnet-canary', sha: 'f'.repeat(40) }),
    { ...run({ id: 8, event: 'workflow_dispatch', branch: 'testnet-canary', conclusion: 'failure', sha: 'f'.repeat(40) }), display_title: 'CI (nightly-equivalent)' },
    run({ id: 9, event: 'push', branch: 'testnet-canary', sha: 'g'.repeat(40) }),
    { ...run({ id: 10, event: 'workflow_dispatch', branch: 'testnet-canary', conclusion: 'failure', sha: 'g'.repeat(40) }), display_title: 'CI (standard)' },
  ]).map((entry) => ({ ...entry, jobs: {
    1: [failedLane(lane, 'Run core tests'), gate({ conclusion: 'failure' }), job(lane, { attempt: 2 }), gate({ attempt: 2 })],
    2: [job(lane), failedLane('Bura: cli [1/4]', 'Run'), job(lane, { attempt: 2 }), job('Bura: cli [1/4]', { attempt: 2 })],
    3: [failedLane('Tornado: agent [2/11]', 'Run'), gate({ conclusion: 'failure' })],
    4: [job('Tornado: agent [2/11]'), gate()],
    5: [job('Tornado: publisher [1/4]')],
    6: [failedLane('Tornado: publisher [1/4]', 'Run')],
    7: [job('Tornado: query [1/2]')],
    8: [failedLane('Tornado: query [1/2]', 'Run')],
    9: [job('Tornado: sync [1/2]')],
    10: [failedLane('Tornado: sync [1/2]', 'Run')],
  }[entry.run.id] }));
  const flaky = Object.fromEntries(flakyJobs(entries).map(({ name, retried, sameCommit }) => [name, [retried.map(({ id }) => id), sameCommit.map(({ sha }) => sha.slice(0, 1))]]));
  assert.deepEqual(flaky, {
    [lane]: [[1], []],
    'Bura: cli [1/4]': [[2], []],
    'Tornado: agent [2/11]': [[], ['d']],
    'Tornado: sync [1/2]': [[], ['g']],
  });
});

test('lane timings use the latest attempt, the slowest shard, passing lanes only, and flag an uneven split', () => {
  const sharded = (minutes) => minutes.map((length, index) => job(`Tornado: agent [${index + 1}/4]`, { minutes: length }));
  const dispatch = (id, profile) => ({ ...run({ id, event: 'workflow_dispatch', branch: 'testnet-canary' }), display_title: `CI (${profile})` });
  const entries = classifyRuns([
    run({ id: 1 }), run({ id: 2, attempt: 2 }), run({ id: 3 }), run({ id: 4, event: 'workflow_dispatch', branch: 'testnet-canary', actor: 'github-actions[bot]' }),
    dispatch(5, 'nightly-equivalent'), dispatch(6, 'standard'),
  ])
    .map((entry) => ({ ...entry, jobs: {
      1: [...sharded([4, 5, 6, 12]), job('Build packages', { minutes: 6 }), gate({ minutes: 1 })],
      // Attempt 1's failed shard is not timed; attempt 2 holds the copies and the re-run.
      2: [...sharded([4, 5, 6, 10]), failedLane('Tornado: agent [4/4]', 'Run', { minutes: 2 }), ...sharded([4, 5, 6, 10]).map((entry) => ({ ...entry, run_attempt: 2 }))].filter((entry) => !(entry.run_attempt === 1 && entry.name.endsWith('[4/4]') && entry.conclusion === 'success')),
      3: [...sharded([5, 5, 5, 5]).slice(0, 3), failedLane('Tornado: agent [4/4]', 'Run'), job('Build packages', { minutes: 8 })],
      4: [...sharded([50, 50, 50, 50])],
      // A developer's nightly-equivalent dispatch is not timed; a standard dispatch is.
      5: [...sharded([40, 40, 40, 40])],
      6: [...sharded([4, 5, 6, 11])],
    }[entry.run.id] }));
  const timings = Object.fromEntries(laneTimings(entries).map((entry) => [entry.lane, entry]));
  assert.deepEqual(Object.keys(timings), ['Tornado: agent', 'Build packages']);
  const agent = timings['Tornado: agent'];
  assert.equal(agent.runs, 3, 'a lane with a failed shard is not timed, nor a nightly-equivalent run');
  assert.equal(agent.p50, 11 * MINUTE);
  assert.equal(agent.shardCount, 4);
  assert.deepEqual(agent.shards.map(({ shard, p50 }) => [shard, p50 / MINUTE]), [[1, 4], [2, 5], [3, 6], [4, 11]]);
  assert.equal(agent.slowestShard, 4);
  assert.equal(agent.spread, 11 / 5.5);
  assert.equal(timings['Build packages'].runs, 2);
  assert.equal(timings['Build packages'].spread, undefined);
});

test('nightly results name what failed each red night and the dispatches that started nothing', () => {
  const nightly = { event: 'workflow_dispatch', branch: 'testnet-canary', actor: 'github-actions[bot]' };
  const classified = classifyRuns([
    run({ id: 1, ...nightly, created: 0, updated: 47 }),
    run({ id: 2, ...nightly, conclusion: 'cancelled', created: 1440, updated: 1485 }),
    run({ id: 3, ...nightly, conclusion: 'failure', created: 2880, updated: 2925 }),
  ]);
  const jobsByRun = new Map([
    [2, [job('Tornado: Solidity coverage (push safety net)', { conclusion: 'cancelled', minutes: 45, steps: [['Hardhat tests', 'cancelled']] }), failedLane(CI_GATE_JOB, 'Verify')]],
    [3, [failedLane('Build packages', 'Lint source and repository tooling'), failedLane(PROFILE_JOB, 'Verify'), failedLane(CI_GATE_JOB, 'Verify')]],
  ]);
  const dispatcher = (id, created, conclusion) => ({ ...run({ id, event: 'schedule', branch: 'main', created, conclusion }), status: 'completed' });
  const { rows, missed } = nightlyResults({ classified, jobsByRun, dispatcherRuns: [dispatcher(11, -2, 'success'), dispatcher(12, 1438, 'failure'), dispatcher(13, 4318, 'failure')] });
  assert.deepEqual(rows.map(({ run: { id }, outcome, minutes, failures }) => [id, outcome, minutes, failures.map(({ lane, steps, cancelled }) => `${lane}: ${steps[0]}${cancelled ? ' (cancelled)' : ''}`)]), [
    [1, 'success', 47, []],
    [2, 'cancelled', 45, ['Tornado: Solidity coverage (push safety net): Hardhat tests (cancelled)']],
    [3, 'failure', 45, ['Build packages: Lint source and repository tooling']],
  ]);
  assert.deepEqual(missed.map(({ id }) => id), [13]);
});

test('test exceptions are read from comments in the audit\'s files, and their deadlines are the end of the UTC day', () => {
  for (const [file, expected] of [
    ['packages/cli/test/mcp-launch-command.test.ts', true],
    ['packages/agent/test-live/primary.blazegraph.test.ts', true],
    ['packages/node-ui/e2e/helpers/devnet.ts', true],
    ['packages/cli/vitest.unit.config.ts', true],
    ['packages/cli/src/daemon.ts', false],
    ['test-policy/README.md', false],
    ['packages/cli/test/archive/old.test.ts', false],
    ['packages/cli/dist/test/a.test.js', false],
  ]) assert.equal(isTestExceptionFile(file), expected, file);

  const source = [
    "const fixture = '// test-disable-allow: D1 #1 -- quoted owner=x lane=y expires=2026-11-12';",
    '  // test-disable-allow: D1 #3274 -- owner=Jurij89 lane=tornado-blazegraph expires=2026-11-20 Needs BLAZEGRAPH_TEST_URL.',
    'it.skip("x", () => {});',
    '/* test-disable-allow: D2 #9 -- spans lines',
    ' * owner=storage lane=tornado-core expires=2026-11-11 */',
    '// an ordinary comment',
  ].join('\n');
  assert.deepEqual(parseTestExceptions(source), [
    { line: 2, ticket: '#3274', owner: 'Jurij89', lane: 'tornado-blazegraph', expires: '2026-11-20' },
    { line: 4, ticket: '#9', owner: 'storage', lane: 'tornado-core', expires: '2026-11-11' },
  ]);

  const now = Date.parse('2026-11-11T12:00:00Z');
  const exceptions = [
    ...parseTestExceptions(source).map((exception) => ({ file: 'a.test.ts', ...exception })),
    { file: 'b.test.ts', line: 1, expires: '2026-11-05' },
    { file: 'c.test.ts', line: 1, expires: '2026-12-08' },
    { file: 'd.test.ts', line: 1, expires: '2026-12-08' },
    { file: 'e.test.ts', line: 1, expires: '2026-02-30' },
    { file: 'f.test.ts', line: 1 },
  ];
  const { rows, next, scanned } = expiringTestExceptions(exceptions, { now, days: 14 });
  // Whole days to the end of the deadline day: today's is 0, a week-old one's -6.
  assert.deepEqual(rows.map(({ file, expired, daysLeft }) => [file, expired, daysLeft]), [
    ['b.test.ts', true, -6],
    ['a.test.ts', false, 0],
    ['a.test.ts', false, 9],
  ]);
  assert.deepEqual(next, { expires: '2026-12-08', count: 2 });
  assert.equal(scanned, 7);
});

// The files whose exceptions the report reads differently from the audit:
// per file, the lines the audit finds (in 2100 every exception is invalid)
// against the lines the report read. Every file given is compared, including
// those where the report read nothing.
function exceptionDisagreements(files, read, reported) {
  const byFile = Object.groupBy(reported, ({ file }) => file);
  const farFuture = new Date(Date.parse('2100-01-01T00:00:00Z'));
  return files.flatMap((file) => {
    const audit = inspectTestExceptions(read(file), file, farFuture).invalidExceptions;
    const report = (byFile[file] ?? []).map(({ line }) => line);
    return JSON.stringify(audit) === JSON.stringify(report) ? [] : [{ file, audit, report }];
  });
}

test('the exception reader agrees with the disabled-test audit on every tracked file', () => {
  // The audit's own scanner loads TypeScript, so the report mirrors its file
  // set and comment reading. Every file the audit scans is compared, so a file
  // whose exceptions the report misses entirely fails here, and every
  // exception the report reads is valid the day before its deadline and
  // invalid the day after.
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const disagreements = files.filter((file) => isScannableFile(file) !== isTestExceptionFile(file));
  assert.deepEqual(disagreements, []);
  const exceptions = trackedTestExceptions(REPO_ROOT);
  assert.ok(exceptions.length > 0, 'the repository has exceptions to compare');
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  assert.deepEqual(exceptionDisagreements(files.filter(isScannableFile), read, exceptions), [],
    'the CI health report reads test-disable-allow comments that open a line: put the waiver on its own line, or teach parseTestExceptions its form');
  const day = 86_400_000;
  for (const { file, line, expires } of exceptions.filter(({ owner, lane, expires }) => owner && lane && expires)) {
    const deadline = Date.parse(`${expires}T23:59:59Z`);
    assert.equal(inspectTestExceptions(read(file), file, new Date(deadline - day)).invalidExceptions.includes(line), false, `${file}:${line}`);
    assert.equal(inspectTestExceptions(read(file), file, new Date(deadline + day)).invalidExceptions.includes(line), true, `${file}:${line}`);
  }
});

test('the reader comparison fails for a file whose exceptions the report misses entirely, beside one it reads', () => {
  const waiver = 'test-disable-allow: D1 #1 -- owner=ci lane=network expires=2026-11-12';
  const sources = {
    'packages/x/test/leading.test.ts': ['// ' + waiver, "it.skip('a', () => {});", ''].join('\n'),
    'packages/x/test/trailing.test.ts': ['const setup = true; // ' + waiver, "it.skip('b', () => {});", ''].join('\n'),
  };
  const reported = Object.entries(sources).flatMap(([file, source]) => parseTestExceptions(source).map((exception) => ({ file, ...exception })));
  assert.deepEqual(reported.map(({ file, line }) => `${file}:${line}`), ['packages/x/test/leading.test.ts:1'], 'the report reads only waivers that open a line');
  assert.deepEqual(exceptionDisagreements(Object.keys(sources), (file) => sources[file], reported), [
    { file: 'packages/x/test/trailing.test.ts', audit: [1], report: [] },
  ]);
});

test('table text cannot break a table, inject HTML or notify anyone', () => {
  assert.equal(inline('a | b <!-- x --> @someone `code`\nnext'), "a \\| b &lt;!-- x --&gt; @​someone 'code' next");
  assert.equal(inline('x'.repeat(10), 5), 'xxxx…');
  assert.equal(inline(undefined), '');
});

// A week of runs and the week before, with jobs, as the API returns them.
function fixtureWeek() {
  const end = T0 + 14 * 1440 * MINUTE;
  const week = 7 * 1440;
  const runs = [
    // Prior week: two green first-attempt PR runs.
    run({ id: 1, created: 100 }),
    run({ id: 2, created: 200 }),
    // This week.
    run({ id: 10, created: week + 100 }),
    run({ id: 11, created: week + 200, conclusion: 'failure' }),
    run({ id: 12, created: week + 300, branch: 'feature/b', conclusion: 'cancelled', updated: week + 305 }),
    run({ id: 13, created: week + 302, branch: 'feature/b' }),
    run({ id: 14, event: 'merge_group', branch: 'gh-readonly-queue/testnet-canary/pr-1', created: week + 400 }),
    run({ id: 15, event: 'push', branch: 'testnet-canary', created: week + 500, conclusion: 'failure' }),
    run({ id: 16, event: 'workflow_dispatch', branch: 'testnet-canary', actor: 'github-actions[bot]', created: week + 600 }),
    run({ id: 17, created: week + 700, status: 'in_progress', conclusion: null }),
  ];
  const e2e = failedLane('Kosava: node-ui e2e [1/7] (x)', 'Install Playwright Chromium');
  const jobsByRun = new Map([
    [1, [gate({ start: 100 + 10 })]],
    [2, [gate({ start: 200 + 14 })]],
    [10, [job('Build packages', { start: week + 100, minutes: 6 }), gate({ start: week + 100 + 20 })]],
    [11, [job('Build packages', { start: week + 200 }), e2e, gate({ conclusion: 'failure' })]],
    [13, [job('Build packages', { start: week + 302, minutes: 8 }), gate({ start: week + 302 + 30 })]],
    [14, [job('Build packages', { minutes: 7 }), gate()]],
    [15, [job('Build packages'), e2e, gate({ conclusion: 'failure' })]],
    [16, [job('Build packages'), gate()]],
  ]);
  return { end, runs, jobsByRun };
}

test('the report renders every section from one model, with week-over-week deltas', () => {
  const { end, runs, jobsByRun } = fixtureWeek();
  const window = { start: end - 7 * 86_400_000, end };
  const model = buildHealthReport({
    repo: 'OriginTrail/dkg',
    window,
    previousWindow: { start: end - 14 * 86_400_000, end: window.start },
    runs,
    jobsByRun,
    exceptions: [{ file: 'packages/cli/test/a.test.ts', line: 3, owner: 'cli', lane: 'bura-cli', ticket: '#1', expires: '2026-11-20' }],
    generatedAt: end,
    requestCount: 42,
  });
  assert.deepEqual([model.timeToGreen.current.runs, model.timeToGreen.current.p50 / MINUTE], [2, 25.2]);
  assert.deepEqual([model.timeToGreen.previous.runs, model.timeToGreen.previous.p50 / MINUTE], [2, 12.2]);
  const markdown = renderHealthReport(model);
  for (const expected of [
    '## CI health: 2026-11-11 to 2026-11-18',
    '- **PR time to green:** p50 25.2 min (+13.0 min on the prior week), p90 29.2 min (+15.4 min), over 2 first-attempt green PR runs.',
    '- **Cancelled:** 25% of PR runs (prior week 0%) and 0% of testnet-canary pushes (prior week n/a).',
    '- **Merge queue:** 1 runs, 1 passed, 0 failed, 0 cancelled by the queue.',
    '- **Nightly:** 1 of 1 green.',
    '- **Top root failure:** Kosava: node-ui e2e (x), 2 run(s), most often at `Install Playwright Chromium`.',
    '- **Test exceptions:** 0 expired, 1 expire within 14 days.',
    '| testnet-canary pushes | 1 | 0 | 1 | 100% | 0 | 0 | 0% | 0 |',
    '| Pull requests | 5 | 2 | 1 | 33% | 1 | 0 | 25% | 1 |',
    '| **All runs** | 8 | 4 | 2 | 33% | 1 | 0 | 14% | 1 |',
    '| This week | 2 | 25.2 min | 29.2 min |',
    '| Prior week | 2 | 12.2 min | 13.8 min |',
    '| Kosava: node-ui e2e (x) | 2 | 2 | PR 1, canary 1 | Install Playwright Chromium (2) | [#15](https://github.com/OriginTrail/dkg/actions/runs/15) |',
    '| Build packages | 5 | 6.0 min | 7.6 min |  |  |',
    '| 2026-11-11 10:00 | `aaaaaaaaaa` | success | 30 min |  | [#16](https://github.com/OriginTrail/dkg/actions/runs/16) |',
    '| 2026-11-20 | 2 | `packages/cli/test/a.test.ts:3` | cli | bura-cli | #1 |',
    'from 8 runs (jobs read for 6; superseded and running ones are not read) in 42 API requests',
  ]) assert.ok(markdown.includes(expected), `missing: ${expected}\n\n${markdown}`);
  assert.match(renderHealthHeadline(model), /^\*\*CI health: 2026-11-11 to 2026-11-18\*\*\n\n- \*\*PR time to green:\*\*/);
  // A body too long for an issue is cut at a line and says where the rest is.
  const long = issueBody(`${'line\n'.repeat(20_000)}`, 'https://example.invalid/run');
  assert.ok(long.length <= 65_000 && long.startsWith(HEALTH_MARKER) && long.includes('[workflow run](https://example.invalid/run) summary'));
});

test('jobs are read for this week\'s verdicts and unexplained cancellations, and the prior week\'s green PR runs', () => {
  const { end, runs } = fixtureWeek();
  const window = { start: end - 7 * 86_400_000, end };
  const wanted = runsNeedingJobs(classifyRuns(runs), { window, previousWindow: { start: end - 14 * 86_400_000, end: window.start } });
  assert.deepEqual(wanted.map(({ id }) => id), [1, 2, 10, 11, 13, 14, 15, 16]);
});

// A fake GitHub API over the fixture week, recording every request.
function fakeGitHub({ runs, jobsByRun }, { issues = [] } = {}) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(`${init.method} ${pathname}`);
    if (init.method === 'GET' && pathname.endsWith('/actions/workflows/ci.yml/runs')) {
      const [from, to] = searchParams.get('created').split('..');
      const page = runs.filter(({ created_at: created }) => created >= from && created <= to);
      return json({ total_count: page.length, workflow_runs: Number(searchParams.get('page')) === 1 ? page : [] });
    }
    if (pathname.endsWith('/actions/workflows/nightly-ci.yml/runs')) return json({ message: 'Not Found' }, 404);
    const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(pathname);
    if (jobs) return json({ total_count: (jobsByRun.get(Number(jobs[1])) ?? []).length, jobs: jobsByRun.get(Number(jobs[1])) ?? [] });
    if (pathname.endsWith('/labels/ci-health')) return json({ message: 'Not Found' }, 404);
    if (pathname.endsWith('/labels')) return json({}, 201);
    if (init.method === 'GET' && pathname.endsWith('/issues')) return json(issues);
    if (pathname.endsWith('/issues') || pathname.includes('/issues/')) return json({ number: 77 }, init.method === 'POST' ? 201 : 200);
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  return { client: createGitHubClient({ token: 't', fetch, sleep: async () => {} }), calls };
}

test('the report CLI only reads GitHub unless --publish-issue is given, then keeps one ci-health issue', async (t) => {
  const week = fixtureWeek();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-health-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const end = new Date(week.end).toISOString();
  const logs = [];
  const read = fakeGitHub(week);
  let printed = '';
  const { model } = await runHealthReport({
    argv: ['--repo', 'OriginTrail/dkg', '--end', end],
    env: {}, client: read.client, now: week.end, log: (message) => logs.push(message), print: (text) => { printed += text; },
  });
  assert.ok(read.calls.every((call) => call.startsWith('GET ')), read.calls.join('\n'));
  assert.ok(printed.startsWith('## CI health: 2026-11-11 to 2026-11-18'));
  assert.equal(model.runs, 8);
  assert.ok(logs.some((message) => /nightly-ci\.yml is not a workflow here/.test(message)));

  const summary = path.join(directory, 'summary.md');
  const publish = fakeGitHub(week);
  await runHealthReport({
    argv: ['--repo', 'OriginTrail/dkg', '--end', end, '--summary', summary, '--publish-issue'],
    env: { GITHUB_RUN_ID: '9', GITHUB_SERVER_URL: 'https://github.com' }, client: publish.client, now: week.end, log: () => {}, print: () => assert.fail('a summary run prints nothing'),
  });
  assert.ok(fs.readFileSync(summary, 'utf8').startsWith('## CI health'));
  assert.deepEqual(publish.calls.filter((call) => !call.startsWith('GET ')), [
    'POST /repos/OriginTrail/dkg/labels',
    'POST /repos/OriginTrail/dkg/issues',
  ]);
  const update = fakeGitHub(week, { issues: [{ number: 5, body: `${HEALTH_MARKER}\nlast week` }] });
  await runHealthReport({
    argv: ['--repo', 'OriginTrail/dkg', '--end', end, '--output', path.join(directory, 'report.md'), '--publish-issue'],
    env: {}, client: update.client, now: week.end, log: () => {}, print: () => {},
  });
  assert.deepEqual(update.calls.filter((call) => !call.startsWith('GET ')), [
    'POST /repos/OriginTrail/dkg/labels',
    'PATCH /repos/OriginTrail/dkg/issues/5',
    'POST /repos/OriginTrail/dkg/issues/5/comments',
  ]);
  await assert.rejects(runHealthReport({ argv: ['--repo', 'OriginTrail/dkg', '--days', '0'], env: {}, client: read.client }), /--days must be an integer/);
});

test('the report workflow runs weekly and by hand with read access and an issue writer only', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci-health-report.yml'), 'utf8');
  const workflow = parse(source);
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.deepEqual(workflow.on.schedule, [{ cron: '0 6 * * 1' }]);
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.equal(workflow.on.pull_request, undefined, 'PR code never gets the issue-writing token');
  assert.deepEqual(workflow.on.push.branches, ['testnet-canary']);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const [name, job] = Object.entries(workflow.jobs)[0];
  assert.equal(Object.keys(workflow.jobs).length, 1, name);
  assert.equal(job.if, "github.repository == 'OriginTrail/dkg'");
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', issues: 'write' });
  for (const step of job.steps.filter(({ uses }) => uses)) {
    assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, step.uses);
    assert.ok(ci.includes(step.uses), `${step.uses} reuses a pin ci.yml already trusts`);
  }
  assert.equal(job.steps.find(({ uses }) => uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
  const report = job.steps.find(({ run }) => run?.includes('ci-health-report.mjs'));
  assert.doesNotMatch(report.run, /\$\{\{/, 'inputs reach the shell through env only');
  assert.match(report.run, /--summary "\$GITHUB_STEP_SUMMARY"/);
  assert.match(report.run, /--publish-issue/);
  assert.equal(report.env.GITHUB_TOKEN, '${{ github.token }}');
  // The push trigger refreshes the report whenever the code it runs changes.
  const closure = importClosure('scripts/ci/ci-health-report.mjs');
  assert.deepEqual([...workflow.on.push.paths].sort(), ['.github/workflows/ci-health-report.yml', ...closure].sort());
});
