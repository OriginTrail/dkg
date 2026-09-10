import { constants } from 'node:fs';
import { copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const saves = new Map<string, Promise<void>>();

/** Publish complete configuration before synchronous runtime activation. */
export function writeConfigFile(
  path: string,
  contents: string,
  activate?: () => undefined,
): Promise<void> {
  const previous = saves.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const staged = `${path}.${randomUUID()}.tmp`;
    let backup: string | undefined;
    let preserveBackup = false;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(staged, contents, { flag: 'wx', mode: 0o600 });
      if (activate) {
        const candidate = `${path}.${randomUUID()}.rollback`;
        try {
          await copyFile(path, candidate, constants.COPYFILE_EXCL);
          backup = candidate;
        } catch (error) {
          await unlink(candidate).catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await rename(staged, path);
      try {
        activate?.();
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
      await unlink(staged).catch(() => undefined);
      if (backup && !preserveBackup) await unlink(backup).catch(() => undefined);
    }
  });
  saves.set(path, operation);
  return operation.finally(() => {
    if (saves.get(path) === operation) saves.delete(path);
  });
}
