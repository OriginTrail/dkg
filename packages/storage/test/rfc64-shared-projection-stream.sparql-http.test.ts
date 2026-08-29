import {
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  compileRfc64SharedProjectionStreamOperationV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
  verifyCatalogSealBindingV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  SparqlHttpStore,
  SyncSharedProjectionStoreV1,
} from '../src/index.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import type { Quad } from '../src/triple-store.js';
import {
  startOxigraphSparqlEndpoint,
  type OxigraphSparqlEndpoint,
} from './helpers/oxigraph-sparql-endpoint.js';

const ORIGINAL_FETCH = globalThis.fetch;
const GRAPH = 'did:dkg:context-graph:v1/root/a%2Fb/_shared_memory/0x3333333333333333333333333333333333333333/7';
const LINE_A = '<urn:a> <urn:p> "alpha" .\n';
const LINE_Z = '<urn:z> <urn:p> "zeta" .\n';
const PROJECTION_BYTES = new TextEncoder().encode(LINE_A + LINE_Z);
const AUTHOR = '0x3333333333333333333333333333333333333333';
const KAV10 = '0x4444444444444444444444444444444444444444';
const KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
const SCOPE = validScope({
  networkId: 'otp:20430',
  contextGraphId: 'a/b',
  governanceChainId: '20430',
  governanceContractAddress: '0x5555555555555555555555555555555555555555',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
});
const PROFILE = {
  networkId: 'otp:20430',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
} as CatalogSealDeploymentProfileV1;
const SEAL = validSeal({
  assertionMerkleRoot: `0x${'aa'.repeat(32)}`,
  authorAddress: AUTHOR,
  authorAttestationR: `0x${'11'.repeat(32)}`,
  authorAttestationVS: `0x${'22'.repeat(32)}`,
  authorSchemeVersion: '1',
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
  reservedKaId: KA_ID,
  assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
  contentScopeVersion: '2',
  kaUal: `did:dkg:otp:20430/${AUTHOR}/7`,
  assertionVersion: '2',
  publicTripleCount: '2',
  privateTripleCount: '0',
  privateMerkleRoot: null,
});
const PROJECTION_DIGEST = computeKaProjectionDigestV1(PROJECTION_BYTES);
const ROW = validRow({
  kaId: KA_ID,
  assertionCoordinate: 'name λ',
  assertionVersion: '2',
  projectionId: 'cg-shared-v1',
  projectionDigest: PROJECTION_DIGEST,
  sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(SEAL),
  transfer: {
    codec: 'dkg-ka-bundle-v1',
    projectionId: 'cg-shared-v1',
    projectionDigest: PROJECTION_DIGEST,
    byteLength: '4096',
    chunkSize: '262144',
    chunkCount: '1',
    blobDigest: `0x${'11'.repeat(32)}`,
    chunkTreeRoot: `0x${'22'.repeat(32)}`,
  },
});
const REQUEST = Object.freeze({
  sealBinding: verifyCatalogSealBindingV1(
    SCOPE,
    ROW,
    canonicalizeCanonicalGraphScopedAuthorSealBytesV1(SEAL),
    PROFILE,
  ),
});
const OPERATION = compileRfc64SharedProjectionStreamOperationV1(REQUEST);
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

  it('uses the frozen exact CONSTRUCT and exposes a sorted bounded quad stream', async () => {
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
      managedOxigraph: true,
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
      managedOxigraph: true,
    });

    const source = await store.rfc64SharedProjectionStreamV1!(OPERATION, {
      byteCeiling: 4096,
    });

    expect(await collect(source)).toEqual([
      quad('urn:a', '"alpha"'),
      quad('urn:z', '"zeta"'),
    ]);
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
      managedOxigraph: true,
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
      managedOxigraph: true,
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

  it('preserves typed HTTP refusal evidence without parsing an unbounded error body', async () => {
    globalThis.fetch = (async () => new Response('managed endpoint refused the query', {
      status: 503,
    })) as typeof fetch;
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
      responseExcerpt: 'managed endpoint refused the query',
    });
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

function quad(subject: string, object: string): Quad {
  return Object.freeze({ subject, predicate: 'urn:p', object, graph: GRAPH });
}

async function collect(source: AsyncIterable<Quad>): Promise<Quad[]> {
  const quads: Quad[] = [];
  for await (const value of source) quads.push(value);
  return quads;
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

function validScope(value: unknown): AuthorCatalogScopeV1 {
  assertAuthorCatalogScopeV1(value);
  return value;
}

function validRow(value: unknown): AuthorCatalogRowV1 {
  assertAuthorCatalogRowV1(value);
  return value;
}

function validSeal(value: unknown): CanonicalGraphScopedAuthorSealV1 {
  assertCanonicalGraphScopedAuthorSealV1(value);
  return value;
}
