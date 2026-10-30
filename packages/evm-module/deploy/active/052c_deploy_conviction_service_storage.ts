import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

import {
  configuredParameter,
  publishingConvictionAfterRun,
  versionAtLeast,
} from '../../utils/conviction-service-deploy';

/**
 * V10 — deploys `ConvictionServiceStorage` 1.1.0, the state store for service
 * plan periods (OT-RFC-27): the opt-in switch per account, the buyer-key
 * assignments and their usage, the service labels per account and epoch, and
 * the funded plan periods of one epoch, from an account or a wallet, with their
 * buckets and top-ups.
 *
 * It is registered in the Hub's contract set, never as an asset storage: its
 * mutators are `onlyContracts`, which reads the contract set. On a live
 * network `998_initialize_contracts.ts` registers it, runs its `initialize()`
 * (which seeds `maxBucketsPerPeriod` where unset) and then forwards the
 * parameters of `deployments/parameters.json`, all in one
 * `Hub.setAndReinitializeContracts`.
 *
 * `exactScheduleFrom`, the schedule cut-over, goes in the per-network
 * `overrides` of the environment. It is one second after the block time of the
 * Hub transaction that switched `PublishingConviction` from a build older than
 * 10.0.8 to 10.0.8 or later, with no later switch back to an older build. One
 * second after, because an account created earlier in that block was created
 * by the older build. Accounts created at or after it have a schedule that is
 * exactly reproducible from their stored terms. The setter takes it once and
 * never a future time. Until it is set, `ServiceSubscriptions` refuses to
 * switch service spending on, so a network without the override deploys both
 * contracts with service spending off. A network that moves straight from an
 * older build to 10.1.0 switches in this deployment's own Hub transaction, so
 * the value is set after it, through `Hub.forwardCall`.
 *
 * base_sepolia_v10: 1783530141. The Hub 0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6
 * emitted `ContractChanged` and `NewContract` for `PublishingConviction` ->
 * 0x99341dEb6cdfACA94F359591ED3fD20da1901DAf (10.0.8) in block 43880926,
 * transaction 0x6f99c482b1367f0bf9ccc5ac792b5caab1f00a576b8f20ac0ae73f0ffef3de28
 * (`Hub.setAndReinitializeContracts`), whose block time is 1783530140
 * (2026-07-08T17:02:20Z). It replaced 10.0.7, and the name's earlier builds
 * were 1.0.0, 10.0.2, 10.0.4 and 10.0.5. The Hub emitted no registration
 * event after that block, up to block 48586906 at least.
 *
 * Before anything is deployed, on a network that configures the cut-over and
 * whose storage does not hold it yet, this script checks:
 *   - `ParametersStorage.protocolTreasury()` is the zero address. An account
 *     scheduled while a treasury is wired emits net of a fee that no storage
 *     records, so the label basis would not hold; such a network needs a
 *     `ServiceSubscriptions` that snapshots that fee before service spending
 *     is switched on there;
 *   - the Hub names a `PublishingConviction` of 10.0.8 or later, so the switch
 *     the value marks has happened;
 *   - this run leaves the Hub naming `PublishingConviction` 10.1.0 or later,
 *     the first build with `coverServiceCost` (see 052d);
 *   - the value is not in the future, and the storage does not already hold a
 *     different one.
 * So a refused run deploys nothing that a later run would take as deployed
 * although the Hub never registered it.
 *
 * On a mainnet network the step is skipped, as are 052d and 052e: service
 * spending reaches mainnet only as its own, deliberate release, so an ordinary
 * mainnet deploy never registers these contracts.
 */

async function checkCutOver(hre: HardhatRuntimeEnvironment, configured: bigint, onChain: bigint): Promise<void> {
  const where = `ConvictionServiceStorage.exactScheduleFrom on ${hre.network.name}`;
  if (onChain !== 0n) {
    if (onChain !== configured) {
      throw new Error(
        `${where} is already ${onChain}; it is set once, so the configured ${configured} cannot be applied.`,
      );
    }
    return;
  }

  const deployments = hre.helpers.contractDeployments.contracts;
  const parametersStorage = await hre.ethers.getContractAt(
    'ParametersStorage',
    deployments['ParametersStorage'].evmAddress,
  );
  const treasury: string = await parametersStorage.protocolTreasury();
  if (treasury !== hre.ethers.ZeroAddress) {
    throw new Error(
      `${where}: ParametersStorage.protocolTreasury() is ${treasury}. Service spending must stay off ` +
        'while a protocol treasury is wired: deploy a ServiceSubscriptions that snapshots the treasury ' +
        'fee before setting the cut-over.',
    );
  }

  const hub = await hre.ethers.getContractAt('Hub', deployments['Hub'].evmAddress);
  const registered: string = await hub.getContractAddress('PublishingConviction');
  const current: string = await (await hre.ethers.getContractAt('PublishingConviction', registered)).version();
  if (!versionAtLeast(current, [10, 0, 8])) {
    throw new Error(
      `${where}: the Hub names PublishingConviction ${current} at ${registered}, older than 10.0.8, ` +
        'so the cut-over has not happened yet. Leave the override out, and set the value through ' +
        'Hub.forwardCall once the Hub names 10.0.8 or later.',
    );
  }

  const after = await publishingConvictionAfterRun(hre);
  if (!versionAtLeast(after.version, [10, 1, 0])) {
    throw new Error(
      `${where}: this run would leave PublishingConviction ${after.version} at ${after.address}, older than ` +
        '10.1.0, the first build with coverServiceCost. Set contracts.PublishingConviction.deployed to false in ' +
        `deployments/${hre.network.name}_contracts.json, so this run redeploys it, and run the deploy again.`,
    );
  }

  const latest = await hre.ethers.provider.getBlock('latest');
  if (!latest || configured > BigInt(latest.timestamp)) {
    throw new Error(
      `${where}: ${configured} is after the latest block time ${latest?.timestamp}; the setter refuses a future time.`,
    );
  }

  console.log(
    `[ConvictionServiceStorage] exactScheduleFrom ${configured} will be set; no protocol treasury is wired, ` +
      `the Hub names PublishingConviction ${current}, and this run leaves ${after.version}.`,
  );
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.config.environment === 'mainnet') {
    console.log(
      `[ConvictionServiceStorage] ${hre.network.name}: Conviction Account service spending is not ` +
        'deployed on mainnet yet, so this step is skipped.',
    );
    return;
  }
  const exactScheduleFrom = configuredParameter(hre, 'ConvictionServiceStorage', 'exactScheduleFrom');
  if (exactScheduleFrom !== undefined) {
    // What the storage holds: nothing yet when this run deploys it.
    let onChain = 0n;
    if (hre.helpers.isDeployed('ConvictionServiceStorage')) {
      const recorded = await hre.ethers.getContractAt(
        'ConvictionServiceStorage',
        hre.helpers.contractDeployments.contracts['ConvictionServiceStorage'].evmAddress,
      );
      onChain = BigInt(await recorded.exactScheduleFrom());
    }
    await checkCutOver(hre, exactScheduleFrom, onChain);
  } else if (hre.network.config.environment !== 'development') {
    console.log(
      `[ConvictionServiceStorage] no exactScheduleFrom is configured for ${hre.network.name}: ` +
        'service spending stays off there until it is set.',
    );
  }

  const ConvictionServiceStorage = await hre.helpers.deploy({
    newContractName: 'ConvictionServiceStorage',
  });
  await hre.helpers.updateContractParameters('ConvictionServiceStorage', ConvictionServiceStorage);
};

export default func;
func.tags = ['ConvictionServiceStorage', 'v10'];
// PublishingConviction first, so the checks see the build this run leaves.
func.dependencies = ['Hub', 'PublishingConviction'];
