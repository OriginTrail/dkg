// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Only callers maintaining a historical best-effort state file may tolerate these directory refusals. */
export type DirectorySyncPolicy = 'strict' | 'allow-unsupported';
const UNSUPPORTED_DIRECTORY_CODES = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR']);

/** Flush the visible file through a writable handle, then its supported parent-directory barrier. */
export async function persistFileAndParent(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const absolutePath = resolve(path);
  // Windows FlushFileBuffers requires GENERIC_WRITE; a read-only handle fails.
  const file = await open(absolutePath, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  const directory = dirname(absolutePath);
  await persistDirectoryRange(directory, directory, platform);
}

/** POSIX directory fsync is strict by default; Windows has no supported directory handle through Node's open API. */
export async function persistDirectoryRange(
  directory: string, last: string, platform: NodeJS.Platform = process.platform, policy: DirectorySyncPolicy = 'strict',
): Promise<void> {
  if (platform === 'win32') return;
  for (;; directory = dirname(directory)) {
    try {
      const handle = await open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if (policy !== 'allow-unsupported' || !UNSUPPORTED_DIRECTORY_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (directory === last || dirname(directory) === directory) break;
  }
}
