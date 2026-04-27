import 'hardhat-deploy';
import 'hardhat-deploy-ethers';
import '@nomicfoundation/hardhat-chai-matchers';
import { extendEnvironment } from 'hardhat/config';
import { lazyObject } from 'hardhat/plugins';
import { HardhatRuntimeEnvironment, HardhatUserConfig } from 'hardhat/types';

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
      saveDeployments: false,
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
  },
};

export default config;
