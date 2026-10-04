import { rollbackMigrationFailure } from '../src/daemon/harden/rollback-failure.js';
import type { RollbackResult } from '../src/daemon/harden/rollback.js';

function executorBoundary(outcome: Awaited<ReturnType<typeof rollbackMigrationFailure>>) {
  const rollback: RollbackResult = outcome.rollback;
  const reportable: Error = outcome.error;
  const recoveryRequired: boolean = !rollback.complete;
  return { recoveryRequired, reportable };
}
void executorBoundary;
