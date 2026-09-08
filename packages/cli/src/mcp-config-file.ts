import { closeSync, existsSync, fchmodSync, fchownSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { McpClientLocation } from './mcp-client-registry.js';
import { linuxMetadataCopyCommand, runMcpConfigPowerShell } from './mcp-config-metadata.js';

/** Replace a complete client config without exposing a truncated file to readers. */
export function writeMcpConfigAtomic(configPath: string, content: string, location: McpClientLocation = 'native'): void {
  const windowsMetadata = process.platform === 'win32' || location === 'windows-wsl';
  // lstat also sees dangling links. Resolving one fails before any write,
  // preserving the user's link instead of renaming a regular file over it.
  const destination = lstatSync(configPath, { throwIfNoEntry: false }) ? realpathSync(configPath) : configPath;
  const original = existsSync(destination) ? statSync(destination) : undefined;
  // Probe before creating a temporary file. BusyBox cp lacks these guarantees.
  const copyCommand = original && !windowsMetadata && process.platform === 'linux' ? linuxMetadataCopyCommand() : 'cp';
  const mode = original ? original.mode & 0o7777 : 0o600;
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    // Hold the new inode open while its existing access metadata is copied.
    // The descriptor stays writable even if the target ACL/owner forbids reopening it.
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      if (original && !windowsMetadata) {
        // Node copyFile does not preserve Unix ACLs. Native cp preserves the
        // same-directory target's ACL/attributes as well as its ownership/mode.
        const args = process.platform === 'linux'
          ? ['--preserve=mode,ownership,xattr', destination, temporary]
          : ['-p', destination, temporary];
        execFileSync(copyCommand, args, { stdio: 'pipe' });
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
      if (original && windowsMetadata) {
        // The temporary inode must have the original access policy before it
        // receives config contents; a permissive parent must not expose secrets.
        runMcpConfigPowerShell('Get-Acl -LiteralPath $env:DKG_MCP_FILE_SOURCE | Set-Acl -LiteralPath $env:DKG_MCP_FILE_DESTINATION', {
          source: destination, destination: temporary,
        }, location);
      }
      ftruncateSync(fd, 0);
      writeFileSync(fd, content, 'utf8');
      if (location !== 'windows-wsl') fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (original && windowsMetadata) {
      const backup = `${temporary}.backup`;
      try {
        // File.Replace uses ReplaceFileW, merging the destination's access
        // metadata. false rejects metadata merge errors instead of ignoring them.
        runMcpConfigPowerShell('[System.IO.File]::Replace($env:DKG_MCP_FILE_SOURCE, $env:DKG_MCP_FILE_DESTINATION, $env:DKG_MCP_FILE_BACKUP, $false)', {
          source: temporary, destination, backup,
        }, location);
      } catch (error) {
        // ReplaceFileW can move the old file before a later rename fails.
        if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
        if (existsSync(backup)) {
          throw new Error(`MCP config replacement failed; the original backup is retained at ${backup}`, { cause: error });
        }
        throw error;
      }
      rmSync(backup, { force: true });
    } else {
      renameSync(temporary, destination);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
