import { monotonicNow } from '../catchup-policy.js';
import { createSyncWorkAdmission, UNRESTRICTED_SYNC_WORK, type SyncWorkAdmission } from '../work-admission.js';

export const DEFAULT_PRIVATE_SWM_RECOVERY_BUDGET_MS = 600_000;

/** One elapsed-time allowance shared by all rounds/pages in a recovery job. */
export type PrivateSwmRecoveryWindow = SyncWorkAdmission & Readonly<{
  kind: 'budgeted' | 'initial-round-only';
  canStartRound: (round: number) => boolean;
}>;

export function resolvePrivateSwmRecoveryBudgetMs(
  raw: string | undefined = process.env.DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_PRIVATE_SWM_RECOVERY_BUDGET_MS;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_PRIVATE_SWM_RECOVERY_BUDGET_MS;
}

/** Zero disables extra rounds; the initial round retains its existing deadline. */
export function createPrivateSwmRecoveryWindow(budgetMs: number): PrivateSwmRecoveryWindow {
  if (budgetMs === 0) return Object.freeze({
    ...UNRESTRICTED_SYNC_WORK,
    kind: 'initial-round-only',
    canStartRound: (round: number) => round === 1,
  });
  const expiresAt = monotonicNow() + budgetMs;
  const remainingMs = () => Math.max(0, expiresAt - monotonicNow());
  return Object.freeze({
    ...createSyncWorkAdmission(remainingMs),
    kind: 'budgeted',
    canStartRound: (round: number) => round === 1 || remainingMs() > 0,
  });
}
