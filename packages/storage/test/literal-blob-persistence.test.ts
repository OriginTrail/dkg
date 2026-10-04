import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OxigraphStore, SharedMemoryLiteralBlobStore, asTripleStorePersistenceCapability } from '../src/index.js';
const syncControl = vi.hoisted(() => ({ fail: undefined as 'file' | 'directory' | undefined, held: null as Promise<void> | null, entered: false, calls: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args), sync = file.sync.bind(file), path = String(args[0]);
    if (path.includes('literal-files')) file.sync = async () => {
      syncControl.calls.push(path); syncControl.entered = true; await syncControl.held;
      if (syncControl.fail === (/[a-f0-9]{64}$/.test(path) ? 'file' : 'directory')) throw Object.assign(new Error('literal fsync failed'), { code: 'EIO' });
      await sync();
    };
    return file;
  } };
});
const dirs: string[] = [], stores: SharedMemoryLiteralBlobStore[] = [];
afterEach(async () => { syncControl.fail = undefined; syncControl.held = null; syncControl.entered = false; syncControl.calls = [];
  vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-literal-persistence-')); dirs.push(dir);
  const path = join(dir, 'store.nq'), blobDir = join(dir, 'literal-files', 'nested'), backend = new OxigraphStore(path);
  const store = new SharedMemoryLiteralBlobStore(backend, { blobDir, thresholdBytes: 10 }); stores.push(store);
  const quad = { graph: 'urn:dkg:cg/_shared_memory', subject: 'urn:asset', predicate: 'urn:value', object: '"a literal larger than the threshold"' };
  return { store, backend, path, blobDir, quad };
}
describe('external literal persistence certification', () => {
  it('waits for file and directory persistence before referencing the blob, then reopens hydrated content', async () => {
    const f = await fixture(); let release!: () => void;
    syncControl.held = new Promise<void>(resolve => { release = resolve; });
    const insert = vi.spyOn(f.backend, 'insert'), mutation = f.store.insert([f.quad]);
    try {
      await vi.waitFor(() => expect(syncControl.entered).toBe(true));
      expect(insert).not.toHaveBeenCalled();
    } finally { release(); }
    await mutation; await asTripleStorePersistenceCapability(f.store)!.persist();
    expect(syncControl.calls).toContain(f.blobDir); expect(syncControl.calls).toContain(join(f.blobDir, '..')); expect(syncControl.calls.some(path => /[a-f0-9]{64}$/.test(path))).toBe(true);
    const reopened = new SharedMemoryLiteralBlobStore(new OxigraphStore(f.path), { blobDir: f.blobDir, thresholdBytes: 10 }); stores.push(reopened);
    expect(await reopened.query('SELECT ?value WHERE { GRAPH <urn:dkg:cg/_shared_memory> { <urn:asset> <urn:value> ?value } }'))
      .toMatchObject({ bindings: [{ value: f.quad.object }] });
  });
  it.each(['file', 'directory'] as const)('propagates a %s sync error, never inserts a dangling reference, and retries existing bytes durably', async failure => {
    const f = await fixture(), insert = vi.spyOn(f.backend, 'insert'); syncControl.fail = failure;
    await expect(f.store.insert([f.quad])).rejects.toMatchObject({ code: 'EIO' }); expect(insert).not.toHaveBeenCalled();
    syncControl.fail = undefined; await f.store.insert([f.quad]); await asTripleStorePersistenceCapability(f.store)!.persist();
    expect(insert).toHaveBeenCalledOnce(); expect(syncControl.calls.filter(path => /[a-f0-9]{64}$/.test(path))).toHaveLength(2);
  });
});
