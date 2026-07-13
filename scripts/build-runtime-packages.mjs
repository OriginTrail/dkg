#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runtimeBuildPnpmArgs } from './lib/runtime-build-plan.mjs';

export function runRuntimePackageBuild({
  extraArgs = process.argv.slice(2),
  spawn = spawnSync,
  platform = process.platform,
  reportError = (message) => console.error(message),
} = {}) {
  const args = runtimeBuildPnpmArgs(['run', 'build', ...extraArgs]);
  const result = spawn('pnpm', args, {
    stdio: 'inherit',
    shell: platform === 'win32',
  });

  if (result.error) {
    reportError(result.error.message);
    return 1;
  }
  if (typeof result.status === 'number') return result.status;
  if (result.signal) {
    reportError(`pnpm ${args.join(' ')} exited via ${result.signal}`);
    return 1;
  }
  reportError(`pnpm ${args.join(' ')} exited without a status`);
  return 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = runRuntimePackageBuild();
}
