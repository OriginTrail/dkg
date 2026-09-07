import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export type RegistrationEdit = { kind: 'upsert' } | { kind: 'remove' };

/** Replace a complete client config without exposing a truncated file to readers. */
export function writeMcpConfigAtomic(configPath: string, content: string): void {
  // lstat also sees dangling links. Resolving one fails before any write,
  // preserving the user's link instead of renaming a regular file over it.
  const destination = lstatSync(configPath, { throwIfNoEntry: false }) ? realpathSync(configPath) : configPath;
  const mode = existsSync(destination) ? statSync(destination).mode & 0o777 : 0o600;
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, 'wx', mode);
    try {
      writeFileSync(fd, content, 'utf8');
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}
