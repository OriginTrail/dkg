import {
  deriveRfc64SemanticRecordAddressFromCoordinateV1,
  MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
  RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1,
  snapshotRfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticRecordTypeV1,
} from './rfc64-semantic-records-v1.js';
import { type Rfc64SemanticAddressV1 } from './rfc64-semantic-addresses-v1.js';

export const RFC64_SEMANTIC_READ_QUERY_ID_BY_RECORD_TYPE_V1 = Object.freeze({
  CurrentAuthorCatalogRefV1: 'SYNC_HEAD_REF_GET_V1',
  SubgraphMutationGuardV1: 'SYNC_MUTATION_GUARD_GET_V1',
  ContextGraphMutationGuardV1: 'SYNC_MUTATION_GUARD_GET_V1',
  SubgraphReconcileTargetGuardV1: 'SYNC_RECONCILE_TARGET_GET_V1',
  AppliedSubgraphSealV1: 'SYNC_APPLIED_SEAL_GET_V1',
  AppliedSubgraphSetRefV1: 'SYNC_APPLIED_SET_GET_V1',
  AppliedContextGraphSealV1: 'SYNC_APPLIED_CG_SEAL_GET_V1',
} as const satisfies Record<Rfc64SemanticRecordTypeV1, string>);

export type Rfc64SemanticReadQueryIdV1 =
  (typeof RFC64_SEMANTIC_READ_QUERY_ID_BY_RECORD_TYPE_V1)[Rfc64SemanticRecordTypeV1];

export const RFC64_SEMANTIC_READ_QUERY_IDS_V1 = Object.freeze([
  ...new Set(Object.values(RFC64_SEMANTIC_READ_QUERY_ID_BY_RECORD_TYPE_V1)),
] as Rfc64SemanticReadQueryIdV1[]);

export const RFC64_SEMANTIC_READ_CONCURRENCY_CLASS_V1 =
  'rfc64-semantic-control-v1' as const;

/** Backend-neutral semantic read operation used by new consumers. */
export interface Rfc64SemanticReadOperationV2 {
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
  | 'rfc64-semantic-read-schema';

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

/**
 * Compile one closed, exact-subject RFC-64 semantic read operation.
 *
 * The record coordinate is the sole discriminant: the compiler derives the
 * matching query ID and canonical address. Backend routing is intentionally
 * absent from this contract.
 */
export function compileRfc64SemanticReadOperationV2(
  input: unknown,
): Rfc64SemanticReadOperationV2 {
  let coordinate: Rfc64SemanticRecordCoordinateV1;
  try {
    coordinate = snapshotRfc64SemanticRecordCoordinateV1(input);
  } catch (cause) {
    fail('semantic read coordinate is invalid', cause);
  }
  const queryId = queryIdForRecordType(coordinate.recordType);
  const address = deriveRfc64SemanticRecordAddressFromCoordinateV1(coordinate);
  const expectedRowCount = RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1[coordinate.recordType];
  const rowCeiling = expectedRowCount + 1;
  return Object.freeze({
    queryId,
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
    sparql: renderExactSubjectRead(address, rowCeiling),
  });
}

function queryIdForRecordType(
  recordType: Rfc64SemanticRecordTypeV1,
): Rfc64SemanticReadQueryIdV1 {
  return RFC64_SEMANTIC_READ_QUERY_ID_BY_RECORD_TYPE_V1[recordType];
}

function renderExactSubjectRead(
  address: Rfc64SemanticAddressV1,
  rowCeiling: number,
): string {
  return `SELECT ?p ?o\nWHERE {\n  GRAPH <${address.graphUri}> {\n`
    + `    <${address.subject}> ?p ?o .\n  }\n}\nLIMIT ${rowCeiling}`;
}

function fail(message: string, cause?: unknown): never {
  throw new Rfc64SemanticReadManifestErrorV1(
    'rfc64-semantic-read-schema',
    message,
    cause === undefined ? {} : { cause },
  );
}
