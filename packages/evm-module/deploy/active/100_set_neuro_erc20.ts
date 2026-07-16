import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const neuroERC20Exists = hre.helpers.inConfig('NeurowebERC20');
  if (neuroERC20Exists) {
    const hubAddress =
      hre.helpers.contractDeployments.contracts['Hub'].evmAddress;
    const Hub = await hre.ethers.getContractAt('Hub', hubAddress);

    const tokenInHub = await Hub['isContract(string)']('NeurowebERC20');
    if (!tokenInHub) {
      hre.helpers.newContracts.push({
        name: 'NeurowebERC20',
        addr: hre.helpers.contractDeployments.contracts['NeurowebERC20']
          .evmAddress,
      });
    }
  }
};
export default func;
func.tags = ['Neuro'];
func.dependencies = ['Hub'];
