import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LiteralBlobFileOwner } from './literal-blob-file-owner.js';
import { assertSqliteBlobRuntime, SQLITE_BLOB_APPLICATION_ID, SQLITE_BLOB_FILENAME, SQLITE_BLOB_VERSION } from './sqlite-literal-blob-protocol.js';

/** Offline, non-destructive export for an older binary. Stop writers before invoking. */
export async function exportLiteralBlobs(source: string, destination: string, maxLiteralBytes = 256 * 1024 * 1024): Promise<number> {
  assertSqliteBlobRuntime();
  if (!Number.isSafeInteger(maxLiteralBytes) || maxLiteralBytes < 0) throw new RangeError('Invalid export literal byte limit');
  const path = join(resolve(source), SQLITE_BLOB_FILENAME), entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Literal blob database must be a regular file');
  const db = new DatabaseSync(path, { readOnly: true }), files = new LiteralBlobFileOwner(resolve(destination));
  let count = 0;
  try {
    if (db.prepare('PRAGMA application_id').get()!.application_id !== SQLITE_BLOB_APPLICATION_ID ||
      db.prepare('PRAGMA user_version').get()!.user_version !== SQLITE_BLOB_VERSION ||
      db.prepare('PRAGMA encoding').get()!.encoding !== 'UTF-8') throw new Error('Unsupported literal blob database identity/version/encoding');
    // Iterate one read snapshot, materializing at most one bounded BLOB at a time.
    const rows = db.prepare(`SELECT hash, typeof(term) AS kind,
      CASE WHEN typeof(term)='blob' THEN length(term) END AS bytes,
      CASE WHEN typeof(term)='blob' AND length(term)<=? THEN term END AS term FROM blobs ORDER BY hash`);
    for (const row of rows.iterate(maxLiteralBytes)) {
      if (typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash) || row.kind !== 'blob') throw new Error('Invalid literal blob export row');
      if (Number(row.bytes) > maxLiteralBytes) throw new Error(`Literal blob ${row.hash} exceeds export byte limit ${maxLiteralBytes}`);
      if (!(row.term instanceof Uint8Array) || createHash('sha256').update(row.term).digest('hex') !== row.hash) throw new Error(`Literal blob integrity mismatch for ${row.hash}`);
      const term = new TextDecoder('utf-8', { fatal: true }).decode(row.term);
      await files.write(row.hash, term); count += 1;
    }
    return count;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node export-literal-blobs.js <source-blob-directory> <destination-blob-directory>');
  console.log(`Exported ${await exportLiteralBlobs(source, destination)} durable hash files; source database retained`);
}
