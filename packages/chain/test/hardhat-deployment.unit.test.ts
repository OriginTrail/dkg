import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const deployment = vi.hoisted(() => ({ code: 0, directory: '' }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn((_cmd, _args, options) => {
    deployment.directory = options.env.DKG_TEST_DEPLOYMENTS_DIR;
    writeFileSync(join(deployment.directory, 'partial.json'), '{}');
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
  await expect(deployContracts('http://127.0.0.1:1')).rejects.toThrow('Deploy failed');
  expect(existsSync(deployment.directory)).toBe(false);
});
it('accepts Hub only after successful deployment and cleans its directory', async () => {
  deployment.code = 0;
  await expect(deployContracts('http://127.0.0.1:1')).resolves.toBe('0x1234');
  expect(existsSync(deployment.directory)).toBe(false);
});
