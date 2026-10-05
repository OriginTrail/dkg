import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { validateNode26Evidence } from '../ci-results.mjs';
import { EXPECTED_NODE26_ASSERTIONS, REPO_ROOT } from './ci-plan-fixtures.mjs';

const runner = path.join(REPO_ROOT, 'scripts/ci/run-chain-rpc-node26.mjs');
const initialOutput = 'existing=preserved\n';
const fixtureVersions = { node: '26.7.0', undici: '8.9.0' };
const passingReport = () => ({
  success: true,
  testResults: [0, 2].map((offset) => ({
    assertionResults: EXPECTED_NODE26_ASSERTIONS.slice(offset, offset + 2).map((fullName) => ({
      fullName, title: 'use fullName, not the short title', status: 'passed',
    })),
  })),
});

function fixture(t, { report = passingReport(), exitCode = 0, omitReport = false, malformed = false, versions = fixtureVersions, requireFetch = '1', staleReport = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-node26-collector-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'results');
  fs.mkdirSync(output);
  if (staleReport) fs.writeFileSync(path.join(output, 'vitest.json'), JSON.stringify(passingReport()));
  const githubOutput = path.join(directory, 'github-output');
  fs.writeFileSync(githubOutput, initialOutput);
  const scenario = path.join(directory, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ report, exitCode, omitReport, malformed, versions }));
  const child = path.join(directory, 'child.mjs');
  fs.writeFileSync(child, `
    import fs from 'node:fs';
    const scenario = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    fs.writeFileSync(process.argv[3] + '.started', 'yes');
    if (!scenario.omitReport) fs.writeFileSync(process.argv[2], scenario.malformed ? '{broken' : JSON.stringify(scenario.report));
    process.exitCode = scenario.exitCode;
  `);
  const harness = path.join(directory, 'harness.mjs');
  // Synthetic runtime metadata permits collection tests in the Node 22 build
  // job. Only the execution/runtime boundary is replaced: an actual child writes
  // a Vitest-shaped report and exits; the production collector decides the verdict
  // and GITHUB_OUTPUT. The real Node 26 workflow verifies actual runtime separately.
  fs.writeFileSync(harness, `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { runChainRpcNode26 } from ${JSON.stringify(pathToFileURL(runner).href)};
    const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenario)}, 'utf8'));
    process.exitCode = runChainRpcNode26({
      output: ${JSON.stringify(output)}, versions: scenario.versions,
      runVitest: (reportPath) => spawnSync(process.execPath, [${JSON.stringify(child)}, reportPath, ${JSON.stringify(scenario)}], { env: process.env, stdio: 'inherit' }),
    });
  `);
  const result = spawnSync(process.execPath, [harness], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, DKG_REQUIRE_UNDICI8_FETCH: requireFetch, GITHUB_OUTPUT: githubOutput },
  });
  assert.ifError(result.error);
  return {
    result,
    evidence: JSON.parse(fs.readFileSync(path.join(output, 'evidence.json'), 'utf8')),
    published: fs.readFileSync(githubOutput, 'utf8'),
    childStarted: fs.existsSync(`${scenario}.started`),
    reportExists: fs.existsSync(path.join(output, 'vitest.json')),
  };
}

function rejected(attempt) {
  assert.equal(attempt.result.status, 1, attempt.result.stdout + attempt.result.stderr);
  assert.equal(attempt.published, initialOutput, 'rejected execution must not publish evidence');
  assert.doesNotMatch(attempt.result.stdout, /all four required transport assertions passed/);
  assert.ok(validateNode26Evidence(attempt.evidence).length);
}

test('collector publishes evidence only after a successful child and all required assertions pass', (t) => {
  const attempt = fixture(t);
  assert.equal(attempt.result.status, 0, attempt.result.stderr);
  assert.equal(attempt.childStarted, true);
  assert.deepEqual(attempt.evidence, {
    version: 1, ...fixtureVersions, requireUndici8Fetch: true, success: true,
    assertions: EXPECTED_NODE26_ASSERTIONS.map((name) => ({ name, status: 'passed' })),
  });
  assert.deepEqual(validateNode26Evidence(attempt.evidence), []);
  assert.equal(attempt.published, `${initialOutput}evidence=${JSON.stringify(attempt.evidence)}\n`);
  assert.match(attempt.result.stdout, /all four required transport assertions passed/);
});

test('collector rejects a nonzero child exit even when its report passes every required assertion', (t) => {
  const attempt = fixture(t, { exitCode: 1 });
  rejected(attempt);
  assert.equal(attempt.childStarted, true);
  assert.equal(attempt.evidence.success, false);
  assert.equal(attempt.evidence.assertions.length, 4);
  assert.ok(attempt.evidence.assertions.every(({ status }) => status === 'passed'));
  assert.match(attempt.result.stderr, /test execution did not succeed/);
});

test('collector rejects an unsuccessful report even when the child exits zero and every assertion passes', (t) => {
  const attempt = fixture(t, { report: { ...passingReport(), success: false } });
  rejected(attempt);
  assert.equal(attempt.evidence.success, false);
  assert.ok(attempt.evidence.assertions.every(({ status }) => status === 'passed'));
});

for (const name of EXPECTED_NODE26_ASSERTIONS) {
  test(`collector rejects a skipped required assertion in a successful child/report: ${name}`, (t) => {
    const report = passingReport();
    report.testResults.flatMap(({ assertionResults }) => assertionResults).find(({ fullName }) => fullName === name).status = 'pending';
    const attempt = fixture(t, { report });
    rejected(attempt);
    assert.equal(attempt.evidence.success, true, 'child and report passed; assertion validation must still reject');
    assert.equal(attempt.evidence.assertions.find((assertion) => assertion.name === name).status, 'pending');
    assert.ok(attempt.result.stderr.includes(name));
  });
}

test('collector discards a stale successful report when the child produces no report', (t) => {
  const attempt = fixture(t, { omitReport: true, staleReport: true });
  rejected(attempt);
  assert.equal(attempt.childStarted, true);
  assert.equal(attempt.reportExists, false);
  assert.deepEqual(attempt.evidence.assertions, []);
  assert.equal(attempt.evidence.success, false);
});

test('collector rejects malformed JSON without publishing evidence', (t) => {
  const attempt = fixture(t, { malformed: true });
  rejected(attempt);
  assert.deepEqual(attempt.evidence.assertions, []);
  assert.equal(attempt.evidence.success, false);
});

test('collector runtime and environment guards reject before starting the child', (t) => {
  for (const options of [
    { versions: { node: '22.23.2', undici: '6.23.0' } },
    { versions: { node: '26.7.0', undici: '6.23.0' } },
    { requireFetch: '0' },
  ]) {
    const attempt = fixture(t, options);
    rejected(attempt);
    assert.equal(attempt.childStarted, false);
    assert.deepEqual(attempt.evidence.assertions, []);
    assert.match(attempt.result.stderr, /requires Node 26 with bundled undici 8/);
  }
});

test('collector CLI uses the actual interpreter runtime and its default execution boundary', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-node26-cli-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const githubOutput = path.join(output, 'github-output');
  fs.writeFileSync(githubOutput, initialOutput);
  const result = spawnSync(process.execPath, [runner, output], {
    encoding: 'utf8', timeout: 150_000,
    env: { ...process.env, DKG_REQUIRE_UNDICI8_FETCH: '1', GITHUB_OUTPUT: githubOutput },
  });
  assert.ifError(result.error);
  const evidence = JSON.parse(fs.readFileSync(path.join(output, 'evidence.json'), 'utf8'));
  assert.equal(evidence.node, process.versions.node);
  assert.equal(evidence.undici, process.versions.undici);
  if (process.versions.node.startsWith('26.') && process.versions.undici?.startsWith('8.')) {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(validateNode26Evidence(evidence), []);
    assert.equal(fs.readFileSync(githubOutput, 'utf8'), `${initialOutput}evidence=${JSON.stringify(evidence)}\n`);
  } else {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires Node 26 with bundled undici 8/);
    assert.equal(fs.readFileSync(githubOutput, 'utf8'), initialOutput);
    assert.deepEqual(evidence.assertions, []);
  }
});
