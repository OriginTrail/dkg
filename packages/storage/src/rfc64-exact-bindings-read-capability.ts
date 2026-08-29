import {
  isSafeIri,
  type CanonicalAuthorSealStoreRowV1,
  type Rfc64AuthorSealReadOperationV1,
  type Rfc64SemanticReadOperationV1,
  type Rfc64SemanticStoreObjectV1,
} from '@origintrail-official/dkg-core';
import {
  XSD_STRING_DATATYPE,
  parseRdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';

import type { QueryOptions, QueryResult, TripleStore } from './triple-store.js';
import { SparqlJsonResultsShapeError } from './adapters/sparql-json-results.js';

const certifiedRfc64ExactBindingsReadStoresV1 = new WeakSet<object>();

export type Rfc64ExactBindingsReadOperationV1 =
  | Rfc64SemanticReadOperationV1
  | Rfc64AuthorSealReadOperationV1;

export type Rfc64ExactBindingsStoreRowV1 = CanonicalAuthorSealStoreRowV1;

export interface Rfc64ExactBindingsReadCapabilityV1 {
  rfc64ExactBindingsReadV1(
    operation: Rfc64ExactBindingsReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ): Promise<readonly Rfc64ExactBindingsStoreRowV1[]>;
}

/** @deprecated Use {@link Rfc64ExactBindingsReadResultErrorV1}. */
export class Rfc64SemanticReadCapabilityResultErrorV1 extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'Rfc64SemanticReadCapabilityResultErrorV1';
  }
}

export class Rfc64ExactBindingsReadResultErrorV1
  extends Rfc64SemanticReadCapabilityResultErrorV1 {
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
): Promise<readonly Rfc64ExactBindingsStoreRowV1[]> {
  return executeRfc64ExactBindingsReadCapabilityV1(store, operation, options);
}

/**
 * Declarative opt-in used only by adapters whose closed-read conformance is
 * covered by the storage certification suite.
 */
export function certifyRfc64ExactBindingsReadStoreV1(
  store: TripleStore,
  execute: Rfc64ExactBindingsReadCapabilityV1['rfc64ExactBindingsReadV1'] =
    (operation, options) => executeRfc64ExactBindingsReadCapabilityV1(
      store,
      operation,
      options,
    ),
): void {
  if (certifiedRfc64ExactBindingsReadStoresV1.has(store)) return;
  Object.defineProperty(store, 'rfc64ExactBindingsReadV1', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: execute,
  });
  Object.defineProperty(store, 'rfc64SemanticReadV1', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: (
      operation: Rfc64SemanticReadOperationV1,
      options?: Pick<QueryOptions, 'signal'>,
    ) => execute(operation, options),
  });
  certifiedRfc64ExactBindingsReadStoresV1.add(store);
}

/** @deprecated Use {@link certifyRfc64ExactBindingsReadStoreV1}. */
export function certifyRfc64SemanticReadStoreV1(store: TripleStore): void {
  certifyRfc64ExactBindingsReadStoreV1(store);
}

export function isRfc64ExactBindingsReadCapabilityV1(
  candidate: unknown,
): candidate is Rfc64ExactBindingsReadCapabilityV1 {
  return candidate !== null
    && typeof candidate === 'object'
    && certifiedRfc64ExactBindingsReadStoresV1.has(candidate)
    && typeof Object.getOwnPropertyDescriptor(candidate, 'rfc64ExactBindingsReadV1')?.value
      === 'function';
}

/** Legacy semantic-only capability retained for the compatibility window. */
export interface Rfc64SemanticReadCapabilityV1 {
  rfc64SemanticReadV1(
    operation: Rfc64SemanticReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ): Promise<readonly Rfc64ExactBindingsStoreRowV1[]>;
}

/**
 * Compatibility discovery does not invoke accessors. Certified exact stores
 * expose an immutable own data method; pre-generalization custom adapters may
 * expose the legacy method as a data method on their prototype.
 */
export function isRfc64SemanticReadCapabilityV1(
  candidate: unknown,
): candidate is Rfc64SemanticReadCapabilityV1 {
  return isRfc64ExactBindingsReadCapabilityV1(candidate)
    || hasDataMethod(candidate, 'rfc64SemanticReadV1');
}

function hasDataMethod(candidate: unknown, key: string): boolean {
  if (candidate === null || typeof candidate !== 'object') return false;
  let current: object | null = candidate;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && typeof descriptor.value === 'function';
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function normalizeRfc64ExactBindingsReadResultV1(
  result: QueryResult,
  operation: Rfc64ExactBindingsReadOperationV1,
): readonly Rfc64ExactBindingsStoreRowV1[] {
  if (ownDataValue(result, 'type') !== 'bindings') {
    invalid('exact-bindings read did not return bindings');
  }
  const bindings = ownDataValue(result, 'bindings');
  if (!Array.isArray(bindings) || Object.getPrototypeOf(bindings) !== Array.prototype) {
    invalid('exact-bindings read bindings must be an ordinary Array');
  }
  if (bindings.length > operation.rowCeiling) {
    invalid('exact-bindings read exceeded its row ceiling');
  }
  const keys = Reflect.ownKeys(bindings);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== bindings.length + 1
    || !keys.includes('length')
  ) {
    invalid('exact-bindings read bindings must be dense and unadorned');
  }
  const rows: Rfc64ExactBindingsStoreRowV1[] = [];
  let normalizedBytes = 0;
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = ownDataValue(bindings, String(index));
    const predicate = ownDataValue(binding, 'p');
    const object = ownDataValue(binding, 'o');
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

function parseStoreObject(input: string): Rfc64SemanticStoreObjectV1 {
  const literal = parseRdfLiteralTerm(input);
  if (literal?.kind === 'plain') {
    return Object.freeze({
      kind: 'literal',
      value: literal.value,
      datatypeIri: XSD_STRING_DATATYPE,
    });
  }
  if (literal?.kind === 'typed') {
    return Object.freeze({
      kind: 'literal',
      value: literal.value,
      datatypeIri: literal.datatype,
    });
  }
  if (literal?.kind === 'language') {
    invalid('exact-bindings record literals cannot carry a language tag');
  }
  if (isSafeIri(input)) {
    return Object.freeze({ kind: 'named-node', value: input });
  }
  invalid('exact-bindings record object is not an exact RDF term');
}

function ownDataValue(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object') {
    invalid('exact-bindings read result must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    invalid(`exact-bindings read result ${key} must be a data property`);
  }
  return descriptor.value;
}

function invalid(message: string): never {
  throw new Rfc64ExactBindingsReadResultErrorV1(message);
}
