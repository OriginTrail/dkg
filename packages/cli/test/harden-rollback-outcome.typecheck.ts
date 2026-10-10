import { rollbackMigrationFailure } from '../src/daemon/harden/rollback-failure.js';
import type { RollbackResult } from '../src/daemon/harden/rollback.js';

function executorBoundary(outcome: Awaited<ReturnType<typeof rollbackMigrationFailure>>) {
  const rollback: RollbackResult = outcome.rollback;
  const reportable: Error = outcome.error;
  const recoveryRequired: boolean = !rollback.complete;
  return { recoveryRequired, reportable };
}
void executorBoundary;

const complete: RollbackResult = { complete: true };
const incomplete: RollbackResult = { complete: false, failedStep: 'rename-backup', detail: 'rename failed' };
// @ts-expect-error incomplete rollback requires both failure evidence fields
const missingEvidence: RollbackResult = { complete: false };
// @ts-expect-error incomplete rollback requires a reportable detail
const missingDetail: RollbackResult = { complete: false, failedStep: 'rename-backup' };
// @ts-expect-error incomplete rollback requires the failed command
const missingStep: RollbackResult = { complete: false, detail: 'rename failed' };
// @ts-expect-error successful rollback excludes failed-step evidence
const successWithFailure: RollbackResult = { complete: true, failedStep: 'rename-backup' };
// @ts-expect-error successful rollback excludes failure details
const successWithDetail: RollbackResult = { complete: true, detail: 'rename failed' };
const contradictoryVariable = { complete: true as const, failedStep: 'rename-backup', detail: 'rename failed' };
// @ts-expect-error structural assignments must also exclude contradictory success evidence
const successFromContradictoryVariable: RollbackResult = contradictoryVariable;
function narrowFailure(rollback: RollbackResult) {
  if (rollback.complete) return;
  const failedStep: string = rollback.failedStep;
  const detail: string = rollback.detail;
  return { failedStep, detail };
}
void [complete, incomplete, missingEvidence, missingDetail, missingStep, successWithFailure,
  successWithDetail, successFromContradictoryVariable, narrowFailure];
