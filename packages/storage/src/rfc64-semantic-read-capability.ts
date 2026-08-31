import {
  TypedRdfStoreRowErrorV1,
  parseRenderedRdfStoreObjectV1,
  type Rfc64SemanticReadOperationV1,
  type Rfc64SemanticStoreRowV1,
} from '@origintrail-official/dkg-core';

import type { QueryOptions, QueryResult, TripleStore } from './triple-store.js';
import { SparqlJsonResultsShapeError } from './sparql-json-query-result.js';
import {
  readOwnEnumerableDataProperty,
  snapshotDenseDataArray,
} from './closed-data-snapshot.js';

export interface Rfc64SemanticReadCapabilityResultV1 {
  readonly rows: readonly Rfc64SemanticStoreRowV1[];
}

export interface Rfc64SemanticReadCapabilityV1 {
  readonly rfc64SemanticReadCertifiedV1: true;
  rfc64SemanticReadV1(
    operation: Rfc64SemanticReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ): Promise<Rfc64SemanticReadCapabilityResultV1>;
}

export class Rfc64SemanticReadCapabilityResultErrorV1 extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'Rfc64SemanticReadCapabilityResultErrorV1';
  }
}

/** Shared implementation used by adapters that explicitly expose the capability. */
export async function executeRfc64SemanticReadCapabilityV1(
  store: Pick<TripleStore, 'query'>,
  operation: Rfc64SemanticReadOperationV1,
  options: Pick<QueryOptions, 'signal'> = {},
): Promise<Rfc64SemanticReadCapabilityResultV1> {
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

export function isRfc64SemanticReadCapabilityV1(
  candidate: unknown,
): candidate is Rfc64SemanticReadCapabilityV1 {
  return candidate !== null
    && typeof candidate === 'object'
    && dataPropertyValue(candidate, 'rfc64SemanticReadCertifiedV1') === true
    && typeof dataPropertyValue(candidate, 'rfc64SemanticReadV1') === 'function';
}

function normalizeRfc64SemanticReadResultV1(
  result: QueryResult,
  operation: Rfc64SemanticReadOperationV1,
): Rfc64SemanticReadCapabilityResultV1 {
  if (ownDataValue(result, 'type') !== 'bindings') {
    invalid('semantic read did not return bindings');
  }
  const reportedVariables = ownOptionalDataValue(result, 'variables');
  const variables = reportedVariables === undefined
    ? [...operation.resultVariables]
    : snapshotProjection(reportedVariables);
  if (!sameProjection(variables, operation.resultVariables)) {
    invalid('semantic read returned the wrong result projection');
  }

  const bindings = snapshotDenseDataArray(
    ownDataValue(result, 'bindings'),
    'semantic read bindings',
    invalid,
  );
  if (bindings.length > operation.rowCeiling) {
    invalid('semantic read exceeded its row ceiling');
  }
  const rows: Rfc64SemanticStoreRowV1[] = [];
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    const predicate = ownDataValue(binding, 'p');
    const object = ownDataValue(binding, 'o');
    if (typeof predicate !== 'string' || typeof object !== 'string') {
      invalid('semantic read binding terms must be strings');
    }
    try {
      rows.push(Object.freeze({
        subjectIri: operation.subjectIri,
        predicateIri: predicate,
        graphIri: operation.graphIri,
        object: parseRenderedRdfStoreObjectV1(object),
      }));
    } catch (cause) {
      if (cause instanceof TypedRdfStoreRowErrorV1) {
        invalid('semantic record object is not an exact RDF term', cause);
      }
      throw cause;
    }
  }
  return Object.freeze({
    rows: Object.freeze(rows),
  });
}

function snapshotProjection(input: unknown): string[] {
  const snapshot = snapshotDenseDataArray(
    input,
    'semantic read result projection',
    invalid,
  );
  const result: string[] = [];
  for (const value of snapshot) {
    if (typeof value !== 'string') invalid('semantic read result variables must be strings');
    result.push(value);
  }
  return result;
}

function sameProjection(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ownOptionalDataValue(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object') {
    invalid('semantic read result must be an object');
  }
  if (!Object.prototype.hasOwnProperty.call(input, key)) return undefined;
  return ownDataValue(input, key);
}

function ownDataValue(input: unknown, key: string): unknown {
  return readOwnEnumerableDataProperty(input, key, 'semantic read result', invalid);
}

function dataPropertyValue(input: object, key: string): unknown {
  let current: object | null = input;
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : undefined;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function invalid(message: string, cause?: unknown): never {
  throw new Rfc64SemanticReadCapabilityResultErrorV1(
    message,
    cause === undefined ? {} : { cause },
  );
}
