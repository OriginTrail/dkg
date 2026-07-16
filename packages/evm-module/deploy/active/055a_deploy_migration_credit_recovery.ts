import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `MigrationCreditRecovery`, the standalone node-independent
 * recovery path for V8→V10 migration credit.
 *
 * It only depends on the Hub and `ConvictionStakingStorage` (the credit ledger
 * + TRAC vault). Being Hub-registered is what lets it pass CSS's
 * `onlyContracts` gate, so it can call `spendMigrationCredit` + `transferStake`
 * on the EXISTING deployed CSS — no CSS or NFT-wrapper redeploy required. This
 * is the same contract on every chain (Base, Gnosis, NeuroWeb); on chains that
 * are already live it is an additive deploy + one Hub registration.
 *
 * Included in the `v10` deploy tag so the prod cutover pulls it.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  await hre.helpers.deploy({
    newContractName: 'MigrationCreditRecovery',
  });
};

export default func;
func.tags = ['MigrationCreditRecovery', 'v10'];
func.dependencies = ['Hub', 'ConvictionStakingStorage'];
