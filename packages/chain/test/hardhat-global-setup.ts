/**
 * Vitest globalSetup — starts a single Hardhat node + deploys contracts
 * before all test files in the package, tears it down afterward.
 *
 * The port is read from HARDHAT_PORT (default 9545).
 * Context (rpcUrl, hubAddress, profile IDs) is written to a JSON file
 * so test workers can read it via evm-test-context.ts helpers.
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { spawnHardhatEnv, killHardhat, type HardhatContext } from './hardhat-harness.js';
import { contextFilePath } from './evm-test-context.js';

let ctx: HardhatContext | null = null;

export async function setup(): Promise<void> {
  const port = parseInt(process.env.HARDHAT_PORT || '9545', 10);
  ctx = await spawnHardhatEnv(port);

  const snapshotId = await ctx.provider.send('evm_snapshot', []);

  writeFileSync(
    contextFilePath(),
    JSON.stringify({
      rpcUrl: ctx.rpcUrl,
      hubAddress: ctx.hubAddress,
      coreProfileId: ctx.coreProfileId,
      receiverIds: ctx.receiverIds,
      baseSnapshotId: snapshotId,
    }),
  );
}

export async function teardown(): Promise<void> {
  killHardhat(ctx);
  try { unlinkSync(contextFilePath()); } catch { /* already cleaned */ }
}
