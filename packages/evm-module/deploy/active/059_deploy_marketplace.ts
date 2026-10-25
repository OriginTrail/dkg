import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'Marketplace',
  });
};

export default func;
func.tags = ['Marketplace'];
// OT-RFC-27 — every Hub binding `Marketplace.initialize()` resolves must be
// Hub-registered first (numeric prefix only orders within a tag set;
// cross-tag ordering is via `dependencies`).
func.dependencies = [
  'Hub',
  'Token',
  'IdentityStorage',
  'ShardingTableStorage',
  'ParametersStorage',
  'ConvictionStakingStorage',
  'Chronos',
  'MarketplaceStorage',
];
