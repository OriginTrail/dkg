import { describe, expect, it, vi } from 'vitest';

import {
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  compileRfc64SharedProjectionStreamOperationV1,
  CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1,
  CG_SHARED_PRIVATE_HASH_PREDICATE_V1,
  tripleContentV10,
  verifyCatalogSealBindingV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';

import {
  Rfc64SharedProjectionStreamGatewayErrorV1,
  SyncSharedProjectionStoreV1,
} from '../src/rfc64-shared-projection-stream-gateway.js';
import type { Quad, TripleStore } from '../src/triple-store.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const KAV10 = '0x4444444444444444444444444444444444444444';
const KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
const GRAPH = `did:dkg:context-graph:a/b/_shared_memory/${AUTHOR}/7`;
const QUADS: readonly Quad[] = Object.freeze([
  Object.freeze({ subject: 'urn:a', predicate: 'urn:p', object: '"alpha"', graph: GRAPH }),
  Object.freeze({ subject: 'urn:b', predicate: 'urn:p', object: '"beta"', graph: GRAPH }),
]);
const PROJECTION_BYTES = joinLines(QUADS);
const PROJECTION_DIGEST = computeKaProjectionDigestV1(PROJECTION_BYTES);
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
const SEAL_BINDING = verifyCatalogSealBindingV1(
  SCOPE,
  ROW,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1(SEAL),
  PROFILE,
);
const REQUEST = Object.freeze({
  sealBinding: SEAL_BINDING,
});

describe('SyncSharedProjectionStoreV1', () => {
  it('streams canonical bytes and proves count, order, ceiling, and digest at completion', async () => {
    let captured: Rfc64SharedProjectionStreamOperationV1 | undefined;
    let capturedByteCeiling: number | undefined;
    const gateway = new SyncSharedProjectionStoreV1(fakeStore(async (operation, options) => {
      captured = operation;
      capturedByteCeiling = options.byteCeiling;
      return streamQuads(QUADS);
    }));
    const result = await gateway.open(REQUEST, {
      operatorByteCeiling: 2048,
      timeoutMs: 1000,
    });
    const received = await collect(result.bytes);

    expect(received).toEqual(PROJECTION_BYTES);
    expect(result).toMatchObject({
      projectionDigest: PROJECTION_DIGEST,
      publicTripleCount: '2',
      effectiveByteCeiling: 2048,
    });
    expect(captured).toMatchObject({
      graphIri: GRAPH,
      signedByteCeiling: 4096,
      resultKind: 'quad-stream',
    });
    expect(capturedByteCeiling).toBe(2048);
  });

  it('discovers the callable capability through a documented decorator', async () => {
    const inner = fakeStore(async () => streamQuads(QUADS));
    const outer = { innerStore: inner } as unknown as TripleStore;
    const result = await new SyncSharedProjectionStoreV1(outer).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 1000,
    });
    expect(await collect(result.bytes)).toEqual(PROJECTION_BYTES);
  });

  it('does not acquire an adapter stream until its bytes are consumed', async () => {
    const open = vi.fn(async () => streamQuads(QUADS));
    const result = await new SyncSharedProjectionStoreV1(fakeStore(open)).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 1000,
    });
    expect(open).not.toHaveBeenCalled();
    expect(await collect(result.bytes)).toEqual(PROJECTION_BYTES);
    expect(open).toHaveBeenCalledOnce();
  });

  it('fails closed on another graph, non-canonical order, or digest mismatch', async () => {
    await expectStreamFailure([
      { ...QUADS[0], graph: 'urn:other' },
      QUADS[1],
    ], /outside the authenticated projection graph/);
    await expectStreamFailure([QUADS[1], QUADS[0]], /canonical byte order/);
    await expectStreamFailure([
      QUADS[0],
      { ...QUADS[1], object: '"changed"' },
    ], /digest differs/);
  });

  it('enforces the local byte ceiling while consuming instead of buffering', async () => {
    const gateway = new SyncSharedProjectionStoreV1(
      fakeStore(async () => streamQuads(QUADS)),
    );
    const result = await gateway.open(REQUEST, {
      operatorByteCeiling: 1,
      timeoutMs: 1000,
    });
    await expect(collect(result.bytes)).rejects.toMatchObject({
      code: 'rfc64-shared-projection-stream-result',
    });
  });

  it('measures canonical output bytes rather than a longer backend lexical form', async () => {
    const canonical = Object.freeze({
      subject: 'urn:a',
      predicate: 'urn:p',
      object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
      graph: GRAPH,
    });
    const backend = Object.freeze({
      ...canonical,
      object: '"00000000000000000001"^^<http://www.w3.org/2001/XMLSchema#integer>',
    });
    const canonicalBytes = joinLines([canonical]);
    const result = await new SyncSharedProjectionStoreV1(
      fakeStore(async () => streamQuads([backend])),
    ).open(requestFor([canonical], '1'), {
      operatorByteCeiling: canonicalBytes.byteLength,
      timeoutMs: 1000,
    });

    expect(await collect(result.bytes)).toEqual(canonicalBytes);
  });

  it('rejects sealed-count underflow and overflow before digest can mask them', async () => {
    await expectStreamFailureForRequest(
      [QUADS[0]],
      requestFor([QUADS[0]], '2'),
      /triple count differs from the author seal/,
    );
    const overflowRequest = requestFor(QUADS, '1');
    expect(compileRfc64SharedProjectionStreamOperationV1(overflowRequest).publicTripleCount)
      .toBe('1');
    await expectStreamFailureForRequest(
      QUADS,
      overflowRequest,
      /exceeded the author-sealed public triple count/,
    );
  });

  it.each([
    CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1,
    CG_SHARED_PRIVATE_HASH_PREDICATE_V1,
  ])('rejects %s outside the derived commitment subject', async (predicate) => {
    const misplaced = Object.freeze({
      subject: 'urn:not-the-derived-commitment-subject',
      predicate,
      object: predicate === CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1
        ? '"true"'
        : `"${'aa'.repeat(32)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`,
      graph: GRAPH,
    });
    await expectStreamFailureForRequest(
      [misplaced],
      requestFor([misplaced], '1'),
      /private commitment predicate is outside the derived KA commitment subject/,
    );
  });

  it('keeps one deadline authoritative through lazy stream consumption', async () => {
    const gateway = new SyncSharedProjectionStoreV1(fakeStore(async () => (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield* QUADS;
    })()));
    const result = await gateway.open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5,
    });
    await expect(collect(result.bytes)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('aborts a pending adapter open at the caller-supplied deadline', async () => {
    let observedSignal: AbortSignal | undefined;
    const gateway = new SyncSharedProjectionStoreV1(fakeStore((_operation, options) => {
      observedSignal = options?.signal;
      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    }));
    const result = await gateway.open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 10,
    });
    await expect(collect(result.bytes)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('enforces the deadline when adapter acquisition ignores cancellation', async () => {
    const gateway = new SyncSharedProjectionStoreV1(fakeStore(
      () => new Promise<AsyncIterable<Quad>>(() => undefined),
    ));
    const result = await gateway.open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5,
    });

    await expect(collect(result.bytes)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('enforces the deadline on a non-cooperative iterator read and closes it', async () => {
    let returned = false;
    const source: AsyncIterable<Quad> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Quad>>(() => undefined),
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const result = await new SyncSharedProjectionStoreV1(
      fakeStore(async () => source),
    ).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5,
    });

    await expect(collect(result.bytes)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(returned).toBe(true);
  });

  it('forwards an independent caller cancellation during a pending adapter open', async () => {
    let observedSignal: AbortSignal | undefined;
    const started = Promise.withResolvers<void>();
    const gateway = new SyncSharedProjectionStoreV1(fakeStore((_operation, options) => {
      observedSignal = options.signal;
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    }));
    const controller = new AbortController();
    const result = await gateway.open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const pending = collect(result.bytes);
    await started.promise;
    controller.abort(new DOMException('caller cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toMatchObject({ name: 'AbortError' });
  });

  it('closes the backend iterator when a consumer stops before completeness', async () => {
    let sourceClosed = false;
    const source = async function* () {
      try {
        yield* QUADS;
      } finally {
        sourceClosed = true;
      }
    };
    const result = await new SyncSharedProjectionStoreV1(
      fakeStore(async () => source()),
    ).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 1000,
    });
    const iterator = result.bytes[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await iterator.return?.();
    expect(sourceClosed).toBe(true);
  });

  it('refuses stores without an explicit certified stream capability', () => {
    expect(() => new SyncSharedProjectionStoreV1({} as TripleStore))
      .toThrow(/no certified RFC-64 shared-projection stream capability/);
  });
});

async function expectStreamFailure(quads: readonly Quad[], message: RegExp): Promise<void> {
  return expectStreamFailureForRequest(quads, REQUEST, message);
}

async function expectStreamFailureForRequest(
  quads: readonly Quad[],
  request: typeof REQUEST,
  message: RegExp,
): Promise<void> {
  const gateway = new SyncSharedProjectionStoreV1(
    fakeStore(async () => streamQuads(quads)),
  );
  const result = await gateway.open(request, {
    operatorByteCeiling: 4096,
    timeoutMs: 1000,
  });
  try {
    await collect(result.bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(Rfc64SharedProjectionStreamGatewayErrorV1);
    expect(error).toHaveProperty('code', 'rfc64-shared-projection-stream-result');
    expect(error).toHaveProperty('message', expect.stringMatching(message));
    return;
  }
  throw new Error(`expected stream failure ${message}`);
}

function requestFor(quads: readonly Quad[], publicTripleCount: string): typeof REQUEST {
  const projectionDigest = computeKaProjectionDigestV1(joinLines(quads));
  const seal = validSeal({ ...SEAL, publicTripleCount });
  const row = validRow({
    ...ROW,
    projectionDigest,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    transfer: {
      ...ROW.transfer,
      projectionDigest,
    },
  });
  return Object.freeze({
    sealBinding: verifyCatalogSealBindingV1(
      SCOPE,
      row,
      canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal),
      PROFILE,
    ),
  });
}

function fakeStore(
  open: (
    operation: Rfc64SharedProjectionStreamOperationV1,
    options: { readonly byteCeiling: number; readonly signal?: AbortSignal },
  ) => Promise<AsyncIterable<Quad>>,
): TripleStore {
  return { rfc64SharedProjectionStreamV1: open } as unknown as TripleStore;
}

async function* streamQuads(quads: readonly Quad[]): AsyncGenerator<Quad> {
  for (const quad of quads) yield { ...quad };
}

function joinLines(quads: readonly Quad[]): Uint8Array {
  const lines = quads.map((quad) => {
    const content = tripleContentV10(quad.subject, quad.predicate, quad.object);
    const line = new Uint8Array(content.byteLength + 1);
    line.set(content);
    line[line.byteLength - 1] = 0x0a;
    return line;
  });
  const bytes = new Uint8Array(lines.reduce((sum, line) => sum + line.byteLength, 0));
  let offset = 0;
  for (const line of lines) {
    bytes.set(line, offset);
    offset += line.byteLength;
  }
  return bytes;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
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
