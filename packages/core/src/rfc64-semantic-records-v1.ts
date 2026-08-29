import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import {
  assertAuthorLaneContextGraphIdV1,
  assertAuthorLaneSubGraphNameV1,
  type ContextGraphIdV1,
  type SubGraphNameV1,
} from './author-lane-scope-v1.js';
import type {
  CanonicalAuthorSealStoreObjectV1,
  CanonicalAuthorSealStoreRowV1,
  CanonicalIsoUtcMillisV1,
} from './canonical-graph-scoped-author-seal.js';
import {
  deriveRfc64ContextGraphSemanticAddressesV1,
  deriveRfc64CurrentAuthorCatalogRefAddressV1,
  deriveRfc64SubgraphSemanticAddressesV1,
  type Rfc64SemanticAddressV1,
} from './rfc64-semantic-addresses-v1.js';
import { isSafeIri } from './sparql-safe.js';
import {
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  type ChainIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import {
  assertNetworkIdV1,
  type NetworkIdV1,
} from './sync-wire-identifiers.js';
import {
  isPlainRecord,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';

const DKG_ONTOLOGY = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_STRING_IRI = `${XSD}string`;
const XSD_INTEGER_IRI = `${XSD}integer`;
const XSD_HEX_BINARY_IRI = `${XSD}hexBinary`;
const XSD_DATE_TIME_IRI = `${XSD}dateTime`;
const UTF8 = new TextEncoder();
const CANONICAL_UTC_MILLIS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

export const RFC64_SEMANTIC_NULL_IRI_V1 = 'urn:dkg:sync:null' as const;
export const RFC64_DIGEST_LIST_DATATYPE_IRI_V1 =
  `${DKG_ONTOLOGY}digestListV1` as const;
export const MAX_RFC64_PENDING_TARGET_DIGESTS_V1 = 64;
export const MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1 = 64 * 1024;

export const RFC64_SEMANTIC_PREDICATES_V1 = Object.freeze({
  NETWORK_ID: `${DKG_ONTOLOGY}networkId`,
  CONTEXT_GRAPH_ID: `${DKG_ONTOLOGY}contextGraphId`,
  GOVERNANCE_CHAIN_ID: `${DKG_ONTOLOGY}governanceChainId`,
  GOVERNANCE_CONTRACT_ADDRESS: `${DKG_ONTOLOGY}governanceContractAddress`,
  OWNERSHIP_TRANSITION_DIGEST: `${DKG_ONTOLOGY}ownershipTransitionDigest`,
  SUBGRAPH_NAME: `${DKG_ONTOLOGY}subGraphName`,
  AUTHOR_ADDRESS: `${DKG_ONTOLOGY}authorAddress`,
  CATALOG_ERA: `${DKG_ONTOLOGY}catalogEra`,
  CATALOG_VERSION: `${DKG_ONTOLOGY}catalogVersion`,
  CATALOG_HEAD_DIGEST: `${DKG_ONTOLOGY}catalogHeadDigest`,
  CHECKPOINT_ERA: `${DKG_ONTOLOGY}checkpointEra`,
  CHECKPOINT_VERSION: `${DKG_ONTOLOGY}checkpointVersion`,
  CHECKPOINT_DIGEST: `${DKG_ONTOLOGY}checkpointDigest`,
  MUTATION_GENERATION: `${DKG_ONTOLOGY}mutationGeneration`,
  APPLIED_AT: `${DKG_ONTOLOGY}appliedAt`,
  GENERATION: `${DKG_ONTOLOGY}generation`,
  BASELINE_SUBGRAPH_CHECKPOINT_DIGEST:
    `${DKG_ONTOLOGY}baselineSubgraphCheckpointDigest`,
  ACTIVE_TARGET_SUBGRAPH_CHECKPOINT_DIGEST:
    `${DKG_ONTOLOGY}activeTargetSubgraphCheckpointDigest`,
  PENDING_TARGET_CHECKPOINT_DIGESTS:
    `${DKG_ONTOLOGY}pendingTargetCheckpointDigests`,
  SUBGRAPH_INDEX_ERA: `${DKG_ONTOLOGY}subgraphIndexEra`,
  SUBGRAPH_INDEX_VERSION: `${DKG_ONTOLOGY}subgraphIndexVersion`,
  SUBGRAPH_COUNT: `${DKG_ONTOLOGY}subgraphCount`,
  APPLIED_DIRECTORY_ROOT_DIGEST: `${DKG_ONTOLOGY}appliedDirectoryRootDigest`,
  POLICY_DIGEST: `${DKG_ONTOLOGY}policyDigest`,
  CHAIN_COVERAGE_DIGEST: `${DKG_ONTOLOGY}chainCoverageDigest`,
} as const);

export type Rfc64SemanticRecordTypeV1 =
  | 'CurrentAuthorCatalogRefV1'
  | 'AppliedSubgraphSealV1'
  | 'SubgraphMutationGuardV1'
  | 'ContextGraphMutationGuardV1'
  | 'SubgraphReconcileTargetGuardV1'
  | 'AppliedSubgraphSetRefV1'
  | 'AppliedContextGraphSealV1';

interface Rfc64SemanticScopeFieldsV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
}

interface Rfc64SubgraphSemanticScopeFieldsV1 extends Rfc64SemanticScopeFieldsV1 {
  readonly subGraphName: SubGraphNameV1 | null;
}

export interface CurrentAuthorCatalogRefV1 extends Rfc64SubgraphSemanticScopeFieldsV1 {
  readonly governanceChainId: ChainIdV1 | null;
  readonly governanceContractAddress: EvmAddressV1 | null;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly catalogEra: DecimalU64V1;
  readonly catalogVersion: DecimalU64V1;
  readonly catalogHeadDigest: Digest32V1;
}

export interface AppliedSubgraphSealV1 extends Rfc64SubgraphSemanticScopeFieldsV1 {
  readonly checkpointEra: DecimalU64V1;
  readonly checkpointVersion: DecimalU64V1;
  readonly checkpointDigest: Digest32V1;
  readonly mutationGeneration: DecimalU64V1;
  readonly appliedAt: CanonicalIsoUtcMillisV1;
}

export interface SubgraphMutationGuardV1 extends Rfc64SubgraphSemanticScopeFieldsV1 {
  readonly generation: DecimalU64V1;
}

export interface ContextGraphMutationGuardV1 extends Rfc64SemanticScopeFieldsV1 {
  readonly generation: DecimalU64V1;
}

export interface SubgraphReconcileTargetGuardV1
  extends Rfc64SubgraphSemanticScopeFieldsV1 {
  readonly generation: DecimalU64V1;
  readonly baselineSubgraphCheckpointDigest: Digest32V1 | null;
  readonly activeTargetSubgraphCheckpointDigest: Digest32V1;
  readonly pendingTargetCheckpointDigests: readonly Digest32V1[];
}

export interface AppliedSubgraphSetRefV1 extends Rfc64SemanticScopeFieldsV1 {
  readonly generation: DecimalU64V1;
  readonly subgraphIndexEra: DecimalU64V1;
  readonly subgraphIndexVersion: DecimalU64V1;
  readonly subgraphCount: DecimalU64V1;
  readonly appliedDirectoryRootDigest: Digest32V1;
}

export interface AppliedContextGraphSealV1 extends Rfc64SemanticScopeFieldsV1 {
  readonly checkpointEra: DecimalU64V1;
  readonly checkpointVersion: DecimalU64V1;
  readonly checkpointDigest: Digest32V1;
  readonly policyDigest: Digest32V1;
  readonly chainCoverageDigest: Digest32V1;
  readonly mutationGeneration: DecimalU64V1;
  readonly appliedAt: CanonicalIsoUtcMillisV1;
}

export type Rfc64SemanticRecordV1 =
  | { readonly recordType: 'CurrentAuthorCatalogRefV1'; readonly value: CurrentAuthorCatalogRefV1 }
  | { readonly recordType: 'AppliedSubgraphSealV1'; readonly value: AppliedSubgraphSealV1 }
  | { readonly recordType: 'SubgraphMutationGuardV1'; readonly value: SubgraphMutationGuardV1 }
  | { readonly recordType: 'ContextGraphMutationGuardV1'; readonly value: ContextGraphMutationGuardV1 }
  | {
      readonly recordType: 'SubgraphReconcileTargetGuardV1';
      readonly value: SubgraphReconcileTargetGuardV1;
    }
  | { readonly recordType: 'AppliedSubgraphSetRefV1'; readonly value: AppliedSubgraphSetRefV1 }
  | {
      readonly recordType: 'AppliedContextGraphSealV1';
      readonly value: AppliedContextGraphSealV1;
    };

export type Rfc64SemanticRecordCoordinateV1 =
  | ({ readonly recordType: 'CurrentAuthorCatalogRefV1'; readonly authorAddress: EvmAddressV1 }
    & Rfc64SubgraphSemanticScopeFieldsV1)
  | ({ readonly recordType:
      | 'AppliedSubgraphSealV1'
      | 'SubgraphMutationGuardV1'
      | 'SubgraphReconcileTargetGuardV1' }
    & Rfc64SubgraphSemanticScopeFieldsV1)
  | ({ readonly recordType:
      | 'ContextGraphMutationGuardV1'
      | 'AppliedSubgraphSetRefV1'
      | 'AppliedContextGraphSealV1' }
    & Rfc64SemanticScopeFieldsV1);

export type Rfc64SemanticStoreObjectV1 = CanonicalAuthorSealStoreObjectV1;
export type Rfc64SemanticStoreRowV1 = CanonicalAuthorSealStoreRowV1;

export interface Rfc64SemanticRenderedRowV1 {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly graph: string;
}

export interface DecodedRfc64SemanticRecordV1 {
  readonly record: Rfc64SemanticRecordV1;
  readonly address: Rfc64SemanticAddressV1;
  readonly rows: readonly Rfc64SemanticStoreRowV1[];
}

export type Rfc64SemanticRecordErrorCodeV1 =
  | 'rfc64-semantic-schema'
  | 'rfc64-semantic-coordinate'
  | 'rfc64-semantic-scalar'
  | 'rfc64-semantic-row-schema'
  | 'rfc64-semantic-row-cardinality'
  | 'rfc64-semantic-row-term'
  | 'rfc64-semantic-too-large';

export class Rfc64SemanticRecordErrorV1 extends Error {
  constructor(
    readonly code: Rfc64SemanticRecordErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64SemanticRecordErrorV1';
  }
}

type FieldKind =
  | 'string'
  | 'integer'
  | 'digest'
  | 'address'
  | 'date-time'
  | 'nullable-string'
  | 'nullable-integer'
  | 'nullable-digest'
  | 'nullable-address'
  | 'digest-list';

interface FieldSpec {
  readonly key: string;
  readonly predicate: string;
  readonly kind: FieldKind;
}

const P = RFC64_SEMANTIC_PREDICATES_V1;
const COMMON_SCOPE_FIELDS = [
  { key: 'networkId', predicate: P.NETWORK_ID, kind: 'string' },
  { key: 'contextGraphId', predicate: P.CONTEXT_GRAPH_ID, kind: 'string' },
] as const satisfies readonly FieldSpec[];
const SUBGRAPH_FIELD = {
  key: 'subGraphName', predicate: P.SUBGRAPH_NAME, kind: 'nullable-string',
} as const satisfies FieldSpec;

const RECORD_FIELDS = Object.freeze({
  CurrentAuthorCatalogRefV1: [
    ...COMMON_SCOPE_FIELDS,
    { key: 'governanceChainId', predicate: P.GOVERNANCE_CHAIN_ID, kind: 'nullable-integer' },
    {
      key: 'governanceContractAddress',
      predicate: P.GOVERNANCE_CONTRACT_ADDRESS,
      kind: 'nullable-address',
    },
    {
      key: 'ownershipTransitionDigest',
      predicate: P.OWNERSHIP_TRANSITION_DIGEST,
      kind: 'nullable-digest',
    },
    SUBGRAPH_FIELD,
    { key: 'authorAddress', predicate: P.AUTHOR_ADDRESS, kind: 'address' },
    { key: 'catalogEra', predicate: P.CATALOG_ERA, kind: 'integer' },
    { key: 'catalogVersion', predicate: P.CATALOG_VERSION, kind: 'integer' },
    { key: 'catalogHeadDigest', predicate: P.CATALOG_HEAD_DIGEST, kind: 'digest' },
  ],
  AppliedSubgraphSealV1: [
    ...COMMON_SCOPE_FIELDS,
    SUBGRAPH_FIELD,
    { key: 'checkpointEra', predicate: P.CHECKPOINT_ERA, kind: 'integer' },
    { key: 'checkpointVersion', predicate: P.CHECKPOINT_VERSION, kind: 'integer' },
    { key: 'checkpointDigest', predicate: P.CHECKPOINT_DIGEST, kind: 'digest' },
    { key: 'mutationGeneration', predicate: P.MUTATION_GENERATION, kind: 'integer' },
    { key: 'appliedAt', predicate: P.APPLIED_AT, kind: 'date-time' },
  ],
  SubgraphMutationGuardV1: [
    ...COMMON_SCOPE_FIELDS,
    SUBGRAPH_FIELD,
    { key: 'generation', predicate: P.GENERATION, kind: 'integer' },
  ],
  ContextGraphMutationGuardV1: [
    ...COMMON_SCOPE_FIELDS,
    { key: 'generation', predicate: P.GENERATION, kind: 'integer' },
  ],
  SubgraphReconcileTargetGuardV1: [
    ...COMMON_SCOPE_FIELDS,
    SUBGRAPH_FIELD,
    { key: 'generation', predicate: P.GENERATION, kind: 'integer' },
    {
      key: 'baselineSubgraphCheckpointDigest',
      predicate: P.BASELINE_SUBGRAPH_CHECKPOINT_DIGEST,
      kind: 'nullable-digest',
    },
    {
      key: 'activeTargetSubgraphCheckpointDigest',
      predicate: P.ACTIVE_TARGET_SUBGRAPH_CHECKPOINT_DIGEST,
      kind: 'digest',
    },
    {
      key: 'pendingTargetCheckpointDigests',
      predicate: P.PENDING_TARGET_CHECKPOINT_DIGESTS,
      kind: 'digest-list',
    },
  ],
  AppliedSubgraphSetRefV1: [
    ...COMMON_SCOPE_FIELDS,
    { key: 'generation', predicate: P.GENERATION, kind: 'integer' },
    { key: 'subgraphIndexEra', predicate: P.SUBGRAPH_INDEX_ERA, kind: 'integer' },
    { key: 'subgraphIndexVersion', predicate: P.SUBGRAPH_INDEX_VERSION, kind: 'integer' },
    { key: 'subgraphCount', predicate: P.SUBGRAPH_COUNT, kind: 'integer' },
    {
      key: 'appliedDirectoryRootDigest',
      predicate: P.APPLIED_DIRECTORY_ROOT_DIGEST,
      kind: 'digest',
    },
  ],
  AppliedContextGraphSealV1: [
    ...COMMON_SCOPE_FIELDS,
    { key: 'checkpointEra', predicate: P.CHECKPOINT_ERA, kind: 'integer' },
    { key: 'checkpointVersion', predicate: P.CHECKPOINT_VERSION, kind: 'integer' },
    { key: 'checkpointDigest', predicate: P.CHECKPOINT_DIGEST, kind: 'digest' },
    { key: 'policyDigest', predicate: P.POLICY_DIGEST, kind: 'digest' },
    { key: 'chainCoverageDigest', predicate: P.CHAIN_COVERAGE_DIGEST, kind: 'digest' },
    { key: 'mutationGeneration', predicate: P.MUTATION_GENERATION, kind: 'integer' },
    { key: 'appliedAt', predicate: P.APPLIED_AT, kind: 'date-time' },
  ],
} as const satisfies Record<Rfc64SemanticRecordTypeV1, readonly FieldSpec[]>);

const RECORD_TYPES = new Set<Rfc64SemanticRecordTypeV1>(
  Object.keys(RECORD_FIELDS) as Rfc64SemanticRecordTypeV1[],
);

/**
 * Project one validated semantic record into exact backend-neutral typed rows.
 * The graph and subject are always derived from the record's validated scope.
 */
export function projectRfc64SemanticRecordStoreRowsV1(
  input: unknown,
): readonly Rfc64SemanticStoreRowV1[] {
  const record = snapshotRfc64SemanticRecordV1(input);
  const address = deriveSemanticRecordAddress(record);
  const fields = RECORD_FIELDS[record.recordType];
  const value = record.value as unknown as Record<string, unknown>;
  return Object.freeze(fields.map((field) => Object.freeze({
    subjectIri: address.subject,
    predicateIri: field.predicate,
    graphIri: address.graphUri,
    object: encodeObject(field.kind, value[field.key]),
  })));
}

/**
 * Strict order-independent inverse over one expected fixed record address.
 * Unknown, missing, duplicate, oversized, or noncanonical rows fail closed.
 */
export function decodeRfc64SemanticRecordStoreRowsV1(
  rows: unknown,
  expectedCoordinate: unknown,
): DecodedRfc64SemanticRecordV1 {
  const coordinate = snapshotRfc64SemanticRecordCoordinateV1(expectedCoordinate);
  const address = deriveCoordinateAddress(coordinate);
  const fields = RECORD_FIELDS[coordinate.recordType];
  const typedRows = snapshotSemanticRows(rows, fields.length);
  const allowed = new Map<string, FieldSpec>(
    fields.map((field) => [field.predicate, field]),
  );
  const byPredicate = new Map<string, Rfc64SemanticStoreRowV1>();
  for (const row of typedRows) {
    if (row.subjectIri !== address.subject || row.graphIri !== address.graphUri) {
      fail('rfc64-semantic-row-term', 'semantic record row has the wrong subject or graph');
    }
    const field = allowed.get(row.predicateIri);
    if (!field) {
      fail(
        'rfc64-semantic-row-cardinality',
        `unknown semantic record predicate ${row.predicateIri}`,
      );
    }
    if (byPredicate.has(row.predicateIri)) {
      fail(
        'rfc64-semantic-row-cardinality',
        `duplicate semantic record predicate ${row.predicateIri}`,
      );
    }
    byPredicate.set(row.predicateIri, row);
  }

  const raw: Record<string, unknown> = {};
  for (const field of fields) {
    const row = byPredicate.get(field.predicate);
    if (!row) {
      fail(
        'rfc64-semantic-row-cardinality',
        `missing semantic record predicate ${field.predicate}`,
      );
    }
    raw[field.key] = decodeObject(field.kind, row.object, field.key);
  }
  const record = snapshotRfc64SemanticRecordV1({
    recordType: coordinate.recordType,
    value: raw,
  });
  assertRecordMatchesCoordinate(record, coordinate);
  const canonicalRows = projectRfc64SemanticRecordStoreRowsV1(record);
  for (const expected of canonicalRows) {
    const actual = byPredicate.get(expected.predicateIri);
    if (!actual || !sameStoreRow(actual, expected)) {
      fail(
        'rfc64-semantic-row-term',
        `noncanonical RDF term for predicate ${expected.predicateIri}`,
      );
    }
  }
  return Object.freeze({
    record,
    address,
    rows: canonicalRows,
  });
}

/** Render one exact typed semantic row into canonical flattened RDF terms. */
export function renderRfc64SemanticStoreRowV1(
  input: unknown,
): Rfc64SemanticRenderedRowV1 {
  const row = snapshotSemanticStoreRow(input);
  let object: string;
  if (row.object.kind === 'named-node') {
    object = `<${row.object.value}>`;
  } else {
    const literal = JSON.stringify(row.object.value);
    object = row.object.datatypeIri === XSD_STRING_IRI
      ? literal
      : `${literal}^^<${row.object.datatypeIri}>`;
  }
  return Object.freeze({
    subject: row.subjectIri,
    predicate: row.predicateIri,
    object,
    graph: row.graphIri,
  });
}

export function snapshotRfc64SemanticRecordV1(input: unknown): Rfc64SemanticRecordV1 {
  const envelope = snapshotClosed(input, ['recordType', 'value'], 'semantic record envelope');
  if (typeof envelope.recordType !== 'string' || !RECORD_TYPES.has(
    envelope.recordType as Rfc64SemanticRecordTypeV1,
  )) {
    fail('rfc64-semantic-schema', 'semantic record has an unknown recordType');
  }
  const recordType = envelope.recordType as Rfc64SemanticRecordTypeV1;
  const fields = RECORD_FIELDS[recordType];
  const value = snapshotClosed(
    envelope.value,
    fields.map((field) => field.key),
    recordType,
  );
  validateRecordValue(recordType, value);
  const immutableValue = recordType === 'SubgraphReconcileTargetGuardV1'
    ? Object.freeze({
        ...value,
        pendingTargetCheckpointDigests: Object.freeze([
          ...(value.pendingTargetCheckpointDigests as readonly Digest32V1[]),
        ]),
      })
    : Object.freeze(value);
  return Object.freeze({
    recordType,
    value: immutableValue,
  }) as unknown as Rfc64SemanticRecordV1;
}

export function snapshotRfc64SemanticRecordCoordinateV1(
  input: unknown,
): Rfc64SemanticRecordCoordinateV1 {
  if (!isPlainRecord(input)) {
    fail('rfc64-semantic-coordinate', 'semantic record coordinate must be a plain object');
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(input, 'recordType');
  const recordType = typeDescriptor?.enumerable
    && Object.prototype.hasOwnProperty.call(typeDescriptor, 'value')
    ? typeDescriptor.value
    : undefined;
  if (typeof recordType !== 'string' || !RECORD_TYPES.has(recordType as Rfc64SemanticRecordTypeV1)) {
    fail('rfc64-semantic-coordinate', 'semantic record coordinate has an unknown recordType');
  }
  const keys = recordType === 'CurrentAuthorCatalogRefV1'
    ? ['authorAddress', 'contextGraphId', 'networkId', 'recordType', 'subGraphName']
    : isSubgraphRecordType(recordType as Rfc64SemanticRecordTypeV1)
      ? ['contextGraphId', 'networkId', 'recordType', 'subGraphName']
      : ['contextGraphId', 'networkId', 'recordType'];
  let coordinate: Readonly<Record<string, unknown>>;
  try {
    coordinate = snapshotExactDataRecord(input, keys, 'semantic record coordinate');
  } catch (cause) {
    fail(
      'rfc64-semantic-coordinate',
      'semantic record coordinate has an invalid field set',
      cause,
    );
  }
  scalar(() => assertNetworkIdV1(coordinate.networkId), 'networkId');
  coordinateScalar(() => assertAuthorLaneContextGraphIdV1(coordinate.contextGraphId));
  if ('subGraphName' in coordinate && coordinate.subGraphName !== null) {
    coordinateScalar(() => assertAuthorLaneSubGraphNameV1(coordinate.subGraphName));
  }
  if ('authorAddress' in coordinate) {
    scalar(() => assertCanonicalEvmAddress(coordinate.authorAddress, 'authorAddress'), 'authorAddress');
  }
  return Object.freeze(coordinate) as unknown as Rfc64SemanticRecordCoordinateV1;
}

function validateRecordValue(
  recordType: Rfc64SemanticRecordTypeV1,
  value: Readonly<Record<string, unknown>>,
): void {
  scalar(() => assertNetworkIdV1(value.networkId), 'networkId');
  coordinateScalar(() => assertAuthorLaneContextGraphIdV1(value.contextGraphId));
  if ('subGraphName' in value && value.subGraphName !== null) {
    coordinateScalar(() => assertAuthorLaneSubGraphNameV1(value.subGraphName));
  }
  for (const field of RECORD_FIELDS[recordType]) {
    const current = value[field.key];
    switch (field.kind) {
      case 'string':
      case 'nullable-string':
        break;
      case 'integer':
        scalar(() => assertCanonicalDecimalU64(current, field.key), field.key);
        break;
      case 'nullable-integer':
        if (current !== null) {
          scalar(() => assertCanonicalChainId(current, field.key), field.key);
        }
        break;
      case 'digest':
        scalar(() => assertCanonicalDigest(current, field.key), field.key);
        break;
      case 'nullable-digest':
        if (current !== null) scalar(() => assertCanonicalDigest(current, field.key), field.key);
        break;
      case 'address':
        scalar(() => assertCanonicalEvmAddress(current, field.key), field.key);
        break;
      case 'nullable-address':
        if (current !== null) scalar(() => assertCanonicalEvmAddress(current, field.key), field.key);
        break;
      case 'date-time':
        assertCanonicalUtcMillis(current, field.key);
        break;
      case 'digest-list':
        assertPendingDigestList(current);
        break;
    }
  }
  if (recordType === 'CurrentAuthorCatalogRefV1') {
    const chainIsNull = value.governanceChainId === null;
    const contractIsNull = value.governanceContractAddress === null;
    if (chainIsNull !== contractIsNull) {
      fail(
        'rfc64-semantic-scalar',
        'governanceChainId and governanceContractAddress must both be null or both non-null',
      );
    }
  }
}

function encodeObject(kind: FieldKind, value: unknown): Rfc64SemanticStoreObjectV1 {
  if (value === null) return namedNode(RFC64_SEMANTIC_NULL_IRI_V1);
  switch (kind) {
    case 'string':
    case 'nullable-string':
    case 'address':
    case 'nullable-address':
      return literal(value as string, XSD_STRING_IRI);
    case 'integer':
    case 'nullable-integer':
      return literal(value as string, XSD_INTEGER_IRI);
    case 'digest':
    case 'nullable-digest':
      return literal((value as string).slice(2), XSD_HEX_BINARY_IRI);
    case 'date-time':
      return literal(value as string, XSD_DATE_TIME_IRI);
    case 'digest-list':
      return literal(canonicalizeJson(value as CanonicalJsonValue, {
        maxBytes: 8192,
        maxDepth: 1,
      }), RFC64_DIGEST_LIST_DATATYPE_IRI_V1);
  }
}

function decodeObject(kind: FieldKind, object: Rfc64SemanticStoreObjectV1, label: string): unknown {
  if (kind.startsWith('nullable-') && isExactNullObject(object)) return null;
  if (kind === 'digest-list') {
    const value = exactLiteralValue(object, RFC64_DIGEST_LIST_DATATYPE_IRI_V1, label);
    let parsed: CanonicalJsonValue;
    try {
      parsed = parseCanonicalJson(value, { maxBytes: 8192, maxDepth: 1 });
    } catch (cause) {
      fail('rfc64-semantic-row-term', `${label} is not an exact canonical digest list`, cause);
    }
    assertPendingDigestList(parsed);
    return parsed;
  }
  switch (kind) {
    case 'string':
    case 'nullable-string':
    case 'address':
    case 'nullable-address':
      return exactLiteralValue(object, XSD_STRING_IRI, label);
    case 'integer':
    case 'nullable-integer':
      return exactLiteralValue(object, XSD_INTEGER_IRI, label);
    case 'digest':
    case 'nullable-digest': {
      const value = exactLiteralValue(object, XSD_HEX_BINARY_IRI, label);
      if (!/^[0-9a-f]{64}$/.test(value)) {
        fail('rfc64-semantic-row-term', `${label} is not exact lowercase xsd:hexBinary`);
      }
      return `0x${value}`;
    }
    case 'date-time':
      return exactLiteralValue(object, XSD_DATE_TIME_IRI, label);
  }
}

function snapshotSemanticRows(
  input: unknown,
  expectedLength: number,
): readonly Rfc64SemanticStoreRowV1[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    fail('rfc64-semantic-row-schema', 'semantic record rows must be an ordinary Array');
  }
  if (input.length !== expectedLength) {
    fail(
      'rfc64-semantic-row-cardinality',
      `semantic record requires exactly ${expectedLength} rows`,
    );
  }
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== input.length + 1
    || !ownKeys.includes('length')
  ) {
    fail('rfc64-semantic-row-schema', 'semantic record rows must be dense and unadorned');
  }
  let totalBytes = 0;
  const result: Rfc64SemanticStoreRowV1[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('rfc64-semantic-row-schema', 'semantic record rows must use data properties');
    }
    const row = snapshotSemanticStoreRow(descriptor.value);
    totalBytes += storeRowByteLength(row);
    if (totalBytes > MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1) {
      fail('rfc64-semantic-too-large', 'semantic record response exceeds 64 KiB');
    }
    result.push(row);
  }
  return Object.freeze(result);
}

function snapshotSemanticStoreRow(input: unknown): Rfc64SemanticStoreRowV1 {
  const row = snapshotRowClosed(
    input,
    ['graphIri', 'object', 'predicateIri', 'subjectIri'],
    'semantic store row',
  );
  for (const key of ['subjectIri', 'predicateIri', 'graphIri'] as const) {
    if (typeof row[key] !== 'string' || !isSafeIri(row[key])) {
      fail('rfc64-semantic-row-term', `${key} must be one bare safe IRI`);
    }
  }
  if (!isPlainRecord(row.object)) {
    fail('rfc64-semantic-row-schema', 'semantic store object must be a plain object');
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(row.object, 'kind');
  const kind = kindDescriptor?.enumerable
    && Object.prototype.hasOwnProperty.call(kindDescriptor, 'value')
    ? kindDescriptor.value
    : undefined;
  if (kind === 'named-node') {
    const object = snapshotRowClosed(row.object, ['kind', 'value'], 'semantic named-node object');
    if (typeof object.value !== 'string' || !isSafeIri(object.value)) {
      fail('rfc64-semantic-row-term', 'semantic named-node object must be one bare safe IRI');
    }
    return Object.freeze({
      subjectIri: row.subjectIri as string,
      predicateIri: row.predicateIri as string,
      graphIri: row.graphIri as string,
      object: namedNode(object.value),
    });
  }
  if (kind === 'literal') {
    const object = snapshotRowClosed(
      row.object,
      ['datatypeIri', 'kind', 'value'],
      'semantic literal object',
    );
    if (
      typeof object.value !== 'string'
      || typeof object.datatypeIri !== 'string'
      || !isSafeIri(object.datatypeIri)
    ) {
      fail('rfc64-semantic-row-term', 'semantic literal object is malformed');
    }
    return Object.freeze({
      subjectIri: row.subjectIri as string,
      predicateIri: row.predicateIri as string,
      graphIri: row.graphIri as string,
      object: literal(object.value, object.datatypeIri),
    });
  }
  fail('rfc64-semantic-row-schema', 'semantic store object has an unsupported kind');
}

function snapshotClosed(
  input: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(input)) {
    fail('rfc64-semantic-schema', `${label} must be a plain object`);
  }
  try {
    return snapshotExactDataRecord(input, keys, label);
  } catch (cause) {
    fail('rfc64-semantic-schema', `${label} has an invalid field set`, cause);
  }
}

function snapshotRowClosed(
  input: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(input)) {
    fail('rfc64-semantic-row-schema', `${label} must be a plain object`);
  }
  try {
    return snapshotExactDataRecord(input, keys, label);
  } catch (cause) {
    fail('rfc64-semantic-row-schema', `${label} has an invalid field set`, cause);
  }
}

function deriveSemanticRecordAddress(record: Rfc64SemanticRecordV1): Rfc64SemanticAddressV1 {
  return deriveCoordinateAddress(coordinateFromRecord(record));
}

function deriveCoordinateAddress(
  coordinate: Rfc64SemanticRecordCoordinateV1,
): Rfc64SemanticAddressV1 {
  const scope = {
    networkId: coordinate.networkId,
    contextGraphId: coordinate.contextGraphId,
  };
  if (coordinate.recordType === 'CurrentAuthorCatalogRefV1') {
    return deriveRfc64CurrentAuthorCatalogRefAddressV1({
      ...scope,
      subGraphName: coordinate.subGraphName,
      authorAddress: coordinate.authorAddress,
    });
  }
  if (isSubgraphRecordType(coordinate.recordType)) {
    const subgraphCoordinate = coordinate as Extract<
      Rfc64SemanticRecordCoordinateV1,
      { readonly subGraphName: SubGraphNameV1 | null }
    >;
    const addresses = deriveRfc64SubgraphSemanticAddressesV1({
      ...scope,
      subGraphName: subgraphCoordinate.subGraphName,
    });
    if (coordinate.recordType === 'AppliedSubgraphSealV1') return addresses.appliedSeal;
    if (coordinate.recordType === 'SubgraphMutationGuardV1') return addresses.mutationGuard;
    return addresses.reconcileTarget;
  }
  const addresses = deriveRfc64ContextGraphSemanticAddressesV1(scope);
  if (coordinate.recordType === 'ContextGraphMutationGuardV1') return addresses.mutationGuard;
  if (coordinate.recordType === 'AppliedSubgraphSetRefV1') return addresses.appliedSetRef;
  return addresses.appliedSeal;
}

function coordinateFromRecord(record: Rfc64SemanticRecordV1): Rfc64SemanticRecordCoordinateV1 {
  const common = {
    recordType: record.recordType,
    networkId: record.value.networkId,
    contextGraphId: record.value.contextGraphId,
  };
  if (record.recordType === 'CurrentAuthorCatalogRefV1') {
    return Object.freeze({
      ...common,
      subGraphName: record.value.subGraphName,
      authorAddress: record.value.authorAddress,
    });
  }
  if (isSubgraphRecordType(record.recordType)) {
    const value = record.value as Rfc64SubgraphSemanticScopeFieldsV1;
    return Object.freeze({ ...common, subGraphName: value.subGraphName }) as unknown as
      Rfc64SemanticRecordCoordinateV1;
  }
  return Object.freeze(common) as Rfc64SemanticRecordCoordinateV1;
}

function assertRecordMatchesCoordinate(
  record: Rfc64SemanticRecordV1,
  coordinate: Rfc64SemanticRecordCoordinateV1,
): void {
  const actual = coordinateFromRecord(record) as unknown as Record<string, unknown>;
  const expected = coordinate as unknown as Record<string, unknown>;
  const keys = Object.keys(expected);
  if (keys.some((key) => actual[key] !== expected[key])) {
    fail('rfc64-semantic-coordinate', 'decoded semantic record disagrees with expected scope');
  }
}

function isSubgraphRecordType(
  recordType: Rfc64SemanticRecordTypeV1,
): recordType is
  | 'AppliedSubgraphSealV1'
  | 'SubgraphMutationGuardV1'
  | 'SubgraphReconcileTargetGuardV1' {
  return recordType === 'AppliedSubgraphSealV1'
    || recordType === 'SubgraphMutationGuardV1'
    || recordType === 'SubgraphReconcileTargetGuardV1';
}

function assertPendingDigestList(value: unknown): asserts value is readonly Digest32V1[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests must be an ordinary Array');
  }
  if (value.length > MAX_RFC64_PENDING_TARGET_DIGESTS_V1) {
    fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests exceeds 64 entries');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== value.length + 1
    || !ownKeys.includes('length')
  ) {
    fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests must be dense');
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests must use data properties');
    }
    scalar(
      () => assertCanonicalDigest(descriptor.value, `pendingTargetCheckpointDigests[${index}]`),
      `pendingTargetCheckpointDigests[${index}]`,
    );
    if (seen.has(descriptor.value as string)) {
      fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests must be unique');
    }
    seen.add(descriptor.value as string);
  }
}

function assertCanonicalUtcMillis(value: unknown, label: string): asserts value is CanonicalIsoUtcMillisV1 {
  if (typeof value !== 'string' || !CANONICAL_UTC_MILLIS.test(value)) {
    fail('rfc64-semantic-scalar', `${label} must use exact YYYY-MM-DDTHH:mm:ss.sssZ form`);
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) {
    fail('rfc64-semantic-scalar', `${label} must be a real canonical UTC instant`);
  }
}

function exactLiteralValue(
  object: Rfc64SemanticStoreObjectV1,
  datatypeIri: string,
  label: string,
): string {
  if (object.kind !== 'literal' || object.datatypeIri !== datatypeIri) {
    fail('rfc64-semantic-row-term', `${label} has the wrong RDF object form`);
  }
  return object.value;
}

function isExactNullObject(object: Rfc64SemanticStoreObjectV1): boolean {
  return object.kind === 'named-node' && object.value === RFC64_SEMANTIC_NULL_IRI_V1;
}

function namedNode(value: string): Rfc64SemanticStoreObjectV1 {
  return Object.freeze({ kind: 'named-node' as const, value });
}

function literal(value: string, datatypeIri: string): Rfc64SemanticStoreObjectV1 {
  return Object.freeze({ kind: 'literal' as const, value, datatypeIri });
}

function sameStoreRow(
  left: Rfc64SemanticStoreRowV1,
  right: Rfc64SemanticStoreRowV1,
): boolean {
  if (
    left.subjectIri !== right.subjectIri
    || left.predicateIri !== right.predicateIri
    || left.graphIri !== right.graphIri
    || left.object.kind !== right.object.kind
  ) return false;
  if (left.object.kind === 'named-node' && right.object.kind === 'named-node') {
    return left.object.value === right.object.value;
  }
  return left.object.kind === 'literal'
    && right.object.kind === 'literal'
    && left.object.value === right.object.value
    && left.object.datatypeIri === right.object.datatypeIri;
}

function storeRowByteLength(row: Rfc64SemanticStoreRowV1): number {
  return UTF8.encode(row.subjectIri).byteLength
    + UTF8.encode(row.predicateIri).byteLength
    + UTF8.encode(row.graphIri).byteLength
    + UTF8.encode(row.object.value).byteLength
    + (row.object.kind === 'literal' ? UTF8.encode(row.object.datatypeIri).byteLength : 0);
}

function scalar(operation: () => void, label: string): void {
  try {
    operation();
  } catch (cause) {
    if (cause instanceof Rfc64SemanticRecordErrorV1) throw cause;
    fail('rfc64-semantic-scalar', `${label} is not canonical`, cause);
  }
}

function coordinateScalar(operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    if (cause instanceof Rfc64SemanticRecordErrorV1) throw cause;
    fail('rfc64-semantic-coordinate', 'semantic record coordinate is not canonical', cause);
  }
}

function fail(
  code: Rfc64SemanticRecordErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64SemanticRecordErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
