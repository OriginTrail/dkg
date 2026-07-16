import * as fs from 'fs';
import * as path from 'path';

export function deploymentConfigPath(
  deploymentsDirectory: string,
  networkName: string,
): string {
  return path.join(deploymentsDirectory, `${networkName}_contracts.json`);
}

export function readContractDeploymentAddress(
  deploymentsDirectory: string,
  networkName: string,
  contractName: string,
): string {
  const filePath = deploymentConfigPath(deploymentsDirectory, networkName);
  const config = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    contracts?: Record<string, { evmAddress?: unknown }>;
  };
  const address = config.contracts?.[contractName]?.evmAddress;
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error(`${contractName} address is missing from ${filePath}`);
  }
  return address;
}
