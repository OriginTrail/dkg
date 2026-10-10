// SPDX-License-Identifier: Apache-2.0
import { DurableDirectory, type DirectorySyncPolicy } from '@origintrail-official/dkg-storage';
import { randomUUID } from 'node:crypto';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface DurableFileReplacePermissions {
  /** Creation modes are filtered by the process umask; existing directories keep their mode. */
  readonly fileMode: number;
  readonly directoryMode: number;
  /** Strict by default; only historical source-worker state opts into unsupported-directory tolerance. */
  readonly directorySyncPolicy?: DirectorySyncPolicy;
}

/**
 * Same-directory replacement: fsync bytes, rename, then sync the directory and every
 * directory entry created for it. One long-lived instance keeps a created ancestry
 * pending across failed barriers, although mkdir reports it only once.
 */
export class DurableReplaceableFile {
  private readonly directory: DurableDirectory;

  constructor(private readonly path: string, private readonly permissions: DurableFileReplacePermissions) {
    this.directory = new DurableDirectory(dirname(path), { mode: permissions.directoryMode, policy: permissions.directorySyncPolicy });
  }

  async replace(contents: string): Promise<void> {
    await this.directory.create();
    const temporary = join(this.directory.path, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    let file: FileHandle | undefined;
    try {
      file = await open(temporary, 'wx', this.permissions.fileMode);
      await file.writeFile(contents, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, this.path);
      await this.directory.persist();
    } catch (error) {
      await file?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** One-shot replacement; it persists the ancestry this call creates. */
export async function replaceDurableFile(path: string, contents: string, permissions: DurableFileReplacePermissions): Promise<void> {
  await new DurableReplaceableFile(path, permissions).replace(contents);
}
