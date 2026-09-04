#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runtimeBuildPnpmArgs } from './lib/runtime-build-plan.mjs';
import { runBuildCommand } from './lib/run-build-command.mjs';

export function runRuntimePackageBuild({
  extraArgs = process.argv.slice(2),
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
  reportError = (message) => console.error(message),
} = {}) {
  const args = runtimeBuildPnpmArgs(['run', 'build', ...extraArgs]);
  return runBuildCommand('pnpm', args, {
    spawn,
    platform,
    reportError,
    // pnpm's recursive plan builds the complete dependency closure in order.
    // The CLI prebuild hook can therefore avoid recursively building it again.
    env: { ...env, DKG_RUNTIME_BUILD_TOPOLOGICAL: '1' },
  });

}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = runRuntimePackageBuild();
}
