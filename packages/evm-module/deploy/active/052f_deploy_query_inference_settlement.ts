import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `QueryInferenceSettlement`, the stateless settlement of the
 * query/inference pool (OT-RFC-27): receipt batches from Core Node sellers,
 * checked against the buyers' signed requests, which count as they land, up to
 * what the funded budgets have left.
 *
 * It is registered in the Hub's contract set, so the `onlyContracts` mutators
 * of `QueryInferenceStorage` admit it. `initialize()` wires
 * `QueryInferenceStorage`, `ServiceSubscriptionsStorage`, `Chronos`,
 * `IdentityStorage`, `ProfileStorage`, `ShardingTableStorage`,
 * `RandomSamplingStorage`, `ConvictionStakingStorage` and `ParametersStorage`,
 * all deployed before it. On development each contract is initialized as it is
 * deployed; on a live network `998_initialize_contracts.ts` registers and
 * initializes it in the same `Hub.setAndReinitializeContracts` as the rest.
 *
 * Requests are signed under an EIP-712 domain whose verifying contract is
 * `QueryInferenceStorage`, so redeploying this contract keeps every signature
 * and the replay bitmap. It has no parameters of its own: the batch bounds and
 * λ live in `QueryInferenceStorage`.
 *
 * Replacing it. A fixed settlement is registered under the same name and
 * initialized; `StakingV10` and `StakingKPI` read it from the Hub at their
 * next call, and it reads the same `QueryInferenceStorage`, so nothing is
 * stranded. Prefer this to the emergency switch.
 *
 * The emergency switch. Removing this contract from the Hub turns the pool
 * off for `StakingV10`'s claims, and strands money; the procedure and what it
 * strands are in the NatSpec of `StakingV10.queryInferenceSettlement()`. In
 * short:
 *   - pause `QueryInferenceStorage` too (`setPaused(true)`), or wallet and
 *     Conviction Account funding go on;
 *   - stop your own keepers and auto-claims first: any claim while it is out,
 *     `claimFor` and `claimWithdrawnEpoch` included, splits its node-epochs
 *     without the pool for good;
 *   - keep the outage short: batches revert, and sellers lose the R of work
 *     whose epoch ends meanwhile;
 *   - remove it with `Hub.removeContractByName` only, never
 *     `removeContractByAddress`, which on the Hub's last entry makes every
 *     claim and withdrawal revert until a contract under another name is
 *     added;
 *   - switch back on with a fresh deployment of this contract and its
 *     `initialize()`, not the removed address, which can revert
 *     `AddressAlreadyInSet`.
 *
 * On a mainnet network the step is skipped, as are 052c, 052d and 052e.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.config.environment === 'mainnet') {
    console.log(
      `[QueryInferenceSettlement] ${hre.network.name}: the query/inference pool is not deployed on mainnet yet, ` +
        'so this step is skipped.',
    );
    return;
  }

  await hre.helpers.deploy({
    newContractName: 'QueryInferenceSettlement',
  });
};

export default func;
func.tags = ['QueryInferenceSettlement', 'v10'];
func.dependencies = [
  'ServiceSpendingBuilds',
  'Hub',
  'QueryInferenceStorage',
  'ServiceSubscriptionsStorage',
  'Chronos',
  'IdentityStorage',
  'ProfileStorage',
  'ShardingTableStorage',
  'RandomSamplingStorage',
  'ConvictionStakingStorage',
  'ParametersStorage',
];
