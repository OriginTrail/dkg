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
  'ParametersStorage',
  'IdentityStorage',
  'PaymasterManager',
  'StakingStorage',
  'ParanetKnowledgeCollectionsRegistry',
  'ParanetKnowledgeMinersRegistry',
  'ParanetsRegistry',
  'AskStorage',
  'EpochStorage',
  // V10 Phase 8 dependencies — `KnowledgeAssetsV10.initialize()` reverts
  // ZeroAddressDependency for any of these missing from Hub at init time.
  'ContextGraphStorage',
  'ContextGraphs',
  'ContextGraphValueStorage',
  'DKGPublishingConvictionNFT',
];
