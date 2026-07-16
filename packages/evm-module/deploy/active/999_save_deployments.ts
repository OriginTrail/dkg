import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.config.environment !== 'development') {
    hre.helpers.saveDeploymentsJson('deployments');
  }
};

export default func;
func.runAtTheEnd = true;
