// The RS soak's publish loop and summary step (scripts/devnet-soak-rs.sh), run
// as the soak writes them, with a stand-in CLI: a share the node answers as
// retryable is shared again on the same draft, a bounded number of times, and
// the summary reports every repeat and fails a lane that needed too many.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

const soak = readFileSync(new URL('../../devnet-soak-rs.sh', import.meta.url), 'utf8');
function between(start, end) {
  const from = soak.indexOf(start);
  assert.ok(from >= 0, `the soak script has ${JSON.stringify(start)}`);
  const to = soak.indexOf(end, from + start.length);
  assert.ok(to >= 0, `the soak script closes ${JSON.stringify(start)}`);
  return soak.slice(from + start.length, to);
}
// What the soak writes to publisher-loop.sh, and the summary step's Node script.
const publisherLoop = between(`cat > "$OUT_DIR/publisher-loop.sh" <<'EOLOOP'\n`, '\nEOLOOP\n');
const summaryScript = between(`NUM_EDGE="$NUM_EDGE" \\\nnode -e '\n`, `\n'`);

// The CLI as `node "$CLI_JS" ka <command> <name> ...` runs it: each call is
// recorded with its DKG_HOME (and, for create, the first line of its input);
// the n-th call of a command gets that command's n-th planned answer.
const standInCli = `const fs = require('node:fs');
const args = process.argv.slice(2);
const record = { args, home: process.env.DKG_HOME };
if (args[1] === 'create') {
  const input = args[args.indexOf('--input-file') + 1];
  record.input = fs.existsSync(input) ? fs.readFileSync(input, 'utf8').split('\\n')[0] : null;
}
fs.appendFileSync(process.env.SOAK_CALLS, JSON.stringify(record) + '\\n');
const seen = fs.readFileSync(process.env.SOAK_CALLS, 'utf8').trim().split('\\n')
  .filter((line) => JSON.parse(line).args[1] === args[1]).length;
const answers = JSON.parse(fs.readFileSync(process.env.SOAK_PLAN, 'utf8'))[args[1]] ?? [[97, 'unplanned ' + args[1]]];
const [exit, text] = answers[Math.min(seen, answers.length) - 1];
(exit === 0 ? process.stdout : process.stderr).write(text + '\\n');
process.exit(exit);
`;
// sleep records each wait and returns at once. The publish interval (7 s) ends
// the run: after it, date +%s answers past the end of the soak.
const standInSleep = '#!/bin/sh\necho "$1" >> "$SOAK_WAITS"\nif [ "$1" = 7 ]; then : > "$SOAK_WAITS.interval"; fi\n';
const standInDate = '#!/bin/sh\nif [ "$1" = "+%s" ] && [ -e "$SOAK_WAITS.interval" ]; then echo 9999999999; exit 0; fi\nexec /bin/date "$@"\n';

async function publishOnce(t, plan) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-soak-share-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), out = join(dir, 'out'), devnet = join(dir, 'devnet'), cli = join(dir, 'dkg-cli.cjs');
  mkdirSync(bin); mkdirSync(out);
  writeFileSync(join(bin, 'sleep'), standInSleep, { mode: 0o755 });
  writeFileSync(join(bin, 'date'), standInDate, { mode: 0o755 });
  writeFileSync(cli, standInCli);
  const files = { SOAK_PLAN: join(dir, 'plan.json'), SOAK_CALLS: join(dir, 'calls.jsonl'), SOAK_WAITS: join(dir, 'waits.log') };
  writeFileSync(files.SOAK_PLAN, JSON.stringify(plan));
  writeFileSync(files.SOAK_CALLS, '');
  writeFileSync(files.SOAK_WAITS, '');
  const result = await new Promise((resolve, reject) => {
    // The loop's arguments: repo, devnet, output, CLI, interval, end, token, round.
    const child = spawn('bash', ['-c', publisherLoop, 'publisher-loop.sh', dir, devnet, out, cli, '7', '9999999998', 'fixture-token', '9'],
      { env: { ...process.env, ...files, PATH: `${bin}${delimiter}${process.env.PATH}` } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr }));
  });
  const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const waits = lines(files.SOAK_WAITS);
  return {
    result, devnet,
    rows: lines(join(out, 'publish.jsonl')).map((line) => JSON.parse(line)),
    calls: lines(files.SOAK_CALLS).map((line) => JSON.parse(line)),
    waits: waits.filter((wait) => wait !== '7').map(Number),
    intervals: waits.filter((wait) => wait === '7').length,
  };
}

const retryable = 'A promote prerequisite is temporarily unavailable';
const createRefused = [1, `Knowledge asset create/share completed partially for "x" in devnet-test: phase=swm-share ${retryable}`];
const shareRefused = [1, retryable];
const answer = (text) => [0, text];
const summary = (run) => [run.calls.map((call) => call.args[1]), run.waits, run.rows.map((row) => [row.status, row.rc, row.share_retries])];

test('a share the node answers as retryable is shared again on the same draft, then published', async (t) => {
  const run = await publishOnce(t, { create: [createRefused], share: [shareRefused, answer('shared')], publish: [answer('published')] });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(summary(run), [['create', 'share', 'share', 'publish'], [1, 2], [['ok', 0, 2]]]);
  const [create, ...rest] = run.calls;
  const name = create.args[2];
  assert.match(name, /^soak-9-0-/);
  assert.deepEqual(create.args, ['ka', 'create', name, '--context-graph-id', 'devnet-test', '--input-file', create.args[6], '--share']);
  assert.match(create.input, /^<urn:soak:r9:i0:/, 'the loop wrote the draft it creates');
  for (const call of rest) assert.deepEqual(call.args, ['ka', call.args[1], name, '--context-graph-id', 'devnet-test']);
  assert.ok(run.calls.every((call) => call.home === join(run.devnet, 'node1')), 'every step goes to the same node');
  assert.equal(run.intervals, 1);
  assert.deepEqual([run.rows[0].node, run.rows[0].cg], [1, 'devnet-test']);
  assert.match(run.rows[0].out, /retryable share answer followed: ka share, retry 1\n/);
  assert.match(run.rows[0].out, /retryable share answer followed: ka share, retry 2\nshared\npublished/);
});

test('a node that keeps answering retryable gets five more shares, and nothing is published', async (t) => {
  const run = await publishOnce(t, { create: [createRefused], share: [shareRefused], publish: [answer('published')] });
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(summary(run), [['create', 'share', 'share', 'share', 'share', 'share'], [1, 2, 3, 4, 5], [['fail', 1, 5]]]);
});

test('no other failure is shared again', async (t) => {
  for (const [plan, expected] of [
    [{ create: [[1, 'Daemon is not running']] }, [['create'], [], [['fail', 1, 0]]]],
    [{ create: [createRefused], share: [[1, 'Context graph not found']] }, [['create', 'share'], [1], [['fail', 1, 1]]]],
    [{ create: [createRefused], share: [answer('shared')], publish: [[1, 'VM publish failed']] }, [['create', 'share', 'publish'], [1], [['fail', 1, 1]]]],
    [{ create: [answer('created and shared')], publish: [answer('published')] }, [['create', 'publish'], [], [['ok', 0, 0]]]],
  ]) {
    const run = await publishOnce(t, plan);
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(summary(run), expected, JSON.stringify(plan));
  }
});

// The summary step on a made-up publish log: the PUBLISH lines by section.
async function publishLines(t, rows, restartWindow) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-soak-summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); };
  const stake = JSON.stringify({ epoch: '1', blockNumber: 1, perCore: [], perDelegator: [] });
  const env = {
    ...process.env, TIMESERIES: join(dir, 'none.jsonl'), EVENTS_LOG: join(dir, 'none.jsonl'),
    PUBLISH_LOG: file('publish.jsonl', rows.map((row) => JSON.stringify(row)).join('\n') + '\n'),
    RESTART_WINDOW_FILE: restartWindow ? file('restart-window.json', JSON.stringify(restartWindow)) : join(dir, 'none.json'),
    STAKE_BEFORE: file('stake-before.json', stake), STAKE_AFTER: file('stake-after.json', stake),
    DELEGATORS_FILE: file('delegators.json', '[]'), FINDINGS: join(dir, 'summary.md'),
    ROUND: '9', DURATION_SEC: '600', NUM_CORES: '4', NUM_EDGE: '2',
  };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', summaryScript], { env, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', resolve);
  });
  const sections = { Pass: [], Warn: [], Fail: [] };
  let section;
  for (const line of readFileSync(env.FINDINGS, 'utf8').split('\n')) {
    section = /^## (\w+)/.exec(line)?.[1] ?? section;
    if (line.startsWith('- PUBLISH')) sections[section].push(line.slice(2));
  }
  return sections;
}
const at = (i) => `2026-11-26T10:${String(i).padStart(2, '0')}:00Z`;
const attempts = (count, overrides = {}) => Array.from({ length: count }, (_, i) => ({
  ts: at(i), cg: 'devnet-test', node: (i % 4) + 1, i, subject: `urn:soak:r9:i${i}`,
  status: 'ok', rc: 0, share_retries: 0, elapsed_s: 3, out: 'published', ...overrides[i],
}));

test('one publish in ten needing a repeat is a warning; more fails the lane', async (t) => {
  const two = await publishLines(t, attempts(20, { 3: { share_retries: 1 }, 11: { share_retries: 1 } }));
  assert.deepEqual(two.Warn, ['PUBLISH followed 2 retryable share answer(s) on 2 publish(es): i3 node4 x1 ok, i11 node4 x1 ok']);
  assert.deepEqual(two.Fail, []);
  assert.match(two.Pass.join('\n'), /PUBLISH success rate excluding planned restart window 20\/20/);

  const three = await publishLines(t, attempts(20, { 3: { share_retries: 2 }, 11: { share_retries: 2 }, 15: { share_retries: 2 } }));
  assert.deepEqual(three.Fail, ['PUBLISH followed 6 retryable share answer(s) on 3 publish(es): i3 node4 x2 ok, i11 node4 x2 ok, i15 node4 x2 ok (more than 1 publish in 10)']);

  const exhausted = await publishLines(t, attempts(20, { 7: { status: 'fail', rc: 1, share_retries: 5, out: retryable } }));
  assert.deepEqual(exhausted.Warn, ['PUBLISH followed 5 retryable share answer(s) on 1 publish(es): i7 node4 x5 fail']);
  assert.match(exhausted.Fail.join('\n'), /PUBLISH success rate excluding planned restart window 19\/20 \(blocking failures=1/);

  // A log written before share_retries existed has no repeats to report.
  const older = await publishLines(t, attempts(20).map((row) => {
    const written = { ...row };
    delete written.share_retries;
    return written;
  }));
  assert.deepEqual([older.Warn, older.Fail], [[], []]);
});

test('a failure the planned restart excuses is reported but left out of the repeat rate', async (t) => {
  // 20 attempts: 18 succeed and two fail while node 2 is stopped on purpose.
  // One of each needed a repeat: 1 of the 18 counted attempts, not 2 of 18.
  const seconds = (i) => Date.parse(at(i)) / 1000;
  const excused = { node: 2, status: 'fail', rc: 143, out: 'terminated' };
  const run = await publishLines(t, attempts(20, { 5: { ...excused, share_retries: 1 }, 6: excused, 12: { share_retries: 1 } }),
    { node: 2, stopTs: seconds(5), apiReadyTs: seconds(7), graceSec: 45 });
  assert.deepEqual(run.Fail, []);
  assert.deepEqual(run.Warn, ['PUBLISH followed 2 retryable share answer(s) on 2 publish(es): i5 node2 x1 fail, i12 node1 x1 ok']);
  assert.match(run.Pass.join('\n'), /PUBLISH tolerated 2 failure\(s\) during planned node2 restart window/);
  assert.match(run.Pass.join('\n'), /PUBLISH success rate excluding planned restart window 18\/18/);
});
