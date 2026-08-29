import { describe, expect, it, vi } from 'vitest';

import {
  CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1,
  CG_SHARED_PRIVATE_HASH_PREDICATE_V1,
  tripleContentV10,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';

import {
  Rfc64SharedProjectionStreamGatewayErrorV1,
  SyncSharedProjectionStoreV1,
} from '../src/rfc64-shared-projection-stream-gateway.js';
import type {
  Rfc64CanonicalProjectionLineV1,
} from '../src/rfc64-shared-projection-stream-capability.js';
import type { TripleStore } from '../src/triple-store.js';
import {
  createRfc64SharedProjectionTestFixture,
  type Rfc64ProjectionTestTriple,
} from './helpers/rfc64-shared-projection-fixture.js';

const TRIPLES: readonly Rfc64ProjectionTestTriple[] = Object.freeze([
  Object.freeze({ subject: 'urn:a', predicate: 'urn:p', object: '"alpha"' }),
  Object.freeze({ subject: 'urn:b', predicate: 'urn:p', object: '"beta"' }),
]);
const FIXTURE = createRfc64SharedProjectionTestFixture({ triples: TRIPLES });
const PROJECTION_BYTES = FIXTURE.projectionBytes;
const PROJECTION_DIGEST = FIXTURE.projectionDigest;
const REQUEST = FIXTURE.request;

describe('SyncSharedProjectionStoreV1', () => {
  it('streams canonical bytes and proves count, order, ceiling, and digest at completion', async () => {
    let captured: Rfc64SharedProjectionStreamOperationV1 | undefined;
    let capturedByteCeiling: number | undefined;
    const gateway = new SyncSharedProjectionStoreV1(fakeStore(async (operation, options) => {
      captured = operation;
      capturedByteCeiling = options.byteCeiling;
      return streamLines(TRIPLES);
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
      graphIri: FIXTURE.graph,
      signedByteCeiling: 4096,
      resultKind: 'quad-stream',
    });
    expect(capturedByteCeiling).toBe(2048);
  });

  it('rejects a capability line that is not one canonical LF-terminated record', async () => {
    const malformed = new TextEncoder().encode(
      '<urn:a> <urn:p> "alpha" .\r\n',
    ) as Rfc64CanonicalProjectionLineV1;
    const result = await new SyncSharedProjectionStoreV1(
      fakeStore(async () => streamCanonicalLines([malformed])),
    ).open(REQUEST, { operatorByteCeiling: 4096, timeoutMs: 1000 });

    await expect(collect(result.bytes)).rejects.toMatchObject({
      code: 'rfc64-shared-projection-stream-result',
    });
  });

  it('discovers the callable capability through a documented decorator', async () => {
    const inner = fakeStore(async () => streamLines(TRIPLES));
    const outer = { innerStore: inner } as unknown as TripleStore;
    const result = await new SyncSharedProjectionStoreV1(outer).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 1000,
    });
    expect(await collect(result.bytes)).toEqual(PROJECTION_BYTES);
  });

  it('does not acquire an adapter stream until its bytes are consumed', async () => {
    const open = vi.fn(async () => streamLines(TRIPLES));
    const result = await new SyncSharedProjectionStoreV1(fakeStore(open)).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 1000,
    });
    expect(open).not.toHaveBeenCalled();
    expect(await collect(result.bytes)).toEqual(PROJECTION_BYTES);
    expect(open).toHaveBeenCalledOnce();
  });

  it('fails closed on non-canonical order or digest mismatch', async () => {
    await expectStreamFailure([TRIPLES[1], TRIPLES[0]], /canonical byte order/);
    await expectStreamFailure([
      TRIPLES[0],
      { ...TRIPLES[1], object: '"changed"' },
    ], /digest differs/);
  });

  it('enforces the local byte ceiling while consuming instead of buffering', async () => {
    const gateway = new SyncSharedProjectionStoreV1(
      fakeStore(async () => streamLines(TRIPLES)),
    );
    const result = await gateway.open(REQUEST, {
      operatorByteCeiling: 1,
      timeoutMs: 1000,
    });
    await expect(collect(result.bytes)).rejects.toMatchObject({
      code: 'rfc64-shared-projection-stream-result',
    });
  });

  it('rejects sealed-count underflow and overflow before digest can mask them', async () => {
    await expectStreamFailureForRequest(
      [TRIPLES[0]],
      requestFor([TRIPLES[0]], '2'),
      /triple count differs from the author seal/,
    );
    const overflowRequest = requestFor(TRIPLES, '1');
    expect(createRfc64SharedProjectionTestFixture({
      triples: TRIPLES,
      publicTripleCount: '1',
    }).operation.publicTripleCount)
      .toBe('1');
    await expectStreamFailureForRequest(
      TRIPLES,
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
      yield* linesFor(TRIPLES);
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
      timeoutMs: 100,
    });
    await expect(collect(result.bytes)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('enforces the deadline when adapter acquisition ignores cancellation', async () => {
    const gateway = new SyncSharedProjectionStoreV1(fakeStore(
      () => new Promise<AsyncIterable<Rfc64CanonicalProjectionLineV1>>(() => undefined),
    ));
    const result = await gateway.open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5,
    });

    await expect(collect(result.bytes)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('closes an adapter stream that arrives after its acquisition deadline', async () => {
    const pending = Promise.withResolvers<AsyncIterable<Rfc64CanonicalProjectionLineV1>>();
    let closed = false;
    const lateSource: AsyncIterable<Rfc64CanonicalProjectionLineV1> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: true, value: undefined };
          },
          async return() {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const result = await new SyncSharedProjectionStoreV1(
      fakeStore(() => pending.promise),
    ).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5,
    });

    await expect(collect(result.bytes)).rejects.toMatchObject({ name: 'TimeoutError' });
    pending.resolve(lateSource);
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('enforces the deadline on a non-cooperative iterator read and closes it', async () => {
    let returned = false;
    const source: AsyncIterable<Rfc64CanonicalProjectionLineV1> = {
      [Symbol.asyncIterator]() {
        return {
      next: () => new Promise<IteratorResult<Rfc64CanonicalProjectionLineV1>>(() => undefined),
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
        yield* linesFor(TRIPLES);
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

async function expectStreamFailure(
  triples: readonly Rfc64ProjectionTestTriple[],
  message: RegExp,
): Promise<void> {
  return expectStreamFailureForRequest(triples, REQUEST, message);
}

async function expectStreamFailureForRequest(
  triples: readonly Rfc64ProjectionTestTriple[],
  request: typeof REQUEST,
  message: RegExp,
): Promise<void> {
  const gateway = new SyncSharedProjectionStoreV1(
    fakeStore(async () => streamLines(triples)),
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

function requestFor(
  triples: readonly Rfc64ProjectionTestTriple[],
  publicTripleCount: string,
): typeof REQUEST {
  return createRfc64SharedProjectionTestFixture({ triples, publicTripleCount }).request;
}

function fakeStore(
  open: (
    operation: Rfc64SharedProjectionStreamOperationV1,
    options: { readonly byteCeiling: number; readonly signal?: AbortSignal },
  ) => Promise<AsyncIterable<Rfc64CanonicalProjectionLineV1>>,
): TripleStore {
  return { rfc64SharedProjectionStreamV1: open } as unknown as TripleStore;
}

async function* streamLines(
  triples: readonly Rfc64ProjectionTestTriple[],
): AsyncGenerator<Rfc64CanonicalProjectionLineV1> {
  yield* linesFor(triples);
}

async function* streamCanonicalLines(
  lines: readonly Rfc64CanonicalProjectionLineV1[],
): AsyncGenerator<Rfc64CanonicalProjectionLineV1> {
  for (const line of lines) yield line;
}

function linesFor(
  triples: readonly Rfc64ProjectionTestTriple[],
): Rfc64CanonicalProjectionLineV1[] {
  return triples.map((triple) => {
    const content = tripleContentV10(triple.subject, triple.predicate, triple.object);
    const line = new Uint8Array(content.byteLength + 1);
    line.set(content);
    line[line.byteLength - 1] = 0x0a;
    return line as Rfc64CanonicalProjectionLineV1;
  });
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
