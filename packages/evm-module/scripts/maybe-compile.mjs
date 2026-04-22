#!/usr/bin/env node
/**
 * Wrapper around `hardhat compile` that honors the `DKG_SKIP_EVM_BUILD=1`
 * env var. Used by the `build` script in `package.json`.
 *
 * Why this exists:
 *   - The monorepo's shared `pnpm build` runs `hardhat compile` here, which
 *     takes ~1m 54s on CI and is the single biggest chunk of the shared
 *     build.
 *   - Nothing in CI's Node test lanes consumes the output: `packages/chain`
 *     imports ABIs from `@dkg-evm-module/abi/*.json` which are committed to
 *     the repo, and the Solidity unit-test lane (`tornado-solidity`) does
 *     its own hardhat compile in-lane with its own cache.
 *   - We can't just drop evm-module from the turbo task graph via
 *     `--filter=!…` because `@dkg-chain#build` declares evm-module as a
 *     workspace dependency and turbo pulls it in transitively.
 *
 * So ci.yml sets `DKG_SKIP_EVM_BUILD=1` for the shared build step, this
 * wrapper short-circuits, and the turbo task graph stays valid. Release
 * workflows (`release.yml`, `npm-continuous-publish.yml`) and the
 * `evm-integration.yml` workflow all leave the env var unset so hardhat
 * still compiles for real when it matters.
 */
import { spawnSync } from 'node:child_process';

if (process.env.DKG_SKIP_EVM_BUILD === '1') {
  console.log('evm-module build skipped (DKG_SKIP_EVM_BUILD=1)');
  process.exit(0);
}

const result = spawnSync(
  'hardhat',
  ['compile', '--config', 'hardhat.node.config.ts'],
  { stdio: 'inherit', shell: true },
);

process.exit(result.status ?? 1);
