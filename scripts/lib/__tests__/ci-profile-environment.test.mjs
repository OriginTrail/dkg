import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { profileEnvironment } from '../../ci/apply-ci-profile.mjs';
import { resolveCiProfile } from '../../ci/resolve-ci-profile.mjs';
import { runVitestJunit } from '../../ci/run-vitest-junit.mjs';

const subject = 'a'.repeat(40);
test('shared setup passes standard/nightly settings to test runners and browser metadata', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-profile-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'packages/publisher'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages/publisher/package.json'), JSON.stringify({ devDependencies: { vitest: '*' } }));
  const originalEnv = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv); });
  for (const [profile, seed, runs, local] of [['standard', '640905', '100', '0'], ['nightly-equivalent', '13064', '1000', '1'], ['nightly-equivalent', '0', '1000', '1']]) {
    const record = { ...resolveCiProfile({ eventName: 'workflow_dispatch', profile, seed }), subject, runId: '40079149573' };
    const envFile = path.join(dir, 'env');
    fs.writeFileSync(envFile, '');
    execFileSync(process.execPath, ['scripts/ci/apply-ci-profile.mjs'], {
      env: { ...originalEnv, PROFILE_JSON: JSON.stringify(record), GITHUB_SHA: subject, GITHUB_ENV: envFile },
    });
    const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').trim().split('\n').map(line => line.split('=')));
    assert.deepEqual(env, { DKG_PROPERTY_RUNS: runs, DKG_PROPERTY_SEED: seed, DKG_CI_PROFILE: profile, DKG_CI_SUBJECT: subject, PW_DEVNET_LOCAL: local });
    Object.assign(process.env, env);
    let seen = false;
    // Observe the actual package runner boundary without running unrelated suites.
    const code = runVitestJunit(['--lane', 'publisher'], { repoRoot: dir, coverage: false, spawnProcess: (_command, _args, options) => {
      seen = true;
      for (const [key, value] of Object.entries(env)) assert.equal(options.env[key], value);
      return { status: 17 };
    } });
    assert.equal(code, 17); assert.equal(seen, true);
    const browser = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "import config from './packages/node-ui/playwright.config.ts'; console.log(JSON.stringify({ metadata: config.metadata, ignore: config.testIgnore }));"],
    { env: { ...originalEnv, ...env }, encoding: 'utf8' }));
    assert.equal(browser.metadata.subject, subject);
    assert.equal(browser.metadata.seed, seed);
    assert.equal(browser.metadata.requestedTrials, runs);
    assert.equal(browser.metadata.profile, profile);
    assert.equal(browser.metadata.managedLocal, local === '1');
    assert.deepEqual(browser.ignore, local === '1' ? [] : ['**/devnet-local/**']);
  }
});

test('invalid or stale profiles cannot publish partial runner settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-profile-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = { ...resolveCiProfile({ eventName: 'schedule', runNumber: '13064' }), subject, runId: '40079149573' };
  for (const bad of [null, { ...record, seed: '13064' }, { ...record, subject: 'wrong' },
    { ...record, seed: 2147483648 }, { ...record, requestedTrials: 100 }, { ...record, managedLocal: false }]) {
    assert.throws(() => profileEnvironment(bad));
  }
  const envFile = path.join(dir, 'env');
  const result = spawnSync(process.execPath, ['scripts/ci/apply-ci-profile.mjs'], {
    env: { ...process.env, PROFILE_JSON: JSON.stringify(record), GITHUB_SHA: 'b'.repeat(40), GITHUB_ENV: envFile },
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(envFile), false);
});
