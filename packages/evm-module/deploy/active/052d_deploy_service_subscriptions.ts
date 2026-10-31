import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

import { publishingConvictionAfterRun, versionAtLeast } from '../../utils/conviction-service-deploy';

/**
 * V10 — deploys the two stateless contracts that fund plan periods of one
 * epoch (OT-RFC-27):
 *   - `ServiceSubscriptions`, Conviction Account service spending: the owner's
 *     opt-in, buyer-key assignments with the consent of both parties over one
 *     EIP-712 digest, the owner's limit updates and revocations, and
 *     `fundFromConviction` and `topUpFromConviction`, which draw from the
 *     account's allowance through `PublishingConviction.coverServiceCost` and
 *     book the cost as due in `QueryInferenceStorage`, as a wallet period's
 *     value is booked. No TRAC moves. `initialize()` wires
 *     `PublishingConvictionStorage`, `ConvictionServiceStorage`, `Chronos`,
 *     `ParametersStorage` and `QueryInferenceStorage`. `PublishingConviction`
 *     and `DKGPublishingConvictionNFT` are resolved from the Hub on every call,
 *     so either can be re-registered without re-initializing it.
 *   - `ServiceSubscriptionsWallet`, periods funded from the buyer key's wallet:
 *     `fundFromWallet` and `topUpFromWallet` move the whole value into the vault,
 *     with no fee, and book it as due in `QueryInferenceStorage`. `initialize()`
 *     wires the Token, `ConvictionStakingStorage` (the vault),
 *     `ConvictionServiceStorage`, `QueryInferenceStorage` and `Chronos`.
 *
 * Both record their periods in `ConvictionServiceStorage` (052c) and read
 * `QueryInferenceStorage` (052e), which is deployed first, so on development,
 * where each contract is initialized as it is deployed, both are registered by
 * then. Fundings from either start at the activation epoch of
 * `QueryInferenceStorage`.
 *
 * Account fundings need `PublishingConviction` 10.2.0 or later, whose
 * `coverServiceCost` books nothing to the staker pool. On a network whose
 * deployments file records an older `PublishingConviction`, set that entry's
 * `deployed` to false before the deploy run: the helper then redeploys it
 * (052b), and the same `Hub.setAndReinitializeContracts` registers and
 * initializes it with this contract and the storage, as the repository
 * upgrades any Hub-registered logic contract.
 *
 * This script refuses a run that would leave `PublishingConviction` 10.1.x:
 * that build has `coverServiceCost` but books every account's whole budget to
 * the staker pool up front, so an account funding through it would be counted
 * in both pools. A build older than 10.1.0 has no `coverServiceCost`, so
 * account fundings revert until 10.2.0 is registered, and the script deploys
 * with a note, so other deploys go on.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.config.environment === 'mainnet') {
    console.log(
      `[ServiceSubscriptions] ${hre.network.name}: Conviction Account service spending is not ` +
        'deployed on mainnet yet, so this step, and ServiceSubscriptionsWallet with it, is skipped.',
    );
    return;
  }
  const after = await publishingConvictionAfterRun(hre);
  if (!versionAtLeast(after.version, [10, 2, 0])) {
    if (versionAtLeast(after.version, [10, 1, 0])) {
      throw new Error(
        `ServiceSubscriptions needs PublishingConviction 10.2.0 or later on ${hre.network.name}, but this run ` +
          `would leave ${after.version} at ${after.address}, which books every account's budget to the staker ` +
          'pool up front, so an account funding would be counted twice. Set ' +
          `contracts.PublishingConviction.deployed to false in deployments/${hre.network.name}_contracts.json, ` +
          'so this run redeploys it, and run the deploy again.',
      );
    }
    console.log(
      `[ServiceSubscriptions] ${hre.network.name} keeps PublishingConviction ${after.version}, which has no ` +
        'coverServiceCost. Account fundings stay off there: they revert until PublishingConviction 10.2.0 is ' +
        'registered.',
    );
  }

  await hre.helpers.deploy({
    newContractName: 'ServiceSubscriptions',
  });
  await hre.helpers.deploy({
    newContractName: 'ServiceSubscriptionsWallet',
  });
};

export default func;
func.tags = ['ServiceSubscriptions', 'ServiceSubscriptionsWallet', 'v10'];
func.dependencies = [
  'Hub',
  'Token',
  'ConvictionStakingStorage',
  'ConvictionServiceStorage',
  'QueryInferenceStorage',
  'PublishingConvictionStorage',
  'PublishingConviction',
  'Chronos',
  'ParametersStorage',
];
