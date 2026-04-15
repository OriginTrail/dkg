import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ParanetV9Registry',
  });
};

export default func;
func.tags = ['ParanetV9Registry', 'v9'];
func.dependencies = ['Hub'];
