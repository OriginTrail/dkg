import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

import { reusedDeployment, versionAtLeast } from '../../utils/conviction-service-deploy';

/**
 * V10 — deploys `QueryInferenceStorage`, the state store of the query/inference
 * reward pool (OT-RFC-27): the money per epoch from funded subscriptions, the
 * QIF inputs, what each budget has used and the replay bitmap, and its
 * parameters (the activation epoch, the batch bounds, the pause and λ).
 *
 * It is registered in the Hub's contract set: its mutators are `onlyContracts`,
 * which reads the contract set. On a live network `998_initialize_contracts.ts`
 * registers it, runs its `initialize()` (which seeds the bounds where unset)
 * and then forwards the parameters of `deployments/parameters.json`, all in one
 * `Hub.setAndReinitializeContracts`.
 *
 * StakingV10 pays the pool, so a run that would keep a StakingV10 below 10.1.0
 * is refused by 000: the deployments file marks it deployed, and the run reuses
 * it, but that build splits every node's epoch without the pool, so from
 * activation on each epoch's share of the pool would stay in the vault for good.
 * Set that entry's `deployed` to false, so the run redeploys it (055), and run
 * the deploy again. A StakingKPI below 10.1.0 only reports rewards without the
 * pool, and moves no TRAC, so the run goes on with a loud warning.
 *
 * Activation. A subscription funded from a wallet, and its top-ups, are refused
 * until `activationEpoch` is set and reached, and `setActivationEpoch` itself
 * is refused until the Hub's `QueryInferenceSettlement` and `StakingV10` read
 * this storage. So the activation comes once every contract is registered and
 * initialized, in `998b_activate_query_inference.ts`.
 *
 * Replacing it. Once the pool is active, a new `QueryInferenceStorage` starts
 * empty: node-epochs not yet claimed lose their share of the old pool, and
 * money not yet in a pool is stranded. So a redeploy of this storage
 * needs a migration, which no step here runs; the contract's NatSpec says
 * what one must do. Redeploy the settlement instead to change the logic.
 *
 * On a mainnet network the step is skipped, as are 052c and 052d.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.config.environment === 'mainnet') {
    console.log(
      `[QueryInferenceStorage] ${hre.network.name}: the query/inference pool is not deployed on mainnet yet, ` +
        'so this step is skipped.',
    );
    return;
  }

  const kpi = await reusedDeployment(hre, 'StakingKPI');
  if (kpi && !versionAtLeast(kpi.version, [10, 1, 0])) {
    console.log(
      `[QueryInferenceStorage] WARNING: ${hre.network.name} keeps StakingKPI ${kpi.version} at ${kpi.address}, ` +
        'whose reward views leave the query/inference pool out, so they read low once the pool is active. No TRAC ' +
        `is at risk. Set contracts.StakingKPI.deployed to false in deployments/${hre.network.name}_contracts.json ` +
        'to redeploy it.',
    );
  }

  const QueryInferenceStorage = await hre.helpers.deploy({
    newContractName: 'QueryInferenceStorage',
  });
  await hre.helpers.updateContractParameters('QueryInferenceStorage', QueryInferenceStorage);
};

export default func;
func.tags = ['QueryInferenceStorage', 'v10'];
func.dependencies = ['ServiceSpendingBuilds', 'Hub', 'Chronos'];
