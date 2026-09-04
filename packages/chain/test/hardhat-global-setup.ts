/**
 * Vitest globalSetup — starts a single Hardhat node + deploys contracts
 * before all test files in the package, tears it down afterward.
 *
 * The port is read from HARDHAT_PORT (default 9545).
 * Context (rpcUrl, hubAddress, profile IDs) is written to a JSON file
 * so test workers can read it via evm-test-context.ts helpers.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVM_MODULE_DIR,
  spawnHardhatEnv,
  killHardhat,
  type HardhatContext,
} from './hardhat-harness.js';
import { contextFilePath } from './evm-test-context.js';

let ctx: HardhatContext | null = null;
const localhostContractsPath = join(EVM_MODULE_DIR, 'deployments/localhost_contracts.json');
let originalLocalhostContracts: Buffer | null = null;
let localhostContractsExisted = false;

export async function setup(): Promise<void> {
  // Hardhat Deploy rewrites this tracked convenience manifest with the current
  // branch, commit and timestamps. Preserve the checkout-owned fixture so a
  // test suite remains hermetic and later evidence gates can still distinguish
  // real source changes from deployment side effects.
  localhostContractsExisted = existsSync(localhostContractsPath);
  originalLocalhostContracts = localhostContractsExisted
    ? readFileSync(localhostContractsPath)
    : null;

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
  if (localhostContractsExisted && originalLocalhostContracts !== null) {
    writeFileSync(localhostContractsPath, originalLocalhostContracts);
  } else {
    try { unlinkSync(localhostContractsPath); } catch { /* not created */ }
  }
}
