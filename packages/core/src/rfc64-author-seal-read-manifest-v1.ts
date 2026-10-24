import {
  assertCanonicalGraphScopedAuthorSealCoordinateV1,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
} from './canonical-graph-scoped-author-seal.js';
import { isPlainRecord, snapshotExactDataRecord } from './sync-wire-objects.js';

export const RFC64_AUTHOR_SEAL_READ_QUERY_ID_V1 = 'SYNC_AUTHOR_SEAL_GET_V1' as const;
export const RFC64_AUTHOR_SEAL_READ_CONCURRENCY_CLASS_V1 =
  'rfc64-author-seal-v1' as const;
export const RFC64_AUTHOR_SEAL_READ_MIN_ROWS_V1 = 14;
export const RFC64_AUTHOR_SEAL_READ_MAX_ROWS_V1 = 15;
export const RFC64_AUTHOR_SEAL_READ_ROW_CEILING_V1 = 16;
export const RFC64_AUTHOR_SEAL_READ_RESPONSE_BYTES_V1 = 64 * 1024;

export interface Rfc64AuthorSealReadTemplateInputV1 {
  readonly coordinate: CanonicalGraphScopedAuthorSealCoordinateV1;
}

export interface Rfc64AuthorSealReadOperationV1 {
  readonly queryId: typeof RFC64_AUTHOR_SEAL_READ_QUERY_ID_V1;
  readonly coordinate: CanonicalGraphScopedAuthorSealCoordinateV1;
  readonly graphIri: string;
  readonly subjectIri: string;
  readonly resultKind: 'bindings';
  readonly resultVariables: readonly ['p', 'o'];
  readonly minimumRowCount: typeof RFC64_AUTHOR_SEAL_READ_MIN_ROWS_V1;
  readonly maximumRowCount: typeof RFC64_AUTHOR_SEAL_READ_MAX_ROWS_V1;
  readonly rowCeiling: typeof RFC64_AUTHOR_SEAL_READ_ROW_CEILING_V1;
  readonly responseByteCeiling: typeof RFC64_AUTHOR_SEAL_READ_RESPONSE_BYTES_V1;
  readonly concurrencyClass: typeof RFC64_AUTHOR_SEAL_READ_CONCURRENCY_CLASS_V1;
  readonly sparql: string;
}

export class Rfc64AuthorSealReadManifestErrorV1 extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(`[rfc64-author-seal-read-schema] ${message}`, options);
    this.name = 'Rfc64AuthorSealReadManifestErrorV1';
  }
}

/** Compile the sole fixed-subject, fixed-graph RFC-64 author-seal read. */
export function compileRfc64AuthorSealReadOperationV1(
  input: unknown,
): Rfc64AuthorSealReadOperationV1 {
  const request = snapshotInput(input);
  const coordinate = snapshotCoordinate(request.coordinate);
  const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1(coordinate);
  return Object.freeze({
    queryId: RFC64_AUTHOR_SEAL_READ_QUERY_ID_V1,
    coordinate,
    graphIri: placement.metaGraph,
    subjectIri: placement.subject,
    resultKind: 'bindings' as const,
    resultVariables: Object.freeze(['p', 'o'] as const),
    minimumRowCount: RFC64_AUTHOR_SEAL_READ_MIN_ROWS_V1,
    maximumRowCount: RFC64_AUTHOR_SEAL_READ_MAX_ROWS_V1,
    rowCeiling: RFC64_AUTHOR_SEAL_READ_ROW_CEILING_V1,
    responseByteCeiling: RFC64_AUTHOR_SEAL_READ_RESPONSE_BYTES_V1,
    concurrencyClass: RFC64_AUTHOR_SEAL_READ_CONCURRENCY_CLASS_V1,
    sparql: `SELECT ?p ?o\nWHERE {\n  GRAPH <${placement.metaGraph}> {\n`
      + `    <${placement.subject}> ?p ?o .\n  }\n}\nLIMIT ${RFC64_AUTHOR_SEAL_READ_ROW_CEILING_V1}`,
  });
}

function snapshotInput(input: unknown): Readonly<{ coordinate: unknown }> {
  if (!isPlainRecord(input)) fail('author-seal read input must be a plain object');
  try {
    const value = snapshotExactDataRecord(input, ['coordinate'], 'RFC-64 author-seal read input');
    return Object.freeze({ coordinate: value.coordinate });
  } catch (cause) {
    fail('author-seal read input has an invalid field set', cause);
  }
}

function snapshotCoordinate(input: unknown): CanonicalGraphScopedAuthorSealCoordinateV1 {
  if (!isPlainRecord(input)) fail('author-seal coordinate must be a plain object');
  let value: Readonly<Record<string, unknown>>;
  try {
    value = snapshotExactDataRecord(input, [
      'assertionCoordinate',
      'authorAddress',
      'contextGraphId',
      'subGraphName',
    ], 'RFC-64 author-seal coordinate');
  } catch (cause) {
    fail('author-seal coordinate has an invalid field set', cause);
  }
  const coordinate = Object.freeze({
    assertionCoordinate: value.assertionCoordinate,
    authorAddress: value.authorAddress,
    contextGraphId: value.contextGraphId,
    subGraphName: value.subGraphName,
  });
  try {
    assertCanonicalGraphScopedAuthorSealCoordinateV1(coordinate);
  } catch (cause) {
    fail('author-seal coordinate is invalid', cause);
  }
  return coordinate;
}

function fail(message: string, cause?: unknown): never {
  throw new Rfc64AuthorSealReadManifestErrorV1(
    message,
    cause === undefined ? {} : { cause },
  );
}
