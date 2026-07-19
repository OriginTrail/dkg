import { sha256Digest } from './canonical.ts';
import {
  computeAppliedInventoryDigest,
  computeCatalogScopeDigest,
} from './product-digests.ts';
import {
  GATE_EVALUATION,
  MAX_GATE2_ROWS,
  PRODUCT_BOUNDARY,
  RAW_SCHEMA_ID,
  type AssetRowV1,
  type CatalogScopeV1,
  type RawEvidenceV1,
} from './schema.ts';

const AUTHOR = '0x1111111111111111111111111111111111111111';

export const FIXTURE_SCOPE: CatalogScopeV1 = Object.freeze({
  networkId: 'otp:20430',
  contextGraphId: 'gate2-multi-asset',
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
});

function deterministicRow(index: number): AssetRowV1 {
  const kaNumber = BigInt(index + 1);
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const seed = `gate2-multi-asset:${kaNumber.toString()}`;
  return Object.freeze({
    kaId,
    catalogRowDigest: sha256Digest(`catalog-row:${seed}`),
    contentDigest: sha256Digest(`projection:${seed}`),
    sealDigest: sha256Digest(`author-seal:${seed}`),
    bundleDigest: sha256Digest(`opaque-bundle:${seed}`),
    kaUal: `did:dkg:${FIXTURE_SCOPE.networkId}/${AUTHOR}/${kaNumber.toString()}`,
    activatedTripleCount: (index % 7) + 1,
  });
}

/** Pure, byte-stable 1..1,024-row fixture shaped exactly like the product adapter. */
export function generateCompleteFixture(count: number): RawEvidenceV1 {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_GATE2_ROWS) {
    throw new RangeError(`fixture asset count must be within 1..${MAX_GATE2_ROWS}`);
  }
  const signedRows = Object.freeze(
    Array.from({ length: count }, (_unused, index) => deterministicRow(index)),
  );
  const activatedRows = Object.freeze(signedRows.map((row) => Object.freeze({ ...row })));
  const declaredCatalogScopeDigest = computeCatalogScopeDigest(FIXTURE_SCOPE);
  const catalogHeadDigest = sha256Digest(
    `catalog-head:${declaredCatalogScopeDigest}:${count.toString()}`,
  );
  const declaredInventoryDigest = computeAppliedInventoryDigest(
    declaredCatalogScopeDigest,
    activatedRows,
  );
  return Object.freeze({
    schema: RAW_SCHEMA_ID,
    productBoundary: PRODUCT_BOUNDARY,
    gateEvaluation: GATE_EVALUATION,
    authored: Object.freeze({
      catalogScope: FIXTURE_SCOPE,
      declaredCatalogScopeDigest,
      catalogHeadDigest,
      catalogHeadTotalRows: count.toString(),
      signedBucketRowCount: count.toString(),
      signedRows,
    }),
    received: Object.freeze({
      catalogHeadDigest,
      declaredInventoryDigest,
      inventoryRowCount: count,
      activatedRows,
    }),
  });
}
