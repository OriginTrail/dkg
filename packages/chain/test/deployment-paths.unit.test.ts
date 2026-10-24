import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Helpers } from '../../evm-module/utils/helpers.js';

it.each(['deployments', 'isolated-run/deployments'])('reads and writes the configured %s directory', (directory) => {
  const root = mkdtempSync(join(tmpdir(), 'dkg-deployment-paths-'));
  const deployments = join(root, directory);
  mkdirSync(deployments, { recursive: true });
  const manifest = join(deployments, 'localhost_contracts.json');
  writeFileSync(manifest, JSON.stringify({ contracts: { Hub: { evmAddress: 'before' } } }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const hre = { config: { paths: { deployments } }, network: { name: 'localhost' } };
    const helper = new Helpers(hre as any);
    expect(helper.contractDeployments.contracts.Hub.evmAddress).toBe('before');
    helper.contractDeployments.contracts.Hub.evmAddress = 'after';
    helper.saveDeploymentsJson();
    expect(JSON.parse(readFileSync(manifest, 'utf8')).contracts.Hub.evmAddress).toBe('after');
    expect(new Helpers(hre as any).contractDeployments.contracts.Hub.evmAddress).toBe('after');
  } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
