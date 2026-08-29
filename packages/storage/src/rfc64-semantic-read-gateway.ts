import {
  compileRfc64SemanticReadOperationV1,
  decodeRfc64SemanticRecordStoreRowsV1,
  snapshotExactDataRecord,
  type DecodedRfc64SemanticRecordV1,
  type Rfc64SemanticRecordCoordinateV1,
} from '@origintrail-official/dkg-core';

import {
  runRfc64ClosedBindingsReadV1,
  snapshotRfc64ClosedBindingsReadOptionsV1,
} from './rfc64-closed-bindings-read-runner.js';
import {
  isRfc64ExactBindingsReadCapabilityV1,
  type Rfc64ExactBindingsReadCapabilityV1,
} from './rfc64-exact-bindings-read-capability.js';
import {
  findTripleStoreCapability,
  type TripleStore,
} from './triple-store.js';

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
  private readonly capability: Rfc64ExactBindingsReadCapabilityV1;

  constructor(store: TripleStore) {
    const capability = findTripleStoreCapability(
      store,
      isRfc64ExactBindingsReadCapabilityV1,
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

    return runRfc64ClosedBindingsReadV1({
      options: readOptions,
      deadlineLabel: 'RFC-64 semantic read',
      dispatch: (signal) => this.capability.rfc64ExactBindingsReadV1(
        operation,
        { signal },
      ),
      decode: (rows) => decodeRfc64SemanticRecordStoreRowsV1(
        rows,
        operation.coordinate,
      ),
      absent: (): Rfc64SemanticReadResultV1 => Object.freeze({ kind: 'absent' }),
      present: (decoded): Rfc64SemanticReadResultV1 => Object.freeze({
        kind: 'record',
        decoded,
      }),
      invalidResult: (message, cause) => fail(
        'rfc64-semantic-read-result',
        message,
        cause,
      ),
    });
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
  return snapshotRfc64ClosedBindingsReadOptionsV1(
    input,
    MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1,
    'RFC-64 semantic read options',
    (message, cause) => fail('rfc64-semantic-read-options', message, cause),
  ) as Rfc64SemanticReadOptionsV1;
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
