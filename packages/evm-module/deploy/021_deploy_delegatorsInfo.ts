import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * D13 (cutover) — `DelegatorsInfo` is scheduled for Hub un-registration in
 * V10. The two per-node-per-epoch flags V10 still needs
 * (`isOperatorFeeClaimedForEpoch`, `netNodeEpochRewards`) were absorbed
 * into `ConvictionStakingStorage` (D3). All other fields were V8 address-
 * keyed scaffolding replaced by the NFT-keyed `claim()` + D6
 * `migrationEpoch` flow.
 *
 * This script STILL deploys + registers `DelegatorsInfo` because test
 * fixtures that replay the full V8→V10 journey need the slot populated
 * to replay V8-era flows faithfully. The one-shot V6/V8 reward-period
 * migrators that used to write to this slot were removed from V10.0
 * scope — they were already executed on V8 testnet and are not needed
 * for a V10 chain bring-up.
 *
 * The live V10 cutover on a running chain removes the `DelegatorsInfo`
 * Hub slot via `Hub.removeContractByAddress` in script 998. No V10
 * runtime contract reads from this slot — see
 * `packages/evm-module/contracts/Profile.sol` and `StakingKPI.sol` which
 * were redirected to `ConvictionStakingStorage` in PR #231.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'DelegatorsInfo',
  });
};

export default func;
func.tags = ['DelegatorsInfo'];
func.dependencies = ['Hub'];
