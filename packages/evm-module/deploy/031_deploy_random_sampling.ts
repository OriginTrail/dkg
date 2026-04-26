import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'RandomSampling',
  });
};

export default func;
func.tags = ['RandomSampling'];
// IMPORTANT: ContextGraphStorage and ContextGraphValueStorage are listed as
// dependencies because RandomSampling.initialize() reads both via
// `hub.getAssetStorageAddress("ContextGraphStorage")` and
// `hub.getContractAddress("ContextGraphValueStorage")` for Phase 10
// value-weighted challenge generation. Without them, initialize() would
// resolve to address(0) on hardhat (no manual reinit on dev networks), so we
// need the Hub to already have them registered when this script runs. Their
// deploy scripts use higher file numbers (049 / 050) than this one (031);
// hardhat-deploy honours the dependency graph over file ordering when a tag
// list is supplied, so listing them here is sufficient — no file rename.
func.dependencies = [
  'Hub',
  'Chronos',
  'RandomSamplingStorage',
  'StakingStorage',
  'ProfileStorage',
  'EpochStorage',
  'AskStorage',
  'DelegatorsInfo',
  'KnowledgeCollectionStorage',
  'IdentityStorage',
  'ShardingTableStorage',
  'ParametersStorage',
  'ContextGraphStorage',
  'ContextGraphValueStorage',
  'ConvictionStakingStorage',
];
