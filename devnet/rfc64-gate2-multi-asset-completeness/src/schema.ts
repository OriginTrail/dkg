import { isSafeNonNegativeInteger, isSha256Hex } from './canonical.ts';

export const RAW_SCHEMA_ID = 'rfc64-gate2-multi-asset-completeness/raw@1' as const;
export const VERDICT_SCHEMA_ID = 'rfc64-gate2-multi-asset-completeness/verdict@1' as const;

// This contract is a closed fixture harness. It is NOT wired to any product
// runtime, so it can never assert that a real Gate 2 evaluation passed. These
// two markers are always present, on every raw artifact and every verdict, and
// are set from these constants by the verifier itself (never trusted from
// input) so a green fixture can never be read as a real gate pass.
export const PRODUCT_BOUNDARY = 'not-connected' as const;
export const GATE_EVALUATION = 'not-evaluated' as const;

/** One asset's completeness row. `ual` is the primary identity/order key. */
export type AssetRowV1 = {
  readonly ual: string;
  readonly contentDigest: string;
  readonly contentLength: number;
  readonly bundleDigest: string;
  readonly bundleLength: number;
}

export type RawEvidenceV1 = {
  readonly schema: typeof RAW_SCHEMA_ID;
  readonly productBoundary: typeof PRODUCT_BOUNDARY;
  readonly gateEvaluation: typeof GATE_EVALUATION;
  readonly authored: readonly AssetRowV1[];
  readonly received: readonly AssetRowV1[];
  readonly totalCount: number;
  readonly inventorySetRoot: string;
}

export type CompletenessChecksV1 = {
  readonly schemaWellFormed: boolean;
  readonly authoredRowsWellFormed: boolean;
  readonly receivedRowsWellFormed: boolean;
  readonly authoredUniqueUals: boolean;
  readonly receivedUniqueUals: boolean;
  readonly authoredCanonicalOrder: boolean;
  readonly receivedCanonicalOrder: boolean;
  readonly totalCountMatchesAuthored: boolean;
  readonly noMissing: boolean;
  readonly noExtra: boolean;
  readonly perRowExactMatch: boolean;
  readonly inventorySetRootMatches: boolean;
}

export type VerdictV1 = {
  readonly schema: typeof VERDICT_SCHEMA_ID;
  readonly productBoundary: typeof PRODUCT_BOUNDARY;
  readonly gateEvaluation: typeof GATE_EVALUATION;
  /**
   * True only when every completeness invariant holds for this fixture. This is
   * a FIXTURE-level property, deliberately distinct from any gate disposition:
   * `gateEvaluation` stays `not-evaluated` regardless of this value.
   */
  readonly fixtureComplete: boolean;
  readonly checks: CompletenessChecksV1;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly duplicateUals: readonly string[];
  readonly mismatchedUals: readonly string[];
  readonly recomputedInventorySetRoot: string;
  readonly rejectReasons: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const ROW_KEYS = ['bundleDigest', 'bundleLength', 'contentDigest', 'contentLength', 'ual'];
const RAW_KEYS = [
  'authored',
  'gateEvaluation',
  'inventorySetRoot',
  'productBoundary',
  'received',
  'schema',
  'totalCount',
];

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseRow(value: unknown): AssetRowV1 | undefined {
  if (!isPlainObject(value) || !exactKeys(value, ROW_KEYS)) return undefined;
  const { ual, contentDigest, contentLength, bundleDigest, bundleLength } = value;
  if (typeof ual !== 'string' || ual.length === 0) return undefined;
  if (!isSha256Hex(contentDigest) || !isSha256Hex(bundleDigest)) return undefined;
  if (!isSafeNonNegativeInteger(contentLength) || !isSafeNonNegativeInteger(bundleLength)) {
    return undefined;
  }
  return Object.freeze({ ual, contentDigest, contentLength, bundleDigest, bundleLength });
}

function parseRowArray(value: unknown): readonly AssetRowV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: AssetRowV1[] = [];
  for (const entry of value) {
    const row = parseRow(entry);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return Object.freeze(rows);
}

/**
 * Fail-closed structural parse of raw evidence. Returns `undefined` for any
 * shape deviation — unknown or missing keys, wrong types, malformed hex,
 * non-integer lengths, or the wrong schema/boundary literals — so the verifier
 * can record a schema rejection rather than trusting or throwing on bad input.
 */
export function parseRawEvidence(value: unknown): RawEvidenceV1 | undefined {
  if (!isPlainObject(value) || !exactKeys(value, RAW_KEYS)) return undefined;
  if (value.schema !== RAW_SCHEMA_ID) return undefined;
  if (value.productBoundary !== PRODUCT_BOUNDARY) return undefined;
  if (value.gateEvaluation !== GATE_EVALUATION) return undefined;
  if (!isSafeNonNegativeInteger(value.totalCount)) return undefined;
  if (!isSha256Hex(value.inventorySetRoot)) return undefined;
  const authored = parseRowArray(value.authored);
  const received = parseRowArray(value.received);
  if (authored === undefined || received === undefined) return undefined;
  return Object.freeze({
    schema: RAW_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    authored,
    received,
    totalCount: value.totalCount,
    inventorySetRoot: value.inventorySetRoot,
  });
}
