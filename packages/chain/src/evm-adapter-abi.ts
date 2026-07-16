// SPDX-License-Identifier: Apache-2.0

/**
 * ABI loading extracted from evm-adapter.ts as part of the structural
 * split. Resolves a contract's ABI JSON from the package-local `abi/`
 * directory (falling back to the `archive/` subdir, then to the
 * `@origintrail-official/dkg-evm-module` package). The `createRequire` +
 * `import.meta.url` + `__dirname` setup is replicated exactly so the
 * lookup paths resolve identically to the original module location
 * (this file lives in the same `src/` directory as `evm-adapter.ts`).
 */
import { ethers } from 'ethers';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const localAbiDir = join(__dirname, '..', 'abi');

export function loadAbi(contractName: string): ethers.InterfaceAbi {
  const localPath = join(localAbiDir, `${contractName}.json`);
  if (existsSync(localPath)) {
    return JSON.parse(readFileSync(localPath, 'utf-8'));
  }
  const archivedPath = join(localAbiDir, 'archive', `${contractName}.json`);
  if (existsSync(archivedPath)) {
    return JSON.parse(readFileSync(archivedPath, 'utf-8'));
  }
  return require(`@origintrail-official/dkg-evm-module/abi/${contractName}.json`);
}
