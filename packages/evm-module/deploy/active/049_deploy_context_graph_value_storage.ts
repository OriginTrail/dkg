import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ContextGraphValueStorage',
  });
};

export default func;
func.tags = ['ContextGraphValueStorage', 'v10'];
func.dependencies = ['Hub', 'Chronos'];
