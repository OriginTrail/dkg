import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runRuntimePackageBuild } from '../../build-runtime-packages.mjs';
import {
  buildCliPrerequisites,
  CLI_PREREQUISITE_ROOTS,
} from '../../../packages/cli/scripts/build-prerequisites.mjs';
import {
  RUNTIME_BUILD_EXCLUSIONS,
  RUNTIME_CLI_PACKAGE,
  runtimeBuildPhases,
  runtimeBuildPnpmArgs,
} from '../runtime-build-plan.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const REQUIRED_RUNTIME_PACKAGES = [
  '@origintrail-official/dkg-http-utils',
  '@origintrail-official/dkg',
  '@origintrail-official/dkg-adapter-hermes',
  '@origintrail-official/dkg-adapter-openclaw',
  '@origintrail-official/dkg-agent',
  '@origintrail-official/dkg-chain',
  '@origintrail-official/dkg-core',
  '@origintrail-official/dkg-epcis',
  '@origintrail-official/dkg-graph-viz',
  '@origintrail-official/dkg-mcp',
  '@origintrail-official/dkg-node-ui',
  '@origintrail-official/dkg-okf',
  '@origintrail-official/dkg-publisher',
  '@origintrail-official/dkg-query',
  '@origintrail-official/dkg-random-sampling',
  '@origintrail-official/dkg-rdf-utils',
  '@origintrail-official/dkg-storage',
  '@origintrail-official/kafka-plugin',
];

test('public runtime build script delegates to the checked build plan', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  assert.equal(
    packageJson.scripts?.['build:runtime:packages'],
    'node scripts/build-runtime-packages.mjs',
    'pnpm run build:runtime:packages must use the checked phased entrypoint',
  );
});

test('runtime build entrypoint invokes pnpm with the checked plan and forwards extra arguments', () => {
  const invocations = [];
  const status = runRuntimePackageBuild({
    extraArgs: ['--force', '--log-order=stream'],
    platform: 'linux',
    env: { PATH: '/mock-bin' },
    spawn(command, args, options) {
      invocations.push({ command, args, options });
      return { status: 0, signal: null };
    },
    reportError(message) {
      assert.fail(`successful runtime build must not report an error: ${message}`);
    },
  });

  assert.equal(status, 0);
  const phases = runtimeBuildPhases({
    runtimeOperation: ['run', 'build', '--force', '--log-order=stream'],
  });
  assert.deepEqual(invocations, phases.map((phase) => ({
    command: 'pnpm',
    args: phase.args,
    options: { stdio: 'inherit', shell: false, env: { PATH: '/mock-bin' } },
  })));
});

test('CLI exposes explicit standalone and prepared build paths', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/cli/package.json'), 'utf8'));
  assert.equal(packageJson.scripts.prebuild, undefined);
  assert.equal(packageJson.scripts.build, 'pnpm run build:prerequisites && pnpm run build:prepared');
  assert.equal(packageJson.scripts['build:prerequisites'], 'node scripts/build-prerequisites.mjs');
  assert.match(packageJson.scripts['build:prepared'], /^tsc /);
});

test('standalone CLI prerequisite entrypoint always builds its dependency graph', () => {
  for (const env of [{ PATH: '/mock-bin' }, { PATH: '/mock-bin', CI: 'true' }]) {
    let invocation;
    assert.equal(buildCliPrerequisites({ env, platform: 'win32', spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0 };
    } }), 0);
    assert.equal(invocation.command, 'pnpm');
    assert.equal(invocation.options.shell, true);
    assert.deepEqual(invocation.options.env, env);
    assert.deepEqual(invocation.args, [
      '-r', ...CLI_PREREQUISITE_ROOTS.flatMap(name => ['--filter', `${name}...`]), 'run', 'build',
    ]);
  }
});

test('standalone CLI prerequisite failures propagate instead of allowing compilation', () => {
  const messages = [];
  for (const [result, expected] of [
    [{ status: 17 }, 17],
    [{ error: new Error('spawn failed') }, 1],
    [{ status: null, signal: 'SIGTERM' }, 1],
  ]) {
    assert.equal(buildCliPrerequisites({ env: {}, spawn: () => result, reportError: message => messages.push(message) }), expected);
  }
  assert.deepEqual(messages, ['spawn failed', 'CLI prerequisites exited via SIGTERM']);
});

test('runtime build entrypoint propagates process failures', () => {
  const messages = [];
  const reportError = (message) => messages.push(message);

  assert.equal(runRuntimePackageBuild({
    spawn: () => ({ status: 23, signal: null }),
    reportError,
  }), 23);
  assert.equal(runRuntimePackageBuild({
    spawn: () => ({ status: null, signal: null, error: new Error('spawn failed') }),
    reportError,
  }), 1);
  assert.equal(runRuntimePackageBuild({
    spawn: () => ({ status: null, signal: 'SIGTERM' }),
    reportError,
  }), 1);

  assert.equal(messages[0], 'spawn failed');
  assert.match(messages[1], /exited via SIGTERM$/);
});

test('runtime build stops on the first nonzero phase status', () => {
  for (const failingPhase of [0, 1, 2]) {
    let invocations = 0;
    assert.equal(runRuntimePackageBuild({
      spawn() {
        const status = invocations === failingPhase ? 9 : 0;
        invocations += 1;
        return { status, signal: null };
      },
    }), 9);
    assert.equal(invocations, failingPhase + 1);
  }
});

test('release runtime build plan includes workspace dependencies but excludes Hardhat', () => {
  assert.ok(
    RUNTIME_BUILD_EXCLUSIONS.includes('@origintrail-official/dkg-evm-module'),
    'runtime dependency closure must explicitly subtract evm-module',
  );

  // Resolve the canonical filters with pnpm's read-only workspace listing.
  const planArgs = runtimeBuildPnpmArgs(['list', '--depth', '-1', '--json']);
  const selected = JSON.parse(execFileSync(PNPM, planArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }));
  const selectedNames = new Set(selected.map((workspace) => workspace.name));

  const phases = runtimeBuildPhases({
    runtimeOperation: ['list', '--depth', '-1', '--json'],
    preparedCliOperation: ['list', '--depth', '-1', '--json'],
  });
  assert.deepEqual(phases.map(({ label }) => label), [
    'CLI prerequisite build',
    'prepared CLI build',
    'runtime dependent build',
  ]);
  const phasePlans = phases.map(({ args }) => JSON.parse(execFileSync(PNPM, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })));
  const prerequisiteNames = new Set(phasePlans[0].map((workspace) => workspace.name));
  const preparedCliNames = new Set(phasePlans[1].map((workspace) => workspace.name));
  const dependentNames = new Set(phasePlans[2].map((workspace) => workspace.name));

  for (const packageName of REQUIRED_RUNTIME_PACKAGES) {
    assert.ok(selectedNames.has(packageName), `${packageName} must remain in the runtime build`);
  }
  for (const packageName of CLI_PREREQUISITE_ROOTS) {
    assert.ok(
      selectedNames.has(packageName),
      `${packageName} must be present in the complete runtime plan`,
    );
  }
  assert.equal(prerequisiteNames.has(RUNTIME_CLI_PACKAGE), false, 'prepared CLI build must run only after prerequisites');
  assert.deepEqual(preparedCliNames, new Set([RUNTIME_CLI_PACKAGE]));
  for (const packageName of CLI_PREREQUISITE_ROOTS) {
    assert.ok(prerequisiteNames.has(packageName), `${packageName} must remain in the prerequisite phase`);
  }
  assert.ok(dependentNames.has('@origintrail-official/kafka-plugin'), 'CLI consumers must build after the prepared CLI');
  for (const packageName of prerequisiteNames) {
    assert.equal(dependentNames.has(packageName), false, `${packageName} must not be rebuilt after the CLI`);
  }
  assert.deepEqual(
    new Set([...prerequisiteNames, ...preparedCliNames, ...dependentNames]),
    selectedNames,
    'the three explicit phases must partition the complete runtime plan',
  );
  assert.equal(
    selectedNames.has('@origintrail-official/dkg-evm-module'),
    false,
    'node-host releases must use committed ABIs instead of compiling Solidity',
  );

  for (const workspace of selected) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(workspace.path, 'package.json'), 'utf8'));
    assert.doesNotMatch(
      packageJson.scripts?.build ?? '',
      /hardhat/i,
      `${workspace.name} must not invoke Hardhat in the release runtime build`,
    );
  }
});
