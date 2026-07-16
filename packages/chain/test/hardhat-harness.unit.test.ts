import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ContractDeployments,
  writeDeploymentConfig,
} from '../../evm-module/utils/deployment-artifacts.js';
import { resolveSuccessfulHubDeployment } from './hardhat-harness.js';

const HUB_ADDRESS = `0x${'1'.repeat(40)}`;
const PARTIAL_OUTPUT = `deploying "Hub" ... deployed at ${HUB_ADDRESS}`;

function writeHubArtifact(deploymentsDir: string, address = HUB_ADDRESS): void {
  const config: ContractDeployments = {
    contracts: {
      Hub: {
        evmAddress: address,
        version: '1.0.0',
        deployed: true,
      },
    },
  };
  writeDeploymentConfig(deploymentsDir, 'localhost', config);
}

describe('resolveSuccessfulHubDeployment', () => {
  it('reads the Hub only from the supplied isolated deployment directory', () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'dkg-hardhat-isolated-'));
    const unrelatedDir = mkdtempSync(join(tmpdir(), 'dkg-hardhat-unrelated-'));
    try {
      writeHubArtifact(isolatedDir);
      writeHubArtifact(unrelatedDir, `0x${'2'.repeat(40)}`);

      expect(resolveSuccessfulHubDeployment(isolatedDir, '', '', 0, null))
        .toBe(HUB_ADDRESS);
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
      rmSync(unrelatedDir, { recursive: true, force: true });
    }
  });

  it('rejects a killed deploy even if it left an artifact and partial stdout', () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'dkg-hardhat-killed-'));
    try {
      writeHubArtifact(isolatedDir);
      expect(() => resolveSuccessfulHubDeployment(
        isolatedDir,
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
      expect(() => resolveSuccessfulHubDeployment(
        isolatedDir,
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
