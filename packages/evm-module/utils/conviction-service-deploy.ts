import { HardhatRuntimeEnvironment } from 'hardhat/types';

// Shared by the deploy steps of Conviction Account service spending (OT-RFC-27):
// 052c (ConvictionServiceStorage) and 052d (ServiceSubscriptions).

type ParameterValue = string | { setterArgs: unknown[] };

/**
 * The value configured for one parameter on the network being deployed to,
 * merged as `Helpers.updateContractParameters` merges it: the environment's
 * parameters, then the network's overrides. Undefined when none is configured.
 */
export function configuredParameter(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  parameter: string,
): bigint | undefined {
  const environment = hre.helpers.parametersConfig[hre.network.config.environment];
  const merged = {
    ...environment?.[contractName],
    ...environment?.overrides?.[hre.network.name]?.[contractName],
  } as Record<string, ParameterValue>;
  const value = merged[parameter];
  if (value === undefined) return undefined;
  return BigInt(typeof value === 'object' ? String(value.setterArgs[0]) : value);
}

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
