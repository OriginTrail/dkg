import { isSafeNonNegativeInteger, isSha256Hex } from './canonical.ts';
import {
  GATE_EVALUATION,
  PRODUCT_BOUNDARY,
  VERDICT_SCHEMA_ID,
  parseRawEvidence,
  type AssetRowV1,
  type RawEvidenceV1,
  type VerdictV1,
} from './schema.ts';
import { computeInventorySetRoot } from './set-root.ts';

function rowWellFormed(row: AssetRowV1): boolean {
  return (
    typeof row.ual === 'string'
    && row.ual.length > 0
    && isSha256Hex(row.contentDigest)
    && isSha256Hex(row.bundleDigest)
    && isSafeNonNegativeInteger(row.contentLength)
    && isSafeNonNegativeInteger(row.bundleLength)
  );
}

function uals(rows: readonly AssetRowV1[]): string[] {
  return rows.map((row) => row.ual);
}

function duplicatesInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const value of values) {
    if (seen.has(value) && !duplicates.includes(value)) duplicates.push(value);
    seen.add(value);
  }
  return duplicates.sort();
}

function isSortedAscending(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! > values[index]!) return false;
  }
  return true;
}

function rowsEqual(a: AssetRowV1, b: AssetRowV1): boolean {
  return (
    a.ual === b.ual
    && a.contentDigest === b.contentDigest
    && a.contentLength === b.contentLength
    && a.bundleDigest === b.bundleDigest
    && a.bundleLength === b.bundleLength
  );
}

/** First-wins index by ual (duplicates are reported separately, not merged away). */
function indexByUal(rows: readonly AssetRowV1[]): Map<string, AssetRowV1> {
  const map = new Map<string, AssetRowV1>();
  for (const row of rows) if (!map.has(row.ual)) map.set(row.ual, row);
  return map;
}

function schemaRejectVerdict(reason: string): VerdictV1 {
  return Object.freeze({
    schema: VERDICT_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    fixtureComplete: false,
    checks: Object.freeze({
      schemaWellFormed: false,
      authoredRowsWellFormed: false,
      receivedRowsWellFormed: false,
      authoredUniqueUals: false,
      receivedUniqueUals: false,
      authoredCanonicalOrder: false,
      receivedCanonicalOrder: false,
      totalCountMatchesAuthored: false,
      noMissing: false,
      noExtra: false,
      perRowExactMatch: false,
      inventorySetRootMatches: false,
    }),
    missing: Object.freeze([]),
    extra: Object.freeze([]),
    duplicateUals: Object.freeze([]),
    mismatchedUals: Object.freeze([]),
    recomputedInventorySetRoot: '',
    rejectReasons: Object.freeze([reason]),
  });
}

/**
 * Fail-closed verification of a raw evidence artifact against the multi-asset
 * completeness contract. Always returns a verdict (never throws on bad input);
 * `fixtureComplete` is true only when every invariant holds. The gate
 * disposition stays `not-evaluated` and the product boundary `not-connected`
 * regardless — a complete fixture is not a Gate 2 pass.
 */
export function verify(rawInput: unknown): VerdictV1 {
  const raw: RawEvidenceV1 | undefined = parseRawEvidence(rawInput);
  if (raw === undefined) {
    return schemaRejectVerdict('raw evidence failed fail-closed structural schema validation');
  }

  const authoredUals = uals(raw.authored);
  const receivedUals = uals(raw.received);
  const authoredSet = new Set(authoredUals);
  const receivedSet = new Set(receivedUals);

  const authoredRowsWellFormed = raw.authored.every(rowWellFormed);
  const receivedRowsWellFormed = raw.received.every(rowWellFormed);

  // Uniqueness and duplicates are read from the raw arrays, before any Map/Set
  // collapse, so a duplicated ual cannot silently pass.
  const authoredDuplicates = duplicatesInOrder(authoredUals);
  const receivedDuplicates = duplicatesInOrder(receivedUals);
  const authoredUniqueUals = authoredDuplicates.length === 0;
  const receivedUniqueUals = receivedDuplicates.length === 0;
  const duplicateUals = [...new Set([...authoredDuplicates, ...receivedDuplicates])].sort();

  // Canonical ordering is an independent check on the array AS GIVEN, so a
  // complete-but-misordered set is still rejected.
  const authoredCanonicalOrder = isSortedAscending(authoredUals);
  const receivedCanonicalOrder = isSortedAscending(receivedUals);

  const totalCountMatchesAuthored = raw.totalCount === raw.authored.length;

  const missing = [...authoredSet].filter((ual) => !receivedSet.has(ual)).sort();
  const extra = [...receivedSet].filter((ual) => !authoredSet.has(ual)).sort();
  const noMissing = missing.length === 0;
  const noExtra = extra.length === 0;

  const authoredIndex = indexByUal(raw.authored);
  const receivedIndex = indexByUal(raw.received);
  const mismatchedUals: string[] = [];
  for (const ual of authoredSet) {
    const a = authoredIndex.get(ual);
    const b = receivedIndex.get(ual);
    if (a !== undefined && b !== undefined && !rowsEqual(a, b)) mismatchedUals.push(ual);
  }
  mismatchedUals.sort();
  const perRowExactMatch = mismatchedUals.length === 0;

  // Recomputed independently from the RECEIVED rows; the declared field is never
  // trusted. Complete + correct data yields the authored-derived declared root.
  const recomputedInventorySetRoot = computeInventorySetRoot(raw.received);
  const inventorySetRootMatches = recomputedInventorySetRoot === raw.inventorySetRoot;

  const checks = Object.freeze({
    schemaWellFormed: true,
    authoredRowsWellFormed,
    receivedRowsWellFormed,
    authoredUniqueUals,
    receivedUniqueUals,
    authoredCanonicalOrder,
    receivedCanonicalOrder,
    totalCountMatchesAuthored,
    noMissing,
    noExtra,
    perRowExactMatch,
    inventorySetRootMatches,
  });

  const rejectReasons: string[] = [];
  if (!authoredRowsWellFormed) rejectReasons.push('one or more authored rows are malformed');
  if (!receivedRowsWellFormed) rejectReasons.push('one or more received rows are malformed');
  if (!authoredUniqueUals) rejectReasons.push(`authored contains duplicate uals: ${authoredDuplicates.join(', ')}`);
  if (!receivedUniqueUals) rejectReasons.push(`received contains duplicate uals: ${receivedDuplicates.join(', ')}`);
  if (!authoredCanonicalOrder) rejectReasons.push('authored rows are not in canonical ual order');
  if (!receivedCanonicalOrder) rejectReasons.push('received rows are not in canonical ual order');
  if (!totalCountMatchesAuthored) rejectReasons.push(`totalCount ${raw.totalCount} does not equal authored count ${raw.authored.length}`);
  if (!noMissing) rejectReasons.push(`received is missing authored uals: ${missing.join(', ')}`);
  if (!noExtra) rejectReasons.push(`received has extra uals not authored: ${extra.join(', ')}`);
  if (!perRowExactMatch) rejectReasons.push(`row content/bundle digests or lengths differ for uals: ${mismatchedUals.join(', ')}`);
  if (!inventorySetRootMatches) rejectReasons.push('recomputed inventorySetRoot does not match the declared value');

  const fixtureComplete = rejectReasons.length === 0
    && Object.values(checks).every((value) => value === true);

  return Object.freeze({
    schema: VERDICT_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    fixtureComplete,
    checks,
    missing: Object.freeze(missing),
    extra: Object.freeze(extra),
    duplicateUals: Object.freeze(duplicateUals),
    mismatchedUals: Object.freeze(mismatchedUals),
    recomputedInventorySetRoot,
    rejectReasons: Object.freeze(rejectReasons),
  });
}
