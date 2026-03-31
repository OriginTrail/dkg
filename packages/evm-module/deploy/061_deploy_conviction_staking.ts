import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ConvictionStaking',
  });
};

export default func;
func.tags = ['ConvictionStaking'];
func.dependencies = [
  'Hub',
  'Token',
  'StakingStorage',
  'ConvictionStakeStorage',
  'ParametersStorage',
  'ProfileStorage',
  'IdentityStorage',
  'ShardingTable',
  'ShardingTableStorage',
  'Ask',
  'Chronos',
];
