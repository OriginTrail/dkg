import {
  RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { SyncSharedProjectionStoreV1 } from '../src/rfc64-shared-projection-stream-gateway.js';
import { runRfc64HttpProjectionCapabilityConformance } from './helpers/rfc64-http-projection-capability-conformance.js';
import { createRfc64SharedProjectionTestFixture } from './helpers/rfc64-shared-projection-fixture.js';

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
  it('uses the frozen query and Blazegraph-specific request headers', async () => {
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_input, init) => {
      request = init;
      return new Response(byteStream([LINE_Z, LINE_A]), { status: 200 });
    }) as typeof fetch;
    const store = new BlazegraphStore('http://blazegraph.invalid/sparql', { timeout: 1_000 });

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
  });

  it('normalizes Blazegraph UCHAR escapes in every IRI position through the gateway', async () => {
    const fixture = createRfc64SharedProjectionTestFixture({
      triples: [{
        subject: 'urn:café',
        predicate: 'urn:predicate:😀',
        object: 'urn:object:😀',
      }],
    });
    const escaped = String.raw`<urn:caf\u00E9> <urn:predicate:\U0001F600> <urn:object:\uD83D\uDE00> .`;
    globalThis.fetch = (async () => new Response(`${escaped}\n`, {
      status: 200,
    })) as typeof fetch;
    const store = new BlazegraphStore('http://blazegraph.invalid/sparql');

    const result = await new SyncSharedProjectionStoreV1(store).open(fixture.request, {
      operatorByteCeiling: 4096,
      timeoutMs: 1000,
    });

    expect(await collect(result.bytes)).toEqual(fixture.projectionBytes);
  });

});

runRfc64HttpProjectionCapabilityConformance({
  adapterName: 'Blazegraph',
  createStore: (scheduler, timeout) => new BlazegraphStore(
    'http://blazegraph.invalid/sparql',
    { scheduler, timeout },
  ),
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
