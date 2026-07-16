import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const isDeployed = hre.helpers.isDeployed('IdentityStorage');

  await hre.helpers.deploy({
    newContractName: 'IdentityStorage',
  });

  if (isDeployed) {
    const hubAddress =
      hre.helpers.contractDeployments.contracts['Hub'].evmAddress;
    const Hub = await hre.ethers.getContractAt('Hub', hubAddress);

    const tokenInHub = await Hub['isContract(string)']('IdentityStorage');

    if (!tokenInHub) {
      hre.helpers.newContracts.push({
        name: 'IdentityStorage',
        addr: hre.helpers.contractDeployments.contracts['IdentityStorage']
          .evmAddress,
      });
    }
  }
};

export default func;
func.tags = ['IdentityStorage'];
func.dependencies = ['Hub'];
