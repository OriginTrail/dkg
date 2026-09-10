import { win32, posix } from 'node:path';
import { detectMcpRuntime, type McpRuntime } from './mcp-runtime.js';
import { execFileSync } from 'node:child_process';
import { existsSync, fchmodSync, fchownSync, fstatSync, renameSync, rmSync, type Stats } from 'node:fs';

type WindowsExecution = 'native' | 'windows-wsl';

interface McpConfigReplacement {
  configPath: string;
  destination: string;
  temporary: string;
  original: Stats | undefined;
  mode: number;
}

interface OpenMcpConfigReplacement extends McpConfigReplacement {
  fd: number;
}

/** Complete platform-specific policy selected before an atomic write begins. */
export interface McpConfigPersistenceStrategy {
  readonly kind: 'posix' | 'linux' | 'windows-native' | 'windows-wsl';
  preflight(replacement: McpConfigReplacement): void;
  prepare(replacement: OpenMcpConfigReplacement): void;
  secure(replacement: OpenMcpConfigReplacement): void;
  publish(replacement: McpConfigReplacement): void;
}

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
type WindowsMcpConfigOperation = 'copy-metadata' | 'replace-file';

const WINDOWS_MCP_CONFIG_SCRIPTS: Record<WindowsMcpConfigOperation, string> = {
  'copy-metadata': 'Get-Acl -LiteralPath $env:DKG_MCP_FILE_SOURCE | Set-Acl -LiteralPath $env:DKG_MCP_FILE_DESTINATION',
  'replace-file': '[System.IO.File]::Replace($env:DKG_MCP_FILE_SOURCE, $env:DKG_MCP_FILE_DESTINATION, $env:DKG_MCP_FILE_BACKUP, $false)',
};

/** Resolve the OS runtime without searching the working directory or PATH. */
export function windowsPowerShellExecutable(location: WindowsExecution): string {
  // WSL does not forward SystemRoot by default. Non-default Windows installs
  // can supply the inherited Windows SystemRoot explicitly to the Linux process.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  if (!/^[A-Za-z]:[\\/]/.test(systemRoot) || /[\\/]\.\.?([\\/]|$)/.test(systemRoot)) {
    throw new Error('MCP config persistence requires an absolute Windows SystemRoot (for example C:\\Windows).');
  }
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (location === 'native') return executable;
  const mounted = execFileSync('/usr/bin/wslpath', ['-u', executable], { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (!posix.isAbsolute(mounted)) throw new Error('Could not resolve an absolute WSL path for system PowerShell.');
  return mounted;
}

function runMcpConfigPowerShell(
  operation: WindowsMcpConfigOperation,
  paths: { source: string; destination: string; backup?: string },
  location: WindowsExecution,
): void {
  const executable = windowsPowerShellExecutable(location);
  const windowsPath = (path: string) => location === 'windows-wsl'
    ? execFileSync('/usr/bin/wslpath', ['-w', path], { encoding: 'utf8', stdio: 'pipe' }).trim()
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
  execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; $env:PSModulePath = $PSHOME + '\\Modules'; ${WINDOWS_MCP_CONFIG_SCRIPTS[operation]}`], {
    stdio: 'pipe',
    windowsHide: true,
    env: {
      ...process.env,
      ...pathEnvironment,
      ...(location === 'windows-wsl' ? { WSLENV: wslEnvironment } : {}),
    },
  });
}

/** Copy the destination file's Windows owner and DACL to a replacement inode. */
export function copyWindowsMcpConfigMetadata(
  source: string,
  destination: string,
  location: WindowsExecution,
): void {
  runMcpConfigPowerShell('copy-metadata', { source, destination }, location);
}

/** Atomically replace a Windows config while retaining a recoverable backup. */
export function replaceWindowsMcpConfigFile(
  source: string,
  destination: string,
  backup: string,
  location: WindowsExecution,
): void {
  runMcpConfigPowerShell('replace-file', { source, destination, backup }, location);
}

function preservePosixMetadata(
  replacement: OpenMcpConfigReplacement,
  copyCommand: string,
  copyArguments: string[],
): void {
  const { configPath, destination, temporary, original, fd } = replacement;
  if (!original) return;
  // Node copyFile does not preserve Unix ACLs. Native cp preserves the
  // same-directory target's ACL/attributes as well as its ownership/mode.
  execFileSync(copyCommand, [...copyArguments, destination, temporary], { stdio: 'pipe' });
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

function posixPersistence(kind: 'posix' | 'linux'): McpConfigPersistenceStrategy {
  let copyCommand = 'cp';
  return {
    kind,
    preflight({ original }) {
      // BusyBox cp lacks the metadata guarantees required by the transaction.
      if (original && kind === 'linux') copyCommand = linuxMetadataCopyCommand();
    },
    prepare(replacement) {
      preservePosixMetadata(replacement, copyCommand,
        kind === 'linux' ? ['--preserve=mode,ownership,xattr'] : ['-p']);
    },
    secure({ fd, mode }) { fchmodSync(fd, mode); },
    publish({ temporary, destination }) { renameSync(temporary, destination); },
  };
}

function windowsPersistence(
  kind: 'windows-native' | 'windows-wsl',
): McpConfigPersistenceStrategy {
  const location = kind === 'windows-wsl' ? 'windows-wsl' : 'native';
  return {
    kind,
    preflight() {},
    prepare({ original, destination, temporary }) {
      if (original) {
        // The temporary inode must have the original access policy before it
        // receives config contents; a permissive parent must not expose secrets.
        copyWindowsMcpConfigMetadata(destination, temporary, location);
      }
    },
    secure({ fd, mode }) {
      // A WSL descriptor is not authoritative for a Windows-side config.
      if (kind === 'windows-native') fchmodSync(fd, mode);
    },
    publish({ original, temporary, destination }) {
      if (!original) {
        renameSync(temporary, destination);
        return;
      }
      const backup = `${temporary}.backup`;
      try {
        // File.Replace uses ReplaceFileW, merging the destination's access
        // metadata. false rejects metadata merge errors instead of ignoring them.
        replaceWindowsMcpConfigFile(temporary, destination, backup, location);
      } catch (error) {
        // ReplaceFileW can move the old file before a later rename fails.
        if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
        if (existsSync(backup)) {
          throw new Error(`MCP config replacement failed; the original backup is retained at ${backup}`, { cause: error });
        }
        throw error;
      }
      rmSync(backup, { force: true });
    },
  };
}

/** Select persistence solely from the runtime and resolved physical destination. */
export function mcpConfigPersistenceStrategy(
  destination: string,
  runtime: McpRuntime = detectMcpRuntime(),
): McpConfigPersistenceStrategy {
  if (runtime === 'wsl') {
    // WSL resolves custom drive mounts and UNC shares too. A Linux-backed path
    // is exported through the distro share; every other Windows path uses ACLs.
    const translated = execFileSync('/usr/bin/wslpath', ['-w', destination], { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (!win32.isAbsolute(translated)) throw new Error('Could not resolve the WSL MCP config destination. The original config was not changed.');
    return /^\\\\wsl(?:\$|\.localhost)\\/i.test(translated)
      ? posixPersistence('linux') : windowsPersistence('windows-wsl');
  }
  if (runtime === 'windows') return windowsPersistence('windows-native');
  return posixPersistence(runtime === 'linux' ? 'linux' : 'posix');
}
