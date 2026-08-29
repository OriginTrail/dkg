import {
  compileRfc64AuthorSealReadOperationV1,
  decodeCanonicalGraphScopedAuthorSealRowsV1,
  snapshotExactDataRecord,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
  type DecodedCanonicalGraphScopedAuthorSealRowsV1,
} from '@origintrail-official/dkg-core';

import { composeAbortSignals } from './abortable-store-work-lifecycle.js';
import { findTripleStoreCapability, type TripleStore } from './triple-store.js';
import {
  isRfc64AuthorSealReadCapabilityV1,
  type Rfc64AuthorSealReadCapabilityV1,
} from './rfc64-author-seal-read-capability.js';
import { Rfc64SemanticReadCapabilityResultErrorV1 } from
  './rfc64-semantic-read-capability.js';

export const MAX_RFC64_AUTHOR_SEAL_READ_TIMEOUT_MS_V1 = 30_000;

export interface Rfc64AuthorSealReadRequestV1 {
  readonly coordinate: CanonicalGraphScopedAuthorSealCoordinateV1;
}

export interface Rfc64AuthorSealReadOptionsV1 {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type Rfc64AuthorSealReadResultV1 =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'seal';
      readonly decoded: DecodedCanonicalGraphScopedAuthorSealRowsV1;
    };

export type Rfc64AuthorSealReadGatewayErrorCodeV1 =
  | 'rfc64-author-seal-read-capability'
  | 'rfc64-author-seal-read-request'
  | 'rfc64-author-seal-read-options'
  | 'rfc64-author-seal-read-result';

export class Rfc64AuthorSealReadGatewayErrorV1 extends Error {
  constructor(
    readonly code: Rfc64AuthorSealReadGatewayErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64AuthorSealReadGatewayErrorV1';
  }
}

/** Narrow post-commit author-seal read; callers never receive raw SPARQL. */
export class SyncAuthorSealStoreV1 {
  private readonly capability: Rfc64AuthorSealReadCapabilityV1;

  constructor(store: TripleStore) {
    const capability = findTripleStoreCapability(store, isRfc64AuthorSealReadCapabilityV1);
    if (!capability) {
      fail(
        'rfc64-author-seal-read-capability',
        'triple store has no certified RFC-64 author-seal read capability',
      );
    }
    this.capability = capability;
  }

  async read(
    input: unknown,
    options: Rfc64AuthorSealReadOptionsV1,
  ): Promise<Rfc64AuthorSealReadResultV1> {
    const request = snapshotRequest(input);
    const readOptions = snapshotOptions(options);
    const operation = compileRfc64AuthorSealReadOperationV1(request);
    const deadlineAt = performance.now() + readOptions.timeoutMs;
    const deadlineSignal = AbortSignal.timeout(readOptions.timeoutMs);
    const signalScope = composeAbortSignals(readOptions.signal, deadlineSignal);
    try {
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      let rows;
      try {
        rows = await this.capability.rfc64AuthorSealReadV1(operation, {
          signal: signalScope.signal,
        });
      } catch (cause) {
        assertBeforeDeadline(signalScope.signal, deadlineAt);
        if (cause instanceof Rfc64SemanticReadCapabilityResultErrorV1) {
          fail('rfc64-author-seal-read-result', cause.message, cause);
        }
        throw cause;
      }
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      if (rows.length === 0) return Object.freeze({ kind: 'absent' });
      let decoded: DecodedCanonicalGraphScopedAuthorSealRowsV1;
      try {
        decoded = decodeCanonicalGraphScopedAuthorSealRowsV1(rows, operation.coordinate);
      } catch (cause) {
        assertBeforeDeadline(signalScope.signal, deadlineAt);
        throw cause;
      }
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      return Object.freeze({ kind: 'seal', decoded });
    } finally {
      signalScope.dispose();
    }
  }
}

function snapshotRequest(input: unknown): Rfc64AuthorSealReadRequestV1 {
  const request = snapshotExactRecord(
    input,
    ['coordinate'],
    'RFC-64 author-seal read request',
    'rfc64-author-seal-read-request',
  );
  return Object.freeze({
    coordinate: request.coordinate as CanonicalGraphScopedAuthorSealCoordinateV1,
  });
}

function snapshotOptions(input: unknown): Rfc64AuthorSealReadOptionsV1 {
  const options = snapshotExactRecord(
    input,
    isRecordWithOwnKey(input, 'signal') ? ['signal', 'timeoutMs'] : ['timeoutMs'],
    'RFC-64 author-seal read options',
    'rfc64-author-seal-read-options',
  );
  if (
    typeof options.timeoutMs !== 'number'
    || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > MAX_RFC64_AUTHOR_SEAL_READ_TIMEOUT_MS_V1
  ) {
    fail(
      'rfc64-author-seal-read-options',
      `timeoutMs must be an integer from 1 to ${MAX_RFC64_AUTHOR_SEAL_READ_TIMEOUT_MS_V1}`,
    );
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    fail('rfc64-author-seal-read-options', 'signal must be an AbortSignal');
  }
  return Object.freeze({
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }) as Rfc64AuthorSealReadOptionsV1;
}

function snapshotExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
  code: Rfc64AuthorSealReadGatewayErrorCodeV1,
): Readonly<Record<string, unknown>> {
  try {
    return snapshotExactDataRecord(input, expectedKeys, label);
  } catch (cause) {
    fail(code, `${label} has an invalid field set`, cause);
  }
}

function isRecordWithOwnKey(input: unknown, key: string): boolean {
  return input !== null
    && typeof input === 'object'
    && Object.prototype.hasOwnProperty.call(input, key);
}

function assertBeforeDeadline(signal: AbortSignal | undefined, deadlineAt: number): void {
  signal?.throwIfAborted();
  if (performance.now() >= deadlineAt) {
    throw new DOMException('RFC-64 author-seal read deadline exceeded', 'TimeoutError');
  }
}

function fail(
  code: Rfc64AuthorSealReadGatewayErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64AuthorSealReadGatewayErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
