#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runBuildCommand } from './lib/run-build-command.mjs';

export function runBuild({ extraArgs = process.argv.slice(2), run = runBuildCommand } = {}) {
  const status = run('turbo', ['build', ...extraArgs]);
  if (status !== 0 || extraArgs.length > 0) return status;
  return run('pnpm', ['turbo', 'run', 'build:ui', '--filter=@origintrail-official/dkg-node-ui']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runBuild();
}
