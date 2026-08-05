/**
 * Fixed SQL-1 statement manifest. Every statement that can touch persistent
 * candidate rows is named here so plan gates can inspect the exact production
 * template. SQL-1 deliberately has no OFFSET-based statement.
 */
export const INVENTORY_V1_STATEMENT_SQL = Object.freeze({
  insertHeader: `
INSERT INTO rfc64_candidate_bucket_loads_v1 (
  session_id,
  catalog_scope_digest,
  author_address,
  target_catalog_head_digest,
  subgraph_name,
  catalog_era_u64be,
  bucket_count_u64be,
  bucket_id_u64be,
  bucket_object_digest,
  row_count_u64be,
  payload_byte_length_u64be
) VALUES (
  :session,
  :scope,
  :author,
  :head,
  :subgraphName,
  :era,
  :bucketCount,
  :bucket,
  :bucketObjectDigest,
  :rowCount,
  :payloadByteLength
);`,

  insertRow: `
INSERT INTO rfc64_candidate_bucket_rows_v1 (
  session_id,
  catalog_scope_digest,
  author_address,
  target_catalog_head_digest,
  bucket_id_u64be,
  ka_id_u256be,
  catalog_key_digest,
  assertion_coordinate,
  assertion_version_u64be,
  projection_id,
  projection_digest,
  seal_digest,
  transfer_codec,
  transfer_byte_length_u64be,
  transfer_chunk_size_u64be,
  transfer_chunk_count_u64be,
  transfer_blob_digest,
  transfer_chunk_tree_root,
  expected_catalog_row_digest
) VALUES (
  :session,
  :scope,
  :author,
  :head,
  :bucket,
  :kaId,
  :catalogKeyDigest,
  :assertionCoordinate,
  :assertionVersion,
  :projectionId,
  :projectionDigest,
  :sealDigest,
  :transferCodec,
  :transferByteLength,
  :transferChunkSize,
  :transferChunkCount,
  :transferBlobDigest,
  :transferChunkTreeRoot,
  :expectedCatalogRowDigest
);`,

  startupGcNext: `
SELECT session_id, catalog_scope_digest, author_address,
       target_catalog_head_digest, bucket_id_u64be
FROM rfc64_candidate_bucket_loads_v1
WHERE session_id > zeroblob(32)
ORDER BY session_id, catalog_scope_digest, author_address,
         target_catalog_head_digest, bucket_id_u64be
LIMIT 8;`,

  discardSessionNext: `
SELECT session_id, catalog_scope_digest, author_address,
       target_catalog_head_digest, bucket_id_u64be
FROM rfc64_candidate_bucket_loads_v1
WHERE session_id = :session
ORDER BY catalog_scope_digest, author_address,
         target_catalog_head_digest, bucket_id_u64be
LIMIT 8;`,

  getHeader: `
SELECT *
FROM rfc64_candidate_bucket_loads_v1
WHERE session_id = :session
  AND catalog_scope_digest = :scope
  AND author_address = :author
  AND target_catalog_head_digest = :head
  AND bucket_id_u64be = :bucket;`,

  getRowsFirst: `
SELECT *
FROM rfc64_candidate_bucket_rows_v1
WHERE session_id = :session
  AND catalog_scope_digest = :scope
  AND author_address = :author
  AND target_catalog_head_digest = :head
  AND bucket_id_u64be = :bucket
ORDER BY ka_id_u256be
LIMIT :limit;`,

  getRowsNext: `
SELECT *
FROM rfc64_candidate_bucket_rows_v1
WHERE session_id = :session
  AND catalog_scope_digest = :scope
  AND author_address = :author
  AND target_catalog_head_digest = :head
  AND bucket_id_u64be = :bucket
  AND ka_id_u256be > :afterKaIdU256be
ORDER BY ka_id_u256be
LIMIT :limit;`,

  getRowsExactRetry: `
SELECT *
FROM rfc64_candidate_bucket_rows_v1
WHERE session_id = :session
  AND catalog_scope_digest = :scope
  AND author_address = :author
  AND target_catalog_head_digest = :head
  AND bucket_id_u64be = :bucket
ORDER BY ka_id_u256be
LIMIT 1025;`,

  diffAddedOrChangedFirst: `
SELECT n.*
FROM rfc64_candidate_bucket_rows_v1 AS n
LEFT JOIN rfc64_candidate_bucket_rows_v1 AS o
  ON o.session_id = :oldSession
 AND o.catalog_scope_digest = :scope
 AND o.author_address = :author
 AND o.target_catalog_head_digest = :oldHead
 AND o.ka_id_u256be = n.ka_id_u256be
WHERE n.session_id = :newSession
  AND n.catalog_scope_digest = :scope
  AND n.author_address = :author
  AND n.target_catalog_head_digest = :newHead
  AND n.bucket_id_u64be = :bucket
  AND (
    o.ka_id_u256be IS NULL
    OR o.expected_catalog_row_digest <> n.expected_catalog_row_digest
  )
ORDER BY n.ka_id_u256be
LIMIT :limit;`,

  diffAddedOrChangedNext: `
SELECT n.*
FROM rfc64_candidate_bucket_rows_v1 AS n
LEFT JOIN rfc64_candidate_bucket_rows_v1 AS o
  ON o.session_id = :oldSession
 AND o.catalog_scope_digest = :scope
 AND o.author_address = :author
 AND o.target_catalog_head_digest = :oldHead
 AND o.ka_id_u256be = n.ka_id_u256be
WHERE n.session_id = :newSession
  AND n.catalog_scope_digest = :scope
  AND n.author_address = :author
  AND n.target_catalog_head_digest = :newHead
  AND n.bucket_id_u64be = :bucket
  AND n.ka_id_u256be > :afterKaIdU256be
  AND (
    o.ka_id_u256be IS NULL
    OR o.expected_catalog_row_digest <> n.expected_catalog_row_digest
  )
ORDER BY n.ka_id_u256be
LIMIT :limit;`,

  diffRemovedFirst: `
SELECT o.*
FROM rfc64_candidate_bucket_rows_v1 AS o
LEFT JOIN rfc64_candidate_bucket_rows_v1 AS n
  ON n.session_id = :newSession
 AND n.catalog_scope_digest = :scope
 AND n.author_address = :author
 AND n.target_catalog_head_digest = :newHead
 AND n.ka_id_u256be = o.ka_id_u256be
WHERE o.session_id = :oldSession
  AND o.catalog_scope_digest = :scope
  AND o.author_address = :author
  AND o.target_catalog_head_digest = :oldHead
  AND o.bucket_id_u64be = :bucket
  AND n.ka_id_u256be IS NULL
ORDER BY o.ka_id_u256be
LIMIT :limit;`,

  diffRemovedNext: `
SELECT o.*
FROM rfc64_candidate_bucket_rows_v1 AS o
LEFT JOIN rfc64_candidate_bucket_rows_v1 AS n
  ON n.session_id = :newSession
 AND n.catalog_scope_digest = :scope
 AND n.author_address = :author
 AND n.target_catalog_head_digest = :newHead
 AND n.ka_id_u256be = o.ka_id_u256be
WHERE o.session_id = :oldSession
  AND o.catalog_scope_digest = :scope
  AND o.author_address = :author
  AND o.target_catalog_head_digest = :oldHead
  AND o.bucket_id_u64be = :bucket
  AND o.ka_id_u256be > :afterKaIdU256be
  AND n.ka_id_u256be IS NULL
ORDER BY o.ka_id_u256be
LIMIT :limit;`,

  countBucketRows: `
SELECT count(*) AS row_count
FROM rfc64_candidate_bucket_rows_v1
WHERE session_id = :session
  AND catalog_scope_digest = :scope
  AND author_address = :author
  AND target_catalog_head_digest = :head
  AND bucket_id_u64be = :bucket;`,

  deleteHeader: `
DELETE FROM rfc64_candidate_bucket_loads_v1
WHERE session_id = :session
  AND catalog_scope_digest = :scope
  AND author_address = :author
  AND target_catalog_head_digest = :head
  AND bucket_id_u64be = :bucket;`,

  getAppliedHead: `
SELECT current_catalog_head_digest, applied_inventory_digest,
       catalog_version_u64be, inventory_row_count_u64be
FROM rfc64_applied_catalog_heads_v1
WHERE catalog_scope_digest = :scope
  AND author_address = :author;`,

  insertAppliedHead: `
INSERT INTO rfc64_applied_catalog_heads_v1 (
  catalog_scope_digest,
  author_address,
  current_catalog_head_digest,
  applied_inventory_digest,
  catalog_version_u64be,
  inventory_row_count_u64be
) VALUES (
  :scope,
  :author,
  :nextHead,
  :inventoryDigest,
  :catalogVersion,
  :inventoryRowCount
);`,

  updateAppliedHeadCas: `
UPDATE rfc64_applied_catalog_heads_v1
SET current_catalog_head_digest = :nextHead,
    applied_inventory_digest = :inventoryDigest,
    catalog_version_u64be = :catalogVersion,
    inventory_row_count_u64be = :inventoryRowCount
WHERE catalog_scope_digest = :scope
  AND author_address = :author
  AND current_catalog_head_digest = :expectedHead;`,

  getSwmAuthorHead: `
SELECT current_head_digest, inventory_version_u64be, total_rows_u64be,
       rows_digest, signed_head_envelope, expected_head_digest,
       canonical_mutation
FROM rfc64_swm_author_inventory_heads_v1
WHERE inventory_scope_digest = :scope
  AND author_address = :author;`,

  getSwmAuthorRows: `
SELECT ka_ual, assertion_coordinate, assertion_version_u64be,
       share_operation_id, projection_digest, public_triple_count_u64be,
       private_triple_count_u64be, seal_digest, shared_at_u64be,
       expires_at_u64be
FROM rfc64_swm_author_inventory_rows_v1
WHERE inventory_scope_digest = :scope
  AND author_address = :author
ORDER BY ka_ual;`,

  insertSwmAuthorHead: `
INSERT INTO rfc64_swm_author_inventory_heads_v1 (
  inventory_scope_digest, author_address, current_head_digest,
  inventory_version_u64be, total_rows_u64be, rows_digest, signed_head_envelope,
  expected_head_digest, canonical_mutation
) VALUES (
  :scope, :author, :nextHead, :inventoryVersion, :totalRows,
  :rowsDigest, :signedHeadEnvelope, :expectedHead, :canonicalMutation
);`,

  updateSwmAuthorHeadCas: `
UPDATE rfc64_swm_author_inventory_heads_v1
SET current_head_digest = :nextHead,
    inventory_version_u64be = :inventoryVersion,
    total_rows_u64be = :totalRows,
    rows_digest = :rowsDigest,
    signed_head_envelope = :signedHeadEnvelope,
    expected_head_digest = :expectedHead,
    canonical_mutation = :canonicalMutation
WHERE inventory_scope_digest = :scope
  AND author_address = :author
  AND current_head_digest = :expectedHead;`,

  upsertSwmAuthorRow: `
INSERT INTO rfc64_swm_author_inventory_rows_v1 (
  inventory_scope_digest, author_address, ka_ual, assertion_coordinate,
  assertion_version_u64be, share_operation_id, projection_digest,
  public_triple_count_u64be, private_triple_count_u64be, seal_digest,
  shared_at_u64be, expires_at_u64be
) VALUES (
  :scope, :author, :kaUal, :assertionCoordinate, :assertionVersion,
  :shareOperationId, :projectionDigest, :publicTripleCount,
  :privateTripleCount, :sealDigest, :sharedAt, :expiresAt
)
ON CONFLICT (inventory_scope_digest, author_address, ka_ual) DO UPDATE SET
  assertion_coordinate = excluded.assertion_coordinate,
  assertion_version_u64be = excluded.assertion_version_u64be,
  share_operation_id = excluded.share_operation_id,
  projection_digest = excluded.projection_digest,
  public_triple_count_u64be = excluded.public_triple_count_u64be,
  private_triple_count_u64be = excluded.private_triple_count_u64be,
  seal_digest = excluded.seal_digest,
  shared_at_u64be = excluded.shared_at_u64be,
  expires_at_u64be = excluded.expires_at_u64be;`,

  deleteSwmAuthorRow: `
DELETE FROM rfc64_swm_author_inventory_rows_v1
WHERE inventory_scope_digest = :scope
  AND author_address = :author
  AND ka_ual = :kaUal;`,
});

export type InventoryV1StatementKey = keyof typeof INVENTORY_V1_STATEMENT_SQL;

/** Stable production query IDs; these are telemetry/plan-contract identities. */
export const INVENTORY_V1_STATEMENT_IDS = Object.freeze({
  insertHeader: 'rfc64.candidate-bucket.header.insert.v1',
  insertRow: 'rfc64.candidate-bucket.row.insert.v1',
  startupGcNext: 'rfc64.candidate-session.startup-gc.next.v1',
  discardSessionNext: 'rfc64.candidate-session.discard.next.v1',
  getHeader: 'rfc64.candidate-bucket.header.get.v1',
  getRowsFirst: 'rfc64.candidate-bucket.rows.first.v1',
  getRowsNext: 'rfc64.candidate-bucket.rows.next.v1',
  getRowsExactRetry: 'rfc64.candidate-bucket.rows.exact-retry.v1',
  diffAddedOrChangedFirst: 'rfc64.candidate-bucket.diff-added-or-changed.first.v1',
  diffAddedOrChangedNext: 'rfc64.candidate-bucket.diff-added-or-changed.next.v1',
  diffRemovedFirst: 'rfc64.candidate-bucket.diff-removed.first.v1',
  diffRemovedNext: 'rfc64.candidate-bucket.diff-removed.next.v1',
  countBucketRows: 'rfc64.candidate-bucket.rows.count.v1',
  deleteHeader: 'rfc64.candidate-bucket.delete.v1',
  getAppliedHead: 'rfc64.applied-head.get.v1',
  insertAppliedHead: 'rfc64.applied-head.insert.v1',
  updateAppliedHeadCas: 'rfc64.applied-head.cas-update.v1',
  getSwmAuthorHead: 'rfc64.swm-author-inventory.head.get.v1',
  getSwmAuthorRows: 'rfc64.swm-author-inventory.rows.get.v1',
  insertSwmAuthorHead: 'rfc64.swm-author-inventory.head.insert.v1',
  updateSwmAuthorHeadCas: 'rfc64.swm-author-inventory.head.cas-update.v1',
  upsertSwmAuthorRow: 'rfc64.swm-author-inventory.row.upsert.v1',
  deleteSwmAuthorRow: 'rfc64.swm-author-inventory.row.delete.v1',
} as const satisfies Readonly<Record<InventoryV1StatementKey, string>>);

export type InventoryV1StatementId =
  typeof INVENTORY_V1_STATEMENT_IDS[InventoryV1StatementKey];

export const INVENTORY_V1_PERSISTENT_READ_STATEMENT_KEYS = Object.freeze([
  'startupGcNext',
  'discardSessionNext',
  'getHeader',
  'getRowsFirst',
  'getRowsNext',
  'getRowsExactRetry',
  'diffAddedOrChangedFirst',
  'diffAddedOrChangedNext',
  'diffRemovedFirst',
  'diffRemovedNext',
  'countBucketRows',
  'getAppliedHead',
  'getSwmAuthorHead',
  'getSwmAuthorRows',
] as const satisfies readonly InventoryV1StatementKey[]);

export const INVENTORY_V1_PLAN_STATEMENT_KEYS = Object.freeze([
  ...INVENTORY_V1_PERSISTENT_READ_STATEMENT_KEYS,
  'deleteHeader',
  'insertAppliedHead',
  'updateAppliedHeadCas',
  'insertSwmAuthorHead',
  'updateSwmAuthorHeadCas',
  'upsertSwmAuthorRow',
  'deleteSwmAuthorRow',
] as const satisfies readonly InventoryV1StatementKey[]);
