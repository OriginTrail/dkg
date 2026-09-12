import { monotonicNow } from '../catchup-policy.js';
import {
  composeSyncWorkAdmission,
  createSyncWorkAdmission,
  UNRESTRICTED_SYNC_WORK,
  type SyncWorkAdmission,
  type SyncWorkAdmissionScope,
} from '../work-admission.js';

export const DEFAULT_PRIVATE_SWM_RECOVERY_BUDGET_MS = 600_000;

/** One elapsed-time allowance shared by all rounds/pages in a recovery job. */
export type PrivateSwmRecoveryWindow = Readonly<{
  kind: 'budgeted' | 'initial-round-only';
  canStartRound: (round: number) => boolean;
  admitRound: (deadline: number, scope: SyncWorkAdmissionScope) => SyncWorkAdmission;
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

/** Normalize programmatic/legacy executor composition at its compatibility edge. */
export function normalizePrivateSwmRecoveryBudgetMs(
  value: number | undefined,
): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0
    ? value!
    : DEFAULT_PRIVATE_SWM_RECOVERY_BUDGET_MS;
}

/** Zero disables extra rounds; the initial round retains its existing deadline. */
export function createPrivateSwmRecoveryWindow(budgetMs: number): PrivateSwmRecoveryWindow {
  if (budgetMs === 0) return Object.freeze({
    kind: 'initial-round-only',
    canStartRound: (round: number) => round === 1,
    admitRound: (deadline, scope) => composeSyncWorkAdmission({
      deadline,
      window: UNRESTRICTED_SYNC_WORK,
      scope,
    }),
  });
  const expiresAt = monotonicNow() + budgetMs;
  const remainingMs = () => Math.max(0, expiresAt - monotonicNow());
  const window = createSyncWorkAdmission(remainingMs, {
    sharing: 'exclusive',
    owner: 'private-swm-job-window',
  });
  return Object.freeze({
    kind: 'budgeted',
    canStartRound: (round: number) => round === 1 || remainingMs() > 0,
    admitRound: (deadline, scope) => composeSyncWorkAdmission({ deadline, window, scope }),
  });
}
