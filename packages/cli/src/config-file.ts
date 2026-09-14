import { constants } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  resolveAtomicWriteDestination,
  resolveAtomicWriteDestinationSync,
  writeFileAtomic,
} from './fs-utils.js';
import { acquireConfigWriteLease } from './config-write-lease.js';

export interface FileActivation<T> {
  apply(): T | Promise<T>;
  rollback(): void | Promise<void>;
}

export interface ConfigFileWriter {
  /** Includes ordinary writes admitted before the daemon claimed this file. */
  ready: Promise<string | undefined>;
  commit<T>(prepare: () =>
    | { contents: string; activation: FileActivation<T> }
    | { unchanged: T }): Promise<T>;
  close(): Promise<void>;
}

/** Publication recovery failed, so the prior file/runtime pair is not restored. */
class ConfigRecoveryError extends AggregateError {
  override name = 'ConfigRecoveryError';
}

/** Generic atomic publication lane. Live configuration belongs to DkgConfigStore. */
export class ConfigFileStore {
  static readonly #stores = new Map<string, ConfigFileStore>();
  #tail: Promise<unknown> = Promise.resolve();
  #claim?: symbol;
  #latestContents?: string;

  private constructor(readonly path: string) {}

  static open(path: string): ConfigFileStore {
    // Resolve synchronously before enqueueing so aliases share call ordering,
    // including an ordinary save immediately followed by a daemon update.
    const destination = resolveAtomicWriteDestinationSync(path);
    let store = this.#stores.get(destination);
    if (!store) {
      store = new ConfigFileStore(destination);
      this.#stores.set(destination, store);
    }
    return store;
  }

  /** Fence new raw writes immediately, then drain already-admitted writes. */
  claim(): ConfigFileWriter {
    if (this.#claim) throw new Error('Configuration file already has a live owner');
    const claim = Symbol();
    this.#claim = claim;
    const lease = this.#serialize(() => acquireConfigWriteLease(this.path));
    // Opening failures leave the process-local lane available for a retry.
    void lease.catch(() => { if (this.#claim === claim) this.#claim = undefined; });
    let closing: Promise<void> | undefined;
    let unreconciled: Error | undefined;
    return {
      ready: lease.then(() => this.#latestContents),
      commit: prepare => closing ? Promise.reject(new Error('Configuration owner is closed')) : this.#serialize(async () => {
        await lease;
        // Check inside the lane: even updates queued before the failed rollback
        // must not prepare a candidate from the now-unreliable runtime snapshot.
        if (unreconciled) throw unreconciled;
        const transaction = prepare();
        if ('unchanged' in transaction) return transaction.unchanged;
        const { contents, activation } = transaction;
        try {
          return await this.#publishTransaction(contents, activation);
        } catch (error) {
          if (error instanceof ConfigRecoveryError) {
            unreconciled = new Error('Configuration owner is unreconciled after failed rollback; restart the daemon before changing settings', { cause: error });
          }
          throw error;
        }
      }),
      close: () => {
        closing ??= this.#serialize(async () => {
          const owned = await lease.catch(() => undefined);
          owned?.release();
          if (this.#claim === claim) {
            this.#claim = undefined;
            this.#latestContents = undefined;
          }
        });
        return closing;
      },
    };
  }

  write(contents: string): Promise<void> {
    if (this.#claim) return Promise.reject(new Error('Live daemon configuration must be updated through DkgConfigStore.update with explicit activation'));
    return this.#serialize(async () => {
      const lease = await acquireConfigWriteLease(this.path);
      try {
        await writeFileAtomic(this.path, contents, { writeOptions: { flag: 'wx', mode: 0o600 } });
        this.#latestContents = contents;
      } finally { lease.release(); }
    });
  }

  transaction<T>(contents: string, activation: FileActivation<T>): Promise<T> {
    if (this.#claim) return Promise.reject(new Error('Live daemon configuration must be updated through DkgConfigStore.update with explicit activation'));
    return this.#serialize(async () => {
      const lease = await acquireConfigWriteLease(this.path);
      try { return await this.#publishTransaction(contents, activation); }
      finally { lease.release(); }
    });
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
          throw new ConfigRecoveryError([error, ...rollbackErrors],
            `Runtime activation failed and configuration rollback failed${preserveBackup && backup ? `; previous configuration retained at ${backup}` : ''}`);
        }
        throw error;
      }
    } finally {
      if (backup && !preserveBackup) await unlink(backup).catch(() => undefined);
    }
  }
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
