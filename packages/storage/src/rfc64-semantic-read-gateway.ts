import {
  compileRfc64SemanticReadOperationV1,
  decodeRfc64SemanticRecordStoreRowsV1,
  isSafeIri,
  type DecodedRfc64SemanticRecordV1,
  type Rfc64SemanticReadBackendV1,
  type Rfc64SemanticReadOperationV1,
  type Rfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticStoreObjectV1,
  type Rfc64SemanticStoreRowV1,
} from '@origintrail-official/dkg-core';
import {
  XSD_STRING_DATATYPE,
  parseRdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';

import { composeAbortSignals } from './abortable-store-work-lifecycle.js';
import {
  findTripleStoreCapability,
  type QueryResult,
  type TripleStore,
} from './triple-store.js';

export const MAX_RFC64_SEMANTIC_READ_TIMEOUT_MS_V1 = 30_000;

export interface Rfc64SemanticReadBackendCapabilityV1 {
  readonly rfc64SemanticReadBackendV1: Rfc64SemanticReadBackendV1;
}

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
  readonly backend: Rfc64SemanticReadBackendV1;

  constructor(private readonly store: Pick<TripleStore, 'query'>) {
    const capability = findTripleStoreCapability(
      store,
      isRfc64SemanticReadBackendCapabilityV1,
    );
    if (!capability) {
      fail(
        'rfc64-semantic-read-capability',
        'triple store has no certified RFC-64 semantic read backend',
      );
    }
    this.backend = capability.rfc64SemanticReadBackendV1;
  }

  async read(
    input: unknown,
    options: Rfc64SemanticReadOptionsV1,
  ): Promise<Rfc64SemanticReadResultV1> {
    const request = snapshotRequest(input);
    const readOptions = snapshotOptions(options);
    const operation = compileRfc64SemanticReadOperationV1({
      backend: this.backend,
      coordinate: request.coordinate,
    });

    const deadlineAt = performance.now() + readOptions.timeoutMs;
    const deadlineSignal = AbortSignal.timeout(readOptions.timeoutMs);
    const signalScope = composeAbortSignals(readOptions.signal, deadlineSignal);
    try {
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      const result = await this.store.query(operation.sparql, {
        source: `rfc64.semantic.${operation.queryId}`,
        priority: 'background',
        signal: signalScope.signal,
        maxResponseBytes: operation.responseByteCeiling,
      });
      assertBeforeDeadline(signalScope.signal, deadlineAt);
      const rows = semanticRowsFromResult(result, operation);
      if (rows.length === 0) {
        return Object.freeze({ kind: 'absent' });
      }
      return Object.freeze({
        kind: 'record',
        decoded: decodeRfc64SemanticRecordStoreRowsV1(rows, operation.coordinate),
      });
    } finally {
      signalScope.dispose();
    }
  }
}

export function isRfc64SemanticReadBackendCapabilityV1(
  candidate: unknown,
): candidate is Rfc64SemanticReadBackendCapabilityV1 {
  if (candidate === null || typeof candidate !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptor(
    candidate,
    'rfc64SemanticReadBackendV1',
  );
  return descriptor?.enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && (descriptor.value === 'oxigraph' || descriptor.value === 'blazegraph');
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

function semanticRowsFromResult(
  result: QueryResult,
  operation: Rfc64SemanticReadOperationV1,
): readonly Rfc64SemanticStoreRowV1[] {
  const resultType = ownDataValue(result, 'type');
  if (resultType !== 'bindings') {
    fail('rfc64-semantic-read-result', 'semantic read did not return bindings');
  }
  const response = snapshotExactRecord(
    result,
    ['bindings', 'type'],
    'RFC-64 semantic read result',
    'rfc64-semantic-read-result',
  );
  const bindings = response.bindings;
  if (!Array.isArray(bindings) || Object.getPrototypeOf(bindings) !== Array.prototype) {
    fail('rfc64-semantic-read-result', 'semantic read bindings must be an ordinary Array');
  }
  if (bindings.length > operation.rowCeiling) {
    fail('rfc64-semantic-read-result', 'semantic read exceeded its row ceiling');
  }
  const ownKeys = Reflect.ownKeys(bindings);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== bindings.length + 1
    || !ownKeys.includes('length')
  ) {
    fail('rfc64-semantic-read-result', 'semantic read bindings must be dense and unadorned');
  }
  const rows: Rfc64SemanticStoreRowV1[] = [];
  for (let index = 0; index < bindings.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(bindings, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('rfc64-semantic-read-result', 'semantic read bindings must use data properties');
    }
    const binding = snapshotExactRecord(
      descriptor.value,
      ['o', 'p'],
      `RFC-64 semantic binding ${index}`,
      'rfc64-semantic-read-result',
    );
    if (typeof binding.p !== 'string' || typeof binding.o !== 'string') {
      fail('rfc64-semantic-read-result', 'semantic read binding terms must be strings');
    }
    rows.push(Object.freeze({
      subjectIri: operation.subjectIri,
      predicateIri: binding.p,
      graphIri: operation.graphIri,
      object: parseStoreObject(binding.o),
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
    fail('rfc64-semantic-read-result', 'semantic record literals cannot carry a language tag');
  }
  if (isSafeIri(input)) {
    return Object.freeze({ kind: 'named-node', value: input });
  }
  fail('rfc64-semantic-read-result', 'semantic record object is not an exact RDF term');
}

function snapshotExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
  code: Rfc64SemanticReadGatewayErrorCodeV1,
): Readonly<Record<string, unknown>> {
  if (
    input === null
    || typeof input !== 'object'
    || Object.getPrototypeOf(input) !== Object.prototype
  ) {
    fail(code, `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !keys.includes(key))
  ) {
    fail(code, `${label} has an invalid field set`);
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, `${label} must use enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function isRecordWithOwnKey(input: unknown, key: string): boolean {
  return input !== null
    && typeof input === 'object'
    && Object.prototype.hasOwnProperty.call(input, key);
}

function ownDataValue(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object') {
    fail('rfc64-semantic-read-result', 'semantic read result must be an object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail('rfc64-semantic-read-result', `semantic read result ${key} must be a data property`);
  }
  return descriptor.value;
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
