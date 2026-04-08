import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'DKGPublishingConvictionNFT',
  });
};

export default func;
func.tags = ['DKGPublishingConvictionNFT', 'v10'];
func.dependencies = ['Hub', 'Token'];
