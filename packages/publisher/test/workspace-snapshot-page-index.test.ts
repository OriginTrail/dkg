import { mkdtemp, open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Quad } from '@origintrail-official/dkg-storage';
import { afterEach, expect, it, vi } from 'vitest';
import { FileWorkspacePublicSnapshotStore, serializeWorkspacePublicSnapshotQuads } from '../src/workspace-snapshot-store.js';
import { DIGEST, MemoryPageIndexStore, makeQuads, digestFor, snapshotPath } from './_helpers/workspace-snapshot-store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(open).mockReset(); });

/** Inject faults into the actual descriptor selected by the next public read. */
async function instrumentNextFile(install: (file: FileHandle) => void): Promise<void> {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args);
    install(file);
    return file;
  });
}

it('invalidates an already-warm page index after replacement with different row offsets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-swap-'));
  const pageIndexes = new MemoryPageIndexStore();
  const store = new FileWorkspacePublicSnapshotStore(directory, pageIndexes, { gc: { enabled: false } });
  const quads = makeQuads(300, 'before');
  try {
    await store.putSnapshot({ digest: DIGEST, quads });
    await expect(store.getSnapshotPage(DIGEST, 257, 20)).resolves.toEqual(quads.slice(257, 277));
    expect(pageIndexes.reads).toBe(0);
    const replacement = new FileWorkspacePublicSnapshotStore(`${directory}/replacement`, undefined, { gc: { enabled: false } });
    const changed = makeQuads(300, 'a-much-longer-label-after');
    await replacement.putSnapshot({ digest: DIGEST, quads: changed });
    await rename(snapshotPath(`${directory}/replacement`), snapshotPath(directory));
    await expect(store.getSnapshotPage(DIGEST, 257, 20)).resolves.toEqual(changed.slice(257, 277));
    expect(pageIndexes.reads).toBe(1);
    expect(pageIndexes.writes).toBe(2);
    await expect(store.getSnapshotPage(DIGEST, 280, 5)).resolves.toEqual(changed.slice(280, 285));
    expect(pageIndexes.reads).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it('rejects a replacement selected during a cold index lookup without persisting its index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-cold-'));
  const original = makeQuads(300, 'original');
  const replacement = makeQuads(300, 'replacement-with-longer-rows');
  const pageIndexes = new MemoryPageIndexStore();
  try {
    await new FileWorkspacePublicSnapshotStore(directory, undefined, { gc: { enabled: false } })
      .putSnapshot({ digest: DIGEST, quads: original });
    const replacementDirectory = join(directory, 'replacement');
    await new FileWorkspacePublicSnapshotStore(replacementDirectory, undefined, { gc: { enabled: false } })
      .putSnapshot({ digest: DIGEST, quads: replacement });
    vi.spyOn(pageIndexes, 'get').mockImplementationOnce(async () => {
      await rename(snapshotPath(replacementDirectory), snapshotPath(directory));
      return null;
    });
    const reader = new FileWorkspacePublicSnapshotStore(directory, pageIndexes, { gc: { enabled: false } });
    await expect(reader.getSnapshotPage(DIGEST, 257, 2)).rejects.toThrow('Snapshot source changed');
    expect(pageIndexes.writes).toBe(0);
    await expect(reader.getSnapshotPage(DIGEST, 257, 2)).resolves.toEqual(replacement.slice(257, 259));
    expect(pageIndexes.writes).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(['mutate inode', 'replace pathname'] as const)('rejects %s after the first cold-index chunk without persisting mixed offsets', async change => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-mid-read-'));
  const original = makeQuads(4096, 'original');
  const replacement = makeQuads(4096, 'replacement-with-longer-rows');
  const pageIndexes = new MemoryPageIndexStore();
  try {
    await new FileWorkspacePublicSnapshotStore(directory, undefined, { gc: { enabled: false } })
      .putSnapshot({ digest: DIGEST, quads: original });
    const path = snapshotPath(directory);
    const payload = serializeWorkspacePublicSnapshotQuads(replacement);
    let chunks = 0;
    vi.mocked(open).mockClear();
    await instrumentNextFile(file => {
      const read = file.read.bind(file);
      Object.defineProperty(file, 'read', { value: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        if (result.bytesRead > 0 && chunks++ === 0) {
          if (change === 'mutate inode') await writeFile(path, payload);
          else {
            await writeFile(`${path}.replacement`, payload);
            await rename(`${path}.replacement`, path);
          }
        }
        return result;
      } });
    });
    const reader = new FileWorkspacePublicSnapshotStore(directory, pageIndexes, { gc: { enabled: false } });
    await expect(reader.getSnapshotPage(DIGEST, 257, 2)).rejects.toThrow('Snapshot source changed');
    expect(open).toHaveBeenCalledOnce();
    expect(chunks).toBeGreaterThan(1);
    expect(pageIndexes.writes).toBe(0);
    await expect(reader.getSnapshotPage(DIGEST, 257, 2)).resolves.toEqual(replacement.slice(257, 259));
    expect(pageIndexes.writes).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('shares one in-flight page-index lookup across canonical snapshot reference aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-alias-'));
  const quads = makeQuads(300);
  const pageIndexes = new MemoryPageIndexStore();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    await new FileWorkspacePublicSnapshotStore(directory, undefined, { gc: { enabled: false } })
      .putSnapshot({ digest: DIGEST, quads });
    const lookup = vi.spyOn(pageIndexes, 'get').mockImplementation(async () => { await blocked; return null; });
    const reader = new FileWorkspacePublicSnapshotStore(directory, pageIndexes, { gc: { enabled: false } });
    const first = reader.getSnapshotPage(DIGEST, 257, 2);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    const second = reader.getSnapshotPage(DIGEST.slice(7), 280, 3);
    release();
    await expect(first).resolves.toEqual(quads.slice(257, 259));
    await expect(second).resolves.toEqual(quads.slice(280, 283));
    expect(lookup).toHaveBeenCalledExactlyOnceWith(DIGEST);
    expect(pageIndexes.writes).toBe(1);
    await expect(reader.getSnapshotPage(DIGEST.slice(7).toUpperCase(), 129, 1)).resolves.toEqual(quads.slice(129, 130));
    expect(lookup).toHaveBeenCalledOnce();
  } finally { release(); await rm(directory, { recursive: true, force: true }); }
});

it('retains a newer cached index when an evicted in-flight index later rejects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-rejected-'));
  const quads = makeQuads(300);
  const pageIndexes = new MemoryPageIndexStore();
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  let first: Promise<Quad[] | null> | undefined;
  try {
    const writer = new FileWorkspacePublicSnapshotStore(directory, undefined, { gc: { enabled: false } });
    await writer.putSnapshot({ digest: DIGEST, quads });
    for (let index = 0; index < 64; index++) await writer.putSnapshot({ digest: digestFor(index), quads: quads.slice(0, 1) });
    await instrumentNextFile(file => {
      const read = file.read.bind(file);
      let failOnce = true;
      Object.defineProperty(file, 'read', { value: async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (failOnce) {
          failOnce = false;
          started();
          await blocked;
          throw new Error('injected index read failure');
        }
        return read(buffer, offset, length, position);
      } });
    });
    const lookup = vi.spyOn(pageIndexes, 'get');
    const reader = new FileWorkspacePublicSnapshotStore(directory, pageIndexes, { gc: { enabled: false } });
    first = reader.getSnapshotPage(DIGEST, 257, 2);
    await reading;
    for (let index = 0; index < 64; index++) await reader.getSnapshotPage(digestFor(index), 0, 1);
    // The first promise has been evicted. A second load for its hash now succeeds.
    await expect(reader.getSnapshotPage(DIGEST, 280, 3)).resolves.toEqual(quads.slice(280, 283));
    expect(lookup.mock.calls.filter(([digest]) => digest === DIGEST)).toHaveLength(2);
    release();
    // Index failure still falls back to the same descriptor's valid contents.
    await expect(first).resolves.toEqual(quads.slice(257, 259));
    await expect(reader.getSnapshotPage(DIGEST, 129, 1)).resolves.toEqual(quads.slice(129, 130));
    expect(lookup.mock.calls.filter(([digest]) => digest === DIGEST)).toHaveLength(2);
  } finally {
    release();
    await first?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

it('decodes a multibyte character split across paging chunks and the last line without a newline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-utf8-'));
  const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"' + 'x'.repeat(65516) + '🚀"', graph: '' }];
  try {
    const writer = new FileWorkspacePublicSnapshotStore(directory, undefined, { gc: { enabled: false } });
    await writer.putSnapshot({ digest: DIGEST, quads });
    const payload = serializeWorkspacePublicSnapshotQuads(quads).trimEnd();
    const rocket = Buffer.byteLength(payload.slice(0, payload.indexOf('🚀')));
    expect(rocket).toBeLessThan(65536);
    expect(rocket + Buffer.byteLength('🚀')).toBeGreaterThan(65536);
    await writeFile(snapshotPath(directory), payload);
    const reader = new FileWorkspacePublicSnapshotStore(directory, undefined, { gc: { enabled: false } });
    await expect(reader.getSnapshotPage(DIGEST, 0, 1)).resolves.toEqual(quads);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('drains an aborted physical page read before closing its descriptor and releasing its GC lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-abort-'));
  const quads = makeQuads(300);
  const pageIndexes = new MemoryPageIndexStore();
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  let retired = false;
  let settled = false;
  let request: Promise<unknown> | undefined;
  let reader: FileWorkspacePublicSnapshotStore | undefined;
  try {
    await new FileWorkspacePublicSnapshotStore(directory, pageIndexes, { gc: { enabled: false } })
      .putSnapshot({ digest: DIGEST, quads });
    await instrumentNextFile(file => {
      const read = file.read.bind(file);
      const close = file.close.bind(file);
      Object.defineProperty(file, 'read', { value: async (buffer: Buffer, offset: number, length: number, position: number) => {
        started();
        await blocked;
        return read(buffer, offset, length, position);
      } });
      Object.defineProperty(file, 'close', { value: async () => { await close(); retired = true; } });
    });
    reader = new FileWorkspacePublicSnapshotStore(directory, pageIndexes, {
      gc: { intervalMs: 60000, minAgeMs: 0, triggerFreeBytes: 1, targetFreeBytes: 1, hardReserveBytes: 0 },
      getAvailableBytes: async () => 0,
      now: () => Date.now() + 1000,
    });
    request = reader.getSnapshotPage(DIGEST, 257, 2, { signal: controller.signal })
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await reading;
    controller.abort(new Error('test abort'));
    const during = await reader.collectGarbage();
    expect(during).toMatchObject({ deletedSnapshots: 0, skippedActiveFiles: 1 });
    expect(settled).toBe(false);
    expect(retired).toBe(false);
    release();
    await expect(request).resolves.toBe(controller.signal.reason);
    expect(retired).toBe(true);
    await expect(reader.collectGarbage()).resolves.toMatchObject({ deletedSnapshots: 1, skippedActiveFiles: 0 });
  } finally {
    release();
    await request;
    reader?.stopGarbageCollection();
    await rm(directory, { recursive: true, force: true });
  }
});
