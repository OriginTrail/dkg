import {
  compileRfc64AuthorSealReadOperationV1,
  decodeCanonicalGraphScopedAuthorSealRowsV1,
  snapshotExactDataRecord,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
  type DecodedCanonicalGraphScopedAuthorSealRowsV1,
} from '@origintrail-official/dkg-core';

import {
  runRfc64ClosedBindingsReadV1,
  snapshotRfc64ClosedBindingsReadOptionsV1,
} from './rfc64-closed-bindings-read-runner.js';
import {
  isRfc64ExactBindingsReadCapabilityV1,
  type Rfc64ExactBindingsReadCapabilityV1,
} from './rfc64-exact-bindings-read-capability.js';
import { findTripleStoreCapability, type TripleStore } from './triple-store.js';

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
  private readonly capability: Rfc64ExactBindingsReadCapabilityV1;

  constructor(store: TripleStore) {
    const capability = findTripleStoreCapability(
      store,
      isRfc64ExactBindingsReadCapabilityV1,
    );
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
    return runRfc64ClosedBindingsReadV1({
      options: readOptions,
      deadlineLabel: 'RFC-64 author-seal read',
      dispatch: (signal) => this.capability.rfc64ExactBindingsReadV1(
        operation,
        { signal },
      ),
      decode: (rows) => decodeCanonicalGraphScopedAuthorSealRowsV1(
        rows,
        operation.coordinate,
      ),
      absent: (): Rfc64AuthorSealReadResultV1 => Object.freeze({ kind: 'absent' }),
      present: (decoded): Rfc64AuthorSealReadResultV1 => Object.freeze({
        kind: 'seal',
        decoded,
      }),
      invalidResult: (message, cause) => fail(
        'rfc64-author-seal-read-result',
        message,
        cause,
      ),
    });
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
  return snapshotRfc64ClosedBindingsReadOptionsV1(
    input,
    MAX_RFC64_AUTHOR_SEAL_READ_TIMEOUT_MS_V1,
    'RFC-64 author-seal read options',
    (message, cause) => fail('rfc64-author-seal-read-options', message, cause),
  ) as Rfc64AuthorSealReadOptionsV1;
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
