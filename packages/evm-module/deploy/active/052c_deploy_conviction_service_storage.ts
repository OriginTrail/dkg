import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

/**
 * V10 — deploys `ConvictionServiceStorage` 1.2.0, the state store for service
 * plan periods (OT-RFC-27): the opt-in switch per account, the buyer-key
 * assignments and their usage, and the funded plan periods of one epoch, from
 * an account or a wallet, with their buckets and top-ups. The money a period
 * brings is booked as due in `QueryInferenceStorage` (052e), not here.
 *
 * It is registered in the Hub's contract set, never as an asset storage: its
 * mutators are `onlyContracts`, which reads the contract set. On a live
 * network `998_initialize_contracts.ts` registers it, runs its `initialize()`
 * (which seeds `maxBucketsPerPeriod` where unset) and then forwards the
 * parameters of `deployments/parameters.json`, all in one
 * `Hub.setAndReinitializeContracts`.
 *
 * On a mainnet network the step is skipped, as are 052d and 052e: service
 * spending reaches mainnet only as its own, deliberate release, so an ordinary
 * mainnet deploy never registers these contracts.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.config.environment === 'mainnet') {
    console.log(
      `[ConvictionServiceStorage] ${hre.network.name}: Conviction Account service spending is not ` +
        'deployed on mainnet yet, so this step is skipped.',
    );
    return;
  }

  const ConvictionServiceStorage = await hre.helpers.deploy({
    newContractName: 'ConvictionServiceStorage',
  });
  await hre.helpers.updateContractParameters('ConvictionServiceStorage', ConvictionServiceStorage);
};

export default func;
func.tags = ['ConvictionServiceStorage', 'v10'];
func.dependencies = ['Hub'];
