import { describe, expect, it } from 'vitest';
import {
  createAdmittedOperationContext,
  createOperationContext,
} from '../src/index.js';

describe('admitted operation context', () => {
  it('snapshots operation attribution and preserves the admitted signal identity', () => {
    const operation = createOperationContext('publish');
    const signal = new AbortController().signal;
    const admitted = createAdmittedOperationContext(operation, signal);
    operation.operationName = 'query';

    expect(admitted.operation.operationName).toBe('publish');
    expect(admitted.signal).toBe(signal);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.operation)).toBe(true);
  });

  it('refuses to admit work after its owner has cancelled the generation', () => {
    const controller = new AbortController();
    const reason = new Error('generation closed');
    controller.abort(reason);
    expect(() => createAdmittedOperationContext(
      createOperationContext('publish'),
      controller.signal,
    )).toThrow(reason);
  });
});
