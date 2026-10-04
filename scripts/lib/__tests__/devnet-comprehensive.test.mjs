import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  for (const key of ['SOAK_ONLY', 'SKIP_SOAK', 'SKIP_UI', 'SKIP_PROBES', 'SKIP_RFC38_EXTRAS', 'SKIP_RFC49', 'FAIL_FAST', 'DEVNET_DIR']) delete env[key];
  const child = spawn('bash', [join(dir, 'scripts/devnet-comprehensive.sh')], { env: { ...env, ...overrides } });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr })); });
  return { child, done };
}
const report = dir => JSON.parse(readFileSync(join(dir, 'results/REPORT.json'), 'utf8'));

test('complete valid run succeeds and snapshots every registered suite before execution', async t => {
  const dir = setup(t);
  const result = await launch(dir).done;
  assert.equal(result.status, 0, result.stderr);
  const receipt = report(dir);
  assert.equal(receipt.outcome, 'PASS'); assert.equal(receipt.completeSuccess, true);
  assert.equal(receipt.totals.pass, suiteFiles.length);
  const plan = JSON.parse(readFileSync(join(dir, 'results/PLAN.json'), 'utf8'));
  assert.equal(plan.suites.length, suiteFiles.length);
  assert.ok(plan.suites.every(s => s.result === 'PENDING'));
});

test('missing-only run is incomplete and nonzero', async t => {
  const dir = setup(t, { missing: suiteFiles });
  const result = await launch(dir).done;
  const receipt = report(dir);
  assert.equal(receipt.totals.missing, suiteFiles.length);
  assert.equal(result.status, 1, `MISSING=${receipt.totals.missing}, PASS=${receipt.totals.pass}, FAIL=${receipt.totals.fail}: missing-only run must block success`);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.totals.executed, 0);
  assert.equal(receipt.totals.missing, suiteFiles.length);
});

test('empty filtered run never succeeds', async t => {
  const dir = setup(t);
  const result = await launch(dir, { SOAK_ONLY: '1', SKIP_SOAK: '1' }).done;
  assert.equal(result.status, 1, result.stderr);
  assert.equal(report(dir).outcome, 'INCONCLUSIVE'); assert.equal(report(dir).totals.registered, 0);
});

test('valid exploratory selection remains usable and is explicitly partial', async t => {
  const dir = setup(t);
  const result = await launch(dir, { SKIP_SOAK: '1' }).done;
  assert.equal(result.status, 0, result.stderr);
  const receipt = report(dir);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.selectionOutcome, 'PASS');
  assert.equal(receipt.partial, true); assert.equal(receipt.completeSuccess, false);
  assert.deepEqual(receipt.filters, ['SKIP_SOAK=1']); assert.match(result.stdout, /PARTIAL exploratory/);
});

test('legacy exit 2 remains an individual FAIL:2 and does not get reinterpreted', async t => {
  const dir = setup(t, { first: 'exit 2' });
  const result = await launch(dir).done;
  assert.equal(result.status, 1, result.stderr);
  const receipt = report(dir);
  assert.equal(receipt.outcome, 'FAIL'); assert.equal(receipt.suites[0].result, 'FAIL:2');
});

test('confirmed failure and missing evidence are both retained', async t => {
  const dir = setup(t, { first: 'exit 1', missing: [suiteFiles[1]] });
  assert.equal((await launch(dir).done).status, 1);
  const receipt = report(dir);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.totals.fail, 1); assert.equal(receipt.totals.missing, 1);
  assert.equal(receipt.suites[0].result, 'FAIL:1'); assert.equal(receipt.suites[1].result, 'MISSING');
});

test('fail-fast preserves failure and unexecuted registered work', async t => {
  const dir = setup(t, { first: 'exit 1' });
  assert.equal((await launch(dir, { FAIL_FAST: '1' }).done).status, 1);
  const receipt = report(dir);
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

test('interruption terminates the ready suite and descendant and records unfinished work', async t => {
  const dir = setup(t, { first: `
echo $$ > "$SUITE_PID_FILE"
bash -c 'echo $$ > "$DESCENDANT_PID_FILE"; exec sleep 300' &
descendant=$!
trap 'wait "$descendant" 2>/dev/null || true; exit 0' TERM
wait "$descendant"
` });
  const suiteFile = join(dir, 'suite.pid'), descendantFile = join(dir, 'descendant.pid');
  const run = launch(dir, { SUITE_PID_FILE: suiteFile, DESCENDANT_PID_FILE: descendantFile });
  let suitePid, descendantPid;
  t.after(async () => {
    // Always stop our fixture processes, including when a lifetime assertion fails.
    for (const pid of [descendantPid, suitePid, run.child.pid]) if (alive(pid)) process.kill(pid, 'SIGTERM');
    await until(() => !alive(suitePid) && !alive(descendantPid), 1000);
    for (const pid of [descendantPid, suitePid, run.child.pid]) if (alive(pid)) process.kill(pid, 'SIGKILL');
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
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 143, result.stderr);
  assert.ok(await until(() => !alive(suitePid)), `suite PID ${suitePid} terminated`);
  assert.ok(await until(() => !alive(descendantPid)), `descendant PID ${descendantPid} terminated`);
  const receipt = report(dir);
  assert.equal(receipt.outcome, 'INCONCLUSIVE'); assert.equal(receipt.interrupted, true);
  assert.equal(receipt.suites[0].result, 'CANCELLED');
  assert.ok(receipt.suites.slice(1).every(s => s.result === 'NOT_RUN'));
});

test('pure reducer never passes empty, unknown or unfinished states', () => {
  for (const suites of [[], [{ result: 'PENDING' }], [{ result: 'RUNNING' }], [{ result: 'MISSING' }], [{ result: 'BOGUS' }]]) {
    assert.equal(summarizeComprehensive(suites).outcome, 'INCONCLUSIVE');
  }
});
