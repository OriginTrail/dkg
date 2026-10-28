import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pnpmInvocation } from './subprocess.mjs';
import { REQUIRED_ROUTE } from './profile-contract.mjs';

export function namedTestDiscoveryInvocation(files, options) {
  // --json takes an optional output filename: it must stay last to avoid
  // overwriting one of the selected source files with the discovery report.
  return pnpmInvocation(['--dir', 'packages/agent', 'exec', 'vitest', 'list', '--config', REQUIRED_ROUTE.config,
    ...[...new Set(files)].map(file => file.replace('packages/agent/', '')), '--json'], options);
}
export function discoverNamedTests(root, files) {
  const invocation = namedTestDiscoveryInvocation(files);
  const result = spawnSync(invocation.command, invocation.args, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`named test discovery failed: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(result.stdout).map(row => ({ file: path.relative(root, row.file).split(path.sep).join('/'), name: row.name }));
}
