import {
  MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
  RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1,
  snapshotRfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticRecordTypeV1,
} from './rfc64-semantic-records-v1.js';
import {
  deriveRfc64ContextGraphSemanticAddressesV1,
  deriveRfc64CurrentAuthorCatalogRefAddressV1,
  deriveRfc64SubgraphSemanticAddressesV1,
  type Rfc64SemanticAddressV1,
} from './rfc64-semantic-addresses-v1.js';
import { isPlainRecord, snapshotExactDataRecord } from './sync-wire-objects.js';

export const RFC64_SEMANTIC_READ_BACKENDS_V1 = Object.freeze([
  'oxigraph',
  'blazegraph',
] as const);

export type Rfc64SemanticReadBackendV1 =
  (typeof RFC64_SEMANTIC_READ_BACKENDS_V1)[number];

export const RFC64_SEMANTIC_READ_QUERY_IDS_V1 = Object.freeze([
  'SYNC_HEAD_REF_GET_V1',
  'SYNC_MUTATION_GUARD_GET_V1',
  'SYNC_RECONCILE_TARGET_GET_V1',
  'SYNC_APPLIED_SEAL_GET_V1',
  'SYNC_APPLIED_SET_GET_V1',
  'SYNC_APPLIED_CG_SEAL_GET_V1',
] as const);

export type Rfc64SemanticReadQueryIdV1 =
  (typeof RFC64_SEMANTIC_READ_QUERY_IDS_V1)[number];

export const RFC64_SEMANTIC_READ_CONCURRENCY_CLASS_V1 =
  'rfc64-semantic-control-v1' as const;

export interface Rfc64SemanticReadTemplateInputV1 {
  readonly backend: Rfc64SemanticReadBackendV1;
  readonly queryId: Rfc64SemanticReadQueryIdV1;
  readonly coordinate: Rfc64SemanticRecordCoordinateV1;
}

export interface Rfc64SemanticReadOperationV1 {
  readonly backend: Rfc64SemanticReadBackendV1;
  readonly queryId: Rfc64SemanticReadQueryIdV1;
  readonly recordType: Rfc64SemanticRecordTypeV1;
  readonly coordinate: Rfc64SemanticRecordCoordinateV1;
  readonly graphIri: string;
  readonly subjectIri: string;
  readonly resultKind: 'bindings';
  readonly resultVariables: readonly ['p', 'o'];
  readonly expectedRowCount: number;
  readonly rowCeiling: number;
  readonly responseByteCeiling: number;
  readonly concurrencyClass: typeof RFC64_SEMANTIC_READ_CONCURRENCY_CLASS_V1;
  readonly sparql: string;
}

export type Rfc64SemanticReadManifestErrorCodeV1 =
  | 'rfc64-semantic-read-schema'
  | 'rfc64-semantic-read-query-id'
  | 'rfc64-semantic-read-operation';

export class Rfc64SemanticReadManifestErrorV1 extends Error {
  constructor(
    readonly code: Rfc64SemanticReadManifestErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64SemanticReadManifestErrorV1';
  }
}

const QUERY_RECORD_TYPES = Object.freeze({
  SYNC_HEAD_REF_GET_V1: Object.freeze([
    'CurrentAuthorCatalogRefV1',
  ]),
  SYNC_MUTATION_GUARD_GET_V1: Object.freeze([
    'SubgraphMutationGuardV1',
    'ContextGraphMutationGuardV1',
  ]),
  SYNC_RECONCILE_TARGET_GET_V1: Object.freeze([
    'SubgraphReconcileTargetGuardV1',
  ]),
  SYNC_APPLIED_SEAL_GET_V1: Object.freeze([
    'AppliedSubgraphSealV1',
  ]),
  SYNC_APPLIED_SET_GET_V1: Object.freeze([
    'AppliedSubgraphSetRefV1',
  ]),
  SYNC_APPLIED_CG_SEAL_GET_V1: Object.freeze([
    'AppliedContextGraphSealV1',
  ]),
} as const satisfies Record<
  Rfc64SemanticReadQueryIdV1,
  readonly Rfc64SemanticRecordTypeV1[]
>);

const BACKENDS = new Set<string>(RFC64_SEMANTIC_READ_BACKENDS_V1);
const QUERY_IDS = new Set<string>(RFC64_SEMANTIC_READ_QUERY_IDS_V1);

/**
 * Compile one closed, exact-subject RFC-64 semantic read operation.
 *
 * Oxigraph and Blazegraph intentionally receive the same SPARQL 1.1 query.
 * Backend identity remains explicit so conformance can reject an uncertified
 * adapter rather than silently falling back to a generic endpoint.
 */
export function compileRfc64SemanticReadOperationV1(
  input: unknown,
): Rfc64SemanticReadOperationV1 {
  const request = snapshotInput(input);
  const coordinate = snapshotRfc64SemanticRecordCoordinateV1(request.coordinate);
  const allowedTypes = QUERY_RECORD_TYPES[request.queryId];
  if (!allowedTypes.some((recordType) => recordType === coordinate.recordType)) {
    fail(
      'rfc64-semantic-read-query-id',
      `${request.queryId} cannot read ${coordinate.recordType}`,
    );
  }
  const address = addressForCoordinate(coordinate);
  const expectedRowCount = RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1[coordinate.recordType];
  const rowCeiling = expectedRowCount + 1;
  const sparql = renderExactSubjectRead(address, rowCeiling);
  return Object.freeze({
    backend: request.backend,
    queryId: request.queryId,
    recordType: coordinate.recordType,
    coordinate,
    graphIri: address.graphUri,
    subjectIri: address.subject,
    resultKind: 'bindings',
    resultVariables: Object.freeze(['p', 'o'] as const),
    expectedRowCount,
    rowCeiling,
    responseByteCeiling: MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
    concurrencyClass: RFC64_SEMANTIC_READ_CONCURRENCY_CLASS_V1,
    sparql,
  });
}

/**
 * Fail closed if a would-be dispatched operation differs from the manifest.
 * This is intentionally exact rather than a permissive SPARQL parser: callers
 * have no supported raw-query escape hatch.
 */
export function assertRfc64SemanticReadOperationV1(
  input: unknown,
): asserts input is Rfc64SemanticReadOperationV1 {
  if (!isPlainRecord(input)) {
    fail('rfc64-semantic-read-operation', 'semantic read operation must be a plain object');
  }
  let operation: Readonly<Record<string, unknown>>;
  try {
    operation = snapshotExactDataRecord(input, [
      'backend',
      'concurrencyClass',
      'coordinate',
      'expectedRowCount',
      'graphIri',
      'queryId',
      'recordType',
      'responseByteCeiling',
      'resultKind',
      'resultVariables',
      'rowCeiling',
      'sparql',
      'subjectIri',
    ], 'RFC-64 semantic read operation');
  } catch (cause) {
    fail(
      'rfc64-semantic-read-operation',
      'semantic read operation has an invalid field set',
      cause,
    );
  }
  const expected = compileRfc64SemanticReadOperationV1({
    backend: operation.backend,
    queryId: operation.queryId,
    coordinate: operation.coordinate,
  });
  if (!sameOperation(operation, expected)) {
    fail('rfc64-semantic-read-operation', 'semantic read operation differs from manifest');
  }
}

function snapshotInput(input: unknown): {
  readonly backend: Rfc64SemanticReadBackendV1;
  readonly queryId: Rfc64SemanticReadQueryIdV1;
  readonly coordinate: unknown;
} {
  if (!isPlainRecord(input)) {
    fail('rfc64-semantic-read-schema', 'semantic read input must be a plain object');
  }
  let request: Readonly<Record<string, unknown>>;
  try {
    request = snapshotExactDataRecord(
      input,
      ['backend', 'coordinate', 'queryId'],
      'RFC-64 semantic read input',
    );
  } catch (cause) {
    fail('rfc64-semantic-read-schema', 'semantic read input has an invalid field set', cause);
  }
  if (typeof request.backend !== 'string' || !BACKENDS.has(request.backend)) {
    fail('rfc64-semantic-read-schema', 'semantic read backend is not certified');
  }
  if (typeof request.queryId !== 'string' || !QUERY_IDS.has(request.queryId)) {
    fail('rfc64-semantic-read-query-id', 'semantic read query ID is not in the v1 manifest');
  }
  return Object.freeze({
    backend: request.backend as Rfc64SemanticReadBackendV1,
    queryId: request.queryId as Rfc64SemanticReadQueryIdV1,
    coordinate: request.coordinate,
  });
}

function addressForCoordinate(
  coordinate: Rfc64SemanticRecordCoordinateV1,
): Rfc64SemanticAddressV1 {
  const scope = {
    networkId: coordinate.networkId,
    contextGraphId: coordinate.contextGraphId,
  };
  switch (coordinate.recordType) {
    case 'CurrentAuthorCatalogRefV1':
      return deriveRfc64CurrentAuthorCatalogRefAddressV1({
        ...scope,
        subGraphName: coordinate.subGraphName,
        authorAddress: coordinate.authorAddress,
      });
    case 'AppliedSubgraphSealV1':
      return deriveRfc64SubgraphSemanticAddressesV1({
        ...scope,
        subGraphName: coordinate.subGraphName,
      }).appliedSeal;
    case 'SubgraphMutationGuardV1':
      return deriveRfc64SubgraphSemanticAddressesV1({
        ...scope,
        subGraphName: coordinate.subGraphName,
      }).mutationGuard;
    case 'SubgraphReconcileTargetGuardV1':
      return deriveRfc64SubgraphSemanticAddressesV1({
        ...scope,
        subGraphName: coordinate.subGraphName,
      }).reconcileTarget;
    case 'ContextGraphMutationGuardV1':
      return deriveRfc64ContextGraphSemanticAddressesV1(scope).mutationGuard;
    case 'AppliedSubgraphSetRefV1':
      return deriveRfc64ContextGraphSemanticAddressesV1(scope).appliedSetRef;
    case 'AppliedContextGraphSealV1':
      return deriveRfc64ContextGraphSemanticAddressesV1(scope).appliedSeal;
  }
}

function renderExactSubjectRead(
  address: Rfc64SemanticAddressV1,
  rowCeiling: number,
): string {
  return `SELECT ?p ?o\nWHERE {\n  GRAPH <${address.graphUri}> {\n`
    + `    <${address.subject}> ?p ?o .\n  }\n}\nLIMIT ${rowCeiling}`;
}

function sameOperation(
  actual: Readonly<Record<string, unknown>>,
  expected: Rfc64SemanticReadOperationV1,
): boolean {
  if (
    actual.backend !== expected.backend
    || actual.queryId !== expected.queryId
    || actual.recordType !== expected.recordType
    || actual.graphIri !== expected.graphIri
    || actual.subjectIri !== expected.subjectIri
    || actual.resultKind !== expected.resultKind
    || actual.expectedRowCount !== expected.expectedRowCount
    || actual.rowCeiling !== expected.rowCeiling
    || actual.responseByteCeiling !== expected.responseByteCeiling
    || actual.concurrencyClass !== expected.concurrencyClass
    || actual.sparql !== expected.sparql
    || !sameCoordinate(actual.coordinate, expected.coordinate)
  ) return false;
  const variables = actual.resultVariables;
  if (
    !Array.isArray(variables)
    || Object.getPrototypeOf(variables) !== Array.prototype
    || variables.length !== 2
    || Reflect.ownKeys(variables).length !== 3
  ) return false;
  const p = Object.getOwnPropertyDescriptor(variables, '0');
  const o = Object.getOwnPropertyDescriptor(variables, '1');
  return p?.enumerable === true
    && Object.prototype.hasOwnProperty.call(p, 'value')
    && p.value === 'p'
    && o?.enumerable === true
    && Object.prototype.hasOwnProperty.call(o, 'value')
    && o.value === 'o';
}

function sameCoordinate(
  actual: unknown,
  expected: Rfc64SemanticRecordCoordinateV1,
): boolean {
  if (!isPlainRecord(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedRecord = expected as unknown as Readonly<Record<string, unknown>>;
  const expectedKeys = Object.keys(expectedRecord).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => (
      key === expectedKeys[index]
      && Object.getOwnPropertyDescriptor(actual, key)?.value === expectedRecord[key]
    ));
}

function fail(
  code: Rfc64SemanticReadManifestErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64SemanticReadManifestErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
