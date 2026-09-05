import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Vitest owns eligibility; listing files does not execute globalSetup. */
export function discoverVitestFiles(packageRoot, { run = spawnSync } = {}) {
  const result = run('pnpm', ['exec', 'vitest', 'list', '--filesOnly', '--json'], {
    cwd: packageRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Vitest discovery failed in ${packageRoot}: ${result.error?.message ?? result.stderr}`);
  }
  const records = JSON.parse(result.stdout);
  if (!Array.isArray(records) || records.length === 0) throw new Error('Vitest discovered no test files');
  const files = records.map(({ file }) => {
    if (typeof file !== 'string') throw new Error('Invalid Vitest test path');
    const relative = path.relative(packageRoot, path.resolve(packageRoot, file)).split(path.sep).join('/');
    if (!relative.startsWith('test/') || !relative.endsWith('.test.ts') || /[\r\n]/.test(relative)) {
      throw new Error(`Unexpected Vitest test path: ${relative}`);
    }
    return relative;
  });
  if (new Set(files).size !== files.length) throw new Error('Duplicate Vitest test paths');
  return files.sort();
}
