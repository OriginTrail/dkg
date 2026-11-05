// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRfc64PersistenceV1, type Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import {
  RFC64_OWED_SHARE_INVENTORY_DIRECTORY_NAME_V1,
  encodeRfc64OwedShareInventoryV1,
  openRfc64OwedShareInventoryStoreForOwnedPersistenceRootV1,
  parseRfc64OwedShareInventoryV1,
  snapshotRfc64OwedShareInventoryV1,
  type Rfc64OwedShareInventoryV1,
} from '../src/rfc64/owed-share-inventory-store-v1.js';
import { resolveRfc64PersistenceRootV1 } from '../src/rfc64/persistence-layout-v1.js';
import {
  getRfc64PersistenceRootOwnershipForInventoryV1,
  registerRfc64PersistenceRootOwnershipV1,
} from '../src/rfc64/persistence-root-ownership-v1-internal.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const MARKER: Readonly<Rfc64OwedShareInventoryV1> = snapshotRfc64OwedShareInventoryV1({
  version: 1,
  contextGraphId: `${AUTHOR}/owed-share-inventory`,
  subGraphName: null,
  authorAddress: AUTHOR,
  assertionCoordinate: 'fenced-share',
  sealDigest: `0x${'ab'.repeat(32)}`,
  shareOperationId: 'swm-share-op-1',
});

const roots: string[] = [];
const opened: Rfc64PersistenceV1[] = [];

afterEach(async () => {
  for (const persistence of opened.splice(0)) {
    if (!persistence.closed) await persistence.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rfc64-owed-share-inventory-'));
  roots.push(root);
  return root;
}

async function open(dir: string): Promise<Rfc64PersistenceV1> {
  const persistence = await openRfc64PersistenceV1(dir, { yieldAfterPurgeBatch: async () => undefined });
  opened.push(persistence);
  return persistence;
}

function markerDirectory(dir: string): string {
  return join(resolveRfc64PersistenceRootV1(dir), RFC64_OWED_SHARE_INVENTORY_DIRECTORY_NAME_V1);
}

describe('RFC-64 owed share inventory store', () => {
  it.each([null, [], 'marker', {}, { ...MARKER, authorAddress: 7 },
    { ...MARKER, assertionCoordinate: 'bad\u0000name' }, { ...MARKER, sealDigest: 'bad' }])(
    'rejects unvalidated marker input %j', (raw: unknown) => {
      expect(() => snapshotRfc64OwedShareInventoryV1(raw)).toThrow();
    },
  );

  it('keeps a marker across a restart until it is deleted', async () => {
    const dir = await dataDir();
    const first = await open(dir);
    expect(first.owedShareInventories.list()).toEqual([]);
    expect(first.owedShareInventories.unreadableAtOpen).toBe(0);
    await first.owedShareInventories.put(MARKER);
    // The same marker again is the same durable file.
    await first.owedShareInventories.put({ ...MARKER });
    const second = { ...MARKER, shareOperationId: 'swm-share-op-2' };
    await first.owedShareInventories.put(second);
    expect(first.owedShareInventories.list()).toEqual([MARKER, second]);
    // The owner keeps a failed attempt's pause on this object, so it stays one object while kept.
    const [kept] = first.owedShareInventories.list();
    expect(first.owedShareInventories.list()[0]).toBe(kept);
    expect(Object.isFrozen(kept)).toBe(true);
    await first.close();
    expect(() => first.owedShareInventories.list()).toThrow('closed');

    const restarted = await open(dir);
    expect(restarted.owedShareInventories.list()).toHaveLength(2);
    expect(restarted.owedShareInventories.list()).toEqual(expect.arrayContaining([MARKER, second]));
    await restarted.owedShareInventories.delete(MARKER);
    // Deleting a marker that is no longer kept changes nothing.
    await restarted.owedShareInventories.delete(MARKER);
    expect(restarted.owedShareInventories.list()).toEqual([second]);
    await restarted.close();

    const again = await open(dir);
    expect(again.owedShareInventories.list()).toEqual([second]);
    expect(await readdir(markerDirectory(dir))).toHaveLength(1);
  });

  it('completes the delete of a marker whose file is already gone', async () => {
    const dir = await dataDir();
    const persistence = await open(dir);
    await persistence.owedShareInventories.put(MARKER);
    const [file] = await readdir(markerDirectory(dir));
    await unlink(join(markerDirectory(dir), file!));
    await persistence.owedShareInventories.delete(MARKER);
    expect(persistence.owedShareInventories.list()).toEqual([]);
  });

  it('counts unreadable marker files without loading them and removes interrupted writes', async () => {
    const dir = await dataDir();
    const first = await open(dir);
    await first.owedShareInventories.put(MARKER);
    await first.close();
    const directory = markerDirectory(dir);
    const [kept] = await readdir(directory);
    await writeFile(join(directory, `${'0'.repeat(64)}.json`), 'not json', { mode: 0o600 });
    // Canonical bytes under a name that is not their digest.
    await writeFile(join(directory, `${'1'.repeat(64)}.json`), encodeRfc64OwedShareInventoryV1({
      ...MARKER, shareOperationId: 'misnamed',
    }), { mode: 0o600 });
    await writeFile(join(directory, `.${kept}.interrupted.tmp`), 'partial', { mode: 0o600 });
    await writeFile(join(directory, 'unrelated.txt'), 'left alone', { mode: 0o600 });

    const restarted = await open(dir);
    expect(restarted.owedShareInventories.list()).toEqual([MARKER]);
    expect(restarted.owedShareInventories.unreadableAtOpen).toBe(2);
    expect((await readdir(directory)).sort()).toEqual([
      `${'0'.repeat(64)}.json`, `${'1'.repeat(64)}.json`, kept, 'unrelated.txt',
    ].sort());
  });

  it('refuses invalid markers before touching the disk', async () => {
    const dir = await dataDir();
    const persistence = await open(dir);
    await expect(persistence.owedShareInventories.put({ ...MARKER, version: 2 as 1 }))
      .rejects.toThrow('version is invalid');
    await expect(persistence.owedShareInventories.put({ ...MARKER, authorAddress: AUTHOR.toUpperCase() as typeof AUTHOR }))
      .rejects.toThrow('authorAddress');
    await expect(persistence.owedShareInventories.put({ ...MARKER, subGraphName: '_reserved' as never }))
      .rejects.toThrow('subGraphName');
    expect(snapshotRfc64OwedShareInventoryV1({ ...MARKER, subGraphName: 'notes' as never }).subGraphName).toBe('notes');
    expect(persistence.owedShareInventories.list()).toEqual([]);
    await expect(readdir(markerDirectory(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('parses only canonical marker objects', () => {
    const bytes = encodeRfc64OwedShareInventoryV1(MARKER);
    expect(parseRfc64OwedShareInventoryV1(bytes)).toEqual(MARKER);
    const encoder = new TextEncoder();
    expect(() => parseRfc64OwedShareInventoryV1(encoder.encode('{'))).toThrow('not valid JSON');
    expect(() => parseRfc64OwedShareInventoryV1(encoder.encode('[]'))).toThrow('malformed');
    expect(() => parseRfc64OwedShareInventoryV1(encoder.encode(JSON.stringify({ ...MARKER, extra: 1 }))))
      .toThrow('unknown fields');
  });

  it('refuses work after close and an unreadable root at open', async () => {
    const root = await dataDir();
    const holder = {};
    registerRfc64PersistenceRootOwnershipV1(holder, root, () => undefined);
    const ownership = getRfc64PersistenceRootOwnershipForInventoryV1(holder);
    const store = await openRfc64OwedShareInventoryStoreForOwnedPersistenceRootV1(ownership);
    await store.put(MARKER);
    await store.close();
    await expect(store.put(MARKER)).rejects.toThrow('closed');
    await expect(store.delete(MARKER)).rejects.toThrow('closed');

    // A file where the marker directory belongs cannot be opened as one.
    const blocked = await dataDir();
    await writeFile(join(blocked, RFC64_OWED_SHARE_INVENTORY_DIRECTORY_NAME_V1), 'file');
    const blockedHolder = {};
    registerRfc64PersistenceRootOwnershipV1(blockedHolder, blocked, () => undefined);
    await expect(openRfc64OwedShareInventoryStoreForOwnedPersistenceRootV1(
      getRfc64PersistenceRootOwnershipForInventoryV1(blockedHolder),
    )).rejects.toThrow();
    const missingParent = {};
    registerRfc64PersistenceRootOwnershipV1(missingParent, join(blocked, RFC64_OWED_SHARE_INVENTORY_DIRECTORY_NAME_V1), () => undefined);
    await expect(openRfc64OwedShareInventoryStoreForOwnedPersistenceRootV1(
      getRfc64PersistenceRootOwnershipForInventoryV1(missingParent),
    )).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
