import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, open, readlink, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { hasErrorCode } from '@origintrail-official/dkg-core';

// Windows fails a replacing rename while another handle (an antivirus scan,
// the search indexer) has the target open. Those handles close quickly.
const WINDOWS_RENAME_RETRY_CODES = ['EPERM', 'EACCES', 'EBUSY'];
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 250];
/** Links followed to a missing file before giving up, as Linux's own limit. */
const MAX_SYMLINK_HOPS = 40;

/**
 * How new content reached the file: renamed into place, which a crash cannot
 * leave half done, or rewritten in place, which keeps an owner this process
 * could not give a new file, but which a crash can leave incomplete.
 */
export type ReplaceStrategy = 'rename' | 'in-place';

export interface DurableReplaceOptions {
  /** Selects the Windows rename retry and directory-fsync skip; tests override it. */
  platform?: NodeJS.Platform;
  /**
   * Runs `publish`, the step that makes the new content visible (the rename,
   * or the in-place rewrite), once that content is on disk. A lock holder
   * passes one that runs it only while it still holds the lock; if it throws
   * without running it, the file is left as it was.
   */
  commit?: (publish: () => Promise<void>) => Promise<void>;
  /** Permission bits for the file, in place of the original's (or, for a new file, the umask default). */
  mode?: number;
}

/**
 * Replace the file at `path` with `content` so that readers, and a restart
 * after a crash, see either the previous complete file or the new one. The
 * content goes to a sibling temp file, which is fsynced and then renamed over
 * the target; the directory is fsynced last so the rename itself survives a
 * power loss.
 *
 * The replacement keeps the file's owner, group and permission bits (or takes
 * `mode`): the temp file starts owner-only and takes them before the rename
 * makes it visible.
 * An ACL the directory passes on applies to it as to any new file, but one set
 * on the file itself cannot be read from Node and is not carried over. When
 * this process may not give the temp file the original's owner or group (it
 * belongs to another user), the file is rewritten in place instead, keeping
 * its owner and ACL at the cost of the crash guarantee. The strategy used is
 * returned, so a caller can tell when that guarantee did not apply.
 *
 * A file that is not writable is refused, as `writeFile` would refuse it. A
 * symlink is followed as `writeFile` follows it: the file behind it is
 * replaced, or created when the link points at a file that does not exist
 * yet, and the link stays. A new file gets the same umask-derived mode that
 * `writeFile` would give it.
 */
export async function replaceFileDurably(
  path: string,
  content: string,
  options: DurableReplaceOptions = {},
): Promise<ReplaceStrategy> {
  const target = await resolveWriteTarget(path);
  const original = await stat(target).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (original) await access(target, constants.W_OK);
  if (await replaceByRename(target, content, original, options)) return 'rename';
  await rewriteInPlace(target, content, options);
  return 'in-place';
}

/**
 * The file a write to `path` lands in, with every symlink resolved. `realpath`
 * fails for a link whose target is missing, so such links are followed one at
 * a time, each relative one from the directory the link really sits in.
 */
async function resolveWriteTarget(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; ; hops += 1) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
    let directory: string;
    try {
      directory = await realpath(dirname(current));
    } catch (error) {
      // Without its directory the write fails with ENOENT, as writeFile would.
      if (hasErrorCode(error, 'ENOENT')) return current;
      throw error;
    }
    const entry = join(directory, basename(current));
    let link: string;
    try {
      link = await readlink(entry);
    } catch (error) {
      // Nothing there (ENOENT) or not a link (EINVAL): the write creates the file here.
      if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'EINVAL')) return entry;
      throw error;
    }
    if (hops >= MAX_SYMLINK_HOPS) {
      throw Object.assign(new Error(`ELOOP: too many symbolic links, resolving '${path}'`), { code: 'ELOOP' });
    }
    current = resolvePath(directory, link);
  }
}

/**
 * Write the content to a temp file with the original's owner, group and mode,
 * and rename it over the target. Returns false, having changed nothing, when
 * the temp file cannot be given the original's owner and group.
 */
async function replaceByRename(
  target: string,
  content: string,
  original: Stats | undefined,
  options: DurableReplaceOptions,
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const directory = dirname(target);
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const mode = options.mode ?? (original ? original.mode & 0o7777 : undefined);
  let renamed = false;
  try {
    const handle = await open(temporary, 'wx', mode === undefined ? 0o666 : 0o600);
    try {
      if (original && !await takeOwnership(handle, original)) return false;
      await handle.writeFile(content, 'utf-8');
      // After the chown, which can clear set-id bits.
      if (mode !== undefined) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await commit(options, async () => {
      await renameWithRetry(temporary, target, platform);
      renamed = true;
    });
  } finally {
    if (!renamed) await unlink(temporary).catch(() => {});
  }
  // Best effort: the new file is already in place, and a directory that
  // cannot be flushed still holds a complete old or new file after power loss.
  await fsyncDirectory(directory, platform).catch(() => {});
  return true;
}

/**
 * Give the temp file the original's owner and group. A new file belongs to
 * this process's user and to its group or the directory's, so the two differ
 * when, for example, a root daemon writes an operator's config. False when
 * this process may not make the change.
 */
async function takeOwnership(handle: FileHandle, original: Stats): Promise<boolean> {
  const created = await handle.stat();
  if (created.uid === original.uid && created.gid === original.gid) return true;
  try {
    await handle.chown(original.uid, original.gid);
    return true;
  } catch (error) {
    // EINVAL: an owner that does not exist in this user namespace.
    if (hasErrorCode(error, 'EPERM') || hasErrorCode(error, 'EINVAL')) return false;
    throw error;
  }
}

/**
 * Overwrite the file itself, keeping everything the replacement could not:
 * its owner, group and ACL. A crash part-way through can leave it incomplete,
 * so this is only for a file whose owner the replacement could not keep.
 */
async function rewriteInPlace(target: string, content: string, options: DurableReplaceOptions): Promise<void> {
  const handle = await open(target, 'r+');
  try {
    await commit(options, async () => {
      if (options.mode !== undefined) await handle.chmod(options.mode);
      await handle.truncate(0);
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    });
  } finally {
    await handle.close();
  }
}

async function commit(options: DurableReplaceOptions, publish: () => Promise<void>): Promise<void> {
  await (options.commit ? options.commit(publish) : publish());
}

async function renameWithRetry(from: string, to: string, platform: NodeJS.Platform): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const delayMs = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      const transient = platform === 'win32'
        && WINDOWS_RENAME_RETRY_CODES.some((code) => hasErrorCode(error, code));
      if (!transient || delayMs === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Same policy as the agent's RFC-64 `fsyncRfc64DirectoryV1`, which that
 * package keeps internal: Windows cannot flush a directory handle.
 */
async function fsyncDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
