import {
  RFC64_SECURE_DIRECTORY_MODE_V1,
  RFC64_SECURE_FILE_MODE_V1,
} from '../secure-filesystem-policy-v1.js';
import {
  RFC64_INVENTORY_DATABASE_FILENAME_V1,
  RFC64_PERSISTENCE_ROOT_RELATIVE_PATH_V1,
} from '../persistence-layout-v1.js';

export const INVENTORY_V1_APPLICATION_ID = 0x444b3634;
export const INVENTORY_V1_USER_VERSION = 1;
export const INVENTORY_V1_RELATIVE_PATH =
  `${RFC64_PERSISTENCE_ROOT_RELATIVE_PATH_V1}/${RFC64_INVENTORY_DATABASE_FILENAME_V1}`;
export const INVENTORY_V1_DIRECTORY_MODE = RFC64_SECURE_DIRECTORY_MODE_V1;
export const INVENTORY_V1_FILE_MODE = RFC64_SECURE_FILE_MODE_V1;

// SQL-1 stores protocol integers only as canonical fixed-width big-endian
// BLOBs. Decode the bounded low hexadecimal suffix with SQLite core built-ins
// solely inside the relational CHECK below; no redundant numeric authority,
// extension function, trigger, or connection-local UDF is introduced.
function unsignedHexSuffixIntegerSql(column: string, nibbles: number): string {
  const firstPosition = 17 - nibbles;
  return Array.from({ length: nibbles }, (_unused, index) => {
    const position = firstPosition + index;
    const multiplier = 16 ** (nibbles - index - 1);
    return `((instr('0123456789ABCDEF', substr(hex(${column}), ${position}, 1)) - 1) * ${multiplier})`;
  }).join(' + ');
}

const TRANSFER_BYTE_LENGTH_INTEGER_SQL = unsignedHexSuffixIntegerSql(
  'transfer_byte_length_u64be',
  8,
);
const TRANSFER_CHUNK_COUNT_INTEGER_SQL = unsignedHexSuffixIntegerSql(
  'transfer_chunk_count_u64be',
  4,
);
const TRANSFER_CHUNK_GEOMETRY_CHECK_SQL =
  `((${TRANSFER_BYTE_LENGTH_INTEGER_SQL}) + 262143) / 262144`
  + ` = (${TRANSFER_CHUNK_COUNT_INTEGER_SQL})`;

export const INVENTORY_V1_LOADS_TABLE_SQL = `
CREATE TABLE rfc64_candidate_bucket_loads_v1 (
  session_id BLOB NOT NULL
    CHECK (
      typeof(session_id) = 'blob'
      AND length(session_id) = 32
      AND session_id <> zeroblob(32)
    ),

  catalog_scope_digest BLOB NOT NULL
    CHECK (
      typeof(catalog_scope_digest) = 'blob'
      AND length(catalog_scope_digest) = 32
    ),

  author_address BLOB NOT NULL
    CHECK (
      typeof(author_address) = 'blob'
      AND length(author_address) = 20
      AND author_address <> zeroblob(20)
    ),

  target_catalog_head_digest BLOB NOT NULL
    CHECK (
      typeof(target_catalog_head_digest) = 'blob'
      AND length(target_catalog_head_digest) = 32
    ),

  subgraph_name TEXT
    CHECK (
      subgraph_name IS NULL
      OR (typeof(subgraph_name) = 'text' AND length(subgraph_name) > 0)
    ),

  catalog_era_u64be BLOB NOT NULL
    CHECK (
      typeof(catalog_era_u64be) = 'blob'
      AND length(catalog_era_u64be) = 8
    ),

  bucket_count_u64be BLOB NOT NULL CHECK (
    typeof(bucket_count_u64be) = 'blob' AND length(bucket_count_u64be) = 8
    AND bucket_count_u64be >= x'0000000000000001' AND bucket_count_u64be <= x'8000000000000000'
  ),

  bucket_id_u64be BLOB NOT NULL CHECK (
    typeof(bucket_id_u64be) = 'blob' AND length(bucket_id_u64be) = 8 AND bucket_id_u64be < bucket_count_u64be
  ),

  bucket_object_digest BLOB NOT NULL
    CHECK (
      typeof(bucket_object_digest) = 'blob'
      AND length(bucket_object_digest) = 32
    ),

  row_count_u64be BLOB NOT NULL
    CHECK (
      typeof(row_count_u64be) = 'blob'
      AND length(row_count_u64be) = 8
    ),

  payload_byte_length_u64be BLOB NOT NULL CHECK (
    typeof(payload_byte_length_u64be) = 'blob' AND length(payload_byte_length_u64be) = 8
  ),

  CHECK (
    (
      bucket_object_digest = zeroblob(32)
      AND row_count_u64be = zeroblob(8)
      AND payload_byte_length_u64be = zeroblob(8)
    )
    OR
    (
      bucket_object_digest <> zeroblob(32)
      AND row_count_u64be >= x'0000000000000001'
      AND row_count_u64be <= x'0000000000000400'
      AND payload_byte_length_u64be >= x'0000000000000001'
      AND payload_byte_length_u64be <= x'0000000000100000'
    )
  ),

  PRIMARY KEY (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    bucket_id_u64be
  )
) WITHOUT ROWID, STRICT`;

export const INVENTORY_V1_ROWS_TABLE_SQL = `
CREATE TABLE rfc64_candidate_bucket_rows_v1 (
  session_id BLOB NOT NULL
    CHECK (
      typeof(session_id) = 'blob'
      AND length(session_id) = 32
      AND session_id <> zeroblob(32)
    ),

  catalog_scope_digest BLOB NOT NULL
    CHECK (
      typeof(catalog_scope_digest) = 'blob'
      AND length(catalog_scope_digest) = 32
    ),

  author_address BLOB NOT NULL
    CHECK (
      typeof(author_address) = 'blob'
      AND length(author_address) = 20
      AND author_address <> zeroblob(20)
    ),

  target_catalog_head_digest BLOB NOT NULL
    CHECK (
      typeof(target_catalog_head_digest) = 'blob'
      AND length(target_catalog_head_digest) = 32
    ),

  bucket_id_u64be BLOB NOT NULL
    CHECK (
      typeof(bucket_id_u64be) = 'blob'
      AND length(bucket_id_u64be) = 8
    ),

  ka_id_u256be BLOB NOT NULL
    CHECK (
      typeof(ka_id_u256be) = 'blob'
      AND length(ka_id_u256be) = 32
    ),

  catalog_key_digest BLOB NOT NULL
    CHECK (
      typeof(catalog_key_digest) = 'blob'
      AND length(catalog_key_digest) = 32
    ),

  assertion_coordinate TEXT NOT NULL COLLATE BINARY
    CHECK (
      typeof(assertion_coordinate) = 'text'
      AND length(assertion_coordinate) > 0
    ),

  assertion_version_u64be BLOB NOT NULL
    CHECK (
      typeof(assertion_version_u64be) = 'blob'
      AND length(assertion_version_u64be) = 8
    ),

  projection_id TEXT NOT NULL
    CHECK (projection_id = 'cg-shared-v1'),

  projection_digest BLOB NOT NULL
    CHECK (
      typeof(projection_digest) = 'blob'
      AND length(projection_digest) = 32
    ),

  seal_digest BLOB NOT NULL
    CHECK (
      typeof(seal_digest) = 'blob'
      AND length(seal_digest) = 32
    ),

  transfer_codec TEXT NOT NULL
    CHECK (transfer_codec = 'dkg-ka-bundle-v1'),

  transfer_byte_length_u64be BLOB NOT NULL CHECK (
    typeof(transfer_byte_length_u64be) = 'blob' AND length(transfer_byte_length_u64be) = 8
    AND transfer_byte_length_u64be >= x'0000000000000010' AND transfer_byte_length_u64be <= x'0000000040000000'
  ),

  transfer_chunk_size_u64be BLOB NOT NULL
    CHECK (
      transfer_chunk_size_u64be = x'0000000000040000'
    ),

  transfer_chunk_count_u64be BLOB NOT NULL CHECK (
    typeof(transfer_chunk_count_u64be) = 'blob' AND length(transfer_chunk_count_u64be) = 8
    AND transfer_chunk_count_u64be >= x'0000000000000001' AND transfer_chunk_count_u64be <= x'0000000000001000'
    AND ${TRANSFER_CHUNK_GEOMETRY_CHECK_SQL}
  ),

  transfer_blob_digest BLOB NOT NULL
    CHECK (
      typeof(transfer_blob_digest) = 'blob'
      AND length(transfer_blob_digest) = 32
    ),

  transfer_chunk_tree_root BLOB NOT NULL
    CHECK (
      typeof(transfer_chunk_tree_root) = 'blob'
      AND length(transfer_chunk_tree_root) = 32
    ),

  expected_catalog_row_digest BLOB NOT NULL CHECK (
    typeof(expected_catalog_row_digest) = 'blob' AND length(expected_catalog_row_digest) = 32
  ),

  PRIMARY KEY (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    bucket_id_u64be,
    ka_id_u256be
  ),

  UNIQUE (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    ka_id_u256be
  ),

  UNIQUE (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    catalog_key_digest
  ),

  UNIQUE (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    assertion_coordinate
  ),

  FOREIGN KEY (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    bucket_id_u64be
  )
  REFERENCES rfc64_candidate_bucket_loads_v1 (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    bucket_id_u64be
  )
  ON DELETE CASCADE
) WITHOUT ROWID, STRICT`;

export const INVENTORY_V1_DDL = [
  INVENTORY_V1_LOADS_TABLE_SQL,
  INVENTORY_V1_ROWS_TABLE_SQL,
].join(';\n\n').concat(';');

export const INVENTORY_V1_USER_OBJECTS: Readonly<Record<string, string>> = Object.freeze({
  rfc64_candidate_bucket_loads_v1: normalizeInventoryV1SchemaSql(INVENTORY_V1_LOADS_TABLE_SQL),
  rfc64_candidate_bucket_rows_v1: normalizeInventoryV1SchemaSql(INVENTORY_V1_ROWS_TABLE_SQL),
});

export function normalizeInventoryV1SchemaSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
}
