import {
  RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';

const ORIGINAL_FETCH = globalThis.fetch;
const GRAPH = 'did:dkg:context-graph:v1/root/a%2Fb/_shared_memory/0x3333333333333333333333333333333333333333/7';
const LINE_A = '<urn:a> <urn:p> "alpha" .\n';
const LINE_Z = '<urn:z> <urn:p> "zeta" .\n';
const PROJECTION_BYTES = new TextEncoder().encode(LINE_A + LINE_Z);
const OPERATION = operation();

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('Blazegraph RFC-64 shared-projection stream', () => {
  it('executes only the frozen query under background admission and emits canonical bytes', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
    const schedule = vi.spyOn(scheduler, 'run');
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      request = init;
      return new Response(byteStream([LINE_Z, LINE_A]), { status: 200 });
    }) as typeof fetch;
    const store = new BlazegraphStore('http://blazegraph.invalid/sparql', {
      scheduler,
      timeout: 1_000,
    });

    const source = await store.rfc64SharedProjectionStreamV1(OPERATION, {
      byteCeiling: 4096,
    });

    expect(await collect(source)).toEqual(PROJECTION_BYTES);
    expect(request?.body).toBe(OPERATION.sparql);
    expect(request?.headers).toMatchObject({
      Accept: 'text/x-nquads, application/n-quads',
      'Content-Type': 'application/sparql-query; charset=utf-8',
      'X-BIGDATA-MAX-QUERY-MILLIS': '4000',
    });
    expect(schedule).toHaveBeenCalledWith(
      'background',
      'rfc64.shared-projection.SYNC_KA_SHARED_PROJECTION_STREAM_V1',
      expect.any(Function),
      expect.any(AbortSignal),
      { storeOperation: 'construct' },
    );
  });

  it('accepts the exact named graph and rejects a foreign graph', async () => {
    globalThis.fetch = (async () => new Response(
      `<urn:a> <urn:p> "alpha" <${GRAPH}> .\n`,
      { status: 200 },
    )) as typeof fetch;
    const store = new BlazegraphStore('http://blazegraph.invalid/sparql');
    const exact = await store.rfc64SharedProjectionStreamV1(
      operation({ publicTripleCount: '1' }),
      { byteCeiling: 4096 },
    );
    expect(await collect(exact)).toEqual(new TextEncoder().encode(LINE_A));

    globalThis.fetch = (async () => new Response(
      '<urn:a> <urn:p> "alpha" <urn:foreign> .\n',
      { status: 200 },
    )) as typeof fetch;
    await expect(store.rfc64SharedProjectionStreamV1(
      operation({ publicTripleCount: '1' }),
      { byteCeiling: 4096 },
    )).rejects.toThrow('escaped the exact authenticated graph');
  });

  it('holds scheduler admission through the response body and cancels promptly', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
    const started = Promise.withResolvers<void>();
    let transportSignal: AbortSignal | null = null;
    globalThis.fetch = (async (_input, init) => {
      transportSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(LINE_A));
          started.resolve();
          transportSignal?.addEventListener('abort', () => {
            controller.error(transportSignal?.reason);
          }, { once: true });
        },
      }), { status: 200 });
    }) as typeof fetch;
    const store = new BlazegraphStore('http://blazegraph.invalid/sparql', {
      scheduler,
      timeout: 30_000,
    });
    const abort = new AbortController();

    const pending = store.rfc64SharedProjectionStreamV1(
      operation({ publicTripleCount: '2' }),
      { byteCeiling: 4096, signal: abort.signal },
    );
    await started.promise;
    expect(scheduler.snapshot.backgroundInflight).toBe(1);
    abort.abort(new DOMException('caller stopped', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(true);
    expect(scheduler.snapshot.backgroundInflight).toBe(0);
  });

  it('keeps caller cancellation live after the HTTP spool has released its scheduler slot', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
    globalThis.fetch = (async () => new Response(
      byteStream([LINE_Z, LINE_A]),
      { status: 200 },
    )) as typeof fetch;
    const store = new BlazegraphStore('http://blazegraph.invalid/sparql', {
      scheduler,
      timeout: 1_000,
    });
    const abort = new AbortController();

    const source = await store.rfc64SharedProjectionStreamV1(OPERATION, {
      byteCeiling: 4096,
      signal: abort.signal,
    });
    expect(scheduler.snapshot.backgroundInflight).toBe(0);

    const reason = new DOMException('consumer stopped', 'AbortError');
    abort.abort(reason);
    await expect(collect(source)).rejects.toBe(reason);
  });
});

function operation(
  overrides: Partial<Rfc64SharedProjectionStreamOperationV1> = {},
): Rfc64SharedProjectionStreamOperationV1 {
  return Object.freeze({
    queryId: 'SYNC_KA_SHARED_PROJECTION_STREAM_V1',
    graphIri: GRAPH,
    commitmentSubject:
      'did:dkg:otp:20430/0x3333333333333333333333333333333333333333/7/_cg-shared-v1',
    projectionDigest: `0x${'11'.repeat(32)}`,
    publicTripleCount: '2',
    signedByteCeiling: 4096,
    protocolByteCeiling: RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
    resultKind: 'quad-stream',
    concurrencyClass: 'rfc64-shared-projection-v1',
    sparql: `CONSTRUCT { ?s ?p ?o }\nWHERE {\n  GRAPH <${GRAPH}> {\n    ?s ?p ?o .\n  }\n}`,
    ...overrides,
  }) as Rfc64SharedProjectionStreamOperationV1;
}

function byteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const value of source) {
    chunks.push(value);
    length += value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
