/**
 * Vitest globalSetup — starts a single Hardhat node + deploys contracts
 * before all test files in the package, tears it down afterward.
 *
 * The port is read from HARDHAT_PORT (default 9545).
 * Context (rpcUrl, hubAddress, profile IDs) is written to a JSON file
 * so test workers can read it via evm-test-context.ts helpers.
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import {
  spawnHardhatEnv,
  killHardhat,
  type HardhatContext,
} from './hardhat-harness.js';
import { contextFilePath } from './evm-test-context.js';
import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let ctx: HardhatContext | null = null;
  const selectedContextPath = project.config.env.DKG_HARDHAT_CONTEXT_FILE ?? contextFilePath();
  const port = parseInt(project.config.env.HARDHAT_PORT || process.env.HARDHAT_PORT || '9545', 10);
  try {
    ctx = await spawnHardhatEnv(port);

    const snapshotId = await ctx.provider.send('evm_snapshot', []);

    writeFileSync(
      selectedContextPath,
      JSON.stringify({
        rpcUrl: ctx.rpcUrl,
        hubAddress: ctx.hubAddress,
        coreProfileId: ctx.coreProfileId,
        receiverIds: ctx.receiverIds,
        baseSnapshotId: snapshotId,
      }),
    );
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;

  async function teardown(): Promise<void> {
    killHardhat(ctx);
    try { unlinkSync(selectedContextPath); } catch { /* already cleaned */ }
  }
}
