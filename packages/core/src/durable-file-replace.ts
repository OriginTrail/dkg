import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { hasErrorCode } from './errors.js';

// Windows fails a replacing rename while another handle (an antivirus scan,
// the search indexer) has the target open. Those handles close quickly.
const WINDOWS_RENAME_RETRY_CODES = ['EPERM', 'EACCES', 'EBUSY'];
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 250];

export interface DurableReplaceOptions {
  /** Selects the Windows rename retry and directory-fsync skip; tests override it. */
  platform?: NodeJS.Platform;
}

/**
 * Replace the file at `path` with `content` so that readers, and a restart
 * after a crash, see either the previous complete file or the new one. The
 * content goes to a sibling temp file, which is fsynced and then renamed over
 * the target; the directory is fsynced last so the rename itself survives a
 * power loss.
 *
 * An existing file keeps its permission bits: the temp file starts owner-only
 * and takes the original mode before the rename makes it visible. A file that
 * is not writable is refused, as `writeFile` would refuse it, and a symlinked
 * target is replaced behind its link. A new file gets the same umask-derived
 * mode that `writeFile` would give it.
 */
export async function replaceFileDurably(
  path: string,
  content: string,
  options: DurableReplaceOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const target = await realpath(path).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return path;
    throw error;
  });
  const original = await stat(target).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (original) await access(target, constants.W_OK);

  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', original ? 0o600 : 0o666);
    try {
      await handle.writeFile(content, 'utf-8');
      if (original) await handle.chmod(original.mode & 0o7777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, target, platform);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  // Best effort: the new file is already in place, and a directory that
  // cannot be flushed still holds a complete old or new file after power loss.
  await fsyncDirectory(dirname(target), platform).catch(() => {});
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
 * Whether a directory can be fsynced on `platform`. Node cannot
 * FlushFileBuffers on a Windows directory handle, so a directory fsync is
 * skipped there. This is the one definition of that rule: the atomic replace
 * here and the agent's RFC-64 durable stores both use it.
 */
export function directoryFsyncSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

async function fsyncDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  if (!directoryFsyncSupported(platform)) return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
