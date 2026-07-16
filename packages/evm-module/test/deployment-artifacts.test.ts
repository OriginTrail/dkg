import { expect } from 'chai';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  type ContractDeployments,
  deploymentConfigPath,
  readContractDeploymentAddress,
  readDeploymentConfig,
  writeDeploymentConfig,
} from '../utils/deployment-artifacts';

describe('@unit deployment artifact schema', () => {
  it('accepts every tracked network deployment registry', () => {
    const deploymentsDir = join(__dirname, '../deployments');
    const networkNames = readdirSync(deploymentsDir)
      .filter((fileName) => fileName.endsWith('_contracts.json'))
      .map((fileName) => fileName.slice(0, -'_contracts.json'.length));

    expect(networkNames).not.to.be.empty;
    for (const networkName of networkNames) {
      expect(() => readDeploymentConfig(deploymentsDir, networkName)).not.to.throw();
    }
  });

  it('round-trips the canonical typed config and resolves contract addresses', () => {
    const deploymentsDir = mkdtempSync(join(tmpdir(), 'dkg-deployment-artifact-'));
    const config: ContractDeployments = {
      contracts: {
        Hub: {
          evmAddress: '0x1111111111111111111111111111111111111111',
          version: '1.0.0',
          deployed: true,
          gitBranch: 'test',
          gitCommitHash: 'abc123',
          deploymentBlock: 1,
          deploymentTimestamp: 2,
        },
      },
    };

    try {
      writeDeploymentConfig(deploymentsDir, 'localhost', config);
      expect(readDeploymentConfig(deploymentsDir, 'localhost')).to.deep.equal(config);
      expect(readContractDeploymentAddress(deploymentsDir, 'localhost', 'Hub'))
        .to.equal(config.contracts.Hub.evmAddress);
    } finally {
      rmSync(deploymentsDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed deployment artifacts at the shared read boundary', () => {
    const deploymentsDir = mkdtempSync(join(tmpdir(), 'dkg-deployment-artifact-invalid-'));
    try {
      writeFileSync(
        deploymentConfigPath(deploymentsDir, 'localhost'),
        JSON.stringify({ contracts: { Hub: { evmAddress: '' } } }),
      );
      expect(() => readDeploymentConfig(deploymentsDir, 'localhost'))
        .to.throw(/Hub\.evmAddress must be a non-empty string/);
    } finally {
      rmSync(deploymentsDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed optional metadata instead of casting it to the typed schema', () => {
    const deploymentsDir = mkdtempSync(join(tmpdir(), 'dkg-deployment-artifact-metadata-'));
    try {
      writeFileSync(
        deploymentConfigPath(deploymentsDir, 'localhost'),
        JSON.stringify({
          contracts: {
            Hub: {
              evmAddress: '0x1111111111111111111111111111111111111111',
              version: null,
              deployed: true,
              deploymentBlock: '1',
            },
          },
        }),
      );
      expect(() => readDeploymentConfig(deploymentsDir, 'localhost'))
        .to.throw(/Hub\.deploymentBlock must be a finite number/);
    } finally {
      rmSync(deploymentsDir, { recursive: true, force: true });
    }
  });
});
