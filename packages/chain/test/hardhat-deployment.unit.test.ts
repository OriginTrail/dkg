import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const deployment = vi.hoisted(() => ({ code: 0, directory: '', manifest: true }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn((_cmd, _args, options) => {
    deployment.directory = options.env.DKG_TEST_DEPLOYMENTS_DIR;
    if (deployment.manifest) writeFileSync(join(deployment.directory, 'localhost_contracts.json'), JSON.stringify({ contracts: { Hub: { evmAddress: '0x1234' } } }));
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => {
      child.stdout.write('deploying "Hub" ... deployed at 0x1234');
      child.stdout.end(); child.stderr.end(); child.emit('close', deployment.code, null);
    });
    return child;
  }),
}));
import { deployContracts } from './hardhat-harness.js';

it('rejects a partial deployment even after Hub is printed, and cleans its directory', async () => {
  deployment.code = 1;
  await expect(deployContracts('http://127.0.0.1:1')).rejects.toThrow('Deploy closed (code 1');
  expect(existsSync(deployment.directory)).toBe(false);
});
it('accepts Hub only after successful deployment and cleans its directory', async () => {
  deployment.code = 0;
  await expect(deployContracts('http://127.0.0.1:1')).resolves.toBe('0x1234');
  expect(existsSync(deployment.directory)).toBe(false);
});

it('rejects a successful child that did not write through the isolated configuration path', async () => {
  deployment.code = 0; deployment.manifest = false;
  try { await expect(deployContracts('http://127.0.0.1:1')).rejects.toThrow('localhost_contracts.json'); }
  finally { deployment.manifest = true; }
  expect(existsSync(deployment.directory)).toBe(false);
});
