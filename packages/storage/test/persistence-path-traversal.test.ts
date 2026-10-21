import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { DurableReplaceableFile } from '../src/durable-file-replace.js';

const synced = vi.hoisted(() => ({ files: [] as string[], directories: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), sync = handle.sync.bind(handle);
    if (args[1] === 'r+' || args[1] === 'r') handle.sync = async () => {
      await sync();
      (args[1] === 'r+' ? synced.files : synced.directories).push(await fs.realpath(String(args[0])));
    };
    return handle;
  } };
});
const roots: string[] = [];
afterEach(async () => { synced.files = []; synced.directories = []; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each((['snapshot', 'replacement'] as const).flatMap(writer => [false, true].flatMap(decoyExists =>
  [false, true].map(relativePath => [writer, decoyExists, relativePath] as const))))(
  'certifies the actual %s target through a symlink followed by .. with decoy=%s, relative=%s', async (writer, decoyExists, relativePath) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-traversal-'))); roots.push(root);
  await mkdir(join(root, 'physical', 'deep'), { recursive: true });
  await symlink(join(root, 'physical', 'deep'), join(root, 'link'), 'junction');
  // Deliberately do not path.join/resolve this traversal: POSIX follows the link first.
  const path = `${relativePath ? relative(process.cwd(), root) : root}/link/../store.nq`, decoy = join(root, 'store.nq');
  const decoyBytes = '<urn:unrelated> <urn:value> "keep" <urn:other> .\n';
  if (decoyExists) await writeFile(decoy, decoyBytes);
  const store = writer === 'snapshot' ? new OxigraphStore(path) : undefined;
  try {
    if (store) {
      await store.insert([{ subject: 'urn:actual', predicate: 'urn:value', object: '"durable"', graph: 'urn:graph' }]);
      await store.commitment.capture()();
      const reopened = new OxigraphStore(path);
      try { expect(await reopened.countQuads('urn:graph')).toBe(1); } finally { await reopened.close(); }
    } else {
      await new DurableReplaceableFile(path, { fileMode: 0o600, directoryMode: 0o700 }).replace('replacement bytes');
      expect(await readFile(path, 'utf8')).toBe('replacement bytes');
    }
    const actual = await realpath(path);
    expect(synced.files).toContain(actual);
    if (process.platform !== 'win32') expect(synced.directories).toContain(dirname(actual));
    if (actual !== decoy) {
      expect(synced.files).not.toContain(decoy);
      if (decoyExists) expect(await readFile(decoy, 'utf8')).toBe(decoyBytes);
      else await expect(readFile(decoy, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally { await store?.close().catch(() => {}); }
});
