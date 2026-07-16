import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'Ask',
  });
};

export default func;
func.tags = ['Ask'];
// v4.0.0 — Ask reads V10 canonical stake from CSS in `recalculateActiveSet`.
// CSS must be Hub-registered before `Ask.initialize()` runs (numeric prefix
// only orders within tag set; cross-tag ordering is via `dependencies`).
func.dependencies = [
  'Hub',
  'AskStorage',
  'ShardingTableStorage',
  'ParametersStorage',
  'StakingStorage',
  'ConvictionStakingStorage',
  'ProfileStorage',
];
