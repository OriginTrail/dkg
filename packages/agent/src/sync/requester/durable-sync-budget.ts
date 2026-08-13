import {
  SYNC_MIN_GRAPH_BUDGET_MS,
  SYNC_TOTAL_TIMEOUT_MS,
} from '../../dkg-agent-constants.js';

export const MAX_DURABLE_SYNC_TOTAL_TIMEOUT_MS = 300_000;
// Explicit operation timeouts also bound verification, storage, and durable
// checkpoint settlement. Stop network fetches before that hard boundary so a
// large, already-received prefix is not discarded when the outer signal fires
// during local settlement. Callers without an explicit operation boundary keep
// their historical fetch-only budgets.
export const DURABLE_SYNC_SETTLEMENT_HEADROOM_MS = 60_000;
// A maximum-size valid KA is 10,000 triples. Field measurements on the slowest
// observed canary path project roughly 425 seconds for its byte-paged transfer,
// so exact VM repair gets a separate hard 10-minute transfer ceiling.
export const EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS = 600_000;
// Meta and data historically drew down ONE shared per-CG deadline, and the
// meta stream of a large system CG (agents/ontology run to tens of thousands
// of rows) over a relayed, page-shrinking transport could consume the whole
// window. The data phase then reported a timeout with zero triples received
// having never sent a request — every cycle, forever. The requester applies
// this cap to system CGs only: their unverified payloads can persist and resume
// after a capped partial meta page. Verified CGs keep the full window for meta,
// because their meta and data cursors advance only after clean joint
// verification; capping meta there could pin both cursors on the same partial
// descriptor window. Deadlines are absolute, so a system-CG meta phase that
// finishes early hands its unused time to data for free and the two phases
// combined can never exceed the CG budget.
export const DURABLE_META_PHASE_BUDGET_FRACTION = 0.4;
// Wall clock the data phase keeps even when an operation deadline clamps the
// CG window so tight that the fraction above would leave it less. Must stay
// below SYNC_MIN_GRAPH_BUDGET_MS * (1 - DURABLE_META_PHASE_BUDGET_FRACTION)
// so a minimum-budget CG still gives meta a usable slice.
export const DURABLE_DATA_PHASE_MIN_BUDGET_MS = SYNC_MIN_GRAPH_BUDGET_MS / 2;

export interface DurableSyncContextGraphBudget {
  /**
   * Deadline for fetching this Context Graph's durable snapshot. This bounds
   * the whole per-CG fetch, so the data phase (which runs last) uses it
   * directly and unused meta time rolls over to data.
   */
  readonly fetchDeadline: number;
  /**
   * Earlier deadline for the meta phase alone, keeping a bounded fraction of
   * the CG window so a slow system-CG meta transfer cannot starve the data
   * phase. The requester deliberately ignores this earlier deadline for
   * verified CGs. Optional for rolling deep-import compatibility: budgets
   * minted before the phases split share `fetchDeadline`, preserving their
   * single-deadline behaviour.
   */
  readonly metaFetchDeadline?: number;
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

/**
 * Resolve the soft fetch budget inside a durable-sync operation.
 *
 * An explicit `totalTimeoutMs` owns the whole operation, not just transport,
 * so reserve bounded headroom for verification, storage, and checkpointing.
 * Exact recovery keeps its wider fetch-only ceiling when no outer operation
 * timeout exists.
 */
export function createDurableSyncFetchTimeoutMs(options: {
  totalTimeoutMs?: number;
  exactRecovery?: boolean;
} = {}): number {
  if (options.totalTimeoutMs === undefined) {
    return options.exactRecovery
      ? EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS
      : normalizeDurableSyncTimeoutMs(undefined);
  }

  const operationTimeoutMs = normalizeDurableSyncTimeoutMs(options.totalTimeoutMs);
  return Math.max(
    SYNC_MIN_GRAPH_BUDGET_MS,
    operationTimeoutMs - DURABLE_SYNC_SETTLEMENT_HEADROOM_MS,
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
 * Bound the meta phase inside one Context Graph's fetch window. Meta gets at
 * most its budget fraction, and never so much that less than the data floor
 * remains before `fetchDeadline`. A window already too small to reserve that
 * floor has nothing meaningful to split, so it keeps the shared deadline:
 * a tightly clamped operation window degrades exactly as it always did
 * instead of failing meta instantly.
 */
export function createDurableMetaPhaseFetchDeadline(options: {
  fetchDeadline: number;
  now?: () => number;
}): number {
  const now = (options.now ?? Date.now)();
  const totalBudgetMs = options.fetchDeadline - now;
  const metaBudgetMs = Math.min(
    Math.floor(totalBudgetMs * DURABLE_META_PHASE_BUDGET_FRACTION),
    totalBudgetMs - DURABLE_DATA_PHASE_MIN_BUDGET_MS,
  );
  if (metaBudgetMs <= 0) return options.fetchDeadline;
  return now + metaBudgetMs;
}

/**
 * Construct the requester-owned fetch/authentication phase policy. Lifecycle
 * supplies only caller configuration and whether this is exact VM recovery.
 */
export function createDurableSyncBudget(options: {
  fetchTimeoutMs?: number;
  authenticationTimeoutMs?: number;
  exactRecovery?: boolean;
  operationFetchDeadline?: number;
  operationDeadline?: number;
  now?: () => number;
}): DurableSyncBudget {
  return {
    createContextGraphBudget: ({ remainingContextGraphs }) => {
      const fetchDeadline = Math.min(
        createContextGraphSyncDeadline({
          remainingContextGraphs,
          totalTimeoutMs: options.fetchTimeoutMs,
          maximumMs: options.exactRecovery
            ? EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS
            : MAX_DURABLE_SYNC_TOTAL_TIMEOUT_MS,
          now: options.now,
        }),
        options.operationFetchDeadline ?? Number.POSITIVE_INFINITY,
        options.operationDeadline ?? Number.POSITIVE_INFINITY,
      );
      return {
        fetchDeadline,
        metaFetchDeadline: createDurableMetaPhaseFetchDeadline({
          fetchDeadline,
          now: options.now,
        }),
        createGraphScopedAuthenticationDeadline: () => Math.min(
          createGraphScopedAuthenticationDeadline({
            totalTimeoutMs: options.authenticationTimeoutMs,
            now: options.now,
          }),
          options.operationDeadline ?? Number.POSITIVE_INFINITY,
        ),
      };
    },
  };
}
