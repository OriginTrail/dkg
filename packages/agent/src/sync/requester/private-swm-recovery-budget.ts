import { monotonicNow } from '../catchup-policy.js';

export const DEFAULT_PRIVATE_SWM_RECOVERY_BUDGET_MS = 600_000;

/** One elapsed-time allowance shared by all rounds/pages in a recovery job. */
export interface SwmRecoveryTimeBudget {
  readonly remainingMs: () => number;
}

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
export function createPrivateSwmRecoveryTimeBudget(
  budgetMs = resolvePrivateSwmRecoveryBudgetMs(),
): SwmRecoveryTimeBudget | undefined {
  if (budgetMs === 0) return undefined;
  const expiresAt = monotonicNow() + budgetMs;
  return Object.freeze({ remainingMs: () => Math.max(0, expiresAt - monotonicNow()) });
}

/** Transport deadlines use wall time; rebuild the cap from the remaining duration. */
export function recoveryFetchDeadline(deadline: number, budget?: SwmRecoveryTimeBudget): number {
  return budget === undefined ? deadline : Math.min(deadline, Date.now() + budget.remainingMs());
}
