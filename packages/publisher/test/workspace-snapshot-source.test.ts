import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { readSnapshotSource, resolveSnapshotSource, snapshotPath } from '../src/workspace-snapshot-source.js';

it('rejects bytes from a different inode than the selected source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-source-swap-'));
  const hash = '1'.repeat(64);
  const path = snapshotPath(directory, hash, 'nq');
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '<urn:original> <urn:value> "original" .\n');
    const source = await resolveSnapshotSource(directory, hash);
    if (!source) throw new Error('Missing fixture source');
    await writeFile(`${path}.replacement`, '<urn:replacement> <urn:value> "replacement" .\n');
    await rename(path, `${path}.original`);
    await rename(`${path}.replacement`, path);
    await expect(readSnapshotSource(source)).rejects.toThrow('Snapshot source changed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
