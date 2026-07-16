import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const kcParametersConfig =
    hre.helpers.parametersConfig[hre.network.config.environment]
      .KnowledgeCollectionStorage;

  await hre.helpers.deploy({
    newContractName: 'KnowledgeCollectionStorage',
    setContractInHub: false,
    setAssetStorageInHub: true,
    additionalArgs: [
      kcParametersConfig.knowledgeCollectionSize,
      kcParametersConfig.uriBase,
    ],
  });
};

export default func;
func.tags = ['KnowledgeCollectionStorage'];
func.dependencies = ['Hub'];
