import { closeSync, existsSync, fchmodSync, fchownSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export type RegistrationEdit = { kind: 'upsert' } | { kind: 'remove' };

/** Replace a complete client config without exposing a truncated file to readers. */
export function writeMcpConfigAtomic(configPath: string, content: string): void {
  // lstat also sees dangling links. Resolving one fails before any write,
  // preserving the user's link instead of renaming a regular file over it.
  const destination = lstatSync(configPath, { throwIfNoEntry: false }) ? realpathSync(configPath) : configPath;
  const original = existsSync(destination) ? statSync(destination) : undefined;
  const mode = original ? original.mode & 0o7777 : 0o600;
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    // Hold the new inode open while its existing access metadata is copied.
    // The descriptor stays writable even if the target ACL/owner forbids reopening it.
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      if (original && process.platform !== 'win32') {
        // Node copyFile does not preserve Unix ACLs. Native cp preserves the
        // same-directory target's ACL/attributes as well as its ownership/mode.
        const args = process.platform === 'linux'
          ? ['--preserve=mode,ownership,xattr', destination, temporary]
          : ['-p', destination, temporary];
        execFileSync('cp', args, { stdio: 'pipe' });
        const copied = fstatSync(fd);
        // BSD cp may silently fail to retain UID/GID: verify and repair before publishing.
        if (copied.uid !== original.uid || copied.gid !== original.gid) {
          fchownSync(fd, original.uid, original.gid);
        }
        const owned = fstatSync(fd);
        if (owned.uid !== original.uid || owned.gid !== original.gid) {
          throw new Error(`Cannot preserve MCP config ownership: ${configPath}`);
        }
      }
      ftruncateSync(fd, 0);
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
