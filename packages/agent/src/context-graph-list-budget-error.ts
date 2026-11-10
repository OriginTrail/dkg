/** Validated fields shared by throwable errors and plain-object copies. */
export interface ListContextGraphsBudgetExceededLike {
  readonly code: 'CONTEXT_GRAPH_LIST_BUDGET_EXCEEDED';
  readonly retryable: true;
  readonly timeoutMs: number;
}

/** A bounded graph listing could not complete; retrying the read is safe. */
export class ListContextGraphsBudgetExceeded extends Error implements ListContextGraphsBudgetExceededLike {
  readonly code = 'CONTEXT_GRAPH_LIST_BUDGET_EXCEEDED' as const;
  readonly retryable = true as const;

  constructor(label: string, readonly timeoutMs: number) {
    super(`${label} exceeded listContextGraphs budget`);
    this.name = 'ListContextGraphsBudgetExceeded';
  }
}

export function isListContextGraphsBudgetExceeded(error: unknown): error is ListContextGraphsBudgetExceededLike {
  if (!error || typeof error !== 'object') return false;
  const value = error as Partial<ListContextGraphsBudgetExceededLike>;
  return value.code === 'CONTEXT_GRAPH_LIST_BUDGET_EXCEEDED'
    && value.retryable === true
    && typeof value.timeoutMs === 'number'
    && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0;
}
