import { readContractDeploymentAddress } from './deployment-artifacts';

export const HARDHAT_DEPLOYMENTS_DIR_ENV = 'DKG_HARDHAT_DEPLOYMENTS_DIR';
export const HARDHAT_LOCAL_NETWORK_NAME = 'localhost';

export type HardhatDeploymentIsolation = {
  deploymentsDir: string;
  networkName: typeof HARDHAT_LOCAL_NETWORK_NAME;
};

export function createHardhatDeploymentIsolation(
  deploymentsDir: string,
): HardhatDeploymentIsolation {
  return {
    deploymentsDir,
    networkName: HARDHAT_LOCAL_NETWORK_NAME,
  };
}

export function hardhatDeploymentsDirectoryFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const deploymentsDir = env[HARDHAT_DEPLOYMENTS_DIR_ENV]?.trim();
  return deploymentsDir || undefined;
}

export function hardhatDeploymentProcessEnv(
  isolation: HardhatDeploymentIsolation,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [HARDHAT_DEPLOYMENTS_DIR_ENV]: isolation.deploymentsDir,
  };
}

export function readIsolatedContractDeploymentAddress(
  isolation: HardhatDeploymentIsolation,
  contractName: string,
): string {
  return readContractDeploymentAddress(
    isolation.deploymentsDir,
    isolation.networkName,
    contractName,
  );
}
