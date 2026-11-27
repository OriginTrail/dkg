// The RS soak's publisher (scripts/devnet-soak-rs-publisher.sh) and summary
// (scripts/devnet-soak-rs-summary.mjs), run as the soak runs them. The
// publisher creates and shares each draft through the share step, publishes
// it once the share is done, and logs how the share was followed; the summary
// reports every publish whose share needed following, and fails a lane that
// needed it for more than one publish in ten.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPublisher } from '../../devnet-soak-rs-publisher.mjs';
import { createPendingAnswer, ownerConflictAnswer, prerequisiteAnswer, sharedAnswer, standInNode } from './devnet-soak-rs-stand-ins.mjs';

const PUBLISHER = fileURLToPath(new URL('../../devnet-soak-rs-publisher.sh', import.meta.url));
const SUMMARY = fileURLToPath(new URL('../../devnet-soak-rs-summary.mjs', import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(PUBLISHER));
// macOS ships bash 3.2 as /bin/bash, and the soak has to run there.
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

// The CLI as `node "$CLI_JS" ka publish <name> ...` runs it: each call is
// recorded with its DKG_HOME, and the n-th call gets the n-th planned answer.
const standInCli = `const fs = require('node:fs');
fs.appendFileSync(process.env.SOAK_CALLS, JSON.stringify({ args: process.argv.slice(2), home: process.env.DKG_HOME }) + '\\n');
const seen = fs.readFileSync(process.env.SOAK_CALLS, 'utf8').trim().split('\\n').length;
const answers = JSON.parse(process.env.SOAK_PUBLISH);
const [exit, text] = answers[Math.min(seen, answers.length) - 1];
(exit === 0 ? process.stdout : process.stderr).write(text + '\\n');
process.exit(exit);
`;
async function collect(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}
const jsonLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

// One publish attempt of round 9 on node 1, against a stand-in node API.
async function publishOnce(t, plan, { publish = [[0, 'published']], apiPort = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dkg-soak-publisher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const out = path.join(dir, 'out');
  const devnet = path.join(dir, 'devnet');
  const cli = path.join(dir, 'dkg-cli.cjs');
  for (const directory of [bin, out, path.join(devnet, 'node1')]) mkdirSync(directory, { recursive: true });
  const node = await standInNode(t, plan);
  if (apiPort) writeFileSync(path.join(devnet, 'node1', 'api.port'), `${node.port}\n`);
  writeFileSync(cli, standInCli);
  const files = { SOAK_CALLS: path.join(dir, 'calls.jsonl'), SOAK_WAITS: path.join(dir, 'waits.log') };
  writeFileSync(files.SOAK_CALLS, '');
  writeFileSync(files.SOAK_WAITS, '');
  let clock = Date.now();
  const endTs = Math.floor(clock / 1000) + 10;
  await runPublisher({ repoRoot: REPO_ROOT, devnetDir: devnet, outDir: out, cli, intervalSec: 7,
    endTs, auth: 'fixture-token', round: 9,
    env: { ...process.env, ...files, SOAK_PUBLISH: JSON.stringify(publish), SOAK_SHARE_RECOVERY_WAIT_SEC: '20' },
  }, { now: () => clock, sleep: async ms => {
    if (ms === 7000) { clock = endTs * 1000; writeFileSync(files.SOAK_WAITS, '7\n'); }
  } });
  const result = { status: 0, stdout: '', stderr: '' };
  return {
    result, devnet, requests: node.requests,
    rows: jsonLines(path.join(out, 'publish.jsonl')), calls: jsonLines(files.SOAK_CALLS),
    waits: readFileSync(files.SOAK_WAITS, 'utf8').split('\n').filter(Boolean),
  };
}

test('a prerequisite failure, then a pending owner, then a recovery that succeeds reaches the publish', async (t) => {
  const run = await publishOnce(t, { create: [prerequisiteAnswer()], share: [ownerConflictAnswer('job-7')], jobs: { 'job-7': ['succeeded'] } });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.rows.length, 1);
  const [row] = run.rows;
  const name = run.requests[0].body.name;
  assert.match(name, /^soak-9-0-/);
  assert.deepEqual(run.requests.map(({ method, path: route, auth }) => `${method} ${route} ${auth}`), [
    'POST /api/knowledge-assets Bearer fixture-token',
    `POST /api/knowledge-assets/${name}/swm/share Bearer fixture-token`,
    'GET /api/knowledge-assets/swm/share-jobs/job-7 Bearer fixture-token',
  ]);
  assert.equal(run.requests[0].body.quads[0].subject, row.subject, 'the draft is the fixture the loop wrote');
  assert.deepEqual(run.calls, [{ args: ['ka', 'publish', name, '--context-graph-id', 'devnet-test'], home: path.join(run.devnet, 'node1') }]);
  assert.deepEqual([row.status, row.rc, row.node, row.cg, row.share_retries], ['ok', 0, 1, 'devnet-test', 1]);
  assert.deepEqual([row.share_recovery.job, row.share_recovery.state, row.share_recovery.settled], ['job-7', 'succeeded', true]);
  assert.match(row.out, /SHARE_OWNER_CONFLICT[\s\S]*share job job-7: succeeded[\s\S]*\npublished$/);
  assert.deepEqual(run.waits, ['7'], 'the loop itself waits only its publish interval');
});

test('a share job that fails leaves the draft unpublished, and the attempt failed', async (t) => {
  const run = await publishOnce(t, { create: [createPendingAnswer('job-8')], jobs: { 'job-8': ['failed'] } });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.calls, []);
  assert.deepEqual(run.rows.map((row) => [row.status, row.rc, row.share_retries, row.share_recovery?.state]), [['fail', 1, 0, 'failed']]);
});

test('a share the node finishes at once is published, and a failed publish fails the attempt', async (t) => {
  const shared = await publishOnce(t, { create: [sharedAnswer(201)] });
  assert.equal(shared.calls.length, 1);
  assert.deepEqual(shared.rows.map((row) => [row.status, row.rc, row.share_retries, row.share_recovery]), [['ok', 0, 0, null]]);

  const refused = await publishOnce(t, { create: [sharedAnswer(201)] }, { publish: [[1, 'VM publish failed']] });
  assert.deepEqual(refused.rows.map((row) => [row.status, row.rc, row.share_retries]), [['fail', 1, 0]]);
  assert.match(refused.rows[0].out, /\nVM publish failed$/);
});

test('a node whose API cannot be found fails in the CLI\'s words, with the default share fields', async (t) => {
  const run = await publishOnce(t, { create: [sharedAnswer(201)] }, { apiPort: false });
  assert.deepEqual([run.requests, run.calls], [[], []]);
  assert.deepEqual(run.rows.map((row) => [row.status, row.rc, row.share_retries, row.share_recovery]), [['fail', 1, 0, null]]);
  assert.ok(run.rows[0].out.includes(`Daemon is not running at ${path.join(run.devnet, 'node1')}.`), run.rows[0].out);
});

test('the publisher drains a share pending across END_TS and SIGTERM before exiting', { timeout: 20_000 }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dkg-soak-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out'), devnet = path.join(dir, 'devnet'), home = path.join(devnet, 'node1');
  mkdirSync(out); mkdirSync(home, { recursive: true });
  const node = await standInNode(t, { create: [createPendingAnswer('held-job')], jobs: { 'held-job': ['failed_retrying'] } });
  writeFileSync(path.join(home, 'api.port'), String(node.port));
  const end = Math.floor(Date.now() / 1000) + 3;
  const child = spawn(BASH, [PUBLISHER, REPO_ROOT, devnet, out, 'must-not-publish.cjs', '7', String(end), 'fixture-token', '9'], {
    env: { ...process.env, SOAK_SHARE_RECOVERY_WAIT_SEC: '4' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  });
  const completion = collect(child);
  // Wait for the real node API to acknowledge that the attempt is following its job.
  const timeout = Date.now() + 5_000;
  while (!node.requests.some(request => request.method === 'GET') && Date.now() < timeout) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(node.requests.some(request => request.method === 'GET'));
  child.kill('SIGTERM');
  assert.equal(readFileSync(path.join(out, 'publish.jsonl'), 'utf8'), '', 'attempt is still in flight');
  const result = await completion;
  assert.equal(result.status, 0, result.stderr);
  const rows = jsonLines(path.join(out, 'publish.jsonl'));
  assert.equal(rows.length, 1, 'every admitted attempt has a recorded outcome before parent wait returns');
  assert.equal(rows[0].status, 'fail');
  assert.equal(rows[0].share_recovery.state, 'failed_retrying');
  assert.equal(rows[0].share_recovery.settled, false);
  assert.ok(Date.now() >= end * 1000, 'the pending job crossed the soak deadline');
});

// The soak's other inputs, made up so that every other check passes: four
// cores that submitted proofs, two edge nodes that stayed disabled, score
// events for every core, and stake that did not shrink. The publish log alone
// then decides whether the lane passes.
const CORES = [1, 2, 3, 4];
const stakeSnapshot = (epoch) => JSON.stringify({
  epoch: String(epoch), blockNumber: epoch * 100, perDelegator: [],
  perCore: CORES.map((n) => ({ identityId: String(n), v10StakeWei: String(10n ** 23n), epochScorePerStake: '1', netNodeEpochRewards: '0' })),
});
const observerSnapshot = JSON.stringify({ ts: '2026-11-26T10:30:00Z', perNode: [
  ...CORES.map((n) => ({ node: n, rs: { enabled: true, identityId: String(n), loop: { submittedCount: 3 } } })),
  ...[5, 6].map((n) => ({ node: n, rs: { enabled: false, loop: null } })),
] });
const chainEvents = CORES.flatMap((n) => [
  { event: 'EpochNodeValidProofsCountIncremented', args: ['1', String(n), '1'] },
  { event: 'NodeEpochScoreAdded', args: ['1', String(n), '0', '10'] },
]);

// The summary on a made-up publish log: its exit status, every line of its
// Fail section, and the PUBLISH lines of its Pass and Warn sections.
async function summarize(t, rows, restartWindow) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dkg-soak-summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name, text) => { writeFileSync(path.join(dir, name), text); return path.join(dir, name); };
  const lines = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const env = {
    ...process.env, OUT_DIR: dir,
    TIMESERIES: file('timeseries.jsonl', `${observerSnapshot}\n`), EVENTS_LOG: file('chain-events.jsonl', lines(chainEvents)),
    PUBLISH_LOG: file('publish.jsonl', lines(rows)),
    RESTART_WINDOW_FILE: restartWindow ? file('restart-window.json', JSON.stringify(restartWindow)) : path.join(dir, 'none.json'),
    STAKE_BEFORE: file('stake-before.json', stakeSnapshot(1)), STAKE_AFTER: file('stake-after.json', stakeSnapshot(2)),
    DELEGATORS_FILE: file('delegators.json', '[]'), FINDINGS: path.join(dir, 'summary.md'),
    ROUND: '9', DURATION_SEC: '600', NUM_CORES: '4', NUM_EDGE: '2',
  };
  const { status } = await collect(spawn(process.execPath, [SUMMARY], { env, stdio: 'ignore', timeout: 30_000 }));
  const sections = { Pass: [], Warn: [], Fail: [] };
  let section;
  for (const line of readFileSync(env.FINDINGS, 'utf8').split('\n')) {
    section = /^## (\w+)/.exec(line)?.[1] ?? section;
    if (sections[section] && line.startsWith('- ')) sections[section].push(line.slice(2));
  }
  const publish = (entries) => entries.filter((entry) => entry.startsWith('PUBLISH'));
  return { status, Fail: sections.Fail, Pass: publish(sections.Pass), Warn: publish(sections.Warn) };
}
const at = (i) => `2026-11-26T10:${String(i).padStart(2, '0')}:00Z`;
const attempts = (count, overrides = {}) => Array.from({ length: count }, (_, i) => ({
  ts: at(i), cg: 'devnet-test', node: (i % 4) + 1, i, subject: `urn:soak:r9:i${i}`,
  status: 'ok', rc: 0, share_retries: 0, share_recovery: null, elapsed_s: 3, out: 'published', ...overrides[i],
}));
const followedJob = (state = 'succeeded') => ({ job: 'job-1', state, settled: true, attempts: 2, polls: 13, waited_s: 64 });

test('one publish in ten needing its share followed passes with a warning; more fails the lane', async (t) => {
  // The control: a clean log passes, so nothing else in the made-up inputs fails.
  const clean = await summarize(t, attempts(20));
  assert.deepEqual([clean.status, clean.Fail, clean.Warn], [0, [], []]);

  const two = await summarize(t, attempts(20, { 3: { share_retries: 1 }, 11: { share_recovery: followedJob() } }));
  assert.deepEqual([two.status, two.Fail], [0, []]);
  assert.deepEqual(two.Warn, ['PUBLISH followed 1 retryable share answer(s) and 1 share job(s) on 2 publish(es): i3 node4 x1 ok, i11 node4 x0 job succeeded 64s ok']);
  assert.match(two.Pass.join('\n'), /PUBLISH success rate excluding planned restart window 20\/20/);

  const three = await summarize(t, attempts(20, { 3: { share_retries: 2 }, 11: { share_retries: 1, share_recovery: followedJob() }, 15: { share_retries: 2 } }));
  assert.deepEqual([three.status, three.Fail], [1, ['PUBLISH followed 5 retryable share answer(s) and 1 share job(s) on 3 publish(es): i3 node4 x2 ok, i11 node4 x1 job succeeded 64s ok, i15 node4 x2 ok (more than 1 publish in 10)']]);

  const failedJob = await summarize(t, attempts(20, { 7: { status: 'fail', rc: 1, share_recovery: followedJob('failed') } }));
  assert.deepEqual([failedJob.status, failedJob.Fail], [1, ['PUBLISH success rate excluding planned restart window 19/20 (blocking failures=1, total failures=1)']]);
  assert.deepEqual(failedJob.Warn, ['PUBLISH followed 0 retryable share answer(s) and 1 share job(s) on 1 publish(es): i7 node4 x0 job failed 64s fail']);

  // A log written before these fields existed has nothing to report.
  const older = await summarize(t, attempts(20).map((row) => {
    const written = { ...row };
    delete written.share_retries;
    delete written.share_recovery;
    return written;
  }));
  assert.deepEqual([older.status, older.Fail, older.Warn], [0, [], []]);
});

test('a failure the planned restart excuses is reported but left out of the rate', async (t) => {
  // 20 attempts: 18 succeed and two fail while node 2 is stopped on purpose.
  // One of each needed its share followed: 1 of the 18 counted attempts, not 2 of 18.
  const seconds = (i) => Date.parse(at(i)) / 1000;
  const excused = { node: 2, status: 'fail', rc: 143, out: 'terminated' };
  const run = await summarize(t, attempts(20, { 5: { ...excused, share_retries: 1 }, 6: excused, 12: { share_recovery: followedJob() } }),
    { node: 2, stopTs: seconds(5), apiReadyTs: seconds(7), graceSec: 45 });
  assert.deepEqual([run.status, run.Fail], [0, []]);
  assert.deepEqual(run.Warn, ['PUBLISH followed 1 retryable share answer(s) and 1 share job(s) on 2 publish(es): i5 node2 x1 fail, i12 node1 x0 job succeeded 64s ok']);
  assert.match(run.Pass.join('\n'), /PUBLISH tolerated 2 failure\(s\) during planned node2 restart window/);
  assert.match(run.Pass.join('\n'), /PUBLISH success rate excluding planned restart window 18\/18/);
});
