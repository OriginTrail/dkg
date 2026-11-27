import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEANUP_TIMEOUT_ENV, DEFAULT_CLEANUP_TIMEOUT_MS, certifyInstall, cleanupTimeoutMs, dockerCleanup } from '../package-certification/certify.mjs';
import { recordAttempt } from '../package-certification/attempt.mjs';
import { readJson } from '../package-certification/bundle.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const container = 'dkg-cert-fixture-core-slot';
const originalPath = process.env.PATH;

// A stand-in `docker`, first on PATH, that records its arguments and then runs `body`.
function fakeDocker(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), output = path.join(root, 'attempt'), calls = path.join(root, 'calls.log');
  fs.mkdirSync(bin); fs.mkdirSync(output);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${quote(calls)}\n${body}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  return { output, log: path.join(output, 'controller.log'), calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n') };
}

// One attempt whose only work is the container removal certifyInstall runs after each layout.
function removeInAttempt(f, env) {
  const removeContainer = dockerCleanup(f.log, env);
  const receipt = { outcome: 'INCOMPLETE', layouts: [], errors: [], evidence: [] };
  const attempt = recordAttempt({ output: f.output, receipt, work: () => {},
    cleanup: safely => safely('cleanup', () => removeContainer(['rm', '-f', container])),
    verify: () => {},
  });
  return { attempt, receipt: () => readJson(path.join(f.output, 'receipt.json')) };
}

test('cleanup commands get 180 s unless the setting names another whole number of milliseconds', () => {
  assert.equal(DEFAULT_CLEANUP_TIMEOUT_MS, 180_000);
  assert.equal(cleanupTimeoutMs({}), 180_000);
  assert.equal(cleanupTimeoutMs({ [CLEANUP_TIMEOUT_ENV]: '' }), 180_000);
  for (const [value, limit] of [['600000', 600_000], ['1', 1], ['2147483647', 2_147_483_647]]) {
    assert.equal(cleanupTimeoutMs({ [CLEANUP_TIMEOUT_ENV]: value }), limit);
  }
  // Past 2^31 - 1 ms a Node timer fires at once, so every cleanup would time out.
  for (const value of ['0', '-1', '1.5', '1e3', ' 600000', '600000ms', '180s', 'abc', '0600', '2147483648', '99999999999']) {
    assert.throws(() => cleanupTimeoutMs({ [CLEANUP_TIMEOUT_ENV]: value }),
      error => error.message.includes(CLEANUP_TIMEOUT_ENV) && error.message.includes(JSON.stringify(value)), value);
  }
});

test('a malformed cleanup limit stops certification before the attempt directory exists', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env[CLEANUP_TIMEOUT_ENV];
  process.env[CLEANUP_TIMEOUT_ENV] = '180s';
  t.after(() => { if (previous === undefined) delete process.env[CLEANUP_TIMEOUT_ENV]; else process.env[CLEANUP_TIMEOUT_ENV] = previous; });
  const output = path.join(root, 'attempt');
  await assert.rejects(certifyInstall({ rootDir: root, bundle: path.join(root, 'bundle'), output, expected: {} }),
    new RegExp(`${CLEANUP_TIMEOUT_ENV} must be a whole number of milliseconds`));
  assert.equal(fs.existsSync(output), false);
});

test('a slow container removal passes within the limit and leaves the attempt INCOMPLETE past it', async t => {
  const slow = fakeDocker(t, 'exec sleep 2');
  const passing = removeInAttempt(slow, {});
  assert.equal((await passing.attempt).outcome, 'PASS');
  assert.deepEqual(passing.receipt().errors, []);
  assert.deepEqual(slow.calls(), [`rm -f ${container}`]);

  // The same removal under a 200 ms limit. It can be stopped before it writes
  // its call record, so only the receipt is checked.
  const cut = fakeDocker(t, 'exec sleep 2');
  const failing = removeInAttempt(cut, { [CLEANUP_TIMEOUT_ENV]: '200' });
  await assert.rejects(failing.attempt, /Package certification INCOMPLETE/);
  const receipt = failing.receipt();
  assert.equal(receipt.outcome, 'INCOMPLETE');
  assert.deepEqual(receipt.errors.map(e => e.phase), ['cleanup']);
  assert.match(receipt.errors[0].message, /docker; see controller\.log timed out after 200 ms/);
});

test('a container removal that fails leaves the attempt INCOMPLETE', async t => {
  const broken = fakeDocker(t, 'echo "Error response from daemon: removal of container failed" >&2\nexit 1');
  const failing = removeInAttempt(broken, {});
  await assert.rejects(failing.attempt, /Package certification INCOMPLETE/);
  const receipt = failing.receipt();
  assert.equal(receipt.outcome, 'INCOMPLETE');
  assert.deepEqual(receipt.errors.map(e => e.phase), ['cleanup']);
  assert.match(receipt.errors[0].message, /docker; see controller\.log closed \(code 1/);
  assert.match(fs.readFileSync(broken.log, 'utf8'), /removal of container failed/);
});
