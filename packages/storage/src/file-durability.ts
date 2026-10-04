// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Flush the visible file through a writable handle, then its supported parent-directory barrier. */
export async function persistFileAndParent(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const absolutePath = resolve(path);
  // Windows FlushFileBuffers requires GENERIC_WRITE; a read-only handle fails.
  const file = await open(absolutePath, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  const directory = dirname(absolutePath);
  await persistDirectoryRange(directory, directory, platform);
}

/** POSIX directory fsync is strict; Windows has no supported directory handle through Node's open API. */
export async function persistDirectoryRange(directory: string, last: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return;
  for (;; directory = dirname(directory)) {
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (directory === last || dirname(directory) === directory) break;
  }
}
