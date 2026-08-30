import {
  compileRfc64SemanticReadRequestV2,
  decodeRfc64SemanticRecordStoreRowsV1,
  Rfc64SemanticReadManifestErrorV1,
  type DecodedRfc64SemanticRecordV1,
  type Rfc64SemanticReadOperationV2,
  type Rfc64SemanticRecordCoordinateV1,
} from '@origintrail-official/dkg-core';

import {
  runRfc64ClosedBindingsReadV1,
  snapshotRfc64ClosedBindingsReadOptionsV1,
} from './rfc64-closed-bindings-read-runner.js';
import {
  isRfc64SemanticReadCapabilitySourceV1,
  resolveRfc64SemanticReadCapabilityV1,
  Rfc64SemanticReadCapabilityResultErrorV1,
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
  | { readonly kind: 'absent' }
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
  private readonly dispatch: (
    operation: Rfc64SemanticReadOperationV2,
    signal: AbortSignal | undefined,
  ) => Promise<readonly import('@origintrail-official/dkg-core').Rfc64SemanticStoreRowV1[]>;

  constructor(store: TripleStore) {
    const capabilitySource = findTripleStoreCapability(
      store,
      isRfc64SemanticReadCapabilitySourceV1,
    );
    const capability = resolveRfc64SemanticReadCapabilityV1(capabilitySource);
    if (!capability) {
      fail(
        'rfc64-semantic-read-capability',
        'triple store has no certified RFC-64 semantic read capability',
      );
    }
    this.dispatch = (operation, signal) => capability.read(
      operation,
      { signal },
    );
  }

  async read(
    input: unknown,
    options: Rfc64SemanticReadOptionsV1,
  ): Promise<Rfc64SemanticReadResultV1> {
    let operation: Rfc64SemanticReadOperationV2;
    try {
      operation = compileRfc64SemanticReadRequestV2(input);
    } catch (cause) {
      if (cause instanceof Rfc64SemanticReadManifestErrorV1) {
        fail('rfc64-semantic-read-request', cause.message, cause);
      }
      throw cause;
    }
    const readOptions = snapshotOptions(options);
    try {
      const decoded = await runRfc64ClosedBindingsReadV1({
        options: readOptions,
        deadlineLabel: 'RFC-64 semantic read',
        dispatch: (signal) => this.dispatch(operation, signal),
        decode: (rows) => decodeRfc64SemanticRecordStoreRowsV1(
          rows,
          operation.coordinate,
        ),
      });
      return decoded === undefined
        ? Object.freeze({ kind: 'absent' })
        : Object.freeze({ kind: 'record', decoded });
    } catch (cause) {
      if (cause instanceof Rfc64SemanticReadCapabilityResultErrorV1) {
        fail('rfc64-semantic-read-result', cause.message, cause);
      }
      throw cause;
    }
  }
}

function snapshotOptions(input: unknown): Rfc64SemanticReadOptionsV1 {
  return snapshotRfc64ClosedBindingsReadOptionsV1(
    input,
    MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1,
    'RFC-64 semantic read options',
    (message, cause) => fail('rfc64-semantic-read-options', message, cause),
  ) as Rfc64SemanticReadOptionsV1;
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
