import type { McpClientLocation } from './mcp-client-registry.js';
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

/** Use the Windows system runtime; paths are data, never interpolated script text.
 * Restrict module discovery to this runtime's built-ins. A Node process launched
 * by PowerShell 7 otherwise forwards incompatible PS7 modules to powershell.exe.
 */
export function runMcpConfigPowerShell(script: string, paths: { source: string; destination: string; backup?: string }, location: McpClientLocation = 'native'): void {
  const windowsPath = (path: string) => location === 'windows-wsl'
    ? execFileSync('wslpath', ['-w', path], { encoding: 'utf8', stdio: 'pipe' }).trim()
    : path;
  const pathEnvironment = {
    DKG_MCP_FILE_SOURCE: windowsPath(paths.source),
    DKG_MCP_FILE_DESTINATION: windowsPath(paths.destination),
    DKG_MCP_FILE_BACKUP: paths.backup ? windowsPath(paths.backup) : '',
  };
  // WSLENV explicitly forwards these data variables across the Win32 boundary.
  // Paths are already converted; do not apply WSLENV's path-translation flag.
  const forwardedNames = Object.keys(pathEnvironment);
  const wslEnvironment = [...(process.env.WSLENV ?? '').split(':')
    .filter(name => name && !forwardedNames.includes(name.split('/')[0]!)), ...forwardedNames].join(':');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; $env:PSModulePath = $PSHOME + '\\Modules'; ${script}`], {
    stdio: 'pipe',
    windowsHide: true,
    env: {
      ...process.env,
      ...pathEnvironment,
      ...(location === 'windows-wsl' ? { WSLENV: wslEnvironment } : {}),
    },
  });
}
