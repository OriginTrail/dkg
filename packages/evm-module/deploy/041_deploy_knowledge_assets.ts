import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'KnowledgeAssets',
  });
};

export default func;
func.tags = ['KnowledgeAssets', 'v9'];
func.dependencies = [
  'Hub',
  'KnowledgeAssetsStorage',
  'Chronos',
  'ShardingTableStorage',
  'ParametersStorage',
  'IdentityStorage',
  'PaymasterManager',
  'ContextGraphs',
];
