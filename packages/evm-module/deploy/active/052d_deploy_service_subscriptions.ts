import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

import { publishingConvictionAfterRun, versionAtLeast } from '../../utils/conviction-service-deploy';

/**
 * V10 — deploys the two stateless contracts that fund subscriptions of one
 * epoch (OT-RFC-27):
 *   - `ServiceSubscriptions`, Conviction Account service spending: the owner's
 *     opt-in, buyer grants with the consent of both parties over one EIP-712
 *     digest, the owner's limit updates and revocations, and `fundFromAccount`
 *     and `topUpFromAccount`, which spend from the account's allowance through
 *     `PublishingConviction.coverServiceCost` and book the cost in
 *     `QueryInferenceStorage`, as a wallet subscription's value is booked. No
 *     TRAC moves. `initialize()` wires `PublishingConvictionStorage`,
 *     `ServiceSubscriptionsStorage`, `Chronos`, `ParametersStorage` and
 *     `QueryInferenceStorage`. `PublishingConviction` and
 *     `DKGPublishingConvictionNFT` are resolved from the Hub on every call, so
 *     either can be re-registered without re-initializing it.
 *   - `ServiceSubscriptionsWallet`, subscriptions funded from the buyer's
 *     wallet: `fundFromWallet` and `topUpFromWallet` move the whole value into
 *     the vault, with no fee, and book it in `QueryInferenceStorage`.
 *     `initialize()` wires the Token, `ConvictionStakingStorage` (the vault),
 *     `ServiceSubscriptionsStorage`, `QueryInferenceStorage` and `Chronos`.
 *
 * Both record their subscriptions in `ServiceSubscriptionsStorage` (052c) and
 * read `QueryInferenceStorage` (052e), which is deployed first, so on
 * development, where each contract is initialized as it is deployed, both are
 * registered by then. Fundings from either start at the activation epoch of
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
 * `ParametersStorage.protocolTreasury` must stay 0 on a network that runs these
 * contracts: while a treasury is wired, every Conviction Account funding,
 * top-up and opt-in is refused, a service spend carrying no treasury fee.
 * Wallet subscriptions take no fee and go on.
 *
 * A run that would leave `PublishingConviction` 10.1.x is refused by 000: that
 * build has `coverServiceCost` but books every account's whole allowance to the
 * staker pool up front, so an account funding through it would be counted in
 * both pools. A build older than 10.1.0 has no `coverServiceCost`, so account
 * fundings revert until 10.2.0 is registered, and the script deploys with a
 * note, so other deploys go on.
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
  if (!versionAtLeast(after.version, [10, 1, 0])) {
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
  'ServiceSpendingBuilds',
  'Hub',
  'Token',
  'ConvictionStakingStorage',
  'ServiceSubscriptionsStorage',
  'QueryInferenceStorage',
  'PublishingConvictionStorage',
  'PublishingConviction',
  'Chronos',
  'ParametersStorage',
];
