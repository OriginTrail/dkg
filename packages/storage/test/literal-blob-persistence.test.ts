import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OxigraphStore, SharedMemoryLiteralBlobStore } from '../src/index.js';
const syncControl = vi.hoisted(() => ({ fail: undefined as 'file' | 'directory' | undefined, failPath: undefined as string | undefined, holdPath: undefined as string | undefined, ancestorPath: undefined as string | undefined, creationFail: false, held: null as Promise<void> | null, entered: false, directoryHeld: null as Promise<void> | null, directoryEntered: false, creations: [] as string[], writes: [] as string[], calls: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    if (String(args[0]).includes('literal-files')) syncControl.creations.push(String(args[0]));
    if (syncControl.creationFail && String(args[0]).includes('literal-files')) throw Object.assign(new Error('directory unavailable'), { code: 'EACCES' });
    const created = await actual.mkdir(...args);
    if (created !== undefined && String(args[0]).includes('literal-files')) {
      syncControl.directoryEntered = true; await syncControl.directoryHeld;
    }
    return created;
  }, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (String(args[0]).includes('literal-files')) syncControl.writes.push(String(args[0]));
    return actual.writeFile(...args);
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args), sync = file.sync.bind(file), path = String(args[0]);
    if (path.includes('literal-files') || path === syncControl.ancestorPath) file.sync = async () => {
      syncControl.calls.push(path); syncControl.entered = true;
      if (syncControl.holdPath === undefined || syncControl.holdPath === path) await syncControl.held;
      if (path === syncControl.failPath || syncControl.fail === (/[a-f0-9]{64}$/.test(path) ? 'file' : 'directory')) throw Object.assign(new Error('literal fsync failed'), { code: 'EIO' });
      await sync();
    };
    return file;
  } };
});
const dirs: string[] = [], stores: SharedMemoryLiteralBlobStore[] = [];
afterEach(async () => { syncControl.fail = undefined; syncControl.failPath = undefined; syncControl.holdPath = undefined; syncControl.ancestorPath = undefined; syncControl.creationFail = false; syncControl.held = null; syncControl.entered = false; syncControl.directoryHeld = null; syncControl.directoryEntered = false; syncControl.creations = []; syncControl.writes = []; syncControl.calls = [];
  vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-literal-persistence-')); dirs.push(dir);
  syncControl.ancestorPath = dir;
  const path = join(dir, 'store.nq'), blobDir = join(dir, 'literal-files', 'nested'), backend = new OxigraphStore(path);
  const store = new SharedMemoryLiteralBlobStore(backend, { blobDir, thresholdBytes: 10 }); stores.push(store);
  const quad = { graph: 'urn:dkg:cg/_shared_memory', subject: 'urn:asset', predicate: 'urn:value', object: '"a literal larger than the threshold"' };
  return { store, backend, path, blobDir, quad, dir };
}
describe('external literal persistence certification', () => {
  it('does not retain a failed directory-creation task and retries without a dangling reference', async () => {
    const f = await fixture(), insert = vi.spyOn(f.backend, 'insert'); syncControl.creationFail = true;
    await expect(f.store.insert([f.quad])).rejects.toMatchObject({ code: 'EACCES' });
    expect(insert).not.toHaveBeenCalled(); expect(syncControl.writes).toEqual([]);
    syncControl.creationFail = false; await f.store.insert([f.quad]); await (f.store).commitment!.commit();
    expect(await f.store.query('SELECT ?value WHERE { GRAPH <urn:dkg:cg/_shared_memory> { <urn:asset> <urn:value> ?value } }'))
      .toMatchObject({ bindings: [{ value: f.quad.object }] });
  });
  it('keeps different content hashes behind the same initial directory creation and ancestry barrier', async () => {
    const f = await fixture(); let release!: () => void;
    syncControl.directoryHeld = new Promise<void>(resolve => { release = resolve; });
    const insert = vi.spyOn(f.backend, 'insert'), first = f.store.insert([f.quad]);
    await vi.waitFor(() => expect(syncControl.directoryEntered).toBe(true));
    const second = f.store.insert([{ ...f.quad, subject: 'urn:second', object: '"another large content hash"' }]);
    try { await new Promise(resolve => setImmediate(resolve)); expect(syncControl.writes).toEqual([]); expect(insert).not.toHaveBeenCalled(); }
    finally { release(); await Promise.all([first, second]); }
    await (f.store).commitment!.commit();
    expect(insert).toHaveBeenCalledTimes(2);
  });
  it('prepares ancestry once before concurrent distinct blobs begin their own writes', async () => {
    const f = await fixture(), insert = vi.spyOn(f.backend, 'insert'); let release!: () => void;
    syncControl.holdPath = f.dir;
    syncControl.held = new Promise<void>(resolve => { release = resolve; });
    const first = f.store.insert([f.quad]);
    await vi.waitFor(() => expect(syncControl.calls).toContain(f.dir));
    const second = f.store.insert([{ ...f.quad, subject: 'urn:second', object: '"another large content hash"' }]);
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(syncControl.writes).toEqual([]);
      expect(insert).not.toHaveBeenCalled();
    } finally { release(); await Promise.allSettled([first, second]); }
    await Promise.all([first, second]);
    expect(syncControl.creations).toEqual([f.blobDir]);
    expect(syncControl.calls.filter(path => path === f.dir)).toHaveLength(1);
    expect(syncControl.calls.filter(path => /[a-f0-9]{64}$/.test(path))).toHaveLength(2);
    expect(insert).toHaveBeenCalledTimes(2);
  });
  it('shares an ancestry failure and retains the original creation plan for concurrent retries', async () => {
    const f = await fixture(), insert = vi.spyOn(f.backend, 'insert');
    const secondQuad = { ...f.quad, subject: 'urn:second', object: '"another large content hash"' };
    syncControl.failPath = f.dir;
    const results = await Promise.allSettled([f.store.insert([f.quad]), f.store.insert([secondQuad])]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    const errors = results.map(result => result.status === 'rejected' ? result.reason : undefined);
    expect(errors[0]).toMatchObject({ code: 'EIO' });
    expect(errors[1]).toBe(errors[0]);
    expect(syncControl.writes).toEqual([]); expect(insert).not.toHaveBeenCalled();
    syncControl.failPath = undefined;
    await Promise.all([f.store.insert([f.quad]), f.store.insert([secondQuad])]);
    expect(syncControl.creations).toEqual([f.blobDir]);
    expect(syncControl.calls.filter(path => path === f.dir)).toHaveLength(2);
    expect(syncControl.calls.filter(path => path === join(f.blobDir, '..'))).toHaveLength(2);
    expect(syncControl.writes).toHaveLength(2); expect(insert).toHaveBeenCalledTimes(2);
  });
  it('waits for file and directory persistence before referencing the blob, then reopens hydrated content', async () => {
    const f = await fixture(); let release!: () => void;
    syncControl.held = new Promise<void>(resolve => { release = resolve; });
    const insert = vi.spyOn(f.backend, 'insert'), mutation = f.store.insert([f.quad]);
    try {
      await vi.waitFor(() => expect(syncControl.entered).toBe(true));
      expect(insert).not.toHaveBeenCalled();
    } finally { release(); }
    await mutation; await (f.store).commitment!.commit();
    expect(syncControl.calls).toContain(f.blobDir); expect(syncControl.calls).toContain(join(f.blobDir, '..')); expect(syncControl.calls.some(path => /[a-f0-9]{64}$/.test(path))).toBe(true);
    const reopened = new SharedMemoryLiteralBlobStore(new OxigraphStore(f.path), { blobDir: f.blobDir, thresholdBytes: 10 }); stores.push(reopened);
    expect(await reopened.query('SELECT ?value WHERE { GRAPH <urn:dkg:cg/_shared_memory> { <urn:asset> <urn:value> ?value } }'))
      .toMatchObject({ bindings: [{ value: f.quad.object }] });
  });
  it.each(['file', 'directory'] as const)('propagates a per-blob %s sync error after preparation and retries existing bytes durably', async failure => {
    const f = await fixture(), insert = vi.spyOn(f.backend, 'insert');
    await f.store.insert([f.quad]); insert.mockClear(); syncControl.calls = [];
    const next = { ...f.quad, subject: 'urn:next', object: '"a different literal larger than the threshold"' };
    syncControl.fail = failure;
    await expect(f.store.insert([next])).rejects.toMatchObject({ code: 'EIO' }); expect(insert).not.toHaveBeenCalled();
    syncControl.fail = undefined; await f.store.insert([next]); await (f.store).commitment!.commit();
    expect(insert).toHaveBeenCalledOnce(); expect(syncControl.calls.filter(path => /[a-f0-9]{64}$/.test(path))).toHaveLength(2);
  });
});
