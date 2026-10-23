import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { serializeWorkerErrorV1 } from './worker-error-protocol.js';
import { StoreResponseTooLargeError } from './http-response-limit.js';
import { assertSqliteBlobRuntime, SQLITE_BLOB_APPLICATION_ID, SQLITE_BLOB_VERSION, type BlobRequest, type BlobResponse } from './sqlite-literal-blob-protocol.js';
import { assertSqliteBlobByteLimit, assertSqliteBlobHash, assertSqliteBlobSchema, decodeSqliteBlobRow, isEmptySqliteBlobDatabase,
  sqliteBlobPragma as pragma, SQLITE_BLOB_BOUNDED_COLUMNS, verifySqliteBlobBytes } from './sqlite-literal-blob-format.js';

const port = parentPort!;
assertSqliteBlobRuntime();
const path: string = workerData.path;
let database: DatabaseSync | undefined, writable = false;
let writes: Extract<BlobRequest, { operation: 'write' }>[] = [];
let scheduled: ReturnType<typeof setImmediate> | undefined;
const send = (message: BlobResponse) => port.postMessage(message);
const boundedTermSql = `SELECT ${SQLITE_BLOB_BOUNDED_COLUMNS} FROM blobs WHERE hash=?`;

function failure(id: number, error: unknown): void {
  const envelope = serializeWorkerErrorV1(error);
  send({ id, error: error instanceof StoreResponseTooLargeError
    ? { ...envelope, maxBytes: error.maxBytes, actualBytes: error.actualBytes } : envelope });
}
function openDatabase(write: boolean): DatabaseSync | undefined {
  if (write && workerData.readOnly) throw new Error('Literal blob read owner cannot write');
  if (database && (!write || writable)) return database;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Literal blob database must be a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!write) return undefined;
  }
  database?.close(); database = undefined; writable = false;
  const db = new DatabaseSync(path, { readOnly: !write });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const empty = isEmptySqliteBlobDatabase(db);
    if (!empty) assertSqliteBlobSchema(db);
    if (write) {
      if (empty) db.exec('PRAGMA page_size=8192');
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON');
      if (pragma(db, 'journal_mode') !== 'wal' || pragma(db, 'synchronous') !== 2 ||
          pragma(db, 'fullfsync') !== 1 || pragma(db, 'checkpoint_fullfsync') !== 1) {
        throw new Error('Literal blob engine did not establish its required durability policy');
      }
      if (empty) {
        db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY NOT NULL, term BLOB NOT NULL);
          PRAGMA application_id=${SQLITE_BLOB_APPLICATION_ID}; PRAGMA user_version=${SQLITE_BLOB_VERSION}; COMMIT`);
      }
      assertSqliteBlobSchema(db);
    } else if (empty) { db.close(); return undefined; }
    database = db; writable = write; return db;
  } catch (error) { db.close(); throw error; }
}
function commitBatch(scheduleNext = true): void {
  scheduled = undefined;
  let bytes = 0, count = 0;
  for (const request of writes) {
    const next = Buffer.byteLength(request.term);
    if (count && (count === 8 || bytes + next > 2 * 1024 * 1024)) break;
    count += 1; bytes += next;
  }
  const batch = writes.splice(0, count);
  if (!batch.length) return;
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(true)!;
    const current = db.prepare(boundedTermSql);
    const put = db.prepare('INSERT OR REPLACE INTO blobs(hash,term) VALUES(?,?)');
    db.exec('BEGIN IMMEDIATE');
    for (const request of batch) {
      const bytes = Buffer.from(request.term, 'utf8');
      verifySqliteBlobBytes(request.hash, bytes);
      const existing = current.get(bytes.length, request.hash);
      if (existing && (existing.kind !== 'blob' || Number(existing.bytes) !== bytes.length ||
          !(existing.term instanceof Uint8Array) || !Buffer.from(existing.term).equals(bytes))) {
        throw new Error(`Literal blob conflict for ${request.hash}`);
      }
      // Even uncached/adopted matching bytes are re-submitted to this engine's writer.
      put.run(request.hash, bytes);
    }
    db.exec('COMMIT');
    // No member may acknowledge until this exact batch's native durable commit succeeds.
    for (const request of batch) send({ id: request.id });
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* The engine may have already rolled back. */ }
    // A failed native transaction never lends its connection/error state to retry.
    // Reopen through the engine on the next attempt; keep all on-disk evidence.
    let closeFailed = false;
    try { database?.close(); } catch { closeFailed = true; }
    database = undefined; writable = false;
    for (const request of batch) failure(request.id, error);
    if (closeFailed) { setImmediate(() => { throw new Error('Literal blob engine could not close after a failed transaction'); }); }
  }
  if (writes.length && scheduleNext) scheduled = setImmediate(commitBatch);
}
port.on('message', (request: BlobRequest) => {
  if (request.operation === 'write') {
    writes.push(request);
    scheduled ??= setImmediate(commitBatch);
    return;
  }
  try {
    if (request.operation === 'close') {
      if (scheduled) clearImmediate(scheduled);
      while (writes.length) commitBatch(false);
      database?.close(); database = undefined;
      send({ id: request.id }); port.close(); return;
    }
    assertSqliteBlobHash(request.hash); assertSqliteBlobByteLimit(request.maxBytes);
    const db = openDatabase(false);
    // One statement holds a consistent read snapshot. BLOB length uses record metadata;
    // CASE never materializes an oversized value, including under concurrent writers.
    const row = db?.prepare(boundedTermSql).get(request.maxBytes ?? Number.MAX_SAFE_INTEGER, request.hash);
    if (!row) { send({ id: request.id }); return; }
    const term = decodeSqliteBlobRow(request.hash, row, request.maxBytes);
    send({ id: request.id, value: term });
  } catch (error) { failure(request.id, error); }
});
send({ ready: true });
