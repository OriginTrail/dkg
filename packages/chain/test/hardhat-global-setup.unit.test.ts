import { readFileSync, existsSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { TestProject } from 'vitest/node';
import { hardhatTestEnvironment } from '../../../scripts/lib/hardhat-test-env.mjs';

vi.mock('./hardhat-harness.js', () => ({ spawnHardhatEnv: vi.fn(), killHardhat: vi.fn() }));
import { spawnHardhatEnv, killHardhat } from './hardhat-harness.js';
import setup from './hardhat-global-setup.js';

const teardowns: Array<() => Promise<void>> = [];
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown(); vi.clearAllMocks(); });

it('concurrent project setups write distinct contexts and teardown only their own chain and file', async () => {
  const a = hardhatTestEnvironment(9548), b = hardhatTestEnvironment(9548);
  const contexts = [1, 2].map((id) => ({ rpcUrl: `http://127.0.0.1:${10000 + id}`, hubAddress: `hub-${id}`, coreProfileId: id, receiverIds: [id], provider: { send: vi.fn().mockResolvedValue(`snapshot-${id}`) } }));
  vi.mocked(spawnHardhatEnv).mockResolvedValueOnce(contexts[0] as any).mockResolvedValueOnce(contexts[1] as any);
  const [stopA, stopB] = await Promise.all([a, b].map((env) => setup({ config: { env } } as TestProject)));
  teardowns.push(stopA, stopB);
  expect(a.DKG_HARDHAT_CONTEXT_FILE).not.toBe(b.DKG_HARDHAT_CONTEXT_FILE);
  for (const [index, env] of [a, b].entries()) {
    expect(JSON.parse(readFileSync(env.DKG_HARDHAT_CONTEXT_FILE, 'utf8'))).toMatchObject({ rpcUrl: contexts[index].rpcUrl, baseSnapshotId: `snapshot-${index + 1}` });
  }
  await stopA();
  expect(killHardhat).toHaveBeenCalledWith(contexts[0]);
  expect(killHardhat).not.toHaveBeenCalledWith(contexts[1]);
  expect(existsSync(a.DKG_HARDHAT_CONTEXT_FILE)).toBe(false);
  expect(JSON.parse(readFileSync(b.DKG_HARDHAT_CONTEXT_FILE, 'utf8')).rpcUrl).toBe(contexts[1].rpcUrl);
});

it('rejects a legacy caller before starting a chain', async () => {
  await expect(setup({ config: { env: { HARDHAT_PORT: '9548' } } } as TestProject)).rejects.toThrow('DKG_HARDHAT_CONTEXT_FILE');
  expect(spawnHardhatEnv).not.toHaveBeenCalled();
});
