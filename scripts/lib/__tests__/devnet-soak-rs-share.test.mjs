// The RS soak's share step (scripts/devnet-soak-rs-share.mjs) follows a node's
// answers on their status and recovery fields alone: a share job that owns the
// share is waited for until it settles, a retryable answer that names no job
// is shared again on the same draft at most five times, and anything else is
// final.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RECOVERY_WAIT_SEC, fixtureQuads, followShareJob, nodeApiBase, publishLogFields, recoveryWaitSec,
  shareDisposition, shareWithClientRule,
} from '../../devnet-soak-rs-share.mjs';
import {
  createdShareErrorAnswer, createPendingAnswer, jobUrl, ownerConflictAnswer, prerequisiteAnswer,
  recoveryRequiredAnswer, sharedAnswer, standInNode,
} from './devnet-soak-rs-stand-ins.mjs';

const SHARE_STEP = fileURLToPath(new URL('../../devnet-soak-rs-share.mjs', import.meta.url));
const NAME = 'soak-9-0-1-0-1';
const SUBJECT = 'urn:soak:r9:i0:1-0-1';
// What the publisher writes for its first attempt of round 9.
const FIXTURE = `<${SUBJECT}> <urn:soak:predicate> "value-0" .
<${SUBJECT}> <urn:soak:round> "9" .
<${SUBJECT}> <urn:soak:emittedAt> "2026-11-27T10:00:00Z" .
`;
const QUADS = [
  { subject: SUBJECT, predicate: 'urn:soak:predicate', object: '"value-0"', graph: '' },
  { subject: SUBJECT, predicate: 'urn:soak:round', object: '"9"', graph: '' },
  { subject: SUBJECT, predicate: 'urn:soak:emittedAt', object: '"2026-11-27T10:00:00Z"', graph: '' },
];

test('the answer\'s status and recovery fields decide, whatever its message says', () => {
  const cases = [
    [sharedAnswer(201), {}, 'shared'],
    [sharedAnswer(), {}, 'shared'],
    [{ status: 200, body: { swmShared: true, publishReady: false } }, {}, 'final'],
    [{ status: 200, body: { swmShared: false } }, {}, 'final'],
    [createPendingAnswer('job-1'), { createAnswer: true }, 'follow'],
    [ownerConflictAnswer('job-1'), {}, 'follow'],
    // A job that failed or finished: its state decides, so it is followed too.
    [{ status: 409, body: { code: 'SHARE_OWNER_CONFLICT', retryable: false, recoveryJobId: 'job-1', recoveryState: 'inspection-required', recoveryStatusUrl: jobUrl('job-1') } }, {}, 'follow'],
    [prerequisiteAnswer(), {}, 'repeat'],
    [{ status: 503, body: { code: 'SHARE_RECOVERY_UNAVAILABLE', error: 'no worker', retryable: true } }, {}, 'repeat'],
    // A status URL outside the node's API is not followed.
    [{ status: 503, body: { retryable: true, recoveryStatusUrl: 'http://elsewhere.test/job' } }, {}, 'repeat'],
    [createdShareErrorAnswer(), { createAnswer: true }, 'repeat'],
    [createdShareErrorAnswer(), {}, 'final'],
    [recoveryRequiredAnswer(), {}, 'final'],
    [{ status: 400, body: { error: 'Context graph not found' } }, { createAnswer: true }, 'final'],
    [{ status: 503, body: null }, {}, 'final'],
    [{ error: 'fetch failed: connect ECONNREFUSED 127.0.0.1:9' }, {}, 'final'],
  ];
  const reworded = (answer) => {
    if (!answer.body) return answer;
    const body = { ...answer.body, ...(answer.body.error ? { error: 'any other words' } : {}) };
    if (body.errors) body.errors = body.errors.map((error) => ({ ...error, error: 'any other words' }));
    return { ...answer, body };
  };
  for (const [answer, options, kind] of cases) {
    assert.equal(shareDisposition(answer, options).kind, kind, JSON.stringify(answer));
    assert.equal(shareDisposition(reworded(answer), options).kind, kind, `reworded: ${JSON.stringify(answer)}`);
  }
  assert.deepEqual(shareDisposition(ownerConflictAnswer('job 2')), { kind: 'follow', jobId: 'job 2', url: jobUrl('job 2') });
});

// A node driven by planned answers: every request, wait and followed job is recorded.
function plannedNode(answers, jobStates = {}) {
  const node = { sent: [], waits: [], followed: [] };
  node.send = async (request) => {
    node.sent.push(request);
    return answers.shift() ?? { status: 500, body: { error: 'unplanned request' } };
  };
  node.follow = async (job) => {
    node.followed.push(job.jobId);
    const state = jobStates[job.jobId] ?? 'running';
    return { job: job.jobId, state, settled: state === 'succeeded' || state === 'failed', attempts: 2, polls: 3, waited_s: 64 };
  };
  node.sleep = async (ms) => { node.waits.push(ms); };
  return node;
}
async function share(node) {
  const progress = {};
  const shared = await shareWithClientRule({
    contextGraphId: 'devnet-test', name: NAME, quads: QUADS, send: node.send, follow: node.follow, sleep: node.sleep, progress,
  });
  return { shared, shareRetries: progress.shareRetries, recovery: progress.recovery?.state ?? null,
    requests: node.sent.map((request) => request.path.endsWith('/swm/share') ? 'share' : 'create'), waits: node.waits, followed: node.followed };
}

test('a share left to a pending share job is waited for, and the job decides', async () => {
  assert.deepEqual(await share(plannedNode([createPendingAnswer('job-1')], { 'job-1': 'succeeded' })),
    { shared: true, shareRetries: 0, recovery: 'succeeded', requests: ['create'], waits: [], followed: ['job-1'] });
  assert.deepEqual(await share(plannedNode([createPendingAnswer('job-1')], { 'job-1': 'failed' })),
    { shared: false, shareRetries: 0, recovery: 'failed', requests: ['create'], waits: [], followed: ['job-1'] });
  assert.deepEqual(await share(plannedNode([createPendingAnswer('job-1')], { 'job-1': 'running' })),
    { shared: false, shareRetries: 0, recovery: 'running', requests: ['create'], waits: [], followed: ['job-1'] });
});

test('a prerequisite failure, then a pending owner, then a recovery that succeeds: the asset is shared', async () => {
  const node = plannedNode([prerequisiteAnswer(), ownerConflictAnswer('job-2')], { 'job-2': 'succeeded' });
  assert.deepEqual(await share(node),
    { shared: true, shareRetries: 1, recovery: 'succeeded', requests: ['create', 'share'], waits: [1000], followed: ['job-2'] });
  // The create is the request `dkg ka create --share` sends; the share is `dkg ka share`'s, for the same draft.
  assert.deepEqual(node.sent, [
    { path: '/api/knowledge-assets', body: { contextGraphId: 'devnet-test', name: NAME, quads: QUADS, alsoShareSwm: true } },
    { path: `/api/knowledge-assets/${NAME}/swm/share`, body: { contextGraphId: 'devnet-test' } },
  ]);
  assert.deepEqual(await share(plannedNode([prerequisiteAnswer(), ownerConflictAnswer('job-2')], { 'job-2': 'failed' })),
    { shared: false, shareRetries: 1, recovery: 'failed', requests: ['create', 'share'], waits: [1000], followed: ['job-2'] });
});

test('a create whose share failed before a job existed is shared explicitly, and that answer decides', async () => {
  assert.deepEqual(await share(plannedNode([createdShareErrorAnswer(), sharedAnswer()])),
    { shared: true, shareRetries: 1, recovery: null, requests: ['create', 'share'], waits: [1000], followed: [] });
  assert.deepEqual(await share(plannedNode([createdShareErrorAnswer('Context graph not registered'), recoveryRequiredAnswer()])),
    { shared: false, shareRetries: 1, recovery: null, requests: ['create', 'share'], waits: [1000], followed: [] });
});

test('a node that keeps answering retryable with no job gets five more shares, never another create', async () => {
  const answers = Array.from({ length: 7 }, () => prerequisiteAnswer());
  assert.deepEqual(await share(plannedNode(answers)), {
    shared: false, shareRetries: 5, recovery: null, requests: ['create', 'share', 'share', 'share', 'share', 'share'],
    waits: [1000, 2000, 3000, 4000, 5000], followed: [],
  });
  assert.equal(answers.length, 1, 'no request after the fifth share');
});

test('a final answer is not shared again', async () => {
  for (const answers of [
    [recoveryRequiredAnswer()],
    [{ status: 400, body: { error: 'Context graph not found' } }],
    [{ error: 'fetch failed: connect ECONNREFUSED 127.0.0.1:9' }],
  ]) {
    assert.deepEqual(await share(plannedNode(answers)),
      { shared: false, shareRetries: 0, recovery: null, requests: ['create'], waits: [], followed: [] }, JSON.stringify(answers));
  }
  assert.deepEqual(await share(plannedNode([prerequisiteAnswer(), { status: 400, body: { error: 'Draft not found' } }])),
    { shared: false, shareRetries: 1, recovery: null, requests: ['create', 'share'], waits: [1000], followed: [] });
});

// pollShareRecoveries on a made-up clock: a 5 s poll interval, and a job that
// fails its first attempt and succeeds when the queue retries it a minute later.
async function followOnClock(states, budgetMs = DEFAULT_RECOVERY_WAIT_SEC * 1000) {
  let clock = 0;
  const seen = [];
  const record = await followShareJob({ jobId: 'job-3', url: jobUrl('job-3') }, {
    api: 'http://node.test/', auth: 'fixture-token', budgetMs,
    pollOptions: {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      getJson: async (url, { headers }) => {
        seen.push([url, headers.Authorization]);
        return { jobId: 'job-3', state: states(clock), attempts: clock < 62_000 ? 1 : 2 };
      },
    },
  });
  return { record, seen };
}

test('a share job is followed through its first retry, about a minute later', async () => {
  const retried = (ms) => (ms < 2_000 ? 'running' : ms < 62_000 ? 'failed_retrying' : ms < 64_000 ? 'running' : 'succeeded');
  const { record, seen } = await followOnClock(retried);
  assert.deepEqual(record, { job: 'job-3', state: 'succeeded', settled: true, attempts: 2, polls: 14, waited_s: 65 });
  assert.deepEqual(seen[0], [`http://node.test${jobUrl('job-3')}`, 'Bearer fixture-token']);

  const failed = await followOnClock((ms) => (ms < 62_000 ? 'failed_retrying' : 'failed'));
  assert.deepEqual([failed.record.state, failed.record.settled, failed.record.waited_s], ['failed', true, 65]);

  const unsettled = await followOnClock(() => 'failed_retrying');
  assert.deepEqual([unsettled.record.state, unsettled.record.settled, unsettled.record.waited_s], ['failed_retrying', false, 300]);
});

test('the wait for a share job is 300 s unless SOAK_SHARE_RECOVERY_WAIT_SEC sets whole seconds', () => {
  assert.equal(recoveryWaitSec({}), 300);
  assert.equal(recoveryWaitSec({ SOAK_SHARE_RECOVERY_WAIT_SEC: '' }), 300);
  assert.equal(recoveryWaitSec({ SOAK_SHARE_RECOVERY_WAIT_SEC: '0' }), 0);
  assert.equal(recoveryWaitSec({ SOAK_SHARE_RECOVERY_WAIT_SEC: '900' }), 900);
  for (const value of ['-1', '1.5', '60s', ' 60', '0900', '1e3', 'abc']) {
    assert.throws(() => recoveryWaitSec({ SOAK_SHARE_RECOVERY_WAIT_SEC: value }), /must be a whole number of seconds/, value);
  }
});

test('the fixture becomes the quads the CLI would send, and other lines are refused', () => {
  assert.deepEqual(fixtureQuads(FIXTURE), QUADS);
  for (const line of [`<${SUBJECT}> <urn:soak:p> "a\\"b" .`, `<${SUBJECT}> <urn:soak:p> <urn:soak:o> .`, `${SUBJECT} <urn:soak:p> "x" .`]) {
    assert.throws(() => fixtureQuads(line), /unsupported fixture line/, line);
  }
});

test('the node is found as the CLI finds it, and its absence is reported in the CLI\'s words', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'dkg-soak-share-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.throws(() => nodeApiBase(home), { message: `Daemon is not running at ${home}.` });
  writeFileSync(path.join(home, 'daemon.pid'), `${process.pid}\n`);
  assert.throws(() => nodeApiBase(home), { message: `Cannot read API port in ${home}.` });
  writeFileSync(path.join(home, 'api.port'), '9203\n');
  assert.equal(nodeApiBase(home), 'http://127.0.0.1:9203');
});

test('the publish-log fields are JSON members', () => {
  assert.equal(publishLogFields({}), '"share_retries":0,"share_recovery":null');
  const record = { job: 'job-"4"', state: 'succeeded', settled: true, attempts: 2, polls: 1, waited_s: 0 };
  assert.deepEqual(JSON.parse(`{${publishLogFields({ shareRetries: 2, recovery: record })}}`), { share_retries: 2, share_recovery: record });
});

async function collect(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

// The share step as the publisher runs it, against a stand-in node.
async function runShareStep(t, plan) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dkg-soak-share-step-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const node = await standInNode(t, plan);
  const home = path.join(dir, 'node1');
  mkdirSync(home);
  writeFileSync(path.join(home, 'api.port'), `${node.port}\n`);
  const fixture = path.join(dir, 'q0.nt');
  const fields = path.join(dir, 'share0.json');
  writeFileSync(fixture, FIXTURE);
  // A share step that never exits is stopped after 30 s, so the test fails instead of hanging.
  const child = spawn(process.execPath, [SHARE_STEP, home, 'devnet-test', NAME, fixture, fields], {
    env: { ...process.env, SOAK_API_AUTH: 'fixture-token', SOAK_SHARE_RECOVERY_WAIT_SEC: '20' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  const result = await collect(child);
  return { ...result, requests: node.requests, fields: JSON.parse(`{${readFileSync(fields, 'utf8')}}`) };
}

test('run as the publisher runs it, the step follows a pending owner to a shared asset', async (t) => {
  const run = await runShareStep(t, { create: [prerequisiteAnswer()], share: [ownerConflictAnswer('job-7')], jobs: { 'job-7': ['succeeded'] } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(run.requests.map(({ method, path: route, auth }) => [method, route, auth]), [
    ['POST', '/api/knowledge-assets', 'Bearer fixture-token'],
    ['POST', `/api/knowledge-assets/${NAME}/swm/share`, 'Bearer fixture-token'],
    ['GET', jobUrl('job-7'), 'Bearer fixture-token'],
  ]);
  assert.deepEqual(run.requests[0].body, { contextGraphId: 'devnet-test', name: NAME, quads: QUADS, alsoShareSwm: true });
  assert.deepEqual(run.requests[1].body, { contextGraphId: 'devnet-test' });
  const { waited_s: waited, ...recovery } = run.fields.share_recovery;
  assert.deepEqual([run.fields.share_retries, recovery], [1, { job: 'job-7', state: 'succeeded', settled: true, attempts: 2, polls: 1 }]);
  assert.ok(Number.isInteger(waited) && waited < 20, `waited ${waited}s`);
  assert.match(run.stdout, /create and share: HTTP 503 PROMOTE_RETRYABLE_FAILURE retryable=true: /);
  assert.match(run.stdout, /share again, retry 1: HTTP 503 SHARE_OWNER_CONFLICT retryable=true share job job-7 \(pending\)/);
  assert.match(run.stdout, /share job job-7: succeeded after 2 attempt\(s\)/);
});

test('run as the publisher runs it, a share job that fails fails the step', async (t) => {
  const run = await runShareStep(t, { create: [createPendingAnswer('job-8')], jobs: { 'job-8': ['failed'] } });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.deepEqual(run.requests.map(({ method }) => method), ['POST', 'GET']);
  assert.deepEqual([run.fields.share_retries, run.fields.share_recovery.state], [0, 'failed']);
});
