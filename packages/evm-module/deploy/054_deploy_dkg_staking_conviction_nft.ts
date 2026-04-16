import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * DKGStakingConvictionNFT is not yet integrated with the staking protocol
 * (no stakeOnBehalf in Staking.sol). Deployed for testing but excluded from
 * the 'v10' production tag. Re-add 'v10' tag once staking integration is done.
 *
 * V10 Phase 5 — dependencies expanded to match every Hub lookup in
 * `DKGStakingConvictionNFT.initialize()`. Previously the fixture only
 * listed `['Hub', 'Token']`, so any test loading this fixture via
 * `hre.deployments.fixture(['DKGStakingConvictionNFT', 'Token'])` reverted
 * with `ContractDoesNotExist("Staking")` at initialize time. The full list
 * below mirrors `initialize()` 1:1 and also includes `StakingV10` so the
 * NFT contract can resolve it once the NFT-rewrite subagent wires it up.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'DKGStakingConvictionNFT',
  });
};

export default func;
func.tags = ['DKGStakingConvictionNFT'];
func.dependencies = [
  'Hub',
  'Token',
  'Staking',
  'StakingV10',
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
];
