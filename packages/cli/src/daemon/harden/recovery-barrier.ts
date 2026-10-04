// SPDX-License-Identifier: Apache-2.0
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileAtomic } from '../fs-utils.js';
import { assertDaemonStoppedForStoreMigration, storeHardenLockPath } from '../store-maintenance-gate.js';
import { fileSize, verifyReplacement, type HardenWorkflowInputs } from './actions.js';
import type { HardenMigrationResult } from './executor.js';
import type { HardenStep } from './steps.js';
import { BLAZEGRAPH_JOURNAL_FILE, BLAZEGRAPH_DATA_DIR, BLAZEGRAPH_CONTAINER_PORT } from '../blazegraph-docker.js';
import { classifyBlazegraphContainerInspection } from '../blazegraph-container-inspection.js';

/** The sole recovery command is also its dry-run rendering. */
export function hardenRecoveryStep(containerName: string): HardenStep & { dockerArgs: string[] } {
  return { id: 'verify-recovery', description: 'verify restored service, identity and retained journal size before clearing the startup barrier',
    dockerArgs: ['exec', containerName, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE] };
}

/** Keep the original marker in place even when recording recovery evidence fails. */
export async function preserveHardenRecoveryBarrier(ctx: HardenWorkflowInputs, exportBytes: number | undefined) {
  await writeFileAtomic(storeHardenLockPath(ctx.opts.dkgHome), JSON.stringify({
    version: 1, recoveryRequired: true, pid: process.pid, containerName: ctx.containerName,
    namespace: ctx.namespace, migrationDir: resolve(ctx.migrationDir), hostPort: ctx.hostPort, exportBytes,
  }));
  ctx.log('Startup remains blocked. Finish the logged Docker recovery, or repair the replacement, then run '
    + '`dkg store harden --recover` with the same container, namespace, migration directory and port to verify recovery.');
}

async function recoveryEvidence(ctx: HardenWorkflowInputs) {
  const path = storeHardenLockPath(ctx.opts.dkgHome), text = await readFile(path, 'utf8');
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid migration recovery marker; startup remains blocked.'); }
  if (!value || value.version !== 1 || value.recoveryRequired !== true || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
    || value.containerName !== ctx.containerName || value.namespace !== ctx.namespace
    || value.migrationDir !== resolve(ctx.migrationDir) || value.hostPort !== ctx.hostPort
    || !Number.isSafeInteger(value.exportBytes) || Number(value.exportBytes) <= 0) {
    throw new Error('Marker does not certify an incomplete migration for these recovery options; startup remains blocked.');
  }
  return { path, text, exportBytes: Number(value.exportBytes) };
}

/** Explicit recovery never changes Docker state; only verified service can release writers. */
export async function recoverHardenMigration(ctx: HardenWorkflowInputs): Promise<HardenMigrationResult> {
  const evidence = await recoveryEvidence(ctx), lease = `${evidence.path}.recovery`;
  // Keep the startup marker throughout verification and serialize recovery
  // claimants. Normal migration cannot acquire its wx marker in this interval.
  await writeFile(lease, String(process.pid), { flag: 'wx' });
  try {
    if (await readFile(evidence.path, 'utf8') !== evidence.text) throw new Error('Migration marker changed before recovery.');
    await assertDaemonStoppedForStoreMigration(ctx.opts.dkgHome);
    if (ctx.info.state !== 'hardened' && ctx.info.state !== 'legacy') throw new Error('Restore the backup or replacement before verifying recovery.');
    const backup = classifyBlazegraphContainerInspection(await ctx.docker.run(['inspect', ctx.backupName]), ctx.backupName,
      { containerName: ctx.containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT });
    if (backup.kind === 'failed') throw new Error('Cannot verify the migration backup state.');
    const backupExists = backup.kind === 'found';
    if (ctx.info.state === 'legacy' && backupExists) throw new Error('The original-name legacy container is not a completed backup restore.');
    if (await fileSize(ctx.exportPath) !== evidence.exportBytes) throw new Error('Retained migration export is missing or changed; startup remains blocked.');
    await verifyReplacement(ctx, hardenRecoveryStep(ctx.containerName).dockerArgs, { path: ctx.exportPath, bytes: evidence.exportBytes });
    if (await readFile(evidence.path, 'utf8') !== evidence.text) throw new Error('Migration marker changed during recovery.');
    await rm(evidence.path);
    return { outcome: 'recovered', containerName: ctx.containerName, backupContainerName: backupExists ? ctx.backupName : null,
      hostPort: ctx.hostPort, heapMb: ctx.heapMb, exportPath: ctx.exportPath, journalBytes: evidence.exportBytes };
  } finally { await rm(lease, { force: true }); }
}
