import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTripleStore, OxigraphStore, SharedMemoryLiteralBlobStore, type TripleStore } from '../src/index.js';
import { SQLITE_BLOB_FILENAME } from '../src/sqlite-literal-blob-protocol.js';
import { exportLiteralBlobs } from '../src/export-literal-blobs.js';
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
