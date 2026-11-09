#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { boundaryTests } from './lib/qa-boundaries.mjs';
import { pnpmInvocation } from './lib/regressions/subprocess.mjs';
const { values } = parseArgs({ options: { base: { type: 'string', default: 'origin/testnet-canary' }, list: { type: 'boolean', default: false } } });
const root = path.resolve(import.meta.dirname, '..');
const base = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values.base}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const paths = execFileSync('git', ['diff', '--name-only', '-z', base, '--'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const tests = boundaryTests(paths);
console.log(JSON.stringify({ status: tests.length ? 'selected' : 'not-applicable', base, tests }, null, 2));
if (tests.length && !values.list) {
  const invocation = pnpmInvocation(['--dir', 'packages/agent', 'exec', 'vitest', 'run', '--config', 'vitest.unit.config.ts', ...tests]);
  execFileSync(invocation.command, invocation.args, { cwd: root, stdio: 'inherit', timeout: 300_000 });
}
