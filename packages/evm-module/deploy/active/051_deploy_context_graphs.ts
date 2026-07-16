import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ContextGraphs',
  });
};

export default func;
func.tags = ['ContextGraphs', 'v10'];
func.dependencies = ['Hub', 'ContextGraphStorage'];
