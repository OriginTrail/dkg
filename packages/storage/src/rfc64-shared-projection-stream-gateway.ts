import {
  CgSharedProjectionError,
  RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
  compileRfc64SharedProjectionStreamOperationV1,
  createCgSharedProjectionStreamVerifierV1,
  snapshotExactDataRecord,
  type Digest32V1,
  type Rfc64SharedProjectionStreamOperationV1,
  type Rfc64SharedProjectionStreamTemplateInputV1,
} from '@origintrail-official/dkg-core';

import { composeAbortSignals } from './abortable-store-work-lifecycle.js';
import {
  isRfc64SharedProjectionStreamCapabilityV1,
  type Rfc64SharedProjectionStreamCapabilityV1,
} from './rfc64-shared-projection-stream-capability.js';
import {
  findTripleStoreCapability,
  type Quad,
  type TripleStore,
} from './triple-store.js';

export const MAX_RFC64_SHARED_PROJECTION_STREAM_TIMEOUT_MS_V1 = 600_000;

export interface Rfc64SharedProjectionStreamOptionsV1 {
  readonly operatorByteCeiling: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface Rfc64SharedProjectionStreamResultV1 {
  readonly projectionDigest: Digest32V1;
  readonly publicTripleCount: Rfc64SharedProjectionStreamOperationV1['publicTripleCount'];
  readonly effectiveByteCeiling: number;
  /**
   * Canonical graphless cg-shared-v1 lines. Each chunk owns its bytes and ends
   * in one LF. Completion means count, byte ceiling, order, and digest matched.
   */
  readonly bytes: AsyncIterable<Uint8Array>;
}

export type Rfc64SharedProjectionStreamGatewayErrorCodeV1 =
  | 'rfc64-shared-projection-stream-capability'
  | 'rfc64-shared-projection-stream-options'
  | 'rfc64-shared-projection-stream-result';

export class Rfc64SharedProjectionStreamGatewayErrorV1 extends Error {
  constructor(
    readonly code: Rfc64SharedProjectionStreamGatewayErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64SharedProjectionStreamGatewayErrorV1';
  }
}

/** Narrow authenticated gateway for one exact shared-projection byte stream. */
export class SyncSharedProjectionStoreV1 {
  private readonly capability: Rfc64SharedProjectionStreamCapabilityV1;

  constructor(store: TripleStore) {
    const capability = findTripleStoreCapability(
      store,
      isRfc64SharedProjectionStreamCapabilityV1,
    );
    if (!capability) {
      fail(
        'rfc64-shared-projection-stream-capability',
        'triple store has no certified RFC-64 shared-projection stream capability',
      );
    }
    this.capability = capability;
  }

  async open(
    input: Rfc64SharedProjectionStreamTemplateInputV1,
    options: Rfc64SharedProjectionStreamOptionsV1,
  ): Promise<Rfc64SharedProjectionStreamResultV1> {
    const readOptions = snapshotOptions(options);
    const operation = compileRfc64SharedProjectionStreamOperationV1(input);
    const effectiveByteCeiling = Math.min(
      operation.signedByteCeiling,
      operation.protocolByteCeiling,
      readOptions.operatorByteCeiling,
    );
    const deadlineAt = performance.now() + readOptions.timeoutMs;
    const bytes = this.openValidatedStream(
      operation,
      effectiveByteCeiling,
      readOptions.signal,
      deadlineAt,
    );
    return Object.freeze({
      projectionDigest: operation.projectionDigest,
      publicTripleCount: operation.publicTripleCount,
      effectiveByteCeiling,
      bytes,
    });
  }

  /**
   * Defer adapter dispatch until the caller actually consumes the byte stream.
   * A caller that only inspects metadata therefore owns no backend iterator,
   * abort listener, or deadline timer that it could forget to release.
   */
  private async *openValidatedStream(
    operation: ReturnType<typeof compileRfc64SharedProjectionStreamOperationV1>,
    effectiveByteCeiling: number,
    callerSignal: AbortSignal | undefined,
    deadlineAt: number,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) {
      throw new DOMException(
        'RFC-64 shared-projection stream deadline exceeded',
        'TimeoutError',
      );
    }
    const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)));
    const signalScope = composeAbortSignals(callerSignal, deadlineSignal);
    try {
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      let source: AsyncIterable<Quad>;
      try {
        const pendingSource = this.capability.rfc64SharedProjectionStreamV1(operation, {
          byteCeiling: effectiveByteCeiling,
          signal: signalScope.signal,
        });
        source = await raceAgainstAbort(pendingSource, signalScope.signal, async (lateSource) => {
          if (isAsyncIterable(lateSource)) await closeAsyncIterable(lateSource);
        });
      } catch (cause) {
        assertBeforeDeadline(signalScope.signal, deadlineAt);
        throw cause;
      }
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      if (!isAsyncIterable(source)) {
        fail(
          'rfc64-shared-projection-stream-result',
          'adapter did not return an async iterable projection stream',
        );
      }
      try {
        yield* this.validateStream(
          source,
          operation.graphIri,
          operation.commitmentSubject,
          operation.publicTripleCount,
          operation.projectionDigest,
          effectiveByteCeiling,
          signalScope.signal,
          deadlineAt,
        );
      } catch (cause) {
        assertBeforeDeadline(signalScope.signal, deadlineAt);
        throw cause;
      }
    } finally {
      signalScope.dispose();
    }
  }

  private async *validateStream(
    source: AsyncIterable<Quad>,
    graphIri: string,
    commitmentSubject: string,
    expectedTripleCount: Rfc64SharedProjectionStreamOperationV1['publicTripleCount'],
    expectedDigest: Digest32V1,
    byteCeiling: number,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const verifier = createCgSharedProjectionStreamVerifierV1({
      commitmentSubject,
      expectedPublicTripleCount: expectedTripleCount,
      expectedProjectionDigest: expectedDigest,
      byteCeiling,
    });
    const iterator = source[Symbol.asyncIterator]();
    let complete = false;
    try {
      while (true) {
        assertBeforeDeadline(signal, deadlineAt);
        const next = await raceAgainstAbort(Promise.resolve(iterator.next()), signal);
        if (next.done) {
          complete = true;
          break;
        }
        const quad = snapshotQuad(next.value);
        if (quad.graph !== graphIri) {
          fail(
            'rfc64-shared-projection-stream-result',
            'adapter returned a quad outside the authenticated projection graph',
          );
        }
        let line: Uint8Array;
        try {
          line = verifier.push(quad);
        } catch (cause) {
          fail(
            'rfc64-shared-projection-stream-result',
            projectionFailureMessage(cause),
            cause,
          );
        }
        yield line;
        assertBeforeDeadline(signal, deadlineAt);
      }
    } finally {
      if (!complete) {
        await raceAgainstAbort(Promise.resolve(iterator.return?.()), signal).catch(() => undefined);
      }
    }
    assertBeforeDeadline(signal, deadlineAt);
    try {
      verifier.finalize();
    } catch (cause) {
      fail(
        'rfc64-shared-projection-stream-result',
        projectionFailureMessage(cause),
        cause,
      );
    }
  }
}

async function raceAgainstAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onLateResult?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.then(onLateResult).catch(() => undefined);
    signal.throwIfAborted();
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (!aborted && signal.aborted) onAbort();
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (aborted) {
          void Promise.resolve(onLateResult?.(value)).catch(() => undefined);
        } else {
          resolve(value);
        }
      },
      (cause) => {
        signal.removeEventListener('abort', onAbort);
        if (!aborted) reject(cause);
      },
    );
  });
}

async function closeAsyncIterable(source: AsyncIterable<unknown>): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  await iterator.return?.();
}

function snapshotOptions(input: unknown): Rfc64SharedProjectionStreamOptionsV1 {
  const expectedKeys = hasOwnKey(input, 'signal')
    ? ['operatorByteCeiling', 'signal', 'timeoutMs']
    : ['operatorByteCeiling', 'timeoutMs'];
  let options: Readonly<Record<string, unknown>>;
  try {
    options = snapshotExactDataRecord(
      input,
      expectedKeys,
      'RFC-64 shared-projection stream options',
    );
  } catch (cause) {
    fail(
      'rfc64-shared-projection-stream-options',
      'shared-projection stream options have an invalid field set',
      cause,
    );
  }
  if (
    typeof options.operatorByteCeiling !== 'number'
    || !Number.isSafeInteger(options.operatorByteCeiling)
    || options.operatorByteCeiling < 1
    || options.operatorByteCeiling > RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1
  ) {
    fail(
      'rfc64-shared-projection-stream-options',
      `operatorByteCeiling must be an integer from 1 to ${RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1}`,
    );
  }
  if (
    typeof options.timeoutMs !== 'number'
    || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > MAX_RFC64_SHARED_PROJECTION_STREAM_TIMEOUT_MS_V1
  ) {
    fail(
      'rfc64-shared-projection-stream-options',
      `timeoutMs must be an integer from 1 to ${MAX_RFC64_SHARED_PROJECTION_STREAM_TIMEOUT_MS_V1}`,
    );
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    fail('rfc64-shared-projection-stream-options', 'signal must be an AbortSignal');
  }
  return Object.freeze({
    operatorByteCeiling: options.operatorByteCeiling,
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }) as Rfc64SharedProjectionStreamOptionsV1;
}

function snapshotQuad(input: unknown): Readonly<Quad> {
  let quad: Readonly<Record<string, unknown>>;
  try {
    quad = snapshotExactDataRecord(
      input,
      ['graph', 'object', 'predicate', 'subject'],
      'RFC-64 shared-projection stream quad',
    );
  } catch (cause) {
    fail(
      'rfc64-shared-projection-stream-result',
      'adapter returned a malformed projection quad',
      cause,
    );
  }
  if (
    typeof quad.subject !== 'string'
    || typeof quad.predicate !== 'string'
    || typeof quad.object !== 'string'
    || typeof quad.graph !== 'string'
  ) {
    fail(
      'rfc64-shared-projection-stream-result',
      'projection quad terms must be strings',
    );
  }
  return Object.freeze({
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
    graph: quad.graph,
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Quad> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

function hasOwnKey(input: unknown, key: string): boolean {
  return input !== null
    && typeof input === 'object'
    && Object.prototype.hasOwnProperty.call(input, key);
}

function projectionFailureMessage(cause: unknown): string {
  if (cause instanceof CgSharedProjectionError) {
    const error = cause;
    switch (error.code) {
      case 'projection-order':
        return 'adapter projection stream is not in canonical byte order';
      case 'projection-duplicate':
        return 'adapter returned a duplicate projection triple';
      case 'projection-public-count':
        return error.reason === 'public-count-overflow'
          ? 'adapter exceeded the author-sealed public triple count'
          : 'projection stream triple count differs from the author seal';
      case 'projection-digest':
        return 'projection stream digest differs from the catalog row';
      case 'projection-resource-refused':
        return 'adapter exceeded the effective projection byte ceiling';
      case 'projection-private-subject':
        return 'private commitment predicate is outside the derived KA commitment subject';
      default:
        return error.message;
    }
  }
  return 'adapter returned an invalid canonical projection triple';
}

function assertBeforeDeadline(signal: AbortSignal | undefined, deadlineAt: number): void {
  signal?.throwIfAborted();
  if (performance.now() >= deadlineAt) {
    throw new DOMException('RFC-64 shared-projection stream deadline exceeded', 'TimeoutError');
  }
}

function fail(
  code: Rfc64SharedProjectionStreamGatewayErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64SharedProjectionStreamGatewayErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
