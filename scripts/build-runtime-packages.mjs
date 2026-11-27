#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runtimeBuildPhases } from './lib/runtime-build-plan.mjs';
import { runBuildCommand } from './lib/run-build-command.mjs';

export function runRuntimePackageBuild({
  extraArgs = process.argv.slice(2),
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
  reportError = (message) => console.error(message),
} = {}) {
  const phases = runtimeBuildPhases({
    runtimeOperation: ['run', 'build', ...extraArgs],
  });
  for (const phase of phases) {
    const status = runBuildCommand('pnpm', phase.args, {
      spawn,
      platform,
      env,
      reportError,
      label: phase.label,
    });
    if (status !== 0) return status;
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = runRuntimePackageBuild();
}
