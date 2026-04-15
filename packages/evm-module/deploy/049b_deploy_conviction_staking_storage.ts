import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ConvictionStakingStorage',
  });
};

export default func;
func.tags = ['ConvictionStakingStorage', 'v10'];
func.dependencies = ['Hub', 'Chronos'];
