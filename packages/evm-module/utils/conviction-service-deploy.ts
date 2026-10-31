import { HardhatRuntimeEnvironment } from 'hardhat/types';

// Shared by the deploy steps of Conviction Account service spending
// (OT-RFC-27): 052d (ServiceSubscriptions) reads the PublishingConviction
// build a run leaves.

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
