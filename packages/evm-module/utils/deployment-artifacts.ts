import * as fs from 'fs';
import * as path from 'path';

export type ContractDeployment = {
  evmAddress: string;
  version: string | null;
  deployed: boolean;
  gitBranch?: string;
  gitCommitHash?: string;
  deploymentBlock?: number;
  deploymentTimestamp?: number;
  migration?: boolean;
};

export type ContractDeployments = {
  contracts: Record<string, ContractDeployment>;
};

export function deploymentConfigPath(
  deploymentsDirectory: string,
  networkName: string,
): string {
  return path.join(deploymentsDirectory, `${networkName}_contracts.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDeploymentConfig(
  value: unknown,
  source = 'deployment config',
): ContractDeployments {
  if (!isRecord(value) || !isRecord(value.contracts)) {
    throw new Error(`Invalid ${source}: contracts must be an object`);
  }

  for (const [contractName, deployment] of Object.entries(value.contracts)) {
    if (!isRecord(deployment)) {
      throw new Error(`Invalid ${source}: ${contractName} must be an object`);
    }
    if (typeof deployment.evmAddress !== 'string' || deployment.evmAddress.length === 0) {
      throw new Error(`Invalid ${source}: ${contractName}.evmAddress must be a non-empty string`);
    }
    if (deployment.version !== null && typeof deployment.version !== 'string') {
      throw new Error(`Invalid ${source}: ${contractName}.version must be a string or null`);
    }
    if (typeof deployment.deployed !== 'boolean') {
      throw new Error(`Invalid ${source}: ${contractName}.deployed must be a boolean`);
    }
  }

  return value as ContractDeployments;
}

export function readDeploymentConfig(
  deploymentsDirectory: string,
  networkName: string,
): ContractDeployments {
  const filePath = deploymentConfigPath(deploymentsDirectory, networkName);
  return parseDeploymentConfig(
    JSON.parse(fs.readFileSync(filePath, 'utf8')),
    filePath,
  );
}

export function writeDeploymentConfig(
  deploymentsDirectory: string,
  networkName: string,
  config: ContractDeployments,
): void {
  const filePath = deploymentConfigPath(deploymentsDirectory, networkName);
  const validated = parseDeploymentConfig(config, filePath);
  fs.mkdirSync(deploymentsDirectory, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(validated, null, 4));
}

export function readContractDeploymentAddress(
  deploymentsDirectory: string,
  networkName: string,
  contractName: string,
): string {
  const filePath = deploymentConfigPath(deploymentsDirectory, networkName);
  const config = readDeploymentConfig(deploymentsDirectory, networkName);
  const address = config.contracts?.[contractName]?.evmAddress;
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error(`${contractName} address is missing from ${filePath}`);
  }
  return address;
}
