import { createHash } from 'node:crypto';

import {
  UTF8,
  canonicalize,
  digestBytes,
  encodeU64,
  sha256Digest,
} from './canonical.ts';
import type { AssetRowV1, CatalogScopeV1 } from './schema.ts';

const CATALOG_SCOPE_DIGEST_DOMAIN = 'dkg-author-catalog-scope-v1\n';
const APPLIED_INVENTORY_DIGEST_DOMAIN = 'dkg-rfc64-applied-inventory-v1\n';

/** Exact dkg-core `computeAuthorCatalogScopeDigestV1` framing. */
export function computeCatalogScopeDigest(scope: CatalogScopeV1): string {
  return sha256Digest(CATALOG_SCOPE_DIGEST_DOMAIN, canonicalize(scope));
}

/**
 * Exact Gate-1-compatible production applied-inventory framing. Rows are in
 * numeric KA-ID order. Bundle digests are deliberately not inside this legacy
 * commitment, so the contract separately requires exact full-row equality.
 */
export function computeAppliedInventoryDigest(
  catalogScopeDigest: string,
  inputRows: readonly AssetRowV1[],
): string {
  const rows = [...inputRows].sort(compareRowsByKaId);
  const hasher = createHash('sha256');
  hasher.update(APPLIED_INVENTORY_DIGEST_DOMAIN);
  hasher.update(digestBytes(catalogScopeDigest));
  hasher.update(encodeU64(BigInt(rows.length)));
  for (const row of rows) {
    hasher.update(digestBytes(row.catalogRowDigest));
    hasher.update(digestBytes(row.contentDigest));
    hasher.update(digestBytes(row.sealDigest));
    const ual = UTF8.encode(row.kaUal);
    hasher.update(encodeU64(BigInt(ual.byteLength)));
    hasher.update(ual);
    hasher.update(encodeU64(BigInt(row.activatedTripleCount)));
  }
  return `0x${hasher.digest('hex')}`;
}

export function compareRowsByKaId(left: AssetRowV1, right: AssetRowV1): -1 | 0 | 1 {
  const leftId = BigInt(left.kaId);
  const rightId = BigInt(right.kaId);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}
