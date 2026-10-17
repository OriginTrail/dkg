import { assertSwmAuthorInventorySnapshotBindingV1, compareSwmAuthorInventoryRowsV1,
  deriveAuthorCatalogScopeFromHeadV1, computeAuthorCatalogScopeDigestV1,
  computeAuthorCatalogHeadObjectDigestV1, computeAuthorCatalogDirectoryNodeObjectDigestV1,
  computeAuthorCatalogBucketObjectDigestV1, assertAuthorCatalogDirectoryNodeScopeBindingV1,
  assertAuthorCatalogBucketScopeBindingV1, canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1, canonicalizeAuthorCatalogRowV1 } from '../../packages/core/dist/index.js';

export const unsigned = envelope => Object.fromEntries(['issuer', 'objectType', 'payload', 'signatureSuite', 'signatureEvidence'].map(k => [k, envelope[k]]));
export const inventoryRow = row => ({ assertionCoordinate: row.assertion_coordinate, kaUal: row.ka_ual,
  assertionVersion: BigInt(row.assertion_version_u64be).toString(), shareOperationId: row.share_operation_id,
  projectionDigest: row.projection_digest, publicTripleCount: BigInt(row.public_triple_count_u64be).toString(),
  privateTripleCount: BigInt(row.private_triple_count_u64be).toString(), sealDigest: row.seal_digest,
  sharedAt: BigInt(row.shared_at_u64be).toString(), expiresAt: row.expires_at_u64be === null ? null : BigInt(row.expires_at_u64be).toString() });

export function verifyInventoryCommitment(head, rows) {
  assertSwmAuthorInventorySnapshotBindingV1({ head, rows: rows.map(inventoryRow).sort(compareSwmAuthorInventoryRowsV1) });
}

/** Verify the complete immutable object closure, without inventing signature authority. */
export function verifyCatalogCommitment(catalog, applied) {
  const head = unsigned(catalog.head), scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
  const scopeDigest = computeAuthorCatalogScopeDigestV1(scope), headDigest = computeAuthorCatalogHeadObjectDigestV1(head);
  const records = applied.filter(r => r.current_catalog_head_digest === headDigest
    || (r.catalog_scope_digest === scopeDigest && r.author_address === scope.authorAddress));
  if (records.length !== 1 || records[0].current_catalog_head_digest !== headDigest
    || records[0].catalog_scope_digest !== scopeDigest || records[0].author_address !== scope.authorAddress) {
    throw Error('Selected catalog does not match one exact persisted applied-head key');
  }
  const objects = new Map();
  for (const captured of catalog.objects) {
    const object = unsigned(captured); let digest;
    if (object.objectType === 'AuthorCatalogHeadV1') digest = computeAuthorCatalogHeadObjectDigestV1(object);
    else if (object.objectType === 'AuthorCatalogDirectoryNodeV1') {
      assertAuthorCatalogDirectoryNodeScopeBindingV1(object.payload, scope);
      digest = computeAuthorCatalogDirectoryNodeObjectDigestV1(object, scope.bucketCount);
    } else if (object.objectType === 'AuthorCatalogBucketV1') {
      assertAuthorCatalogBucketScopeBindingV1(object.payload, scope);
      digest = computeAuthorCatalogBucketObjectDigestV1(object);
    } else throw Error('Unexpected catalog closure object type');
    if (objects.has(digest)) throw Error('Duplicate catalog closure object');
    objects.set(digest, object);
  }
  const visited = new Set(), rows = [];
  function take(digest, type) {
    const object = objects.get(digest);
    if (!object || object.objectType !== type || visited.has(digest)) throw Error('Missing, repeated or mistyped catalog object reference');
    visited.add(digest); return object.payload;
  }
  take(headDigest, 'AuthorCatalogHeadV1');
  function walk(digest, level, first) {
    const node = take(digest, 'AuthorCatalogDirectoryNodeV1');
    if (BigInt(node.level) !== level || node.firstBucketId !== first) throw Error('Catalog directory topology mismatch');
    let count = 0n;
    for (const entry of node.entries) {
      if (level === 0n) {
        if (BigInt(entry.rowCount) === 0n) continue; // Canonical validation requires zero digest/length for absent buckets.
        const bucket = take(entry.bucketDigest, 'AuthorCatalogBucketV1');
        if (bucket.bucketId !== entry.bucketId || BigInt(bucket.rows.length) !== BigInt(entry.rowCount)
          || BigInt(canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket).byteLength) !== BigInt(entry.byteLength)) {
          throw Error('Catalog bucket differs from directory commitment');
        }
        rows.push(...bucket.rows); count += BigInt(bucket.rows.length);
      } else {
        const child = walk(entry.childDigest, level - 1n, entry.firstBucketId);
        if (child.count !== BigInt(entry.rowCount) || child.bytes !== BigInt(entry.byteLength)) throw Error('Catalog child differs from directory commitment');
        count += child.count;
      }
    }
    return { count, bytes: BigInt(canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(node, scope.bucketCount).byteLength) };
  }
  const root = walk(head.payload.directoryRootDigest, BigInt(head.payload.directoryHeight), '0');
  if (root.count !== BigInt(head.payload.totalRows) || visited.size !== objects.size) throw Error('Incomplete or extraneous catalog closure');
  const canonical = value => JSON.stringify(value.map(canonicalizeAuthorCatalogRowV1).sort());
  if (canonical(rows) !== canonical(catalog.rows)) throw Error('Exported catalog rows differ from committed directory/bucket rows');
  return { rows, scopeDigest, headDigest };
}
