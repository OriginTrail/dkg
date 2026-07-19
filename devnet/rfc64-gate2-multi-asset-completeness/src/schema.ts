import {
  UTF8,
  isAddress,
  isDigest32,
  parseCanonicalU64,
  parseCanonicalU256,
} from './canonical.ts';

export const RAW_SCHEMA_ID = 'rfc64-gate2-multi-asset-completeness/raw@1' as const;
export const VERDICT_SCHEMA_ID = 'rfc64-gate2-multi-asset-completeness/verdict@1' as const;
export const PRODUCT_BOUNDARY = 'not-connected' as const;
export const GATE_EVALUATION = 'not-evaluated' as const;
export const MAX_GATE2_ROWS = 1024;

const NETWORK_ID = /^[A-Za-z0-9._:-]+$/u;
const CONTEXT_GRAPH_ID = /^[A-Za-z0-9_:/\.@-]+$/u;
const MAX_NETWORK_ID_BYTES = 128;
const MAX_CONTEXT_GRAPH_ID_BYTES = 256;
const MAX_UAL_BYTES = 1024;
const MAX_KA_NUMBER = (1n << 96n) - 1n;

export type CatalogScopeV1 = {
  readonly networkId: string;
  readonly contextGraphId: string;
  readonly governanceChainId: string | null;
  readonly governanceContractAddress: string | null;
  readonly ownershipTransitionDigest: string | null;
  readonly subGraphName: null;
  readonly authorAddress: string;
  readonly era: string;
  readonly bucketCount: '1';
};

/** Exact shape emitted by the Gate 2 completeness helper and native receiver. */
export type AssetRowV1 = {
  readonly kaId: string;
  readonly catalogRowDigest: string;
  readonly contentDigest: string;
  readonly sealDigest: string;
  readonly bundleDigest: string;
  readonly kaUal: string;
  readonly activatedTripleCount: number;
};

export type AuthoredInventoryV1 = {
  readonly catalogScope: CatalogScopeV1;
  readonly declaredCatalogScopeDigest: string;
  readonly catalogHeadDigest: string;
  readonly catalogHeadTotalRows: string;
  readonly signedBucketRowCount: string;
  readonly signedRows: readonly AssetRowV1[];
};

export type ReceivedInventoryV1 = {
  readonly catalogHeadDigest: string;
  readonly declaredInventoryDigest: string;
  readonly inventoryRowCount: number;
  readonly activatedRows: readonly AssetRowV1[];
};

export type RawEvidenceV1 = {
  readonly schema: typeof RAW_SCHEMA_ID;
  readonly productBoundary: typeof PRODUCT_BOUNDARY;
  readonly gateEvaluation: typeof GATE_EVALUATION;
  readonly authored: AuthoredInventoryV1;
  readonly received: ReceivedInventoryV1;
};

export type CompletenessChecksV1 = {
  readonly schemaWellFormed: boolean;
  readonly rowCountWithinBounds: boolean;
  readonly catalogScopeDigestMatches: boolean;
  readonly catalogHeadMatches: boolean;
  readonly headCountMatchesSignedRows: boolean;
  readonly bucketCountMatchesSignedRows: boolean;
  readonly receivedCountMatchesSignedRows: boolean;
  readonly signedRowsCanonicalOrder: boolean;
  readonly activatedRowsCanonicalOrder: boolean;
  readonly signedRowsUnique: boolean;
  readonly activatedRowsUnique: boolean;
  readonly rowsBindCatalogScope: boolean;
  readonly noMissing: boolean;
  readonly noExtra: boolean;
  readonly perRowExactMatch: boolean;
  readonly inventoryDigestMatches: boolean;
};

export type VerdictV1 = {
  readonly schema: typeof VERDICT_SCHEMA_ID;
  readonly productBoundary: typeof PRODUCT_BOUNDARY;
  readonly gateEvaluation: typeof GATE_EVALUATION;
  /** Fixture-only result; it is never a Gate 2 disposition. */
  readonly fixtureComplete: boolean;
  readonly checks: CompletenessChecksV1;
  readonly missingKaIds: readonly string[];
  readonly extraKaIds: readonly string[];
  readonly duplicateKaIds: readonly string[];
  readonly duplicateUals: readonly string[];
  readonly mismatchedKaIds: readonly string[];
  readonly recomputedCatalogScopeDigest: string;
  readonly recomputedInventoryDigest: string;
  readonly rejectReasons: readonly string[];
};

const RAW_KEYS = ['authored', 'gateEvaluation', 'productBoundary', 'received', 'schema'];
const AUTHORED_KEYS = [
  'catalogHeadDigest',
  'catalogHeadTotalRows',
  'catalogScope',
  'declaredCatalogScopeDigest',
  'signedBucketRowCount',
  'signedRows',
];
const RECEIVED_KEYS = [
  'activatedRows',
  'catalogHeadDigest',
  'declaredInventoryDigest',
  'inventoryRowCount',
];
const SCOPE_KEYS = [
  'authorAddress',
  'bucketCount',
  'contextGraphId',
  'era',
  'governanceChainId',
  'governanceContractAddress',
  'networkId',
  'ownershipTransitionDigest',
  'subGraphName',
];
const ROW_KEYS = [
  'activatedTripleCount',
  'bundleDigest',
  'catalogRowDigest',
  'contentDigest',
  'kaId',
  'kaUal',
  'sealDigest',
];

/**
 * Fail-closed, data-descriptor-only snapshot. It never performs property gets,
 * rejects accessors, snapshots switching Proxies once, and checks the 1,024-row
 * work ceiling before enumerating array keys or elements.
 */
export function parseRawEvidence(value: unknown): RawEvidenceV1 | undefined {
  try {
    const raw = snapshotExactRecord(value, RAW_KEYS);
    if (
      raw.schema !== RAW_SCHEMA_ID
      || raw.productBoundary !== PRODUCT_BOUNDARY
      || raw.gateEvaluation !== GATE_EVALUATION
    ) return undefined;

    const authoredInput = snapshotExactRecord(raw.authored, AUTHORED_KEYS);
    const receivedInput = snapshotExactRecord(raw.received, RECEIVED_KEYS);
    const catalogScope = parseScope(authoredInput.catalogScope);
    if (catalogScope === undefined) return undefined;
    if (
      !isDigest32(authoredInput.declaredCatalogScopeDigest)
      || !isDigest32(authoredInput.catalogHeadDigest)
      || parseCanonicalU64(authoredInput.catalogHeadTotalRows) === undefined
      || parseCanonicalU64(authoredInput.signedBucketRowCount) === undefined
      || !isDigest32(receivedInput.catalogHeadDigest)
      || !isDigest32(receivedInput.declaredInventoryDigest)
      || !Number.isSafeInteger(receivedInput.inventoryRowCount)
      || (receivedInput.inventoryRowCount as number) < 0
    ) return undefined;

    const signedRows = parseRows(authoredInput.signedRows);
    const activatedRows = parseRows(receivedInput.activatedRows);
    if (signedRows === undefined || activatedRows === undefined) return undefined;

    return Object.freeze({
      schema: RAW_SCHEMA_ID,
      productBoundary: PRODUCT_BOUNDARY,
      gateEvaluation: GATE_EVALUATION,
      authored: Object.freeze({
        catalogScope,
        declaredCatalogScopeDigest: authoredInput.declaredCatalogScopeDigest,
        catalogHeadDigest: authoredInput.catalogHeadDigest,
        catalogHeadTotalRows: authoredInput.catalogHeadTotalRows,
        signedBucketRowCount: authoredInput.signedBucketRowCount,
        signedRows,
      }) as AuthoredInventoryV1,
      received: Object.freeze({
        catalogHeadDigest: receivedInput.catalogHeadDigest,
        declaredInventoryDigest: receivedInput.declaredInventoryDigest,
        inventoryRowCount: receivedInput.inventoryRowCount,
        activatedRows,
      }) as ReceivedInventoryV1,
    });
  } catch {
    return undefined;
  }
}

function parseScope(value: unknown): CatalogScopeV1 | undefined {
  const scope = snapshotExactRecord(value, SCOPE_KEYS);
  if (
    !boundedIdentifier(scope.networkId, NETWORK_ID, MAX_NETWORK_ID_BYTES)
    || !boundedIdentifier(scope.contextGraphId, CONTEXT_GRAPH_ID, MAX_CONTEXT_GRAPH_ID_BYTES)
    || !isAddress(scope.authorAddress)
    || parseCanonicalU64(scope.era) === undefined
    || scope.bucketCount !== '1'
    || scope.subGraphName !== null
    || (scope.ownershipTransitionDigest !== null && !isDigest32(scope.ownershipTransitionDigest))
  ) return undefined;
  const governanceNull = scope.governanceChainId === null
    && scope.governanceContractAddress === null;
  const governancePresent = parseCanonicalU256(scope.governanceChainId) !== undefined
    && isAddress(scope.governanceContractAddress);
  if (!governanceNull && !governancePresent) return undefined;
  return Object.freeze({
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    governanceChainId: scope.governanceChainId,
    governanceContractAddress: scope.governanceContractAddress,
    ownershipTransitionDigest: scope.ownershipTransitionDigest,
    subGraphName: null,
    authorAddress: scope.authorAddress,
    era: scope.era,
    bucketCount: '1',
  }) as CatalogScopeV1;
}

function parseRows(value: unknown): readonly AssetRowV1[] | undefined {
  const inputs = snapshotDenseArray(value);
  const rows: AssetRowV1[] = [];
  for (const input of inputs) {
    const row = snapshotExactRecord(input, ROW_KEYS);
    const kaId = parseCanonicalU256(row.kaId);
    if (
      kaId === undefined
      || !isDigest32(row.catalogRowDigest)
      || !isDigest32(row.contentDigest)
      || !isDigest32(row.sealDigest)
      || !isDigest32(row.bundleDigest)
      || typeof row.kaUal !== 'string'
      || row.kaUal.length === 0
      || row.kaUal.normalize('NFC') !== row.kaUal
      || UTF8.encode(row.kaUal).byteLength > MAX_UAL_BYTES
      || !Number.isSafeInteger(row.activatedTripleCount)
      || (row.activatedTripleCount as number) < 1
    ) return undefined;
    rows.push(Object.freeze({
      kaId: row.kaId,
      catalogRowDigest: row.catalogRowDigest,
      contentDigest: row.contentDigest,
      sealDigest: row.sealDigest,
      bundleDigest: row.bundleDigest,
      kaUal: row.kaUal,
      activatedTripleCount: row.activatedTripleCount,
    }) as AssetRowV1);
  }
  return Object.freeze(rows);
}

export function rowBindsToScope(row: AssetRowV1, scope: CatalogScopeV1): boolean {
  const prefix = `did:dkg:${scope.networkId}/${scope.authorAddress}/`;
  if (!row.kaUal.startsWith(prefix)) return false;
  const numberText = row.kaUal.slice(prefix.length);
  const kaNumber = parseCanonicalU256(numberText);
  if (kaNumber === undefined || kaNumber > MAX_KA_NUMBER) return false;
  const packed = (BigInt(scope.authorAddress) << 96n) | kaNumber;
  return packed === BigInt(row.kaId) && row.kaUal === `${prefix}${kaNumber.toString()}`;
}

function boundedIdentifier(value: unknown, pattern: RegExp, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.normalize('NFC') === value
    && UTF8.encode(value).byteLength <= maxBytes
    && pattern.test(value);
}

function snapshotDenseArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('rows must be an ordinary Array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined
    || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > MAX_GATE2_ROWS
  ) throw new TypeError('row array length is outside the closed 0..1024 parse bound');
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== length + 1
    || !keys.includes('length')
  ) throw new TypeError('row array must be dense and property-free');
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) throw new TypeError('row array elements must be enumerable data fields');
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('value must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('non-plain object');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) throw new TypeError('missing or extra fields');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) throw new TypeError('fields must be enumerable data properties');
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
