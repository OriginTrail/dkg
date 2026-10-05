// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { assertDaemonStoppedForStoreMigration } from '../store-maintenance-gate.js';
import { fileSize, verifyReplacement, type HardenWorkflowInputs } from './actions.js';
import type { HardenMigrationResult } from './executor.js';
import type { HardenStep } from './steps.js';
import { BLAZEGRAPH_JOURNAL_FILE, BLAZEGRAPH_DATA_DIR, BLAZEGRAPH_CONTAINER_PORT } from '../blazegraph-docker.js';
import { classifyBlazegraphContainerInspection } from '../blazegraph-container-inspection.js';
import { retainStoreMigrationRecoveryMarker, requireStoreMigrationRecoveryMarker, withStoreMigrationRecoveryLease, releaseStoreMigrationMarker, storeHardenLockPath, type StoreMigrationMarkerOwnership } from '../store-migration-marker.js';

/** The sole recovery command is also its dry-run rendering. */
export function hardenRecoveryStep(containerName: string): HardenStep & { dockerArgs: string[] } {
  return { id: 'verify-recovery', description: 'verify restored service, identity and retained journal size before clearing the startup barrier',
    dockerArgs: ['exec', containerName, 'stat', '-c', '%s', BLAZEGRAPH_JOURNAL_FILE] };
}

/** Keep the original marker in place even when recording recovery evidence fails. */
export async function preserveHardenRecoveryBarrier(ctx: HardenWorkflowInputs, exportBytes: number | undefined, marker: StoreMigrationMarkerOwnership) {
  await retainStoreMigrationRecoveryMarker(marker, {
    version: 1, recoveryRequired: true, pid: process.pid, containerName: ctx.containerName,
    namespace: ctx.namespace, migrationDir: resolve(ctx.migrationDir), hostPort: ctx.hostPort, exportBytes,
  });
  ctx.log('Startup remains blocked. Finish the logged Docker recovery, or repair the replacement, then run '
    + '`dkg store harden --recover` with the same container, namespace, migration directory and port to verify recovery.');
}

/** Explicit recovery never changes Docker state; only verified service can release writers. */
export async function recoverHardenMigration(ctx: HardenWorkflowInputs): Promise<HardenMigrationResult> {
  const evidence = requireStoreMigrationRecoveryMarker(storeHardenLockPath(ctx.opts.dkgHome), ctx);
  return withStoreMigrationRecoveryLease(evidence, async (): Promise<HardenMigrationResult> => {
    await assertDaemonStoppedForStoreMigration(ctx.opts.dkgHome);
    if (ctx.info.state !== 'hardened' && ctx.info.state !== 'legacy') throw new Error('Restore the backup or replacement before verifying recovery.');
    const backup = classifyBlazegraphContainerInspection(await ctx.docker.run(['inspect', ctx.backupName]), ctx.backupName,
      { containerName: ctx.containerName, dataPath: BLAZEGRAPH_DATA_DIR, containerPort: BLAZEGRAPH_CONTAINER_PORT });
    if (backup.kind === 'failed') throw new Error('Cannot verify the migration backup state.');
    const backupExists = backup.kind === 'found';
    if (ctx.info.state === 'legacy' && backupExists) throw new Error('The original-name legacy container is not a completed backup restore.');
    if (await fileSize(ctx.exportPath) !== evidence.exportBytes) throw new Error('Retained migration export is missing or changed; startup remains blocked.');
    await verifyReplacement(ctx, hardenRecoveryStep(ctx.containerName).dockerArgs, { path: ctx.exportPath, bytes: evidence.exportBytes });
    await releaseStoreMigrationMarker(evidence);
    return { outcome: 'recovered', containerName: ctx.containerName, backupContainerName: backupExists ? ctx.backupName : null,
      hostPort: ctx.hostPort, heapMb: ctx.heapMb, exportPath: ctx.exportPath, journalBytes: evidence.exportBytes };
  });
}
