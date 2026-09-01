import { describe, expect, it } from 'vitest';

import {
  deserializeWorkerErrorV1,
  serializeWorkerErrorV1,
  type WorkerResponseV1,
} from '../src/worker-error-protocol.js';
import { OxigraphWorkerStore } from '../src/adapters/oxigraph-worker.js';

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

  it('keeps worker failures in one discriminated error envelope', () => {
    const response: WorkerResponseV1 = {
      id: 7,
      error: serializeWorkerErrorV1(Object.assign(
        new Error('Unknown method: missing'),
        { name: 'UnknownWorkerMethodError', code: 'UNKNOWN_METHOD' },
      )),
    };
    expect(response).toEqual({
      id: 7,
      error: {
        name: 'UnknownWorkerMethodError',
        message: 'Unknown method: missing',
        code: 'UNKNOWN_METHOD',
      },
    });
    if (!('error' in response)) throw new Error('expected worker error response');
    expect(deserializeWorkerErrorV1(response.error)).toMatchObject({
      name: 'UnknownWorkerMethodError',
      message: 'Unknown method: missing',
      code: 'UNKNOWN_METHOD',
    });
  });

  it('routes an unknown worker method through the structured error envelope', async () => {
    const store = new OxigraphWorkerStore();
    const internals = store as unknown as {
      postToWorker<T>(
        timeoutMs: number,
        signal: AbortSignal | undefined,
        method: string,
        args: unknown[],
      ): Promise<T>;
    };
    try {
      await expect(internals.postToWorker(1_000, undefined, 'missingMethod', []))
        .rejects.toMatchObject({
          name: 'Error',
          message: 'Unknown method: missingMethod',
        });
    } finally {
      await store.close();
    }
  });
});
