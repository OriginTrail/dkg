import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileWorkspacePublicSnapshotStore } from '../src/workspace-snapshot-store.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;

describe('FileWorkspacePublicSnapshotStore paging', () => {
  it('reads only the requested N-Quads page and returns an empty EOF page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const store = new FileWorkspacePublicSnapshotStore(directory);
    const quads = Array.from({ length: 205 }, (_, index) => ({
      subject: `urn:snapshot:entity:${index.toString().padStart(3, '0')}`,
      predicate: 'http://schema.org/value',
      object: `"${index}"`,
      graph: '',
    }));

    try {
      await store.putSnapshot({ digest: DIGEST, quads });

      await expect(store.getSnapshotPage(DIGEST, 64, 64))
        .resolves.toEqual(quads.slice(64, 128));
      await expect(store.getSnapshotPage(DIGEST, 192, 64))
        .resolves.toEqual(quads.slice(192));
      await expect(store.getSnapshotPage(DIGEST, quads.length, 64))
        .resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
