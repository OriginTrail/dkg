import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LiteralBlobFileOwner } from './literal-blob-file-owner.js';
import { assertSqliteBlobRuntime, SQLITE_BLOB_FILENAME } from './sqlite-literal-blob-protocol.js';
import { assertSqliteBlobSchema, decodeSqliteBlobRow, SQLITE_BLOB_BOUNDED_COLUMNS } from './sqlite-literal-blob-format.js';

/** Offline, non-destructive export for an older binary. Stop writers before invoking. */
export async function exportLiteralBlobs(source: string, destination: string, maxLiteralBytes = 256 * 1024 * 1024): Promise<number> {
  assertSqliteBlobRuntime();
  if (!Number.isSafeInteger(maxLiteralBytes) || maxLiteralBytes < 0) throw new RangeError('Invalid export literal byte limit');
  const path = join(resolve(source), SQLITE_BLOB_FILENAME), entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Literal blob database must be a regular file');
  const db = new DatabaseSync(path, { readOnly: true }), files = new LiteralBlobFileOwner(resolve(destination));
  let count = 0;
  try {
    assertSqliteBlobSchema(db);
    // One offline snapshot; the shared projection never materializes over-budget BLOBs.
    const rows = db.prepare(`SELECT hash, ${SQLITE_BLOB_BOUNDED_COLUMNS} FROM blobs ORDER BY hash`);
    for (const row of rows.iterate(maxLiteralBytes)) {
      if (typeof row.hash !== 'string') throw new Error('Invalid literal blob export row');
      let term: string;
      try { term = decodeSqliteBlobRow(row.hash, row, maxLiteralBytes); }
      catch (error) {
        // Offline export has its own explicit per-term policy and diagnostic.
        if ((error as { code?: string }).code === 'STORE_RESPONSE_TOO_LARGE') {
          throw new Error(`Literal blob ${row.hash} exceeds export byte limit ${maxLiteralBytes}`, { cause: error });
        }
        throw error;
      }
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
