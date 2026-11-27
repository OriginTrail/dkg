import {
  compileRfc64AuthorSealReadOperationV1,
  decodeCanonicalGraphScopedAuthorSealRowsV1,
  Rfc64AuthorSealReadManifestErrorV1,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
  type DecodedCanonicalGraphScopedAuthorSealRowsV1,
} from '@origintrail-official/dkg-core';

import {
  runRfc64ClosedBindingsReadV1,
  snapshotRfc64ClosedBindingsReadOptionsV1,
} from './rfc64-closed-bindings-read-runner.js';
import {
  isRfc64ExactBindingsReadCapabilityV1,
  Rfc64ExactBindingsReadResultErrorV1,
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
    let operation;
    try {
      operation = compileRfc64AuthorSealReadOperationV1(input);
    } catch (cause) {
      if (cause instanceof Rfc64AuthorSealReadManifestErrorV1) {
        fail('rfc64-author-seal-read-request', cause.message, cause);
      }
      throw cause;
    }
    const readOptions = snapshotOptions(options);
    try {
      const decoded = await runRfc64ClosedBindingsReadV1({
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
      });
      return decoded === undefined
        ? Object.freeze({ kind: 'absent' })
        : Object.freeze({ kind: 'seal', decoded });
    } catch (cause) {
      if (cause instanceof Rfc64ExactBindingsReadResultErrorV1) {
        fail('rfc64-author-seal-read-result', cause.message, cause);
      }
      throw cause;
    }
  }
}

function snapshotOptions(input: unknown): Rfc64AuthorSealReadOptionsV1 {
  return snapshotRfc64ClosedBindingsReadOptionsV1(
    input,
    MAX_RFC64_AUTHOR_SEAL_READ_TIMEOUT_MS_V1,
    'RFC-64 author-seal read options',
    (message, cause) => fail('rfc64-author-seal-read-options', message, cause),
  ) as Rfc64AuthorSealReadOptionsV1;
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
