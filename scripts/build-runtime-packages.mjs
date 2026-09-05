#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  RUNTIME_CLI_PACKAGE,
  runtimeCliPrerequisiteBuildPnpmArgs,
  runtimeDependentBuildPnpmArgs,
} from './lib/runtime-build-plan.mjs';
import { runBuildCommand } from './lib/run-build-command.mjs';

export function runRuntimePackageBuild({
  extraArgs = process.argv.slice(2),
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
  reportError = (message) => console.error(message),
} = {}) {
  const prerequisiteStatus = runBuildCommand(
    'pnpm',
    runtimeCliPrerequisiteBuildPnpmArgs(['run', 'build', ...extraArgs]),
    {
      spawn,
      platform,
      env,
      reportError,
      label: 'CLI prerequisite build',
    },
  );
  if (prerequisiteStatus !== 0) return prerequisiteStatus;

  const cliStatus = runBuildCommand('pnpm', ['--filter', RUNTIME_CLI_PACKAGE, 'run', 'build:prepared'], {
    spawn,
    platform,
    reportError,
    env,
    label: 'prepared CLI build',
  });
  if (cliStatus !== 0) return cliStatus;

  return runBuildCommand(
    'pnpm',
    runtimeDependentBuildPnpmArgs(['run', 'build', ...extraArgs]),
    {
      spawn,
      platform,
      reportError,
      env,
      label: 'runtime dependent build',
    },
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = runRuntimePackageBuild();
}
