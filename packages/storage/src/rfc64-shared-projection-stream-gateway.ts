import {
  CgSharedProjectionError,
  RFC64_SHARED_PROJECTION_STREAM_PROTOCOL_BYTES_V1,
  compileRfc64SharedProjectionStreamOperationV1,
  createCgSharedProjectionStreamVerifierV1,
  type Digest32V1,
  type Rfc64SharedProjectionStreamOperationV1,
  type Rfc64SharedProjectionStreamTemplateInputV1,
} from '@origintrail-official/dkg-core';

import { openLazyAbortableStream } from './abortable-stream-work-lifecycle.js';
import { snapshotExactOrdinaryDataRecord } from './closed-data-snapshot.js';
import {
  isRfc64SharedProjectionStreamCapabilityV1,
  type Rfc64SharedProjectionStreamCapabilityV1,
} from './rfc64-shared-projection-stream-capability.js';
import {
  findTripleStoreCapability,
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
    const source = openLazyAbortableStream<Uint8Array>({
      deadlineAt,
      signal: callerSignal,
      timeoutMessage: 'RFC-64 shared-projection stream deadline exceeded',
      open: (signal) => this.capability.rfc64SharedProjectionStreamV1(operation, {
        byteCeiling: effectiveByteCeiling,
        signal,
      }),
      invalidSource: () => {
        fail(
          'rfc64-shared-projection-stream-result',
          'adapter did not return an async iterable projection stream',
        );
      },
    });
    yield* this.validateStream(
      source,
      operation.commitmentSubject,
      operation.publicTripleCount,
      operation.projectionDigest,
      effectiveByteCeiling,
    );
  }

  private async *validateStream(
    source: AsyncIterable<Uint8Array>,
    commitmentSubject: string,
    expectedTripleCount: Rfc64SharedProjectionStreamOperationV1['publicTripleCount'],
    expectedDigest: Digest32V1,
    byteCeiling: number,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const verifier = createCgSharedProjectionStreamVerifierV1({
      commitmentSubject,
      expectedPublicTripleCount: expectedTripleCount,
      expectedProjectionDigest: expectedDigest,
      byteCeiling,
    });
    for await (const value of source) {
      let line: Uint8Array;
      try {
        line = verifier.pushCanonicalLine(value);
      } catch (cause) {
        fail(
          'rfc64-shared-projection-stream-result',
          projectionFailureMessage(cause),
          cause,
        );
      }
      yield line;
    }
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

function snapshotOptions(input: unknown): Rfc64SharedProjectionStreamOptionsV1 {
  const expectedKeys = hasOwnKey(input, 'signal')
    ? ['operatorByteCeiling', 'signal', 'timeoutMs']
    : ['operatorByteCeiling', 'timeoutMs'];
  let options: Readonly<Record<string, unknown>>;
  try {
    options = snapshotExactOrdinaryDataRecord(
      input,
      expectedKeys,
      'RFC-64 shared-projection stream options',
      (message) => { throw new Error(message); },
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
      case 'projection-public-count-overflow':
        return 'adapter exceeded the author-sealed public triple count';
      case 'projection-public-count-mismatch':
        return 'projection stream triple count differs from the author seal';
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
