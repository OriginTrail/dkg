import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  applyRfc64OwnerOnlyPermissionsSyncV1,
  assertRfc64FilesystemOwnerSyncV1,
  fsyncRfc64DirectorySyncV1,
  rfc64RegularFileFsyncOpenFlagsV1,
  RFC64_SECURE_FILE_MODE_V1,
} from '../rfc64/secure-filesystem-policy-v1.js';
export {
  loadOwnedSqliteModuleV1,
  type OwnedSqliteModuleV1,
} from './module-loader-v1.js';

export const OWNED_SQLITE_FILE_SUFFIXES_V1 = ['', '-journal', '-wal', '-shm'] as const;

export function ownedSqlitePathEntryExistsV1(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Refuse symlinks, foreign owners, and sidecars without a main database before
 * SQLite can recover or create anything through those paths.
 */
export function secureOwnedSqliteFileSetV1(
  databasePath: string,
  feature: string,
): { mainExists: boolean } {
  const mainExists = ownedSqlitePathEntryExistsV1(databasePath);
  for (const suffix of OWNED_SQLITE_FILE_SUFFIXES_V1) {
    const path = `${databasePath}${suffix}`;
    if (!ownedSqlitePathEntryExistsV1(path)) continue;
    if (!mainExists && suffix !== '') {
      throw new Error(`${feature} has an orphaned SQLite sidecar`);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${feature} owned path must be a regular file`);
    }
    assertRfc64FilesystemOwnerSyncV1(path);
    applyRfc64OwnerOnlyPermissionsSyncV1(
      path,
      RFC64_SECURE_FILE_MODE_V1,
      { entryKind: 'file' },
    );
  }
  return { mainExists };
}

/** Refuse a foreign/ambiguous identity before opening can recover its journal. */
export function assertOwnedSqliteHeaderIdentityV1(
  databasePath: string,
  applicationId: number,
  userVersion: number,
  feature: string,
): void {
  const header = Buffer.alloc(100);
  const descriptor = openSync(databasePath, 'r');
  let bytesRead = 0;
  try {
    bytesRead = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (
    bytesRead !== header.length
    || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0'
  ) {
    throw new Error(`${feature} has an invalid SQLite header`);
  }
  if (
    header.readUInt32BE(68) !== applicationId
    || header.readUInt32BE(60) !== userVersion
  ) {
    throw new Error(`${feature} has a foreign or unsupported database identity`);
  }
}

export function readOwnedSqlitePragmaIntegerV1(
  database: DatabaseSync,
  pragma: string,
  feature: string,
): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${feature} PRAGMA ${pragma} returned an invalid value`);
  }
  return value;
}

export function fsyncOwnedSqliteFileAndDirectoryV1(path: string): void {
  const descriptor = openSync(path, rfc64RegularFileFsyncOpenFlagsV1());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncRfc64DirectorySyncV1(dirname(path));
}
