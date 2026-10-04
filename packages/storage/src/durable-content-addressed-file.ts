// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { persistDirectoryRange, persistFileAndParent } from './file-durability.js';

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
  await persistFileAndParent(path, platform);
}
