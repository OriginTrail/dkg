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

const DEPLOYMENT_CONFIG_FIELDS = new Set(['contracts']);
const CONTRACT_DEPLOYMENT_FIELDS = new Set([
  'evmAddress',
  'version',
  'deployed',
  'gitBranch',
  'gitCommitHash',
  'deploymentBlock',
  'deploymentTimestamp',
  'migration',
]);

export function deploymentConfigPath(
  deploymentsDirectory: string,
  networkName: string,
): string {
  return path.join(deploymentsDirectory, `${networkName}_contracts.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  field: string,
  source: string,
): void {
  const unknownFields = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknownFields.length > 0) {
    throw new Error(
      `Invalid ${source}: ${field} contains unknown field(s): ${unknownFields.join(', ')}`,
    );
  }
}

function optionalString(
  value: unknown,
  field: string,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${source}: ${field} must be a string`);
  }
  return value;
}

function optionalNumber(
  value: unknown,
  field: string,
  source: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${source}: ${field} must be a finite number`);
  }
  return value;
}

export function parseDeploymentConfig(
  value: unknown,
  source = 'deployment config',
): ContractDeployments {
  if (!isRecord(value) || !isRecord(value.contracts)) {
    throw new Error(`Invalid ${source}: contracts must be an object`);
  }
  // Deployment registries are a closed schema. Rejecting unknown metadata
  // prevents a read/modify/write cycle from silently discarding future fields.
  assertOnlyFields(value, DEPLOYMENT_CONFIG_FIELDS, 'root', source);

  const contracts: Record<string, ContractDeployment> = {};
  for (const [contractName, deployment] of Object.entries(value.contracts)) {
    if (!isRecord(deployment)) {
      throw new Error(`Invalid ${source}: ${contractName} must be an object`);
    }
    assertOnlyFields(deployment, CONTRACT_DEPLOYMENT_FIELDS, contractName, source);
    if (typeof deployment.evmAddress !== 'string' || deployment.evmAddress.length === 0) {
      throw new Error(`Invalid ${source}: ${contractName}.evmAddress must be a non-empty string`);
    }
    if (deployment.version !== null && typeof deployment.version !== 'string') {
      throw new Error(`Invalid ${source}: ${contractName}.version must be a string or null`);
    }
    if (typeof deployment.deployed !== 'boolean') {
      throw new Error(`Invalid ${source}: ${contractName}.deployed must be a boolean`);
    }

    const parsed: ContractDeployment = {
      evmAddress: deployment.evmAddress,
      version: deployment.version,
      deployed: deployment.deployed,
    };
    const gitBranch = optionalString(
      deployment.gitBranch,
      `${contractName}.gitBranch`,
      source,
    );
    const gitCommitHash = optionalString(
      deployment.gitCommitHash,
      `${contractName}.gitCommitHash`,
      source,
    );
    const deploymentBlock = optionalNumber(
      deployment.deploymentBlock,
      `${contractName}.deploymentBlock`,
      source,
    );
    const deploymentTimestamp = optionalNumber(
      deployment.deploymentTimestamp,
      `${contractName}.deploymentTimestamp`,
      source,
    );
    if (deployment.migration !== undefined && typeof deployment.migration !== 'boolean') {
      throw new Error(`Invalid ${source}: ${contractName}.migration must be a boolean`);
    }

    if (gitBranch !== undefined) parsed.gitBranch = gitBranch;
    if (gitCommitHash !== undefined) parsed.gitCommitHash = gitCommitHash;
    if (deploymentBlock !== undefined) parsed.deploymentBlock = deploymentBlock;
    if (deploymentTimestamp !== undefined) parsed.deploymentTimestamp = deploymentTimestamp;
    if (deployment.migration !== undefined) parsed.migration = deployment.migration;
    contracts[contractName] = parsed;
  }

  return { contracts };
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
