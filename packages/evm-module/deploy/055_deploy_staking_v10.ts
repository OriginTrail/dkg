import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 Phase 5 — deploys `StakingV10`, the V10 NFT-backed staking
 * orchestrator. Hub-registered so `DKGStakingConvictionNFT` can resolve
 * it via `hub.getContractAddress("StakingV10")` in its `initialize()`.
 *
 * `initialize()` reads 12 Hub deps (StakingStorage, ConvictionStakingStorage,
 * DelegatorsInfo, Chronos, RandomSamplingStorage, ShardingTableStorage,
 * ShardingTable, Ask, ParametersStorage, ProfileStorage, Staking, Token),
 * so every one must be deployed & Hub-registered before this script runs.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'StakingV10',
  });
};

export default func;
func.tags = ['StakingV10', 'v10'];
func.dependencies = [
  'Hub',
  'Staking', // for cross-helper `Staking.prepareForStakeChange(...)`
  'StakingStorage',
  'ConvictionStakingStorage',
  'DelegatorsInfo',
  'Chronos',
  'RandomSamplingStorage',
  'ShardingTableStorage',
  'ShardingTable',
  'Ask',
  'ParametersStorage',
  'ProfileStorage',
  'Token',
];
