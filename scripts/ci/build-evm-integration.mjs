import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EVM_SCOPES } from '../lib/ci-delta.mjs';

export function integrationBuildArgs(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0
      || scopes.some((scope) => !EVM_SCOPES.includes(scope))
      || new Set(scopes).size !== scopes.length) {
    throw new Error(`Expected a non-empty selection of unique EVM scopes: ${EVM_SCOPES.join(', ')}`);
  }
  return ['exec', 'turbo', 'build', ...EVM_SCOPES.filter((scope) => scopes.includes(scope))
    .map((scope) => `--filter=@origintrail-official/dkg-${scope}...`)];
}

export function buildEvmIntegration(scopes, { spawnProcess = spawnSync } = {}) {
  const commands = [
    integrationBuildArgs(scopes),
    ['--filter', '@origintrail-official/dkg-evm-module', 'exec',
      'hardhat', 'compile', '--config', 'hardhat.node.config.ts'],
  ];
  for (const args of commands) {
    // Turbo's generic build output is dist/**, which does not capture EVM
    // artifacts. Always ask Hardhat to validate/compile after the Node build,
    // even if Turbo restores every package task from its cache.
    const result = spawnProcess('pnpm', args, {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      env: { ...process.env, DKG_SKIP_EVM_BUILD: '1' },
      stdio: 'inherit',
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = buildEvmIntegration(JSON.parse(process.env.EVM_SCOPES_JSON ?? 'null'));
}
