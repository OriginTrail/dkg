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
  // V6/V8 DelegatorsInfo migrators retired in TB-1 (archive).
  'ConvictionStakingStorage',
  'RandomSamplingStorage',
  'EpochStorage',
  'ParametersStorage',
  // Bound in initialize() for timestamp-aware operator-fee lookup in
  // getNetNodeRewards (must mirror StakingV10._claim).
  'Chronos',
  // 10.1.0 — initialize() wires the query/inference pool's settlement
  // (OT-RFC-27) where the Hub holds it, so getNetNodeRewards adds a node's
  // gross from that pool as StakingV10 does; the settlement deploys first.
  // On mainnet its step is skipped, and this contract wires 0.
  'QueryInferenceSettlement',
];
