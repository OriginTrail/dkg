import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `ConvictionWithdrawalStorage`, which keeps what a withdrawn
 * conviction position leaves to claim of the epoch that was in progress at
 * its withdrawal: the staker, the node, the epoch and that epoch's reward
 * carries. `StakingV10.withdraw` has a record written, and the permissionless
 * `StakingV10.claimWithdrawnEpoch` has it deleted and pays it once the epoch
 * has ended (StakingV10 10.1.0).
 *
 * It is registered in the Hub's contract set, and its mutators are
 * `onlyContracts`, so `StakingV10Ledger`, which writes and deletes the records
 * for `StakingV10`, reaches them. It has no `initialize()` and no parameters.
 *
 * `StakingV10Ledger.initialize()` resolves this contract from the Hub, so it
 * is registered first: on development it is deployed here, as a dependency of
 * `054a_deploy_staking_v10_ledger.ts`; on a live network
 * `998_initialize_contracts.ts` registers both in one
 * `Hub.setAndReinitializeContracts` before either is initialized.
 *
 * Included in the `v10` deploy tag so the prod cutover pulls it.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'ConvictionWithdrawalStorage',
  });
};

export default func;
func.tags = ['ConvictionWithdrawalStorage', 'v10'];
func.dependencies = ['Hub'];
