import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';

const readWorkflow = name => parse(fs.readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8'));
const dispatcher = readWorkflow('nightly-ci.yml');
const ci = readWorkflow('ci.yml');
const [dispatch, wait] = dispatcher.jobs.nightly.steps;

function execute(t, step, { runId = '40406058516', apiExit = 0, watchExit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  const calls = path.join(dir, 'calls');
  // Replace only the external API client; execute the workflow's actual shell.
  const stub = `gh() {
    printf '%s\\n' "$@" >> "$CALLS_FILE"
    if [[ "$1" == api ]]; then
      printf '%s\\n' "$DISPATCH_RUN_ID"
      return "$API_EXIT"
    fi
    return "$WATCH_EXIT"
  }`;
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `${stub}\n${step.run}`], {
    encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'OriginTrail/dkg', GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, CALLS_FILE: calls, DISPATCH_RUN_ID: runId,
      API_EXIT: String(apiExit), WATCH_EXIT: String(watchExit), CI_RUN_ID: runId },
  });
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { ...result, output: read(output), summary: read(summary), args: read(calls).trim().split('\n') };
}

test('only the dispatcher owns the nightly clock; main and canary push/PR checks remain', () => {
  assert.deepEqual(dispatcher.on.schedule, [{ cron: '23 2 * * *' }]);
  assert.ok(Object.hasOwn(dispatcher.on, 'workflow_dispatch'));
  assert.equal(ci.on.schedule, undefined);
  assert.deepEqual(ci.on.push.branches, ['main', 'testnet-canary']);
  assert.deepEqual(ci.on.pull_request.branches, ['main', 'testnet-canary']);
  assert.ok(Object.hasOwn(ci.on, 'merge_group'));
  assert.deepEqual(ci.on.workflow_dispatch.inputs.profile.options, ['standard', 'nightly-equivalent']);
  assert.deepEqual(ci.permissions, { contents: 'read' });
  assert.deepEqual(dispatcher.permissions, {});
  assert.deepEqual(dispatcher.jobs.nightly.permissions, { actions: 'write', checks: 'read' });
  assert.equal(dispatcher.jobs.nightly.if, "github.repository == 'OriginTrail/dkg'");
  assert.equal(dispatcher.jobs.nightly.steps.length, 2);
  assert.ok(dispatcher.jobs.nightly.steps.every(step => !step.uses));
  assert.equal(dispatcher.concurrency['cancel-in-progress'], false);
});

test('dispatch selects the canary workflow and full profile, then links the exact returned run', t => {
  const result = execute(t, dispatch);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.args, ['api', '--method', 'POST', '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2026-03-10', 'repos/OriginTrail/dkg/actions/workflows/ci.yml/dispatches',
    '-f', 'ref=testnet-canary', '-f', 'inputs[profile]=nightly-equivalent', '--jq', '.workflow_run_id']);
  assert.equal(result.output, 'run_id=40406058516\n');
  assert.match(result.summary, /https:\/\/github.com\/OriginTrail\/dkg\/actions\/runs\/40406058516/);
  assert.equal(wait.env.CI_RUN_ID, '${{ steps.dispatch.outputs.run_id }}');
});

test('a refused dispatch or missing run receipt cannot proceed as a successful launch', t => {
  for (const options of [{ apiExit: 1 }, ...['', 'null', '0', '1\n2', 'not-an-id'].map(runId => ({ runId }))]) {
    const result = execute(t, dispatch, options);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.equal(result.output, '');
    assert.equal(result.summary, '');
  }
});

test('the dispatcher waits for its returned run and propagates a failed or cancelled CI result', t => {
  for (const watchExit of [0, 1, 2]) {
    const result = execute(t, wait, { watchExit });
    assert.deepEqual(result.args, ['run', 'watch', '40406058516', '--repo', 'OriginTrail/dkg', '--interval', '60', '--exit-status']);
    assert.equal(result.status, watchExit);
  }
});
