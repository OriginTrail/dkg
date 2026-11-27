// The RS soak's share step (scripts/devnet-soak-rs-share.mjs) follows a node's
// answers on their status and recovery fields alone: a share job that owns the
// share is waited for until it settles, a retryable answer that names no job
// is shared again on the same draft at most five times, and anything else is
// final.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RECOVERY_WAIT_SEC, followShareJob, recoveryWaitSec,
  shareDisposition, shareWithClientRule,
} from '../../devnet-soak-rs-share.mjs';
import {
  createdShareErrorAnswer, createPendingAnswer, jobUrl, ownerConflictAnswer, prerequisiteAnswer,
  recoveryRequiredAnswer, sharedAnswer,
} from './devnet-soak-rs-stand-ins.mjs';

const NAME = 'soak-9-0-1-0-1';
const SUBJECT = 'urn:soak:r9:i0:1-0-1';
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
  node.create = (contextGraphId, name, options) => node.send({ path: '/api/knowledge-assets', body: { contextGraphId, name, ...options } });
  node.share = (contextGraphId, name) => node.send({ path: `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`, body: { contextGraphId } });
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
    contextGraphId: 'devnet-test', name: NAME, quads: QUADS, create: node.create, share: node.share, follow: node.follow, sleep: node.sleep, progress,
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

// pollShareRecoveryJobs on a made-up clock: a 5 s poll interval, and a job that
// fails its first attempt and succeeds when the queue retries it a minute later.
async function followOnClock(states, budgetMs = DEFAULT_RECOVERY_WAIT_SEC * 1000) {
  let clock = 0;
  const seen = [];
  const record = await followShareJob({ jobId: 'job-3', url: jobUrl('job-3') }, {
    budgetMs,
    readJob: async ({ jobId, url }, { timeoutMs }) => {
      seen.push([jobId, url, timeoutMs]);
      return { jobId, state: states(clock), attempts: clock < 62_000 ? 1 : 2 };
    },
    pollOptions: {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    },
  });
  return { record, seen };
}

test('a share job is followed through its first retry, about a minute later', async () => {
  const retried = (ms) => (ms < 2_000 ? 'running' : ms < 62_000 ? 'failed_retrying' : ms < 64_000 ? 'running' : 'succeeded');
  const { record, seen } = await followOnClock(retried);
  assert.deepEqual(record, { job: 'job-3', state: 'succeeded', settled: true, attempts: 2, polls: 14, waited_s: 65 });
  assert.deepEqual(seen[0].slice(0, 2), ['job-3', jobUrl('job-3')]);
  assert.ok(seen.every(([, , timeoutMs]) => timeoutMs > 0 && timeoutMs <= DEFAULT_RECOVERY_WAIT_SEC * 1000));

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
