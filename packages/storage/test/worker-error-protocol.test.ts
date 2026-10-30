import { describe, expect, it } from 'vitest';

import {
  StoreResponseTooLargeError,
  isStoreResponseTooLargeError,
} from '../src/http-response-limit.js';
import {
  deserializeWorkerErrorV1,
  serializeWorkerErrorV1,
  type WorkerResponseV1,
} from '../src/worker-error-protocol.js';
import { OxigraphWorkerStore } from '../src/adapters/oxigraph-worker.js';

describe('worker error protocol', () => {
  it('serializes thrown non-Error values through the generic variant', () => {
    expect(serializeWorkerErrorV1('plain worker failure')).toEqual({
      kind: 'generic',
      name: 'Error',
      message: 'plain worker failure',
    });
  });

  it('round-trips generic error metadata without reconstructing feature errors', () => {
    const source = new Error('worker failed') as Error & { code?: string };
    source.name = 'UnrelatedWorkerError';
    source.code = 'UNRELATED_V1';
    const envelope = serializeWorkerErrorV1(source);
    expect(envelope).toEqual({
      kind: 'generic',
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
        kind: 'generic',
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

  it('does not attach response-limit metadata to unrelated error codes', () => {
    const source = Object.assign(new Error('unrelated'), {
      code: 'UNRELATED',
      maxBytes: 10,
      actualBytes: 11,
    });
    expect(serializeWorkerErrorV1(source)).toEqual({
      kind: 'generic',
      name: 'Error',
      message: 'unrelated',
      code: 'UNRELATED',
    });
  });

  it('round-trips response-limit metadata only through its discriminated variant', () => {
    const envelope = serializeWorkerErrorV1(new StoreResponseTooLargeError(256, 257n));
    expect(envelope).toEqual({
      kind: 'store-response-too-large',
      maxBytes: 256,
      actualBytes: 257n,
    });
    const restored = deserializeWorkerErrorV1(envelope);
    expect(restored).toBeInstanceOf(StoreResponseTooLargeError);
    expect(isStoreResponseTooLargeError(restored)).toBe(true);
    expect(restored).toMatchObject({ maxBytes: 256, actualBytes: 257n });
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
      await expect(internals.postToWorker(5_000, undefined, 'missingMethod', []))
        .rejects.toMatchObject({
          name: 'Error',
          message: 'Unknown method: missingMethod',
        });
    } finally {
      await store.close();
    }
  });

  it('rejects an oversized query inside the worker before transferring its result', async () => {
    const store = new OxigraphWorkerStore();
    try {
      await store.insert(Array.from({ length: 64 }, (_, index) => ({
        subject: `urn:worker-subject:${index}`,
        predicate: 'urn:predicate',
        object: `"${'x'.repeat(128)}"`,
        graph: 'urn:worker-graph',
      })));

      await expect(store.query(
        'SELECT ?s ?o WHERE { GRAPH <urn:worker-graph> { ?s <urn:predicate> ?o } }',
        { maxResponseBytes: 256 },
      )).rejects.toMatchObject({
        name: 'StoreResponseTooLargeError',
        code: 'STORE_RESPONSE_TOO_LARGE',
        maxBytes: 256,
        actualBytes: expect.any(Number),
      });
    } finally {
      await store.close();
    }
  });
});
