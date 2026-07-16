import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ProfileStorage',
  });
};

export default func;
func.tags = ['ProfileStorage'];
func.dependencies = ['Hub', 'Token'];
