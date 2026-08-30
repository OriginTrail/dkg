import { describe, expect, it } from 'vitest';

import {
  deserializeWorkerErrorV1,
  serializeWorkerErrorV1,
} from '../src/worker-error-protocol.js';

describe('worker error protocol', () => {
  it('round-trips generic error metadata without reconstructing feature errors', () => {
    const source = new Error('worker failed') as Error & { code?: string };
    source.name = 'UnrelatedWorkerError';
    source.code = 'UNRELATED_V1';
    const envelope = serializeWorkerErrorV1(source);
    expect(envelope).toEqual({
      name: 'UnrelatedWorkerError',
      message: 'worker failed',
      code: 'UNRELATED_V1',
    });
    const restored = deserializeWorkerErrorV1(envelope) as Error & { code?: string };
    expect(restored).toBeInstanceOf(Error);
    expect(restored).toMatchObject({
      name: 'UnrelatedWorkerError',
      message: 'worker failed',
      code: 'UNRELATED_V1',
    });
  });
});
