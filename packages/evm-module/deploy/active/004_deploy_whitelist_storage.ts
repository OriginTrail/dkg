import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const WhitelistStorage = await hre.helpers.deploy({
    newContractName: 'WhitelistStorage',
  });

  await hre.helpers.updateContractParameters(
    'WhitelistStorage',
    WhitelistStorage,
  );
};

export default func;
func.tags = ['WhitelistStorage'];
func.dependencies = ['Hub'];
