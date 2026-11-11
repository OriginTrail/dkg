// =============================================================================
// rfc27-testnet-fork.config.ts — the repository's own deploy pipeline, pointed
// at a LOCAL anvil fork of Base Sepolia (OT-RFC-27 testnet deploy rehearsal)
// =============================================================================
//
// The network keeps the name `base_sepolia_v10` and the `testnet` environment,
// so `hardhat deploy` reads the contracts of `deployments/base_sepolia_v10_contracts.json`
// and `deployments/parameters.json` "testnet" exactly as the real deploy does.
// Three things differ from `hardhat.node.config.ts`:
//   - the URL is hard-coded to the local anvil on 127.0.0.1 (the port may be
//     chosen with ANVIL_PORT, the host never), with no fallback to any other
//     endpoint;
//   - the accounts are `remote`: anvil's own unlocked development accounts and
//     whatever the rehearsal impersonates. No key is read from the environment
//     or held in this process;
//   - the deployments file is a scratch copy. The deploy helper reads and
//     rewrites `<paths.deployments>/<network>_contracts.json` on every run
//     (utils/helpers.ts, and step 999), the setting `DKG_TEST_DEPLOYMENTS_DIR`
//     feeds in the base config. Here `paths.deployments` is
//     cache/rfc27-fork/deployments/ (under REHEARSAL_DIR), which git ignores.
//     Every `deploy` first copies the tracked file there, marks the entries
//     REDEPLOY names not deployed, and checks after the run that the tracked
//     file is byte for byte as it was, so nothing tracked is ever written.
//     hardhat-deploy writes nothing there either: `saveDeployments` is false.
//     The helper still reads `deployments/parameters.json` from the tracked
//     directory, relative to the working directory, so run from
//     packages/evm-module.
// Every other network is dropped, and `deploy` and `run` refuse to start unless
// the node answers as anvil on that URL with chain id 84532.
//
//   anvil --fork-url <base-sepolia-rpc> --fork-block-number <N> --host 127.0.0.1 --port 8545 &
//   REDEPLOY=PublishingConviction,StakingV10,StakingKPI \
//     npx hardhat deploy --network base_sepolia_v10 --config scripts/rfc27-testnet-fork.config.ts
//   PHASE=hub npx hardhat run scripts/rfc27-testnet-fork-rehearsal.ts --network base_sepolia_v10 \
//     --config scripts/rfc27-testnet-fork.config.ts
//
// See scripts/rfc27-testnet-fork-rehearsal.ts for the whole sequence.

import * as fs from 'fs';
import * as path from 'path';

import { task } from 'hardhat/config';
import { TASK_RUN } from 'hardhat/builtin-tasks/task-names';
import { HardhatRuntimeEnvironment, HardhatUserConfig } from 'hardhat/types';

import baseConfig from '../hardhat.node.config';

const port = Number(process.env.ANVIL_PORT ?? '8545');
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`ANVIL_PORT must be a TCP port, got ${process.env.ANVIL_PORT}`);
}
export const FORK_URL = `http://127.0.0.1:${port}`;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

const ROOT = path.resolve(__dirname, '..');
/** The tracked deployments directory: read here, never written. */
export const TRACKED_DEPLOYMENTS = path.join(ROOT, 'deployments');
/** The scratch deployments directory the deploy reads and writes. */
export const SCRATCH_DEPLOYMENTS = path.resolve(ROOT, process.env.REHEARSAL_DIR ?? 'cache/rfc27-fork', 'deployments');
{
  const inside = path.relative(TRACKED_DEPLOYMENTS, SCRATCH_DEPLOYMENTS);
  if (!inside || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
    throw new Error(`REHEARSAL_DIR puts the scratch deployments at ${SCRATCH_DEPLOYMENTS}, inside the tracked ${TRACKED_DEPLOYMENTS}`);
  }
}

/** Refuse to run against anything but the local anvil fork of Base Sepolia. */
export async function assertLocalAnvilFork(hre: HardhatRuntimeEnvironment): Promise<void> {
  const url = (hre.network.config as { url?: string }).url;
  if (url !== FORK_URL) {
    throw new Error(`refusing to run: network ${hre.network.name} is ${url}, not the local fork ${FORK_URL}`);
  }
  const client = String(await hre.network.provider.send('web3_clientVersion', []));
  if (!client.startsWith('anvil/')) {
    throw new Error(`refusing to run: ${FORK_URL} answers as ${client}, not anvil`);
  }
  const chainId = BigInt(String(await hre.network.provider.send('eth_chainId', [])));
  if (chainId !== BigInt(BASE_SEPOLIA_CHAIN_ID)) {
    throw new Error(`refusing to run: chain id ${chainId} is not Base Sepolia's ${BASE_SEPOLIA_CHAIN_ID}`);
  }
}

/**
 * Seed the scratch deployments file from the tracked one, with the entries
 * REDEPLOY names (comma-separated) marked not deployed, so this run redeploys
 * them, as the deploy's first step, 000, asks of the real deploy. Returns the tracked
 * file's path and bytes.
 */
function seedScratchDeployments(network: string): { tracked: string; bytes: Buffer } {
  const file = `${network}_contracts.json`;
  const tracked = path.join(TRACKED_DEPLOYMENTS, file);
  const bytes = fs.readFileSync(tracked);
  const deployments = JSON.parse(bytes.toString());
  const redeploy = (process.env.REDEPLOY ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  for (const n of redeploy) {
    if (!deployments.contracts[n]) throw new Error(`REDEPLOY names ${n}, which ${tracked} does not hold`);
    deployments.contracts[n].deployed = false;
  }
  fs.mkdirSync(SCRATCH_DEPLOYMENTS, { recursive: true });
  const scratch = path.join(SCRATCH_DEPLOYMENTS, file);
  fs.writeFileSync(scratch, JSON.stringify(deployments, null, 4));
  console.log(
    `deployments: ${path.relative(ROOT, scratch)}, seeded from ${path.relative(ROOT, tracked)}` +
      `${redeploy.length ? `, with ${redeploy.join(', ')} marked not deployed` : ''}`,
  );
  return { tracked, bytes };
}

task('deploy').setAction(async (args, hre, runSuper) => {
  await assertLocalAnvilFork(hre);
  const { tracked, bytes } = seedScratchDeployments(hre.network.name);
  // Checked after the run whether it succeeds or fails; a changed tracked file is the error reported.
  const untouched = () => {
    if (!fs.readFileSync(tracked).equals(bytes)) {
      throw new Error(`${tracked} changed during the run, which must never write it`);
    }
  };
  let result: unknown;
  try {
    result = await runSuper(args);
  } catch (e: unknown) {
    untouched();
    throw e;
  }
  untouched();
  return result;
});

task(TASK_RUN).setAction(async (args, hre, runSuper) => {
  await assertLocalAnvilFork(hre);
  return runSuper(args);
});

const fork = {
  environment: 'testnet',
  chainId: BASE_SEPOLIA_CHAIN_ID,
  url: FORK_URL,
  accounts: 'remote' as const,
  saveDeployments: false,
  timeout: 600_000,
};

const config: HardhatUserConfig = {
  ...baseConfig,
  defaultNetwork: 'base_sepolia_v10',
  networks: {
    hardhat: baseConfig.networks!.hardhat,
    base_sepolia_v10: fork,
  },
  paths: { ...baseConfig.paths, root: ROOT, deployments: SCRATCH_DEPLOYMENTS },
};

export default config;
