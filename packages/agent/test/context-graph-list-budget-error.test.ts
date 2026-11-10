import { describe, expect, it } from 'vitest';
import { ListContextGraphsBudgetExceeded, isListContextGraphsBudgetExceeded } from '../src/context-graph-list-budget-error.js';

describe('retryable context-graph listing budget markers', () => {
  const marker = { code: 'CONTEXT_GRAPH_LIST_BUDGET_EXCEEDED', retryable: true, timeoutMs: 5000 };

  it('recognizes the thrown budget error and its enumerable copy without requiring Error fields', () => {
    const error = new ListContextGraphsBudgetExceeded('required scan', 5000);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('required scan exceeded listContextGraphs budget');
    expect(error.name).toBe('ListContextGraphsBudgetExceeded');
    expect(isListContextGraphsBudgetExceeded(error)).toBe(true);
    const copy = { ...error };
    expect(copy).not.toHaveProperty('message');
    expect(isListContextGraphsBudgetExceeded(copy)).toBe(true);
    expect(isListContextGraphsBudgetExceeded(marker)).toBe(true);
  });

  it.each([null, undefined, false, 0, 'CONTEXT_GRAPH_LIST_BUDGET_EXCEEDED', {},
    new Error('required scan exceeded listContextGraphs budget')])('does not classify unrelated values as retryable: %s', value => {
    expect(isListContextGraphsBudgetExceeded(value)).toBe(false);
  });

  it.each([
    { ...marker, code: 'STORE_OPERATION_TIMEOUT' },
    { ...marker, retryable: false },
    { ...marker, timeoutMs: '5000' },
    { ...marker, timeoutMs: undefined },
    { ...marker, timeoutMs: 0 },
    { ...marker, timeoutMs: -1 },
    { ...marker, timeoutMs: Number.NaN },
    { ...marker, timeoutMs: Number.POSITIVE_INFINITY },
  ])('rejects malformed marker fields: %j', value => {
    expect(isListContextGraphsBudgetExceeded(value)).toBe(false);
  });
});
