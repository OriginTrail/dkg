import { rollbackToBackup, type RollbackResult } from './rollback.js';
import type { HardenWorkflowContext } from './actions.js';

/** Only phases after the authoritative source rename enter automatic rollback. */
export async function rollbackMigrationFailure(ctx: HardenWorkflowContext,
  phase: 'post-swap setup' | 'verification', err: unknown): Promise<never> {
  const { log, docker, containerName, backupName, exportPath } = ctx;
  log(
    `${phase === 'verification' ? 'Verification' : 'Post-swap setup'} FAILED ` +
    `(${(err as Error).message}) — rolling back to ${backupName}.`,
  );
  let rollback: RollbackResult;
  try {
    rollback = await rollbackToBackup({ docker, containerName, backupName, log });
  } catch (rollbackErr) {
    // Spawn-level docker failure mid-rollback: report INCOMPLETE, never
    // pretend the legacy container came back.
    rollback = {
      complete: false,
      failedStep: 'docker-invocation',
      detail: (rollbackErr as Error).message ?? String(rollbackErr),
    };
    log(`ROLLBACK INCOMPLETE: docker invocation failed (${rollback.detail}).`);
  }
  if (rollback.complete) {
    throw new Error(
      `Harden ${phase} failed and the legacy container was restored. ` +
      `Cause: ${(err as Error).message}. The journal export is retained at ${exportPath}.`,
    );
  }
  throw new Error(
    `Harden ${phase} failed and the automatic rollback is INCOMPLETE ` +
    `(stopped at step "${rollback.failedStep}": ${rollback.detail ?? 'see log'}). ` +
    `The legacy container was NOT restored to service. Your data is still safe in ` +
    `container "${backupName}" and in the export at ${exportPath} — see the log above ` +
    `for the exact docker commands to finish the restore by hand. ` +
    `Cause of the failed ${phase}: ${(err as Error).message}.`,
  );
}
