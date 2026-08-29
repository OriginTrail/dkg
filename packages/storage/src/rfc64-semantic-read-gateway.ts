import {
  compileRfc64SemanticReadOperationV1,
  decodeRfc64SemanticRecordStoreRowsV1,
  snapshotExactDataRecord,
  type DecodedRfc64SemanticRecordV1,
  type Rfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticStoreRowV1,
} from '@origintrail-official/dkg-core';

import { composeAbortSignals } from './abortable-store-work-lifecycle.js';
import {
  findTripleStoreCapability,
  type TripleStore,
} from './triple-store.js';
import {
  Rfc64SemanticReadCapabilityResultErrorV1,
  isRfc64SemanticReadCapabilityV1,
  type Rfc64SemanticReadCapabilityV1,
} from './rfc64-semantic-read-capability.js';

export const MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1 = 30_000;

export interface Rfc64SemanticReadRequestV1 {
  readonly coordinate: Rfc64SemanticRecordCoordinateV1;
}

export interface Rfc64SemanticReadOptionsV1 {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type Rfc64SemanticReadResultV1 =
  | {
      readonly kind: 'absent';
    }
  | {
      readonly kind: 'record';
      readonly decoded: DecodedRfc64SemanticRecordV1;
    };

export type Rfc64SemanticReadGatewayErrorCodeV1 =
  | 'rfc64-semantic-read-capability'
  | 'rfc64-semantic-read-request'
  | 'rfc64-semantic-read-options'
  | 'rfc64-semantic-read-result';

export class Rfc64SemanticReadGatewayErrorV1 extends Error {
  constructor(
    readonly code: Rfc64SemanticReadGatewayErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64SemanticReadGatewayErrorV1';
  }
}

/**
 * Narrow RFC-64 semantic read boundary. Consumers receive this gateway rather
 * than a generic SPARQL client; every dispatched query is recompiled from the
 * closed manifest immediately before execution.
 */
export class SyncSemanticStoreV1 {
  private readonly capability: Rfc64SemanticReadCapabilityV1;

  constructor(store: TripleStore) {
    const capability = findTripleStoreCapability(
      store,
      isRfc64SemanticReadCapabilityV1,
    );
    if (!capability) {
      fail(
        'rfc64-semantic-read-capability',
        'triple store has no certified RFC-64 semantic read capability',
      );
    }
    this.capability = capability;
  }

  async read(
    input: unknown,
    options: Rfc64SemanticReadOptionsV1,
  ): Promise<Rfc64SemanticReadResultV1> {
    const request = snapshotRequest(input);
    const readOptions = snapshotOptions(options);
    const operation = compileRfc64SemanticReadOperationV1({
      coordinate: request.coordinate,
    });

    const deadlineAt = performance.now() + readOptions.timeoutMs;
    const deadlineSignal = AbortSignal.timeout(readOptions.timeoutMs);
    const signalScope = composeAbortSignals(readOptions.signal, deadlineSignal);
    try {
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      let rows: readonly Rfc64SemanticStoreRowV1[];
      try {
        rows = await this.capability.rfc64SemanticReadV1(operation, {
          signal: signalScope.signal,
        });
      } catch (cause) {
        assertBeforeDeadline(signalScope.signal, deadlineAt);
        if (cause instanceof Rfc64SemanticReadCapabilityResultErrorV1) {
          fail('rfc64-semantic-read-result', cause.message, cause);
        }
        throw cause;
      }
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      if (rows.length === 0) {
        assertBeforeDeadline(signalScope.signal, deadlineAt);
        return Object.freeze({ kind: 'absent' });
      }
      let decoded: DecodedRfc64SemanticRecordV1;
      try {
        decoded = decodeRfc64SemanticRecordStoreRowsV1(rows, operation.coordinate);
      } catch (cause) {
        assertBeforeDeadline(signalScope.signal, deadlineAt);
        throw cause;
      }
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      return Object.freeze({
        kind: 'record',
        decoded,
      });
    } finally {
      signalScope.dispose();
    }
  }
}

function snapshotRequest(input: unknown): Rfc64SemanticReadRequestV1 {
  const request = snapshotExactRecord(
    input,
    ['coordinate'],
    'RFC-64 semantic read request',
    'rfc64-semantic-read-request',
  );
  return Object.freeze({
    coordinate: request.coordinate as Rfc64SemanticRecordCoordinateV1,
  });
}

function snapshotOptions(input: unknown): Rfc64SemanticReadOptionsV1 {
  const options = snapshotExactRecord(
    input,
    isRecordWithOwnKey(input, 'signal') ? ['signal', 'timeoutMs'] : ['timeoutMs'],
    'RFC-64 semantic read options',
    'rfc64-semantic-read-options',
  );
  if (
    typeof options.timeoutMs !== 'number'
    || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1
  ) {
    fail(
      'rfc64-semantic-read-options',
      `timeoutMs must be an integer from 1 to ${MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1}`,
    );
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    fail('rfc64-semantic-read-options', 'signal must be an AbortSignal');
  }
  return Object.freeze({
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }) as Rfc64SemanticReadOptionsV1;
}

function snapshotExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
  code: Rfc64SemanticReadGatewayErrorCodeV1,
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

function assertBeforeDeadline(
  signal: AbortSignal | undefined,
  deadlineAt: number,
): void {
  signal?.throwIfAborted();
  if (performance.now() >= deadlineAt) {
    throw new DOMException('RFC-64 semantic read deadline exceeded', 'TimeoutError');
  }
}

function fail(
  code: Rfc64SemanticReadGatewayErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64SemanticReadGatewayErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
