import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `DKGStakingConvictionNFT`, the user-facing ERC-721 wrapper
 * over `StakingV10` positions.
 *
 * D13 cleanup: dependencies trimmed. The NFT wrapper's `initialize()` no
 * longer reads the V8 `Staking` / `DelegatorsInfo` contracts (D17 + D3);
 * those lookups were dropped when the wrapper stopped doing any cross-V8
 * bookkeeping. `Staking` is kept in the dependency list only because
 * external integrations resolve the `IStaking` interface through the Hub
 * slot during tests — the NFT wrapper itself does not call into V8 Staking.
 *
 * Included in the `v10` deploy tag so the prod cutover pulls it.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'DKGStakingConvictionNFT',
  });
};

export default func;
func.tags = ['DKGStakingConvictionNFT', 'v10'];
func.dependencies = [
  'Hub',
  'Token',
  'Staking',
  'StakingV10',
  'StakingStorage',
  'ConvictionStakingStorage',
  'Chronos',
  'RandomSamplingStorage',
  'ShardingTableStorage',
  'ShardingTable',
  'Ask',
  'ParametersStorage',
  'ProfileStorage',
];
