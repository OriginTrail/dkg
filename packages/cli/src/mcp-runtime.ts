import { readFileSync } from 'node:fs';
import { platform, release } from 'node:os';

export type McpRuntime = 'wsl' | 'linux' | 'windows' | 'posix';

/** One runtime classification for client discovery and physical-file persistence. */
export function detectMcpRuntime(): McpRuntime {
  const operatingSystem = platform();
  if (operatingSystem === 'win32') return 'windows';
  if (operatingSystem !== 'linux') return 'posix';
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return 'wsl';
  try { if (/microsoft|wsl/i.test(release())) return 'wsl'; } catch { /* Try procfs. */ }
  try { if (/microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'))) return 'wsl'; } catch { /* Plain Linux. */ }
  return 'linux';
}
