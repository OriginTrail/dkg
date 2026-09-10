import { constants } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAtomicWriteDestination, writeFileAtomic } from './fs-utils.js';

export interface ConfigFileTransition<T> {
  readonly contents: string;
  readonly activate: () => T;
}

export type ConfigFileTransitionPreparation<T> =
  () => ConfigFileTransition<T> | Promise<ConfigFileTransition<T>>;

/** One explicit serialization and publication owner for a configuration path. */
export class ConfigFileStore {
  #tail: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  write(contents: string): Promise<void> {
    return this.#serialize(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFileAtomic(this.path, contents, { writeOptions: { flag: 'wx', mode: 0o600 } });
    });
  }

  transaction<T>(contents: string, activate: () => T): Promise<T> {
    return this.#serialize(() => this.#publishTransaction(contents, activate));
  }

  /** Prepare an ordered state transition from the latest committed owner state. */
  transition<T>(prepare: ConfigFileTransitionPreparation<T>): Promise<T> {
    return this.#serialize(async () => {
      const transition = await prepare();
      return this.#publishTransaction(transition.contents, transition.activate);
    });
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.#tail.catch(() => undefined).then(run);
    this.#tail = operation;
    return operation;
  }

  async #publishTransaction<T>(contents: string, activate: () => T): Promise<T> {
    const destination = await resolveAtomicWriteDestination(this.path);
    let backup: string | undefined;
    let preserveBackup = false;
    try {
      await mkdir(dirname(destination), { recursive: true });
      const candidate = `${destination}.${randomUUID()}.rollback`;
      try {
        await copyFile(destination, candidate, constants.COPYFILE_EXCL);
        backup = candidate;
      } catch (error) {
        await unlink(candidate).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeFileAtomic(destination, contents, { writeOptions: { flag: 'wx', mode: 0o600 } });
      try {
        return activate();
      } catch (error) {
        try {
          if (backup) await rename(backup, destination);
          else await unlink(destination);
        } catch (rollbackError) {
          preserveBackup = true;
          throw new AggregateError([error, rollbackError],
            `Runtime activation failed and configuration rollback failed${backup ? `; previous configuration retained at ${backup}` : ''}`);
        }
        throw error;
      }
    } finally {
      if (backup && !preserveBackup) await unlink(backup).catch(() => undefined);
    }
  }
}

const stores = new Map<string, ConfigFileStore>();

export function configFileStore(path: string): ConfigFileStore {
  let store = stores.get(path);
  if (!store) {
    store = new ConfigFileStore(path);
    stores.set(path, store);
  }
  return store;
}

/** Persist one immutable, call-time configuration snapshot. */
export function writeConfigFile(path: string, contents: string): Promise<void> {
  return configFileStore(path).write(contents);
}

/**
 * Publish a settings candidate, activate it synchronously, and restore the
 * previous file if activation rejects the candidate.
 */
export function writeConfigSettingsTransaction<T>(
  path: string,
  contents: string,
  activate: () => T,
): Promise<T> {
  return configFileStore(path).transaction(contents, activate);
}
