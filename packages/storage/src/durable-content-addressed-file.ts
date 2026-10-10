// SPDX-License-Identifier: Apache-2.0
import { DurableDirectory } from './file-durability.js';

/** One preparation task owns creation and its full ancestry barrier for every blob. */
export class DurableDirectoryPreparation {
  private readonly directory: DurableDirectory;
  private created = false;
  private ready?: Promise<void>;

  constructor(directory: string, platform: NodeJS.Platform = process.platform) {
    this.directory = new DurableDirectory(directory, { platform });
  }

  prepare(): Promise<void> {
    this.ready ??= this.createAndPersist().catch(error => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async createAndPersist(): Promise<void> {
    // mkdir may already have succeeded; its ancestry stays pending in the directory
    // until a barrier persists it, so a retry runs only the barrier.
    if (!this.created) {
      await this.directory.create();
      this.created = true;
    }
    await this.directory.persist();
  }
}
