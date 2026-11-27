import { ListContextGraphsBudgetExceeded, isListContextGraphsBudgetExceeded } from '../dist/index.js';

export function narrowedListingBudgetError(value: unknown): void {
  if (!isListContextGraphsBudgetExceeded(value)) return;
  const code: 'CONTEXT_GRAPH_LIST_BUDGET_EXCEEDED' = value.code;
  const retryable: true = value.retryable;
  const timeoutMs: number = value.timeoutMs;
  // Plain-object copies omit Error.message; the guard must not promise it.
  // @ts-expect-error The structural contract establishes no message field.
  const message: string = value.message;
  void [code, retryable, timeoutMs, message];
}

const produced = new ListContextGraphsBudgetExceeded('scan', 5000);
const producerMessage: string = produced.message;
void producerMessage;
