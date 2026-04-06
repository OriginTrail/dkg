import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'KnowledgeAssetsV10',
  });
};

export default func;
func.tags = ['KnowledgeAssetsV10', 'v10'];
func.dependencies = [
  'Hub',
  'KnowledgeCollectionStorage',
  'Chronos',
  'ShardingTableStorage',
  'ParametersStorage',
  'IdentityStorage',
  'PaymasterManager',
  'PublishingConvictionAccount',
  'ParanetKnowledgeCollectionsRegistry',
  'ParanetKnowledgeMinersRegistry',
  'ParanetsRegistry',
  'AskStorage',
  'EpochStorage',
];
