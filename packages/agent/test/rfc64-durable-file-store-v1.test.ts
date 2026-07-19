import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE } from '../src/rfc64/control-object-store-v1.js';
import { createRfc64DurableFileStoreV1 } from '../src/rfc64/durable-file-store-v1.js';
import { applyRfc64OwnerOnlyPermissionsSyncV1 } from '../src/rfc64/secure-filesystem-policy-v1.js';
import {
  createTemporaryDataDirectoryFixture,
} from './support/rfc64-control-object-store-fixtures.js';

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
});
