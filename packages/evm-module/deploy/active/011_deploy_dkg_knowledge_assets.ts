import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const kaParametersConfig =
    hre.helpers.parametersConfig[hre.network.config.environment]
      .DKGKnowledgeAssets;

  await hre.helpers.deploy({
    newContractName: 'DKGKnowledgeAssets',
    setContractInHub: false,
    setAssetStorageInHub: true,
    additionalArgs: [
      kaParametersConfig.knowledgeAssetBatchSize,
      kaParametersConfig.uriBase,
    ],
  });
};

export default func;
func.tags = ['DKGKnowledgeAssets'];
func.dependencies = ['Hub'];
