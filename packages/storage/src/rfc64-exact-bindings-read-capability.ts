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

export class Rfc64ExactBindingsReadResultErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Rfc64ExactBindingsReadResultErrorV1';
  }
}

/** Execute and normalize one member of the closed RFC-64 exact-bindings union. */
export async function executeRfc64ExactBindingsReadCapabilityV1(
  store: Pick<TripleStore, 'query'>,
  operation: Rfc64ExactBindingsReadOperationV1,
  options: Pick<QueryOptions, 'signal'> = {},
): Promise<readonly Rfc64ExactBindingsStoreRowV1[]> {
  const result = await store.query(operation.sparql, {
    source: `rfc64.exact-bindings.${operation.queryId}`,
    priority: 'background',
    signal: options.signal,
    maxResponseBytes: operation.responseByteCeiling,
  });
  return normalizeRfc64ExactBindingsReadResultV1(result, operation);
}

export function isRfc64ExactBindingsReadCapabilityV1(
  candidate: unknown,
): candidate is Rfc64ExactBindingsReadCapabilityV1 {
  return candidate !== null
    && typeof candidate === 'object'
    && typeof (candidate as Partial<Rfc64ExactBindingsReadCapabilityV1>)
      .rfc64ExactBindingsReadV1 === 'function';
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
