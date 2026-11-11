// The red-canary alert: its per-profile issue state machine (canary-alert.mjs),
// the script that applies it (scripts/ci/canary-alert.mjs), and the ci.yml job
// that runs it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { ALERT_ISSUES, ALERT_LABEL, alertIssue, planAlert, PROFILES, readAlertState, renderFailure } from '../canary-alert.mjs';
import { CANARY_ALERT_JOB, CI_GATE_JOB, PROFILE_JOB } from '../ci-health.mjs';
import { createGitHubClient } from '../github-rest.mjs';
import { runCanaryAlert, runProfile } from '../../ci/canary-alert.mjs';
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
const open = (run, jobs = redJobs) => planAlert({ issue: null, run, gateResult: 'failure', jobs });

test('a red run opens its own profile\'s alert with the state, run, commit, actor, and failed jobs and steps', () => {
  const plan = open(reference(101));
  assert.equal(plan.action, 'open');
  assert.equal(plan.title, 'testnet-canary CI is red');
  assert.deepEqual(plan.labels, [ALERT_LABEL.name]);
  assert.ok(plan.body.startsWith(ALERT_ISSUES.standard.marker));
  assert.deepEqual(readAlertState(plan.body, 'standard'), { version: 1, profile: 'standard', since: at(0), run: {
    id: 101, attempt: 1, createdAt: at(0), url: 'https://github.com/OriginTrail/dkg/actions/runs/101',
    sha: '1010000000000000000000000000000000000000', commitUrl: 'https://github.com/OriginTrail/dkg/commit/1010000000000000000000000000000000000000',
  } });
  assert.equal(readAlertState(plan.body, 'nightly-equivalent'), undefined, 'one profile cannot read another\'s issue');
  for (const expected of [
    '**testnet-canary CI is red** for the standard profile (pushes and manual standard dispatches). This issue closes itself when a later standard run passes; the nightly-equivalent profile has its own issue.',
    '- **Red since:** 2026-11-11 10:00 UTC',
    '- **Latest red run:** [CI #101](https://github.com/OriginTrail/dkg/actions/runs/101) at [`1010000000`](https://github.com/OriginTrail/dkg/commit/1010000000000000000000000000000000000000)',
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

  const nightly = open(reference(102, { profile: 'nightly-equivalent', event: 'workflow_dispatch' }));
  assert.equal(nightly.title, 'testnet-canary nightly is red');
  assert.ok(nightly.body.startsWith(ALERT_ISSUES['nightly-equivalent'].marker));
  assert.match(nightly.body, /for the nightly-equivalent profile \(the nightly and manual nightly-equivalent dispatches\)\. This issue closes itself when a later nightly-equivalent run passes; the standard profile has its own issue\./);
  assert.equal(readAlertState(nightly.body, 'standard'), undefined);
  // A run the alert cannot place is an error, not a guess.
  assert.throws(() => open(reference(103, { profile: 'nightly' })), /unknown CI profile: nightly/);
  assert.throws(() => alertIssue('toString'), /unknown CI profile/);
});

test('later runs of a profile comment while it stays red, and its next pass closes it', () => {
  const opened = open(reference(101, { created: 0 }));
  const issue = (plan) => ({ number: 7, body: plan.body });
  const again = planAlert({ issue: issue(opened), run: reference(102, { created: 60 }), gateResult: 'failure', jobs: redJobs });
  assert.equal(again.action, 'comment');
  assert.match(again.comment, /^### Still red: \[CI #102\]/);
  assert.deepEqual([again.state.since, again.state.run.id], [at(0), 102]);
  assert.ok(again.body.includes('- **Latest red run:** [CI #102]') && again.body.includes('- **Run:** [CI #102]'));
  assert.equal(again.body.match(/_Opened, commented on/g).length, 1);
  // A timed-out gate is red too.
  assert.equal(planAlert({ issue: issue(again), run: reference(103, { created: 90 }), gateResult: 'cancelled', jobs: redJobs }).action, 'comment');
  const closed = planAlert({ issue: issue(again), run: reference(104, { created: 120 }), gateResult: 'success', jobs: greenJobs });
  assert.equal(closed.action, 'close');
  assert.match(closed.comment, /^\*\*Green again:\*\* \[CI #104\]\(.+\) \(`push`, standard profile\) passed at .+ Closing\.$/);
});

test('within a profile, an older run\'s pass proves nothing about a newer red one, and a late old failure keeps the newer run', () => {
  const opened = open(reference(201, { created: 100 }));
  const issue = { number: 8, body: opened.body };
  const stale = planAlert({ issue, run: reference(200, { created: 50 }), gateResult: 'success', jobs: greenJobs });
  assert.equal(stale.action, 'none');
  assert.match(stale.reason, /#8 records a newer red run \(#201\)/);
  // A re-run attempt of the same red run that passes clears it.
  assert.equal(planAlert({ issue, run: reference(201, { created: 100, attempt: 2 }), gateResult: 'success', jobs: greenJobs }).action, 'close');
  const late = planAlert({ issue, run: reference(199, { created: 20 }), gateResult: 'failure', jobs: redJobs });
  assert.equal(late.action, 'comment');
  assert.deepEqual([late.state.since, late.state.run.id], [at(20), 201]);
  assert.ok(late.body.includes('- **Run:** [CI #201]') && !late.body.includes('- **Run:** [CI #199]'), 'the details stay on the newer run');
  assert.match(late.comment, /^### Still red: \[CI #199\]/);
});

test('a skipped or missing gate does nothing, and an issue whose state is unreadable closes on any pass of its profile', () => {
  for (const gateResult of ['skipped', '', undefined]) {
    assert.equal(planAlert({ issue: null, run: reference(1), gateResult, jobs: [] }).action, 'none', String(gateResult));
  }
  assert.equal(planAlert({ issue: null, run: reference(1), gateResult: 'success', jobs: greenJobs }).action, 'none');
  const marker = ALERT_ISSUES.standard.marker;
  const broken = { number: 9, body: `${marker}{not json} -->\nsomeone edited this` };
  assert.equal(readAlertState(broken.body, 'standard'), undefined);
  assert.equal(planAlert({ issue: broken, run: reference(2), gateResult: 'success', jobs: greenJobs }).action, 'close');
  const rebuilt = planAlert({ issue: broken, run: reference(3), gateResult: 'failure', jobs: redJobs });
  assert.deepEqual([rebuilt.action, rebuilt.state.since, rebuilt.state.run.id], ['comment', at(0), 3]);
  for (const state of [{ version: 1, profile: 'standard', since: 'soon', run: { createdAt: at(0) } }, { version: 1, profile: 'nightly-equivalent', since: at(0), run: { createdAt: at(0) } }]) {
    assert.equal(readAlertState(`${marker}${JSON.stringify(state)} -->`, 'standard'), undefined, JSON.stringify(state));
  }
  // No recorded value can end the state comment early.
  const hostile = open({ ...reference(4), url: 'https://github.com/x --> <img>' });
  assert.equal(readAlertState(hostile.body, 'standard').run.url, 'https://github.com/x --> <img>');
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

const apiRun = (overrides = {}) => ({
  id: 43031937922, run_attempt: 1, event: 'push', head_branch: 'testnet-canary', status: 'in_progress', conclusion: null,
  path: '.github/workflows/ci.yml', created_at: '2026-11-11T13:45:01Z', html_url: 'https://github.com/OriginTrail/dkg/actions/runs/43031937922',
  head_sha: 'a6d986be9b691b4f39f43188214249a519cf1294', head_commit: { message: 'Merge pull request #3815\n\nbody' },
  actor: { login: 'branarakic' }, triggering_actor: { login: 'branarakic' }, repository: { full_name: 'OriginTrail/dkg' },
  ...overrides,
});
const nightlyRun = (overrides = {}) => apiRun({
  id: 42551086687, event: 'workflow_dispatch', created_at: '2026-11-11T02:27:58Z', html_url: 'https://github.com/OriginTrail/dkg/actions/runs/42551086687',
  actor: { login: 'github-actions[bot]' }, triggering_actor: { login: 'github-actions[bot]' }, head_commit: { message: 'Merge pull request #3719' },
  ...overrides,
});
const env = (run, overrides = {}) => ({ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'OriginTrail/dkg', GITHUB_RUN_ID: String(run.id), GITHUB_RUN_ATTEMPT: String(run.run_attempt), ...overrides });
const quiet = () => {};

// A GitHub whose runs, jobs, issues, comments and labels every caller shares.
// Each caller gets its own client, so each request is attributed to it, and
// `beforeIssueList` can hold the open-issue listing (to make callers overlap).
// The listing answers with the issues open when it is answered.
function sharedGitHub({ runs, issues = [], labels = [], beforeIssueList }) {
  const state = {
    issues: issues.map((issue) => ({ state: 'open', labels: [{ name: ALERT_LABEL.name }], comments: [], ...issue })),
    labels: new Set(labels),
    next: 100,
  };
  const requests = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const answer = async (caller, method, pathname, body) => {
    const route = `${method} ${pathname.replace('/repos/OriginTrail/dkg', '')}`;
    requests.push({ caller, route, body });
    let match;
    if ((match = /^GET \/actions\/runs\/(\d+)$/.exec(route))) return json(runs[match[1]].run);
    if ((match = /^GET \/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(route))) return json(runs[match[1]].attempts?.[match[2]] ?? runs[match[1]].run);
    if ((match = /^GET \/actions\/runs\/(\d+)\/attempts\/\d+\/jobs$/.exec(route))) return json({ total_count: runs[match[1]].jobs.length, jobs: runs[match[1]].jobs });
    if (route === 'GET /issues') {
      await beforeIssueList?.(caller);
      return json(state.issues.filter((issue) => issue.state === 'open').map(({ number, title, body, labels: names }) => ({ number, title, body, labels: names })));
    }
    if (route === `GET /labels/${ALERT_LABEL.name}`) return state.labels.has(ALERT_LABEL.name) ? json({ name: ALERT_LABEL.name }) : json({ message: 'Not Found' }, 404);
    if (route === 'POST /labels') {
      if (state.labels.has(body.name)) return json({ message: 'Validation Failed' }, 422);
      state.labels.add(body.name);
      return json(body, 201);
    }
    if (route === 'POST /issues') {
      const issue = { number: state.next++, title: body.title, body: body.body, labels: body.labels.map((name) => ({ name })), state: 'open', comments: [], openedBy: caller };
      state.issues.push(issue);
      return json(issue, 201);
    }
    const issue = state.issues.find(({ number }) => number === Number(/^\w+ \/issues\/(\d+)/.exec(route)?.[1]));
    if (issue && /^PATCH \/issues\/\d+$/.test(route)) return json(Object.assign(issue, body));
    if (issue && /^POST \/issues\/\d+\/comments$/.test(route)) {
      issue.comments.push(body.body);
      return json({}, 201);
    }
    throw new Error(`unexpected ${route}`);
  };
  const clientFor = (caller) => createGitHubClient({
    token: 't',
    sleep: async () => {},
    fetch: async (url, init) => answer(caller, init.method, new URL(url).pathname, init.body && JSON.parse(init.body)),
  });
  const writes = (caller) => requests.filter((request) => request.caller === caller && !request.route.startsWith('GET ')).map(({ route }) => route);
  return { state, requests, clientFor, writes, openIssues: () => state.issues.filter((issue) => issue.state === 'open') };
}

// Both callers listed the open issues before either wrote anything.
function assertOverlapped(api) {
  const firstWrite = api.requests.findIndex(({ route }) => !route.startsWith('GET '));
  const listings = api.requests.flatMap(({ route }, index) => (route === 'GET /issues' ? [index] : []));
  assert.equal(listings.length, 2);
  assert.ok(firstWrite > Math.max(...listings), 'both read before either wrote');
}

// Holds each caller until `count` have arrived, so all have read before any
// writes; fails, rather than hangs, if one never arrives.
function barrier(count) {
  let arrived = 0;
  let release;
  const all = new Promise((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === count) release();
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${arrived} of ${count} callers reached the barrier`)), 2000); });
    try {
      await Promise.race([all, late]);
    } finally {
      clearTimeout(timer);
    }
  };
}

const gate = (conclusion, completedAt = '2026-11-11T14:34:53Z') => ({ ...job(CI_GATE_JOB, conclusion), completed_at: completedAt });

test('the alert script opens its profile\'s issue for a red canary run and closes it on a green one, with no look at other runs', async () => {
  const red = apiRun();
  const api = sharedGitHub({ runs: { [red.id]: { run: red, jobs: [...redJobs.slice(0, -1), gate('failure')] } } });
  const plan = await runCanaryAlert({ argv: [], env: env(red, { CI_GATE_RESULT: 'failure', CI_PROFILE: 'standard' }), client: api.clientFor('red'), log: quiet });
  assert.equal(plan.action, 'open');
  assert.deepEqual(api.writes('red'), ['POST /labels', 'POST /issues']);
  const [created] = api.openIssues();
  assert.equal(created.title, 'testnet-canary CI is red');
  assert.match(created.body, /\) Merge pull request #3815\n/, 'the commit headline, without its body');
  assert.equal(readAlertState(created.body, 'standard').run.id, red.id);
  // No supersede check: a red push alerts even with newer runs queued behind it.
  assert.ok(api.requests.every(({ route }) => !route.includes('/workflows/')), 'other runs are never listed');

  const green = apiRun({ id: 43031937999, created_at: '2026-11-11T15:00:00Z' });
  const greenApi = sharedGitHub({ runs: { [green.id]: { run: green, jobs: greenJobs } }, issues: [{ number: 12, title: created.title, body: created.body }], labels: [ALERT_LABEL.name] });
  assert.equal((await runCanaryAlert({ argv: [], env: env(green, { CI_GATE_RESULT: 'success', CI_PROFILE: 'standard' }), client: greenApi.clientFor('green'), log: quiet })).action, 'close');
  assert.deepEqual(greenApi.writes('green'), ['POST /issues/12/comments', 'PATCH /issues/12']);
  assert.equal(greenApi.state.issues[0].state, 'closed');
});

test('a pass closes only its own profile\'s issue: a green nightly leaves a red push open, and the other way round', async () => {
  const standardBody = open(reference(301, { created: 0 })).body;
  const nightlyBody = open(reference(302, { created: 0, profile: 'nightly-equivalent', event: 'workflow_dispatch' })).body;
  // Both issues open, in a fresh API each time.
  const issues = [{ number: 1, title: 'testnet-canary CI is red', body: standardBody }, { number: 2, title: 'testnet-canary nightly is red', body: nightlyBody }];
  const pass = async (run, profile) => {
    const api = sharedGitHub({ runs: { [run.id]: { run, jobs: greenJobs } }, issues, labels: [ALERT_LABEL.name] });
    await runCanaryAlert({ argv: [], env: env(run, { CI_GATE_RESULT: 'success', CI_PROFILE: profile }), client: api.clientFor(profile), log: quiet });
    return api.state.issues.map(({ number, state }) => `${number} ${state}`);
  };
  assert.deepEqual(await pass(nightlyRun({ id: 303, created_at: at(60) }), 'nightly-equivalent'), ['1 open', '2 closed']);
  assert.deepEqual(await pass(apiRun({ id: 304, created_at: at(90) }), 'standard'), ['1 closed', '2 open']);
});

test('overlapping standard and nightly alert jobs, both reading before either writes, each keep to their own issue', async () => {
  // A standard issue is open. A standard pass and a nightly failure finish
  // together: different concurrency groups, so their alert jobs overlap.
  const standardBody = open(reference(401, { created: 0 })).body;
  const pass = apiRun({ id: 402, created_at: at(60) });
  const fail = nightlyRun({ id: 403, created_at: at(30) });
  const runs = { 402: { run: pass, jobs: greenJobs }, 403: { run: fail, jobs: [...redJobs.slice(0, -1), gate('failure')] } };
  const api = sharedGitHub({ runs, issues: [{ number: 1, title: 'testnet-canary CI is red', body: standardBody }], labels: [ALERT_LABEL.name], beforeIssueList: barrier(2) });
  const [standard, nightly] = await Promise.all([
    runCanaryAlert({ argv: [], env: env(pass, { CI_GATE_RESULT: 'success', CI_PROFILE: 'standard' }), client: api.clientFor('standard'), log: quiet }),
    runCanaryAlert({ argv: [], env: env(fail, { CI_GATE_RESULT: 'failure', CI_PROFILE: 'nightly-equivalent' }), client: api.clientFor('nightly'), log: quiet }),
  ]);
  assertOverlapped(api);
  assert.deepEqual([standard.action, nightly.action], ['close', 'open']);
  const [standardIssue, ...rest] = api.state.issues;
  assert.equal(standardIssue.state, 'closed');
  assert.match(standardIssue.comments.at(-1), /^\*\*Green again:\*\* \[CI #402\]/);
  assert.equal(rest.length, 1, 'one new issue');
  const [nightlyIssue] = api.openIssues();
  assert.equal(nightlyIssue.title, 'testnet-canary nightly is red');
  assert.equal(readAlertState(nightlyIssue.body, 'nightly-equivalent').run.id, 403);
  // Neither job wrote the other's issue.
  assert.deepEqual(api.writes('standard'), ['POST /issues/1/comments', 'PATCH /issues/1']);
  assert.deepEqual(api.writes('nightly'), ['POST /issues']);
  assert.equal(nightlyIssue.openedBy, 'nightly');
});

test('two profiles opening at once, both reading before either writes, open two issues and lose neither', async () => {
  const push = apiRun({ id: 501, created_at: at(0) });
  const night = nightlyRun({ id: 502, created_at: at(5) });
  const runs = { 501: { run: push, jobs: [...redJobs.slice(0, -1), gate('failure')] }, 502: { run: night, jobs: [...redJobs.slice(0, -1), gate('cancelled')] } };
  const api = sharedGitHub({ runs, beforeIssueList: barrier(2) });
  const plans = await Promise.all([
    runCanaryAlert({ argv: [], env: env(push, { CI_GATE_RESULT: 'failure', CI_PROFILE: 'standard' }), client: api.clientFor('standard'), log: quiet }),
    runCanaryAlert({ argv: [], env: env(night, { CI_GATE_RESULT: 'cancelled', CI_PROFILE: 'nightly-equivalent' }), client: api.clientFor('nightly'), log: quiet }),
  ]);
  assertOverlapped(api);
  assert.deepEqual(plans.map(({ action }) => action), ['open', 'open']);
  const issues = api.openIssues();
  assert.equal(issues.length, 2);
  assert.notEqual(issues[0].number, issues[1].number);
  const byProfile = Object.fromEntries(PROFILES.map((profile) => [profile, issues.filter(({ body }) => readAlertState(body, profile))]));
  assert.deepEqual(Object.fromEntries(Object.entries(byProfile).map(([profile, found]) => [profile, found.map(({ title, openedBy, body }) => [title, openedBy, readAlertState(body, profile).run.id])])), {
    standard: [['testnet-canary CI is red', 'standard', 501]],
    'nightly-equivalent': [['testnet-canary nightly is red', 'nightly', 502]],
  });
  // Both may try to create the missing label; one wins and the other's 422 is fine.
  assert.ok(api.state.labels.has(ALERT_LABEL.name));
});

test('the alert script skips other branches, and a dry run skips a cancelled run and writes nothing', async () => {
  const feature = apiRun({ head_branch: 'feature/x', event: 'workflow_dispatch' });
  const featureApi = sharedGitHub({ runs: { [feature.id]: { run: feature, jobs: [] } } });
  assert.equal((await runCanaryAlert({ argv: [], env: env(feature, { CI_GATE_RESULT: 'failure', CI_PROFILE: 'standard' }), client: featureApi.clientFor('x'), log: quiet })).action, 'none');
  assert.deepEqual(featureApi.writes('x'), []);

  const dry = (run, argv = [], extra = {}) => {
    const api = sharedGitHub({ runs: { [run.id]: { run, jobs: [...redJobs.slice(0, -1), gate('failure')], attempts: extra.attempts } } });
    const logs = [];
    return runCanaryAlert({
      argv: ['--dry-run', '--repo', 'OriginTrail/dkg', '--run-id', String(run.id), ...argv],
      env: { GITHUB_TOKEN: 't', CI_GATE_RESULT: 'success', GITHUB_RUN_ATTEMPT: '9', ...extra.env },
      client: api.clientFor('dry'),
      log: (message) => logs.push(message),
    }).then((plan) => ({ plan, logs, api }));
  };
  // The live job skips a cancelled run (`!cancelled()`), so a dry run of one does nothing.
  const cancelled = await dry(apiRun({ status: 'completed', conclusion: 'cancelled' }));
  assert.equal(cancelled.plan.action, 'none');
  assert.match(cancelled.logs[0], /was cancelled: a dry run of a cancelled run does nothing/);
  assert.ok(cancelled.api.requests.every(({ route }) => !route.endsWith('/jobs')));
  // The attempt asked for is the one whose conclusion counts.
  const rerun = apiRun({ status: 'completed', conclusion: 'success', run_attempt: 2 });
  assert.equal((await dry(rerun, ['--attempt', '1'], { attempts: { 1: { ...rerun, run_attempt: 1, conclusion: 'cancelled' } } })).plan.action, 'none');

  // A dry run reads the gate from the past run (red here), not this shell's
  // CI_GATE_RESULT, and guesses the profile from the run only without
  // --profile or CI_PROFILE.
  const night = await dry(nightlyRun({ status: 'completed', conclusion: 'failure' }));
  assert.equal(night.plan.action, 'open');
  assert.equal(night.plan.title, 'testnet-canary nightly is red');
  assert.deepEqual(night.api.writes('dry'), []);
  assert.ok(night.logs.some((message) => message.startsWith('--- Body (open) ---')));
  assert.equal((await dry(nightlyRun({ status: 'completed', conclusion: 'failure' }), ['--profile', 'standard'])).plan.title, 'testnet-canary CI is red');
  assert.equal((await dry(nightlyRun({ status: 'completed', conclusion: 'failure' }), [], { env: { CI_PROFILE: 'standard' } })).plan.title, 'testnet-canary CI is red');
  await assert.rejects(runCanaryAlert({ argv: [], env: { GITHUB_TOKEN: 't' }, client: featureApi.clientFor('x'), log: quiet }), /needs GITHUB_REPOSITORY and GITHUB_RUN_ID/);
});

test('the live job takes its profile from ci.yml and never guesses one; a dry run guesses as the report does', () => {
  const push = apiRun();
  const manualNightly = nightlyRun({ actor: { login: 'dev' }, triggering_actor: { login: 'dev' } });
  assert.equal(runProfile({ option: undefined, env: { CI_PROFILE: 'nightly-equivalent' }, live: true, run: manualNightly }), 'nightly-equivalent');
  assert.equal(runProfile({ option: 'standard', env: { CI_PROFILE: 'nightly-equivalent' }, live: true, run: push }), 'standard');
  for (const env of [{}, { CI_PROFILE: '' }]) {
    assert.throws(() => runProfile({ option: undefined, env, live: true, run: nightlyRun() }), /needs --profile or CI_PROFILE/);
  }
  assert.throws(() => runProfile({ option: 'nightly', env: {}, live: true, run: push }), /not nightly/);
  // The dry-run guess is the report's runKind: a nightly-ci.yml dispatch,
  // by actor or by triggering actor.
  assert.equal(runProfile({ option: undefined, env: {}, live: false, run: nightlyRun() }), 'nightly-equivalent');
  assert.equal(runProfile({ option: undefined, env: {}, live: false, run: nightlyRun({ actor: { login: 'dev' } }) }), 'nightly-equivalent');
  assert.equal(runProfile({ option: undefined, env: {}, live: false, run: manualNightly }), 'standard');
  assert.equal(runProfile({ option: undefined, env: {}, live: false, run: push }), 'standard');
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
  // Runs of one profile share the workflow's concurrency group, one at a time,
  // and each profile has its own issue, so no job lock is needed; one would
  // cancel a pending alert job, which turns the run cancelled.
  assert.equal(alert.concurrency, undefined);
  assert.match(workflow.concurrency.group, /'nightly-equivalent' \|\| 'standard'/, 'the workflow groups runs by profile');
  // The profiles the alert files under are the ones ci.yml resolves, each with
  // its own title and a marker no other profile's issue can contain.
  assert.deepEqual(PROFILES, workflow.on.workflow_dispatch.inputs.profile.options);
  assert.deepEqual(Object.keys(ALERT_ISSUES), PROFILES);
  for (const profile of PROFILES) {
    for (const other of PROFILES.filter((name) => name !== profile)) {
      assert.equal(ALERT_ISSUES[profile].marker.includes(ALERT_ISSUES[other].marker), false, `${profile} ${other}`);
      assert.notEqual(ALERT_ISSUES[profile].title, ALERT_ISSUES[other].title);
    }
  }

  // Evaluate the job's condition over the events ci.yml takes.
  const expression = alert.if.trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '').replace(/cancelled\(\)/g, 'cancelled');
  const runs = (event, ref, { cancelled = false, repository = 'OriginTrail/dkg' } = {}) => Function('github', 'cancelled', `return (${expression});`)(
    { event_name: event, ref, repository }, cancelled);
  assert.equal(runs('push', 'refs/heads/testnet-canary'), true);
  assert.equal(runs('workflow_dispatch', 'refs/heads/testnet-canary'), true);
  assert.equal(runs('push', 'refs/heads/testnet-canary', { cancelled: true }), false, 'a cancelled run is skipped');
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
