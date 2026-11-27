import { chmod } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE } from '../src/rfc64/control-object-store-v1.js';
import {
  applyRfc64OwnerOnlyPermissionsSyncV1,
  applyRfc64OwnerOnlyPermissionsV1,
  assertRfc64FilesystemOwnerSyncV1,
  assertRfc64FilesystemOwnerV1,
  assertRfc64OwnerOnlyPermissionsSyncV1,
  assertRfc64OwnerOnlyPermissionsV1,
} from '../src/rfc64/secure-filesystem-policy-v1.js';
import {
  createTemporaryDataDirectoryFixture,
} from './support/rfc64-control-object-store-fixtures.js';

const temporaryDirectories = createTemporaryDataDirectoryFixture();
const { temporaryDataDirectory } = temporaryDirectories;

afterEach(async () => {
  await temporaryDirectories.cleanup();
});

describe('RFC-64 secure filesystem policy v1', () => {
  it('keeps synchronous inventory and asynchronous durable policy twins aligned', async () => {
    const dataDir = await temporaryDataDirectory();
    const policy = { entryKind: 'directory' as const };
    applyRfc64OwnerOnlyPermissionsSyncV1(
      dataDir,
      RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
      policy,
    );

    expect(() => assertRfc64FilesystemOwnerSyncV1(dataDir)).not.toThrow();
    await expect(assertRfc64FilesystemOwnerV1(dataDir)).resolves.toBeUndefined();
    expect(() => assertRfc64OwnerOnlyPermissionsSyncV1(
      dataDir,
      RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
      policy,
    )).not.toThrow();
    await expect(assertRfc64OwnerOnlyPermissionsV1(
      dataDir,
      RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
      policy,
    )).resolves.toBeUndefined();
    await expect(applyRfc64OwnerOnlyPermissionsV1(
      dataDir,
      RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
      policy,
    )).resolves.toBeUndefined();

    if (process.platform !== 'win32') {
      await chmod(dataDir, 0o755);
      expect(() => assertRfc64OwnerOnlyPermissionsSyncV1(
        dataDir,
        RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
        policy,
      )).toThrow(/path mode 755/);
      await expect(assertRfc64OwnerOnlyPermissionsV1(
        dataDir,
        RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE,
        policy,
      )).rejects.toThrow(/path mode 755/);
    }
  });
});
