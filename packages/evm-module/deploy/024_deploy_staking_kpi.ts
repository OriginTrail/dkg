import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'StakingKPI',
  });
};

export default func;
func.tags = ['StakingKPI'];
func.dependencies = [
  'Hub',
  'IdentityStorage',
  'ProfileStorage',
  'StakingStorage',
  // D13 — StakingKPI redirects fee-flag + net-node-rewards reads to CSS.
  // DelegatorsInfo kept in deps so fresh bring-ups still run the V6/V8
  // migrators (see 021 header).
  'ConvictionStakingStorage',
  'DelegatorsInfo',
  'RandomSamplingStorage',
  'EpochStorage',
  'ParametersStorage',
];
