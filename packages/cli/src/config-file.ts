import { constants } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './fs-utils.js';

const saves = new Map<string, Promise<void>>();

function serializeConfigFileOperation(
  path: string,
  run: () => Promise<void>,
): Promise<void> {
  const previous = saves.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(run);
  saves.set(path, operation);
  return operation.finally(() => {
    if (saves.get(path) === operation) saves.delete(path);
  });
}

/** Snapshot mutable configuration after prior queued settings have activated. */
export function writeConfigFile(path: string, serialize: () => string): Promise<void> {
  return serializeConfigFileOperation(path, async () => {
    const contents = serialize();
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, contents, { writeOptions: { flag: 'wx', mode: 0o600 } });
  });
}

/**
 * Publish a settings candidate, activate it synchronously, and restore the
 * previous file if activation rejects the candidate.
 */
export function writeConfigSettingsTransaction(
  path: string,
  contents: string,
  activate: () => undefined,
): Promise<void> {
  return serializeConfigFileOperation(path, async () => {
    let backup: string | undefined;
    let preserveBackup = false;
    try {
      await mkdir(dirname(path), { recursive: true });
      const candidate = `${path}.${randomUUID()}.rollback`;
      try {
        await copyFile(path, candidate, constants.COPYFILE_EXCL);
        backup = candidate;
      } catch (error) {
        await unlink(candidate).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeFileAtomic(path, contents, { writeOptions: { flag: 'wx', mode: 0o600 } });
      try {
        activate();
      } catch (error) {
        try {
          if (backup) await rename(backup, path);
          else await unlink(path);
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
  });
}
