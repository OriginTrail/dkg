import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'MigratorV10Staking',
  });
};

export default func;
func.tags = ['MigratorV10Staking', 'v10'];
func.dependencies = ['Hub', 'DelegatorsInfo'];
