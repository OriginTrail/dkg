import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform, release as osRelease } from 'node:os';
import { execSync } from 'node:child_process';
import { resolveMcpConfigDestination } from './mcp-config-file.js';


import { DKG_SERVER_KEY, type McpClientConfigShape } from './mcp-config-document.js';
export { DKG_SERVER_KEY, type McpClientConfigShape } from './mcp-config-document.js';
export type McpClientLocation = 'native' | 'windows-wsl';
type WindowsPaths = { USERPROFILE: string | null; APPDATA: string | null };

function homePaths(home: string, ...parts: string[]) {
  const configPath = join(home, ...parts);
  return { configPath, displayPath: tildify(configPath) };
}

const JSON_MCP = { format: 'json', serverContainer: 'mcpServers' } as const;
const JSONC_SERVERS = { format: 'jsonc', serverContainer: 'servers' } as const;
const TOML_SERVERS = { format: 'toml', serverContainer: 'mcp_servers' } as const;

/** One entry owns each client's identity, storage shape, paths and skill delivery. */
const MCP_CLIENT_REGISTRY = [
  { target: { id: 'cursor', name: 'Cursor', ...JSON_MCP },
    nativePaths: (home: string) => homePaths(home, '.cursor', 'mcp.json'),
    windowsPath: (env: WindowsPaths) => env.USERPROFILE && join(env.USERPROFILE, '.cursor', 'mcp.json'),
    skillPath: ['.cursor', 'skills', 'dkg-node', 'SKILL.md'],
  },
  { target: { id: 'claude-code', name: 'Claude Code', ...JSON_MCP },
    nativePaths: (home: string) => homePaths(home, '.claude.json'),
    skillPath: ['.claude', 'skills', 'dkg-node', 'SKILL.md'],
  },
  { target: { id: 'claude-desktop', name: 'Claude Desktop', ...JSON_MCP },
    nativePaths: (_home: string, root: string) => appConfigPaths(root, 'Claude', 'claude_desktop_config.json'),
    windowsPath: (env: WindowsPaths) => env.APPDATA && join(env.APPDATA, 'Claude', 'claude_desktop_config.json'),
  },
  { target: { id: 'windsurf', name: 'Windsurf', ...JSON_MCP },
    nativePaths: (home: string) => homePaths(home, '.codeium', 'windsurf', 'mcp_config.json'),
    windowsPath: (env: WindowsPaths) => env.USERPROFILE && join(env.USERPROFILE, '.codeium', 'windsurf', 'mcp_config.json'),
  },
  { target: { id: 'vscode', name: 'VSCode', ...JSONC_SERVERS },
    nativePaths: (_home: string, root: string) => appConfigPaths(root, 'Code', 'User', 'mcp.json'),
    windowsPath: (env: WindowsPaths) => env.APPDATA && join(env.APPDATA, 'Code', 'User', 'mcp.json'),
  },
  { target: { id: 'cline', name: 'Cline', ...JSON_MCP },
    nativePaths: (_home: string, root: string) => appConfigPaths(root, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    windowsPath: (env: WindowsPaths) => env.APPDATA && join(env.APPDATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
  },
  { target: { id: 'codex-cli', name: 'Codex CLI', ...TOML_SERVERS },
    nativePaths: (home: string) => homePaths(home, '.codex', 'config.toml'),
    // A WSL process has no Windows-compatible Node/CLI launch command for Codex.
  },
] as const;

type McpClientDefinition = typeof MCP_CLIENT_REGISTRY[number];
export type McpClientId = McpClientDefinition['target']['id'];
export const MCP_CLIENT_IDS = Object.freeze(MCP_CLIENT_REGISTRY.map((client) => client.target.id));
type NativeTarget = McpClientDefinition['target'] & { location: 'native' };
type WindowsTarget = Extract<McpClientDefinition, { windowsPath: unknown }>['target'] & { location: 'windows-wsl' };
/** Identity determines its config shape and supported locations in the registry. */
type WithDisplayName<T> = T extends unknown ? Omit<T, 'name'> & { name: string } : never;
export type ClientTarget = WithDisplayName<NativeTarget | WindowsTarget> & {
  configPath: string;
  /** Pretty path for display, with `~` substituted back in. */
  displayPath: string;
};

/** Stable selector identity is independent of display names and detection results. */
export function parseMcpClientSelector(value: string): { id: McpClientId; location?: McpClientLocation } {
  const [id, location, extra] = value.trim().toLowerCase().split(':');
  const client = MCP_CLIENT_REGISTRY.find(entry => entry.target.id === id);
  if (!client || extra !== undefined
      || (location === 'windows-wsl' && !('windowsPath' in client))
      || (location !== undefined && location !== 'native' && location !== 'windows-wsl')) {
    throw new Error(`Unsupported MCP client selector "${value}". Use ${MCP_CLIENT_IDS.join(', ')}, optionally followed by :native or :windows-wsl.`);
  }
  return { id: client.target.id, location };
}

/** Physical storage owns format and persistence, independently of client identity. */
export type McpConfigEndpoint = McpClientConfigShape & {
  readonly configPath: string;
  readonly displayPath: string;
  readonly location: McpClientLocation;
};

export interface McpConfigSelection {
  readonly endpoint: McpConfigEndpoint;
  readonly destination: string;
  /** Logical clients selected by the caller; never replaced by a storage alias. */
  readonly aliases: readonly ClientTarget[];
}

export function mcpConfigClientNames(selection: McpConfigSelection): string {
  return [...new Set(selection.aliases.map(alias => alias.name))].join(', ');
}

/** Confirmation applies to all selected aliases of the inspected destination. */
export function assertMcpConfigSelectionCurrent(selection: McpConfigSelection): void {
  for (const alias of selection.aliases) {
    if (resolveMcpConfigDestination(alias.configPath) !== selection.destination) {
      throw new Error(`MCP config path changed since inspection: ${alias.displayPath}. Re-run the command to confirm the current destination.`);
    }
  }
}

/** Select each physical owned leaf once while retaining the selected logical aliases. */
export function selectMcpClientTargets(
  clients: readonly ClientTarget[],
  selector?: ReturnType<typeof parseMcpClientSelector>,
): McpConfigSelection[] {
  const groups = new Map<string, { path: string; aliases: ClientTarget[] }>();
  for (const target of clients) {
    let physicalPath: string;
    try { physicalPath = resolveMcpConfigDestination(target.configPath); }
    catch { physicalPath = resolve(target.configPath); }
    const leaf = JSON.stringify([physicalPath, target.serverContainer, DKG_SERVER_KEY]);
    const group = groups.get(leaf) ?? { path: physicalPath, aliases: [] };
    group.aliases.push(target);
    groups.set(leaf, group);
  }
  const selected: McpConfigSelection[] = [];
  for (const group of groups.values()) {
    const aliases = group.aliases.filter(target => !selector || (target.id === selector.id
      && (!selector.location || target.location === selector.location)));
    if (aliases.length === 0) continue;
    // A selected native alias can still refer to a Windows-backed file. Only
    // storage fields come from the persistence owner; identity stays in aliases.
    const storage = group.aliases.find(target => target.location === 'windows-wsl') ?? group.aliases[0]!;
    const { id: _id, name: _name, ...endpoint } = storage;
    selected.push({
      // Keep a selected live path for the atomic transaction's revalidation.
      endpoint: { ...endpoint, configPath: aliases[0]!.configPath, displayPath: aliases[0]!.displayPath },
      destination: group.path,
      aliases,
    });
  }
  return selected;
}

export function clientSkillPath(id: McpClientId, home: string): string | null {
  const client = MCP_CLIENT_REGISTRY.find((entry) => entry.target.id === id);
  return client && 'skillPath' in client ? join(home, ...client.skillPath) : null;
}

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Resolve the native application-config root once for the detection sweep. */
function nativeApplicationConfigRoot(home: string): string {
  switch (platform()) {
    case 'darwin': return join(home, 'Library', 'Application Support');
    case 'win32': return process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    default: return process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  }
}

function appConfigPaths(root: string, ...suffix: string[]) {
  const configPath = join(root, ...suffix);
  return { configPath, displayPath: tildify(configPath) };
}

/**
 * Discover MCP-aware clients on the machine. We look at the standard
 * config-file locations rather than probing for installed binaries — a
 * config file is the artifact `dkg mcp setup` actually writes into, and
 * its existence (or non-existence) is the signal that matters.
 *
 * Per-client docs source-of-truth (verify on next-cycle if anything
 * drifts):
 *   - Cursor:        `~/.cursor/mcp.json` — global per-user MCP config
 *   - Claude Code:   `~/.claude.json` — user-scoped path the MCP-server
 *     wiring already uses across the rest of the codebase
 *   - Claude Desktop: per-platform (native application-config root)
 *   - Windsurf (Codeium): `~/.codeium/windsurf/mcp_config.json`
 *
 * Detection is deliberately permissive: any client whose config file is
 * already present OR whose config directory is already present counts as
 * "detected" for write purposes. Operators with a fresh machine and no
 * client installed still see the fallback "no clients detected; run
 * `dkg mcp setup --print-only`" message.
 */
/**
 * Codex Round-13 Fix 20: detect WSL2. Linux platform with `microsoft`
 * / `WSL` markers in env, kernel release, or `/proc/version`. WSL
 * users running `dkg mcp setup` from inside their WSL distro need
 * to register Windows-side GUI clients (Claude Desktop, Windsurf,
 * VSCode + Copilot, Cline) AS WELL AS any Linux-native clients —
 * pre-fix they got the Linux-only set and the README's WSL2
 * promise silently failed for the apps users actually run.
 *
 * Multi-signal detection (env first; cheaper than fs reads):
 *   - `WSL_DISTRO_NAME` / `WSL_INTEROP` set by the WSL launcher.
 *   - `os.release()` contains `microsoft` or `wsl` (WSL kernels
 *     identify themselves there).
 *   - `/proc/version` contains the same markers (slower fallback).
 */
function isWSL(): boolean {
  if (platform() !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    const release = osRelease().toLowerCase();
    if (release.includes('microsoft') || release.includes('wsl')) return true;
  } catch { /* fall through */ }
  try {
    const procVersion = readFileSync('/proc/version', 'utf-8').toLowerCase();
    if (procVersion.includes('microsoft') || procVersion.includes('wsl')) return true;
  } catch { /* /proc/version not readable; not WSL */ }
  return false;
}

/**
 * Resolve a Windows-side env var (e.g. `%USERPROFILE%`,
 * `%APPDATA%`) into a WSL-mounted Linux path (`/mnt/c/...`). Uses
 * `cmd.exe` to read the env var, then `wslpath` to convert. Returns
 * `null` on any failure (cmd.exe / wslpath missing, env var
 * unset, conversion error) so callers fall back to Linux-only
 * detection.
 *
 * Codex Round-13 Fix 20 helper.
 */
function wslWindowsEnvPath(envVarName: string): string | null {
  try {
    const winPath = execSync(`cmd.exe /c "echo %${envVarName}%"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // `cmd.exe` echoes `%FOO%` literally when the var is unset.
    if (!winPath || winPath.startsWith('%')) return null;
    // Strip Windows CR if present.
    const cleaned = winPath.replace(/\r/g, '');
    // wslpath -u takes the Windows path and emits the /mnt/c/...
    // form. Quote the input to handle spaces in usernames.
    const linuxPath = execSync(`wslpath -u '${cleaned.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return linuxPath || null;
  } catch {
    return null;
  }
}

/**
 * Exported for Codex Round-13 Fix 20 tests — direct unit testing
 * of WSL2 client-detection branch without going through the full
 * `mcpSetupAction` body. Production callers go via the action.
 * The resolver arg is test-only so WSL Windows path discovery can
 * be exercised without real cmd.exe / wslpath binaries.
 */
export function detectClients(
  resolveWslWindowsEnvPath: (envVarName: string) => string | null =
    wslWindowsEnvPath,
): ClientTarget[] {
  const home = homedir();
  const appConfigRoot = nativeApplicationConfigRoot(home);
  const candidates: ClientTarget[] = MCP_CLIENT_REGISTRY.map((client) => ({
    ...client.target,
    location: 'native',
    ...client.nativePaths(home, appConfigRoot),
  }));
  if (isWSL()) {
    const windows = {
      USERPROFILE: resolveWslWindowsEnvPath('USERPROFILE'),
      APPDATA: resolveWslWindowsEnvPath('APPDATA'),
    };
    for (const client of MCP_CLIENT_REGISTRY) {
      if (!('windowsPath' in client)) continue;
      const configPath = client.windowsPath(windows);
      if (!configPath) continue;
      candidates.push({
        ...client.target,
        name: `${client.target.name} (Windows-side via WSL)`,
        location: 'windows-wsl',
        configPath,
        displayPath: configPath,
      });
    }
  }
  return candidates.filter((client) => existsSync(client.configPath) || existsSync(dirname(client.configPath)));
}
