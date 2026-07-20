import Database from 'better-sqlite3';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walObjectId, type WalObjectId } from '../../src/reconciliation/ids.js';
import {
  PackedObjectTransactionAppend,
  createPackedSegmentFile,
  packedRecordMagicMatches,
  packedSegmentMagicMatches,
  readPackedHeaderSync,
  writeAllSync,
  writePackedBytes,
} from '../../src/store/packed-transaction.js';
import { PackedWalObjectStore } from '../../src/store/packed-store.js';

const vectors = JSON.parse(await readFile(
  new URL('../../../../conformance/wal-v1/vectors/protocol-v1.json', import.meta.url),
  'utf8',
));
const roots: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex'));
}

const fixtureBytes = fromHex(vectors.walObjects.first.canonicalBytes);
const fixtureId = walObjectId(fromHex(vectors.walObjects.first.walObjectId));

async function initialized(label: string, putFixture = false): Promise<{
  root: string;
  segmentsRoot: string;
  database: Database.Database;
}> {
  const root = await mkdtemp(join(tmpdir(), `dkg-wal-packed-transaction-${label}-`));
  roots.push(root);
  const store = new PackedWalObjectStore({ root });
  if (putFixture) {
    await store.put(fixtureId, (async function* () { yield fixtureBytes; })());
  }
  store.close();
  const database = new Database(join(root, 'objects.sqlite'));
  databases.push(database);
  return { root, segmentsRoot: join(root, 'segments'), database };
}

function appendFor(input: {
  database: Database.Database;
  segmentsRoot: string;
  id?: WalObjectId;
  source?: { kind: 'bytes'; bytes: Uint8Array } | { kind: 'file'; path: string; length: number };
  hook?: () => void;
}): PackedObjectTransactionAppend {
  return new PackedObjectTransactionAppend({
    database: input.database,
    segmentsRoot: input.segmentsRoot,
    id: input.id ?? walObjectId(new Uint8Array(32).fill(7)),
    source: input.source ?? { kind: 'bytes', bytes: Uint8Array.of(1, 2, 3) },
    segmentTargetBytes: 1_024,
    hook: input.hook,
  });
}

describe('packed transaction primitives', () => {
  it('fails closed when sync or async writes make no progress and validates short magic', async () => {
    expect(packedSegmentMagicMatches(new Uint8Array())).toBe(false);
    expect(packedRecordMagicMatches(Uint8Array.of(1))).toBe(false);
    expect(() => writeAllSync(1, Uint8Array.of(1), 0, () => 0)).toThrowError(
      expect.objectContaining({ code: 'WAL_STORE_IO' }),
    );
    await expect(writePackedBytes({
      write: async () => ({ bytesWritten: 0 }),
    } as never, Uint8Array.of(1), 0)).rejects.toMatchObject({ code: 'WAL_STORE_IO' });
  });

  it('validates segment identifiers and exact synchronous header reads', async () => {
    const { root, segmentsRoot } = await initialized('headers');
    expect(() => createPackedSegmentFile(segmentsRoot, Number.NaN)).toThrowError(
      expect.objectContaining({ code: 'WAL_STORE_CORRUPT' }),
    );
    expect(() => createPackedSegmentFile(segmentsRoot, -1)).toThrowError(
      expect.objectContaining({ code: 'WAL_STORE_CORRUPT' }),
    );
    const path = join(root, 'header.bin');
    await writeFile(path, Uint8Array.of(1, 2, 3));
    const descriptor = openSync(path, 'r');
    try {
      const exact = new Uint8Array(3);
      expect(readPackedHeaderSync(descriptor, exact, 0)).toBe(true);
      expect(exact).toEqual(Uint8Array.of(1, 2, 3));
      expect(readPackedHeaderSync(descriptor, new Uint8Array(4), 0)).toBe(false);
    } finally {
      closeSync(descriptor);
    }
  });

  it('rejects append outside a transaction, invalid sources, duplicates, and missing active segments', async () => {
    const base = await initialized('validation');
    await expect(appendFor(base).append()).rejects.toMatchObject({ code: 'WAL_STORE_IO' });

    base.database.exec('BEGIN IMMEDIATE');
    await expect(appendFor({
      ...base,
      source: { kind: 'bytes', bytes: new Uint8Array() },
    }).append()).rejects.toMatchObject({ code: 'WAL_STORE_INVALID_OBJECT' });
    base.database.exec('ROLLBACK');

    base.database.exec('BEGIN IMMEDIATE');
    await expect(appendFor({
      ...base,
      source: { kind: 'file', path: join(base.root, 'unused'), length: Number.NaN },
    }).append()).rejects.toMatchObject({ code: 'WAL_STORE_INVALID_OBJECT' });
    base.database.exec('ROLLBACK');

    const duplicate = await initialized('duplicate', true);
    duplicate.database.exec('BEGIN IMMEDIATE');
    await expect(appendFor({ ...duplicate, id: fixtureId }).append()).rejects.toMatchObject({
      code: 'WAL_STORE_INVALID_OBJECT',
    });
    duplicate.database.exec('ROLLBACK');

    const missing = await initialized('missing-active');
    missing.database.prepare('UPDATE segments SET sealed = 1').run();
    missing.database.exec('BEGIN IMMEDIATE');
    await expect(appendFor(missing).append()).rejects.toMatchObject({ code: 'WAL_STORE_CORRUPT' });
    missing.database.exec('ROLLBACK');
  });

  it('detects a changed file candidate using the default bounded buffer and repairs the segment', async () => {
    const value = await initialized('short-source');
    const candidate = join(value.root, 'candidate.bin');
    await writeFile(candidate, Uint8Array.of(1));
    value.database.exec('BEGIN IMMEDIATE');
    const append = appendFor({
      ...value,
      source: { kind: 'file', path: candidate, length: 2 },
    });
    await expect(append.append()).rejects.toMatchObject({ code: 'WAL_STORE_IO' });
    value.database.exec('ROLLBACK');
    append.rollback();
    expect((await stat(join(value.segmentsRoot, '0000000000000000.pack'))).size).toBe(32);
  });

  it('makes rollback idempotent before append, after commit, and after external repair', async () => {
    const untouched = await initialized('rollback-untouched');
    appendFor(untouched).rollback();

    const repaired = await initialized('rollback-repaired');
    repaired.database.exec('BEGIN IMMEDIATE');
    const interrupted = appendFor({
      ...repaired,
      hook: () => { throw new Error('after segment sync'); },
    });
    await expect(interrupted.append()).rejects.toThrow('after segment sync');
    repaired.database.exec('ROLLBACK');
    const repairedPath = join(repaired.segmentsRoot, '0000000000000000.pack');
    await truncate(repairedPath, 32);
    interrupted.rollback();
    expect((await stat(repairedPath)).size).toBe(32);

    const committed = await initialized('rollback-committed');
    committed.database.exec('BEGIN IMMEDIATE');
    const complete = appendFor(committed);
    await complete.append();
    committed.database.exec('COMMIT');
    complete.markCommitted();
    complete.rollback();
    expect(committed.database.prepare('SELECT COUNT(*) AS count FROM objects').get()).toEqual({ count: 1 });
  });
});
