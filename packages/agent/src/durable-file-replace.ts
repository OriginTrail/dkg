// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface DurableFileReplacePermissions {
  /** Creation modes are filtered by the process umask; existing directories keep their mode. */
  readonly fileMode: number;
  readonly directoryMode: number;
}

/** Same-directory replacement: fsync bytes, rename, then fsync the parent directory. */
export async function replaceDurableFile(path: string, contents: string, permissions: DurableFileReplacePermissions): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: permissions.directoryMode });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  try {
    file = await open(temporary, 'wx', permissions.fileMode);
    await file.writeFile(contents, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch (error) {
    // These platforms cannot fsync a directory; the replaced file was already fsynced.
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}
