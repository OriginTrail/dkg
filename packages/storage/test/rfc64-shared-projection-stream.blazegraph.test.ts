import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { SyncSharedProjectionStoreV1 } from '../src/rfc64-shared-projection-stream-gateway.js';
import { runRfc64HttpProjectionCapabilityConformance } from './helpers/rfc64-http-projection-capability-conformance.js';
import { createRfc64SharedProjectionTestFixture } from './helpers/rfc64-shared-projection-fixture.js';
import {
  collectProjectionBytes as collect,
  projectionByteStream as byteStream,
} from './helpers/rfc64-projection-stream-test-io.js';

const ORIGINAL_FETCH = globalThis.fetch;
const LINE_A = '<urn:a> <urn:p> "alpha" .\n';
const LINE_Z = '<urn:z> <urn:p> "zeta" .\n';
const FIXTURE = createRfc64SharedProjectionTestFixture();
const PROJECTION_BYTES = FIXTURE.projectionBytes;
const OPERATION = FIXTURE.operation;

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

  it('bounds and cancels an oversized non-2xx response body', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024).fill(0x78));
        if (pulls >= 12) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (async () => new Response(body, { status: 503 })) as typeof fetch;
    const store = new BlazegraphStore('http://blazegraph.invalid/sparql');

    await expect(store.rfc64SharedProjectionStreamV1(OPERATION, {
      byteCeiling: 4096,
    })).rejects.toThrow('Blazegraph construct failed (503)');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(12);
  });

});

runRfc64HttpProjectionCapabilityConformance({
  adapterName: 'Blazegraph',
  createStore: (scheduler, timeout) => new BlazegraphStore(
    'http://blazegraph.invalid/sparql',
    { scheduler, timeout },
  ),
});
