// SPDX-License-Identifier: Apache-2.0
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { durablePathTraversal } from './durable-path-traversal.js';

/** Pin relative paths without collapsing symlink-sensitive dot segments. */
function absoluteTraversalPath(path: string): string {
  if (isAbsolute(path)) return path;
  const root = parse(path).root;
  return `${root ? resolve(root) : process.cwd()}${sep}${path.slice(root.length)}`;
}

/** Windows FlushFileBuffers requires GENERIC_WRITE; a read-only handle fails. */
async function syncFile(path: string): Promise<void> {
  const file = await open(path, 'r+');
  try { await file.sync(); } finally { await file.close(); }
}

/** Flush the visible file through a writable handle, then its parent directory. */
export async function persistFileAndParent(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const absolutePath = absoluteTraversalPath(path);
  await syncFile(absolutePath);
  await persistFileDirectoryEntries(absolutePath, platform);
}

/** The writer already synced its own handle; certify its target name and traversed aliases. */
export async function persistFileDirectoryEntries(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return;
  const traversal = await durablePathTraversal(absoluteTraversalPath(path)), directory = dirname(traversal.resolved);
  await persistResolvedDirectoryRange(directory, traversal.aliasParents.length ? parse(directory).root : directory, traversal.aliasParents);
}

export interface DurableDirectoryOptions {
  /** Mode of each directory `create()` makes, filtered by the umask; existing directories keep theirs. */
  readonly mode?: number;
  /** Defaults to `process.platform`, read at each barrier. */
  readonly platform?: NodeJS.Platform;
}

/**
 * A directory whose entries must survive a crash. A new directory entry lives in
 * its parent, so a barrier syncs this directory, each directory recursive mkdir
 * created for it, and the first parent that already existed. mkdir reports its
 * first new directory only on success. Capture the existing ancestor before
 * creation so partial mkdir failures and failed barriers retain the full range
 * until one persists it. A new owner also certifies existing ancestry through
 * the root, reconstructing obligations lost with its previous worker/process.
 */
export class DurableDirectory {
  readonly path: string;
  private pendingThrough?: string;

  constructor(path: string, private readonly options: DurableDirectoryOptions = {}) {
    this.path = absoluteTraversalPath(path);
    // A replacement owner cannot infer successful parent fsync from existence:
    // the old worker/process may have died after mkdir but before certification.
    // Adopt the complete ancestry once; only a successful barrier clears it.
    this.pendingThrough = parse(this.path).root;
  }

  async create(): Promise<void> {
    let existing = this.path;
    for (;;) {
      try { await stat(existing); break; } catch (error) {
        const parent = dirname(existing);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) throw error;
        existing = parent;
      }
    }
    // mkdir can create some ancestors and then reject without returning firstCreated.
    // Record their parent barrier before any creation, and keep it on every failure.
    if (existing !== this.path) this.retainThrough(existing);
    const firstCreated = await mkdir(this.path, { recursive: true, mode: this.options.mode });
    if (firstCreated !== undefined) this.retainThrough(dirname(firstCreated));
  }

  private retainThrough(through: string): void {
    // Every candidate is an ancestor of this directory; the shorter path is the outer one.
    if (this.pendingThrough === undefined || through.length < this.pendingThrough.length) this.pendingThrough = through;
  }

  /** Sync this directory, then every directory entry created since the last successful barrier. */
  async persist(): Promise<void> {
    const through = this.pendingThrough;
    await persistDirectoryRange(this.path, through ?? this.path, this.options.platform ?? process.platform);
    if (this.pendingThrough === through) this.pendingThrough = undefined;
  }

  /** Flush a file in this directory through a writable handle, then persist the directory. */
  async persistFile(file: string): Promise<void> {
    await syncFile(absoluteTraversalPath(file));
    await this.persist();
  }
}

/** POSIX directory fsync is strict by default; Windows has no supported directory handle through Node's open API. */
export async function persistDirectoryRange(
  directory: string, last: string, platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return;
  const target = await durablePathTraversal(absoluteTraversalPath(directory));
  const through = directory === last ? target : await durablePathTraversal(absoluteTraversalPath(last));
  await persistResolvedDirectoryRange(target.resolved, through.resolved, [...target.aliasParents, ...through.aliasParents]);
}

async function persistResolvedDirectoryRange(directory: string, last: string, aliases: readonly string[]): Promise<void> {
  const synced = new Set<string>();
  const range = async (path: string, through: string) => {
    for (;;) {
      if (!synced.has(path)) {
        const handle = await open(path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
        synced.add(path);
      }
      if (path === through || dirname(path) === path) break;
      path = dirname(path);
    }
  };
  await range(directory, last);
  // An alias's parent may lie outside the target ancestry. New owners cannot
  // infer that its entry or ancestors were persisted by whoever created it.
  for (const alias of aliases) {
    await range(alias, parse(alias).root);
  }
}
