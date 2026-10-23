import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { SQLITE_BLOB_APPLICATION_ID, SQLITE_BLOB_VERSION } from './sqlite-literal-blob-protocol.js';

export const SQLITE_BLOB_BOUNDED_COLUMNS = `typeof(term) AS kind,
  CASE WHEN typeof(term)='blob' THEN length(term) END AS bytes,
  CASE WHEN typeof(term)='blob' AND length(term)<=? THEN term END AS term`;

export function sqliteBlobPragma(db: DatabaseSync, name: string): unknown { return db.prepare(`PRAGMA ${name}`).get()![name]; }

export function isEmptySqliteBlobDatabase(db: DatabaseSync): boolean {
  return sqliteBlobPragma(db, 'application_id') === 0 && sqliteBlobPragma(db, 'user_version') === 0 &&
    sqliteBlobPragma(db, 'encoding') === 'UTF-8' &&
    db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length === 0;
}

/** The worker and offline exporter accept exactly the same versioned format. */
export function assertSqliteBlobSchema(db: DatabaseSync): void {
  if (sqliteBlobPragma(db, 'application_id') !== SQLITE_BLOB_APPLICATION_ID || sqliteBlobPragma(db, 'user_version') !== SQLITE_BLOB_VERSION ||
    sqliteBlobPragma(db, 'encoding') !== 'UTF-8') throw new Error('Unsupported literal blob database identity/version/encoding');
  const columns = db.prepare('PRAGMA table_info(blobs)').all();
  const table = db.prepare("PRAGMA table_list('blobs')").all().find(row => row.schema === 'main');
  if (columns.length !== 2 || columns[0]!.name !== 'hash' || columns[0]!.type !== 'TEXT' || columns[0]!.pk !== 1 || columns[0]!.notnull !== 1 ||
    columns[1]!.name !== 'term' || columns[1]!.type !== 'BLOB' || columns[1]!.notnull !== 1 || columns[1]!.pk !== 0 ||
    table?.type !== 'table' || table.wr !== 0 || table.ncol !== 2 ||
    db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().some(row => row.name !== 'blobs')) {
    throw new Error('Unsupported literal blob database schema');
  }
}

export function assertSqliteBlobHash(hash: string): void { if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid literal blob hash'); }
export function verifySqliteBlobBytes(hash: string, term: Uint8Array): void {
  assertSqliteBlobHash(hash);
  if (createHash('sha256').update(term).digest('hex') !== hash) throw new Error(`Literal blob integrity mismatch for ${hash}`);
}
export function assertSqliteBlobByteLimit(maxBytes?: number): void {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw new RangeError('maxResponseBytes must be a non-negative safe integer');
}
export function decodeSqliteBlobRow(hash: string, row: Record<string, unknown>, maxBytes?: number): string {
  assertSqliteBlobHash(hash); assertSqliteBlobByteLimit(maxBytes);
  if (row.kind !== 'blob') throw new Error('Invalid literal blob encoding');
  const bytes = Number(row.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid literal blob size');
  if (maxBytes !== undefined && bytes > maxBytes) throw Object.assign(new Error('Literal blob exceeds response-byte budget'), {
    code: 'STORE_RESPONSE_TOO_LARGE', maxBytes, actualBytes: bytes,
  });
  if (!(row.term instanceof Uint8Array) || row.term.byteLength !== bytes) throw new Error('Invalid literal blob term');
  verifySqliteBlobBytes(hash, row.term);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row.term);
}
