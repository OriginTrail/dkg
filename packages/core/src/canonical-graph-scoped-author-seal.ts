import { sha256 } from '@noble/hashes/sha2.js';

import {
  ASSERTION_SEAL_PREDICATES,
  buildAssertionSealQuads,
  parseGraphScopedAssertionSealCandidate,
  type AssertionSeal,
  type GraphScopedAssertionSealCandidate,
} from './assertion-seal.js';
import {
  assertAssertionCoordinateV1,
  assertContextGraphIdV1,
  assertSubGraphNameV1,
  buildCatalogAssertionScopeV1,
  buildCatalogAssertionSubjectV1,
  type AssertionCoordinateV1,
  type CatalogLaneV1,
  type ContextGraphIdV1,
  type SubGraphNameV1,
} from './author-catalog-codec.js';
import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  assertCanonicalDeterministicUalV1 as assertSharedCanonicalDeterministicUalV1,
  type CanonicalDeterministicUalV1,
} from './ka-content-scope.js';
import { isSafeIri } from './sparql-safe.js';
import {
  assertCanonicalChainId,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  parseCanonicalDecimalU64,
  parseCanonicalDecimalU256,
  type ChainIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type KaIdV1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

declare const HEX_32_V1_BRAND: unique symbol;
declare const POSITIVE_DECIMAL_U64_V1_BRAND: unique symbol;
declare const SEAL_TRIPLE_COUNT_V1_BRAND: unique symbol;
declare const CANONICAL_ISO_UTC_MILLIS_V1_BRAND: unique symbol;

export type Hex32V1 = string & { readonly [HEX_32_V1_BRAND]: true };
export type PositiveDecimalU64V1 = DecimalU64V1 & {
  readonly [POSITIVE_DECIMAL_U64_V1_BRAND]: true;
};
export type SealTripleCountV1 = DecimalU64V1 & {
  readonly [SEAL_TRIPLE_COUNT_V1_BRAND]: true;
};
export type CanonicalIsoUtcMillisV1 = string & {
  readonly [CANONICAL_ISO_UTC_MILLIS_V1_BRAND]: true;
};
export type { CanonicalDeterministicUalV1 } from './ka-content-scope.js';

export const CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_DIGEST_DOMAIN_V1 =
  'dkg-ka-author-seal-v1\n' as const;
export const MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1 = 16 * 1024;
export const MAX_SEAL_TRIPLE_COUNT_V1 = 9_007_199_254_740_991n;

const XSD_STRING_IRI = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_HEX_BINARY_IRI = 'http://www.w3.org/2001/XMLSchema#hexBinary';
const XSD_INTEGER_IRI = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DATE_TIME_IRI = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_HEX_BINARY = `<${XSD_HEX_BINARY_IRI}>`;
const XSD_INTEGER = `<${XSD_INTEGER_IRI}>`;
const XSD_DATE_TIME = `<${XSD_DATE_TIME_IRI}>`;
const UTF8 = new TextEncoder();
const SEAL_DIGEST_DOMAIN_BYTES = UTF8.encode(
  CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_DIGEST_DOMAIN_V1,
);
const CANONICAL_UTC_MILLIS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

const REQUIRED_PREDICATES = [
  ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT,
  ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS,
  ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R,
  ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_VS,
  ASSERTION_SEAL_PREDICATES.AUTHOR_SCHEME_VERSION,
  ASSERTION_SEAL_PREDICATES.ASSERTED_AT_CHAIN_ID,
  ASSERTION_SEAL_PREDICATES.ASSERTED_AT_KAV10_ADDRESS,
  ASSERTION_SEAL_PREDICATES.RESERVED_KA_ID,
  ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT,
  ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION,
  ASSERTION_SEAL_PREDICATES.KA_UAL,
  ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
  ASSERTION_SEAL_PREDICATES.PUBLIC_TRIPLE_COUNT,
  ASSERTION_SEAL_PREDICATES.PRIVATE_TRIPLE_COUNT,
] as const;
const PRIVATE_ROOT_PREDICATE = ASSERTION_SEAL_PREDICATES.PRIVATE_MERKLE_ROOT;
const ALLOWED_PREDICATES = new Set<string>([
  ...REQUIRED_PREDICATES,
  PRIVATE_ROOT_PREDICATE,
]);

export interface CanonicalGraphScopedAuthorSealV1 {
  readonly assertionMerkleRoot: Digest32V1;
  readonly authorAddress: EvmAddressV1;
  readonly authorAttestationR: Hex32V1;
  readonly authorAttestationVS: Hex32V1;
  readonly authorSchemeVersion: '1';
  readonly assertedAtChainId: ChainIdV1;
  readonly assertedAtKav10Address: EvmAddressV1;
  readonly reservedKaId: KaIdV1;
  readonly assertionFinalizedAt: CanonicalIsoUtcMillisV1;
  readonly contentScopeVersion: '2';
  readonly kaUal: CanonicalDeterministicUalV1;
  readonly assertionVersion: PositiveDecimalU64V1;
  readonly publicTripleCount: SealTripleCountV1;
  readonly privateTripleCount: SealTripleCountV1;
  readonly privateMerkleRoot: Digest32V1 | null;
}

/**
 * Convert the normal publication seal into the exact RFC-64 wire payload.
 * Keeping this at the protocol boundary prevents catalog bridges from owning
 * a second, cast-heavy encoding of the signed graph-scoped seal.
 */
export function canonicalGraphScopedAuthorSealFromAssertionSealV1(
  seal: AssertionSeal,
): Readonly<CanonicalGraphScopedAuthorSealV1> {
  if (
    seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION
    || seal.kaUal === undefined
    || seal.assertionVersion === undefined
    || seal.publicTripleCount === undefined
    || seal.privateTripleCount === undefined
    || seal.reservedKaId === undefined
    || seal.authorSchemeVersion !== 1
  ) {
    fail('canonical-seal-schema', 'conversion requires a complete graph-scoped v2 author seal');
  }
  const canonical: unknown = {
    assertionMerkleRoot: bytesToLowerHex32(seal.merkleRoot, 'assertionMerkleRoot'),
    authorAddress: seal.authorAddress.toLowerCase(),
    authorAttestationR: bytesToLowerHex32(seal.authorAttestationR, 'authorAttestationR'),
    authorAttestationVS: bytesToLowerHex32(seal.authorAttestationVS, 'authorAttestationVS'),
    authorSchemeVersion: '1',
    assertedAtChainId: seal.chainId.toString(),
    assertedAtKav10Address: seal.kav10Address.toLowerCase(),
    reservedKaId: seal.reservedKaId.toString(),
    assertionFinalizedAt: seal.finalizedAtIso,
    contentScopeVersion: '2',
    kaUal: seal.kaUal,
    assertionVersion: seal.assertionVersion,
    publicTripleCount: seal.publicTripleCount.toString(),
    privateTripleCount: seal.privateTripleCount.toString(),
    privateMerkleRoot: seal.privateMerkleRoot === undefined
      ? null
      : bytesToLowerHex32(seal.privateMerkleRoot, 'privateMerkleRoot'),
  };
  assertCanonicalGraphScopedAuthorSealV1(canonical);
  return Object.freeze(canonical);
}

/** Authenticated catalog coordinate used to derive subject and physical metadata graph. */
export interface CanonicalGraphScopedAuthorSealCoordinateV1 extends CatalogLaneV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
}

export interface CanonicalGraphScopedAuthorSealRowV1 {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly graph: string;
}

export type CanonicalAuthorSealStoreObjectV1 =
  | {
      readonly kind: 'named-node';
      /** Bare RDF IRI value; adapters must not preserve angle-bracket rendering. */
      readonly value: string;
    }
  | {
      readonly kind: 'literal';
      readonly value: string;
      readonly datatypeIri: string;
    };

/** Backend-neutral typed adapter row accepted by the strict inverse decoder. */
export interface CanonicalAuthorSealStoreRowV1 {
  readonly subjectIri: string;
  readonly predicateIri: string;
  readonly graphIri: string;
  readonly object: CanonicalAuthorSealStoreObjectV1;
}

export interface CanonicalGraphScopedAuthorSealPlacementV1 {
  readonly subject: string;
  readonly metaGraph: string;
}

export interface DecodedCanonicalGraphScopedAuthorSealRowsV1 {
  readonly payload: CanonicalGraphScopedAuthorSealV1;
  readonly canonicalSealBytes: Uint8Array;
  readonly sealDigest: Digest32V1;
  readonly placement: CanonicalGraphScopedAuthorSealPlacementV1;
  readonly rows: readonly CanonicalGraphScopedAuthorSealRowV1[];
}

export interface ClassifiedCanonicalGraphScopedAuthorSealRowsV1
  extends DecodedCanonicalGraphScopedAuthorSealRowsV1 {
  readonly candidate: GraphScopedAssertionSealCandidate;
}

export type CanonicalGraphScopedAuthorSealErrorCode =
  | 'canonical-seal-schema'
  | 'canonical-seal-scalar'
  | 'canonical-seal-timestamp'
  | 'canonical-seal-ual'
  | 'canonical-seal-binding'
  | 'canonical-seal-count'
  | 'canonical-seal-private-root'
  | 'canonical-seal-too-large'
  | 'canonical-seal-coordinate'
  | 'canonical-seal-row-schema'
  | 'canonical-seal-row-cardinality'
  | 'canonical-seal-row-term'
  | 'canonical-seal-projection'
  | 'canonical-seal-candidate-rejected';

export class CanonicalGraphScopedAuthorSealError extends Error {
  constructor(
    readonly code: CanonicalGraphScopedAuthorSealErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'CanonicalGraphScopedAuthorSealError';
  }
}

/** Validate the closed 15-key subjectless and graphless author-seal payload. */
export function assertCanonicalGraphScopedAuthorSealV1(
  payload: unknown,
): asserts payload is CanonicalGraphScopedAuthorSealV1 {
  if (!isPlainRecord(payload)) {
    fail('canonical-seal-schema', 'canonical author seal must be a plain JSON object');
  }
  assertClosedKeys(payload, [
    'assertedAtChainId',
    'assertedAtKav10Address',
    'assertionFinalizedAt',
    'assertionMerkleRoot',
    'assertionVersion',
    'authorAddress',
    'authorAttestationR',
    'authorAttestationVS',
    'authorSchemeVersion',
    'contentScopeVersion',
    'kaUal',
    'privateMerkleRoot',
    'privateTripleCount',
    'publicTripleCount',
    'reservedKaId',
  ], 'canonical graph-scoped author seal');

  assertSealScalar(() => assertCanonicalDigest(
    payload.assertionMerkleRoot,
    'assertionMerkleRoot',
  ));
  assertSealScalar(() => assertCanonicalEvmAddress(payload.authorAddress, 'authorAddress'));
  assertHex32V1(payload.authorAttestationR, 'authorAttestationR');
  assertHex32V1(payload.authorAttestationVS, 'authorAttestationVS');
  if (payload.authorSchemeVersion !== '1') {
    fail('canonical-seal-schema', 'authorSchemeVersion must be the exact string "1"');
  }
  assertSealScalar(() => assertCanonicalChainId(payload.assertedAtChainId, 'assertedAtChainId'));
  assertSealScalar(() => assertCanonicalEvmAddress(
    payload.assertedAtKav10Address,
    'assertedAtKav10Address',
  ));
  const reservedKaId = assertSealU256(payload.reservedKaId, 'reservedKaId');
  assertCanonicalIsoUtcMillisV1(payload.assertionFinalizedAt);
  if (payload.contentScopeVersion !== '2') {
    fail('canonical-seal-schema', 'contentScopeVersion must be the exact string "2"');
  }
  const ual = assertCanonicalSealDeterministicUalV1(payload.kaUal);
  const assertionVersion = assertSealU64(payload.assertionVersion, 'assertionVersion');
  if (assertionVersion < 1n) {
    fail('canonical-seal-scalar', 'assertionVersion must be in 1..2^64-1');
  }
  const publicCount = assertSealTripleCountV1(payload.publicTripleCount, 'publicTripleCount');
  const privateCount = assertSealTripleCountV1(payload.privateTripleCount, 'privateTripleCount');
  if (publicCount + privateCount < 1n) {
    fail('canonical-seal-count', 'publicTripleCount + privateTripleCount must be positive');
  }
  if (payload.privateMerkleRoot === null) {
    if (privateCount !== 0n) {
      fail(
        'canonical-seal-private-root',
        'positive privateTripleCount requires privateMerkleRoot',
      );
    }
  } else {
    assertSealScalar(() => assertCanonicalDigest(payload.privateMerkleRoot, 'privateMerkleRoot'));
    if (privateCount === 0n) {
      fail(
        'canonical-seal-private-root',
        'privateMerkleRoot requires positive privateTripleCount',
      );
    }
  }

  if (ual.agentAddress !== payload.authorAddress) {
    fail('canonical-seal-binding', 'kaUal author must equal authorAddress');
  }
  const packedKaId = (BigInt(ual.agentAddress) << 96n) | BigInt(ual.kaNumber);
  if (reservedKaId !== packedKaId) {
    fail('canonical-seal-binding', 'reservedKaId must equal the packed kaUal identity');
  }

  // The structural domain is intentionally capped even though the frozen field
  // widths currently keep every valid payload well below it.
  canonicalizePayloadAfterValidation(payload as unknown as CanonicalGraphScopedAuthorSealV1);
}

export function canonicalizeCanonicalGraphScopedAuthorSealV1(
  payload: CanonicalGraphScopedAuthorSealV1,
): string {
  assertCanonicalGraphScopedAuthorSealV1(payload);
  return canonicalizePayloadAfterValidation(payload);
}

export function canonicalizeCanonicalGraphScopedAuthorSealBytesV1(
  payload: CanonicalGraphScopedAuthorSealV1,
): Uint8Array {
  return UTF8.encode(canonicalizeCanonicalGraphScopedAuthorSealV1(payload));
}

export function parseCanonicalGraphScopedAuthorSealV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): CanonicalGraphScopedAuthorSealV1 {
  rejectOversizedInput(input);
  let parsed: CanonicalJsonValue;
  try {
    parsed = parseCanonicalJson(input, {
      ...options,
      maxBytes: Math.min(
        options.maxBytes ?? MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1,
        MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1,
      ),
      maxDepth: Math.min(options.maxDepth ?? 1, 1),
    });
  } catch (cause) {
    fail('canonical-seal-schema', 'author-seal bytes are not strict canonical JCS', cause);
  }
  assertCanonicalGraphScopedAuthorSealV1(parsed);
  return parsed;
}

export function computeCanonicalGraphScopedAuthorSealDigestV1(
  payload: CanonicalGraphScopedAuthorSealV1,
): Digest32V1 {
  const bytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(payload);
  const hasher = sha256.create();
  hasher.update(SEAL_DIGEST_DOMAIN_BYTES);
  hasher.update(bytes);
  return bytesToDigest(hasher.digest());
}

export function assertCanonicalGraphScopedAuthorSealCoordinateV1(
  coordinate: unknown,
): asserts coordinate is CanonicalGraphScopedAuthorSealCoordinateV1 {
  if (!isPlainRecord(coordinate)) {
    fail('canonical-seal-coordinate', 'catalog assertion coordinate must be a plain object');
  }
  assertClosedCoordinateKeys(coordinate);
  try {
    assertContextGraphIdV1(coordinate.contextGraphId);
    if (coordinate.subGraphName !== null) assertSubGraphNameV1(coordinate.subGraphName);
    assertCanonicalEvmAddress(coordinate.authorAddress, 'coordinate authorAddress');
    assertAssertionCoordinateV1(coordinate.assertionCoordinate);
  } catch (cause) {
    fail('canonical-seal-coordinate', 'catalog assertion coordinate is not canonical', cause);
  }
}

/** Derive the only subject and tagged physical metadata graph accepted for this seal. */
export function deriveCanonicalGraphScopedAuthorSealPlacementV1(
  coordinate: CanonicalGraphScopedAuthorSealCoordinateV1,
): CanonicalGraphScopedAuthorSealPlacementV1 {
  assertCanonicalGraphScopedAuthorSealCoordinateV1(coordinate);
  const catalogAssertionScope = buildCatalogAssertionScopeV1(coordinate);
  return {
    subject: buildCatalogAssertionSubjectV1(
      coordinate,
      coordinate.authorAddress,
      coordinate.assertionCoordinate,
    ),
    metaGraph: `did:dkg:context-graph:${catalogAssertionScope}/_meta`,
  };
}

/** Project the typed payload to the exact ordered 14/15-row graph-scoped v2 seal. */
export function projectCanonicalGraphScopedAuthorSealRowsV1(
  payload: CanonicalGraphScopedAuthorSealV1,
  coordinate: CanonicalGraphScopedAuthorSealCoordinateV1,
): readonly CanonicalGraphScopedAuthorSealRowV1[] {
  assertCanonicalGraphScopedAuthorSealV1(payload);
  assertCanonicalGraphScopedAuthorSealCoordinateV1(coordinate);
  if (payload.authorAddress !== coordinate.authorAddress) {
    fail('canonical-seal-binding', 'payload authorAddress must equal coordinate authorAddress');
  }
  const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1(coordinate);
  const row = (predicate: string, object: string): CanonicalGraphScopedAuthorSealRowV1 => ({
    subject: placement.subject,
    predicate,
    object,
    graph: placement.metaGraph,
  });
  const exactRows = [
    row(
      ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT,
      hexBinaryObject(payload.assertionMerkleRoot),
    ),
    row(ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS, JSON.stringify(payload.authorAddress)),
    row(
      ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R,
      hexBinaryObject(payload.authorAttestationR),
    ),
    row(
      ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_VS,
      hexBinaryObject(payload.authorAttestationVS),
    ),
    row(ASSERTION_SEAL_PREDICATES.AUTHOR_SCHEME_VERSION, integerObject('1')),
    row(ASSERTION_SEAL_PREDICATES.ASSERTED_AT_CHAIN_ID, integerObject(payload.assertedAtChainId)),
    row(
      ASSERTION_SEAL_PREDICATES.ASSERTED_AT_KAV10_ADDRESS,
      JSON.stringify(payload.assertedAtKav10Address),
    ),
    row(ASSERTION_SEAL_PREDICATES.RESERVED_KA_ID, integerObject(payload.reservedKaId)),
    row(
      ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT,
      `${JSON.stringify(payload.assertionFinalizedAt)}^^${XSD_DATE_TIME}`,
    ),
    row(ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION, integerObject('2')),
    row(ASSERTION_SEAL_PREDICATES.KA_UAL, `<${payload.kaUal}>`),
    row(ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION, integerObject(payload.assertionVersion)),
    row(ASSERTION_SEAL_PREDICATES.PUBLIC_TRIPLE_COUNT, integerObject(payload.publicTripleCount)),
    row(ASSERTION_SEAL_PREDICATES.PRIVATE_TRIPLE_COUNT, integerObject(payload.privateTripleCount)),
    ...(payload.privateMerkleRoot === null ? [] : [row(
      ASSERTION_SEAL_PREDICATES.PRIVATE_MERKLE_ROOT,
      hexBinaryObject(payload.privateMerkleRoot),
    )]),
  ];

  // Freeze equivalence with the mandatory deployed builder while returning the
  // RFC's independently specified exact lexical projection.
  const builderRows = buildAssertionSealQuads({
    assertionUri: placement.subject,
    metaGraph: placement.metaGraph,
    merkleRoot: hex32ToBytes(payload.assertionMerkleRoot),
    authorAddress: payload.authorAddress,
    authorAttestationR: hex32ToBytes(payload.authorAttestationR),
    authorAttestationVS: hex32ToBytes(payload.authorAttestationVS),
    authorSchemeVersion: 1,
    chainId: BigInt(payload.assertedAtChainId),
    kav10Address: payload.assertedAtKav10Address,
    reservedKaId: BigInt(payload.reservedKaId),
    finalizedAtIso: payload.assertionFinalizedAt,
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: payload.kaUal,
    assertionVersion: payload.assertionVersion,
    publicTripleCount: Number(payload.publicTripleCount),
    privateTripleCount: Number(payload.privateTripleCount),
    ...(payload.privateMerkleRoot === null
      ? {}
      : { privateMerkleRoot: hex32ToBytes(payload.privateMerkleRoot) }),
  });
  if (!sameOrderedRows(exactRows, builderRows)) {
    fail(
      'canonical-seal-projection',
      'canonical author-seal projection disagrees with buildAssertionSealQuads',
    );
  }
  return exactRows;
}

/**
 * Project transferred canonical seal bytes into the backend-neutral typed RDF
 * rows consumed by the strict inverse decoder and the PR #1780 classifier.
 *
 * This is an in-memory projection only. It performs no triple-store read or
 * write and gives callers no authority to treat the seal as semantically
 * admitted.
 */
export function projectCanonicalGraphScopedAuthorSealStoreRowsV1(
  payload: CanonicalGraphScopedAuthorSealV1,
  coordinate: CanonicalGraphScopedAuthorSealCoordinateV1,
): readonly CanonicalAuthorSealStoreRowV1[] {
  const rows = projectCanonicalGraphScopedAuthorSealRowsV1(payload, coordinate);
  const literal = (
    value: string,
    datatypeIri: string,
  ): CanonicalAuthorSealStoreObjectV1 => Object.freeze({
    kind: 'literal' as const,
    value,
    datatypeIri,
  });
  const objects: readonly CanonicalAuthorSealStoreObjectV1[] = [
    literal(payload.assertionMerkleRoot.slice(2), XSD_HEX_BINARY_IRI),
    literal(payload.authorAddress, XSD_STRING_IRI),
    literal(payload.authorAttestationR.slice(2), XSD_HEX_BINARY_IRI),
    literal(payload.authorAttestationVS.slice(2), XSD_HEX_BINARY_IRI),
    literal('1', XSD_INTEGER_IRI),
    literal(payload.assertedAtChainId, XSD_INTEGER_IRI),
    literal(payload.assertedAtKav10Address, XSD_STRING_IRI),
    literal(payload.reservedKaId, XSD_INTEGER_IRI),
    literal(payload.assertionFinalizedAt, XSD_DATE_TIME_IRI),
    literal('2', XSD_INTEGER_IRI),
    Object.freeze({ kind: 'named-node' as const, value: payload.kaUal }),
    literal(payload.assertionVersion, XSD_INTEGER_IRI),
    literal(payload.publicTripleCount, XSD_INTEGER_IRI),
    literal(payload.privateTripleCount, XSD_INTEGER_IRI),
    ...(payload.privateMerkleRoot === null
      ? []
      : [literal(payload.privateMerkleRoot.slice(2), XSD_HEX_BINARY_IRI)]),
  ];
  if (objects.length !== rows.length) {
    fail('canonical-seal-row-cardinality', 'typed projection cardinality is inconsistent');
  }
  return Object.freeze(rows.map((row, index) => Object.freeze({
    subjectIri: row.subject,
    predicateIri: row.predicate,
    graphIri: row.graph,
    object: objects[index],
  })));
}

/** Render one typed store row to the exact canonical parser-row representation. */
export function renderCanonicalAuthorSealStoreRowV1(
  row: CanonicalAuthorSealStoreRowV1,
): CanonicalGraphScopedAuthorSealRowV1 {
  assertCanonicalAuthorSealStoreRowShape(row);
  for (const [label, value] of [
    ['subjectIri', row.subjectIri],
    ['predicateIri', row.predicateIri],
    ['graphIri', row.graphIri],
  ] as const) {
    if (!isSafeIri(value)) {
      fail('canonical-seal-row-term', `${label} must contain one bare safe IRI`);
    }
  }
  let object: string;
  if (row.object.kind === 'named-node') {
    if (!isSafeIri(row.object.value)) {
      fail('canonical-seal-row-term', 'named-node object must contain one bare safe IRI');
    }
    object = `<${row.object.value}>`;
  } else {
    const literal = JSON.stringify(row.object.value);
    switch (row.object.datatypeIri) {
      case 'http://www.w3.org/2001/XMLSchema#string':
        object = literal;
        break;
      case 'http://www.w3.org/2001/XMLSchema#integer':
      case 'http://www.w3.org/2001/XMLSchema#hexBinary':
      case 'http://www.w3.org/2001/XMLSchema#dateTime':
        object = `${literal}^^<${row.object.datatypeIri}>`;
        break;
      default:
        fail(
          'canonical-seal-row-term',
          `unsupported author-seal literal datatype ${row.object.datatypeIri}`,
        );
    }
  }
  return {
    subject: row.subjectIri,
    predicate: row.predicateIri,
    object,
    graph: row.graphIri,
  };
}

/**
 * Strict order-independent inverse over one fixed subject and graph. Every
 * predicate is cardinality-checked before the typed payload is materialized.
 * The store adapter must enforce RFC-64's 64 KiB query-response cap before it
 * constructs these typed rows; this codec intentionally does not invent a
 * backend-independent byte serialization for already-materialized bindings.
 */
export function decodeCanonicalGraphScopedAuthorSealRowsV1(
  rows: readonly CanonicalAuthorSealStoreRowV1[],
  coordinate: CanonicalGraphScopedAuthorSealCoordinateV1,
): DecodedCanonicalGraphScopedAuthorSealRowsV1 {
  assertCanonicalGraphScopedAuthorSealCoordinateV1(coordinate);
  assertDenseOrdinaryStoreRowsArray(rows);
  const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1(coordinate);
  const byPredicate = new Map<string, CanonicalGraphScopedAuthorSealRowV1>();
  for (let index = 0; index < rows.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(rows, index)) {
      fail('canonical-seal-row-schema', 'canonical author-seal row array must be dense');
    }
    const current = renderCanonicalAuthorSealStoreRowV1(rows[index]);
    if (current.subject !== placement.subject || current.graph !== placement.metaGraph) {
      fail('canonical-seal-row-term', 'author-seal row has the wrong subject or graph');
    }
    if (!ALLOWED_PREDICATES.has(current.predicate)) {
      fail('canonical-seal-row-cardinality', `unknown author-seal predicate ${current.predicate}`);
    }
    if (byPredicate.has(current.predicate)) {
      fail(
        'canonical-seal-row-cardinality',
        `duplicate author-seal predicate ${current.predicate}`,
      );
    }
    byPredicate.set(current.predicate, current);
  }
  for (const predicate of REQUIRED_PREDICATES) {
    if (!byPredicate.has(predicate)) {
      fail('canonical-seal-row-cardinality', `missing author-seal predicate ${predicate}`);
    }
  }

  const objectFor = (predicate: string): string => byPredicate.get(predicate)!.object;
  const payload = {
    assertionMerkleRoot: parseHexBinaryObject(
      objectFor(ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT),
      'assertionMerkleRoot',
    ),
    authorAddress: parsePlainAddressObject(
      objectFor(ASSERTION_SEAL_PREDICATES.AUTHOR_ADDRESS),
      'authorAddress',
    ),
    authorAttestationR: parseHexBinaryObject(
      objectFor(ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R),
      'authorAttestationR',
    ),
    authorAttestationVS: parseHexBinaryObject(
      objectFor(ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_VS),
      'authorAttestationVS',
    ),
    authorSchemeVersion: parseIntegerObject(
      objectFor(ASSERTION_SEAL_PREDICATES.AUTHOR_SCHEME_VERSION),
      'authorSchemeVersion',
    ),
    assertedAtChainId: parseIntegerObject(
      objectFor(ASSERTION_SEAL_PREDICATES.ASSERTED_AT_CHAIN_ID),
      'assertedAtChainId',
    ),
    assertedAtKav10Address: parsePlainAddressObject(
      objectFor(ASSERTION_SEAL_PREDICATES.ASSERTED_AT_KAV10_ADDRESS),
      'assertedAtKav10Address',
    ),
    reservedKaId: parseIntegerObject(
      objectFor(ASSERTION_SEAL_PREDICATES.RESERVED_KA_ID),
      'reservedKaId',
    ),
    assertionFinalizedAt: parseDateTimeObject(
      objectFor(ASSERTION_SEAL_PREDICATES.ASSERTION_FINALIZED_AT),
    ),
    contentScopeVersion: parseIntegerObject(
      objectFor(ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION),
      'contentScopeVersion',
    ),
    kaUal: parseIriObject(objectFor(ASSERTION_SEAL_PREDICATES.KA_UAL)),
    assertionVersion: parseIntegerObject(
      objectFor(ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION),
      'assertionVersion',
    ),
    publicTripleCount: parseIntegerObject(
      objectFor(ASSERTION_SEAL_PREDICATES.PUBLIC_TRIPLE_COUNT),
      'publicTripleCount',
    ),
    privateTripleCount: parseIntegerObject(
      objectFor(ASSERTION_SEAL_PREDICATES.PRIVATE_TRIPLE_COUNT),
      'privateTripleCount',
    ),
    privateMerkleRoot: byPredicate.has(PRIVATE_ROOT_PREDICATE)
      ? parseHexBinaryObject(objectFor(PRIVATE_ROOT_PREDICATE), 'privateMerkleRoot')
      : null,
  };
  assertCanonicalGraphScopedAuthorSealV1(payload);
  if (payload.authorAddress !== coordinate.authorAddress) {
    fail('canonical-seal-binding', 'decoded payload author differs from catalog coordinate');
  }

  const projectedRows = projectCanonicalGraphScopedAuthorSealRowsV1(payload, coordinate);
  if (projectedRows.length !== rows.length) {
    fail('canonical-seal-row-cardinality', 'private-root row cardinality is inconsistent');
  }
  for (const expected of projectedRows) {
    const actual = byPredicate.get(expected.predicate);
    if (!actual || !sameRow(expected, actual)) {
      fail(
        'canonical-seal-row-term',
        `noncanonical RDF term for predicate ${expected.predicate}`,
      );
    }
  }
  const canonicalSealBytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(payload);
  return {
    payload,
    canonicalSealBytes,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(payload),
    placement,
    rows: projectedRows,
  };
}

/**
 * Strictly decode/reconstruct, then invoke the PR #1780 classifier exactly
 * once. This returns only a structural publishable-seal candidate; it performs
 * no catalog-row, signature/root, deployment, or chain-authority admission.
 */
export function classifyCanonicalGraphScopedAuthorSealRowsV1(
  rows: readonly CanonicalAuthorSealStoreRowV1[],
  coordinate: CanonicalGraphScopedAuthorSealCoordinateV1,
): ClassifiedCanonicalGraphScopedAuthorSealRowsV1 {
  const decoded = decodeCanonicalGraphScopedAuthorSealRowsV1(rows, coordinate);
  const classifierRows = decoded.rows.map(({ subject, predicate, object }) => ({
    subject,
    predicate,
    object,
  }));
  const candidate = parseGraphScopedAssertionSealCandidate(
    classifierRows,
    decoded.placement.subject,
  );
  if (!candidate) {
    fail(
      'canonical-seal-candidate-rejected',
      'PR #1780 rejected the strictly reconstructed graph-scoped author seal',
    );
  }
  return { ...decoded, candidate };
}

function canonicalizePayloadAfterValidation(payload: CanonicalGraphScopedAuthorSealV1): string {
  try {
    return canonicalizeJson(payload as unknown as CanonicalJsonValue, {
      maxBytes: MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1,
      maxDepth: 1,
    });
  } catch (cause) {
    fail('canonical-seal-too-large', 'canonical author-seal payload exceeds its v1 bounds', cause);
  }
}

function assertCanonicalIsoUtcMillisV1(
  value: unknown,
): asserts value is CanonicalIsoUtcMillisV1 {
  if (typeof value !== 'string' || !CANONICAL_UTC_MILLIS.test(value)) {
    fail(
      'canonical-seal-timestamp',
      'assertionFinalizedAt must use exact YYYY-MM-DDTHH:mm:ss.sssZ form',
    );
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) {
    fail('canonical-seal-timestamp', 'assertionFinalizedAt is not a real UTC instant');
  }
}

function assertCanonicalSealDeterministicUalV1(value: unknown): {
  ual: CanonicalDeterministicUalV1;
  agentAddress: EvmAddressV1;
  kaNumber: string;
} {
  try {
    const parsed = assertSharedCanonicalDeterministicUalV1(value);
    return {
      ual: parsed.ual,
      agentAddress: parsed.agentAddress,
      kaNumber: parsed.kaNumber,
    };
  } catch (cause) {
    if (cause instanceof CanonicalGraphScopedAuthorSealError) throw cause;
    fail('canonical-seal-ual', 'kaUal is not a canonical deterministic v10 UAL', cause);
  }
}

function assertSealTripleCountV1(value: unknown, label: string): bigint {
  const count = assertSealU64(value, label);
  if (count > MAX_SEAL_TRIPLE_COUNT_V1) {
    fail('canonical-seal-count', `${label} exceeds 2^53-1`);
  }
  return count;
}

function assertHex32V1(value: unknown, label: string): asserts value is Hex32V1 {
  assertSealScalar(() => assertCanonicalDigest(value, label));
}

function assertSealU64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail('canonical-seal-scalar', `${label} is not a canonical DecimalU64V1`, cause);
  }
}

function assertSealU256(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU256(value, label);
  } catch (cause) {
    fail('canonical-seal-scalar', `${label} is not a canonical DecimalU256V1`, cause);
  }
}

function assertSealScalar(operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    fail('canonical-seal-scalar', 'author-seal scalar is not canonical', cause);
  }
}

function assertClosedKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  try {
    assertExactKeys(record, keys, label);
  } catch (cause) {
    fail('canonical-seal-schema', `${label} has an invalid field set`, cause);
  }
}

function assertClosedCoordinateKeys(record: Record<string, unknown>): void {
  try {
    assertExactKeys(record, [
      'assertionCoordinate',
      'authorAddress',
      'contextGraphId',
      'subGraphName',
    ], 'catalog assertion coordinate');
  } catch (cause) {
    fail('canonical-seal-coordinate', 'catalog assertion coordinate has invalid fields', cause);
  }
}

function assertCanonicalAuthorSealStoreRowShape(
  row: unknown,
): asserts row is CanonicalAuthorSealStoreRowV1 {
  if (!isPlainRecord(row)) {
    fail('canonical-seal-row-schema', 'author-seal store row must be a plain object');
  }
  try {
    assertExactKeys(
      row,
      ['graphIri', 'object', 'predicateIri', 'subjectIri'],
      'author-seal store row',
    );
  } catch (cause) {
    fail('canonical-seal-row-schema', 'author-seal store row has invalid fields', cause);
  }
  for (const key of ['subjectIri', 'predicateIri', 'graphIri']) {
    if (typeof row[key] !== 'string') {
      fail('canonical-seal-row-schema', `author-seal store row ${key} must be a string`);
    }
  }
  if (!isPlainRecord(row.object)) {
    fail('canonical-seal-row-schema', 'author-seal store object must be a plain object');
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(row.object, 'kind');
  if (
    !kindDescriptor?.enumerable
    || !Object.prototype.hasOwnProperty.call(kindDescriptor, 'value')
  ) {
    fail('canonical-seal-row-schema', 'author-seal store object kind must be a data property');
  }
  if (kindDescriptor.value === 'named-node') {
    try {
      assertExactKeys(row.object, ['kind', 'value'], 'named-node object');
    } catch (cause) {
      fail('canonical-seal-row-schema', 'named-node object has invalid fields', cause);
    }
    if (typeof row.object.value !== 'string') {
      fail('canonical-seal-row-schema', 'named-node value must be a string');
    }
    return;
  }
  if (kindDescriptor.value === 'literal') {
    try {
      assertExactKeys(row.object, ['datatypeIri', 'kind', 'value'], 'literal object');
    } catch (cause) {
      fail('canonical-seal-row-schema', 'literal object has invalid fields', cause);
    }
    if (typeof row.object.value !== 'string' || typeof row.object.datatypeIri !== 'string') {
      fail('canonical-seal-row-schema', 'literal value and datatypeIri must be strings');
    }
    return;
  }
  fail('canonical-seal-row-schema', 'author-seal store object has an unsupported kind');
}

function assertDenseOrdinaryStoreRowsArray(
  rows: unknown,
): asserts rows is CanonicalAuthorSealStoreRowV1[] {
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) {
    fail('canonical-seal-row-schema', 'author-seal rows must be an ordinary Array');
  }
  if (rows.length !== 14 && rows.length !== 15) {
    fail('canonical-seal-row-cardinality', 'canonical author seal must contain 14 or 15 rows');
  }
  const ownKeys = Reflect.ownKeys(rows);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== rows.length + 1
    || !ownKeys.includes('length')
  ) {
    fail(
      'canonical-seal-row-schema',
      'author-seal rows must be dense and contain no custom properties',
    );
  }
  for (let index = 0; index < rows.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(
        'canonical-seal-row-schema',
        'author-seal rows must contain enumerable data properties',
      );
    }
  }
}

function rejectOversizedInput(input: string | Uint8Array): void {
  if (typeof input !== 'string') {
    if (input.byteLength > MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1) {
      fail('canonical-seal-too-large', 'canonical author-seal input exceeds 16384 bytes');
    }
    return;
  }
  if (
    input.length > MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1
    || UTF8.encode(input).byteLength > MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1
  ) {
    fail('canonical-seal-too-large', 'canonical author-seal input exceeds 16384 bytes');
  }
}

function parseHexBinaryObject(object: string, label: string): string {
  const match = /^"([0-9a-f]{64})"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#hexBinary>$/.exec(object);
  if (!match) fail('canonical-seal-row-term', `${label} is not the exact xsd:hexBinary term`);
  return `0x${match[1]}`;
}

function parsePlainAddressObject(object: string, label: string): string {
  const match = /^"(0x[0-9a-f]{40})"$/.exec(object);
  if (!match) fail('canonical-seal-row-term', `${label} is not the exact plain address term`);
  return match[1];
}

function parseIntegerObject(object: string, label: string): string {
  const match = /^"(0|[1-9][0-9]*)"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer>$/.exec(object);
  if (!match) fail('canonical-seal-row-term', `${label} is not the exact xsd:integer term`);
  return match[1];
}

function parseDateTimeObject(object: string): string {
  const suffix = `^^${XSD_DATE_TIME}`;
  if (!object.endsWith(suffix)) {
    fail('canonical-seal-row-term', 'assertionFinalizedAt is not the exact xsd:dateTime term');
  }
  const literal = object.slice(0, -suffix.length);
  if (!/^"[^"\\]*"$/.test(literal)) {
    fail('canonical-seal-row-term', 'assertionFinalizedAt has a noncanonical string literal');
  }
  return literal.slice(1, -1);
}

function parseIriObject(object: string): string {
  const match = /^<([^<>"{}|\\^`\u0000-\u0020]+)>$/.exec(object);
  if (!match) fail('canonical-seal-row-term', 'kaUal is not the exact IRI object form');
  return match[1];
}

function integerObject(value: string): string {
  return `${JSON.stringify(value)}^^${XSD_INTEGER}`;
}

function hexBinaryObject(value: string): string {
  return `${JSON.stringify(value.slice(2))}^^${XSD_HEX_BINARY}`;
}

function hex32ToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + (index * 2), 4 + (index * 2)), 16);
  }
  return bytes;
}

function bytesToLowerHex32(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength !== 32) {
    fail('canonical-seal-scalar', `${label} must contain exactly 32 bytes`);
  }
  let result = '0x';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

function bytesToDigest(bytes: Uint8Array): Digest32V1 {
  let result = '0x';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  assertCanonicalDigest(result, 'computed canonical author-seal digest');
  return result;
}

function sameOrderedRows(
  left: readonly CanonicalGraphScopedAuthorSealRowV1[],
  right: readonly CanonicalGraphScopedAuthorSealRowV1[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!sameRow(left[index], right[index])) return false;
  }
  return true;
}

function sameRow(
  left: CanonicalGraphScopedAuthorSealRowV1,
  right: CanonicalGraphScopedAuthorSealRowV1,
): boolean {
  return left.subject === right.subject
    && left.predicate === right.predicate
    && left.object === right.object
    && left.graph === right.graph;
}

function fail(
  code: CanonicalGraphScopedAuthorSealErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new CanonicalGraphScopedAuthorSealError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
