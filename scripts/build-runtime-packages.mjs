#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  RUNTIME_CLI_PACKAGE,
  runtimeDependencyBuildPnpmArgs,
} from './lib/runtime-build-plan.mjs';
import { runBuildCommand } from './lib/run-build-command.mjs';

export function runRuntimePackageBuild({
  extraArgs = process.argv.slice(2),
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
  reportError = (message) => console.error(message),
} = {}) {
  const dependencyStatus = runBuildCommand(
    'pnpm',
    runtimeDependencyBuildPnpmArgs(['run', 'build', ...extraArgs]),
    {
      spawn,
      platform,
      env,
      reportError,
      label: 'runtime dependency build',
    },
  );
  if (dependencyStatus !== 0) return dependencyStatus;

  return runBuildCommand('pnpm', ['--filter', RUNTIME_CLI_PACKAGE, 'run', 'build:prepared'], {
    spawn,
    platform,
    reportError,
    env,
    label: 'prepared CLI build',
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = runRuntimePackageBuild();
}
