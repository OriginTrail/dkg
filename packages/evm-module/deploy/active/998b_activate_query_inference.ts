import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — activates the query/inference pool (OT-RFC-27): sets the activation
 * epoch of `QueryInferenceStorage`, the first epoch whose rewards include the
 * pool and the first in which subscriptions can be funded from a wallet. It is
 * set once, through the Hub, to the current epoch or a later one, and
 * `setActivationEpoch` refuses until the Hub's `QueryInferenceSettlement` and
 * `StakingV10` read the storage, so this runs at the end, once every contract
 * is registered and initialized:
 *   - development (the in-process Hardhat network and `localhost`, which the
 *     local devnet deploys to): it sets it to the current epoch, the deployment
 *     epoch, when it is unset, so subscriptions can be funded right after a
 *     deploy;
 *   - any other network: it stays unset here. After the Hub transaction of
 *     998, the Hub owner sends `Hub.forwardCall(QueryInferenceStorage,
 *     setActivationEpoch(currentEpoch + 1))`, so the first epoch with the new
 *     rules starts after the switch.
 *
 * Nothing happens where the run has no `QueryInferenceStorage`: on mainnet,
 * where 052e is skipped, or in a deploy without the pool.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const deployments = hre.helpers.contractDeployments.contracts;
  const storage = deployments['QueryInferenceStorage'];
  if (hre.network.config.environment === 'mainnet' || !storage) return;

  if (hre.network.config.environment !== 'development') {
    console.log(
      `[QueryInferenceStorage] ${hre.network.name}: activationEpoch stays unset, so no subscription can be funded ` +
        'from a wallet yet. After the Hub transaction, set it through Hub.forwardCall to ' +
        'setActivationEpoch(currentEpoch + 1).',
    );
    return;
  }

  const QueryInferenceStorage = await hre.ethers.getContractAt('QueryInferenceStorage', storage.evmAddress);
  if (BigInt(await QueryInferenceStorage.activationEpoch()) !== 0n) return;
  const chronos = await hre.ethers.getContractAt('Chronos', deployments['Chronos'].evmAddress);
  const epoch = BigInt(await chronos.getCurrentEpoch());
  const hub = await hre.ethers.getContractAt('Hub', deployments['Hub'].evmAddress);
  const tx = await hub.forwardCall(
    storage.evmAddress,
    QueryInferenceStorage.interface.encodeFunctionData('setActivationEpoch', [epoch]),
  );
  await tx.wait();
  console.log(`[QueryInferenceStorage] activationEpoch set to the deployment epoch, ${epoch}.`);
};

export default func;
func.tags = ['QueryInferenceActivation', 'v10'];
func.dependencies = ['ServiceSpendingBuilds', 'Hub', 'Chronos', 'QueryInferenceStorage', 'QueryInferenceSettlement', 'StakingV10'];
func.runAtTheEnd = true;
