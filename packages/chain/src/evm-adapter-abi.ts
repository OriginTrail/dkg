// SPDX-License-Identifier: Apache-2.0

/**
 * ABI loading extracted from evm-adapter.ts as part of the structural
 * split. Resolves a contract's ABI JSON from the package-local `abi/`
 * directory (falling back to the `archive/` subdir, then to the
 * `@origintrail-official/dkg-evm-module` package). The `createRequire` +
 * `import.meta.url` + `__dirname` setup is replicated exactly so the
 * lookup paths resolve identically to the original module location
 * (this file lives in the same `src/` directory as `evm-adapter.ts`).
 *
 * The vendored `abi/` files are byte-for-byte copies of the evm-module
 * ABIs, refreshed by `scripts/sync-chain-abis.mjs` and checked by
 * `test/vendored-abi-sync.unit.test.ts`. They must stay in this package:
 * evm-module is private, so the `require` fallback only resolves inside
 * the monorepo.
 */
import { ethers } from 'ethers';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * Every vendored ABI: the top-level `abi/` files, then the `archive/` ones,
 * each in file-name order. The custom-error decoder is built from all of
 * them, so vendoring a contract's ABI is enough for its reverts to decode.
 */
export function loadVendoredAbis(): ethers.JsonFragment[][] {
  return [localAbiDir, join(localAbiDir, 'archive')].flatMap((dir) =>
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf-8'))),
  );
}
