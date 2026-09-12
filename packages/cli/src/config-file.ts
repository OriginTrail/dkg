import type { DkgConfig } from './config.js';
import { constants, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAtomicWriteDestination, writeFileAtomic } from './fs-utils.js';
import { immutableConfig, type DkgConfigActivation, type DkgConfigUpdate, type ImmutableDkgConfig } from './config-snapshot.js';

/** One owner of committed configuration state, ordering and atomic publication. */
export class ConfigFileStore {
  static readonly #stores = new Map<string, ConfigFileStore>();
  #tail: Promise<unknown> = Promise.resolve();
  #current?: ImmutableDkgConfig;
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

  initializeConfig(initial: DkgConfig | ImmutableDkgConfig): void {
    this.#current ??= immutableConfig(this.#latestContents === undefined
      ? initial : { ...initial, ...JSON.parse(this.#latestContents) });
  }

  get currentConfig(): ImmutableDkgConfig {
    if (!this.#current) throw new Error('Configuration owner has not been initialized');
    return this.#current;
  }

  /** Rebase a synchronous update; discovery and probes finish before admission. */
  updateConfig(update: DkgConfigUpdate, activate: DkgConfigActivation = () => undefined): Promise<ImmutableDkgConfig> {
    return this.#serialize(async () => {
      const previous = this.currentConfig;
      const next = immutableConfig(update(previous));
      const contents = JSON.stringify(next, null, 2) + '\n';
      return this.#publishTransaction(contents, () => {
        activate(next, previous);
        this.#current = next;
        this.#latestContents = contents;
        return next;
      });
    });
  }

  write(contents: string): Promise<void> {
    return this.#serialize(async () => {
      const next = this.#current ? immutableConfig(JSON.parse(contents)) : undefined;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFileAtomic(this.path, contents, { writeOptions: { flag: 'wx', mode: 0o600 } });
      this.#latestContents = contents;
      if (next) this.#current = next;
    });
  }

  transaction<T>(contents: string, activate: () => T): Promise<T> {
    return this.#serialize(() => {
      const next = this.#current ? immutableConfig(JSON.parse(contents)) : undefined;
      return this.#publishTransaction(contents, () => {
        const result = activate();
        this.#latestContents = contents;
        if (next) this.#current = next;
        return result;
      });
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
 * Publish a settings candidate, activate it synchronously, and restore the
 * previous file if activation rejects the candidate.
 */
export async function writeConfigSettingsTransaction<T>(
  path: string,
  contents: string,
  activate: () => T,
): Promise<T> {
  return configFileStore(path).transaction(contents, activate);
}
