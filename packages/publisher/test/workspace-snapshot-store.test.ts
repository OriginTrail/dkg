import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Quad } from '@origintrail-official/dkg-storage';
import { describe, expect, it, vi } from 'vitest';
import {
  FileWorkspacePublicSnapshotStore,
  SnapshotStorageCapacityError,
  type SnapshotPageIndexRecord,
  type SnapshotPageIndexStore,
  workspacePublicQuadsDigest,
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

// Compatibility oracle copied from the production implementation before the
// serialization optimization. Keep this test-only copy unchanged.
function oldWorkspacePublicQuadsDigest(quads: readonly Quad[]): string {
  const canonical = quads
    .map((quad) => [quad.subject, quad.predicate, quad.object, ''])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const hash = createHash('sha256');
  hash.update(JSON.stringify(canonical));
  return `sha256:${hash.digest('hex')}`;
}

function digestQuad(
  subject: string,
  predicate = 'https://schema.org/value',
  object = '"value"',
  graph = 'urn:ignored:graph',
): Quad {
  return { subject, predicate, object, graph };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const random = seededRandom(seed);
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function randomizedQuads(seed: number, count: number): Quad[] {
  const random = seededRandom(seed);
  const fragments = [
    'plain',
    'café',
    '東京',
    '🚀',
    'quote"',
    'slash\\',
    'line\nbreak',
    '\tcontrol',
  ];
  return Array.from({ length: count }, (_, index) => {
    const fragment = fragments[Math.floor(random() * fragments.length)];
    const value = Math.floor(random() * 10_000).toString(36);
    return digestQuad(
      `urn:random:${seed}:${index}:${fragment}`,
      `https://example.com/predicate/${fragments[Math.floor(random() * fragments.length)]}`,
      `"${fragment}:${value}"`,
      `urn:graph:${Math.floor(random() * 5)}`,
    );
  });
}

describe('workspacePublicQuadsDigest compatibility', () => {
  it.each([
    { name: 'empty', quads: [] },
    { name: 'single row', quads: [digestQuad('urn:single')] },
    {
      name: 'duplicate rows',
      quads: [
        digestQuad('urn:duplicate'),
        digestQuad('urn:other'),
        digestQuad('urn:duplicate'),
        digestQuad('urn:duplicate'),
      ],
    },
    {
      name: 'Unicode and emoji',
      quads: [
        digestQuad(
          'https://例え.テスト/咖啡/🚀',
          'https://schema.org/naïve',
          '"Zażółć gęślą jaźń — こんにちは 👩🏽‍🚀"@pl',
        ),
        digestQuad('urn:unicode:é', 'urn:predicate:ß', '"Привет мир"'),
      ],
    },
    {
      name: 'JSON-escaped characters',
      quads: [
        digestQuad(
          'urn:escaped:"quote"\\backslash\nline',
          'urn:predicate:\tcontrol',
          '"backspace:\b form-feed:\f newline:\n carriage-return:\r tab:\t slash:\\ quote:\" null:\u0000 unit-separator:\u001f"',
        ),
      ],
    },
    {
      name: 'long values',
      quads: [
        digestQuad(
          `urn:long:${'subject'.repeat(10_000)}`,
          `urn:predicate:${'path/'.repeat(10_000)}`,
          `"${'long value 🚀 '.repeat(10_000)}"`,
        ),
      ],
    },
  ])('matches the old digest for $name input', ({ quads }) => {
    expect(workspacePublicQuadsDigest(quads)).toBe(oldWorkspacePublicQuadsDigest(quads));
  });

  it('is identical for differently ordered copies of the same dataset', () => {
    const quads = randomizedQuads(17, 250);
    const permutations = [
      quads,
      [...quads].reverse(),
      shuffled(quads, 101),
      shuffled(quads, 202),
    ];
    const expected = oldWorkspacePublicQuadsDigest(quads);

    for (const permutation of permutations) {
      expect(oldWorkspacePublicQuadsDigest(permutation)).toBe(expected);
      expect(workspacePublicQuadsDigest(permutation)).toBe(expected);
    }
  });

  it('matches the old digest for deterministic randomized datasets and permutations', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const quads = randomizedQuads(seed, 40 + seed * 7);
      for (let permutation = 0; permutation < 4; permutation += 1) {
        const input = shuffled(quads, seed * 100 + permutation);
        expect(workspacePublicQuadsDigest(input)).toBe(oldWorkspacePublicQuadsDigest(input));
      }
    }
  });

  it('matches the old digest for a shuffled 100,000-row dataset', { timeout: 120_000 }, () => {
    const quads = shuffled(
      Array.from({ length: 100_000 }, (_, index) => digestQuad(
        `urn:large:${index.toString().padStart(6, '0')}`,
        `https://example.com/predicate/${index % 97}`,
        `"large value ${index} ${'x'.repeat(index % 41)}"`,
        `urn:graph:${index % 11}`,
      )),
      100_000,
    );

    expect(workspacePublicQuadsDigest(quads)).toBe(oldWorkspacePublicQuadsDigest(quads));
  });

  it('does not mutate the input array or rows', () => {
    const quads = Object.freeze([
      Object.freeze(digestQuad('urn:z')),
      Object.freeze(digestQuad('urn:a')),
      Object.freeze(digestQuad('urn:m')),
    ]);
    const before = structuredClone(quads);

    workspacePublicQuadsDigest(quads);

    expect(quads).toEqual(before);
  });

  it('serializes each canonical row exactly once', () => {
    const quads = randomizedQuads(99, 64);
    const stringify = vi.spyOn(JSON, 'stringify');

    workspacePublicQuadsDigest(quads);
    const serializationCount = stringify.mock.calls.length;
    stringify.mockRestore();

    expect(serializationCount).toBe(quads.length);
  });
});

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

  it('seeks persisted page indexes by UTF-8 bytes across a sparse checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-page-'));
    const pageIndexes = new MemoryPageIndexStore();
    const quads = makeQuads(300, 'utf8').map((quad, index) => ({
      ...quad,
      object: `"café 🚀 ${index}"`,
    }));

    try {
      await new FileWorkspacePublicSnapshotStore(directory, pageIndexes)
        .putSnapshot({ digest: DIGEST, quads });

      const reopenedStore = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
      await expect(reopenedStore.getSnapshotPage(DIGEST, 128, 1))
        .resolves.toEqual(quads.slice(128, 129));
      await expect(reopenedStore.getSnapshotPage(DIGEST, 257, 12))
        .resolves.toEqual(quads.slice(257, 269));
      expect(pageIndexes.reads).toBe(1);
      expect(pageIndexes.writes).toBe(1);
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

describe('FileWorkspacePublicSnapshotStore GC v1', () => {
  it('does not rewrite an immutable snapshot that is already present', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-gc-'));
    const pageIndexes = new MemoryPageIndexStore();
    const store = new FileWorkspacePublicSnapshotStore(directory, pageIndexes);
    const quads = makeQuads(3, 'deduplicated');

    try {
      const first = await store.putSnapshot({ digest: DIGEST, quads });
      const oldTime = new Date(Date.now() - 10_000);
      await utimes(snapshotPath(directory), oldTime, oldTime);

      const second = await store.putSnapshot({ digest: DIGEST, quads });

      expect(second).toEqual(first);
      expect((await stat(snapshotPath(directory))).mtimeMs).toBeCloseTo(oldTime.getTime(), -2);
      expect(pageIndexes.writes).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deletes oldest eligible snapshots under pressure until the target is reached', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-gc-'));
    const writer = new FileWorkspacePublicSnapshotStore(directory);
    const oldestDigest = digestFor(101);
    const olderDigest = digestFor(102);
    const youngDigest = digestFor(103);
    const quads = makeQuads(4, 'pressure');
    const now = Date.now();
    let store: FileWorkspacePublicSnapshotStore | undefined;

    try {
      await writer.putSnapshot({ digest: oldestDigest, quads });
      await writer.putSnapshot({ digest: olderDigest, quads });
      await writer.putSnapshot({ digest: youngDigest, quads });
      await utimes(snapshotPath(directory, oldestDigest), new Date(now - 30_000), new Date(now - 30_000));
      await utimes(snapshotPath(directory, olderDigest), new Date(now - 20_000), new Date(now - 20_000));
      const oldestSize = (await stat(snapshotPath(directory, oldestDigest))).size;

      store = new FileWorkspacePublicSnapshotStore(directory, undefined, {
        gc: {
          enabled: true,
          intervalMs: 60_000,
          triggerFreeBytes: 1,
          targetFreeBytes: oldestSize,
          hardReserveBytes: 0,
          minAgeMs: 10_000,
          staleTempAgeMs: 1_000,
        },
        getAvailableBytes: async () => 0,
        now: () => now,
      });
      const result = await store.collectGarbage();

      expect(result).toMatchObject({
        triggered: true,
        deletedSnapshots: 1,
        deletedSnapshotBytes: oldestSize,
        availableBytesAfter: oldestSize,
      });
      await expect(stat(snapshotPath(directory, oldestDigest))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(snapshotPath(directory, olderDigest))).resolves.toBeTruthy();
      await expect(stat(snapshotPath(directory, youngDigest))).resolves.toBeTruthy();
    } finally {
      store?.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('removes stale temp files even when free space is above the pressure trigger', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-gc-'));
    const hash = DIGEST.slice('sha256:'.length);
    const tempDirectory = snapshotDirectory(directory);
    const tempPath = join(tempDirectory, `${hash}.nq.123.456.tmp`);
    const now = Date.now();
    let store: FileWorkspacePublicSnapshotStore | undefined;

    try {
      await mkdir(tempDirectory, { recursive: true });
      await writeFile(tempPath, 'abandoned temp file');
      await utimes(tempPath, new Date(now - 10_000), new Date(now - 10_000));
      store = new FileWorkspacePublicSnapshotStore(directory, undefined, {
        gc: {
          enabled: true,
          intervalMs: 60_000,
          triggerFreeBytes: 20,
          targetFreeBytes: 30,
          hardReserveBytes: 10,
          minAgeMs: 10_000,
          staleTempAgeMs: 5_000,
        },
        getAvailableBytes: async () => 100,
        now: () => now,
      });

      const result = await store.collectGarbage();

      expect(result).toMatchObject({
        triggered: false,
        deletedTempFiles: 1,
        deletedSnapshots: 0,
      });
      await expect(stat(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      store?.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the pressure collector periodically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-gc-'));
    const quads = makeQuads(2, 'periodic');
    const now = Date.now();
    let resolveCollected!: () => void;
    const collected = new Promise<void>((resolve) => { resolveCollected = resolve; });
    let store: FileWorkspacePublicSnapshotStore | undefined;

    try {
      await new FileWorkspacePublicSnapshotStore(directory)
        .putSnapshot({ digest: DIGEST, quads });
      await utimes(snapshotPath(directory), new Date(now - 20_000), new Date(now - 20_000));
      const snapshotSize = (await stat(snapshotPath(directory))).size;
      store = new FileWorkspacePublicSnapshotStore(directory, undefined, {
        gc: {
          enabled: true,
          intervalMs: 10,
          triggerFreeBytes: 1,
          targetFreeBytes: snapshotSize,
          hardReserveBytes: 0,
          minAgeMs: 10_000,
          staleTempAgeMs: 1_000,
        },
        getAvailableBytes: async () => 0,
        now: () => now,
        log: (message) => {
          if (message.includes('snapshots=1')) resolveCollected();
        },
      });

      await Promise.race([
        collected,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('periodic snapshot GC did not run')), 1_000).unref();
        }),
      ]);

      await expect(stat(snapshotPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      store?.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('protects snapshots participating in an active paged read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-gc-'));
    const quads = makeQuads(3, 'active');
    const now = Date.now();
    let indexReadStarted = false;
    let releaseIndexRead!: () => void;
    const indexReadBlocked = new Promise<void>((resolve) => { releaseIndexRead = resolve; });
    let store: FileWorkspacePublicSnapshotStore | undefined;
    const blockingPageIndexes: SnapshotPageIndexStore = {
      get: async () => {
        indexReadStarted = true;
        await indexReadBlocked;
        return null;
      },
      upsert: async () => {},
    };

    try {
      await new FileWorkspacePublicSnapshotStore(directory)
        .putSnapshot({ digest: DIGEST, quads });
      await utimes(snapshotPath(directory), new Date(now - 20_000), new Date(now - 20_000));
      store = new FileWorkspacePublicSnapshotStore(directory, blockingPageIndexes, {
        gc: {
          enabled: true,
          intervalMs: 60_000,
          triggerFreeBytes: 1,
          targetFreeBytes: 1,
          hardReserveBytes: 0,
          minAgeMs: 10_000,
          staleTempAgeMs: 1_000,
        },
        getAvailableBytes: async () => 0,
        now: () => now,
      });
      const pageRead = store.getSnapshotPage(DIGEST, 1, 1);
      await vi.waitFor(() => expect(indexReadStarted).toBe(true));

      const result = await store.collectGarbage();
      releaseIndexRead();

      expect(result).toMatchObject({ deletedSnapshots: 0, skippedActiveFiles: 1 });
      await expect(pageRead).resolves.toEqual(quads.slice(1, 2));
      await expect(stat(snapshotPath(directory))).resolves.toBeTruthy();
    } finally {
      releaseIndexRead?.();
      store?.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a new snapshot before violating the hard reserve', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-gc-'));
    const now = Date.now();
    const store = new FileWorkspacePublicSnapshotStore(directory, undefined, {
      gc: {
        enabled: true,
        intervalMs: 60_000,
        triggerFreeBytes: 20,
        targetFreeBytes: 30,
        hardReserveBytes: 10,
        minAgeMs: 10_000,
        staleTempAgeMs: 1_000,
      },
      getAvailableBytes: async () => 15,
      now: () => now,
    });

    try {
      const write = store.putSnapshot({ digest: DIGEST, quads: makeQuads(3, 'capacity') });
      await expect(write).rejects.toBeInstanceOf(SnapshotStorageCapacityError);
      await expect(write).rejects.toMatchObject({
        code: 'SNAPSHOT_STORAGE_CAPACITY',
        availableBytes: 15,
        hardReserveBytes: 10,
      });
      await expect(stat(snapshotPath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      store.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses real filesystem availability for collection and capacity admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-gc-statfs-'));
    const oldDigest = digestFor(201);
    const rejectedDigest = digestFor(202);
    const now = Date.now();
    let gcStore: FileWorkspacePublicSnapshotStore | undefined;
    let capacityStore: FileWorkspacePublicSnapshotStore | undefined;

    try {
      await new FileWorkspacePublicSnapshotStore(directory).putSnapshot({
        digest: oldDigest,
        quads: makeQuads(4, 'real-statfs-old'),
      });
      await utimes(
        snapshotPath(directory, oldDigest),
        new Date(now - 20_000),
        new Date(now - 20_000),
      );
      gcStore = new FileWorkspacePublicSnapshotStore(directory, undefined, {
        gc: {
          enabled: true,
          intervalMs: 60_000,
          triggerFreeBytes: Number.MAX_SAFE_INTEGER - 1,
          targetFreeBytes: Number.MAX_SAFE_INTEGER,
          hardReserveBytes: 0,
          minAgeMs: 10_000,
          staleTempAgeMs: 1_000,
        },
        now: () => now,
      });

      const result = await gcStore.collectGarbage();

      expect(result.triggered).toBe(true);
      expect(result.deletedSnapshots).toBe(1);
      expect(result.availableBytesBefore).toBeGreaterThan(0);
      await expect(stat(snapshotPath(directory, oldDigest)))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const filesystem = await statfs(directory);
      const availableBytes = filesystem.bavail * filesystem.bsize;
      const hardReserveBytes = availableBytes + 1024 ** 3;
      capacityStore = new FileWorkspacePublicSnapshotStore(directory, undefined, {
        gc: {
          enabled: true,
          intervalMs: 60_000,
          triggerFreeBytes: hardReserveBytes + 1,
          targetFreeBytes: hardReserveBytes + 1,
          hardReserveBytes,
          minAgeMs: Number.MAX_SAFE_INTEGER,
          staleTempAgeMs: 1_000,
        },
        now: () => now,
      });

      await expect(capacityStore.putSnapshot({
        digest: rejectedDigest,
        quads: makeQuads(4, 'real-statfs-capacity'),
      })).rejects.toMatchObject({
        code: 'SNAPSHOT_STORAGE_CAPACITY',
        hardReserveBytes,
      });
      await expect(stat(snapshotPath(directory, rejectedDigest)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      gcStore?.stopGarbageCollection();
      capacityStore?.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects inconsistent watermarks at construction time', () => {
    expect(() => new FileWorkspacePublicSnapshotStore('/tmp/dkg-invalid-gc', undefined, {
      gc: {
        enabled: true,
        triggerFreeBytes: 20,
        targetFreeBytes: 10,
        hardReserveBytes: 5,
      },
    })).toThrow('targetFreeBytes must be greater than or equal to triggerFreeBytes');
  });
});
