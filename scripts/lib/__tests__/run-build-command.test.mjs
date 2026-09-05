import assert from 'node:assert/strict';
import test from 'node:test';
import { runBuildCommand } from '../run-build-command.mjs';
import { runBuild } from '../../build.mjs';

test('build commands inherit stdio and preserve platform and environment overrides', () => {
  for (const platform of ['linux', 'win32']) {
    let invocation;
    const env = { PATH: '/test-bin' };
    assert.equal(runBuildCommand('pnpm', ['build'], {
      platform, env, spawn: (...args) => { invocation = args; return { status: 0 }; },
    }), 0);
    assert.deepEqual(invocation, ['pnpm', ['build'], { stdio: 'inherit', shell: platform === 'win32', env }]);
  }
});

test('build command failures retain exit status and diagnose spawn, signal and missing status', () => {
  const cases = [
    [{ status: 17 }, 17, []],
    [{ error: new Error('spawn failed') }, 1, ['spawn failed']],
    [{ status: null, signal: 'SIGTERM' }, 1, ['build fixture exited via SIGTERM']],
    [{ status: null }, 1, ['build fixture exited without a status']],
  ];
  for (const [result, expectedStatus, expectedErrors] of cases) {
    const errors = [];
    assert.equal(runBuildCommand('pnpm', ['build'], {
      spawn: () => result, label: 'build fixture', reportError: (message) => errors.push(message),
    }), expectedStatus);
    assert.deepEqual(errors, expectedErrors);
  }
});

test('root build runs UI only after successful unfiltered compilation', () => {
  for (const [extraArgs, statuses, expectedCalls, expectedStatus] of [
    [[], [0, 0], 2, 0], [[], [23], 1, 23], [[], [0, 19], 2, 19], [['--force'], [0], 1, 0],
  ]) {
    const calls = [];
    assert.equal(runBuild({ extraArgs, run: (...args) => { calls.push(args); return statuses[calls.length - 1]; } }), expectedStatus);
    assert.equal(calls.length, expectedCalls);
    assert.deepEqual(calls[0], ['turbo', ['build', ...extraArgs]]);
    if (expectedCalls === 2) assert.deepEqual(calls[1], ['pnpm', ['turbo', 'run', 'build:ui', '--filter=@origintrail-official/dkg-node-ui']]);
  }
});
