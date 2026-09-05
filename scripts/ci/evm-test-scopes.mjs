import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Package-relative files executed by the dedicated real-Hardhat EVM lane.
export const EVM_TEST_SCOPES = Object.freeze({
  chain: Object.freeze({ packageDirectory: 'packages/chain', files: Object.freeze(['test/evm-adapter.test.ts']) }),
  publisher: Object.freeze({ packageDirectory: 'packages/publisher', files: Object.freeze(['test/publisher-evm-e2e.test.ts']) }),
  agent: Object.freeze({ packageDirectory: 'packages/agent', files: Object.freeze(['test/e2e-chain.test.ts', 'test/e2e-finalization.test.ts']) }),
});

export const EVM_REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function evmFilesForPackage(packageRoot) {
  const relative = path.relative(EVM_REPO_ROOT, path.resolve(packageRoot)).split(path.sep).join('/');
  const scope = Object.values(EVM_TEST_SCOPES).find((entry) => entry.packageDirectory === relative);
  if (!scope) throw new Error(`No dedicated EVM tests for package ${relative}`);
  return [...scope.files];
}
