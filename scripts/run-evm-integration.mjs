import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVM_TEST_SCOPES, EVM_REPO_ROOT } from './ci/evm-test-scopes.mjs';
import { EVM_SCOPES } from './lib/ci-delta.mjs';

export function runEvmIntegration(scope = 'all', { run = spawnSync } = {}) {
  if (scope !== 'all' && !EVM_SCOPES.includes(scope)) throw new Error(`Unknown EVM scope: ${scope}`);
  let exitCode = 0;
  for (const selected of scope === 'all' ? EVM_SCOPES : [scope]) {
    const { packageDirectory, files } = EVM_TEST_SCOPES[selected];
    for (const file of files) {
      console.log(`Running EVM integration: ${selected} / ${file}`);
      // Preserve one isolated Hardhat lifecycle at a time and collect failures
      // across all selected files instead of dropping later tests on failure.
      const result = run('pnpm', ['exec', 'vitest', 'run', file,
        '--config', path.join(EVM_REPO_ROOT, 'vitest.evm-integration.ts'), '--reporter=verbose'], {
        cwd: path.join(EVM_REPO_ROOT, packageDirectory), stdio: 'inherit',
      });
      if (result.error || result.status !== 0) {
        console.error(`FAIL: ${packageDirectory}/${file}: ${result.error?.message ?? result.status}`);
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = runEvmIntegration(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
