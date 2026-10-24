import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { EVM_SCOPES } from '../ci-delta.mjs';
import { EVM_TEST_SCOPES, EVM_REPO_ROOT, evmFilesForPackage } from '../../ci/evm-test-scopes.mjs';
import { runEvmIntegration } from '../../run-evm-integration.mjs';

test('the manifest covers canonical scopes and drives every real Vitest integration include', () => {
  assert.deepEqual(Object.keys(EVM_TEST_SCOPES), EVM_SCOPES);
  for (const { packageDirectory, files } of Object.values(EVM_TEST_SCOPES)) {
    const cwd = path.join(EVM_REPO_ROOT, packageDirectory);
    const result = spawnSync('pnpm', ['exec', 'vitest', 'list', '--filesOnly', '--json', '--config', path.join(EVM_REPO_ROOT, 'vitest.evm-integration.ts')], { cwd, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    const discovered = JSON.parse(result.stdout).map(({ file }) => path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/')).sort();
    assert.deepEqual(discovered, [...files].sort());
    assert.deepEqual(evmFilesForPackage(cwd), [...files]);
  }
  assert.throws(() => evmFilesForPackage(path.join(EVM_REPO_ROOT, 'packages/core')), /No dedicated EVM tests/);
});

test('runner routes every requested file once and continues after a failed test', (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'dkg-evm-routing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runFixture = (scope, options) => runEvmIntegration(scope, { ...options, repoRoot: root });
  for (const selection of [...EVM_SCOPES, 'all']) {
    const expectedScopes = selection === 'all' ? EVM_SCOPES : [selection];
    const expected = expectedScopes.flatMap((scope) => {
      const { packageDirectory, files } = EVM_TEST_SCOPES[scope];
      return files.map((file) => ({ cwd: path.join(root, packageDirectory), file }));
    });
    const calls = [];
    const status = runFixture(selection, { checkReport: () => true, run: (command, args, options) => {
      assert.equal(command, 'pnpm');
      assert.deepEqual(args.slice(0, 3), ['exec', 'vitest', 'run']);
      assert.deepEqual(args.slice(4, 8), ['--config', path.join(root, 'vitest.evm-integration.ts'), '--reporter=verbose', '--reporter=junit']);
      assert.match(args[8], /--outputFile\.junit=.*test-results[/\\]evm-.*\.xml$/);
      calls.push({ cwd: options.cwd, file: args[3] });
      return { status: calls.length === 1 ? 7 : 0 };
    } });
    assert.equal(status, 1);
    assert.deepEqual(calls, expected);
  }
  assert.equal(runFixture('chain', { checkReport: () => true, run: () => ({ status: 0 }) }), 0);
  assert.equal(runFixture('chain', { checkReport: () => false, run: () => ({ status: 0 }) }), 1);
  assert.equal(runFixture('chain', { run: () => ({ error: new Error('spawn failed') }) }), 1);
  assert.throws(() => runFixture('unknown', { run: () => assert.fail('must not execute') }), /Unknown EVM scope/);
});

test('EVM evidence requires executed cases in every selected file', (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'dkg-evm-junit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const valid = '<testsuites tests="2"><testsuite><testcase name="executed"/><testcase name="pending"><skipped/></testcase></testsuite></testsuites>';
  for (const [xml, expected] of [
    [valid, 0],
    ['<testsuites tests="0"/>', 1],
    ['<testsuites tests="1" skipped="1"><testsuite tests="1" skipped="1"><testcase><skipped/></testcase></testsuite></testsuites>', 1],
    ['<testsuite><testcase/></broken>', 1],
    ['<testsuite><testcase><failure/></testcase></testsuite>', 1],
  ]) {
    let calls = 0;
    assert.equal(runEvmIntegration('agent', { repoRoot: root, run: (_command, args) => {
      const report = args.find((arg) => arg.startsWith('--outputFile.junit=')).slice('--outputFile.junit='.length);
      fs.writeFileSync(report, calls++ === 0 ? xml : valid);
      return { status: 0 };
    } }), expected);
    assert.equal(calls, EVM_TEST_SCOPES.agent.files.length, 'invalid evidence must not drop later journeys');
  }
});
