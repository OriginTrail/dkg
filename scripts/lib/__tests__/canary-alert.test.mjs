// The red-canary alert: its issue state machine (canary-alert.mjs), the
// script that applies it (scripts/ci/canary-alert.mjs), and the ci.yml job
// that runs it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { ALERT_LABEL, ALERT_MARKER, ALERT_TITLE, planAlert, PROFILES, readAlertState, renderFailure } from '../canary-alert.mjs';
import { CANARY_ALERT_JOB, CI_GATE_JOB, PROFILE_JOB } from '../ci-health.mjs';
import { createGitHubClient } from '../github-rest.mjs';
import { runCanaryAlert } from '../../ci/canary-alert.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';
import { importClosure } from './script-imports.mjs';

const T0 = Date.parse('2026-11-11T10:00:00Z');
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString().replace('.000Z', 'Z');
const reference = (id, { created = 0, profile = 'standard', attempt = 1, event = 'push' } = {}) => ({
  id, attempt, profile, event,
  createdAt: at(created),
  finishedAt: at(created + 45),
  url: `https://github.com/OriginTrail/dkg/actions/runs/${id}`,
  sha: String(id).padEnd(40, '0'),
  commitUrl: `https://github.com/OriginTrail/dkg/commit/${String(id).padEnd(40, '0')}`,
  actor: 'github-merge-queue[bot]',
  triggeringActor: 'github-merge-queue[bot]',
  title: 'Merge pull request #3815 from OriginTrail/fix | cc @someone',
});
const step = (name, conclusion, number) => ({ name, conclusion, number });
const job = (name, conclusion = 'success', steps = []) => ({ name, status: 'completed', conclusion, run_attempt: 1, steps });
const redJobs = [
  job('Build packages'),
  ...[1, 2].map((shard) => job(`Kosava: node-ui e2e [${shard}/7] (Playwright real-node devnet)`, 'failure', [
    step('Set up job', 'success', 1), step('Record first-attempt browser failures', 'failure', 9), step('Install Playwright Chromium', 'failure', 4),
  ])),
  job(PROFILE_JOB, 'failure', [step('Verify actual required execution', 'failure', 6)]),
  job(CI_GATE_JOB, 'failure', [step('Verify selected lanes completed', 'failure', 5)]),
];
const greenJobs = [job('Build packages'), job(CI_GATE_JOB)];

test('a red run opens the alert with its state, run, commit, actor, and failed jobs and steps', () => {
  const plan = planAlert({ issue: null, run: reference(101), gateResult: 'failure', jobs: redJobs });
  assert.equal(plan.action, 'open');
  assert.equal(plan.title, ALERT_TITLE);
  assert.deepEqual(plan.labels, [ALERT_LABEL.name]);
  assert.deepEqual(readAlertState(plan.body), { version: 1, failing: { standard: { since: at(0), run: {
    id: 101, attempt: 1, createdAt: at(0), url: 'https://github.com/OriginTrail/dkg/actions/runs/101',
    sha: '1010000000000000000000000000000000000000', commitUrl: 'https://github.com/OriginTrail/dkg/commit/1010000000000000000000000000000000000000',
  } } } });
  assert.ok(plan.body.startsWith(ALERT_MARKER));
  for (const expected of [
    '| standard | 2026-11-11 10:00 UTC | [CI #101](https://github.com/OriginTrail/dkg/actions/runs/101) |',
    '- **Run:** [CI #101](https://github.com/OriginTrail/dkg/actions/runs/101), `push`, standard profile, finished 2026-11-11 10:45 UTC',
    // The title cannot break the line or notify anyone.
    'Merge pull request #3815 from OriginTrail/fix \\| cc @​someone',
    '- **Actor:** `github-merge-queue[bot]`',
    // One lane, its shards and the first failed step by number, not the aggregates.
    '  - **Kosava: node-ui e2e (Playwright real-node devnet)**, 2 jobs, failed step: `Install Playwright Chromium`',
    '- CI gate (failure): Verify selected lanes completed',
    '- Kosava: node-ui e2e [1/7] (Playwright real-node devnet) (failure): Install Playwright Chromium; Record first-attempt browser failures',
  ]) assert.ok(plan.body.includes(expected), `missing: ${expected}\n${plan.body}`);
  assert.doesNotMatch(plan.body.split('\n').slice(1).join('\n'), /<!--/, 'only the first line is a comment');
});

test('later runs comment while red, clear the profiles a pass covers, and close once none is red', () => {
  const opened = planAlert({ issue: null, run: reference(101, { created: 0 }), gateResult: 'failure', jobs: redJobs });
  const issue = (plan) => ({ number: 7, body: plan.body });

  // Still red: a comment, the same start, the latest run recorded.
  const again = planAlert({ issue: issue(opened), run: reference(102, { created: 60 }), gateResult: 'failure', jobs: redJobs });
  assert.equal(again.action, 'comment');
  assert.match(again.comment, /^### Still red: \[CI #102\]/);
  assert.deepEqual([again.state.failing.standard.since, again.state.failing.standard.run.id], [at(0), 102]);

  // The nightly fails too: both profiles are red.
  const nightly = planAlert({ issue: issue(again), run: reference(103, { created: 120, profile: 'nightly-equivalent', event: 'workflow_dispatch' }), gateResult: 'cancelled', jobs: redJobs });
  assert.deepEqual(Object.keys(nightly.state.failing), ['standard', 'nightly-equivalent']);

  // A standard pass clears only the standard profile, and keeps the details.
  const pushGreen = planAlert({ issue: issue(nightly), run: reference(104, { created: 180 }), gateResult: 'success', jobs: greenJobs });
  assert.equal(pushGreen.action, 'update');
  assert.deepEqual(Object.keys(pushGreen.state.failing), ['nightly-equivalent']);
  assert.match(pushGreen.comment, /That clears standard; nightly-equivalent \(red since 2026-11-11 12:00 UTC/);
  assert.ok(pushGreen.body.includes('### Latest failure') && pushGreen.body.includes('[CI #103]'));
  assert.equal(pushGreen.body.match(/_Opened, commented on/g).length, 1);

  // Another standard pass has nothing left to clear.
  const quiet = planAlert({ issue: issue(pushGreen), run: reference(105, { created: 240 }), gateResult: 'success', jobs: greenJobs });
  assert.equal(quiet.action, 'none');
  assert.match(quiet.reason, /nightly-equivalent stays red/);

  // A nightly-equivalent pass covers both.
  const closed = planAlert({ issue: issue(nightly), run: reference(106, { created: 1440, profile: 'nightly-equivalent', event: 'workflow_dispatch' }), gateResult: 'success', jobs: greenJobs });
  assert.equal(closed.action, 'close');
  assert.match(closed.comment, /^\*\*Green again:\*\* \[CI #106\]\(.+\) \(`workflow_dispatch`, nightly-equivalent profile\) passed at .+ Closing\.$/);
});

test('a pass from an older run proves nothing about a newer red one, and a late old failure keeps the newer run', () => {
  const opened = planAlert({ issue: null, run: reference(201, { created: 100 }), gateResult: 'failure', jobs: redJobs });
  const issue = { number: 8, body: opened.body };
  assert.equal(planAlert({ issue, run: reference(200, { created: 50 }), gateResult: 'success', jobs: greenJobs }).action, 'none');
  // A re-run attempt of the same red run that passes clears it.
  assert.equal(planAlert({ issue, run: reference(201, { created: 100, attempt: 2 }), gateResult: 'success', jobs: greenJobs }).action, 'close');
  const late = planAlert({ issue, run: reference(199, { created: 20 }), gateResult: 'failure', jobs: redJobs });
  assert.equal(late.action, 'comment');
  assert.deepEqual([late.state.failing.standard.since, late.state.failing.standard.run.id], [at(20), 201]);
  assert.ok(late.body.includes('[CI #201]') && !late.body.includes('### Latest failure\n\n- **Run:** [CI #199]'));
});

test('a skipped or missing gate does nothing, and an issue whose state is unreadable closes on any pass', () => {
  for (const gateResult of ['skipped', '', undefined]) {
    assert.equal(planAlert({ issue: null, run: reference(1), gateResult, jobs: [] }).action, 'none', String(gateResult));
  }
  assert.equal(planAlert({ issue: null, run: reference(1), gateResult: 'success', jobs: greenJobs }).action, 'none');
  const broken = { number: 9, body: `${ALERT_MARKER}{not json} -->\nsomeone edited this` };
  assert.equal(readAlertState(broken.body), undefined);
  assert.equal(planAlert({ issue: broken, run: reference(2), gateResult: 'success', jobs: greenJobs }).action, 'close');
  const rebuilt = planAlert({ issue: broken, run: reference(3), gateResult: 'failure', jobs: redJobs });
  assert.deepEqual(Object.keys(rebuilt.state.failing), ['standard']);
  // A hand-edited entry without readable times is dropped; with none left, a pass closes.
  const edited = { number: 10, body: `${ALERT_MARKER}${JSON.stringify({ version: 1, failing: { standard: { since: 'soon' }, other: {} } })} -->` };
  assert.deepEqual(readAlertState(edited.body), { version: 1, failing: {} });
  assert.equal(planAlert({ issue: edited, run: reference(4), gateResult: 'success', jobs: greenJobs }).action, 'close');
  // No recorded value can end the state comment early.
  const hostile = planAlert({ issue: null, run: { ...reference(4), url: 'https://github.com/x --> <img>' }, gateResult: 'failure', jobs: redJobs });
  assert.equal(readAlertState(hostile.body).failing.standard.run.url, 'https://github.com/x --> <img>');
  assert.equal(hostile.body.split('\n')[0].indexOf(' -->'), hostile.body.split('\n')[0].length - 4);
});

test('a timed-out lane is reported as cancelled, and a run without failed jobs says so', () => {
  const timeout = renderFailure(reference(5, { profile: 'nightly-equivalent' }), [
    job('Tornado: Solidity coverage (push safety net)', 'cancelled', [step('Hardhat tests + Solidity coverage + ratchet check', 'cancelled', 8)]),
    job(CI_GATE_JOB, 'failure', [step('Verify selected lanes completed', 'failure', 5)]),
    job(CANARY_ALERT_JOB, 'failure'),
  ]);
  assert.match(timeout, /\*\*Tornado: Solidity coverage \(push safety net\)\*\*, cancelled \(a timeout or a manual cancel\), failed step: `Hardhat tests \+ Solidity coverage \+ ratchet check`/);
  assert.doesNotMatch(timeout, new RegExp(CANARY_ALERT_JOB));
  assert.match(renderFailure(reference(6), []), /No failed job in the jobs API; see the run\./);
});

// A fake GitHub for one canary run, recording every request.
function fakeGitHub({ run, jobs, issues = [], newerRuns = [] }) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ call: `${init.method} ${pathname}`, query: Object.fromEntries(searchParams), body: init.body && JSON.parse(init.body) });
    if (pathname === `/repos/OriginTrail/dkg/actions/runs/${run.id}`) return json(run);
    if (pathname.startsWith(`/repos/OriginTrail/dkg/actions/runs/${run.id}/attempts/`)) return json({ total_count: jobs.length, jobs });
    if (pathname === '/repos/OriginTrail/dkg/actions/workflows/ci.yml/runs') return json({ total_count: newerRuns.length + 1, workflow_runs: [run, ...newerRuns] });
    if (pathname === '/repos/OriginTrail/dkg/issues' && init.method === 'GET') return json(issues);
    if (pathname === '/repos/OriginTrail/dkg/labels/ci-alert') return json({ message: 'Not Found' }, 404);
    if (pathname === '/repos/OriginTrail/dkg/labels') return json({}, 201);
    if (pathname.startsWith('/repos/OriginTrail/dkg/issues')) return json({ number: 12 }, init.method === 'POST' ? 201 : 200);
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  return { client: createGitHubClient({ token: 't', fetch, sleep: async () => {} }), calls, writes: () => calls.filter(({ call }) => !call.startsWith('GET ')) };
}
const apiRun = (overrides = {}) => ({
  id: 43031937922, run_attempt: 1, event: 'push', head_branch: 'testnet-canary', path: '.github/workflows/ci.yml',
  created_at: '2026-11-11T13:45:01Z', html_url: 'https://github.com/OriginTrail/dkg/actions/runs/43031937922',
  head_sha: 'a6d986be9b691b4f39f43188214249a519cf1294', head_commit: { message: 'Merge pull request #3815\n\nbody' },
  actor: { login: 'branarakic' }, triggering_actor: { login: 'branarakic' }, repository: { full_name: 'OriginTrail/dkg' },
  ...overrides,
});
const env = (overrides = {}) => ({ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'OriginTrail/dkg', GITHUB_RUN_ID: '43031937922', GITHUB_RUN_ATTEMPT: '1', ...overrides });
const quiet = () => {};

test('the alert script opens the issue for a red canary run and closes it on a green one', async () => {
  const gateJob = { ...job(CI_GATE_JOB, 'failure'), completed_at: '2026-11-11T14:34:53Z' };
  const red = fakeGitHub({ run: apiRun(), jobs: [...redJobs.slice(0, -1), gateJob] });
  const plan = await runCanaryAlert({ argv: [], env: env({ CI_GATE_RESULT: 'failure', CI_PROFILE: 'standard' }), client: red.client, log: quiet });
  assert.equal(plan.action, 'open');
  assert.deepEqual(red.writes().map(({ call }) => call), ['POST /repos/OriginTrail/dkg/labels', 'POST /repos/OriginTrail/dkg/issues']);
  const created = red.writes()[1].body;
  assert.equal(created.title, ALERT_TITLE);
  assert.match(created.body, /\) Merge pull request #3815\n/, 'the commit headline, without its body');
  // Newer canary runs are looked up from this run's creation on.
  assert.equal(red.calls.find(({ call }) => call.endsWith('/workflows/ci.yml/runs')).query.created, '>=2026-11-11T13:45:01Z');

  const green = fakeGitHub({ run: apiRun({ id: 43031937922 }), jobs: greenJobs, issues: [{ number: 12, body: created.body }] });
  assert.equal((await runCanaryAlert({ argv: [], env: env({ CI_GATE_RESULT: 'success' }), client: green.client, log: quiet })).action, 'close');
  assert.deepEqual(green.writes().map(({ call, body }) => `${call} ${body.state ?? ''}`.trim()), [
    'POST /repos/OriginTrail/dkg/issues/12/comments',
    'PATCH /repos/OriginTrail/dkg/issues/12 closed',
  ]);
});

test('the alert script leaves superseded runs, other branches and dry runs without a write', async () => {
  const gateJob = { ...job(CI_GATE_JOB, 'failure'), completed_at: '2026-11-11T13:45:25Z' };
  const newer = { id: 43031937923, event: 'push', created_at: '2026-11-11T13:45:10Z', actor: { login: 'branarakic' }, html_url: 'x' };
  const superseded = fakeGitHub({ run: apiRun(), jobs: [gateJob], newerRuns: [newer] });
  assert.equal((await runCanaryAlert({ argv: [], env: env({ CI_GATE_RESULT: 'failure' }), client: superseded.client, log: quiet })).superseded, newer.id);
  assert.deepEqual(superseded.writes(), []);
  // A newer nightly is in another concurrency group, and a run created after the gate finished did not cancel it.
  const unrelated = fakeGitHub({ run: apiRun(), jobs: [gateJob], newerRuns: [
    { ...newer, event: 'workflow_dispatch', actor: { login: 'github-actions[bot]' } },
    { ...newer, id: 43031937924, created_at: '2026-11-11T13:46:00Z' },
  ] });
  assert.equal((await runCanaryAlert({ argv: [], env: env({ CI_GATE_RESULT: 'failure' }), client: unrelated.client, log: quiet })).action, 'open');

  const feature = fakeGitHub({ run: apiRun({ head_branch: 'feature/x', event: 'workflow_dispatch' }), jobs: [] });
  assert.equal((await runCanaryAlert({ argv: [], env: env({ CI_GATE_RESULT: 'failure' }), client: feature.client, log: quiet })).action, 'none');
  assert.deepEqual(feature.writes(), []);

  // A dry run reads the gate and profile from the past run, never from the environment.
  const logs = [];
  const dry = fakeGitHub({ run: apiRun({ event: 'workflow_dispatch', actor: { login: 'github-actions[bot]' }, run_attempt: 2 }), jobs: [...redJobs.slice(0, -1), gateJob] });
  const plan = await runCanaryAlert({
    argv: ['--dry-run', '--repo', 'OriginTrail/dkg', '--run-id', '43031937922'],
    env: { GITHUB_TOKEN: 't', CI_GATE_RESULT: 'success', CI_PROFILE: 'standard', GITHUB_RUN_ATTEMPT: '9' },
    client: dry.client,
    log: (message) => logs.push(message),
  });
  assert.equal(plan.action, 'open');
  assert.deepEqual(readAlertState(plan.body).failing['nightly-equivalent'].run.attempt, 2);
  assert.deepEqual(dry.writes(), []);
  assert.ok(logs.some((message) => message.startsWith('--- Body (open) ---')));
  await assert.rejects(runCanaryAlert({ argv: [], env: { GITHUB_TOKEN: 't' }, client: dry.client, log: quiet }), /needs GITHUB_REPOSITORY and GITHUB_RUN_ID/);
});

test('the ci.yml alert job runs after the gate on protected canary runs only, with its own narrow token', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const workflow = parse(source);
  const alert = workflow.jobs['canary-alert'];
  assert.equal(alert.name, CANARY_ALERT_JOB);
  assert.deepEqual(alert.needs, ['changes', 'ci-gate']);
  assert.equal(workflow.jobs['ci-gate'].needs.includes('canary-alert'), false, 'the alert reports the gate; it is not part of it');
  assert.deepEqual(workflow.permissions, { contents: 'read' }, 'the workflow default stays read-only');
  assert.deepEqual(alert.permissions, { contents: 'read', actions: 'read', issues: 'write' });
  assert.equal(alert['continue-on-error'], true);
  assert.ok(alert['timeout-minutes'] <= 10);
  // A concurrency group would cancel a pending alert job, which turns the run cancelled.
  assert.equal(alert.concurrency, undefined);
  // The profiles the alert tracks are the ones ci.yml resolves.
  assert.deepEqual(PROFILES, workflow.on.workflow_dispatch.inputs.profile.options);

  // Evaluate the job's condition over the events ci.yml takes.
  const expression = alert.if.trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '').replace(/cancelled\(\)/g, 'cancelled');
  const runs = (event, ref, { cancelled = false, repository = 'OriginTrail/dkg' } = {}) => Function('github', 'cancelled', `return (${expression});`)(
    { event_name: event, ref, repository }, cancelled);
  assert.equal(runs('push', 'refs/heads/testnet-canary'), true);
  assert.equal(runs('workflow_dispatch', 'refs/heads/testnet-canary'), true);
  assert.equal(runs('push', 'refs/heads/testnet-canary', { cancelled: true }), false, 'a superseded run is skipped');
  assert.equal(runs('push', 'refs/heads/testnet-canary', { repository: 'someone/fork' }), false);
  for (const [event, ref] of [
    ['pull_request', 'refs/pull/1/merge'],
    ['pull_request', 'refs/heads/testnet-canary'],
    ['merge_group', 'refs/heads/gh-readonly-queue/testnet-canary/pr-1-abc'],
    ['push', 'refs/heads/main'],
    ['workflow_dispatch', 'refs/heads/feature/x'],
  ]) assert.equal(runs(event, ref), false, `${event} ${ref}`);

  // It checks out the tested commit, without credentials, and only the alert script and what it loads.
  const [checkout, setup, notify] = alert.steps;
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.deepEqual(checkout.with['sparse-checkout'].trim().split('\n').sort(), ['.nvmrc', ...importClosure('scripts/ci/canary-alert.mjs')].sort());
  assert.match(setup.uses, /^actions\/setup-node@[0-9a-f]{40}$/);
  assert.equal(notify.run, 'node scripts/ci/canary-alert.mjs');
  assert.deepEqual(notify.env, {
    GITHUB_TOKEN: '${{ github.token }}',
    CI_GATE_RESULT: '${{ needs.ci-gate.result }}',
    CI_PROFILE: "${{ needs.changes.outputs.profile || inputs.profile || 'standard' }}",
  });
});
