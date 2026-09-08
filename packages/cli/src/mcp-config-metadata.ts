import { execFileSync } from 'node:child_process';

/** Linux needs an implementation that preserves ACLs and extended attributes. */
export function linuxMetadataCopyCommand(): string {
  for (const command of ['cp', 'gcp']) {
    try {
      const help = execFileSync(command, ['--help'], { encoding: 'utf8', stdio: 'pipe' });
      if (help.includes('--preserve') && help.includes('xattr')) return command;
    } catch { /* Try the separately installed GNU coreutils command. */ }
  }
  throw new Error('Updating existing MCP configs on Linux requires GNU coreutils cp or gcp with ACL/xattr preservation. Install coreutils (for example, apk add coreutils on Alpine). The original config was not changed.');
}

/** Use the Windows system runtime; paths are data, never interpolated script text. */
export function runMcpConfigPowerShell(script: string, paths: { source: string; destination: string; backup?: string }): void {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], {
    stdio: 'pipe',
    windowsHide: true,
    env: {
      ...process.env,
      DKG_MCP_FILE_SOURCE: paths.source,
      DKG_MCP_FILE_DESTINATION: paths.destination,
      DKG_MCP_FILE_BACKUP: paths.backup ?? '',
    },
  });
}
