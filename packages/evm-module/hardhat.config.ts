import 'hardhat-abi-exporter';
import 'hardhat-deploy';
import 'hardhat-deploy-ethers';
import 'hardhat-gas-reporter';
import 'hardhat-contract-sizer';
import 'solidity-coverage';
import '@typechain/hardhat';
import '@typechain/ethers-v6';
import '@nomicfoundation/hardhat-chai-matchers';
import { extendEnvironment } from 'hardhat/config';
import { lazyObject } from 'hardhat/plugins';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import './utils/type-extensions';
import config from './hardhat.node.config';
import { Helpers } from './utils/helpers';

// Note: V8 tasks (address_converter, send_neuro, etc.) are not imported.
// They relied on Polkadot/Neuroweb dependencies removed for V9.

extendEnvironment((hre: HardhatRuntimeEnvironment) => {
  hre.helpers = lazyObject(() => new Helpers(hre));
});

config.typechain = {
  outDir: 'typechain',
  target: 'ethers-v6',
};

config.mocha = {
  reporterOptions: {
    excludeContracts: [],
  },
  timeout: 100000000,
};

config.abiExporter = {
  path: './abi',
  runOnCompile: true,
  clear: true,
  flat: true,
  only: [],
  except: [
    'draft-IERC6093.sol',
    'AccessControl.sol',
    'EnumerableSetLib.sol',
    'ERC20.sol',
    'ERC20Burnable.sol',
    'ERC165.sol',
    'ERC721.sol',
    'ERC1155Delta.sol',
    'IERC20Metadata.sol',
    'IERC721.sol',
    'IERC721Metadata.sol',
    'IERC721Receiver.sol',
    'IERC734Extended.sol',
    'IERC1155.sol',
    'IERC1155MetadataURI.sol',
    'IERC1155Receiver.sol',
    'IERC1155Delta.sol',
    'IERC1155DeltaQueryable.sol',
    'IERC4906.sol',
    'Ownable.sol',
    'IdentityLib.sol',
    'Permissions.sol',
    'ProfileLib.sol',
    'ShardingTableLib.sol',
    'TokenLib.sol',
    'KnowledgeCollectionLib.sol',
    'KnowledgeAssetsLib.sol',
    'StakingLib.sol',
    'IOldHub',
    'IOldNodeOperatorFeesStorage',
    'IOldProfileStorage',
    'IOldStakingStorage',
    'IOldServiceAgreementStorage',
    'ECDSA',
  ],
  spacing: 2,
  format: 'json',
};

config.gasReporter = {
  enabled: process.env.GAS_REPORT ? true : false,
};

config.contractSizer = {
  alphaSort: true,
  runOnCompile: false,
  disambiguatePaths: false,
  strict: false,
  only: [],
  except: [],
};

export default config;
