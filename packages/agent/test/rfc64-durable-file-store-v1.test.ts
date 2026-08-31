import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE } from '../src/rfc64/control-object-store-v1.js';
import { createRfc64DurableFileStoreV1 } from '../src/rfc64/durable-file-store-v1.js';
import { applyRfc64OwnerOnlyPermissionsSyncV1 } from '../src/rfc64/secure-filesystem-policy-v1.js';
import {
  createTemporaryDataDirectoryFixture,
  deferred,
} from './support/rfc64-control-object-store-fixtures.js';
import {
  createRfc64DurableFileStoreForTestV1,
  type Rfc64DurableFileTestLifecycleV1,
} from './support/rfc64-durable-file-store-test-support.js';

const temporaryDirectories = createTemporaryDataDirectoryFixture();
const { temporaryDataDirectory } = temporaryDirectories;

afterEach(async () => {
  await temporaryDirectories.cleanup();
});

describe('RFC-64 durable file store v1', () => {
  it('rejects an escaping durable-file relative key inside the write operation', async () => {
    const containmentRoot = await temporaryDataDirectory();
    const durableFiles = createRfc64DurableFileStoreV1<'object'>(containmentRoot);
    await expect(durableFiles.putExactBytes({
      relativePath: join('..', 'escaped.jcs'),
      bytes: new TextEncoder().encode('{}'),
      maxBytes: 16,
      label: 'test control object',
      kind: 'object',
    })).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it('publishes immutable keys without clobbering a racing independent writer', async () => {
    const containmentRoot = await temporaryDataDirectory();
    applyRfc64OwnerOnlyPermissionsSyncV1(
      containmentRoot,
      RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
      { entryKind: 'directory' },
    );
    const relativePath = join('race', 'immutable.jcs');
    const firstBytes = new TextEncoder().encode('{"writer":"first"}');
    const secondBytes = new TextEncoder().encode('{"writer":"second"}');
    const durableFiles = createRfc64DurableFileStoreV1<'object'>(containmentRoot);
    const write = (bytes: Uint8Array) => durableFiles.putExactBytes({
      relativePath,
      bytes,
      maxBytes: 1024,
      label: 'racing immutable fixture',
      kind: 'object' as const,
    });

    const outcomes = await Promise.allSettled([
      write(firstBytes),
      write(secondBytes),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'corrupt' },
    });
    const stored = await readFile(join(containmentRoot, relativePath));
    expect([firstBytes, secondBytes].some((bytes) => Buffer.from(bytes).equals(stored))).toBe(true);
  });

  it('coalesces distinct descendants on every newly created shared directory', async () => {
    const containmentRoot = await temporaryDataDirectory();
    applyRfc64OwnerOnlyPermissionsSyncV1(
      containmentRoot,
      RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
      { entryKind: 'directory' },
    );
    const created = deferred();
    const releaseCreated = deferred();
    const joined = deferred();
    const sharedAncestor = join(containmentRoot, 'signatures', 'shared');
    let pauseSharedAncestor = false;
    let paused = false;
    let joinedPath: string | null = null;
    const durableFiles = createRfc64DurableFileStoreForTestV1<'signature'>(
      containmentRoot,
      Object.freeze({
        boundary: async (boundary) => {
          if (pauseSharedAncestor && boundary === 'directory.created' && !paused) {
            paused = true;
            created.resolve();
            await releaseCreated.promise;
          }
        },
        directoryPreparation: (observation) => {
          if (observation.disposition === 'joined') {
            joinedPath = observation.path;
            joined.resolve();
          }
        },
      } satisfies Rfc64DurableFileTestLifecycleV1<'signature'>),
    );
    const put = (relativePath: string, value: string) => durableFiles.putExactBytes({
      relativePath,
      bytes: new TextEncoder().encode(value),
      maxBytes: 64,
      label: 'shared-ancestor signature fixture',
      kind: 'signature',
    });
    await put(join('signatures', 'seed', 'prepared.jcs'), 'seed');
    pauseSharedAncestor = true;

    const firstRelativePath = join('signatures', 'shared', 'object-a', 'variant.jcs');
    const secondRelativePath = join('signatures', 'shared', 'object-b', 'variant.jcs');
    const first = put(firstRelativePath, 'first');
    await created.promise;
    const second = put(secondRelativePath, 'second');
    await joined.promise;

    expect(joinedPath).toBe(sharedAncestor);
    releaseCreated.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(readFile(join(containmentRoot, firstRelativePath), 'utf8'))
      .resolves.toBe('first');
    await expect(readFile(join(containmentRoot, secondRelativePath), 'utf8'))
      .resolves.toBe('second');
  });

  it('rejects an existing durable file larger than the read-side byte ceiling', async () => {
    const containmentRoot = await temporaryDataDirectory();
    applyRfc64OwnerOnlyPermissionsSyncV1(
      containmentRoot,
      RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
      { entryKind: 'directory' },
    );
    const durableFiles = createRfc64DurableFileStoreV1<'object'>(containmentRoot);
    const relativePath = join('bounded', 'oversized.jcs');
    await durableFiles.putExactBytes({
      relativePath,
      bytes: new Uint8Array(17).fill(0x61),
      maxBytes: 32,
      label: 'oversized read fixture',
      kind: 'object',
    });

    await expect(durableFiles.readOptionalBoundedBytes({
      relativePath,
      maxBytes: 16,
      label: 'oversized read fixture',
    })).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('owns exact deletion, containment, mismatch, absence, and parent durability', async () => {
    const containmentRoot = await temporaryDataDirectory();
    applyRfc64OwnerOnlyPermissionsSyncV1(
      containmentRoot,
      RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
      { entryKind: 'directory' },
    );
    const boundaries: string[] = [];
    const durableFiles = createRfc64DurableFileStoreForTestV1<'marker'>(
      containmentRoot,
      Object.freeze({ boundary: (boundary) => { boundaries.push(boundary); } }),
    );
    const expectedBytes = new TextEncoder().encode('expected');
    await durableFiles.putExactBytes({
      relativePath: join('markers', 'one'),
      bytes: expectedBytes,
      maxBytes: 32,
      label: 'deletion fixture',
      kind: 'marker',
    });
    await expect(durableFiles.deleteExactBytes({
      relativePath: join('..', 'escaped'),
      expectedBytes,
      maxBytes: 32,
      label: 'escaped deletion fixture',
      kind: 'marker',
    })).rejects.toMatchObject({ code: 'unsafe-path' });
    await expect(durableFiles.deleteExactBytes({
      relativePath: join('markers', 'one'),
      expectedBytes: new TextEncoder().encode('different'),
      maxBytes: 32,
      label: 'deletion fixture',
      kind: 'marker',
    })).rejects.toMatchObject({ code: 'corrupt' });
    await expect(durableFiles.deleteExactBytes({
      relativePath: join('markers', 'one'),
      expectedBytes,
      maxBytes: 32,
      label: 'deletion fixture',
      kind: 'marker',
    })).resolves.toBe(true);
    expect(boundaries).toEqual(expect.arrayContaining([
      'marker.deleted',
      'marker.delete-parent-fsynced',
    ]));
    await expect(durableFiles.deleteExactBytes({
      relativePath: join('markers', 'one'),
      expectedBytes,
      maxBytes: 32,
      label: 'deletion fixture',
      kind: 'marker',
    })).resolves.toBe(false);
  });

});
