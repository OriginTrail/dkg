// SPDX-License-Identifier: Apache-2.0
import { persistDirectoryRange, type DirectorySyncPolicy } from '@origintrail-official/dkg-storage';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface DurableFileReplacePermissions {
  /** Creation modes are filtered by the process umask; existing directories keep their mode. */
  readonly fileMode: number;
  readonly directoryMode: number;
  /** Strict by default; only historical source-worker state opts into unsupported-directory tolerance. */
  readonly directorySyncPolicy?: DirectorySyncPolicy;
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
    await persistDirectoryRange(directory, directory, process.platform, permissions.directorySyncPolicy);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
