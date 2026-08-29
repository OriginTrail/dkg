import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  SparqlHttpStore,
  SyncSharedProjectionStoreV1,
} from '../src/index.js';
import { runRfc64HttpProjectionCapabilityConformance } from './helpers/rfc64-http-projection-capability-conformance.js';
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

  it('uses the frozen exact CONSTRUCT and managed-Oxigraph request headers', async () => {
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
      managedOxigraph: true,
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
      managedOxigraph: true,
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

  it('preserves the typed managed-Oxigraph cancellation trailer classification', async () => {
    globalThis.fetch = (async () => new Response(byteStream([
      LINE_A,
      LINE_Z,
      'The SPARQL operation has been cancelled',
    ]), { status: 200 })) as typeof fetch;
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://managed-oxigraph.invalid/query',
      managedOxigraph: true,
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
      managedOxigraph: true,
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

runRfc64HttpProjectionCapabilityConformance({
  adapterName: 'managed Oxigraph',
  createStore: (scheduler, timeout) => new SparqlHttpStore({
    queryEndpoint: 'http://managed-oxigraph.invalid/query',
    managedOxigraph: true,
    scheduler,
    timeout,
  }),
});

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
