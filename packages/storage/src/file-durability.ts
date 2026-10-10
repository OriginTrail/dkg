// SPDX-License-Identifier: Apache-2.0
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Only callers maintaining a historical best-effort state file may tolerate these directory refusals. */
export type DirectorySyncPolicy = 'strict' | 'allow-unsupported';
const UNSUPPORTED_DIRECTORY_CODES = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR']);

/**
 * Flush the visible file through a writable handle, then its parent directory and,
 * when `through` names an ancestor, every directory up to and including it.
 */
export async function persistFileAndParent(
  path: string, platform: NodeJS.Platform = process.platform, through?: string,
): Promise<void> {
  const absolutePath = resolve(path);
  // Windows FlushFileBuffers requires GENERIC_WRITE; a read-only handle fails.
  const file = await open(absolutePath, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  const directory = dirname(absolutePath);
  await persistDirectoryRange(directory, through === undefined ? directory : resolve(through), platform);
}

/**
 * The directory of a file that is rewritten in place. A new directory entry lives
 * in its parent, so a barrier must sync each directory recursive mkdir created and
 * the first parent that already existed. mkdir reports its first new directory only
 * once: that range stays pending across failed barriers until one persists it.
 */
export class DurableFileDirectory {
  private readonly directory: string;
  private pendingThrough?: string;

  constructor(file: string) { this.directory = dirname(resolve(file)); }

  async create(): Promise<void> {
    const firstCreated = await mkdir(this.directory, { recursive: true });
    if (firstCreated === undefined) return;
    // Every candidate is an ancestor of this directory; the shorter path is the outer one.
    const through = dirname(resolve(firstCreated));
    if (this.pendingThrough === undefined || through.length < this.pendingThrough.length) this.pendingThrough = through;
  }

  /** Flush `file` inside this directory, then every directory entry created since the last success. */
  async persist(file: string, platform: NodeJS.Platform = process.platform): Promise<void> {
    const through = this.pendingThrough;
    await persistFileAndParent(file, platform, through);
    if (this.pendingThrough === through) this.pendingThrough = undefined;
  }
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
