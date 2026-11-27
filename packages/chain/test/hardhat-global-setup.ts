/**
 * Vitest globalSetup — starts a single Hardhat node + deploys contracts
 * before all test files in the package, tears it down afterward.
 *
 * The owned child binds port zero; its actual URL is propagated to workers.
 * Context (rpcUrl, hubAddress, profile IDs) is written to a JSON file
 * so test workers can read it via evm-test-context.ts helpers.
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import {
  spawnHardhatEnv,
  killHardhat,
  type HardhatContext,
} from './hardhat-harness.js';
import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let ctx: HardhatContext | null = null;
  const selectedContextPath = project.config.env.DKG_HARDHAT_CONTEXT_FILE;
  if (!selectedContextPath) throw new Error('Hardhat global setup requires an isolated DKG_HARDHAT_CONTEXT_FILE');
  try {
    ctx = await spawnHardhatEnv();

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
    if (ctx) { await killHardhat(ctx); ctx = null; }
    try { unlinkSync(selectedContextPath); } catch { /* already cleaned */ }
  }
}
