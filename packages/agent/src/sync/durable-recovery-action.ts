// SPDX-License-Identifier: Apache-2.0
import type { DurableSyncResult } from '../dkg-agent-types.js';
export type DurableRecoveryDiagnostics = Omit<DurableSyncResult, 'complete'>;
export interface ExactRecoveryActionOutcome {
  readonly diagnostics: DurableRecoveryDiagnostics;
  readonly selection: 'complete' | 'incomplete';
}
/** Strip lane completion at the action boundary; graph completion belongs to the owner. */
export function recoveryActionDiagnostics(result: DurableSyncResult): DurableRecoveryDiagnostics {
  const { complete: _complete, ...diagnostics } = result;
  return diagnostics;
}
export function exactRecoveryActionOutcome(result: DurableSyncResult, found = true): ExactRecoveryActionOutcome {
  return { diagnostics: recoveryActionDiagnostics(result), selection: found && result.complete ? 'complete' : 'incomplete' };
}
