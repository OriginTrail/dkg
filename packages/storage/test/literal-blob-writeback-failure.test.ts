import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore, SharedMemoryLiteralBlobStore } from '../src/index.js';

const fault = vi.hoisted(() => ({ directory: '', failNext: true, injected: false, writes: 0 }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  const failedWriters = new WeakSet<object>();
  const isBlob = (path: unknown) => String(path).startsWith(fault.directory + '/') && /[a-f0-9]{64}$/.test(String(path));
  const wrote = () => {
    fault.writes += 1;
    if (!fault.failNext) return false;
    fault.failNext = false; fault.injected = true; return true;
  };
  return { ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const result = await fs.writeFile(...args);
      // Models a consumed writeback error on the writer that writeFile closed.
      // A newly opened descriptor below cannot observe that old error.
      if (isBlob(args[0])) wrote();
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      if (isBlob(args[0])) {
        const write = file.writeFile.bind(file), sync = file.sync.bind(file);
        file.writeFile = async (...values: Parameters<typeof write>) => {
          await write(...values);
          if (wrote()) failedWriters.add(file);
        };
        file.sync = async () => {
          if (failedWriters.has(file)) throw Object.assign(new Error('writer observed failed writeback'), { code: 'EIO' });
          await sync();
        };
      }
      return file;
    },
  };
});
let root: string, store: SharedMemoryLiteralBlobStore | undefined;
afterEach(async () => {
  await store?.close(); store = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  fault.directory = ''; fault.failNext = true; fault.injected = false; fault.writes = 0;
});

it('rejects the writer error before publishing a reference and rewrites existing bytes on retry', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-blob-writeback-')));
  const path = join(root, 'store.nq'), blobDir = join(root, 'blobs');
  fault.directory = blobDir;
  const backend = new OxigraphStore(path);
  store = new SharedMemoryLiteralBlobStore(backend, { blobDir, thresholdBytes: 10 });
  const quad = { graph: 'urn:cg/_shared_memory', subject: 'urn:asset', predicate: 'urn:value', object: '"durable immutable literal bytes"' };
  await expect(store.insert([quad])).rejects.toMatchObject({ code: 'EIO' });
  expect(fault.injected).toBe(true);
  expect(await backend.countQuads(quad.graph)).toBe(0);
  await store.insert([quad]); await store.commitment!.capture()();
  expect(fault.writes).toBe(2); // Retry submits the full bytes again, not a new-fd fsync alone.
  await store.close();
  store = new SharedMemoryLiteralBlobStore(new OxigraphStore(path), { blobDir, thresholdBytes: 10 });
  await expect(store.query(`SELECT ?value WHERE { GRAPH <${quad.graph}> { <urn:asset> <urn:value> ?value } }`))
    .resolves.toMatchObject({ bindings: [{ value: quad.object }] });
});
