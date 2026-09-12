import { constants, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAtomicWriteDestination, writeFileAtomic } from './fs-utils.js';

export interface FileActivation<T> {
  apply(): T | Promise<T>;
  rollback(): void | Promise<void>;
}

export interface ConfigFileWriter {
  /** Includes ordinary writes admitted before the daemon claimed this file. */
  ready: Promise<string | undefined>;
  commit<T>(prepare: () => { contents: string; activation: FileActivation<T> }): Promise<T>;
}

/** Generic atomic publication lane. Live configuration belongs to DkgConfigStore. */
export class ConfigFileStore {
  static readonly #stores = new Map<string, ConfigFileStore>();
  #tail: Promise<unknown> = Promise.resolve();
  #claimed = false;
  #latestContents?: string;

  private constructor(readonly path: string) {}

  static open(path: string): ConfigFileStore {
    // Resolve synchronously before enqueueing so aliases share call ordering,
    // including an ordinary save immediately followed by a daemon update.
    const destination = resolvedConfigDestination(path);
    let store = this.#stores.get(destination);
    if (!store) {
      store = new ConfigFileStore(destination);
      this.#stores.set(destination, store);
    }
    return store;
  }

  /** Fence new raw writes immediately, then drain already-admitted writes. */
  claim(): ConfigFileWriter {
    if (this.#claimed) throw new Error('Configuration file already has a live owner');
    this.#claimed = true;
    return {
      ready: this.#tail.catch(() => undefined).then(() => this.#latestContents),
      commit: prepare => this.#serialize(async () => {
        const { contents, activation } = prepare();
        return this.#publishTransaction(contents, activation);
      }),
    };
  }

  write(contents: string): Promise<void> {
    if (this.#claimed) return Promise.reject(new Error('Live daemon configuration must be updated through DkgConfigStore.update with explicit activation'));
    return this.#serialize(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFileAtomic(this.path, contents, { writeOptions: { flag: 'wx', mode: 0o600 } });
      this.#latestContents = contents;
    });
  }

  transaction<T>(contents: string, activation: FileActivation<T>): Promise<T> {
    if (this.#claimed) return Promise.reject(new Error('Live daemon configuration must be updated through DkgConfigStore.update with explicit activation'));
    return this.#serialize(() => this.#publishTransaction(contents, activation));
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.#tail.catch(() => undefined).then(run);
    this.#tail = operation;
    return operation;
  }

  async #publishTransaction<T>(contents: string, activation: FileActivation<T>): Promise<T> {
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
        const result = await activation.apply();
        this.#latestContents = contents;
        return result;
      } catch (error) {
        // Compensation and file restoration are independent: attempt both even
        // when one fails, and retain every failure plus the recovery-copy path.
        const rollbackErrors: unknown[] = [];
        try { await activation.rollback(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        try {
          if (backup) await rename(backup, destination);
          else await unlink(destination);
        } catch (rollbackError) {
          preserveBackup = true;
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length) {
          throw new AggregateError([error, ...rollbackErrors],
            `Runtime activation failed and configuration rollback failed${preserveBackup && backup ? `; previous configuration retained at ${backup}` : ''}`);
        }
        throw error;
      }
    } finally {
      if (backup && !preserveBackup) await unlink(backup).catch(() => undefined);
    }
  }
}

/** Canonicalize file and parent-directory aliases, including not-yet-created targets. */
function resolvedConfigDestination(path: string, followedLinks = 0): string {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    if (lstatSync(absolute).isSymbolicLink()) {
      if (followedLinks >= 40) throw Object.assign(new Error(`Too many symbolic links resolving ${path}`), { code: 'ELOOP' });
      return resolvedConfigDestination(resolve(dirname(absolute), readlinkSync(absolute)), followedLinks + 1);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return resolve(resolvedConfigDestination(parent, followedLinks), basename(absolute));
}

export function configFileStore(path: string): ConfigFileStore {
  return ConfigFileStore.open(path);
}

/** Persist one immutable, call-time configuration snapshot. */
export async function writeConfigFile(path: string, contents: string): Promise<void> {
  return configFileStore(path).write(contents);
}

/**
 * Publish a candidate, then apply its prepared runtime change. On failure,
 * compensate runtime state and restore the previous file before releasing the lane.
 */
export async function writeConfigSettingsTransaction<T>(
  path: string,
  contents: string,
  activation: FileActivation<T>,
): Promise<T> {
  return configFileStore(path).transaction(contents, activation);
}
