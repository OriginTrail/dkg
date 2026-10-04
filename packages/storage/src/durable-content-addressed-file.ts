// SPDX-License-Identifier: Apache-2.0
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** One preparation task owns creation and its full ancestry barrier for every blob. */
export class DurableDirectoryPreparation {
  private readonly directory: string;
  private creation?: { firstCreated: string | undefined };
  private ready?: Promise<void>;

  constructor(directory: string, private readonly platform: NodeJS.Platform = process.platform) {
    this.directory = resolve(directory);
  }

  prepare(): Promise<void> {
    this.ready ??= this.createAndPersist().catch(error => {
      // mkdir may already have succeeded. Keep that original ancestry plan:
      // retrying mkdir would report an existing directory and lose the plan.
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async createAndPersist(): Promise<void> {
    this.creation ??= { firstCreated: await mkdir(this.directory, { recursive: true }) };
    const last = this.creation.firstCreated === undefined
      ? this.directory : dirname(resolve(this.creation.firstCreated));
    await persistDirectoryRange(this.directory, last, this.platform);
  }
}

/** Sync verified immutable bytes and their containing directory before acknowledging their RDF reference. */
export async function persistContentAddressedFile(
  path: string, platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const absolutePath = resolve(path);
  const file = await open(absolutePath, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  const directory = dirname(absolutePath);
  await persistDirectoryRange(directory, directory, platform);
}

async function persistDirectoryRange(directory: string, last: string, platform: NodeJS.Platform): Promise<void> {
  // Windows exposes file FlushFileBuffers but cannot open directories this way.
  if (platform === 'win32') return;
  for (;; directory = dirname(directory)) {
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (directory === last || dirname(directory) === directory) break;
  }
}
