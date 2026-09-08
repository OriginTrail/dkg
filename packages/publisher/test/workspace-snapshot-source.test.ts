import { mkdtemp, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readSnapshotSource, openSnapshotSource, snapshotPath } from '../src/workspace-snapshot-source.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
afterEach(() => { vi.mocked(open).mockReset(); });

it('rejects bytes from a different inode than the selected source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-source-swap-'));
  const hash = '1'.repeat(64);
  const path = snapshotPath(directory, hash, 'nq');
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '<urn:original> <urn:value> "original" .\n');
    const source = await openSnapshotSource(directory, hash);
    if (!source) throw new Error('Missing fixture source');
    await writeFile(`${path}.replacement`, '<urn:replacement> <urn:value> "replacement" .\n');
    await rename(path, `${path}.original`);
    await rename(`${path}.replacement`, path);
    try { await expect(readSnapshotSource(source)).rejects.toThrow('Snapshot source changed'); }
    finally { await source.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(['mutate inode', 'replace pathname'] as const)('rejects %s after readFile consumes the selected bytes', async change => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-source-mid-read-'));
  const hash = '2'.repeat(64);
  const path = snapshotPath(directory, hash, 'nq');
  const original = '<urn:original> <urn:value> "original" .\n';
  const replacement = '<urn:replacement> <urn:value> "replacement-longer" .\n';
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, original);
    const consumed = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      const readFile = file.readFile.bind(file);
      Object.defineProperty(file, 'readFile', { value: async () => {
        const bytes = await readFile('utf8');
        consumed(bytes);
        if (change === 'mutate inode') await writeFile(path, replacement);
        else {
          await writeFile(`${path}.replacement`, replacement);
          await rename(`${path}.replacement`, path);
        }
        return bytes;
      } });
      return file;
    });
    const source = await openSnapshotSource(directory, hash);
    if (!source) throw new Error('Missing fixture source');
    try {
      // Call the helper directly: no store-level final check can hide a missing post-read guard.
      await expect(readSnapshotSource(source)).rejects.toThrow('Snapshot source changed');
      expect(consumed).toHaveBeenCalledExactlyOnceWith(original);
    } finally { await source.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
