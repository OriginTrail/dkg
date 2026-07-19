import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
} from 'node:fs';
import { open } from 'node:fs/promises';

export const RFC64_SECURE_DIRECTORY_MODE_V1 = 0o700;
export const RFC64_SECURE_FILE_MODE_V1 = 0o600;
export const RFC64_POSIX_NAMESPACE_DURABILITY_V1 =
  'posix-atomic-rename-directory-fsync-v1' as const;
export const RFC64_WINDOWS_NAMESPACE_DURABILITY_V1 =
  'windows-file-flush-atomic-rename-v1' as const;

export type Rfc64NamespaceDurabilityV1 =
  | typeof RFC64_POSIX_NAMESPACE_DURABILITY_V1
  | typeof RFC64_WINDOWS_NAMESPACE_DURABILITY_V1;

export function rfc64UsesWindowsFilesystemPolicyV1(): boolean {
  return process.platform === 'win32';
}

export function rfc64NamespaceDurabilityV1(): Rfc64NamespaceDurabilityV1 {
  return rfc64UsesWindowsFilesystemPolicyV1()
    ? RFC64_WINDOWS_NAMESPACE_DURABILITY_V1
    : RFC64_POSIX_NAMESPACE_DURABILITY_V1;
}

export function rfc64CurrentUserOwnsUidV1(uid: number): boolean {
  if (rfc64UsesWindowsFilesystemPolicyV1()) return true;
  const processUid = process.getuid?.();
  return processUid === undefined || uid === processUid;
}

export function rfc64PosixModeMatchesV1(mode: number, expected: number): boolean {
  return rfc64UsesWindowsFilesystemPolicyV1() || (mode & 0o777) === expected;
}

/** Node cannot FlushFileBuffers on a Windows directory handle. */
export async function fsyncRfc64DirectoryV1(path: string): Promise<void> {
  if (rfc64UsesWindowsFilesystemPolicyV1()) return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new Error('RFC-64 directory fsync target is not a directory');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Synchronous twin used by the SQLite inventory lifecycle. */
export function fsyncRfc64DirectorySyncV1(path: string): void {
  if (rfc64UsesWindowsFilesystemPolicyV1()) return;
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** FlushFileBuffers requires a write-capable Windows handle. */
export function rfc64RegularFileFsyncOpenFlagsV1(): string | number {
  return rfc64UsesWindowsFilesystemPolicyV1()
    ? 'r+'
    : constants.O_RDONLY | constants.O_NOFOLLOW;
}

export function rfc64RegularFileReadOpenFlagsV1(): number {
  return constants.O_RDONLY
    | (rfc64UsesWindowsFilesystemPolicyV1() ? 0 : constants.O_NOFOLLOW);
}
