import { mkdtemp, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileWorkspacePublicSnapshotStore,
  type SnapshotPageIndexRecord,
  type SnapshotPageIndexStore,
} from '../src/workspace-snapshot-store.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;

class MemoryPageIndexStore implements SnapshotPageIndexStore {
  readonly records = new Map<string, SnapshotPageIndexRecord>();
  reads = 0;
  writes = 0;

  async get(snapshotDigest: string): Promise<SnapshotPageIndexRecord | null> {
    this.reads += 1;
    return this.records.get(snapshotDigest) ?? null;
  }

  async upsert(record: SnapshotPageIndexRecord): Promise<void> {
    this.writes += 1;
    this.records.set(record.snapshotDigest, record);
  }
}

function makeQuads(count: number, label = 'entity') {
  return Array.from({ length: count }, (_, index) => ({
    subject: `urn:snapshot:${label}:${index.toString().padStart(3, '0')}`,
    predicate: 'http://schema.org/value',
    object: `"${index}"`,
    graph: '',
  }));
}

function digestFor(index: number): string {
  return `sha256:${index.toString(16).padStart(64, '0')}`;
}

function snapshotDirectory(directory: string, digest = DIGEST): string {
  const hash = digest.slice('sha256:'.length);
  return join(directory, hash.slice(0, 2), hash.slice(2, 4));
}

function snapshotPath(directory: string, digest = DIGEST): string {
  const hash = digest.slice('sha256:'.length);
  return join(snapshotDirectory(directory, digest), `${hash}.nq`);
}

function decodeOffsets(blob: Uint8Array): number[] {
  const buffer = Buffer.from(blob);
  return Array.from({ length: blob.byteLength / 8 }, (_, index) =>
    Number(buffer.readBigUInt64BE(index * 8)));
}

describe('FileWorkspacePublicSnapshotStore paging', () => {
  it('persists one binary page index for a new snapshot without creating an idx file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const pageIndexes = new MemoryPageIndexStore();
    const store = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
    const quads = makeQuads(205, 'new');

    try {
      await store.putSnapshot({ digest: DIGEST, quads });

      const snapshot = await stat(snapshotPath(directory));
      const record = pageIndexes.records.get(DIGEST);
      expect(record).toMatchObject({
        snapshotDigest: DIGEST,
        formatVersion: 1,
        stride: 128,
        snapshotFileSize: snapshot.size,
        offsetCount: 2,
      });
      expect(record?.modificationFingerprint).toBeTruthy();
      expect(record?.offsetsBlob).toHaveLength(16);
      expect(record?.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(await readdir(snapshotDirectory(directory))).toEqual([`${'b'.repeat(64)}.nq`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('loads and decodes a persisted page index once after the snapshot store is reopened', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const pageIndexes = new MemoryPageIndexStore();
    const quads = makeQuads(300, 'reopen');

    try {
      await new FileWorkspacePublicSnapshotStore(directory, pageIndexes)
        .putSnapshot({ digest: DIGEST, quads });

      const reopenedStore = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
      await expect(reopenedStore.getSnapshotPage(DIGEST, 257, 20))
        .resolves.toEqual(quads.slice(257, 277));
      await expect(reopenedStore.getSnapshotPage(DIGEST, 280, 20))
        .resolves.toEqual(quads.slice(280));
      expect(pageIndexes.reads).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lazily builds and persists a missing page-index row on the first page request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const pageIndexes = new MemoryPageIndexStore();
    const quads = makeQuads(300, 'legacy');

    try {
      await new FileWorkspacePublicSnapshotStore(directory)
        .putSnapshot({ digest: DIGEST, quads });

      const reopenedStore = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
      await expect(reopenedStore.getSnapshotPage(DIGEST, 257, 20))
        .resolves.toEqual(quads.slice(257, 277));
      expect(pageIndexes.writes).toBe(1);
      expect(pageIndexes.records.get(DIGEST)?.offsetsBlob.byteLength).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rebuilds a page index whose snapshot modification fingerprint is stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const pageIndexes = new MemoryPageIndexStore();
    const quads = makeQuads(300, 'stale');

    try {
      await new FileWorkspacePublicSnapshotStore(directory, pageIndexes)
        .putSnapshot({ digest: DIGEST, quads });
      const originalFingerprint = pageIndexes.records.get(DIGEST)?.modificationFingerprint;
      const changedTime = new Date(Date.now() + 10_000);
      await utimes(snapshotPath(directory), changedTime, changedTime);

      const reopenedStore = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
      await expect(reopenedStore.getSnapshotPage(DIGEST, 257, 20))
        .resolves.toEqual(quads.slice(257, 277));
      expect(pageIndexes.writes).toBe(2);
      expect(pageIndexes.records.get(DIGEST)?.modificationFingerprint)
        .not.toBe(originalFingerprint);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'malformed offsets BLOB',
      alter: (record: SnapshotPageIndexRecord): SnapshotPageIndexRecord => ({
        ...record,
        offsetsBlob: new Uint8Array([1, 2, 3]),
      }),
    },
    {
      name: 'altered offsets BLOB',
      alter: (record: SnapshotPageIndexRecord): SnapshotPageIndexRecord => {
        const offsetsBlob = Uint8Array.from(record.offsetsBlob);
        offsetsBlob[offsetsBlob.length - 1] ^= 1;
        return { ...record, offsetsBlob };
      },
    },
    {
      name: 'invalid stride',
      alter: (record: SnapshotPageIndexRecord): SnapshotPageIndexRecord => ({
        ...record,
        stride: 1,
      }),
    },
  ])('rebuilds $name and still serves the requested page', async ({ alter }) => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const pageIndexes = new MemoryPageIndexStore();
    const quads = makeQuads(300, 'corrupt');

    try {
      await new FileWorkspacePublicSnapshotStore(directory, pageIndexes)
        .putSnapshot({ digest: DIGEST, quads });
      pageIndexes.records.set(DIGEST, alter(pageIndexes.records.get(DIGEST)!));

      const reopenedStore = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
      await expect(reopenedStore.getSnapshotPage(DIGEST, 257, 20))
        .resolves.toEqual(quads.slice(257, 277));
      expect(pageIndexes.writes).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves valid snapshots when page-index reads and writes fail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const quads = makeQuads(300, 'sqlite-failure');
    const failingPageIndexes: SnapshotPageIndexStore = {
      get: async () => { throw new Error('database is locked'); },
      upsert: async () => { throw new Error('attempt to write a readonly database'); },
    };

    try {
      const writer = new FileWorkspacePublicSnapshotStore(directory, failingPageIndexes);
      await expect(writer.putSnapshot({ digest: DIGEST, quads }))
        .resolves.toMatchObject({ ref: DIGEST });

      const reopenedStore = new FileWorkspacePublicSnapshotStore(directory, failingPageIndexes);
      await expect(reopenedStore.getSnapshotPage(DIGEST, 257, 20))
        .resolves.toEqual(quads.slice(257, 277));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves an already-open snapshot when rebuilding its page index fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const quads = makeQuads(3, 'rebuild-failure');
    const nquadsPath = snapshotPath(directory);
    const movedPath = `${nquadsPath}.moved`;
    const disruptivePageIndexes: SnapshotPageIndexStore = {
      get: async () => {
        await rename(nquadsPath, movedPath);
        return null;
      },
      upsert: async () => {},
    };

    try {
      await new FileWorkspacePublicSnapshotStore(directory)
        .putSnapshot({ digest: DIGEST, quads });

      const reopenedStore = new FileWorkspacePublicSnapshotStore(
        directory,
        disruptivePageIndexes,
      );
      await expect(reopenedStore.getSnapshotPage(DIGEST, 1, 1))
        .resolves.toEqual(quads.slice(1, 2));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stores the exact-stride EOF checkpoint and seeks an offset-128 page to EOF', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const pageIndexes = new MemoryPageIndexStore();
    const store = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
    const quads = makeQuads(128, 'boundary');

    try {
      await store.putSnapshot({ digest: DIGEST, quads });

      const snapshot = await stat(snapshotPath(directory));
      const record = pageIndexes.records.get(DIGEST)!;
      expect(decodeOffsets(record.offsetsBlob)).toEqual([0, snapshot.size]);
      await expect(store.getSnapshotPage(DIGEST, 128, 1)).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads normal late pages from their nearest sparse checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const pageIndexes = new MemoryPageIndexStore();
    const store = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
    const quads = makeQuads(400, 'late');

    try {
      await store.putSnapshot({ digest: DIGEST, quads });
      await expect(store.getSnapshotPage(DIGEST, 255, 25))
        .resolves.toEqual(quads.slice(255, 280));
      await expect(store.getSnapshotPage(DIGEST, quads.length, 25))
        .resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds the decoded in-memory page-index cache to 64 snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const pageIndexes = new MemoryPageIndexStore();
    const quads = makeQuads(129, 'cache');

    try {
      const writer = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
      for (let index = 1; index <= 65; index += 1) {
        await writer.putSnapshot({ digest: digestFor(index), quads });
      }

      const reopenedStore = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
      for (let index = 1; index <= 65; index += 1) {
        await expect(reopenedStore.getSnapshotPage(digestFor(index), 128, 1))
          .resolves.toEqual(quads.slice(128));
      }
      expect(pageIndexes.reads).toBe(65);

      await reopenedStore.getSnapshotPage(digestFor(65), 128, 1);
      expect(pageIndexes.reads).toBe(65);
      await reopenedStore.getSnapshotPage(digestFor(1), 128, 1);
      expect(pageIndexes.reads).toBe(66);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
