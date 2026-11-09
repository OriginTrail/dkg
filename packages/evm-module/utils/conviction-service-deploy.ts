import { HardhatRuntimeEnvironment } from 'hardhat/types';

// Shared by the deploy steps of Conviction Account service spending
// (OT-RFC-27): 000 refuses a run that would keep a PublishingConviction or a
// StakingV10 these contracts cannot run on, 052d (ServiceSubscriptions) reads the
// PublishingConviction build a run leaves, and 052e (QueryInferenceStorage) the
// StakingKPI build a run keeps.

/** Whether a `major.minor.patch` version is at least `minimum`. */
export function versionAtLeast(version: string, minimum: [number, number, number]): boolean {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const v = parts[i] === undefined || Number.isNaN(parts[i]) ? 0 : parts[i];
    if (v !== minimum[i]) return v > minimum[i];
  }
  return true;
}

/**
 * The address and on-chain version of `name` when this run reuses the
 * deployment the deployments file records (`deployed: true`), and undefined
 * when this run deploys it from this repository, at its current version: the
 * decision `hre.helpers.deploy` takes, known before `name`'s own step runs.
 */
export async function reusedDeployment(
  hre: HardhatRuntimeEnvironment,
  name: string,
): Promise<{ address: string; version: string } | undefined> {
  if (!hre.helpers.isDeployed(name)) return undefined;
  const address = hre.helpers.contractDeployments.contracts[name].evmAddress;
  const contract = await hre.ethers.getContractAt(name, address);
  return { address, version: await contract.version() };
}

/**
 * The `PublishingConviction` the Hub names once this run's contracts are
 * registered: after 052b, the deployments file holds the one redeployed in
 * this run, or the one already registered.
 */
export async function publishingConvictionAfterRun(
  hre: HardhatRuntimeEnvironment,
): Promise<{ address: string; version: string }> {
  const address = hre.helpers.contractDeployments.contracts['PublishingConviction'].evmAddress;
  const publishingConviction = await hre.ethers.getContractAt('PublishingConviction', address);
  return { address, version: await publishingConviction.version() };
}

/**
 * Refuse a run that would keep a build service spending and the
 * query/inference pool cannot run on. It only reads. In a run of every step or
 * by any single tag it runs ahead of every deployment (000), so a refused run
 * has deployed nothing, and the corrected retry of every step registers all it
 * deploys.
 *   - `PublishingConviction` 10.1.x has `coverServiceCost` but books every
 *     account's whole allowance to the staker pool up front, so an account funding
 *     through it would be counted in both pools. A build older than 10.1.0 has
 *     no `coverServiceCost`, so account fundings revert until 10.2.0 is
 *     registered, and the run goes on (052d notes it).
 *   - `StakingV10` below 10.1.0 splits every node's epoch without the pool, so
 *     from activation on each epoch's share of the pool would stay in the vault
 *     for good.
 * Set the entry's `deployed` to false, so the run redeploys it, and run the
 * deploy again. It reads nothing on a mainnet network, where 052c to 052f deploy
 * nothing, or on a development network, where a run reuses nothing: step 001
 * clears the record, which until then holds whatever file an earlier run left,
 * at addresses where a new chain has no code.
 */
export async function requireServiceSpendingBuilds(hre: HardhatRuntimeEnvironment): Promise<void> {
  const { environment } = hre.network.config;
  if (environment === 'mainnet' || environment === 'development') return;

  const publishing = await reusedDeployment(hre, 'PublishingConviction');
  if (publishing && versionAtLeast(publishing.version, [10, 1, 0]) && !versionAtLeast(publishing.version, [10, 2, 0])) {
    throw new Error(
      `ServiceSubscriptions needs PublishingConviction 10.2.0 or later on ${hre.network.name}, but this run ` +
        `would leave ${publishing.version} at ${publishing.address}, which books every account's allowance to the staker ` +
        'pool up front, so an account funding would be counted twice. Set ' +
        `contracts.PublishingConviction.deployed to false in deployments/${hre.network.name}_contracts.json, ` +
        'so this run redeploys it, and run the deploy again.',
    );
  }

  const staking = await reusedDeployment(hre, 'StakingV10');
  if (staking && !versionAtLeast(staking.version, [10, 1, 0])) {
    throw new Error(
      `QueryInferenceStorage needs StakingV10 10.1.0 or later on ${hre.network.name}, but this run would keep ` +
        `${staking.version} at ${staking.address}, which splits every epoch without the query/inference pool, so ` +
        "each epoch's share of the pool stays in the vault for good. Set contracts.StakingV10.deployed to false in " +
        `deployments/${hre.network.name}_contracts.json, so this run redeploys it, and run the deploy again.`,
    );
  }
}
