import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { OxigraphStore, SharedMemoryLiteralBlobStore } from '../src/index.js';

const fault = vi.hoisted(() => ({ parent: '', fileSynced: false, fail: false, parentSyncs: 0 }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args), sync = file.sync.bind(file);
    file.sync = async () => {
      const path = await fs.realpath(String(args[0]));
      if ((await file.stat()).isDirectory()) {
        if (path === fault.parent && fault.fileSynced) {
          fault.parentSyncs++;
          if (fault.fail) throw Object.assign(new Error('actual blob parent sync failed'), { code: 'EIO' });
        }
      } else if (path.startsWith(fault.parent + sep) && /[a-f0-9]{64}$/.test(path)) {
        fault.fileSynced = true;
      }
      await sync();
    };
    return file;
  } };
});

let root: string, store: SharedMemoryLiteralBlobStore | undefined;
afterEach(async () => {
  await store?.close(); store = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  fault.parent = ''; fault.fileSynced = false; fault.fail = false; fault.parentSyncs = 0;
});

// Node cannot sync directories on Windows; the POSIX identity/barrier contract is tested here.
// test-disable-allow: D1 #2962 -- owner=Jurij89 lane=storage-unit-linux expires=2026-11-14 Actual directory fsync runs in required Linux storage tests; Node has no Windows directory barrier.
describe.skipIf(process.platform === 'win32')('POSIX blob directory entry persistence', () => {
it.each([
  [false, false], [true, false], [false, true], [true, true],
])('persists the actual blob parent for symlink/.. paths: relative=%s, existing=%s', async (relativePath, existing) => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-blob-directory-')));
  await mkdir(join(root, 'physical', 'deep'), { recursive: true });
  await symlink(join(root, 'physical', 'deep'), join(root, 'link'), 'dir');
  const parent = join(root, 'blobs');
  if (existing) await mkdir(parent);
  const configured = `${relativePath ? relative(process.cwd(), root) : root}${sep}link${sep}..${sep}blobs`;
  const snapshot = join(root, 'store.nq'), backend = new OxigraphStore(snapshot);
  store = new SharedMemoryLiteralBlobStore(backend, { blobDir: configured, thresholdBytes: 10 });
  const quad = { graph: 'urn:identity/_shared_memory', subject: 'urn:asset', predicate: 'urn:value', object: '"immutable bytes need their actual directory entry"' };
  fault.parent = parent; fault.fail = true;
  // Fault only after the blob file was synced, not during initial ancestry preparation.
  await expect(store.insert([quad])).rejects.toMatchObject({ code: 'EIO' });
  expect(fault.fileSynced).toBe(true); expect(fault.parentSyncs).toBeGreaterThan(0);
  expect(await backend.countQuads(quad.graph)).toBe(0);
  fault.fail = false;
  await store.insert([quad]); await store.commitment!.capture()();
  expect(await readFile(join(parent, createHash('sha256').update(quad.object).digest('hex')), 'utf8')).toBe(quad.object);
  await store.close();
  store = new SharedMemoryLiteralBlobStore(new OxigraphStore(snapshot), { blobDir: configured, thresholdBytes: 10 });
  await expect(store.query(`SELECT ?value WHERE { GRAPH <${quad.graph}> { <urn:asset> <urn:value> ?value } }`))
    .resolves.toMatchObject({ bindings: [{ value: quad.object }] });
});

it('certifies an adopted blob file alias and the target name before exposing RDF', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-blob-file-alias-')));
  const blobDir = join(root, 'blobs'), adopted = join(root, 'adopted');
  await Promise.all([mkdir(blobDir), mkdir(adopted)]);
  const quad = { graph: 'urn:identity/_shared_memory', subject: 'urn:asset', predicate: 'urn:value', object: '"verified existing bytes behind a file alias"' };
  const hash = createHash('sha256').update(quad.object).digest('hex');
  await writeFile(join(adopted, hash), quad.object);
  await symlink(`../adopted/${hash}`, join(blobDir, hash));
  const backend = new OxigraphStore(join(root, 'store.nq'));
  store = new SharedMemoryLiteralBlobStore(backend, { blobDir, thresholdBytes: 10 });
  fault.parent = adopted; fault.fail = true;
  await expect(store.insert([quad])).rejects.toMatchObject({ code: 'EIO' });
  expect(fault.fileSynced).toBe(true); expect(fault.parentSyncs).toBeGreaterThan(0);
  expect(await backend.countQuads(quad.graph)).toBe(0);
  fault.fail = false; await store.insert([quad]); await store.commitment!.capture()();
  await expect(store.query(`SELECT ?value WHERE { GRAPH <${quad.graph}> { <urn:asset> <urn:value> ?value } }`))
    .resolves.toMatchObject({ bindings: [{ value: quad.object }] });
});
});
