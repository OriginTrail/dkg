import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

import {
  configuredParameter,
  publishingConvictionAfterRun,
  versionAtLeast,
} from '../../utils/conviction-service-deploy';

/**
 * V10 — deploys `ServiceSubscriptions`, the stateless logic of Conviction
 * Account service spending (OT-RFC-27): the owner's opt-in, buyer-key
 * assignments with the consent of both parties over one EIP-712 digest, the
 * owner's cap updates and revocations, and `fundFromConviction`, which funds
 * one plan period from the account's allowance through
 * `PublishingConviction.coverServiceCost` and labels its cost on the account's
 * own scheduled emission. No TRAC moves.
 *
 * Its state is in `ConvictionServiceStorage` (052c). `initialize()` wires
 * `PublishingConvictionStorage`, `ConvictionServiceStorage`, `Chronos` and
 * `ParametersStorage`. `PublishingConviction` and `DKGPublishingConvictionNFT`
 * are resolved from the Hub on every call, so either can be re-registered
 * without re-initializing this contract.
 *
 * Fundings need `PublishingConviction` 10.1.0 or later, the first build with
 * `coverServiceCost`. On a network whose deployments file records an older
 * `PublishingConviction`, set that entry's `deployed` to false before the
 * deploy run: the helper then redeploys it (052b), and the same
 * `Hub.setAndReinitializeContracts` registers and initializes it with this
 * contract and the storage, as the repository upgrades any Hub-registered
 * logic contract.
 *
 * On a network that configures the schedule cut-over (`exactScheduleFrom`),
 * where service spending is to be switched on, this script refuses an older
 * build (052c refuses it first, before deploying anything). On any other
 * network service spending cannot be switched on, so it deploys with a note.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const after = await publishingConvictionAfterRun(hre);
  if (!versionAtLeast(after.version, [10, 1, 0])) {
    if (configuredParameter(hre, 'ConvictionServiceStorage', 'exactScheduleFrom') !== undefined) {
      throw new Error(
        `ServiceSubscriptions needs PublishingConviction 10.1.0 or later on ${hre.network.name}, which sets ` +
          `the schedule cut-over, but this run would leave ${after.version} at ${after.address}. Set ` +
          `contracts.PublishingConviction.deployed to false in deployments/${hre.network.name}_contracts.json, ` +
          'so this run redeploys it, and run the deploy again.',
      );
    }
    console.log(
      `[ServiceSubscriptions] ${hre.network.name} keeps PublishingConviction ${after.version}, which has no ` +
        'coverServiceCost. Service spending stays off there: no exactScheduleFrom is configured, and a ' +
        'funding would revert until PublishingConviction 10.1.0 is registered.',
    );
  }

  await hre.helpers.deploy({
    newContractName: 'ServiceSubscriptions',
  });
};

export default func;
func.tags = ['ServiceSubscriptions', 'v10'];
func.dependencies = [
  'Hub',
  'ConvictionServiceStorage',
  'PublishingConvictionStorage',
  'PublishingConviction',
  'Chronos',
  'ParametersStorage',
];
