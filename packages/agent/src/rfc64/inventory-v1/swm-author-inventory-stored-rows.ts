import {
  compareSwmAuthorInventoryRowsV1,
  snapshotSwmAuthorInventoryRowsV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';
import type { EncodedSwmAuthorInventoryKeyV1 } from './swm-author-inventory-commit-plan.js';
import { sqlBlobsEqualV1 } from './scalars.js';
import { decodeStoredSwmAuthorInventoryRowV1, type SqlRowV1 } from './swm-author-inventory-sql-codec.js';

// The row limit bounds indexing overhead; the byte limit bounds retained text and binary data.
const MAX_RETAINED_ROWS = 16_384;
const MAX_RETAINED_FIELD_BYTES = 8 * 1024 * 1024;
const BLOB_COLUMNS = [
  ['assertion_version_u64be', 8], ['projection_digest', 32], ['public_triple_count_u64be', 8],
  ['private_triple_count_u64be', 8], ['seal_digest', 32], ['shared_at_u64be', 8], ['expires_at_u64be', 8],
] as const;
const ROW_BYTES = BLOB_COLUMNS.reduce((size, [, width]) => size + width, 0);
const COLUMN_COUNT = 4 + BLOB_COLUMNS.length;
const TEXT_DECODERS = new Map([
  [0xef, new TextDecoder('utf-8', { fatal: true })],
  [0xff, new TextDecoder('utf-16le', { fatal: true })],
  [0xfe, new TextDecoder('utf-16be', { fatal: true })],
]);

// node:sqlite can truncate TEXT at NUL or substitute U+FFFD for malformed storage.
// SQL prefixes the independent byte projection with a BOM in the database's own encoding.
function requireExactText(source: SqlRowV1): void {
  const bytes = source.exact_text;
  if (!(bytes instanceof Uint8Array)) throw new Error('missing or oversized stored SWM inventory text');
  const decoder = TEXT_DECODERS.get(bytes[0]!);
  if (!decoder || decoder.decode(bytes) !== [source.ka_ual, source.assertion_coordinate, source.share_operation_id].join('\0')) {
    throw new Error('stored SWM inventory text does not match its complete encoded fields');
  }
}

interface VerifiedStoredSwmRowsV1 {
  readonly retainedBytes: number;
  readonly key: EncodedSwmAuthorInventoryKeyV1;
  readonly rows: SwmAuthorInventorySnapshotV1['rows'];
  readonly sqlOrder: readonly SwmAuthorInventoryRowV1[];
  readonly byUal: ReadonlyMap<string, number>;
  readonly blobs: Uint8Array;
}

function exactRow(source: SqlRowV1, previous: VerifiedStoredSwmRowsV1, index: number): boolean {
  const row = previous.sqlOrder[index]!;
  if (
    Object.keys(source).length !== COLUMN_COUNT
    || source.ka_ual !== row.kaUal
    || source.assertion_coordinate !== row.assertionCoordinate
    || source.share_operation_id !== row.shareOperationId
  ) return false;
  let offset = index * ROW_BYTES;
  for (const [column, width] of BLOB_COLUMNS) {
    const field = source[column];
    if (column === 'expires_at_u64be' && row.expiresAt === null) {
      if (field !== null) return false;
    } else {
      if (!(field instanceof Uint8Array) || field.byteLength !== width) return false;
      for (let i = 0; i < width; i++) {
        if (field[i] !== previous.blobs[offset + i]) return false;
      }
    }
    offset += width;
  }
  return true;
}

/** Always reread the full projection; a retained row is only a witness to unchanged SQL values. */
function decodeStoredSwmRowsV1(
  key: EncodedSwmAuthorInventoryKeyV1,
  stored: readonly SqlRowV1[],
  matching?: VerifiedStoredSwmRowsV1,
): { rows: SwmAuthorInventorySnapshotV1['rows']; cache?: VerifiedStoredSwmRowsV1 } {
  for (const source of stored) requireExactText(source);
  if (matching && stored.length === matching.sqlOrder.length
      && stored.every((source, index) => exactRow(source, matching, index))) {
    return { rows: matching.rows, cache: matching };
  }

  let blobs = stored.length <= MAX_RETAINED_ROWS ? new Uint8Array(stored.length * ROW_BYTES) : undefined;
  let retainedBytes = blobs?.length ?? 0;
  const sqlOrder = stored.map((source, index) => {
    const oldIndex = typeof source.ka_ual === 'string' ? matching?.byUal.get(source.ka_ual) : undefined;
    const row = matching && oldIndex !== undefined && exactRow(source, matching, oldIndex)
      ? matching.sqlOrder[oldIndex]! : decodeStoredSwmAuthorInventoryRowV1(source);
    if (blobs) {
      retainedBytes += 2 * (row.kaUal.length + row.assertionCoordinate.length + row.shareOperationId.length);
      if (retainedBytes > MAX_RETAINED_FIELD_BYTES || Object.keys(source).length !== COLUMN_COUNT) {
        blobs = undefined;
      } else {
        // These exact types and widths were just validated by the decoder or exactRow.
        let offset = index * ROW_BYTES;
        for (const [column, width] of BLOB_COLUMNS) {
          const field = source[column];
          if (field instanceof Uint8Array) blobs.set(field, offset);
          offset += width;
        }
      }
    }
    return row;
  });
  // Rejects duplicate identities or coordinates even when individual rows matched.
  const rows = snapshotSwmAuthorInventoryRowsV1([...sqlOrder].sort(compareSwmAuthorInventoryRowsV1));
  return { rows, cache: blobs && {
    key: { scope: Uint8Array.from(key.scope), author: Uint8Array.from(key.author) },
    rows, blobs, sqlOrder, retainedBytes,
    byUal: new Map(sqlOrder.map((row, index) => [row.kaUal, index])),
  } };
}

function matchesKey(entry: VerifiedStoredSwmRowsV1, key: EncodedSwmAuthorInventoryKeyV1): boolean {
  return sqlBlobsEqualV1(entry.key.scope, key.scope) && sqlBlobsEqualV1(entry.key.author, key.author);
}

/** Keep at most two verified scope/author pairs under one shared retention budget. */
export class StoredSwmRowsCacheV1 {
  private entries: VerifiedStoredSwmRowsV1[] = [];

  clear(): void {
    this.entries = [];
  }

  decode(key: EncodedSwmAuthorInventoryKeyV1, stored: readonly SqlRowV1[]) {
    return decodeStoredSwmRowsV1(key, stored, this.entries.find(entry => matchesKey(entry, key)));
  }

  /** Called only after signed binding and durable replay metadata validate, or the head is absent. */
  remember(key: EncodedSwmAuthorInventoryKeyV1, current?: VerifiedStoredSwmRowsV1): void {
    if (current && this.entries[0] === current) return;
    const others = this.entries.filter(entry => !matchesKey(entry, key));
    if (!current) {
      this.entries = others;
      return;
    }
    const recent = others[0];
    this.entries = [current];
    if (recent && current.rows.length + recent.rows.length <= MAX_RETAINED_ROWS
        && current.retainedBytes + recent.retainedBytes <= MAX_RETAINED_FIELD_BYTES) {
      this.entries.push(recent);
    }
  }
}
