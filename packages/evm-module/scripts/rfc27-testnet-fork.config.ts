// =============================================================================
// rfc27-testnet-fork.config.ts — the repository's own deploy pipeline, pointed
// at a LOCAL anvil fork of Base Sepolia (OT-RFC-27 testnet deploy rehearsal)
// =============================================================================
//
// The network keeps the name `base_sepolia_v10` and the `testnet` environment,
// so `hardhat deploy` reads `deployments/base_sepolia_v10_contracts.json` and
// `deployments/parameters.json` "testnet" exactly as the real deploy does. Only
// two things differ from `hardhat.node.config.ts`:
//   - the URL is hard-coded to the local anvil on 127.0.0.1 (the port may be
//     chosen with ANVIL_PORT, the host never), with no fallback to any other
//     endpoint;
//   - the accounts are `remote`: anvil's own unlocked development accounts and
//     whatever the rehearsal impersonates. No key is read from the environment
//     or held in this process.
// Every other network is dropped, and `deploy` and `run` refuse to start unless
// the node answers as anvil on that URL with chain id 84532.
//
//   anvil --fork-url <base-sepolia-rpc> --fork-block-number <N> --port 8545 &
//   npx hardhat deploy --network base_sepolia_v10 --config scripts/rfc27-testnet-fork.config.ts
//   npx hardhat run scripts/rfc27-testnet-fork-rehearsal.ts --network base_sepolia_v10 \
//     --config scripts/rfc27-testnet-fork.config.ts
//
// See scripts/rfc27-testnet-fork-rehearsal.ts for the whole sequence.

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

task('deploy').setAction(async (args, hre, runSuper) => {
  await assertLocalAnvilFork(hre);
  return runSuper(args);
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
  paths: { ...baseConfig.paths, root: path.resolve(__dirname, '..') },
};

export default config;
