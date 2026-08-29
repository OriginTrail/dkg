import {
  isSafeIri,
  type Rfc64SemanticReadOperationV1,
  type Rfc64SemanticStoreObjectV1,
  type Rfc64SemanticStoreRowV1,
} from '@origintrail-official/dkg-core';
import {
  XSD_STRING_DATATYPE,
  parseRdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';

import type { QueryOptions, QueryResult, TripleStore } from './triple-store.js';
import { SparqlJsonResultsShapeError } from './adapters/sparql-json-results.js';

const certifiedRfc64SemanticReadStoresV1 = new WeakSet<object>();

export interface Rfc64SemanticReadCapabilityV1 {
  rfc64SemanticReadV1(
    operation: Rfc64SemanticReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ): Promise<readonly Rfc64SemanticStoreRowV1[]>;
}

export class Rfc64SemanticReadCapabilityResultErrorV1 extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'Rfc64SemanticReadCapabilityResultErrorV1';
  }
}

/**
 * Shared implementation for adapters certified to execute the closed semantic
 * read manifest. The capability boundary returns backend-neutral typed rows,
 * never a generic SPARQL result.
 */
async function executeRfc64SemanticReadCapabilityV1(
  store: Pick<TripleStore, 'query'>,
  operation: Rfc64SemanticReadOperationV1,
  options: Pick<QueryOptions, 'signal'> = {},
): Promise<readonly Rfc64SemanticStoreRowV1[]> {
  let result: QueryResult;
  try {
    result = await store.query(operation.sparql, {
      source: `rfc64.semantic.${operation.queryId}`,
      priority: 'background',
      signal: options.signal,
      maxResponseBytes: operation.responseByteCeiling,
    });
  } catch (cause) {
    if (cause instanceof SparqlJsonResultsShapeError) {
      throw new Rfc64SemanticReadCapabilityResultErrorV1(
        'semantic read received malformed SPARQL JSON results',
        { cause },
      );
    }
    throw cause;
  }
  return normalizeRfc64SemanticReadResultV1(result, operation);
}

/**
 * Internal declarative opt-in used only by adapters whose RFC-64 read
 * conformance is covered by the storage certification suite. The generic
 * TripleStore contract intentionally does not expose this method.
 */
export function certifyRfc64SemanticReadStoreV1(store: TripleStore): void {
  if (certifiedRfc64SemanticReadStoresV1.has(store)) return;
  Object.defineProperty(store, 'rfc64SemanticReadV1', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: (
      operation: Rfc64SemanticReadOperationV1,
      options?: Pick<QueryOptions, 'signal'>,
    ) => executeRfc64SemanticReadCapabilityV1(store, operation, options),
  });
  certifiedRfc64SemanticReadStoresV1.add(store);
}

export function isRfc64SemanticReadCapabilityV1(
  candidate: unknown,
): candidate is Rfc64SemanticReadCapabilityV1 {
  return candidate !== null
    && typeof candidate === 'object'
    && certifiedRfc64SemanticReadStoresV1.has(candidate)
    && typeof Object.getOwnPropertyDescriptor(candidate, 'rfc64SemanticReadV1')?.value
      === 'function';
}

function normalizeRfc64SemanticReadResultV1(
  result: QueryResult,
  operation: Rfc64SemanticReadOperationV1,
): readonly Rfc64SemanticStoreRowV1[] {
  if (ownDataValue(result, 'type') !== 'bindings') {
    invalid('semantic read did not return bindings');
  }
  const bindings = ownDataValue(result, 'bindings');
  if (!Array.isArray(bindings) || Object.getPrototypeOf(bindings) !== Array.prototype) {
    invalid('semantic read bindings must be an ordinary Array');
  }
  if (bindings.length > operation.rowCeiling) {
    invalid('semantic read exceeded its row ceiling');
  }
  const keys = Reflect.ownKeys(bindings);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== bindings.length + 1
    || !keys.includes('length')
  ) {
    invalid('semantic read bindings must be dense and unadorned');
  }
  const rows: Rfc64SemanticStoreRowV1[] = [];
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = ownDataValue(bindings, String(index));
    const predicate = ownDataValue(binding, 'p');
    const object = ownDataValue(binding, 'o');
    if (typeof predicate !== 'string' || typeof object !== 'string') {
      invalid('semantic read binding terms must be strings');
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
    invalid('semantic record literals cannot carry a language tag');
  }
  if (isSafeIri(input)) {
    return Object.freeze({ kind: 'named-node', value: input });
  }
  invalid('semantic record object is not an exact RDF term');
}

function ownDataValue(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object') {
    invalid('semantic read result must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    invalid(`semantic read result ${key} must be a data property`);
  }
  return descriptor.value;
}

function invalid(message: string): never {
  throw new Rfc64SemanticReadCapabilityResultErrorV1(message);
}
