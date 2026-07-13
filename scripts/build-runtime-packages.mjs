#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { runtimeBuildPnpmArgs } from './lib/runtime-build-plan.mjs';

const args = runtimeBuildPnpmArgs(['run', 'build', ...process.argv.slice(2)]);
const result = spawnSync('pnpm', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (typeof result.status === 'number' && result.status !== 0) {
  process.exit(result.status);
}
if (result.signal) {
  console.error(`pnpm ${args.join(' ')} exited via ${result.signal}`);
  process.exit(1);
}
