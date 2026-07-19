import { canonicalize, sha256Hex, UTF8 } from './canonical.ts';
import type { AssetRowV1 } from './schema.ts';

// Domain-separated so a set root can never collide with a bare content hash or
// a leaf hash. Versioned so the algorithm can evolve without ambiguity.
const LEAF_DOMAIN = 'rfc64-gate2-multi-asset-completeness:leaf:v1\n';
const SET_ROOT_DOMAIN = 'rfc64-gate2-multi-asset-completeness:set-root:v1\n';

/** Leaf digest binding the FULL row (ual + both digests + both lengths). */
function leafHex(row: AssetRowV1): string {
  const canonicalRow = canonicalize({
    ual: row.ual,
    contentDigest: row.contentDigest,
    contentLength: row.contentLength,
    bundleDigest: row.bundleDigest,
    bundleLength: row.bundleLength,
  });
  return sha256Hex(UTF8.encode(LEAF_DOMAIN + canonicalRow));
}

/**
 * Order-independent commitment to a SET of rows: hash the sorted leaf digests
 * under a domain tag and an explicit count prefix (so different partitions can
 * never concatenate to the same preimage). Independent of input order — the
 * verifier recomputes this from the received rows and compares it to the raw
 * artifact's declared value; it never trusts the declared field.
 */
export function computeInventorySetRoot(rows: readonly AssetRowV1[]): string {
  const sortedLeaves = rows.map(leafHex).sort();
  const preimage = `${SET_ROOT_DOMAIN}${sortedLeaves.length}\n${sortedLeaves.join('\n')}`;
  return sha256Hex(UTF8.encode(preimage));
}
