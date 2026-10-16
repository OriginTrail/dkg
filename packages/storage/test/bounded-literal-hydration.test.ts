import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { readLiteralBlobBounded } from '../src/bounded-literal-hydration.js';
import { OxigraphStore, SharedMemoryLiteralBlobStore } from '../src/index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of cleanup.splice(0).reverse()) await stop(); });
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'bounded-literal-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
it('rejects a 1 MiB blob by its opened-file size without reading or allocating its content', async () => {
  const dir = await directory(), content = 'x'.repeat(1024 * 1024), path = join(dir, hash(content));
  await writeFile(path, content);
  const file = await open(path), prototype = Object.getPrototypeOf(file);
  await file.close();
  const read = vi.spyOn(prototype, 'read'), allocate = vi.spyOn(Buffer, 'alloc');
  await expect(readLiteralBlobBounded(path, 16_384))
    .rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
  expect(read).not.toHaveBeenCalled();
  expect(allocate).not.toHaveBeenCalled();
});
it('reads bounded bytes and honors cancellation before any file access', async () => {
  const dir = await directory(), content = '"small literal"', path = join(dir, hash(content));
  await writeFile(path, content);
  expect(await readLiteralBlobBounded(path, content.length)).toBe(content);
  const abort = new AbortController(); abort.abort(new Error('caller left'));
  await expect(readLiteralBlobBounded(join(dir, 'absent'), 100, abort.signal)).rejects.toThrow('caller left');
});
it.each([true, false])('counts repeated and different hydrated values against one result budget, repeated=%s', async repeated => {
  const dir = await directory(), inner = new OxigraphStore(); cleanup.push(() => inner.close());
  const store = new SharedMemoryLiteralBlobStore(inner, { blobDir: dir, thresholdBytes: 40 });
  const graph = 'did:dkg:context-graph:test/_shared_memory';
  await store.insert(['a', repeated ? 'a' : 'b'].map((value, i) => ({
    graph, subject: `urn:s${i}`, predicate: 'urn:p', object: JSON.stringify(value.repeat(500)),
  })));
  const query = `SELECT ?o WHERE { GRAPH <${graph}> { ?s <urn:p> ?o } }`;
  await expect(store.query(query, { maxResponseBytes: 800 })).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
  const result = await store.query(query, { maxResponseBytes: 1100 });
  expect(result.type === 'bindings' && result.bindings.length).toBe(2);
});

it.each([undefined, 4096])('shares valid, corrupt and missing blob diagnostics with byte limit %s', async maxResponseBytes => {
  const dir = await directory(), inner = new OxigraphStore(); cleanup.push(() => inner.close());
  const store = new SharedMemoryLiteralBlobStore(inner, { blobDir: dir, thresholdBytes: 40 });
  const graph = 'did:dkg:context-graph:test/_shared_memory', content = JSON.stringify('value'.repeat(100));
  await store.insert([{ graph, subject: 'urn:s', predicate: 'urn:p', object: content }]);
  const query = `SELECT ?o WHERE { GRAPH <${graph}> { ?s <urn:p> ?o } }`, path = join(dir, hash(content));
  expect(await store.query(query, { maxResponseBytes })).toMatchObject({ bindings: [{ o: content }] });
  await writeFile(path, 'corrupt');
  await expect(store.query(query, { maxResponseBytes })).rejects.toThrow(
    `SWM external literal blob corrupt for sha256:${hash(content)} at ${path}: found sha256:${hash('corrupt')}`);
  await rm(path);
  await expect(store.query(query, { maxResponseBytes })).rejects.toThrow(
    `SWM external literal blob missing for sha256:${hash(content)} at ${path}`);
});
it.each(['bindings', 'quads'])('hydrates independent unbounded %s blobs concurrently without duplicate reads', async kind => {
  const dir = await directory(), inner = new OxigraphStore(); cleanup.push(() => inner.close());
  const store = new SharedMemoryLiteralBlobStore(inner, { blobDir: dir, thresholdBytes: 40 });
  const graph = 'did:dkg:context-graph:test/_shared_memory';
  const values = ['a', 'b', 'a'].map(s => JSON.stringify(s.repeat(500)));
  await store.insert(values.map((object, i) => ({ graph, subject: `urn:s${i}`, predicate: 'urn:p', object })));
  const reader = store as unknown as { readBlob(hash: string, constraints?: unknown): Promise<string> };
  const original = reader.readBlob.bind(store);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reads = vi.spyOn(reader, 'readBlob').mockImplementation(async (...args) => { await held; return original(...args); });
  const query = kind === 'bindings' ? `SELECT ?o WHERE { GRAPH <${graph}> { ?s <urn:p> ?o } } ORDER BY ?s`
    : `CONSTRUCT { ?s <urn:p> ?o } WHERE { GRAPH <${graph}> { ?s <urn:p> ?o } }`;
  const pending = store.query(query);
  try { await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2)); }
  finally { release(); }
  const result = await pending;
  expect(reads).toHaveBeenCalledTimes(2);
  expect(result.type === 'bindings' ? result.bindings.map(row => row.o) : result.type === 'quads' ? result.quads.map(q => q.object).sort() : [])
    .toEqual(kind === 'bindings' ? values : [...values].sort());
});
