import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ContractDeployments,
  writeDeploymentConfig,
} from '@origintrail-official/dkg-evm-module/test-support/deployment-artifacts';
import {
  HARDHAT_DEPLOYMENTS_DIR_ENV,
  HARDHAT_LOCAL_NETWORK_NAME,
  type HardhatDeploymentIsolation,
  createHardhatDeploymentIsolation,
  hardhatDeploymentProcessEnv,
  hardhatDeploymentsDirectoryFromEnv,
} from '@origintrail-official/dkg-evm-module/test-support/deployment-isolation';
import { resolveSuccessfulHubDeployment } from './hardhat-harness.js';

const HUB_ADDRESS = `0x${'1'.repeat(40)}`;
const PARTIAL_OUTPUT = `deploying "Hub" ... deployed at ${HUB_ADDRESS}`;

function writeHubArtifact(
  isolation: HardhatDeploymentIsolation,
  address = HUB_ADDRESS,
): void {
  const config: ContractDeployments = {
    contracts: {
      Hub: {
        evmAddress: address,
        version: '1.0.0',
        deployed: true,
      },
    },
  };
  writeDeploymentConfig(isolation.deploymentsDir, isolation.networkName, config);
}

describe('resolveSuccessfulHubDeployment', () => {
  it('keeps the process env, configured network, and artifact target in sync', () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'dkg-hardhat-contract-'));
    try {
      const isolation = createHardhatDeploymentIsolation(isolatedDir);
      const env = hardhatDeploymentProcessEnv(isolation, {});

      expect(isolation.networkName).toBe(HARDHAT_LOCAL_NETWORK_NAME);
      expect(env[HARDHAT_DEPLOYMENTS_DIR_ENV]).toBe(isolatedDir);
      expect(hardhatDeploymentsDirectoryFromEnv(env)).toBe(isolatedDir);
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it('reads the Hub only from the supplied isolated deployment directory', () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'dkg-hardhat-isolated-'));
    const unrelatedDir = mkdtempSync(join(tmpdir(), 'dkg-hardhat-unrelated-'));
    try {
      const isolation = createHardhatDeploymentIsolation(isolatedDir);
      const unrelated = createHardhatDeploymentIsolation(unrelatedDir);
      writeHubArtifact(isolation);
      writeHubArtifact(unrelated, `0x${'2'.repeat(40)}`);

      expect(resolveSuccessfulHubDeployment(isolation, '', '', 0, null))
        .toBe(HUB_ADDRESS);
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
      rmSync(unrelatedDir, { recursive: true, force: true });
    }
  });

  it('rejects a killed deploy even if it left an artifact and partial stdout', () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'dkg-hardhat-killed-'));
    try {
      const isolation = createHardhatDeploymentIsolation(isolatedDir);
      writeHubArtifact(isolation);
      expect(() => resolveSuccessfulHubDeployment(
        isolation,
        PARTIAL_OUTPUT,
        'out of memory',
        null,
        'SIGKILL',
      )).toThrow(/Deploy failed.*SIGKILL/s);
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it('does not accept partial stdout when the isolated artifact is missing', () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'dkg-hardhat-missing-'));
    try {
      const isolation = createHardhatDeploymentIsolation(isolatedDir);
      expect(() => resolveSuccessfulHubDeployment(
        isolation,
        PARTIAL_OUTPUT,
        '',
        0,
        null,
      )).toThrow(/Hub deployment artifact unavailable/);
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
