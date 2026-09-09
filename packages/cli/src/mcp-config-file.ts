import { closeSync, existsSync, fsyncSync, ftruncateSync, lstatSync, openSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { McpConfigPersistenceStrategy } from './mcp-config-metadata.js';

/** Replace a complete client config without exposing a truncated file to readers. */
export function writeMcpConfigAtomic(
  configPath: string,
  content: string,
  persistence: McpConfigPersistenceStrategy,
): void {
  // lstat also sees dangling links. Resolving one fails before any write,
  // preserving the user's link instead of renaming a regular file over it.
  const destination = lstatSync(configPath, { throwIfNoEntry: false }) ? realpathSync(configPath) : configPath;
  const original = existsSync(destination) ? statSync(destination) : undefined;
  const mode = original ? original.mode & 0o7777 : 0o600;
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  const replacement = { configPath, destination, temporary, original, mode };
  // Capability checks belong to the selected strategy and run before the
  // transaction creates a temporary file.
  persistence.preflight(replacement);
  try {
    // Hold the new inode open while its existing access metadata is copied.
    // The descriptor stays writable even if the target ACL/owner forbids reopening it.
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      persistence.prepare({ ...replacement, fd });
      ftruncateSync(fd, 0);
      writeFileSync(fd, content, 'utf8');
      persistence.secure({ ...replacement, fd });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    persistence.publish(replacement);
  } finally {
    rmSync(temporary, { force: true });
  }
}
