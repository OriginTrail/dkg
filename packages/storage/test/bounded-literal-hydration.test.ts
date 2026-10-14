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
  await expect(readLiteralBlobBounded(path, hash(content), 16_384))
    .rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
  expect(read).not.toHaveBeenCalled();
  expect(allocate).not.toHaveBeenCalled();
});
it('verifies a bounded blob and honors cancellation before any file access', async () => {
  const dir = await directory(), content = '"small literal"', path = join(dir, hash(content));
  await writeFile(path, content);
  expect(await readLiteralBlobBounded(path, hash(content), content.length)).toBe(content);
  await expect(readLiteralBlobBounded(path, '0'.repeat(64), content.length)).rejects.toThrow('digest mismatch');
  const abort = new AbortController(); abort.abort(new Error('caller left'));
  await expect(readLiteralBlobBounded(join(dir, 'absent'), hash(content), 100, abort.signal)).rejects.toThrow('caller left');
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
