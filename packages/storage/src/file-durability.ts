// SPDX-License-Identifier: Apache-2.0
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Only callers maintaining a historical best-effort state file may tolerate these directory refusals. */
export type DirectorySyncPolicy = 'strict' | 'allow-unsupported';
const UNSUPPORTED_DIRECTORY_CODES = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR']);

/** Windows FlushFileBuffers requires GENERIC_WRITE; a read-only handle fails. */
async function syncFile(path: string): Promise<void> {
  const file = await open(path, 'r+');
  try { await file.sync(); } finally { await file.close(); }
}

/** Flush the visible file through a writable handle, then its parent directory. */
export async function persistFileAndParent(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const absolutePath = resolve(path);
  await syncFile(absolutePath);
  const directory = dirname(absolutePath);
  await persistDirectoryRange(directory, directory, platform);
}

export interface DurableDirectoryOptions {
  /** Mode of each directory `create()` makes, filtered by the umask; existing directories keep theirs. */
  readonly mode?: number;
  /** Applies to every directory a barrier syncs. Strict by default. */
  readonly policy?: DirectorySyncPolicy;
  /** Defaults to `process.platform`, read at each barrier. */
  readonly platform?: NodeJS.Platform;
}

/**
 * A directory whose entries must survive a crash. A new directory entry lives in
 * its parent, so a barrier syncs this directory, each directory recursive mkdir
 * created for it, and the first parent that already existed. mkdir reports its
 * first new directory only once: that range stays pending across failed barriers
 * until one persists it, so the owner of a durable path keeps one instance.
 */
export class DurableDirectory {
  readonly path: string;
  private pendingThrough?: string;

  constructor(path: string, private readonly options: DurableDirectoryOptions = {}) {
    this.path = resolve(path);
  }

  async create(): Promise<void> {
    const firstCreated = await mkdir(this.path, { recursive: true, mode: this.options.mode });
    if (firstCreated === undefined) return;
    // Every candidate is an ancestor of this directory; the shorter path is the outer one.
    const through = dirname(resolve(firstCreated));
    if (this.pendingThrough === undefined || through.length < this.pendingThrough.length) this.pendingThrough = through;
  }

  /** Sync this directory, then every directory entry created since the last successful barrier. */
  async persist(): Promise<void> {
    const through = this.pendingThrough;
    await persistDirectoryRange(this.path, through ?? this.path, this.options.platform ?? process.platform, this.options.policy);
    if (this.pendingThrough === through) this.pendingThrough = undefined;
  }

  /** Flush a file in this directory through a writable handle, then persist the directory. */
  async persistFile(file: string): Promise<void> {
    await syncFile(resolve(file));
    await this.persist();
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
