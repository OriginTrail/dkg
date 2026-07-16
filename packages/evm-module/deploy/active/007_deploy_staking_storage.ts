import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const isDeployed = hre.helpers.isDeployed('StakingStorage');

  await hre.helpers.deploy({
    newContractName: 'StakingStorage',
  });

  if (!isDeployed && hre.network.name.startsWith('neuroweb')) {
    const substrateAddress =
      hre.helpers.contractDeployments.contracts['StakingStorage']
        .substrateAddress;
    await hre.helpers.sendNeuro(substrateAddress, 2);
  }
};

export default func;
func.tags = ['StakingStorage'];
func.dependencies = ['Hub', 'Token'];
