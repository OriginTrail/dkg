import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const hub = (await hre.deployments.get('Hub')).address;
  await hre.helpers.deploy({
    newContractName: 'ParanetV9Registry',
    passHubInConstructor: false,
    setContractInHub: true,
    additionalArgs: [hub],
  });
};

export default func;
func.tags = ['ParanetV9Registry', 'v9'];
func.dependencies = ['Hub'];
