import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `QueryInferenceStorage`, the state store of the
 * query/inference reward pool (OT-RFC-27): the money due per epoch from funded
 * plan periods, the frozen inputs of closed epochs, the QIF inputs, the claims
 * and the replay bitmap, and its parameters (the activation epoch, the receipt
 * grace, the batch and close bounds, the pause and the λ schedule).
 *
 * It is registered in the Hub's contract set: its mutators are `onlyContracts`,
 * which reads the contract set. On a live network `998_initialize_contracts.ts`
 * registers it, runs its `initialize()` (which seeds the grace and the bounds
 * where unset) and then forwards the parameters of `deployments/parameters.json`,
 * all in one `Hub.setAndReinitializeContracts`. A λ set while the activation
 * epoch is unset applies at once.
 *
 * Activation. A period funded from a wallet, and its top-ups, are refused
 * until `activationEpoch` is set and reached. It is set once, through the Hub,
 * to the current epoch or a later one:
 *   - development (the in-process Hardhat network and `localhost`, which the
 *     local devnet deploys to): this step sets it to the deployment epoch, when
 *     it is unset, so periods can be funded right after a deploy;
 *   - any other network: it stays unset here. After the Hub transaction, the
 *     Hub owner sends `Hub.forwardCall(QueryInferenceStorage,
 *     setActivationEpoch(currentEpoch + 1))`, so the first epoch with the new
 *     rules starts after the switch.
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

  const QueryInferenceStorage = await hre.helpers.deploy({
    newContractName: 'QueryInferenceStorage',
  });
  await hre.helpers.updateContractParameters('QueryInferenceStorage', QueryInferenceStorage);

  if (hre.network.config.environment !== 'development') {
    console.log(
      `[QueryInferenceStorage] ${hre.network.name}: activationEpoch stays unset, so no period can be funded ` +
        'from a wallet yet. After the Hub transaction, set it through Hub.forwardCall to ' +
        'setActivationEpoch(currentEpoch + 1).',
    );
    return;
  }

  if (BigInt(await QueryInferenceStorage.activationEpoch()) !== 0n) return;
  const deployments = hre.helpers.contractDeployments.contracts;
  const chronos = await hre.ethers.getContractAt('Chronos', deployments['Chronos'].evmAddress);
  const epoch = BigInt(await chronos.getCurrentEpoch());
  const hub = await hre.ethers.getContractAt('Hub', deployments['Hub'].evmAddress);
  const tx = await hub.forwardCall(
    await QueryInferenceStorage.getAddress(),
    QueryInferenceStorage.interface.encodeFunctionData('setActivationEpoch', [epoch]),
  );
  await tx.wait();
  console.log(`[QueryInferenceStorage] activationEpoch set to the deployment epoch, ${epoch}.`);
};

export default func;
func.tags = ['QueryInferenceStorage', 'v10'];
func.dependencies = ['Hub', 'Chronos'];
