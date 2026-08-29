import {
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createTripleStore,
  issueManagedOxigraphRuntimeCapabilityV1,
  SparqlHttpStore,
  SyncSharedProjectionStoreV1,
} from '../src/index.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import {
  createRfc64SharedProjectionTestFixture,
  RFC64_PROJECTION_TEST_GRAPH,
} from './helpers/rfc64-shared-projection-fixture.js';
import {
  startOxigraphSparqlEndpoint,
  type OxigraphSparqlEndpoint,
} from './helpers/oxigraph-sparql-endpoint.js';

const ORIGINAL_FETCH = globalThis.fetch;
const GRAPH = RFC64_PROJECTION_TEST_GRAPH;
const LINE_A = '<urn:a> <urn:p> "alpha" .\n';
const LINE_Z = '<urn:z> <urn:p> "zeta" .\n';
const FIXTURE = createRfc64SharedProjectionTestFixture();
const PROJECTION_BYTES = FIXTURE.projectionBytes;
const REQUEST = FIXTURE.request;
const OPERATION = FIXTURE.operation;
let oxigraph: OxigraphSparqlEndpoint;

beforeAll(async () => {
  oxigraph = await startOxigraphSparqlEndpoint();
});

afterAll(async () => {
  await oxigraph.close();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('managed Oxigraph RFC-64 shared-projection stream', () => {
  it('is structurally absent on generic and merely DKG-owned SPARQL endpoints', () => {
    const generic = new SparqlHttpStore({ queryEndpoint: 'http://generic.invalid/query' });
    const configured = new SparqlHttpStore({
      queryEndpoint: 'http://configured.invalid/query',
      managedByDkg: true,
    });

    expect(generic.rfc64SharedProjectionStreamV1).toBeUndefined();
    expect(configured.rfc64SharedProjectionStreamV1).toBeUndefined();
    expect(() => new SyncSharedProjectionStoreV1(generic)).toThrow(
      'triple store has no certified RFC-64 shared-projection stream capability',
    );
    expect(() => new SyncSharedProjectionStoreV1(configured)).toThrow(
      'triple store has no certified RFC-64 shared-projection stream capability',
    );
  });

  it('cannot activate the capability from forged persisted adapter options', async () => {
    const forged = await createTripleStore({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://forged.invalid/query',
        managedOxigraph: true,
        managedOxigraphRuntimeCapability: {
          kind: 'dkg-managed-oxigraph-runtime-v1',
        },
      },
    });

    expect(forged.rfc64SharedProjectionStreamV1).toBeUndefined();
  });

  it('uses the frozen exact CONSTRUCT and exposes sorted canonical line bytes', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
    const schedule = vi.spyOn(scheduler, 'run');
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      request = init;
      return new Response(byteStream([LINE_Z.slice(0, 7), LINE_Z.slice(7) + LINE_A]), {
        status: 200,
        headers: { 'Content-Type': 'application/n-quads' },
      });
    }) as typeof fetch;
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://managed-oxigraph.invalid/query',
      managedByDkg: true,
      managedOxigraphRuntimeCapability: issueManagedOxigraphRuntimeCapabilityV1(),
      scheduler,
    });

    const result = await new SyncSharedProjectionStoreV1(store).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 1000,
    });

    expect(await collectBytes(result.bytes)).toEqual(PROJECTION_BYTES);
    expect(request?.body).toBe(OPERATION.sparql);
    expect(request?.headers).toMatchObject({
      Accept: 'application/n-quads, text/n-quads',
      'Content-Type': 'application/sparql-query; charset=utf-8',
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(schedule).toHaveBeenCalledWith(
      'background',
      'rfc64.shared-projection.SYNC_KA_SHARED_PROJECTION_STREAM_V1',
      expect.any(Function),
      expect.any(AbortSignal),
      { storeOperation: 'construct' },
    );
  });

  it('reads only the exact projection through the real Oxigraph engine with 10x unrelated state', async () => {
    oxigraph.store.update('DROP ALL');
    const unrelated = Array.from({ length: 20 }, (_, index) => (
      `<urn:unrelated:${index}> <urn:p> "${index}" <urn:unrelated:graph:${index % 4}> .`
    ));
    oxigraph.store.load([
      `<urn:z> <urn:p> "zeta" <${GRAPH}> .`,
      `<urn:a> <urn:p> "alpha" <${GRAPH}> .`,
      ...unrelated,
    ].join('\n'), { format: 'application/n-quads' });
    const store = new SparqlHttpStore({
      queryEndpoint: oxigraph.queryEndpoint,
      updateEndpoint: oxigraph.updateEndpoint,
      managedOxigraphRuntimeCapability: issueManagedOxigraphRuntimeCapabilityV1(),
    });

    const source = await store.rfc64SharedProjectionStreamV1!(OPERATION, {
      byteCeiling: 4096,
    });

    expect(await collectBytes(source)).toEqual(PROJECTION_BYTES);
    const total = oxigraph.store.query(
      'SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }',
    ) as Map<string, { value: string }>[];
    expect(total[0]?.get('c')?.value).toBe('22');
  });

  it('holds scheduler admission through the response body and cancels promptly', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0 });
    const started = Promise.withResolvers<void>();
    let transportSignal: AbortSignal | null = null;
    globalThis.fetch = (async (_input, init) => {
      transportSignal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(LINE_A));
          started.resolve();
          transportSignal?.addEventListener('abort', () => {
            controller.error(transportSignal?.reason);
          }, { once: true });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://managed-oxigraph.invalid/query',
      managedOxigraphRuntimeCapability: issueManagedOxigraphRuntimeCapabilityV1(),
      scheduler,
    });
    const abort = new AbortController();

    const pending = store.rfc64SharedProjectionStreamV1!(operation({
      publicTripleCount: '2',
    }), {
      byteCeiling: 4096,
      signal: abort.signal,
    });
    await started.promise;
    expect(scheduler.snapshot.backgroundInflight).toBe(1);
    abort.abort(new DOMException('caller stopped', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(true);
    expect(scheduler.snapshot.backgroundInflight).toBe(0);
  });

  it('keeps caller cancellation live while the local result is consumed', async () => {
    globalThis.fetch = (async () => new Response(byteStream([LINE_Z, LINE_A]), {
      status: 200,
    })) as typeof fetch;
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://managed-oxigraph.invalid/query',
      managedOxigraphRuntimeCapability: issueManagedOxigraphRuntimeCapabilityV1(),
    });
    const abort = new AbortController();
    const source = await store.rfc64SharedProjectionStreamV1!(OPERATION, {
      byteCeiling: 4096,
      signal: abort.signal,
    });
    const iterator = source[Symbol.asyncIterator]();

    abort.abort(new DOMException('consumer stopped', 'AbortError'));

    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves the typed managed-Oxigraph cancellation trailer classification', async () => {
    globalThis.fetch = (async () => new Response(byteStream([
      LINE_A,
      LINE_Z,
      'The SPARQL operation has been cancelled',
    ]), { status: 200 })) as typeof fetch;
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://managed-oxigraph.invalid/query',
      managedOxigraphRuntimeCapability: issueManagedOxigraphRuntimeCapabilityV1(),
    });

    await expect(store.rfc64SharedProjectionStreamV1!(OPERATION, {
      byteCeiling: 4096,
    })).rejects.toMatchObject({
      code: 'STORE_OPERATION_TIMEOUT',
      backend: 'oxigraph-server',
      operation: 'construct',
      retryable: true,
    });
  });

  it('preserves typed HTTP refusal evidence without parsing an unbounded error body', async () => {
    let pulls = 0;
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x78));
        if (pulls >= 8) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (async () => new Response(oversized, { status: 503 })) as typeof fetch;
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://managed-oxigraph.invalid/query',
      managedOxigraphRuntimeCapability: issueManagedOxigraphRuntimeCapabilityV1(),
    });

    await expect(store.rfc64SharedProjectionStreamV1!(OPERATION, {
      byteCeiling: 4096,
    })).rejects.toMatchObject({
      name: 'SparqlHttpResponseError',
      operation: 'rfc64-shared-projection',
      status: 503,
      responseExcerpt: '',
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(8);
  });
});

function operation(
  overrides: Partial<Rfc64SharedProjectionStreamOperationV1> = {},
): Rfc64SharedProjectionStreamOperationV1 {
  return Object.freeze({
    ...OPERATION,
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

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
