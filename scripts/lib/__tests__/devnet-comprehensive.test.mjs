import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { summarizeComprehensive } from '../qa/comprehensive-result.mjs';

const scripts = fileURLToPath(new URL('../..', import.meta.url));
const suiteFiles = ['v10-rc-validation.sh', '_devnet-full-sweep.sh', 'devnet-test-rfc49-catalog-sampling.sh',
  'devnet-test-rc11-promote-crash-recovery.sh', 'devnet-test-rc11-shutdown-mid-publish.sh', 'devnet-test-rfc38-all.sh',
  ...['hub-rotation', 'multi-rpc-failover', 'libp2p-tunables', 'cg-phonebook', 'ack-rejection-reasons'].map(p => `devnet-probe-${p}.sh`),
  'devnet-test-node-ui-smoke.sh', 'libp2p-soak-test.sh', 'devnet-swm-soak-gate.sh', 'devnet-soak-rs.sh'];
// The regression scripts, in the order they are registered: the scripts that restart a Core come
// late, and the one that arms a chain-wide parameter is last.
const regressionIds = ['store-outage', 'managed-oxigraph-caller-abort', 'agents-meta-bounded',
  'issue-1561-rpc-throttle-retry', 'issue-1562-receipt-timeout', 'issue-1567-global-cli-rollback',
  'issue-1573-publish-fundability', 'issue-1576-publisher-readiness', 'issue-1585-named-ka-swm',
  'issue-1580-bounded-outbox-drain', 'issue-1577-ack-outbox-ownership', 'curator-ack-gate', 'issue-1579-outbox-backoff',
  'cg-registration-deposit'];
suiteFiles.push(...regressionIds.map(id => `devnet-test-${id}.sh`), 'devnet-test-upgrade.sh');
// Suites registered with the "exit 3 = did not run" convention (register_skip_aware).
const skipAwareFiles = ['devnet-test-store-outage.sh', 'devnet-test-managed-oxigraph-caller-abort.sh',
  'devnet-test-issue-1585-named-ka-swm.sh', 'devnet-test-upgrade.sh'];

function setup(t, { missing = [], fail = {}, first = 'exit 0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-comprehensive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts/lib/qa'), { recursive: true });
  cpSync(join(scripts, 'devnet-comprehensive.sh'), join(dir, 'scripts/devnet-comprehensive.sh'));
  for (const file of ['comprehensive-report.mjs', 'comprehensive-result.mjs']) cpSync(join(scripts, 'lib/qa', file), join(dir, 'scripts/lib/qa', file));
  mkdirSync(join(dir, '.devnet/node1'), { recursive: true });
  writeFileSync(join(dir, '.devnet/node1/auth.token'), 'fixture-only');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/curl'), '#!/bin/bash\ncase "$*" in *http_code*) printf 200;; *) printf \'{"peerId":"fixture"}\';; esac\n', { mode: 0o755 });
  for (const file of suiteFiles) if (!missing.includes(file)) writeFileSync(join(dir, 'scripts', file),
    `#!/bin/bash\n${file === suiteFiles[0] ? first : `exit ${fail[file] ?? 0}`}\n`, { mode: 0o755 });
  return dir;
}
function launch(dir, overrides = {}) {
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RESULTS_DIR: join(dir, 'results'), NUM_NODES: '1' };
  for (const key of ['SOAK_ONLY', 'ONLY_GROUPS', 'SKIP_SOAK', 'SKIP_UI', 'SKIP_PROBES', 'SKIP_RFC38_EXTRAS', 'SKIP_RFC49', 'SKIP_REGRESSIONS', 'SKIP_UPGRADE', 'FAIL_FAST', 'DEVNET_DIR']) delete env[key];
  const child = spawn('bash', [join(dir, 'scripts/devnet-comprehensive.sh')], { env: { ...env, ...overrides } });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr })); });
  return { child, done };
}
const report = dir => JSON.parse(readFileSync(join(dir, 'results/REPORT.json'), 'utf8'));
function matchingReports(dir) {
  const receipt = report(dir);
  const markdown = readFileSync(join(dir, 'results/REPORT.md'), 'utf8');
  for (const [key, value] of Object.entries(receipt.totals)) assert.ok(markdown.includes(`| ${key.toUpperCase()} | ${value} |`), key);
  for (const suite of receipt.suites) assert.ok(markdown.includes(`| \`${suite.id}\` | ${suite.group} | ${suite.result} | ${suite.elapsedSeconds}s |`), suite.id);
  assert.ok(markdown.includes(`**Outcome**: ${receipt.outcome}`));
  assert.ok(markdown.includes(`**Selection outcome**: ${receipt.selectionOutcome}`));
  return receipt;
}

test('complete valid run succeeds and snapshots every registered suite before execution', async t => {
  const dir = setup(t);
  const result = await launch(dir).done;
  assert.equal(result.status, 0, result.stderr);
  const receipt = matchingReports(dir);
  assert.equal(receipt.outcome, 'PASS'); assert.equal(receipt.completeSuccess, true);
  assert.equal(receipt.totals.pass, suiteFiles.length);
  const plan = JSON.parse(readFileSync(join(dir, 'results/PLAN.json'), 'utf8'));
  assert.equal(plan.suites.length, suiteFiles.length);
  assert.ok(plan.suites.every(s => s.result === 'PENDING'));
});

test('missing-only run is incomplete and nonzero', async t => {
  const dir = setup(t, { missing: suiteFiles });
  const result = await launch(dir).done;
  const receipt = matchingReports(dir);
  assert.equal(receipt.totals.missing, suiteFiles.length);
  assert.equal(result.status, 1, `MISSING=${receipt.totals.missing}, PASS=${receipt.totals.pass}, FAIL=${receipt.totals.fail}: missing-only run must block success`);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.totals.executed, 0);
  assert.equal(receipt.totals.missing, suiteFiles.length);
});

test('empty filtered run never succeeds', async t => {
  const dir = setup(t);
  const result = await launch(dir, { SOAK_ONLY: '1', SKIP_SOAK: '1' }).done;
  assert.equal(result.status, 1, result.stderr);
  assert.equal(matchingReports(dir).outcome, 'INCONCLUSIVE'); assert.equal(report(dir).totals.registered, 0);
});

test('valid exploratory selection remains usable and is explicitly partial', async t => {
  const dir = setup(t);
  const result = await launch(dir, { SKIP_SOAK: '1' }).done;
  assert.equal(result.status, 0, result.stderr);
  const receipt = matchingReports(dir);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.selectionOutcome, 'PASS');
  assert.equal(receipt.partial, true); assert.equal(receipt.completeSuccess, false);
  assert.deepEqual(receipt.filters, ['SKIP_SOAK=1']); assert.match(result.stdout, /PARTIAL exploratory/);
});

test('legacy exit 2 remains an individual FAIL:2 and does not get reinterpreted', async t => {
  const dir = setup(t, { first: 'exit 2' });
  const result = await launch(dir).done;
  assert.equal(result.status, 1, result.stderr);
  const receipt = matchingReports(dir);
  assert.equal(receipt.outcome, 'FAIL'); assert.equal(receipt.suites[0].result, 'FAIL:2');
});

test('exit 3 of a skip-aware suite is a suite that did not run: never a pass, not a failure, and no reason to stop', async t => {
  const dir = setup(t, { fail: Object.fromEntries(skipAwareFiles.map(file => [file, 3])) });
  // FAIL_FAST stops at a failure. A suite that did not run is not one.
  const result = await launch(dir, { FAIL_FAST: '1' }).done;
  assert.equal(result.status, 1, 'a run with a suite that did not run must not succeed');
  const receipt = matchingReports(dir);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.completeSuccess, false);
  assert.equal(receipt.totals.skipped, skipAwareFiles.length); assert.equal(receipt.totals.fail, 0);
  assert.equal(receipt.totals.pass, suiteFiles.length - skipAwareFiles.length);
  assert.equal(receipt.totals.executed, suiteFiles.length - skipAwareFiles.length);
  const markdown = readFileSync(join(dir, 'results/REPORT.md'), 'utf8');
  for (const file of skipAwareFiles) {
    const suite = receipt.suites.find(s => s.command.endsWith(file));
    assert.equal(suite.result, 'SKIPPED', file);
    assert.match(result.stdout, new RegExp(`SKIPPED ${suite.id} +\\(exit=3: a precondition was unmet`));
    // The reason a suite gives for not running is part of the report.
    assert.ok(markdown.includes(`### ${suite.id}`), file);
  }
  assert.ok(receipt.suites.every(s => s.result === 'PASS' || s.result === 'SKIPPED'));
});

test('exit 3 of an aggregator stays three failed scripts, and any other exit of a skip-aware suite is a failure', async t => {
  const dir = setup(t, { fail: { '_devnet-full-sweep.sh': 3, 'devnet-test-rfc38-all.sh': 3, [skipAwareFiles[0]]: 1 } });
  assert.equal((await launch(dir).done).status, 1);
  const receipt = matchingReports(dir);
  assert.equal(receipt.outcome, 'FAIL'); assert.equal(receipt.totals.skipped, 0); assert.equal(receipt.totals.fail, 3);
  assert.deepEqual(receipt.suites.filter(s => s.result !== 'PASS').map(s => [s.id, s.result]),
    [['devnet-full-sweep', 'FAIL:3'], ['rfc38-all', 'FAIL:3'], ['store-outage', 'FAIL:1']]);
});

// What is registered, and in which order, is in the report of a run that stops
// at its first suite: every later suite is listed as NOT_RUN with its command.
async function registered(t, overrides = {}) {
  const dir = setup(t, { first: 'exit 1' });
  assert.equal((await launch(dir, { FAIL_FAST: '1', ...overrides }).done).status, 1);
  return { dir, receipt: matchingReports(dir) };
}

test('the regression scripts have one entry each, after the soak and before the upgrade, in their registered order', async t => {
  const { dir, receipt } = await registered(t);
  const group = receipt.suites.filter(s => s.group === 'regression');
  assert.deepEqual(group.map(s => s.id), regressionIds);
  for (const s of group) assert.equal(s.command, join(dir, 'scripts', `devnet-test-${s.id}.sh`));
  const first = receipt.suites.findIndex(s => s.group === 'regression');
  assert.equal(receipt.suites[first - 1].group, 'soak');
  assert.deepEqual(receipt.suites.slice(first + group.length).map(s => s.group), ['upgrade']);

  const partial = (await registered(t, { SKIP_REGRESSIONS: '1' })).receipt;
  assert.equal(partial.partial, true); assert.deepEqual(partial.filters, ['SKIP_REGRESSIONS=1']);
  assert.ok(partial.suites.every(s => s.group !== 'regression'));
  assert.equal(partial.suites.at(-1).group, 'upgrade');
});

test('the upgrade suite is last, gets its own results directory, and can be left out of an exploratory run', async t => {
  const { dir, receipt } = await registered(t);
  const last = receipt.suites.at(-1);
  assert.equal(last.id, 'upgrade-from-previous-release');
  assert.ok(last.command.startsWith(`env DEVNET_UPGRADE_RESULTS=${join(dir, 'results')}/upgrade `), last.command);
  const partial = (await registered(t, { SKIP_UPGRADE: '1' })).receipt;
  assert.equal(partial.outcome, 'INCONCLUSIVE'); assert.equal(partial.partial, true);
  assert.deepEqual(partial.filters, ['SKIP_UPGRADE=1']);
  assert.ok(partial.suites.every(s => s.group !== 'upgrade'));
});

test('ONLY_GROUPS selects whole groups in their registered order and marks the run partial', async t => {
  for (const value of ['regression upgrade', 'upgrade,regression']) {
    const dir = setup(t, { fail: { 'devnet-test-store-outage.sh': 1 } });
    assert.equal((await launch(dir, { FAIL_FAST: '1', ONLY_GROUPS: value }).done).status, 1);
    const receipt = matchingReports(dir);
    assert.deepEqual(receipt.suites.map(s => s.id), [...regressionIds, 'upgrade-from-previous-release']);
    assert.deepEqual(receipt.suites.map(s => s.result), ['FAIL:1', ...regressionIds.map(() => 'NOT_RUN')]);
    assert.equal(receipt.partial, true);
    assert.deepEqual(receipt.filters, [`ONLY_GROUPS=${value.replace(',', ' ')}`]);
  }
  // A selection that completes is usable, and still never certifies a complete run.
  const upgradeOnly = setup(t);
  assert.equal((await launch(upgradeOnly, { ONLY_GROUPS: 'upgrade' }).done).status, 0);
  const receipt = matchingReports(upgradeOnly);
  assert.deepEqual(receipt.suites.map(s => [s.id, s.result]), [['upgrade-from-previous-release', 'PASS']]);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.selectionOutcome, 'PASS');
  // A name that is no group selects nothing, and nothing is never a success.
  const none = setup(t);
  assert.equal((await launch(none, { ONLY_GROUPS: 'no-such-group' }).done).status, 1);
  assert.equal(report(none).totals.registered, 0);
});

test('confirmed failure and missing evidence are both retained', async t => {
  const dir = setup(t, { first: 'exit 1', missing: [suiteFiles[1]] });
  assert.equal((await launch(dir).done).status, 1);
  const receipt = matchingReports(dir);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.totals.fail, 1); assert.equal(receipt.totals.missing, 1);
  assert.equal(receipt.suites[0].result, 'FAIL:1'); assert.equal(receipt.suites[1].result, 'MISSING');
});

test('fail-fast preserves failure and unexecuted registered work', async t => {
  const dir = setup(t, { first: 'exit 1' });
  assert.equal((await launch(dir, { FAIL_FAST: '1' }).done).status, 1);
  const receipt = matchingReports(dir);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.suites[0].result, 'FAIL:1');
  assert.ok(receipt.suites.slice(1).every(s => s.result === 'NOT_RUN'));
});

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

for (const [signal, expectedExit, waitRecovery] of [['SIGTERM', 143, true], ['SIGINT', 130, true], ['SIGTERM', 143, false]]) test(`interruption waits for delayed recovery and descendants before finalizing (${signal}${waitRecovery ? '' : '; detached recovery'})`, async t => {
  const dir = setup(t, { first: `
echo $$ > "$SUITE_PID_FILE"
bash -c 'echo $$ > "$DESCENDANT_PID_FILE"; exec sleep 300' &
descendant=$!
cleanup() {
  wait "$descendant" 2>/dev/null || true
  bash -c 'echo $$ > "$CLEANUP_PID_FILE"; sleep 1; echo recovered > "$CLEANUP_DONE_FILE"' &
  recovery=$!
  ${waitRecovery ? 'wait "$recovery"' : ': # recovery continues after the suite leader exits'}
  exit 0
}
trap cleanup TERM
wait "$descendant"
` });
  const suiteFile = join(dir, 'suite.pid'), descendantFile = join(dir, 'descendant.pid');
  const cleanupFile = join(dir, 'cleanup.pid'), cleanupDone = join(dir, 'cleanup.done');
  const run = launch(dir, { SUITE_PID_FILE: suiteFile, DESCENDANT_PID_FILE: descendantFile, CLEANUP_PID_FILE: cleanupFile, CLEANUP_DONE_FILE: cleanupDone });
  let suitePid, descendantPid, cleanupPid;
  t.after(async () => {
    // Always stop our fixture processes, including when a lifetime assertion fails.
    try { cleanupPid = Number(readFileSync(cleanupFile, 'utf8').trim()); } catch {}
    for (const pid of [cleanupPid, descendantPid, suitePid, run.child.pid]) if (alive(pid)) process.kill(pid, 'SIGTERM');
    await until(() => !alive(suitePid) && !alive(descendantPid), 1000);
    // The fixture runs in its own group; also stop recovery spawned after the
    // leader exits when intentionally testing the old early-exit defect.
    if (suitePid) try { process.kill(-suitePid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (const pid of [cleanupPid, descendantPid, suitePid, run.child.pid]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await run.done;
  });
  const ready = await until(() => {
    try {
      suitePid = Number(readFileSync(suiteFile, 'utf8').trim());
      descendantPid = Number(readFileSync(descendantFile, 'utf8').trim());
      return alive(suitePid) && alive(descendantPid) && report(dir).suites[0]?.result === 'RUNNING';
    } catch { return false; }
  });
  assert.ok(ready, 'suite and descendant are alive and the runner records RUNNING');
  run.child.kill(signal);
  const result = await run.done;
  assert.equal(result.status, expectedExit, result.stderr);
  assert.ok(existsSync(cleanupDone), 'runner must wait for delayed recovery before exiting');
  assert.equal(readFileSync(cleanupDone, 'utf8').trim(), 'recovered', 'recovery completed before the runner exit');
  cleanupPid = Number(readFileSync(cleanupFile, 'utf8').trim());
  assert.equal(alive(cleanupPid), false, `recovery PID ${cleanupPid} already terminated`);
  assert.equal(alive(suitePid), false, `suite PID ${suitePid} already terminated`);
  assert.equal(alive(descendantPid), false, `descendant PID ${descendantPid} already terminated`);
  const receipt = matchingReports(dir);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.interrupted, true);
  assert.equal(receipt.suites[0].result, 'CANCELLED');
  assert.ok(receipt.suites.slice(1).every(s => s.result === 'NOT_RUN'));
});

test('cancellation bounds an unresponsive suite and preserves signal exit', async t => {
  const dir = setup(t, { first: 'trap "" TERM; echo $$ > "$SUITE_PID_FILE"; while :; do :; done' });
  const suiteFile = join(dir, 'stubborn.pid');
  const run = launch(dir, { SUITE_PID_FILE: suiteFile, DEVNET_CANCEL_GRACE_SECONDS: '1' });
  let suitePid;
  t.after(async () => {
    for (const pid of [suitePid, run.child.pid]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await run.done;
  });
  assert.ok(await until(() => {
    try { suitePid = Number(readFileSync(suiteFile, 'utf8').trim()); return alive(suitePid); } catch { return false; }
  }), 'unresponsive fixture is ready');
  const started = Date.now();
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 143, result.stderr);
  assert.ok(Date.now() - started < 5000, 'cancellation is bounded');
  assert.equal(alive(suitePid), false, 'unresponsive suite is reaped before runner exits');
  assert.match(result.stdout, /Cleanup grace expired/);
  assert.equal(matchingReports(dir).outcome, 'INCONCLUSIVE');
});

test('preflight failure preserves exit 2 and incomplete matching reports', async t => {
  const dir = setup(t);
  writeFileSync(join(dir, 'bin/curl'), '#!/bin/bash\nexit 7\n', { mode: 0o755 });
  const result = await launch(dir).done;
  assert.equal(result.status, 2, result.stderr);
  assert.equal(matchingReports(dir).outcome, 'INCONCLUSIVE');
});

test('pure reducer never passes empty, unknown or unfinished states', () => {
  for (const suites of [[], [{ result: 'PENDING' }], [{ result: 'RUNNING' }], [{ result: 'MISSING' }], [{ result: 'BOGUS' }],
    [{ result: 'SKIPPED' }], [{ result: 'PASS' }, { result: 'SKIPPED' }], [{ result: 'FAIL:1' }, { result: 'SKIPPED' }]]) {
    assert.equal(summarizeComprehensive(suites).outcome, 'INCONCLUSIVE');
  }
  assert.deepEqual(summarizeComprehensive([{ result: 'PASS' }, { result: 'SKIPPED' }]).totals,
    { pass: 1, fail: 0, missing: 0, skipped: 1, unfinished: 0, executed: 1, registered: 2 });
});
