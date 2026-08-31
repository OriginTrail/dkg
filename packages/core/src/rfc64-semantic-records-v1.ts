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
import {
  assertCanonicalIsoUtcMillisV1 as assertSharedCanonicalIsoUtcMillisV1,
  type CanonicalIsoUtcMillisV1,
} from './xsd-date-time.js';
import {
  deriveRfc64ContextGraphSemanticAddressesV1,
  deriveRfc64CurrentAuthorCatalogRefAddressV1,
  deriveRfc64SubgraphSemanticAddressesV1,
  type Rfc64SemanticAddressV1,
} from './rfc64-semantic-addresses-v1.js';
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
import {
  TypedRdfStoreRowErrorV1,
  renderTypedRdfStoreRowV1,
  sameTypedRdfStoreRowV1,
  snapshotDenseTypedRdfStoreRowsV1,
  typedRdfLiteralV1,
  typedRdfNamedNodeV1,
} from './typed-rdf-store-row-v1.js';
import {
  MAX_RFC64_PENDING_TARGET_DIGESTS_V1,
  MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
  RFC64_DIGEST_LIST_DATATYPE_IRI_V1,
  RFC64_SEMANTIC_NULL_IRI_V1,
  RFC64_SEMANTIC_PREDICATES_V1,
  Rfc64SemanticRecordErrorV1,
  type AppliedContextGraphSealV1,
  type AppliedSubgraphSealV1,
  type AppliedSubgraphSetRefV1,
  type ContextGraphMutationGuardV1,
  type CurrentAuthorCatalogRefV1,
  type DecodedRfc64SemanticRecordV1,
  type Rfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticRecordErrorCodeV1,
  type Rfc64SemanticRecordTypeV1,
  type Rfc64SemanticRecordV1,
  type Rfc64SemanticRecordValuesV1,
  type Rfc64SemanticRenderedRowV1,
  type Rfc64SemanticStoreObjectV1,
  type Rfc64SemanticStoreRowV1,
  type SubgraphMutationGuardV1,
  type SubgraphReconcileTargetGuardV1,
} from './rfc64-semantic-record-model-v1.js';

export * from './rfc64-semantic-record-model-v1.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_STRING_IRI = `${XSD}string`;
const XSD_INTEGER_IRI = `${XSD}integer`;
const XSD_HEX_BINARY_IRI = `${XSD}hexBinary`;
const XSD_DATE_TIME_IRI = `${XSD}dateTime`;

interface FieldCodecV1<T> {
  readonly snapshot: (value: unknown, label: string) => T;
  readonly encode: (value: T) => Rfc64SemanticStoreObjectV1;
  readonly decode: (object: Rfc64SemanticStoreObjectV1, label: string) => unknown;
}

type FieldSpecFor<T> = {
  readonly [K in Extract<keyof T, string>]: {
    readonly key: K;
    readonly predicate: string;
    readonly codec: FieldCodecV1<T[K]>;
  }
}[Extract<keyof T, string>];

type SemanticRecordCoordinateForV1<K extends Rfc64SemanticRecordTypeV1> = Extract<
  Rfc64SemanticRecordCoordinateV1,
  { readonly recordType: K }
>;

interface SemanticRecordDefinitionV1<K extends Rfc64SemanticRecordTypeV1> {
  readonly fields: readonly FieldSpecFor<Rfc64SemanticRecordValuesV1[K]>[];
  readonly coordinateKeys: readonly Exclude<
    Extract<keyof SemanticRecordCoordinateForV1<K>, string>,
    'recordType'
  >[];
  readonly deriveAddress: (
    coordinate: SemanticRecordCoordinateForV1<K>,
  ) => Rfc64SemanticAddressV1;
  readonly validate?: (value: Rfc64SemanticRecordValuesV1[K]) => void;
}

function defineFields<T>() {
  return <const F extends readonly FieldSpecFor<T>[]>(fields: F): F => fields;
}

function defineRecord<K extends Rfc64SemanticRecordTypeV1>(
  definition: SemanticRecordDefinitionV1<K>,
): SemanticRecordDefinitionV1<K> {
  return Object.freeze({ ...definition, fields: Object.freeze(definition.fields) });
}

const stringCodec = <T extends string>(
  validate: (value: unknown, label: string) => T,
): FieldCodecV1<T> => ({
  snapshot: validate,
  encode: (value) => literal(value, XSD_STRING_IRI),
  decode: (object, label) => exactLiteralValue(object, XSD_STRING_IRI, label),
});

const nullableCodec = <T>(codec: FieldCodecV1<T>): FieldCodecV1<T | null> => ({
  snapshot: (value, label) => value === null ? null : codec.snapshot(value, label),
  encode: (value) => value === null ? namedNode(RFC64_SEMANTIC_NULL_IRI_V1) : codec.encode(value),
  decode: (object, label) => isExactNullObject(object) ? null : codec.decode(object, label),
});

const networkIdCodec = stringCodec<NetworkIdV1>((value, label) => {
  scalar(() => assertNetworkIdV1(value, label), label);
  return value as NetworkIdV1;
});
const contextGraphIdCodec = stringCodec<ContextGraphIdV1>((value) => {
  coordinateScalar(() => assertAuthorLaneContextGraphIdV1(value));
  return value as ContextGraphIdV1;
});
const subGraphNameCodec = nullableCodec(stringCodec<SubGraphNameV1>((value) => {
  coordinateScalar(() => assertAuthorLaneSubGraphNameV1(value));
  return value as SubGraphNameV1;
}));
const decimalU64Codec: FieldCodecV1<DecimalU64V1> = {
  snapshot: (value, label) => {
    scalar(() => assertCanonicalDecimalU64(value, label), label);
    return value as DecimalU64V1;
  },
  encode: (value) => literal(value, XSD_INTEGER_IRI),
  decode: (object, label) => exactLiteralValue(object, XSD_INTEGER_IRI, label),
};
const chainIdCodec: FieldCodecV1<ChainIdV1> = {
  snapshot: (value, label) => {
    scalar(() => assertCanonicalChainId(value, label), label);
    return value as ChainIdV1;
  },
  encode: (value) => literal(value, XSD_INTEGER_IRI),
  decode: (object, label) => exactLiteralValue(object, XSD_INTEGER_IRI, label),
};
const digestCodec: FieldCodecV1<Digest32V1> = {
  snapshot: (value, label) => {
    scalar(() => assertCanonicalDigest(value, label), label);
    return value as Digest32V1;
  },
  encode: (value) => literal(value.slice(2), XSD_HEX_BINARY_IRI),
  decode: (object, label) => {
    const value = exactLiteralValue(object, XSD_HEX_BINARY_IRI, label);
    if (!/^[0-9a-f]{64}$/.test(value)) {
      fail('rfc64-semantic-row-term', `${label} is not exact lowercase xsd:hexBinary`);
    }
    return `0x${value}`;
  },
};
const addressCodec = stringCodec<EvmAddressV1>((value, label) => {
  scalar(() => assertCanonicalEvmAddress(value, label), label);
  return value as EvmAddressV1;
});
const dateTimeCodec: FieldCodecV1<CanonicalIsoUtcMillisV1> = {
  snapshot: (value, label) => {
    assertCanonicalUtcMillis(value, label);
    return value;
  },
  encode: (value) => literal(value, XSD_DATE_TIME_IRI),
  decode: (object, label) => exactLiteralValue(object, XSD_DATE_TIME_IRI, label),
};
const digestListCodec: FieldCodecV1<readonly Digest32V1[]> = {
  snapshot: (value) => snapshotPendingDigestList(value),
  encode: (value) => literal(canonicalizeJson(value as CanonicalJsonValue, {
    maxBytes: 8192,
    maxDepth: 1,
  }), RFC64_DIGEST_LIST_DATATYPE_IRI_V1),
  decode: (object, label) => {
    const value = exactLiteralValue(object, RFC64_DIGEST_LIST_DATATYPE_IRI_V1, label);
    try {
      return parseCanonicalJson(value, { maxBytes: 8192, maxDepth: 1 });
    } catch (cause) {
      fail('rfc64-semantic-row-term', `${label} is not an exact canonical digest list`, cause);
    }
  },
};

const nullableChainIdCodec = nullableCodec(chainIdCodec);
const nullableAddressCodec = nullableCodec(addressCodec);
const nullableDigestCodec = nullableCodec(digestCodec);

interface UntypedFieldSpecV1 {
  readonly key: string;
  readonly predicate: string;
  readonly codec: FieldCodecV1<unknown>;
}

const P = RFC64_SEMANTIC_PREDICATES_V1;
const RECORD_DEFINITIONS = Object.freeze({
  CurrentAuthorCatalogRefV1: defineRecord<'CurrentAuthorCatalogRefV1'>({
    fields: defineFields<CurrentAuthorCatalogRefV1>()([
    { key: 'networkId', predicate: P.NETWORK_ID, codec: networkIdCodec },
    { key: 'contextGraphId', predicate: P.CONTEXT_GRAPH_ID, codec: contextGraphIdCodec },
    { key: 'governanceChainId', predicate: P.GOVERNANCE_CHAIN_ID, codec: nullableChainIdCodec },
    {
      key: 'governanceContractAddress',
      predicate: P.GOVERNANCE_CONTRACT_ADDRESS,
      codec: nullableAddressCodec,
    },
    {
      key: 'ownershipTransitionDigest',
      predicate: P.OWNERSHIP_TRANSITION_DIGEST,
      codec: nullableDigestCodec,
    },
    { key: 'subGraphName', predicate: P.SUBGRAPH_NAME, codec: subGraphNameCodec },
    { key: 'authorAddress', predicate: P.AUTHOR_ADDRESS, codec: addressCodec },
    { key: 'catalogEra', predicate: P.CATALOG_ERA, codec: decimalU64Codec },
    { key: 'catalogVersion', predicate: P.CATALOG_VERSION, codec: decimalU64Codec },
    { key: 'catalogHeadDigest', predicate: P.CATALOG_HEAD_DIGEST, codec: digestCodec },
    ]),
    coordinateKeys: ['networkId', 'contextGraphId', 'subGraphName', 'authorAddress'],
    deriveAddress: (value) => deriveRfc64CurrentAuthorCatalogRefAddressV1(value),
    validate: (value) => {
      if ((value.governanceChainId === null) !== (value.governanceContractAddress === null)) {
        fail(
          'rfc64-semantic-scalar',
          'governanceChainId and governanceContractAddress must both be null or both non-null',
        );
      }
    },
  }),
  AppliedSubgraphSealV1: defineRecord<'AppliedSubgraphSealV1'>({
    fields: defineFields<AppliedSubgraphSealV1>()([
      { key: 'networkId', predicate: P.NETWORK_ID, codec: networkIdCodec },
      { key: 'contextGraphId', predicate: P.CONTEXT_GRAPH_ID, codec: contextGraphIdCodec },
      { key: 'subGraphName', predicate: P.SUBGRAPH_NAME, codec: subGraphNameCodec },
      { key: 'checkpointEra', predicate: P.CHECKPOINT_ERA, codec: decimalU64Codec },
      { key: 'checkpointVersion', predicate: P.CHECKPOINT_VERSION, codec: decimalU64Codec },
      { key: 'checkpointDigest', predicate: P.CHECKPOINT_DIGEST, codec: digestCodec },
      { key: 'mutationGeneration', predicate: P.MUTATION_GENERATION, codec: decimalU64Codec },
      { key: 'appliedAt', predicate: P.APPLIED_AT, codec: dateTimeCodec },
    ]),
    coordinateKeys: ['networkId', 'contextGraphId', 'subGraphName'],
    deriveAddress: (value) => deriveRfc64SubgraphSemanticAddressesV1(value).appliedSeal,
  }),
  SubgraphMutationGuardV1: defineRecord<'SubgraphMutationGuardV1'>({
    fields: defineFields<SubgraphMutationGuardV1>()([
      { key: 'networkId', predicate: P.NETWORK_ID, codec: networkIdCodec },
      { key: 'contextGraphId', predicate: P.CONTEXT_GRAPH_ID, codec: contextGraphIdCodec },
      { key: 'subGraphName', predicate: P.SUBGRAPH_NAME, codec: subGraphNameCodec },
      { key: 'generation', predicate: P.GENERATION, codec: decimalU64Codec },
    ]),
    coordinateKeys: ['networkId', 'contextGraphId', 'subGraphName'],
    deriveAddress: (value) => deriveRfc64SubgraphSemanticAddressesV1(value).mutationGuard,
  }),
  ContextGraphMutationGuardV1: defineRecord<'ContextGraphMutationGuardV1'>({
    fields: defineFields<ContextGraphMutationGuardV1>()([
      { key: 'networkId', predicate: P.NETWORK_ID, codec: networkIdCodec },
      { key: 'contextGraphId', predicate: P.CONTEXT_GRAPH_ID, codec: contextGraphIdCodec },
      { key: 'generation', predicate: P.GENERATION, codec: decimalU64Codec },
    ]),
    coordinateKeys: ['networkId', 'contextGraphId'],
    deriveAddress: (value) => deriveRfc64ContextGraphSemanticAddressesV1(value).mutationGuard,
  }),
  SubgraphReconcileTargetGuardV1: defineRecord<'SubgraphReconcileTargetGuardV1'>({
    fields: defineFields<SubgraphReconcileTargetGuardV1>()([
    { key: 'networkId', predicate: P.NETWORK_ID, codec: networkIdCodec },
    { key: 'contextGraphId', predicate: P.CONTEXT_GRAPH_ID, codec: contextGraphIdCodec },
    { key: 'subGraphName', predicate: P.SUBGRAPH_NAME, codec: subGraphNameCodec },
    { key: 'generation', predicate: P.GENERATION, codec: decimalU64Codec },
    {
      key: 'baselineSubgraphCheckpointDigest',
      predicate: P.BASELINE_SUBGRAPH_CHECKPOINT_DIGEST,
      codec: nullableDigestCodec,
    },
    {
      key: 'activeTargetSubgraphCheckpointDigest',
      predicate: P.ACTIVE_TARGET_SUBGRAPH_CHECKPOINT_DIGEST,
      codec: digestCodec,
    },
    {
      key: 'pendingTargetCheckpointDigests',
      predicate: P.PENDING_TARGET_CHECKPOINT_DIGESTS,
      codec: digestListCodec,
    },
    ]),
    coordinateKeys: ['networkId', 'contextGraphId', 'subGraphName'],
    deriveAddress: (value) => deriveRfc64SubgraphSemanticAddressesV1(value).reconcileTarget,
  }),
  AppliedSubgraphSetRefV1: defineRecord<'AppliedSubgraphSetRefV1'>({
    fields: defineFields<AppliedSubgraphSetRefV1>()([
    { key: 'networkId', predicate: P.NETWORK_ID, codec: networkIdCodec },
    { key: 'contextGraphId', predicate: P.CONTEXT_GRAPH_ID, codec: contextGraphIdCodec },
    { key: 'generation', predicate: P.GENERATION, codec: decimalU64Codec },
    { key: 'subgraphIndexEra', predicate: P.SUBGRAPH_INDEX_ERA, codec: decimalU64Codec },
    { key: 'subgraphIndexVersion', predicate: P.SUBGRAPH_INDEX_VERSION, codec: decimalU64Codec },
    { key: 'subgraphCount', predicate: P.SUBGRAPH_COUNT, codec: decimalU64Codec },
    {
      key: 'appliedDirectoryRootDigest',
      predicate: P.APPLIED_DIRECTORY_ROOT_DIGEST,
      codec: digestCodec,
    },
    ]),
    coordinateKeys: ['networkId', 'contextGraphId'],
    deriveAddress: (value) => deriveRfc64ContextGraphSemanticAddressesV1(value).appliedSetRef,
  }),
  AppliedContextGraphSealV1: defineRecord<'AppliedContextGraphSealV1'>({
    fields: defineFields<AppliedContextGraphSealV1>()([
      { key: 'networkId', predicate: P.NETWORK_ID, codec: networkIdCodec },
      { key: 'contextGraphId', predicate: P.CONTEXT_GRAPH_ID, codec: contextGraphIdCodec },
      { key: 'checkpointEra', predicate: P.CHECKPOINT_ERA, codec: decimalU64Codec },
      { key: 'checkpointVersion', predicate: P.CHECKPOINT_VERSION, codec: decimalU64Codec },
      { key: 'checkpointDigest', predicate: P.CHECKPOINT_DIGEST, codec: digestCodec },
      { key: 'policyDigest', predicate: P.POLICY_DIGEST, codec: digestCodec },
      { key: 'chainCoverageDigest', predicate: P.CHAIN_COVERAGE_DIGEST, codec: digestCodec },
      { key: 'mutationGeneration', predicate: P.MUTATION_GENERATION, codec: decimalU64Codec },
      { key: 'appliedAt', predicate: P.APPLIED_AT, codec: dateTimeCodec },
    ]),
    coordinateKeys: ['networkId', 'contextGraphId'],
    deriveAddress: (value) => deriveRfc64ContextGraphSemanticAddressesV1(value).appliedSeal,
  }),
} satisfies {
  readonly [K in Rfc64SemanticRecordTypeV1]: SemanticRecordDefinitionV1<K>;
});

export const RFC64_SEMANTIC_RECORD_ROW_COUNTS_V1 = Object.freeze({
  CurrentAuthorCatalogRefV1: RECORD_DEFINITIONS.CurrentAuthorCatalogRefV1.fields.length,
  AppliedSubgraphSealV1: RECORD_DEFINITIONS.AppliedSubgraphSealV1.fields.length,
  SubgraphMutationGuardV1: RECORD_DEFINITIONS.SubgraphMutationGuardV1.fields.length,
  ContextGraphMutationGuardV1: RECORD_DEFINITIONS.ContextGraphMutationGuardV1.fields.length,
  SubgraphReconcileTargetGuardV1:
    RECORD_DEFINITIONS.SubgraphReconcileTargetGuardV1.fields.length,
  AppliedSubgraphSetRefV1: RECORD_DEFINITIONS.AppliedSubgraphSetRefV1.fields.length,
  AppliedContextGraphSealV1: RECORD_DEFINITIONS.AppliedContextGraphSealV1.fields.length,
} as const satisfies Record<Rfc64SemanticRecordTypeV1, number>);

const RECORD_TYPES = new Set<Rfc64SemanticRecordTypeV1>(
  Object.keys(RECORD_DEFINITIONS) as Rfc64SemanticRecordTypeV1[],
);

interface UntypedRecordDefinitionV1 {
  readonly fields: readonly UntypedFieldSpecV1[];
  readonly coordinateKeys: readonly string[];
  readonly validate?: (value: never) => void;
}

function definitionFor(recordType: Rfc64SemanticRecordTypeV1): UntypedRecordDefinitionV1 {
  return RECORD_DEFINITIONS[recordType] as unknown as UntypedRecordDefinitionV1;
}

/**
 * Project one validated semantic record into exact backend-neutral typed rows.
 * The graph and subject are always derived from the record's validated scope.
 */
export function projectRfc64SemanticRecordStoreRowsV1(
  input: unknown,
): readonly Rfc64SemanticStoreRowV1[] {
  const record = snapshotRfc64SemanticRecordV1(input);
  const definition = definitionFor(record.recordType);
  const address = deriveRfc64SemanticRecordAddressFromCoordinateV1(
    coordinateFromRecord(record),
  );
  const value = record.value as unknown as Record<string, unknown>;
  return Object.freeze(definition.fields.map((field) => Object.freeze({
    subjectIri: address.subject,
    predicateIri: field.predicate,
    graphIri: address.graphUri,
    object: field.codec.encode(value[field.key]),
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
  const definition = definitionFor(coordinate.recordType);
  const address = deriveRfc64SemanticRecordAddressFromCoordinateV1(coordinate);
  const fields = definition.fields;
  const typedRows = snapshotSemanticRows(rows, fields.length);
  const allowed = new Map<string, UntypedFieldSpecV1>(
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
    raw[field.key] = field.codec.decode(row.object, field.key);
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
  try {
    return renderTypedRdfStoreRowV1(input, new Set([
      XSD_STRING_IRI,
      XSD_INTEGER_IRI,
      XSD_HEX_BINARY_IRI,
      XSD_DATE_TIME_IRI,
      RFC64_DIGEST_LIST_DATATYPE_IRI_V1,
    ]));
  } catch (cause) {
    mapTypedRowError(cause);
  }
}

export function snapshotRfc64SemanticRecordV1(input: unknown): Rfc64SemanticRecordV1 {
  const envelope = snapshotClosed(input, ['recordType', 'value'], 'semantic record envelope');
  if (typeof envelope.recordType !== 'string' || !RECORD_TYPES.has(
    envelope.recordType as Rfc64SemanticRecordTypeV1,
  )) {
    fail('rfc64-semantic-schema', 'semantic record has an unknown recordType');
  }
  const recordType = envelope.recordType as Rfc64SemanticRecordTypeV1;
  const definition = definitionFor(recordType);
  const value = snapshotClosed(
    envelope.value,
    definition.fields.map((field) => field.key),
    recordType,
  );
  const immutableValue: Record<string, unknown> = {};
  for (const field of definition.fields) {
    immutableValue[field.key] = field.codec.snapshot(value[field.key], field.key);
  }
  const frozenValue = Object.freeze(immutableValue);
  definition.validate?.(frozenValue as never);
  return Object.freeze({
    recordType,
    value: frozenValue,
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
  const definition = definitionFor(recordType as Rfc64SemanticRecordTypeV1);
  const keys = [...definition.coordinateKeys, 'recordType'];
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
  const snapshot: Record<string, unknown> = { recordType };
  for (const key of definition.coordinateKeys) {
    const field = definition.fields.find((candidate) => candidate.key === key);
    if (!field) {
      fail('rfc64-semantic-coordinate', `semantic record definition lacks coordinate field ${key}`);
    }
    snapshot[key] = field.codec.snapshot(coordinate[key], key);
  }
  return Object.freeze(snapshot) as unknown as Rfc64SemanticRecordCoordinateV1;
}

function snapshotSemanticRows(
  input: unknown,
  expectedLength: number,
): readonly Rfc64SemanticStoreRowV1[] {
  try {
    return snapshotDenseTypedRdfStoreRowsV1(input, {
      allowedLengths: [expectedLength],
      maxBytes: MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1,
    });
  } catch (cause) {
    mapTypedRowError(cause, expectedLength);
  }
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

/** Resolve the one canonical graph and subject for a validated semantic coordinate. */
export function deriveRfc64SemanticRecordAddressFromCoordinateV1(
  coordinate: Rfc64SemanticRecordCoordinateV1,
): Rfc64SemanticAddressV1 {
  switch (coordinate.recordType) {
    case 'CurrentAuthorCatalogRefV1':
      return RECORD_DEFINITIONS.CurrentAuthorCatalogRefV1.deriveAddress(coordinate);
    case 'AppliedSubgraphSealV1':
      return RECORD_DEFINITIONS.AppliedSubgraphSealV1.deriveAddress(coordinate);
    case 'SubgraphMutationGuardV1':
      return RECORD_DEFINITIONS.SubgraphMutationGuardV1.deriveAddress(coordinate);
    case 'ContextGraphMutationGuardV1':
      return RECORD_DEFINITIONS.ContextGraphMutationGuardV1.deriveAddress(coordinate);
    case 'SubgraphReconcileTargetGuardV1':
      return RECORD_DEFINITIONS.SubgraphReconcileTargetGuardV1.deriveAddress(coordinate);
    case 'AppliedSubgraphSetRefV1':
      return RECORD_DEFINITIONS.AppliedSubgraphSetRefV1.deriveAddress(coordinate);
    case 'AppliedContextGraphSealV1':
      return RECORD_DEFINITIONS.AppliedContextGraphSealV1.deriveAddress(coordinate);
  }
}

/** Validate untrusted input once, then delegate to the typed address primitive. */
export function deriveRfc64SemanticRecordAddressV1(
  input: unknown,
): Rfc64SemanticAddressV1 {
  const coordinate = snapshotRfc64SemanticRecordCoordinateV1(input);
  return deriveRfc64SemanticRecordAddressFromCoordinateV1(coordinate);
}

function coordinateFromRecord(record: Rfc64SemanticRecordV1): Rfc64SemanticRecordCoordinateV1 {
  const definition = definitionFor(record.recordType);
  const value = record.value as unknown as Record<string, unknown>;
  const coordinate: Record<string, unknown> = { recordType: record.recordType };
  for (const key of definition.coordinateKeys) {
    coordinate[key] = value[key];
  }
  return Object.freeze(coordinate) as unknown as Rfc64SemanticRecordCoordinateV1;
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

function snapshotPendingDigestList(value: unknown): readonly Digest32V1[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests must be an ordinary Array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor
    && Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    && Number.isSafeInteger(lengthDescriptor.value)
    ? lengthDescriptor.value as number
    : -1;
  if (length < 0) {
    fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests has an invalid length');
  }
  if (length > MAX_RFC64_PENDING_TARGET_DIGESTS_V1) {
    fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests exceeds 64 entries');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== length + 1
    || !ownKeys.includes('length')
  ) {
    fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests must be dense');
  }
  const seen = new Set<string>();
  const snapshot: Digest32V1[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests must use data properties');
    }
    scalar(
      () => assertCanonicalDigest(descriptor.value, `pendingTargetCheckpointDigests[${index}]`),
      `pendingTargetCheckpointDigests[${index}]`,
    );
    const digest = descriptor.value as Digest32V1;
    if (seen.has(digest)) {
      fail('rfc64-semantic-scalar', 'pendingTargetCheckpointDigests must be unique');
    }
    seen.add(digest);
    snapshot.push(digest);
  }
  return Object.freeze(snapshot);
}

function assertCanonicalUtcMillis(value: unknown, label: string): asserts value is CanonicalIsoUtcMillisV1 {
  try {
    assertSharedCanonicalIsoUtcMillisV1(value);
  } catch (cause) {
    fail('rfc64-semantic-scalar', `${label} must use exact YYYY-MM-DDTHH:mm:ss.sssZ form`, cause);
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
  return typedRdfNamedNodeV1(value);
}

function literal(value: string, datatypeIri: string): Rfc64SemanticStoreObjectV1 {
  return typedRdfLiteralV1(value, datatypeIri);
}

function sameStoreRow(
  left: Rfc64SemanticStoreRowV1,
  right: Rfc64SemanticStoreRowV1,
): boolean {
  return sameTypedRdfStoreRowV1(left, right);
}

function mapTypedRowError(cause: unknown, expectedLength?: number): never {
  if (!(cause instanceof TypedRdfStoreRowErrorV1)) throw cause;
  if (cause.code === 'row-cardinality') {
    fail(
      'rfc64-semantic-row-cardinality',
      expectedLength === undefined
        ? cause.message
        : `semantic record requires exactly ${expectedLength} rows`,
      cause,
    );
  }
  if (cause.code === 'row-term') {
    fail('rfc64-semantic-row-term', cause.message, cause);
  }
  if (cause.code === 'row-too-large') {
    fail('rfc64-semantic-too-large', 'semantic record response exceeds 64 KiB', cause);
  }
  fail('rfc64-semantic-row-schema', cause.message, cause);
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
