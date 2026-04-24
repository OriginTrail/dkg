import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `StakingV10`, the V10 NFT-backed staking orchestrator.
 * Hub-registered so `DKGStakingConvictionNFT` can resolve it via
 * `hub.getContractAddress("StakingV10")` in its `initialize()`.
 *
 * D13 + D17 cleanup: `StakingV10.initialize()` no longer reads the V8
 * `Staking` or `DelegatorsInfo` contracts from the Hub — both are
 * unregistered in the V10 cutover (D3 absorbs DelegatorsInfo flags into
 * `ConvictionStakingStorage`; V10 has a native `_prepareForStakeChangeV10`
 * settlement helper so the V8 `Staking.prepareForStakeChange` cross-call
 * is gone). Dependencies trimmed accordingly.
 *
 * Hub registration name: left as `StakingV10` (distinct from the V8
 * `Staking` slot). Rationale: V10 staking is gated by `onlyConvictionNFT`
 * and not callable by generic external integrations, so the canonical
 * staker-facing address is `DKGStakingConvictionNFT`, not `StakingV10`.
 * The V8 `Staking` slot is un-registered (see script 998) rather than
 * aliased so any external integration still pointing at V8 `Staking`
 * fails loudly instead of silently calling a gated V10 function.
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
  'StakingStorage',
  'ConvictionStakingStorage',
  'Chronos',
  'RandomSamplingStorage',
  'ShardingTableStorage',
  'ShardingTable',
  'Ask',
  'ParametersStorage',
  'ProfileStorage',
  'Token',
  'EpochStorage',
];
