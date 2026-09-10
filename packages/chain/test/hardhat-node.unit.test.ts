import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { TestProject } from 'vitest/node';
import { hardhatTestEnvironment } from '../../../scripts/lib/hardhat-test-env.mjs';
import setup from './hardhat-global-setup.js';
import { EVM_MODULE_DIR, waitForNode } from './hardhat-harness.js';

it('real concurrent setups use distinct RPCs, isolated deployment manifests and owned teardown', async () => {
  const contender = createServer();
  await new Promise<void>((resolve) => contender.listen(0, '127.0.0.1', resolve));
  const manifest = join(EVM_MODULE_DIR, 'deployments/localhost_contracts.json');
  const before = existsSync(manifest) ? readFileSync(manifest) : undefined;
  const environments = [hardhatTestEnvironment(), hardhatTestEnvironment()];
  const stops: Array<() => Promise<void>> = [];
  try {
    // Runs real deployContracts, hardhat.node.config and Helpers in both children.
    // deployContracts rejects a missing/mismatched manifest in its unique dir.
    const results = await Promise.allSettled(environments.map(async (env) => {
      const stop = await setup({ config: { env } } as TestProject);
      stops.push(stop);
      return { stop, context: JSON.parse(readFileSync(env.DKG_HARDHAT_CONTEXT_FILE, 'utf8')), env };
    }));
    const [a, b] = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(a.context.rpcUrl).not.toBe(b.context.rpcUrl);
    expect(new URL(a.context.rpcUrl).port).not.toBe(String((contender.address() as { port: number }).port));
    expect(new URL(b.context.rpcUrl).port).not.toBe('0');
    expect(a.context.hubAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(b.context.hubAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(existsSync(manifest) ? readFileSync(manifest) : undefined).toEqual(before);
    await a.stop();
    expect(await waitForNode(a.context.rpcUrl, 500)).toBe(false);
    expect(existsSync(a.env.DKG_HARDHAT_CONTEXT_FILE)).toBe(false);
    expect(existsSync(b.env.DKG_HARDHAT_CONTEXT_FILE)).toBe(true);
    expect(await waitForNode(b.context.rpcUrl, 1000)).toBe(true);
    expect(contender.listening).toBe(true);
  } finally {
    for (const stop of stops) await stop();
    await new Promise<void>((resolve) => contender.close(() => resolve()));
  }
}, 120_000);
