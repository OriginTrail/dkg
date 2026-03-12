import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ContextGraphStorage',
    setContractInHub: false,
    setAssetStorageInHub: true,
  });
};

export default func;
func.tags = ['ContextGraphStorage', 'v9'];
func.dependencies = ['Hub', 'Token'];
