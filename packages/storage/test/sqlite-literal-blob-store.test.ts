import { SqliteLiteralBlobOwner } from '../src/sqlite-literal-blob-owner.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open as openFile, readFile, readdir, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTripleStore, OxigraphStore, SparqlHttpStore, SharedMemoryLiteralBlobStore, EXTERNAL_LITERAL_REF_DATATYPE, type TripleStore } from '../src/index.js';
import { SQLITE_BLOB_FILENAME } from '../src/sqlite-literal-blob-protocol.js';
import { exportLiteralBlobs } from '../src/export-literal-blobs.js';
import { unexpectedBlobSchemas } from './fixtures/sqlite-blob-unexpected-schema.js';
const roots: string[] = [], stores: TripleStore[] = [];
const graph = 'urn:sqlite-compat/_shared_memory', value = JSON.stringify('exact é payload '.repeat(8000));
const hash = (term: string) => createHash('sha256').update(term).digest('hex');
const quad = (subject: string, object = value) => ({ graph, subject, predicate: 'urn:value', object });
const select = (subject: string) => `SELECT ?value WHERE { GRAPH <${graph}> { <${subject}> <urn:value> ?value } }`;
afterEach(async () => {
  vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'dkg-sqlite-blob-store-')); roots.push(root); return root; }
async function open(root: string, persistence: 'files' | 'sqlite-wal') {
  const store = await createTripleStore({ backend: 'oxigraph-persistent', options: { path: join(root, 'store.nq') },
    graphSetIndex: true, changelog: true, largeLiteralStorage: { directory: join(root, 'blobs'), thresholdBytes: 1024, persistence } });
  stores.push(store); return store;
}
it('reads legacy hash files without migrating them, and reopens new grouped blobs alongside them', async () => {
  const root = await fixture(), old = await open(root, 'files'); await old.insert([quad('urn:old')]); await old.close();
  const path = join(root, 'blobs', hash(value)), before = await readFile(path);
  const current = await open(root, 'sqlite-wal');
  await expect(current.query(select('urn:old'))).resolves.toMatchObject({ bindings: [{ value }] });
  expect(await readdir(join(root, 'blobs'))).toEqual([hash(value)]);
  const next = JSON.stringify(JSON.parse(value)+'new');
  await current.insert([quad('urn:new', next)]); await current.close();
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(join(root, 'blobs'))).toContain(SQLITE_BLOB_FILENAME);
  const reopened = await open(root, 'sqlite-wal');
  await expect(reopened.query(select('urn:old'))).resolves.toMatchObject({ bindings: [{ value }] });
  await expect(reopened.query(select('urn:new'))).resolves.toMatchObject({ bindings: [{ value: next }] });
});
it('drains a query accepted before close through its delayed hydration', async () => {
  const root = await fixture(), inner = new OxigraphStore(join(root, 'store.nq'));
  const store = new SharedMemoryLiteralBlobStore(inner, { blobDir: join(root, 'blobs'), thresholdBytes: 1024, persistence: 'sqlite-wal' }); stores.push(store);
  await store.insert([quad('urn:asset')]);
  const query = inner.query.bind(inner); let release!: () => void, entered = false, closed = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(inner, 'query').mockImplementation(async (...args) => { entered = true; await held; return query(...args); });
  const reading = store.query(select('urn:asset'));
  await vi.waitFor(() => expect(entered).toBe(true));
  const closing = store.close().then(() => { closed = true; });
  try {
    await expect(store.query(select('urn:asset'))).rejects.toThrow('closing');
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
  } finally { release(); }
  await expect(reading).resolves.toMatchObject({ bindings: [{ value }] }); await closing;
});
it('preserves cumulative hydration byte budgets and caller cancellation', async () => {
  const root = await fixture(), store = await open(root, 'sqlite-wal');
  await store.insert([quad('urn:first'), quad('urn:second')]);
  await expect(store.query(`SELECT ?value WHERE { GRAPH <${graph}> { ?s <urn:value> ?value } }`,
    { maxLiteralHydrationBytes: Buffer.byteLength(value) * 2 - 1 })).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
  const controller = new AbortController(); controller.abort();
  await expect(store.query(select('urn:first'), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  await expect(store.query(select('urn:first'))).resolves.toMatchObject({ bindings: [{ value }] });
});
it('exports durable hash files for rollback and leaves the source database and legacy data intact', async () => {
  const root = await fixture(), current = await open(root, 'sqlite-wal');
  await current.insert([quad('urn:asset')]); await current.close();
  const directory = join(root, 'blobs'), path = join(directory, SQLITE_BLOB_FILENAME), before = await readFile(path);
  await expect(exportLiteralBlobs(directory, directory, 16)).rejects.toThrow('export byte limit');
  expect(await readdir(directory)).not.toContain(hash(value));
  expect(await exportLiteralBlobs(directory, directory)).toBe(1);
  expect(await exportLiteralBlobs(directory, directory)).toBe(1);
  expect(await readFile(path)).toEqual(before);
  expect(await readFile(join(directory, hash(value)), 'utf8')).toBe(value);
  const rollback = await open(root, 'files');
  await expect(rollback.query(select('urn:asset'))).resolves.toMatchObject({ bindings: [{ value }] });
});
it('propagates SQLite corruption through hydration and export even when a valid legacy file exists', async () => {
  const root = await fixture(), seed = await open(root, 'sqlite-wal');
  await seed.insert([quad('urn:asset')]); await seed.close();
  const directory = join(root, 'blobs'), legacy = join(directory, hash(value));
  await writeFile(legacy, value, 'utf8');
  const db = new DatabaseSync(join(directory, SQLITE_BLOB_FILENAME));
  db.prepare('UPDATE blobs SET term=? WHERE hash=?').run(Buffer.from('"corrupted but valid UTF-8"'), hash(value)); db.close();
  const current = await open(root, 'sqlite-wal');
  await expect(current.query(select('urn:asset'), { maxLiteralHydrationBytes: Buffer.byteLength(value) + 10 })).rejects.toThrow('integrity mismatch');
  await current.close();
  await expect(exportLiteralBlobs(directory, directory)).rejects.toThrow('integrity mismatch');
  expect(await readFile(legacy, 'utf8')).toBe(value);
});
it('shares strict format validation with offline export before creating any hash files', async () => {
  const root = await fixture(), seed = await open(root, 'sqlite-wal');
  await seed.insert([quad('urn:asset')]); await seed.close();
  const directory = join(root, 'blobs'), path = join(directory, SQLITE_BLOB_FILENAME);
  const db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated(value TEXT)'); db.close();
  const before = await readFile(path), destination = join(root, 'exported');
  await expect(exportLiteralBlobs(directory, destination)).rejects.toThrow('schema');
  expect(await readdir(root)).not.toContain('exported'); expect(await readFile(path)).toEqual(before);
});

it.each([1, 2])('retries rollback export after native partial write %s without damaging source or legacy hydration', async failureAt => {
  const root = await fixture(), current = await open(root, 'sqlite-wal');
  await current.insert([quad('urn:asset')]); await current.close();
  const directory = join(root, 'blobs'), source = join(directory, SQLITE_BLOB_FILENAME);
  const before = await readFile(source), destination = join(directory, hash(value));
  const probePath = join(root, 'write-probe'), probe = await openFile(probePath, 'wx');
  const prototype = Object.getPrototypeOf(probe), nativeWrite = prototype.writeFile as FileHandle['writeFile'];
  await probe.close(); await rm(probePath);
  let writes = 0, partialBytes = 0;
  const fault = vi.spyOn(prototype, 'writeFile').mockImplementation(async function(this: FileHandle,
    data: Parameters<FileHandle['writeFile']>[0], options?: Parameters<FileHandle['writeFile']>[1]) {
    if (data === value && ++writes === failureAt) {
      await nativeWrite.call(this, Buffer.from(value).subarray(0, 31)); await this.sync();
      partialBytes = (await this.stat()).size;
      throw Object.assign(new Error('injected partial write ENOSPC'), { code: 'ENOSPC' });
    }
    return nativeWrite.call(this, data, options);
  });
  try { await expect(exportLiteralBlobs(directory, directory)).rejects.toMatchObject({ code: 'ENOSPC' }); }
  finally { fault.mockRestore(); }
  expect(partialBytes).toBe(failureAt === 1 ? 31 : Buffer.byteLength(value));
  if (failureAt === 1) await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(await readFile(destination, 'utf8')).toBe(value);
  // A killed invocation may leave its private partial stage; fresh runs ignore it.
  const abandoned = join(directory, '.literal-export-abandoned'); await mkdir(abandoned);
  const prefix = Buffer.from(value).subarray(0, 31); await writeFile(join(abandoned, hash(value)), prefix);
  expect(await exportLiteralBlobs(directory, directory)).toBe(1);
  expect(await readFile(destination, 'utf8')).toBe(value);
  expect(await readFile(join(abandoned, hash(value)))).toEqual(prefix);
  expect(await readFile(source)).toEqual(before);
  const rollback = await open(root, 'files');
  await expect(rollback.query(select('urn:asset'))).resolves.toMatchObject({ bindings: [{ value }] });
});
it('protects a conflicting existing rollback hash file while preserving the SQLite source', async () => {
  const root = await fixture(), current = await open(root, 'sqlite-wal');
  await current.insert([quad('urn:asset')]); await current.close();
  const directory = join(root, 'blobs'), source = join(directory, SQLITE_BLOB_FILENAME), before = await readFile(source);
  const destination = join(directory, hash(value)), foreign = '"unrelated existing literal"';
  await writeFile(destination, foreign, 'utf8');
  await expect(exportLiteralBlobs(directory, directory)).rejects.toThrow('corrupt');
  expect(await readFile(destination, 'utf8')).toBe(foreign); expect(await readFile(source)).toEqual(before);
});

it.each(unexpectedBlobSchemas)('rejects unexpected schema ($label) before rollback publication and preserves source data', async ({ sql }) => {
  const root = await fixture(), current = await open(root, 'sqlite-wal');
  await current.insert([quad('urn:seed')]); await current.close();
  const source = join(root, 'blobs', SQLITE_BLOB_FILENAME), db = new DatabaseSync(source);
  db.exec(sql); db.close(); const before = await readFile(source), destination = join(root, 'exported');
  await expect(exportLiteralBlobs(join(root, 'blobs'), destination)).rejects.toThrow('schema');
  expect(await readdir(root)).not.toContain('exported'); expect(await readFile(source)).toEqual(before);
});

it('keeps the native blob owner open through post-HTTP hydration during close', async () => {
  const root = await fixture();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    String(init?.body).trimStart().startsWith('SELECT')
      ? new Response(JSON.stringify({ head: { vars: ['value'] }, results: { bindings: [{ value: {
        type: 'literal', datatype: EXTERNAL_LITERAL_REF_DATATYPE, value: `sha256:${hash(value)}`,
      } }] } }), { headers: { 'content-type': 'application/sparql-results+json' } })
      : new Response(null, { status: 204 }));
  const inner = new SparqlHttpStore({ queryEndpoint: 'http://example.invalid/query', updateEndpoint: 'http://example.invalid/update' });
  const store = new SharedMemoryLiteralBlobStore(inner, { blobDir: root, thresholdBytes: 1024, persistence: 'sqlite-wal' });
  stores.push(store); await store.insert([quad('urn:asset')]);
  let release!: () => void, ready = false, httpClosed = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const query = inner.query.bind(inner), close = inner.close.bind(inner);
  vi.spyOn(inner, 'query').mockImplementation(async (...args) => { const result = await query(...args); ready = true; await held; return result; });
  const httpClose = vi.spyOn(inner, 'close').mockImplementation(async () => { await close(); httpClosed = true; });
  const nativeClose = vi.spyOn(SqliteLiteralBlobOwner.prototype, 'close');
  const reading = store.query(select('urn:asset'));
  const observed = reading.then(result => result, error => error);
  let closing: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(ready).toBe(true));
    closing = store.close();
    await vi.waitFor(() => expect(httpClosed).toBe(true), { timeout: 250, interval: 10 });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(nativeClose).not.toHaveBeenCalled();
    expect(httpClose).toHaveBeenCalledTimes(1);
  } finally { release(); await Promise.allSettled([reading, closing]); }
  const result = await observed;
  expect(result.type).toBe('bindings');
  expect(result.bindings).toHaveLength(1);
  expect(Buffer.from(result.bindings[0].value).equals(Buffer.from(value))).toBe(true);
  expect(nativeClose).toHaveBeenCalledTimes(1);
});
