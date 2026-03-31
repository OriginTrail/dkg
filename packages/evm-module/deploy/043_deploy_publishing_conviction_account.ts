import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'PublishingConvictionAccount',
  });
};

export default func;
func.tags = ['PublishingConvictionAccount', 'v9'];
func.dependencies = ['Hub', 'Token', 'Chronos'];
