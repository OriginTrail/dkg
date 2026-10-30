import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `QueryInferenceSettlement`, the stateless settlement of the
 * query/inference pool (OT-RFC-27): receipt batches from Core Node sellers,
 * checked against the buyers' signed requests, which become claims on the
 * funded buckets.
 *
 * It is registered in the Hub's contract set, so the `onlyContracts` mutators
 * of `QueryInferenceStorage` admit it. `initialize()` wires
 * `QueryInferenceStorage`, `ConvictionServiceStorage`, `Chronos`,
 * `IdentityStorage`, `ProfileStorage`, `ShardingTableStorage`,
 * `RandomSamplingStorage`, `ConvictionStakingStorage` and `ParametersStorage`,
 * all deployed before it. On development each contract is initialized as it is
 * deployed; on a live network `998_initialize_contracts.ts` registers and
 * initializes it in the same `Hub.setAndReinitializeContracts` as the rest.
 *
 * Requests are signed under an EIP-712 domain whose verifying contract is
 * `QueryInferenceStorage`, so redeploying this contract keeps every signature
 * and the replay bitmap. It has no parameters of its own: the batch bounds and
 * the receipt grace live in `QueryInferenceStorage`.
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
  'Hub',
  'QueryInferenceStorage',
  'ConvictionServiceStorage',
  'Chronos',
  'IdentityStorage',
  'ProfileStorage',
  'ShardingTableStorage',
  'RandomSamplingStorage',
  'ConvictionStakingStorage',
  'ParametersStorage',
];
