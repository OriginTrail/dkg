import {
  SYNC_MIN_GRAPH_BUDGET_MS,
  SYNC_TOTAL_TIMEOUT_MS,
} from '../../dkg-agent-constants.js';

export const MAX_DURABLE_SYNC_TOTAL_TIMEOUT_MS = 300_000;
// A maximum-size valid KA is 10,000 triples. Field measurements on the slowest
// observed canary path project roughly 425 seconds for its byte-paged transfer,
// so exact VM repair gets a separate hard 10-minute transfer ceiling.
export const EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS = 600_000;

export interface DurableSyncContextGraphBudget {
  /** Deadline for fetching this Context Graph's durable snapshot. */
  readonly fetchDeadline: number;
  /** Fresh deadline for authenticating graph-scoped assets from one verified page. */
  readonly createGraphScopedAuthenticationDeadline: () => number;
}

export interface DurableSyncContextGraphBudgetRequest {
  readonly contextGraphId: string;
  readonly remainingContextGraphs: number;
}

export interface DurableSyncBudget {
  /**
   * Create one explicit Context Graph budget. Callers supply graph identity
   * and remaining work, so budgeting never depends on hidden callback order.
   */
  createContextGraphBudget: (
    request: DurableSyncContextGraphBudgetRequest,
  ) => DurableSyncContextGraphBudget;
}

export function normalizeDurableSyncTimeoutMs(
  value: number | undefined,
  maximumMs: number = MAX_DURABLE_SYNC_TOTAL_TIMEOUT_MS,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SYNC_TOTAL_TIMEOUT_MS;
  return Math.min(
    maximumMs,
    Math.max(SYNC_MIN_GRAPH_BUDGET_MS, Math.floor(value)),
  );
}

export function createContextGraphSyncDeadline(options: {
  remainingContextGraphs: number;
  totalTimeoutMs?: number;
  maximumMs?: number;
  now?: () => number;
}): number {
  const divisor = Math.max(1, options.remainingContextGraphs);
  const normalizedTotalTimeoutMs = normalizeDurableSyncTimeoutMs(
    options.totalTimeoutMs,
    options.maximumMs,
  );
  const budgetMs = Math.max(
    SYNC_MIN_GRAPH_BUDGET_MS,
    Math.floor(normalizedTotalTimeoutMs / divisor),
  );
  return (options.now ?? Date.now)() + budgetMs;
}

export function createGraphScopedAuthenticationDeadline(options: {
  totalTimeoutMs?: number;
  now?: () => number;
} = {}): number {
  return (options.now ?? Date.now)()
    + normalizeDurableSyncTimeoutMs(options.totalTimeoutMs);
}

/**
 * Construct the requester-owned fetch/authentication phase policy. Lifecycle
 * supplies only caller configuration and whether this is exact VM recovery.
 */
export function createDurableSyncBudget(options: {
  fetchTimeoutMs?: number;
  authenticationTimeoutMs?: number;
  exactRecovery?: boolean;
  operationDeadline?: number;
  now?: () => number;
}): DurableSyncBudget {
  return {
    createContextGraphBudget: ({ remainingContextGraphs }) => ({
      fetchDeadline: Math.min(
        createContextGraphSyncDeadline({
          remainingContextGraphs,
          totalTimeoutMs: options.fetchTimeoutMs,
          maximumMs: options.exactRecovery
            ? EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS
            : MAX_DURABLE_SYNC_TOTAL_TIMEOUT_MS,
          now: options.now,
        }),
        options.operationDeadline ?? Number.POSITIVE_INFINITY,
      ),
      createGraphScopedAuthenticationDeadline: () => Math.min(
        createGraphScopedAuthenticationDeadline({
          totalTimeoutMs: options.authenticationTimeoutMs,
          now: options.now,
        }),
        options.operationDeadline ?? Number.POSITIVE_INFINITY,
      ),
    }),
  };
}
