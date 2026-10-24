import {
  parseRenderedRdfStoreObjectV1,
  snapshotTypedRdfStoreRowV1,
  type CanonicalAuthorSealStoreRowV1,
  type Rfc64AuthorSealReadOperationV1,
  type Rfc64SemanticReadOperationV1,
  type Rfc64SemanticStoreObjectV1,
} from '@origintrail-official/dkg-core';

import {
  findTripleStoreCapability,
  type QueryOptions,
  type QueryResult,
  type TripleStore,
} from './triple-store.js';
import { SparqlJsonResultsShapeError } from './sparql-json-query-result.js';
import {
  readOwnEnumerableDataProperty,
  snapshotDenseDataArray,
  snapshotExactOrdinaryDataRecord,
} from './closed-data-snapshot.js';

export const RFC64_EXACT_BINDINGS_RESULT_ERROR_CODE_V1 =
  'RFC64_EXACT_BINDINGS_RESULT_V1' as const;

export type Rfc64ExactBindingsReadOperationV1 =
  | Rfc64SemanticReadOperationV1
  | Rfc64AuthorSealReadOperationV1;

export type Rfc64ExactBindingsStoreRowV1 = CanonicalAuthorSealStoreRowV1;

export interface Rfc64ExactBindingsReadCapabilityV1 {
  readonly rfc64ExactBindingsReadCertifiedV1: true;
  rfc64ExactBindingsReadV1(
    operation: Rfc64ExactBindingsReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ): Promise<readonly Rfc64ExactBindingsStoreRowV1[]>;
}

/** @deprecated Use {@link Rfc64ExactBindingsReadResultErrorV1}. */
export class Rfc64SemanticReadCapabilityResultErrorV1 extends Error {
  readonly code: string = RFC64_EXACT_BINDINGS_RESULT_ERROR_CODE_V1;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'Rfc64SemanticReadCapabilityResultErrorV1';
  }
}

export class Rfc64ExactBindingsReadResultErrorV1
  extends Rfc64SemanticReadCapabilityResultErrorV1 {
  override readonly code = RFC64_EXACT_BINDINGS_RESULT_ERROR_CODE_V1;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'Rfc64ExactBindingsReadResultErrorV1';
  }
}

/**
 * Shared implementation for adapters certified to execute the closed RFC-64
 * exact-bindings union. The capability returns backend-neutral typed rows,
 * never a generic SPARQL result.
 */
export async function executeRfc64ExactBindingsReadCapabilityV1(
  store: Pick<TripleStore, 'query'>,
  operation: Rfc64ExactBindingsReadOperationV1,
  options: Pick<QueryOptions, 'signal'> = {},
): Promise<readonly Rfc64ExactBindingsStoreRowV1[]> {
  let result: QueryResult;
  try {
    result = await store.query(operation.sparql, {
      source: `rfc64.exact-bindings.${operation.queryId}`,
      priority: 'background',
      signal: options.signal,
      maxResponseBytes: operation.responseByteCeiling,
    });
  } catch (cause) {
    if (cause instanceof SparqlJsonResultsShapeError) {
      throw new Rfc64ExactBindingsReadResultErrorV1(
        'exact-bindings read received malformed SPARQL JSON results',
        { cause },
      );
    }
    throw cause;
  }
  return normalizeRfc64ExactBindingsReadResultV1(result, operation);
}

/** @deprecated Use {@link executeRfc64ExactBindingsReadCapabilityV1}. */
export function executeRfc64SemanticReadCapabilityV1(
  store: Pick<TripleStore, 'query'>,
  operation: Rfc64SemanticReadOperationV1,
  options: Pick<QueryOptions, 'signal'> = {},
): Promise<Rfc64SemanticReadCapabilityResultV1> {
  return executeRfc64ExactBindingsReadCapabilityV1(store, operation, options)
    .then((rows) => Object.freeze({ rows }));
}

export function isRfc64ExactBindingsReadCapabilityV1(
  candidate: unknown,
): candidate is Rfc64ExactBindingsReadCapabilityV1 {
  return hasDataValue(candidate, 'rfc64ExactBindingsReadCertifiedV1', true)
    && hasDataMethod(candidate, 'rfc64ExactBindingsReadV1');
}

/** Legacy semantic-only capability retained for the compatibility window. */
export interface Rfc64SemanticReadCapabilityResultV1 {
  readonly rows: readonly Rfc64ExactBindingsStoreRowV1[];
}

export interface Rfc64SemanticReadCapabilityV1 {
  readonly rfc64SemanticReadCertifiedV1: true;
  rfc64SemanticReadV1(
    operation: Rfc64SemanticReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ): Promise<Rfc64SemanticReadCapabilityResultV1>;
}

export type Rfc64SemanticReadDispatchV1 = (
  operation: Rfc64SemanticReadOperationV1,
  options?: Pick<QueryOptions, 'signal'>,
) => Promise<readonly Rfc64ExactBindingsStoreRowV1[]>;

/**
 * Discover and normalize exact and compatibility adapters once. The gateway
 * receives one bound callable, so it cannot accidentally rediscover or invoke
 * a different adapter after construction.
 */
export function resolveRfc64SemanticReadDispatchV1(
  store: unknown,
): Rfc64SemanticReadDispatchV1 | null {
  const candidate = findTripleStoreCapability(
    store,
    isRfc64SemanticReadCapabilitySourceV1,
  );
  if (isRfc64ExactBindingsReadCapabilityV1(candidate)) {
    return candidate.rfc64ExactBindingsReadV1.bind(candidate);
  }
  if (isRfc64SemanticReadCapabilityV1(candidate)) {
    const legacyRead = candidate.rfc64SemanticReadV1.bind(candidate);
    return async (operation, options) => {
      const result = await legacyRead(operation, options);
      return normalizeLegacySemanticReadCapabilityResultV1(result, operation);
    };
  }
  return null;
}

export function isRfc64SemanticReadCapabilitySourceV1(
  candidate: unknown,
): candidate is Rfc64ExactBindingsReadCapabilityV1 | Rfc64SemanticReadCapabilityV1 {
  return isRfc64ExactBindingsReadCapabilityV1(candidate)
    || isRfc64SemanticReadCapabilityV1(candidate);
}

export function isRfc64SemanticReadCapabilityV1(
  candidate: unknown,
): candidate is Rfc64SemanticReadCapabilityV1 {
  return hasDataValue(candidate, 'rfc64SemanticReadCertifiedV1', true)
    && hasDataMethod(candidate, 'rfc64SemanticReadV1');
}

function normalizeLegacySemanticReadCapabilityResultV1(
  result: unknown,
  _operation: Rfc64SemanticReadOperationV1,
): readonly Rfc64ExactBindingsStoreRowV1[] {
  const envelope = snapshotExactOrdinaryDataRecord(
    result,
    ['rows'],
    'semantic read result',
    invalid,
  );
  const rows = snapshotDenseDataArray(
    envelope.rows,
    'semantic read rows',
    invalid,
  );
  return Object.freeze(rows.map((row) => {
    try {
      return snapshotTypedRdfStoreRowV1(row);
    } catch (cause) {
      invalid('semantic read row is malformed', cause);
    }
  }));
}

function hasDataValue(candidate: unknown, key: string, expected: unknown): boolean {
  const descriptor = findDataDescriptor(candidate, key);
  return descriptor !== null && descriptor.value === expected;
}

function hasDataMethod(candidate: unknown, key: string): boolean {
  const descriptor = findDataDescriptor(candidate, key);
  return descriptor !== null && typeof descriptor.value === 'function';
}

function findDataDescriptor(candidate: unknown, key: string): PropertyDescriptor | null {
  if (candidate === null || typeof candidate !== 'object') return null;
  let current: object | null = candidate;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor
        : null;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return null;
}

function normalizeRfc64ExactBindingsReadResultV1(
  result: QueryResult,
  operation: Rfc64ExactBindingsReadOperationV1,
): readonly Rfc64ExactBindingsStoreRowV1[] {
  if (ownDataValue(result, 'type') !== 'bindings') {
    invalid('exact-bindings read did not return bindings');
  }
  assertProjectionIfPresent(result, operation.resultVariables);
  const bindings = snapshotDenseDataArray(
    ownDataValue(result, 'bindings'),
    'exact-bindings read bindings',
    invalid,
  );
  if (bindings.length > operation.rowCeiling) {
    invalid('exact-bindings read exceeded its row ceiling');
  }
  const rows: Rfc64ExactBindingsStoreRowV1[] = [];
  let normalizedBytes = 0;
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = snapshotExactOrdinaryDataRecord(
      bindings[index],
      ['o', 'p'],
      `exact-bindings read binding ${index}`,
      invalid,
    );
    const predicate = binding.p;
    const object = binding.o;
    if (typeof predicate !== 'string' || typeof object !== 'string') {
      invalid('exact-bindings read terms must be strings');
    }
    normalizedBytes += Buffer.byteLength(predicate, 'utf8')
      + Buffer.byteLength(object, 'utf8')
      + 16;
    if (normalizedBytes > operation.responseByteCeiling) {
      invalid('exact-bindings read exceeded its response-byte ceiling');
    }
    rows.push(Object.freeze({
      subjectIri: operation.subjectIri,
      predicateIri: predicate,
      graphIri: operation.graphIri,
      object: parseStoreObject(object),
    }));
  }
  return Object.freeze(rows);
}

function assertProjectionIfPresent(
  result: QueryResult,
  expected: readonly string[],
): void {
  const descriptor = Object.getOwnPropertyDescriptor(result, 'variables');
  if (!descriptor) return;
  const variables = snapshotDenseDataArray(
    readOwnEnumerableDataProperty(result, 'variables', 'exact-bindings read result', invalid),
    'exact-bindings read projection',
    invalid,
  );
  if (variables.length !== expected.length) {
    invalid('exact-bindings read returned the wrong result projection');
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (variables[index] !== expected[index]) {
      invalid('exact-bindings read returned the wrong result projection');
    }
  }
}

function parseStoreObject(input: string): Rfc64SemanticStoreObjectV1 {
  try {
    return parseRenderedRdfStoreObjectV1(input);
  } catch (cause) {
    invalid('exact-bindings record object is not an exact RDF term', cause);
  }
}

function ownDataValue(input: unknown, key: string): unknown {
  return readOwnEnumerableDataProperty(input, key, 'exact-bindings read result', invalid);
}

function invalid(message: string, cause?: unknown): never {
  throw new Rfc64ExactBindingsReadResultErrorV1(message, { cause });
}
