import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.config.environment !== 'development') {
    await hre.helpers.deploy({
      newContractName: 'EpochStorage',
      newContractNameInHub: 'EpochStorageV6',
    });
  }

  await hre.helpers.deploy({
    newContractName: 'EpochStorage',
    newContractNameInHub: 'EpochStorageV8',
  });
};

export default func;
func.tags = ['EpochStorage'];
func.dependencies = ['Hub', 'Chronos'];
