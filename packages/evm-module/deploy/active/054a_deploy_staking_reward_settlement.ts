import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys the node reward-cache reconciliation helper.  It is kept
 * separate from StakingV10 so both contracts remain below the EVM's deployed
 * bytecode limit while allowing late PCA pool credits to be settled.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'StakingRewardSettlement',
  });
};

export default func;
func.tags = ['StakingRewardSettlement', 'v10'];
func.dependencies = [
  'Hub',
  'ConvictionStakingStorage',
  'EpochStorage',
  'Chronos',
  'ParametersStorage',
  'ProfileStorage',
  'RandomSamplingStorage',
];
