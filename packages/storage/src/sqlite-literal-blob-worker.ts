import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { assertSqliteBlobRuntime, SQLITE_BLOB_APPLICATION_ID, SQLITE_BLOB_VERSION, type BlobRequest, type BlobResponse } from './sqlite-literal-blob-protocol.js';

const port = parentPort!;
assertSqliteBlobRuntime();
const path: string = workerData.path;
let database: DatabaseSync | undefined, writable = false;
let writes: Extract<BlobRequest, { operation: 'write' }>[] = [];
let scheduled: ReturnType<typeof setImmediate> | undefined;
const send = (message: BlobResponse) => port.postMessage(message);
const boundedTermSql = `SELECT typeof(term) AS kind,
  CASE WHEN typeof(term)='blob' THEN length(term) END AS bytes,
  CASE WHEN typeof(term)='blob' AND length(term)<=? THEN term END AS term
  FROM blobs WHERE hash=?`;

function failure(id: number, error: unknown): void {
  const e = error as Error & { code?: string; maxBytes?: number; actualBytes?: number };
  send({ id, error: { message: e.message ?? String(error), code: e.code, maxBytes: e.maxBytes, actualBytes: e.actualBytes } });
}
function pragma(db: DatabaseSync, name: string): unknown { return db.prepare(`PRAGMA ${name}`).get()![name]; }
function assertSchema(db: DatabaseSync): void {
  if (pragma(db, 'application_id') !== SQLITE_BLOB_APPLICATION_ID || pragma(db, 'user_version') !== SQLITE_BLOB_VERSION ||
      pragma(db, 'encoding') !== 'UTF-8') throw new Error('Unsupported literal blob database identity/version/encoding');
  const columns = db.prepare('PRAGMA table_info(blobs)').all();
  const table = db.prepare("PRAGMA table_list('blobs')").all().find(row => row.schema === 'main');
  if (columns.length !== 2 || columns[0]!.name !== 'hash' || columns[0]!.type !== 'TEXT' || columns[0]!.pk !== 1 || columns[0]!.notnull !== 1 ||
      columns[1]!.name !== 'term' || columns[1]!.type !== 'BLOB' || columns[1]!.notnull !== 1 || columns[1]!.pk !== 0 ||
      table?.type !== 'table' || table.wr !== 0 || table.ncol !== 2 ||
      db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().some(row => row.name !== 'blobs')) {
    throw new Error('Unsupported literal blob database schema');
  }
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
    const application = pragma(db, 'application_id');
    const empty = application === 0 && pragma(db, 'user_version') === 0 && pragma(db, 'encoding') === 'UTF-8' &&
      db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length === 0;
    if (!empty) assertSchema(db);
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
      assertSchema(db);
    } else if (empty) { db.close(); return undefined; }
    database = db; writable = write; return db;
  } catch (error) { db.close(); throw error; }
}
function assertHash(hash: string): void { if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid literal blob hash'); }
function verify(hash: string, term: Uint8Array): void {
  assertHash(hash);
  if (createHash('sha256').update(term).digest('hex') !== hash) throw new Error(`Literal blob integrity mismatch for ${hash}`);
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
      verify(request.hash, bytes);
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
    assertHash(request.hash);
    if (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0)) {
      throw new RangeError('maxResponseBytes must be a non-negative safe integer');
    }
    const db = openDatabase(false);
    // One statement holds a consistent read snapshot. BLOB length uses record metadata;
    // CASE never materializes an oversized value, including under concurrent writers.
    const row = db?.prepare(boundedTermSql).get(request.maxBytes ?? Number.MAX_SAFE_INTEGER, request.hash);
    if (!row) { send({ id: request.id }); return; }
    if (row.kind !== 'blob') throw new Error('Invalid literal blob encoding');
    const bytes = Number(row.bytes);
    if (request.maxBytes !== undefined && bytes > request.maxBytes) {
      throw Object.assign(new Error('Literal blob exceeds response-byte budget'), {
        code: 'STORE_RESPONSE_TOO_LARGE', maxBytes: request.maxBytes, actualBytes: bytes,
      });
    }
    if (!(row.term instanceof Uint8Array)) throw new Error('Invalid literal blob term');
    verify(request.hash, row.term);
    const term = new TextDecoder('utf-8', { fatal: true }).decode(row.term);
    send({ id: request.id, value: term });
  } catch (error) { failure(request.id, error); }
});
send({ ready: true });
