import 'hardhat-deploy';
import 'hardhat-deploy-ethers';
import '@nomicfoundation/hardhat-chai-matchers';
import { extendEnvironment, subtask } from 'hardhat/config';
import { TASK_TEST_GET_TEST_FILES } from 'hardhat/builtin-tasks/task-names';
import { lazyObject } from 'hardhat/plugins';
import { HardhatRuntimeEnvironment, HardhatUserConfig } from 'hardhat/types';
import * as path from 'path';

// Skip pure V8/V9 tests parked under test/archive/ per PRD §4.1.
// Hardhat's default test-file scanner walks `paths.tests` recursively, so
// without an override the archived `.test.ts` files would still be picked up
// and fail at fixture deploy (their V8/V9 contracts are archived in TB-1).
subtask(TASK_TEST_GET_TEST_FILES, async (_, { config }, runSuper) => {
  const files: string[] = await runSuper();
  const archiveRoot = path.join(config.paths.tests, 'archive') + path.sep;
  return files.filter((f) => !f.startsWith(archiveRoot));
});

import { Helpers } from './utils/helpers';
import { rpc, accounts, mainnetAccounts } from './utils/network';

extendEnvironment((hre: HardhatRuntimeEnvironment) => {
  hre.helpers = lazyObject(() => new Helpers(hre));
});

const isCoverage = process.argv.includes('coverage');

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  namedAccounts: {
    deployer: 0,
    minter: 0,
  },
  networks: {
    localhost: {
      environment: 'development',
      url: rpc('localhost'),
      // true so a `hardhat deploy --network localhost` persists addresses for
      // standalone scripts (OT-RFC-50 rehearsal: mirror/migrate resolve via
      // getContract across processes). Harmless for other localhost use.
      saveDeployments: true,
    },
    hardhat: {
      environment: 'development',
      chainId: 31337,
      gas: 15_000_000,
      gasMultiplier: 1,
      blockGasLimit: 30_000_000,
      hardfork: 'shanghai',
      accounts: { count: 200 },
      throwOnTransactionFailures: true,
      throwOnCallFailures: true,
      loggingEnabled: false,
      allowUnlimitedContractSize: isCoverage,
      saveDeployments: false,
      mining: {
        auto: true,
        interval: 0,
      },
    },
    base_sepolia_v10: {
      environment: 'testnet',
      chainId: 84532,
      url: rpc('BASE_SEPOLIA_V10') || 'https://sepolia.base.org',
      accounts: accounts('BASE_SEPOLIA_V10'),
      saveDeployments: false,
    },
    base_mainnet: {
      environment: 'mainnet',
      chainId: 8453,
      url: rpc('BASE_MAINNET') || 'https://mainnet.base.org',
      gasPrice: 1_000_000_000,
      accounts: mainnetAccounts('BASE_MAINNET'),
      saveDeployments: false,
    },
    gnosis_mainnet: {
      environment: 'mainnet',
      chainId: 100,
      url: rpc('GNOSIS_MAINNET') || 'https://rpc.gnosischain.com',
      gasPrice: 3_000_000_000,
      accounts: mainnetAccounts('GNOSIS_MAINNET'),
      saveDeployments: false,
    },
    neuroweb_mainnet: {
      environment: 'mainnet',
      chainId: 2043,
      url: rpc('NEUROWEB_MAINNET') || 'https://astrosat-parachain-rpc.origin-trail.network',
      gasPrice: 1_000_000_000,
      accounts: mainnetAccounts('NEUROWEB_MAINNET'),
      saveDeployments: false,
    },
  },
  solidity: {
    compilers: [
      {
        version: '0.8.20',
        settings: {
          evmVersion: 'london',
          optimizer: {
            enabled: true,
            runs: 200,
            details: {
              peephole: true,
              inliner: true,
              jumpdestRemover: true,
              orderLiterals: true,
              deduplicate: true,
              cse: true,
              constantOptimizer: true,
              yul: true,
              yulDetails: {
                stackAllocation: true,
              },
            },
          },
          viaIR: true,
        },
      },
    ],
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
    // Pin deploy roots to deploy/active/ so hardhat-deploy's recursive
    // scan does NOT discover scripts under deploy/archive/ (V8/V9 legacy
    // stack archived per PRD §4.1). hardhat-deploy 0.12.4 walks the root
    // recursively, so excluding the archive subdir requires an explicit
    // sibling-root layout rather than the default 'deploy' single root.
    deploy: ['deploy/active'],
  },
};

export default config;
