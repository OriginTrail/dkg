import { closeSync, existsSync, fchmodSync, fsyncSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** Replace a complete client config without exposing a truncated file to readers. */
export function writeMcpConfigAtomic(configPath: string, content: string): void {
  // Preserve a user's config symlink and replace the file it points to.
  const destination = existsSync(configPath) ? realpathSync(configPath) : configPath;
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
