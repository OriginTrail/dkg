import {
  compareRowsByKaId,
  computeAppliedInventoryDigest,
  computeCatalogScopeDigest,
} from './product-digests.ts';
import {
  GATE_EVALUATION,
  MAX_GATE2_ROWS,
  PRODUCT_BOUNDARY,
  VERDICT_SCHEMA_ID,
  parseRawEvidence,
  rowBindsToScope,
  type AssetRowV1,
  type CompletenessChecksV1,
  type RawEvidenceV1,
  type VerdictV1,
} from './schema.ts';

const CHECK_NAMES: readonly (keyof CompletenessChecksV1)[] = Object.freeze([
  'schemaWellFormed',
  'rowCountWithinBounds',
  'catalogScopeDigestMatches',
  'catalogHeadMatches',
  'headCountMatchesSignedRows',
  'bucketCountMatchesSignedRows',
  'receivedCountMatchesSignedRows',
  'signedRowsCanonicalOrder',
  'activatedRowsCanonicalOrder',
  'signedRowsUnique',
  'activatedRowsUnique',
  'rowsBindCatalogScope',
  'noMissing',
  'noExtra',
  'perRowExactMatch',
  'inventoryDigestMatches',
]);

const REASONS: Readonly<Record<keyof CompletenessChecksV1, string>> = Object.freeze({
  schemaWellFormed: 'raw evidence failed closed structural validation',
  rowCountWithinBounds: `signed and activated inventories must each contain 1..${MAX_GATE2_ROWS} rows`,
  catalogScopeDigestMatches: 'declared catalog scope digest differs from the canonical scope',
  catalogHeadMatches: 'receiver catalog head differs from the authored head',
  headCountMatchesSignedRows: 'catalog head totalRows differs from the signed row count',
  bucketCountMatchesSignedRows: 'signed bucket rowCount differs from the signed row count',
  receivedCountMatchesSignedRows: 'receiver inventoryRowCount differs from the signed row count',
  signedRowsCanonicalOrder: 'signed rows are not strictly increasing by mathematical kaId',
  activatedRowsCanonicalOrder: 'activated rows are not strictly increasing by mathematical kaId',
  signedRowsUnique: 'signed rows contain duplicate kaIds or UALs',
  activatedRowsUnique: 'activated rows contain duplicate kaIds or UALs',
  rowsBindCatalogScope: 'one or more KA UALs do not bind network, author, and packed kaId',
  noMissing: 'activated inventory is missing one or more signed kaIds',
  noExtra: 'activated inventory contains one or more unsigned kaIds',
  perRowExactMatch: 'activated row differs in UAL, content, bundle, seal, catalog-row digest, or triple count',
  inventoryDigestMatches: 'declared applied-inventory digest differs from the exact activated inventory',
});

/** Always returns a deterministic fixture-only verdict and never promotes a gate. */
export function verify(rawInput: unknown): VerdictV1 {
  try {
    const raw = parseRawEvidence(rawInput);
    if (raw === undefined) return schemaRejectVerdict();
    return verifyParsed(raw);
  } catch {
    // A revoked or adversarial Proxy may throw from any internal operation. The
    // verdict remains fixed and message-free instead of reflecting attacker text.
    return schemaRejectVerdict();
  }
}

function verifyParsed(raw: RawEvidenceV1): VerdictV1 {
  const signed = raw.authored.signedRows;
  const activated = raw.received.activatedRows;
  const signedDuplicates = duplicates(signed);
  const activatedDuplicates = duplicates(activated);

  const rowCountWithinBounds = inBounds(signed.length) && inBounds(activated.length);
  const recomputedCatalogScopeDigest = computeCatalogScopeDigest(raw.authored.catalogScope);
  const catalogScopeDigestMatches =
    recomputedCatalogScopeDigest === raw.authored.declaredCatalogScopeDigest;
  const catalogHeadMatches =
    raw.authored.catalogHeadDigest === raw.received.catalogHeadDigest;
  const headCountMatchesSignedRows =
    BigInt(raw.authored.catalogHeadTotalRows) === BigInt(signed.length);
  const bucketCountMatchesSignedRows =
    BigInt(raw.authored.signedBucketRowCount) === BigInt(signed.length);
  const receivedCountMatchesSignedRows =
    raw.received.inventoryRowCount === signed.length;
  const signedRowsCanonicalOrder = isStrictlyOrdered(signed);
  const activatedRowsCanonicalOrder = isStrictlyOrdered(activated);
  const signedRowsUnique = signedDuplicates.kaIds.length === 0
    && signedDuplicates.uals.length === 0;
  const activatedRowsUnique = activatedDuplicates.kaIds.length === 0
    && activatedDuplicates.uals.length === 0;
  const rowsBindCatalogScope = [...signed, ...activated]
    .every((row) => rowBindsToScope(row, raw.authored.catalogScope));

  const signedById = firstByKaId(signed);
  const activatedById = firstByKaId(activated);
  const missingKaIds = [...signedById.keys()]
    .filter((kaId) => !activatedById.has(kaId))
    .sort(compareKaIdStrings);
  const extraKaIds = [...activatedById.keys()]
    .filter((kaId) => !signedById.has(kaId))
    .sort(compareKaIdStrings);
  const mismatchedKaIds = [...signedById.entries()]
    .filter(([kaId, row]) => {
      const observed = activatedById.get(kaId);
      return observed !== undefined && !sameRow(row, observed);
    })
    .map(([kaId]) => kaId)
    .sort(compareKaIdStrings);
  const noMissing = missingKaIds.length === 0;
  const noExtra = extraKaIds.length === 0;
  const perRowExactMatch = mismatchedKaIds.length === 0;
  const recomputedInventoryDigest = computeAppliedInventoryDigest(
    recomputedCatalogScopeDigest,
    activated,
  );
  const inventoryDigestMatches =
    recomputedInventoryDigest === raw.received.declaredInventoryDigest;

  const checks = Object.freeze({
    schemaWellFormed: true,
    rowCountWithinBounds,
    catalogScopeDigestMatches,
    catalogHeadMatches,
    headCountMatchesSignedRows,
    bucketCountMatchesSignedRows,
    receivedCountMatchesSignedRows,
    signedRowsCanonicalOrder,
    activatedRowsCanonicalOrder,
    signedRowsUnique,
    activatedRowsUnique,
    rowsBindCatalogScope,
    noMissing,
    noExtra,
    perRowExactMatch,
    inventoryDigestMatches,
  }) satisfies CompletenessChecksV1;
  const rejectReasons = CHECK_NAMES
    .filter((name) => !checks[name])
    .map((name) => REASONS[name]);

  return Object.freeze({
    schema: VERDICT_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    fixtureComplete: CHECK_NAMES.every((name) => checks[name]),
    checks,
    missingKaIds: Object.freeze(missingKaIds),
    extraKaIds: Object.freeze(extraKaIds),
    duplicateKaIds: Object.freeze(uniqueSorted([
      ...signedDuplicates.kaIds,
      ...activatedDuplicates.kaIds,
    ], compareKaIdStrings)),
    duplicateUals: Object.freeze(uniqueSorted([
      ...signedDuplicates.uals,
      ...activatedDuplicates.uals,
    ])),
    mismatchedKaIds: Object.freeze(mismatchedKaIds),
    recomputedCatalogScopeDigest,
    recomputedInventoryDigest,
    rejectReasons: Object.freeze(rejectReasons),
  });
}

function schemaRejectVerdict(): VerdictV1 {
  const checks = Object.freeze(Object.fromEntries(
    CHECK_NAMES.map((name) => [name, false]),
  )) as Readonly<CompletenessChecksV1>;
  return Object.freeze({
    schema: VERDICT_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    fixtureComplete: false,
    checks,
    missingKaIds: Object.freeze([]),
    extraKaIds: Object.freeze([]),
    duplicateKaIds: Object.freeze([]),
    duplicateUals: Object.freeze([]),
    mismatchedKaIds: Object.freeze([]),
    recomputedCatalogScopeDigest: '',
    recomputedInventoryDigest: '',
    rejectReasons: Object.freeze([REASONS.schemaWellFormed]),
  });
}

function inBounds(length: number): boolean {
  return length >= 1 && length <= MAX_GATE2_ROWS;
}

function isStrictlyOrdered(rows: readonly AssetRowV1[]): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    if (compareRowsByKaId(rows[index - 1]!, rows[index]!) >= 0) return false;
  }
  return true;
}

function duplicates(rows: readonly AssetRowV1[]): { kaIds: string[]; uals: string[] } {
  const seenKaIds = new Set<string>();
  const seenUals = new Set<string>();
  const kaIds: string[] = [];
  const uals: string[] = [];
  for (const row of rows) {
    if (seenKaIds.has(row.kaId)) kaIds.push(row.kaId);
    if (seenUals.has(row.kaUal)) uals.push(row.kaUal);
    seenKaIds.add(row.kaId);
    seenUals.add(row.kaUal);
  }
  return {
    kaIds: uniqueSorted(kaIds, compareKaIdStrings),
    uals: uniqueSorted(uals),
  };
}

function firstByKaId(rows: readonly AssetRowV1[]): Map<string, AssetRowV1> {
  const result = new Map<string, AssetRowV1>();
  for (const row of rows) if (!result.has(row.kaId)) result.set(row.kaId, row);
  return result;
}

function sameRow(left: AssetRowV1, right: AssetRowV1): boolean {
  return left.kaId === right.kaId
    && left.catalogRowDigest === right.catalogRowDigest
    && left.contentDigest === right.contentDigest
    && left.sealDigest === right.sealDigest
    && left.bundleDigest === right.bundleDigest
    && left.kaUal === right.kaUal
    && left.activatedTripleCount === right.activatedTripleCount;
}

function compareKaIdStrings(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(
  values: readonly string[],
  compare: (left: string, right: string) => number = (left, right) => left.localeCompare(right),
): string[] {
  return [...new Set(values)].sort(compare);
}
